import assert from 'node:assert/strict';
import { adminClient, SUPABASE_URL, SERVICE_KEY, ANON_KEY } from './_clients.mjs';

const admin = adminClient();
const JOBS_URL = `${SUPABASE_URL}/functions/v1/pms-jobs`;
let n = 0;
const check = (d, c) => { n += 1; assert.ok(c, `FAIL: ${d}`); console.log(`ok ${d}`); };
async function callJobs(action, payload = {}) {
  const res = await fetch(JOBS_URL, { method: 'POST', headers: { Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ action, ...payload }) });
  return { status: res.status, body: await res.json().catch(() => null) };
}

const { data: org } = await admin.from('organizations').select('id').eq('key', 'acme-test').single();

// helper: enqueue a fresh queued email job, return its id
async function enqueueEmail(template = 'publish') {
  const { data } = await admin.from('email_jobs').insert({ organization_id: org.id, template_key: template, recipient_email: 'sink@example.com', subject: 'Test', payload: { cycleName: 'FY-test', orgName: 'Acme' }, status: 'queued' }).select().single();
  return data;
}

// --- auth gate ---
{
  const bad = await fetch(JOBS_URL, { method: 'POST', headers: { Authorization: 'Bearer not-the-key', 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'jobs.drain-emails' }) });
  check('worker rejects a non-service-role bearer', bad.status === 401);
}

{
  const anon = await fetch(JOBS_URL, { method: 'POST', headers: { Authorization: `Bearer ${ANON_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'jobs.drain-emails' }) });
  check('worker rejects a valid anon token (role check)', anon.status === 401);
}

// --- simulate-success: job → sent + one attempt logged ---
{
  const job = await enqueueEmail();
  const r = await callJobs('jobs.drain-emails', { transport: 'simulate-success', limit: 50 });
  check('drain claims and sends (simulate-success)', r.status === 200 && r.body.data.sent >= 1);
  const { data: after } = await admin.from('email_jobs').select('status, sent_at').eq('id', job.id).single();
  check('email job marked sent', after.status === 'sent' && after.sent_at !== null);
  const { data: attempts } = await admin.from('email_delivery_attempts').select('status, provider').eq('email_job_id', job.id);
  check('a delivery attempt was logged', (attempts ?? []).length === 1 && attempts[0].status === 'sent' && attempts[0].provider === 'simulate');
}

// --- simulate-fail: job → requeued with backoff, attempts incremented ---
{
  const job = await enqueueEmail();
  const r = await callJobs('jobs.drain-emails', { transport: 'simulate-fail', limit: 50 });
  check('drain requeues on failure', r.status === 200 && r.body.data.requeued >= 1);
  const { data: after } = await admin.from('email_jobs').select('status, attempts, scheduled_at').eq('id', job.id).single();
  check('failed job requeued with attempts=1 and future schedule', after.status === 'queued' && after.attempts === 1 && new Date(after.scheduled_at) > new Date());
}

// --- exhausting attempts → terminal failed ---
{
  const { data: job } = await admin.from('email_jobs').insert({ organization_id: org.id, template_key: 'publish', recipient_email: 'sink@example.com', subject: 'T', payload: {}, status: 'queued', attempts: 4 }).select().single();
  const r = await callJobs('jobs.drain-emails', { transport: 'simulate-fail', limit: 50 });
  check('drain runs', r.status === 200);
  const { data: after } = await admin.from('email_jobs').select('status, attempts').eq('id', job.id).single();
  check('job marked failed after max attempts', after.status === 'failed' && after.attempts === 5);
}

// --- claim is exclusive: a claimed (sending) job is not re-claimed ---
{
  const { data: job } = await admin.from('email_jobs').insert({ organization_id: org.id, template_key: 'publish', recipient_email: 'x@example.com', subject: 'T', payload: {}, status: 'sending' }).select().single();
  await callJobs('jobs.drain-emails', { transport: 'simulate-success', limit: 50 });
  const { data: after } = await admin.from('email_jobs').select('status').eq('id', job.id).single();
  check('a job already in sending is not re-claimed by drain', after.status === 'sending');
}

console.log(`jobs-check: PASS (${n} assertions)`);
