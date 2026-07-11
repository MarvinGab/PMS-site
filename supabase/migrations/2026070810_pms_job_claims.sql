-- Concurrency-safe job claiming for the pms-jobs worker. FOR UPDATE SKIP LOCKED lets
-- overlapping ticks claim disjoint rows without blocking or double-processing.
-- Backend-only: only the service-role worker may execute these.

create or replace function pms.claim_email_jobs(p_limit int)
returns setof pms.email_jobs
language plpgsql
security definer
set search_path = pms, public
as $$
begin
  return query
  update pms.email_jobs j
     set status = 'sending', updated_at = now()
   where j.id in (
     select e.id from pms.email_jobs e
      where e.status = 'queued' and e.scheduled_at <= now()
      order by e.scheduled_at
      for update skip locked
      limit greatest(p_limit, 0)
   )
  returning j.*;
end $$;

create or replace function pms.claim_background_job()
returns setof pms.background_jobs
language plpgsql
security definer
set search_path = pms, public
as $$
begin
  return query
  update pms.background_jobs b
     set status = 'running', started_at = now(), updated_at = now()
   where b.id = (
     select k.id from pms.background_jobs k
      where k.status = 'queued' and k.scheduled_at <= now()
      order by k.scheduled_at
      for update skip locked
      limit 1
   )
  returning b.*;
end $$;

revoke all on function pms.claim_email_jobs(int) from public, anon, authenticated;
revoke all on function pms.claim_background_job() from public, anon, authenticated;
grant execute on function pms.claim_email_jobs(int) to service_role;
grant execute on function pms.claim_background_job() to service_role;
