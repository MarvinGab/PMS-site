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

// --- background: publish_notification expands to notifications (+ emails when toggle on) ---
{
  // Fresh cycle for acme with email mirror ON and EMP002 (Eve, linked user) as an active participant.
  await admin.from('appraisal_cycles').update({ status: 'archived', archived_at: new Date().toISOString() }).eq('organization_id', org.id).neq('status', 'archived');
  const { data: cyc } = await admin.from('appraisal_cycles').insert({ organization_id: org.id, name: 'Jobs Cycle', framework_id: 'kra', status: 'published' }).select().single();
  await admin.from('cycle_config_snapshots').insert({ organization_id: org.id, cycle_id: cyc.id, snapshot: { notifications: { emailCommsEnabled: true } } });
  const { data: eve } = await admin.from('employees').select('id, user_id').eq('organization_id', org.id).eq('employee_code', 'EMP002').single();
  await admin.from('cycle_participants').insert({ organization_id: org.id, cycle_id: cyc.id, employee_id: eve.id });
  const { data: bg } = await admin.from('background_jobs').insert({ organization_id: org.id, cycle_id: cyc.id, job_type: 'publish_notification', payload: { cycleId: cyc.id }, status: 'queued' }).select().single();

  const run = await callJobs('jobs.run-background', {});
  check('run-background processes the publish_notification', run.status === 200 && run.body.data.ranJob === bg.id);
  const { data: after } = await admin.from('background_jobs').select('status, result, progress').eq('id', bg.id).single();
  check('background job marked done with result', after.status === 'done' && after.result && after.result.notifications >= 1);
  const { data: notes } = await admin.from('notifications').select('type').eq('cycle_id', cyc.id).eq('type', 'result_published');
  check('a result_published notification was created', (notes ?? []).length >= 1);
  const { data: mails } = await admin.from('email_jobs').select('template_key, status').eq('cycle_id', cyc.id).eq('template_key', 'publish');
  check('a publish email_job was queued (toggle on)', (mails ?? []).length >= 1 && mails[0].status === 'queued');
}

// --- run-background with an empty queue returns ranJob null ---
{
  await admin.from('background_jobs').update({ status: 'cancelled' }).eq('organization_id', org.id).eq('status', 'queued');
  const empty = await callJobs('jobs.run-background', {});
  check('run-background is a no-op on an empty queue', empty.status === 200 && empty.body.data.ranJob === null);
}

// --- tick runs both stages ---
{
  const tick = await callJobs('jobs.tick', { transport: 'simulate-success' });
  check('tick returns email + background summaries', tick.status === 200 && tick.body.data.emails && 'background' in tick.body.data);
}

console.log(`jobs-check: PASS (${n} assertions)`);
