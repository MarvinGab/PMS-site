-- Security Phase 1 — stop the public (anon) key from reading/writing auth secrets.
--
-- app_state holds several record types keyed by state_key. Three of them are
-- sensitive and must never be reachable with the public anon key:
--   * 'employee_credentials'  -> password hashes (+ legacy plaintext temp pwds)
--   * 'server_session:%'      -> live session tokens (impersonation risk)
--   * 'password_reset:%'      -> password-reset OTP codes
--
-- These are only ever read/written by the app-auth edge function, which uses the
-- service_role key (service_role has BYPASSRLS, so it is unaffected by the
-- policies below). Login and password-change in the client are server-first;
-- the anon client only falls back to reading credentials when the backend is
-- unreachable (in which case the app cannot function anyway). Every other
-- app_state record (ratings, workflow, wizard config, comms, …) stays readable
-- and writable by anon so the app keeps working exactly as before.
--
-- Rollback (if ever needed):
--   drop policy app_state_anon_select on public.app_state;
--   drop policy app_state_anon_insert on public.app_state;
--   drop policy app_state_anon_update on public.app_state;
--   drop policy app_state_anon_delete on public.app_state;
--   alter table public.app_state disable row level security;

alter table public.app_state enable row level security;

-- A row is a protected auth secret when this is TRUE.
-- Anon policies below permit access only when it is FALSE.

drop policy if exists app_state_anon_select on public.app_state;
create policy app_state_anon_select on public.app_state
  for select to anon
  using (
    state_key <> 'employee_credentials'
    and state_key not like 'server_session:%'
    and state_key not like 'password_reset:%'
  );

drop policy if exists app_state_anon_insert on public.app_state;
create policy app_state_anon_insert on public.app_state
  for insert to anon
  with check (
    state_key <> 'employee_credentials'
    and state_key not like 'server_session:%'
    and state_key not like 'password_reset:%'
  );

drop policy if exists app_state_anon_update on public.app_state;
create policy app_state_anon_update on public.app_state
  for update to anon
  using (
    state_key <> 'employee_credentials'
    and state_key not like 'server_session:%'
    and state_key not like 'password_reset:%'
  )
  with check (
    state_key <> 'employee_credentials'
    and state_key not like 'server_session:%'
    and state_key not like 'password_reset:%'
  );

drop policy if exists app_state_anon_delete on public.app_state;
create policy app_state_anon_delete on public.app_state
  for delete to anon
  using (
    state_key <> 'employee_credentials'
    and state_key not like 'server_session:%'
    and state_key not like 'password_reset:%'
  );
