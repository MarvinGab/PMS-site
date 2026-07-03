-- ============ helper functions (SECURITY DEFINER so policies don't recurse) ============
create or replace function pms.is_super_admin() returns boolean
language sql stable security definer set search_path = pms, public as $$
  select exists (
    select 1 from pms.org_members
    where user_id = auth.uid() and organization_id is null
      and 'super_admin' = any(roles) and status = 'active'
  );
$$;

create or replace function pms.member_roles(p_org uuid) returns text[]
language sql stable security definer set search_path = pms, public as $$
  select coalesce(
    (select roles from pms.org_members
     where user_id = auth.uid() and organization_id = p_org and status = 'active'),
    '{}'::text[]);
$$;

create or replace function pms.has_role(p_org uuid, p_role text) returns boolean
language sql stable security definer set search_path = pms, public as $$
  select p_role = any(pms.member_roles(p_org));
$$;

create or replace function pms.is_org_member(p_org uuid) returns boolean
language sql stable security definer set search_path = pms, public as $$
  select pms.is_super_admin() or cardinality(pms.member_roles(p_org)) > 0;
$$;

create or replace function pms.is_org_reader(p_org uuid) returns boolean
language sql stable security definer set search_path = pms, public as $$
  select pms.is_super_admin() or pms.has_role(p_org, 'hr_admin');
$$;

create or replace function pms.self_employee_id(p_org uuid) returns uuid
language sql stable security definer set search_path = pms, public as $$
  select id from pms.employees
  where organization_id = p_org and user_id = auth.uid()
  limit 1;
$$;

create or replace function pms.manages(p_org uuid, p_emp uuid) returns boolean
language sql stable security definer set search_path = pms, public as $$
  select exists (
    select 1 from pms.reporting_relationships
    where organization_id = p_org and employee_id = p_emp
      and relation_type = 'manager'
      and related_employee_id = pms.self_employee_id(p_org)
  );
$$;

create or replace function pms.is_hod_of(p_org uuid, p_emp uuid) returns boolean
language sql stable security definer set search_path = pms, public as $$
  select exists (
    select 1 from pms.reporting_relationships
    where organization_id = p_org and employee_id = p_emp
      and relation_type = 'hod'
      and related_employee_id = pms.self_employee_id(p_org)
  );
$$;

-- "People related to me": my manager / L2 / HOD rows, so their names can render.
create or replace function pms.is_my_related(p_org uuid, p_emp uuid) returns boolean
language sql stable security definer set search_path = pms, public as $$
  select exists (
    select 1 from pms.reporting_relationships
    where organization_id = p_org
      and employee_id = pms.self_employee_id(p_org)
      and related_employee_id = p_emp
  );
$$;

-- Visibility of manager/final stages to the employee (and their manager),
-- driven by the frozen snapshot: immediate | after_publish (default) | never.
create or replace function pms.stage_visible(p_cycle uuid, p_key text) returns boolean
language plpgsql stable security definer set search_path = pms, public as $$
declare v text;
begin
  select coalesce(snapshot #>> array['visibility', p_key], 'after_publish')
    into v from pms.cycle_config_snapshots where cycle_id = p_cycle;
  v := coalesce(v, 'after_publish');
  if v = 'never' then return false; end if;
  if v = 'immediate' then return true; end if;
  return exists (
    select 1 from pms.cycle_publications
    where cycle_id = p_cycle and revoked_at is null
  );
end $$;

create or replace function pms.can_read_evaluation(p_org uuid, p_cycle uuid, p_emp uuid, p_stage text) returns boolean
language plpgsql stable security definer set search_path = pms, public as $$
declare me uuid;
begin
  if pms.is_org_reader(p_org) then return true; end if;
  me := pms.self_employee_id(p_org);
  if p_stage = 'self' then
    return p_emp = me or pms.manages(p_org, p_emp) or pms.is_hod_of(p_org, p_emp);
  elsif p_stage = 'manager' then
    if pms.manages(p_org, p_emp) or pms.is_hod_of(p_org, p_emp) then return true; end if;
    return p_emp = me and pms.stage_visible(p_cycle, 'manager_rating_visible');
  elsif p_stage = 'hod' then
    return pms.is_hod_of(p_org, p_emp);
  elsif p_stage = 'hr_final' then
    if pms.is_hod_of(p_org, p_emp) then return true; end if;
    if p_emp = me or pms.manages(p_org, p_emp) then
      return pms.stage_visible(p_cycle, 'final_rating_visible');
    end if;
  end if;
  return false;
end $$;

-- ============ enable RLS everywhere ============
do $$
declare t text;
begin
  for t in select table_name from information_schema.tables
           where table_schema = 'pms' and table_type = 'BASE TABLE'
  loop
    execute format('alter table pms.%I enable row level security', t);
  end loop;
end $$;

-- ============ grants: logged-in users read (RLS gates rows); anon gets nothing ============
grant usage on schema pms to authenticated;
grant select on all tables in schema pms to authenticated;
grant update (read_at) on pms.notifications to authenticated;
alter default privileges in schema pms grant select on tables to authenticated;

-- ============ SELECT policies ============
create policy org_select on pms.organizations for select
  using (pms.is_super_admin() or pms.is_org_member(id));

-- Org members may read shared org/cycle configuration.
create policy member_read on pms.organization_branding for select using (pms.is_org_member(organization_id));
create policy member_read on pms.org_grades for select using (pms.is_org_member(organization_id));
create policy member_read on pms.competency_library for select using (pms.is_org_member(organization_id));
create policy member_read on pms.goal_libraries for select using (pms.is_org_member(organization_id));
create policy member_read on pms.goal_library_items for select using (pms.is_org_member(organization_id));
create policy member_read on pms.appraisal_cycles for select using (pms.is_org_member(organization_id));
create policy member_read on pms.cycle_phase_windows for select using (pms.is_org_member(organization_id));
create policy member_read on pms.cycle_config_snapshots for select using (pms.is_org_member(organization_id));
create policy member_read on pms.cycle_perspectives for select using (pms.is_org_member(organization_id));
create policy member_read on pms.cycle_groups for select using (pms.is_org_member(organization_id));
create policy member_read on pms.cycle_group_segment_values for select using (pms.is_org_member(organization_id));
create policy member_read on pms.cycle_group_library_assignments for select using (pms.is_org_member(organization_id));
create policy member_read on pms.cycle_target_types for select using (pms.is_org_member(organization_id));
create policy member_read on pms.cycle_rating_scale_levels for select using (pms.is_org_member(organization_id));
create policy member_read on pms.cycle_auto_rating_bands for select using (pms.is_org_member(organization_id));
create policy member_read on pms.cycle_goal_rules for select using (pms.is_org_member(organization_id));
create policy member_read on pms.cycle_competency_config for select using (pms.is_org_member(organization_id));
create policy member_read on pms.cycle_competency_assignments for select using (pms.is_org_member(organization_id));
create policy member_read on pms.cycle_publications for select using (pms.is_org_member(organization_id));

-- HR/super-admin only.
create policy hr_read on pms.prefill_datasets for select using (pms.is_org_reader(organization_id));
create policy hr_read on pms.prefill_dataset_items for select using (pms.is_org_reader(organization_id));
create policy hr_read on pms.cycle_bell_curve_bands for select using (pms.is_org_reader(organization_id));
create policy hr_read on pms.cycle_config_versions for select using (pms.is_org_reader(organization_id));
create policy hr_read on pms.email_jobs for select using (pms.is_org_reader(organization_id));
create policy hr_read on pms.background_jobs for select using (pms.is_org_reader(organization_id));
create policy hr_read on pms.import_runs for select using (pms.is_org_reader(organization_id));
create policy hr_read on pms.audit_logs for select using (pms.is_org_reader(organization_id));
create policy hr_read on pms.email_delivery_attempts for select
  using (exists (select 1 from pms.email_jobs j
                 where j.id = email_job_id and pms.is_org_reader(j.organization_id)));
create policy hr_read on pms.import_run_errors for select
  using (exists (select 1 from pms.import_runs r
                 where r.id = import_run_id and pms.is_org_reader(r.organization_id)));

-- Own membership rows + HR.
create policy member_self_read on pms.org_members for select
  using (user_id = auth.uid()
         or (organization_id is not null and pms.is_org_reader(organization_id)));

-- Roster: self, people I manage / HOD over, people related to me, HR.
create policy employees_scoped_read on pms.employees for select
  using (pms.is_org_reader(organization_id)
         or user_id = auth.uid()
         or pms.manages(organization_id, id)
         or pms.is_hod_of(organization_id, id)
         or pms.is_my_related(organization_id, id));

create policy rr_scoped_read on pms.reporting_relationships for select
  using (pms.is_org_reader(organization_id)
         or employee_id = pms.self_employee_id(organization_id)
         or related_employee_id = pms.self_employee_id(organization_id));

-- Participation: self, manager, HOD, HR.
create policy participants_scoped_read on pms.cycle_participants for select
  using (pms.is_org_reader(organization_id)
         or employee_id = pms.self_employee_id(organization_id)
         or pms.manages(organization_id, employee_id)
         or pms.is_hod_of(organization_id, employee_id));
create policy assignments_scoped_read on pms.cycle_participant_assignments for select
  using (pms.is_org_reader(organization_id)
         or employee_id = pms.self_employee_id(organization_id)
         or pms.manages(organization_id, employee_id)
         or pms.is_hod_of(organization_id, employee_id));

-- Goal plans and their children: self, manager, HOD, HR.
create policy plans_scoped_read on pms.employee_goal_plans for select
  using (pms.is_org_reader(organization_id)
         or employee_id = pms.self_employee_id(organization_id)
         or pms.manages(organization_id, employee_id)
         or pms.is_hod_of(organization_id, employee_id));
create policy items_scoped_read on pms.employee_goal_items for select
  using (pms.is_org_reader(organization_id)
         or employee_id = pms.self_employee_id(organization_id)
         or pms.manages(organization_id, employee_id)
         or pms.is_hod_of(organization_id, employee_id));
create policy plan_comps_scoped_read on pms.employee_goal_plan_competencies for select
  using (pms.is_org_reader(organization_id)
         or employee_id = pms.self_employee_id(organization_id)
         or pms.manages(organization_id, employee_id)
         or pms.is_hod_of(organization_id, employee_id));
create policy gwe_scoped_read on pms.goal_workflow_events for select
  using (pms.is_org_reader(organization_id)
         or employee_id = pms.self_employee_id(organization_id)
         or pms.manages(organization_id, employee_id)
         or pms.is_hod_of(organization_id, employee_id));

-- Evaluations: stage-aware visibility.
create policy eval_visibility_read on pms.evaluations for select
  using (pms.can_read_evaluation(organization_id, cycle_id, employee_id, stage));
create policy eval_scores_visibility_read on pms.evaluation_goal_scores for select
  using (exists (select 1 from pms.evaluations e where e.id = evaluation_id
                 and pms.can_read_evaluation(e.organization_id, e.cycle_id, e.employee_id, e.stage)));
create policy eval_comp_scores_visibility_read on pms.evaluation_competency_scores for select
  using (exists (select 1 from pms.evaluations e where e.id = evaluation_id
                 and pms.can_read_evaluation(e.organization_id, e.cycle_id, e.employee_id, e.stage)));

-- Calibrations: HR + the HOD who covers that employee.
create policy calibrations_scoped_read on pms.calibrations for select
  using (pms.is_org_reader(organization_id)
         or pms.is_hod_of(organization_id, employee_id));

-- Acknowledgements: own + HR.
create policy ack_scoped_read on pms.rating_acknowledgements for select
  using (pms.is_org_reader(organization_id)
         or employee_id = pms.self_employee_id(organization_id));

-- Notifications: recipient only; recipient may mark read (column grant limits to read_at).
create policy notif_recipient_read on pms.notifications for select
  using (exists (select 1 from pms.org_members m
                 where m.id = recipient_member_id and m.user_id = auth.uid()));
create policy notif_recipient_mark_read on pms.notifications for update
  using (exists (select 1 from pms.org_members m
                 where m.id = recipient_member_id and m.user_id = auth.uid()))
  with check (exists (select 1 from pms.org_members m
                      where m.id = recipient_member_id and m.user_id = auth.uid()));

-- ============ realtime ============
do $$
begin
  begin
    alter publication supabase_realtime add table pms.notifications;
  exception when duplicate_object then null;
  end;
  begin
    alter publication supabase_realtime add table pms.cycle_publications;
  exception when duplicate_object then null;
  end;
end $$;
