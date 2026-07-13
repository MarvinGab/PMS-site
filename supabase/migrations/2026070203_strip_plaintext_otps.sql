-- Security: remove plaintext temporary passwords (pendingTempPassword) that were
-- being stored at rest inside the employee_credentials blob. Only the PBKDF2
-- hash is needed for login; the plaintext was previously kept so the invite
-- email could include it, but the send path uses an in-memory copy — so the
-- stored plaintext was pure exposure. The client no longer writes it.
--
-- This rewrites each credential entry with 'pendingTempPassword' removed, leaving
-- passwordHash and all metadata intact. Safe: does not affect login.

update public.app_state
set payload = (
      select coalesce(jsonb_object_agg(key, value - 'pendingTempPassword'), '{}'::jsonb)
      from jsonb_each(payload)
    ),
    updated_at = now()
where state_key = 'employee_credentials'
  and jsonb_typeof(payload) = 'object';
