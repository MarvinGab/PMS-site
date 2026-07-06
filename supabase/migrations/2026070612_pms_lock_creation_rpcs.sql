-- SECURITY FIX: the two creation RPCs are SECURITY DEFINER (they run with the
-- owner's privileges, bypassing RLS) and MUST be backend-only. The Plan-1
-- `alter default privileges ... revoke execute on functions from public`
-- (2026070315) did NOT suppress the automatic PUBLIC execute grant on these
-- functions created later, so an authenticated user could invoke them directly
-- and create organizations / cycles in ANY org — bypassing all authorization.
--
-- Revoke explicitly per-function. service_role keeps EXECUTE via its own grant
-- (2026070311), so the edge kernel is unaffected. Any future backend-only
-- function must carry its own explicit revoke like this — the default-privilege
-- revoke cannot be relied on for that.
revoke all on function pms.create_organization_tx(text, text, uuid) from public, anon, authenticated;
revoke all on function pms.create_cycle_draft_tx(uuid, text, text, text, uuid, text) from public, anon, authenticated;
