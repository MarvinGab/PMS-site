-- Atomic creation flows (kernel contract: multi-table writes go through RPC).
-- Backend-only: no authenticated/anon execute — default privileges already revoke
-- PUBLIC (2026070315) and grant service_role (2026070311).
create or replace function pms.create_organization_tx(p_key text, p_name text, p_actor uuid)
returns pms.organizations
language plpgsql security definer set search_path = pms, public as $$
declare v_org pms.organizations;
begin
  insert into pms.organizations (key, name) values (p_key, p_name) returning * into v_org;
  insert into pms.organization_branding (organization_id) values (v_org.id);
  insert into pms.audit_logs (organization_id, actor_user_id, actor_role, action, entity_type, entity_id, after)
  values (v_org.id, p_actor, 'super_admin', 'org.create', 'organization', v_org.id, to_jsonb(v_org));
  return v_org;
end $$;

create or replace function pms.create_cycle_draft_tx(
  p_org uuid, p_name text, p_period_label text, p_framework text, p_actor uuid, p_actor_role text
) returns pms.appraisal_cycles
language plpgsql security definer set search_path = pms, public as $$
declare v_cycle pms.appraisal_cycles;
begin
  insert into pms.appraisal_cycles (organization_id, name, period_label, framework_id, status, created_by)
  values (p_org, p_name, p_period_label, p_framework, 'draft', p_actor)
  returning * into v_cycle;
  insert into pms.cycle_config_snapshots (organization_id, cycle_id) values (p_org, v_cycle.id);
  insert into pms.cycle_admin_config (organization_id, cycle_id) values (p_org, v_cycle.id);
  insert into pms.audit_logs (organization_id, cycle_id, actor_user_id, actor_role, action, entity_type, entity_id, after)
  values (p_org, v_cycle.id, p_actor, p_actor_role, 'cycle.create-draft', 'appraisal_cycle', v_cycle.id, to_jsonb(v_cycle));
  return v_cycle;
end $$;
