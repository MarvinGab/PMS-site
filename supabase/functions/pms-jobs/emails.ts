import { JobsCtx, JobsHandler } from './index.ts';
import { renderEmail } from '../_shared/emailTemplates.ts';

const MAX_EMAIL_ATTEMPTS = 5;
function backoffMinutes(attempts: number): number { return Math.min(60, 2 ** attempts); }

type EmailJob = {
  id: string; organization_id: string; template_key: string; recipient_email: string;
  subject: string | null; payload: Record<string, unknown>; attempts: number;
};

async function logAttempt(ctx: JobsCtx, jobId: string, status: string, provider: string, response: string) {
  const { error } = await ctx.admin.from('email_delivery_attempts')
    .insert({ email_job_id: jobId, status, provider, provider_response: response.slice(0, 2000) });
  if (error) console.error('logAttempt', error);
}

// Returns { ok, provider, response }. transport 'live' calls send-email; 'simulate-*' short-circuits.
async function deliver(ctx: JobsCtx, job: EmailJob, transport: string): Promise<{ ok: boolean; provider: string; response: string }> {
  const rendered = renderEmail(job.template_key, job.payload ?? {}, job.subject ?? 'Notification');
  if (transport === 'simulate-success') return { ok: true, provider: 'simulate', response: 'simulated ok' };
  if (transport === 'simulate-fail') return { ok: false, provider: 'simulate', response: 'simulated failure' };
  try {
    const res = await fetch(`${ctx.url}/functions/v1/send-email`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${ctx.serviceKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        organization_id: job.organization_id, recipientEmail: job.recipient_email,
        subjectOverride: job.subject ?? rendered.subject, htmlOverride: rendered.html, textOverride: rendered.text,
      }),
    });
    const txt = await res.text();
    let ok = res.ok;
    try { const p = JSON.parse(txt); if (p && p.ok === false) ok = false; } catch { /* non-JSON body */ }
    return { ok, provider: 'send-email', response: txt.slice(0, 2000) };
  } catch (e) {
    return { ok: false, provider: 'send-email', response: (e as Error).message ?? 'send error' };
  }
}

export const emailHandlers: Record<string, JobsHandler> = {
  'jobs.drain-emails': async (payload, ctx) => {
    const limit = Math.min(Math.max(Number(payload.limit ?? 20), 1), 100);
    const transport = String(payload.transport ?? 'live');
    const { data: claimed, error } = await ctx.admin.rpc('claim_email_jobs', { p_limit: limit });
    if (error) { console.error('claim_email_jobs', error); throw Object.assign(new Error('Database error'), { code: 'DB_ERROR', status: 500 }); }
    const jobs = (claimed ?? []) as EmailJob[];
    let sent = 0, failed = 0, requeued = 0;
    for (const job of jobs) {
      const r = await deliver(ctx, job, transport);
      await logAttempt(ctx, job.id, r.ok ? 'sent' : 'failed', r.provider, r.response);
      if (r.ok) {
        await ctx.admin.from('email_jobs').update({ status: 'sent', sent_at: new Date().toISOString() }).eq('id', job.id);
        sent += 1;
      } else {
        const attempts = (job.attempts ?? 0) + 1;
        if (attempts < MAX_EMAIL_ATTEMPTS) {
          const next = new Date(Date.now() + backoffMinutes(attempts) * 60_000).toISOString();
          await ctx.admin.from('email_jobs').update({ status: 'queued', attempts, last_error: r.response.slice(0, 500), scheduled_at: next }).eq('id', job.id);
          requeued += 1;
        } else {
          await ctx.admin.from('email_jobs').update({ status: 'failed', attempts, last_error: r.response.slice(0, 500) }).eq('id', job.id);
          failed += 1;
        }
      }
    }
    return { claimed: jobs.length, sent, failed, requeued };
  },
};
