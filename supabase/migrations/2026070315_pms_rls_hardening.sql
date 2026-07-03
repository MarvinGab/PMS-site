-- Close a cross-tenant boolean oracle: SECURITY DEFINER helpers are RPC-callable
-- by any authenticated user (pms is an exposed schema), so the two helpers that
-- accept arbitrary ids must refuse to answer for orgs the caller is not in.
create or replace function pms.stage_visible(p_cycle uuid, p_key text) returns boolean
language plpgsql stable security definer set search_path = pms, public as $$
declare v text; v_org uuid;
begin
  select organization_id into v_org from pms.appraisal_cycles where id = p_cycle;
  if v_org is null or not pms.is_org_member(v_org) then return false; end if;
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
  if not pms.is_org_member(p_org) then return false; end if;
  if pms.is_org_reader(p_org) then return true; end if;
  me := pms.self_employee_id(p_org);
  if p_stage = 'self' then
    return p_emp = me or pms.manages(p_org, p_emp) or pms.is_hod_of(p_org, p_emp);
  elsif p_stage = 'manager' then
    if pms.manages(p_org, p_emp) or pms.is_hod_of(p_org, p_emp) then return true; end if;
    return coalesce(p_emp = me and pms.stage_visible(p_cycle, 'manager_rating_visible'), false);
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

-- Function privilege hygiene: helpers back policies; they are not a client API.
revoke execute on all functions in schema pms from public;
revoke execute on all functions in schema pms from anon;
grant execute on all functions in schema pms to authenticated; -- policies evaluate as the querying role
alter default privileges in schema pms revoke execute on functions from public;
notify pgrst, 'reload config';
