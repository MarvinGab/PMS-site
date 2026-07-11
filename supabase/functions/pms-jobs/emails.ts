import { JobsCtx, JobsHandler } from './index.ts';
import { renderEmail } from '../_shared/emailTemplates.ts';
import nodemailer from 'npm:nodemailer@6.10.1';

const MAX_EMAIL_ATTEMPTS = 5;
function backoffMinutes(attempts: number): number { return Math.min(60, 2 ** attempts); }

type EmailJob = {
  id: string; organization_id: string; template_key: string; recipient_email: string;
  subject: string | null; payload: Record<string, unknown>; attempts: number;
};

function smtpConfig() {
  const host = Deno.env.get('SMTP_HOST') || '';
  const port = Number(Deno.env.get('SMTP_PORT') || '465');
  const user = Deno.env.get('SMTP_USER') || '';
  const pass = Deno.env.get('SMTP_PASS') || '';
  const from = Deno.env.get('SMTP_FROM') || user;
  const fromName = Deno.env.get('FROM_NAME') || 'PMS';
  return { host, port, user, pass, from, fromName, configured: Boolean(host && user && pass && from) };
}

async function logAttempt(ctx: JobsCtx, jobId: string, status: string, provider: string, response: string) {
  const { error } = await ctx.admin.from('email_delivery_attempts')
    .insert({ email_job_id: jobId, status, provider, provider_response: response.slice(0, 2000) });
  if (error) console.error('logAttempt', error);
}

// Deliver via the platform SMTP transport (the same engine send-email falls back to), decoupled
// from send-email's app-session/old-world coupling. 'simulate-*' short-circuits deterministically
// for tests; 'live' does a real SMTP send. The live path is structurally correct but not exercised
// by the gate — it needs a one-time real-send smoke at cutover.
async function deliver(_ctx: JobsCtx, job: EmailJob, transport: string): Promise<{ ok: boolean; provider: string; response: string }> {
  const rendered = renderEmail(job.template_key, job.payload ?? {}, job.subject ?? 'Notification');
  if (transport === 'simulate-success') return { ok: true, provider: 'simulate', response: 'simulated ok' };
  if (transport === 'simulate-fail') return { ok: false, provider: 'simulate', response: 'simulated failure' };
  const cfg = smtpConfig();
  if (!cfg.configured) return { ok: false, provider: 'smtp', response: 'SMTP transport not configured' };
  try {
    const transporter = nodemailer.createTransport({ host: cfg.host, port: cfg.port, secure: cfg.port === 465, auth: { user: cfg.user, pass: cfg.pass } });
    const info = await transporter.sendMail({ from: `${cfg.fromName} <${cfg.from}>`, to: job.recipient_email, subject: job.subject ?? rendered.subject, html: rendered.html, text: rendered.text });
    return { ok: true, provider: 'smtp', response: String((info as { messageId?: string })?.messageId ?? 'sent') };
  } catch (e) {
    return { ok: false, provider: 'smtp', response: (e as Error).message ?? 'smtp error' };
  }
}

export const emailHandlers: Record<string, JobsHandler> = {
  'jobs.drain-emails': async (payload, ctx) => {
    const limit = Math.min(Math.max(Number(payload.limit ?? 20) || 0, 1), 100);
    const transport = String(payload.transport ?? 'live');
    const { data: claimed, error } = await ctx.admin.rpc('claim_email_jobs', { p_limit: limit });
    if (error) { console.error('claim_email_jobs', error); throw Object.assign(new Error('Database error'), { code: 'DB_ERROR', status: 500 }); }
    const jobs = (claimed ?? []) as EmailJob[];
    let sent = 0, failed = 0, requeued = 0;
    for (const job of jobs) {
      try {
        const r = await deliver(ctx, job, transport);
        await logAttempt(ctx, job.id, r.ok ? 'sent' : 'failed', r.provider, r.response);
        if (r.ok) {
          const { error: uErr } = await ctx.admin.from('email_jobs').update({ status: 'sent', sent_at: new Date().toISOString() }).eq('id', job.id);
          if (uErr) { console.error('mark sent failed', job.id, uErr); continue; }
          sent += 1;
        } else {
          const attempts = (job.attempts ?? 0) + 1;
          if (attempts < MAX_EMAIL_ATTEMPTS) {
            const next = new Date(Date.now() + backoffMinutes(attempts) * 60_000).toISOString();
            const { error: uErr } = await ctx.admin.from('email_jobs').update({ status: 'queued', attempts, last_error: r.response.slice(0, 500), scheduled_at: next }).eq('id', job.id);
            if (uErr) { console.error('requeue failed', job.id, uErr); continue; }
            requeued += 1;
          } else {
            const { error: uErr } = await ctx.admin.from('email_jobs').update({ status: 'failed', attempts, last_error: r.response.slice(0, 500) }).eq('id', job.id);
            if (uErr) { console.error('mark failed failed', job.id, uErr); continue; }
            failed += 1;
          }
        }
      } catch (e) {
        console.error('drain job crashed', job.id, e);
      }
    }
    return { claimed: jobs.length, sent, failed, requeued };
  },
};
