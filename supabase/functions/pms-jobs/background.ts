import { JobsCtx, JobsHandler } from './index.ts';
import { emailHandlers } from './emails.ts';

function backoffMinutes(n: number): number { return Math.min(60, 2 ** n); }

type BgJob = { id: string; organization_id: string; cycle_id: string | null; job_type: string; payload: Record<string, unknown>; retry_count: number; max_retries: number };

// Insert a queued email job. Returns false (logged) on a DB error so the caller never over-counts
// a write that didn't land, and a done job's result stays truthful.
async function enqueueEmail(ctx: JobsCtx, orgId: string, cycleId: string | null, templateKey: string, email: string, memberId: string | null, subject: string, payload: Record<string, unknown>): Promise<boolean> {
  const { error } = await ctx.admin.from('email_jobs').insert({ organization_id: orgId, cycle_id: cycleId, template_key: templateKey, recipient_email: email, recipient_member_id: memberId, subject, payload, status: 'queued' });
  if (error) { console.error('enqueueEmail insert', error); return false; }
  return true;
}
async function notify(ctx: JobsCtx, orgId: string, cycleId: string | null, memberId: string, type: string, title: string, body: string): Promise<boolean> {
  const { error } = await ctx.admin.from('notifications').insert({ organization_id: orgId, cycle_id: cycleId, recipient_member_id: memberId, type, title, body });
  if (error) { console.error('notify insert', error); return false; }
  return true;
}

// Idempotency probes for publish_notification (at-least-once retries must not double-send).
async function hasNotification(ctx: JobsCtx, orgId: string, cycleId: string, memberId: string, type: string): Promise<boolean> {
  const { data, error } = await ctx.admin.from('notifications').select('id').eq('organization_id', orgId).eq('cycle_id', cycleId).eq('recipient_member_id', memberId).eq('type', type).limit(1);
  if (error) { console.error('hasNotification', error); throw Object.assign(new Error('Database error'), { code: 'DB_ERROR', status: 500 }); }
  return (data ?? []).length > 0;
}
async function hasEmailJob(ctx: JobsCtx, orgId: string, cycleId: string, memberId: string, templateKey: string): Promise<boolean> {
  const { data, error } = await ctx.admin.from('email_jobs').select('id').eq('organization_id', orgId).eq('cycle_id', cycleId).eq('recipient_member_id', memberId).eq('template_key', templateKey).limit(1);
  if (error) { console.error('hasEmailJob', error); throw Object.assign(new Error('Database error'), { code: 'DB_ERROR', status: 500 }); }
  return (data ?? []).length > 0;
}

// Is the cycle's email mirror toggle on? Snapshot notification block; default OFF unless explicitly enabled.
async function emailMirrorEnabled(ctx: JobsCtx, orgId: string, cycleId: string): Promise<boolean> {
  const { data, error } = await ctx.admin.from('cycle_config_snapshots').select('snapshot').eq('cycle_id', cycleId).eq('organization_id', orgId).maybeSingle();
  if (error) { console.error('emailMirrorEnabled', error); throw Object.assign(new Error('Database error'), { code: 'DB_ERROR', status: 500 }); }
  const snap = (data?.snapshot ?? {}) as Record<string, any>;
  return snap?.notifications?.emailCommsEnabled === true || snap?.features?.emailCommsEnabled === true;
}

// Active participants with their linked member + email. Org-scoped.
async function participants(ctx: JobsCtx, orgId: string, cycleId: string) {
  const { data, error } = await ctx.admin.from('cycle_participants')
    .select('employee_id, employees(email, user_id), status')
    .eq('cycle_id', cycleId).eq('organization_id', orgId).eq('status', 'active');
  if (error) throw Object.assign(new Error('Database error'), { code: 'DB_ERROR', status: 500 });
  return data ?? [];
}
async function memberIdForUser(ctx: JobsCtx, orgId: string, userId: string): Promise<string | null> {
  const { data, error } = await ctx.admin.from('org_members').select('id').eq('organization_id', orgId).eq('user_id', userId).maybeSingle();
  if (error) { console.error('memberIdForUser', error); throw Object.assign(new Error('Database error'), { code: 'DB_ERROR', status: 500 }); }
  return data?.id ?? null;
}
async function setProgress(ctx: JobsCtx, jobId: string, progress: number, total: number) {
  const { error } = await ctx.admin.from('background_jobs').update({ progress, total }).eq('id', jobId);
  if (error) console.error('setProgress', jobId, error);
}

