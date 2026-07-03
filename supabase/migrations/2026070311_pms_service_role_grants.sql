-- PostgREST enforces plain object privileges even for service_role (BYPASSRLS ≠ GRANT).
grant usage on schema pms to service_role;
grant all on all tables in schema pms to service_role;
grant all on all sequences in schema pms to service_role;
grant execute on all functions in schema pms to service_role;
alter default privileges in schema pms grant all on tables to service_role;
alter default privileges in schema pms grant all on sequences to service_role;
alter default privileges in schema pms grant execute on functions to service_role;
notify pgrst, 'reload config';
