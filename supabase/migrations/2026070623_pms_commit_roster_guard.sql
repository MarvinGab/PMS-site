-- Self-guarding roster commit: lock + re-check the import run INSIDE the tx so
-- concurrent double-submits serialize (no double audit / committed_at overwrite)
-- and the RPC itself verifies the run exists and belongs to the org.
-- CREATE OR REPLACE (applied migrations are immutable); re-includes the revoke.
create or replace function pms.commit_roster_import_tx(
  p_org uuid, p_import_run uuid, p_actor uuid, p_rows jsonb
) returns jsonb
language plpgsql security definer set search_path = pms, public as $$
declare
  r jsonb;
  v_code text;
  v_ref text;
  v_rel text;
  v_emp_id uuid;
  v_ref_id uuid;
  v_inserted int := 0;
  v_updated int := 0;
  v_rels int := 0;
  v_existed boolean;
  v_run_status text;
begin
  -- Lock the run row and re-check state INSIDE the tx, so concurrent commits
  -- serialize and a second submit can't re-run the body.
  select status into v_run_status from pms.import_runs
    where id = p_import_run and organization_id = p_org for update;
  if v_run_status is null then
    raise exception 'import run not found' using errcode = 'no_data_found';
  end if;
  if v_run_status = 'committed' then
    raise exception 'import already committed' using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- Pass 1: upsert every employee row.
  for r in select * from jsonb_array_elements(p_rows) loop
    v_code := r->>'employee_code';
    select exists(select 1 from pms.employees where organization_id = p_org and employee_code = v_code)
      into v_existed;
    insert into pms.employees (
      organization_id, employee_code, full_name, email, designation, department, grade, group_name
    ) values (
      p_org, v_code, r->>'full_name', nullif(r->>'email','')::citext,
      r->>'designation', r->>'department', r->>'grade', r->>'group_name'
    )
    on conflict (organization_id, employee_code) do update set
      full_name = excluded.full_name, email = excluded.email,
      designation = excluded.designation, department = excluded.department,
      grade = excluded.grade, group_name = excluded.group_name;
    if v_existed then v_updated := v_updated + 1; else v_inserted := v_inserted + 1; end if;
  end loop;

  -- Pass 2: resolve manager/l2/hod codes to ids and upsert reporting rows.
  for r in select * from jsonb_array_elements(p_rows) loop
    v_code := r->>'employee_code';
    select id into v_emp_id from pms.employees where organization_id = p_org and employee_code = v_code;
    for v_rel, v_ref in
      select rel, r->>col from (values ('manager','manager_code'),('l2','l2_code'),('hod','hod_code')) as m(rel,col)
    loop
      if v_ref is not null and v_ref <> '' then
        select id into v_ref_id from pms.employees where organization_id = p_org and employee_code = v_ref;
        if v_ref_id is null then
          raise exception 'reporting reference % for % does not resolve', v_ref, v_code
            using errcode = 'foreign_key_violation';
        end if;
        insert into pms.reporting_relationships (organization_id, employee_id, related_employee_id, relation_type)
        values (p_org, v_emp_id, v_ref_id, v_rel)
        on conflict (organization_id, employee_id, relation_type)
          do update set related_employee_id = excluded.related_employee_id;
        v_rels := v_rels + 1;
      end if;
    end loop;
  end loop;

  update pms.import_runs
    set status = 'committed', committed_at = now()
    where id = p_import_run and organization_id = p_org;

  insert into pms.audit_logs (organization_id, actor_user_id, action, entity_type, entity_id, after)
  values (p_org, p_actor, 'import.commit-roster', 'import_run', p_import_run,
          jsonb_build_object('inserted', v_inserted, 'updated', v_updated, 'relationships', v_rels));

  return jsonb_build_object('inserted', v_inserted, 'updated', v_updated, 'relationships', v_rels);
end $$;

revoke all on function pms.commit_roster_import_tx(uuid, uuid, uuid, jsonb) from public, anon, authenticated;