async function runPublishNotification(ctx: JobsCtx, job: BgJob): Promise<{ emails: number; notifications: number }> {
  const cycleId = String(job.payload.cycleId ?? job.cycle_id ?? '');
  if (!cycleId) throw Object.assign(new Error('publish_notification requires cycleId'), { code: 'BAD_REQUEST', status: 400 });
  const emailOn = await emailMirrorEnabled(ctx, job.organization_id, cycleId);
  const parts = await participants(ctx, job.organization_id, cycleId);
  const { data: cyc, error: cErr } = await ctx.admin.from('appraisal_cycles').select('name').eq('id', cycleId).eq('organization_id', job.organization_id).maybeSingle();
  if (cErr) { console.error('publish cycle name', cErr); throw Object.assign(new Error('Database error'), { code: 'DB_ERROR', status: 500 }); }
  const cycleName = cyc?.name ?? 'your cycle';
  let emails = 0, notifications = 0, done = 0;
  for (const p of parts) {
    const e = p.employees as unknown as { email: string | null; user_id: string | null } | null;
    done += 1;
    await setProgress(ctx, job.id, done, parts.length);
    if (!e?.user_id) continue;
    const memberId = await memberIdForUser(ctx, job.organization_id, e.user_id);
    if (!memberId) continue;
    // Idempotent under at-least-once retries: skip anyone already notified/emailed for this cycle.
    if (!(await hasNotification(ctx, job.organization_id, cycleId, memberId, 'result_published'))) {
      if (await notify(ctx, job.organization_id, cycleId, memberId, 'result_published', 'Results published', `Your ${cycleName} results are available.`)) notifications += 1;
    }
    if (emailOn && e.email && !(await hasEmailJob(ctx, job.organization_id, cycleId, memberId, 'publish'))) {
      if (await enqueueEmail(ctx, job.organization_id, cycleId, 'publish', e.email, memberId, 'Your appraisal results are published', { cycleName, orgName: '' })) emails += 1;
    }
  }
  return { emails, notifications };
}

async function runReminderBatch(ctx: JobsCtx, job: BgJob): Promise<{ emails: number; notifications: number }> {
  const cycleId = String(job.payload.cycleId ?? job.cycle_id ?? '');
  const stage = String(job.payload.stage ?? 'your appraisal task');
  if (!cycleId) throw Object.assign(new Error('reminder_batch requires cycleId'), { code: 'BAD_REQUEST', status: 400 });
  const emailOn = await emailMirrorEnabled(ctx, job.organization_id, cycleId);
  const parts = await participants(ctx, job.organization_id, cycleId);
  let emails = 0, notifications = 0, done = 0;
  // Reminders are intentionally repeatable (HR may send several batches over a cycle), so — unlike
  // publish_notification — there is deliberately NO dedup here. This is at-least-once: a rare mid-loop
  // retry may re-notify participants already processed on the prior attempt. Accepted: an extra
  // reminder is harmless, and suppressing legitimate repeat reminder batches would be worse.
  for (const p of parts) {
    const e = p.employees as unknown as { email: string | null; user_id: string | null } | null;
    done += 1;
    await setProgress(ctx, job.id, done, parts.length);
    if (!e?.user_id) continue;
    const memberId = await memberIdForUser(ctx, job.organization_id, e.user_id);
    if (!memberId) continue;
    if (await notify(ctx, job.organization_id, cycleId, memberId, 'reminder', 'Reminder', `Please complete ${stage}.`)) notifications += 1;
    if (emailOn && e.email) {
      if (await enqueueEmail(ctx, job.organization_id, cycleId, 'reminder', e.email, memberId, `Reminder: ${stage}`, { stage, cycleName: '' })) emails += 1;
    }
  }
  return { emails, notifications };
}

export const backgroundHandlers: Record<string, JobsHandler> = {
  'jobs.run-background': async (_payload, ctx) => {
    const { data: claimed, error } = await ctx.admin.rpc('claim_background_job', {});
    if (error) { console.error('claim_background_job', error); throw Object.assign(new Error('Database error'), { code: 'DB_ERROR', status: 500 }); }
    const job = ((claimed ?? []) as BgJob[])[0];
    if (!job) return { ranJob: null };
    try {
      let result: unknown = {};
      if (job.job_type === 'publish_notification') result = await runPublishNotification(ctx, job);
      else if (job.job_type === 'reminder_batch') result = await runReminderBatch(ctx, job);
      else throw Object.assign(new Error(`unknown job_type ${job.job_type}`), { code: 'BAD_REQUEST', status: 400 });
      await ctx.admin.from('background_jobs').update({ status: 'done', finished_at: new Date().toISOString(), result }).eq('id', job.id);
      return { ranJob: job.id, jobType: job.job_type, result };
    } catch (e) {
      const rc = (job.retry_count ?? 0) + 1;
      if (rc < (job.max_retries ?? 3)) {
        const next = new Date(Date.now() + backoffMinutes(rc) * 60_000).toISOString();
        await ctx.admin.from('background_jobs').update({ status: 'queued', retry_count: rc, scheduled_at: next, error: (e as Error).message }).eq('id', job.id);
      } else {
        await ctx.admin.from('background_jobs').update({ status: 'failed', retry_count: rc, finished_at: new Date().toISOString(), error: (e as Error).message }).eq('id', job.id);
      }
      return { ranJob: job.id, jobType: job.job_type, failed: true };
    }
  },

  'jobs.tick': async (payload, ctx) => {
    const emails = await emailHandlers['jobs.drain-emails']({ limit: payload.emailLimit ?? 50, transport: payload.transport ?? 'live' }, ctx);
    const background = await backgroundHandlers['jobs.run-background']({}, ctx);
    return { emails, background };
  },
};
