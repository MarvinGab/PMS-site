-- Security Phase 1 (narrowed) — lock the instant-access secrets from the anon key.
--
-- The previous migration also blocked 'employee_credentials', but employee
-- credential provisioning (invite OTP generation) is still done client-side as a
-- read-modify-write of the whole credentials blob via the anon key. Blocking it
-- breaks onboarding (and could wipe the blob). So we re-allow 'employee_credentials'
-- for anon FOR NOW, and keep it as a follow-up to move that provisioning into the
-- app-auth edge function (service role) before re-locking the hashes.
--
-- Still hard-blocked from anon (only ever touched by app-auth via service role,
-- never read/written by the client): live session tokens and reset OTPs. These
-- are the instant-impersonation / account-takeover vectors.
--
-- Rollback: drop the four policies below and `alter table public.app_state disable row level security;`

alter table public.app_state enable row level security;

drop policy if exists app_state_anon_select on public.app_state;
create policy app_state_anon_select on public.app_state
  for select to anon
  using (
    state_key not like 'server_session:%'
    and state_key not like 'password_reset:%'
  );

drop policy if exists app_state_anon_insert on public.app_state;
create policy app_state_anon_insert on public.app_state
  for insert to anon
  with check (
    state_key not like 'server_session:%'
    and state_key not like 'password_reset:%'
  );

drop policy if exists app_state_anon_update on public.app_state;
create policy app_state_anon_update on public.app_state
  for update to anon
  using (
    state_key not like 'server_session:%'
    and state_key not like 'password_reset:%'
  )
  with check (
    state_key not like 'server_session:%'
    and state_key not like 'password_reset:%'
  );

drop policy if exists app_state_anon_delete on public.app_state;
create policy app_state_anon_delete on public.app_state
  for delete to anon
  using (
    state_key not like 'server_session:%'
    and state_key not like 'password_reset:%'
  );
