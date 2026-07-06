-- Atomically link an invited auth user to their org membership + employee row,
-- and queue the invite email. GoTrue user creation happens in the edge handler
-- (not transactional with PG); this RPC makes the PG side atomic.
create or replace function pms.link_invited_member_tx(
  p_org uuid, p_user uuid, p_employee uuid, p_email text, p_link text, p_actor uuid
) returns jsonb
language plpgsql security definer set search_path = pms, public as $$
declare v_member_id uuid; v_job_id uuid;
begin
  insert into pms.org_members (organization_id, user_id, roles, status)
  values (p_org, p_user, array['employee']::text[], 'invited')
  on conflict (organization_id, user_id) do update set status = 'invited'
  returning id into v_member_id;

  update pms.employees set user_id = p_user where id = p_employee and organization_id = p_org;

  insert into pms.email_jobs (organization_id, template_key, recipient_email, recipient_member_id, subject, payload, status)
  values (p_org, 'invite', p_email::citext, v_member_id, 'You have been invited to the appraisal system',
          jsonb_build_object('actionLink', p_link), 'queued')
  returning id into v_job_id;

  insert into pms.audit_logs (organization_id, actor_user_id, action, entity_type, entity_id, after)
  values (p_org, p_actor, 'cycle.invite-member', 'org_member', v_member_id,
          jsonb_build_object('email', p_email, 'email_job_id', v_job_id));

  return jsonb_build_object('member_id', v_member_id, 'email_job_id', v_job_id);
end $$;

revoke all on function pms.link_invited_member_tx(uuid, uuid, uuid, text, text, uuid) from public, anon, authenticated;
