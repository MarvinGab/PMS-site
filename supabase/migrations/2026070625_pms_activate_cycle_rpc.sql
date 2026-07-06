-- Atomic activation: prerequisite checks + status flip. Named exceptions carry
-- distinct SQLSTATEs the handler maps to app error codes. Backend-only.
create or replace function pms.activate_cycle_tx(
  p_org uuid, p_cycle uuid, p_expected_version int, p_actor uuid
) returns jsonb
language plpgsql security definer set search_path = pms, public as $$
declare v_status text; v_version int; v_when timestamptz;
begin
  select status, version into v_status, v_version
    from pms.appraisal_cycles where id = p_cycle and organization_id = p_org;
  if v_status is null then raise exception 'cycle not found' using errcode = 'no_data_found'; end if;
  if v_status not in ('draft','setup') then
    raise exception 'cycle is % not draft/setup', v_status using errcode = 'object_not_in_prerequisite_state';
  end if;
  if v_version <> p_expected_version then
    raise exception 'version conflict' using errcode = 'serialization_failure';
  end if;
  if not exists (select 1 from pms.cycle_participants where cycle_id = p_cycle and status = 'active') then
    raise exception 'no active participants' using errcode = 'check_violation';
  end if;
  if not exists (select 1 from pms.cycle_phase_windows where cycle_id = p_cycle) then
    raise exception 'no phase windows' using errcode = 'check_violation';
  end if;
  if not exists (select 1 from pms.cycle_rating_scale_levels where cycle_id = p_cycle) then
    raise exception 'no rating scale' using errcode = 'check_violation';
  end if;

  update pms.appraisal_cycles
    set status = 'active', activated_at = now()
    where id = p_cycle and organization_id = p_org and version = p_expected_version
    returning activated_at into v_when;

  insert into pms.audit_logs (organization_id, cycle_id, actor_user_id, action, entity_type, entity_id, before, after)
  values (p_org, p_cycle, p_actor, 'cycle.activate', 'appraisal_cycle', p_cycle,
          jsonb_build_object('status', v_status), jsonb_build_object('status','active','activated_at', v_when));

  return jsonb_build_object('status', 'active', 'activated_at', v_when);
end $$;

revoke all on function pms.activate_cycle_tx(uuid, uuid, int, uuid) from public, anon, authenticated;
