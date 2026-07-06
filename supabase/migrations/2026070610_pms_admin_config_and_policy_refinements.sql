-- HR-only per-cycle admin config (bell-curve header etc.) — deliberately NOT in
-- member-readable cycle_config_snapshots (Plan-1 final-review decision).
create table pms.cycle_admin_config (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references pms.organizations(id) on delete cascade,
  cycle_id uuid not null unique references pms.appraisal_cycles(id) on delete cascade,
  payload jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version int not null default 1
);
alter table pms.cycle_admin_config enable row level security;
create policy hr_read on pms.cycle_admin_config for select
  using (pms.is_org_reader(organization_id));
drop trigger if exists touch on pms.cycle_admin_config;
create trigger touch before update on pms.cycle_admin_config
  for each row execute function pms.touch_row();

-- Band sanity (deferred from Plan-1 review).
alter table pms.cycle_auto_rating_bands
  add constraint auto_band_range check (to_percent >= from_percent);

-- self_employee_id now requires an ACTIVE membership, so disabled/invited members
-- lose every self-pivot read (plans, items, participants, acks, reporting rows).
create or replace function pms.self_employee_id(p_org uuid) returns uuid
language sql stable security definer set search_path = pms, public as $$
  select e.id from pms.employees e
  where e.organization_id = p_org and e.user_id = auth.uid()
    and pms.is_org_member(p_org)
  limit 1;
$$;

-- employees: replace the raw user_id pivot with the membership-gated helper.
drop policy employees_scoped_read on pms.employees;
create policy employees_scoped_read on pms.employees for select
  using (pms.is_org_reader(organization_id)
         or id = pms.self_employee_id(organization_id)
         or pms.manages(organization_id, id)
         or pms.is_hod_of(organization_id, id)
         or pms.is_my_related(organization_id, id));

-- Draft privacy: unsubmitted evaluations are visible only to their author + HR.
drop policy eval_visibility_read on pms.evaluations;
drop policy eval_scores_visibility_read on pms.evaluation_goal_scores;
drop policy eval_comp_scores_visibility_read on pms.evaluation_competency_scores;
drop function pms.can_read_evaluation(uuid, uuid, uuid, text);

create function pms.can_read_evaluation(
  p_org uuid, p_cycle uuid, p_emp uuid, p_stage text, p_status text
) returns boolean
language plpgsql stable security definer set search_path = pms, public as $$
declare me uuid;
begin
  if pms.is_org_reader(p_org) then return true; end if;
  if not pms.is_org_member(p_org) then return false; end if; -- cross-org oracle guard
  me := pms.self_employee_id(p_org);
  if me is null then return false; end if;
  if p_status is distinct from 'submitted' then
    -- Drafts: only the author. self → the employee; manager/hod → the evaluator.
    if p_stage = 'self' then return p_emp = me; end if;
    if p_stage = 'manager' then return pms.manages(p_org, p_emp); end if;
    if p_stage = 'hod' then return pms.is_hod_of(p_org, p_emp); end if;
    return false; -- hr_final drafts: HR only (handled by is_org_reader above)
  end if;
  -- Submitted rows: Plan-1 stage-visibility rules.
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

-- Plan-1 default privileges revoked PUBLIC execute; policies evaluate with the
-- querying role's privileges, so authenticated needs execute explicitly.
grant execute on function pms.can_read_evaluation(uuid, uuid, uuid, text, text) to authenticated;

create policy eval_visibility_read on pms.evaluations for select
  using (pms.can_read_evaluation(organization_id, cycle_id, employee_id, stage, status));
create policy eval_scores_visibility_read on pms.evaluation_goal_scores for select
  using (exists (select 1 from pms.evaluations e where e.id = evaluation_id
                 and pms.can_read_evaluation(e.organization_id, e.cycle_id, e.employee_id, e.stage, e.status)));
create policy eval_comp_scores_visibility_read on pms.evaluation_competency_scores for select
  using (exists (select 1 from pms.evaluations e where e.id = evaluation_id
                 and pms.can_read_evaluation(e.organization_id, e.cycle_id, e.employee_id, e.stage, e.status)));
