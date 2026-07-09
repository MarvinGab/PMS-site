# Rebuild Plan 4: Background Jobs & Email Worker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Drain the queued `email_jobs` and `background_jobs` server-side — a scheduled `pms-jobs` worker that claims jobs concurrency-safely, renders and sends invite/reminder/publish emails through the existing multi-provider engine, logs every delivery attempt, retries failures with backoff, and expands publish/reminder batch jobs into per-recipient emails + in-app notifications — with HR-visible status/progress.

**Architecture:** A new system edge function `pms-jobs` (Deno, `verify_jwt=false`, authorized by the service-role bearer — NOT a user JWT) claims jobs via `SECURITY DEFINER` RPCs using `FOR UPDATE SKIP LOCKED`, so overlapping ticks never double-process. Email delivery reuses the existing `send-email` function (SMTP/Microsoft/Google + platform fallback) via a function-to-function call; the worker only renders subject/html/text and passes overrides. A pure `_shared/emailTemplates.ts` renders by `template_key`. Background jobs (`publish_notification`, `reminder_batch`) expand into `email_jobs` + `notifications` rows. The every-minute `jobs.tick` schedule is a deploy/ops step (pg_cron+Vault or a dashboard schedule — the key can't be committed), documented in the carried-forward notes; the gate drives the worker directly. **Exports are OUT OF SCOPE** (deferred to a later plan, per product decision). Tests use a **simulated transport** (secret-gated) so the gate verifies queue→attempt→sent/failed→retry→give-up deterministically with no real email.

**Tech Stack:** Supabase edge functions (Deno, `npm:@supabase/supabase-js@2`, reuse `npm:nodemailer` only inside the untouched `send-email`), Postgres (`pms` schema, `SECURITY DEFINER` claim RPCs, optional pg_cron/pg_net), Node verify scripts with `node:assert`, Supabase CLI (linked project `mkjtdwrzmobahwkpumxx`).

**Spec:** `docs/superpowers/specs/2026-07-03-server-first-rebuild-design.md` §8 (background_jobs queued→running→done/failed with progress/retry, worked by a scheduled backend function every minute; every email is an `email_jobs` row sent by the worker through the existing multi-provider engine with attempts logged in `email_delivery_attempts` and failed sends retryable; notifications email-mirror through the same path when the cycle email toggle is on), §5 line 100 (grouped edge function `pms-jobs`), §5 line 61 (plumbing tables).

## Worker Model (authoritative — implement exactly this)

- **`pms-jobs` is a system worker, not a user API.** `verify_jwt=false`. The entrypoint requires `Authorization: Bearer <SUPABASE_SERVICE_ROLE_KEY>` (auto-injected function env). Any other/absent bearer → `401` before any work. It uses a service-role client. It never trusts a user identity; callers are the cron and the verify scripts, both holding the service-role key.
- **Claiming is concurrency-safe.** Jobs are claimed by `SECURITY DEFINER` RPCs using `FOR UPDATE SKIP LOCKED`, flipping `queued→sending` (emails) / `queued→running` (background) and stamping `started_at`, returning the claimed rows. Two overlapping ticks never grab the same row. The RPCs are backend-only (revoked from public/anon/authenticated) with a live `42501` denial test.
- **Email delivery reuses `send-email`.** For each claimed email job the worker renders `{subject, html, text}` from `template_key`+`payload`, then POSTs to the deployed `send-email` function with `{ recipientEmail, subjectOverride, htmlOverride, textOverride, organization_id }` and the service-role bearer. `send-email` resolves the org's SMTP (or platform default) and sends. The worker treats a non-2xx / `{ok:false}` as a failure. **The `send-email` function is OLD-WORLD and MUST NOT be modified.**
- **Delivery attempts + retry/backoff.** Every send attempt appends an `email_delivery_attempts` row (`status`, `provider`, `provider_response`). On success: `email_jobs.status='sent'`, `sent_at=now()`. On failure: `attempts+=1`, `last_error=…`; if `attempts < MAX_EMAIL_ATTEMPTS` (5) → back to `status='queued'` with `scheduled_at=now()+backoff(attempts)` (exponential: `min(60, 2^attempts)` minutes); else `status='failed'` (terminal, HR-visible, manually retryable later). The claim RPC only returns `status='queued' AND scheduled_at<=now()`.
- **Test transport (simulate).** The drain action accepts an optional `transport` (`'live'` default | `'simulate-success'` | `'simulate-fail'`). Only reachable behind the service-role bearer, so it is safe. `simulate-*` replaces the `send-email` POST with a deterministic outcome (still logs an attempt with `provider='simulate'`). The gate uses this; production omits it.
- **Background jobs expand into emails + notifications.** `jobs.run-background` claims ONE queued `background_jobs`, dispatches by `job_type`:
  - `publish_notification` (payload `{cycleId}`): for each active participant with a linked member, insert a `notifications` row (`type='result_published'`) AND an `email_jobs` row (`template_key='publish'`) — but only email-mirror when the cycle's snapshot notification/email toggle is on; always insert the in-app notification. Set `progress`/`total`, `status='done'`, `result={emails, notifications}`.
  - `reminder_batch` (payload `{cycleId, stage}`): for each active participant still missing the given step, insert a `notifications` row (`type='reminder'`) + (toggle-gated) an `email_jobs` (`template_key='reminder'`).
  - On handler throw: `retry_count+=1`; if `< max_retries` → `status='queued'`, `scheduled_at=now()+backoff`; else `status='failed'`, `error=…`.
- **`jobs.tick`** = drain a batch of emails THEN run one background job. This is the single action the every-minute cron calls.
- **HR status/progress needs no new endpoint.** `email_jobs` + `background_jobs` already carry `hr_read` RLS (`is_org_reader`); screens (Plan 5) read them directly. This plan does not build read endpoints.

## Global Constraints

- **Write rule:** browser reads via RLS only; ALL business writes go through backend functions. No new grants to `anon`. The claim RPCs are `SECURITY DEFINER` and **backend-only** — every one gets an explicit `revoke ... from public, anon, authenticated` and a live `42501` denial assertion (systemic lesson from Plans 2a/2b).
- **Do NOT modify old-world files:** `send-email`, `email-config`, `app-auth`, `pms-actions`, `src/**`, `supabase/schema-v1.sql`, the 7 untracked old migrations. `pms-jobs` CALLS `send-email` over HTTP; it never edits it. `src/` screens are untouched (Plan 5 rewires screens).
- **Kernel note:** `pms-jobs` does NOT use the user-JWT `serveActions` kernel (that requires a user token). It has its own tiny entrypoint: parse `{action, ...}` → service-role-bearer check → dispatch → `{ok:true,data}`/`{ok:false,error:{code,message}}`. Raw DB errors never reach callers (`console.error` + generic `DB_ERROR` 500). Reuse `_shared/validate.ts` validators. Every non-trivial read is org-scoped where an org applies.
- **Optimistic concurrency:** the claim RPCs own the queued→sending/running transition atomically (SKIP LOCKED), so post-claim per-job writes (attempt log, status flip) are plain updates keyed by id — no version token needed on the worker path (the row is already claimed/owned). Enqueue writes into `email_jobs`/`background_jobs` are simple inserts.
- **Migration ordering & numbering:** new migrations are dated 2026-07-08+ and sort AFTER the last applied `2026070628`. If a later-numbered migration is added below an already-applied one, use `supabase db push --include-all`.
- **Secrets:** never print/commit `.env`. The worker relies on auto-injected `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY`; `send-email` relies on its already-set `SMTP_*` secrets (untouched). If `deno.lock` changes, do NOT stage it.
- **Build in an ISOLATED WORKTREE off pushed `main`** (`rebuild-4-jobs`) — never build in the dirty parent folder (uncommitted old-app edits in `src/`, `app-auth`, old migrations). Wire `.env`, symlink `node_modules`, copy `supabase/.temp`, copy the 7 untracked old-app migrations (`2026062501..2026070301`) so `supabase db push` reconciles.
- **Deploy gate for subagents:** implementers CANNOT run `supabase functions deploy` / `db push` (permission-blocked). Proven handoff: agent writes code + `deno check` + STOPS (NEEDS_CONTEXT); controller deploys/pushes from the worktree; controller resumes agent to run the live check + commit.
- Commit trailer on every commit: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`
- Verify counts at branch start: `rls-check` 55, `admin-check` 97, `workflow-check` 70. This plan ADDS `jobs-check.mjs` and grows `admin-check`; each task states expected totals.
- **Go-live note (carry forward, unchanged):** Supabase Auth signups must be disabled manually in the dashboard before production — not automatable here.

---

### Task 1: Claim RPCs (concurrency-safe queue) — migration

**Files:**
- Create: `supabase/migrations/2026070810_pms_job_claims.sql`
- Modify: `supabase/verify/rls-check.mjs` (add backend-only denial assertions for the new RPCs)

**Interfaces:**
- Produces (used by Tasks 3–4):
  - `pms.claim_email_jobs(p_limit int) returns setof pms.email_jobs` — atomically flips up to `p_limit` rows where `status='queued' AND scheduled_at<=now()` to `status='sending'` (via `FOR UPDATE SKIP LOCKED`), returns the claimed rows.
  - `pms.claim_background_job() returns setof pms.background_jobs` — atomically flips the single oldest `status='queued' AND scheduled_at<=now()` row to `status='running'`, `started_at=now()`, returns it (0 or 1 rows).
  - Both `SECURITY DEFINER`, `search_path=pms,public`, revoked from `public, anon, authenticated`.

- [ ] **Step 1: Write the migration**

`supabase/migrations/2026070810_pms_job_claims.sql`:

```sql
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
```

- [ ] **Step 2: Controller pushes the migration**

(Implementer STOPS here — `db push` is gated.) Controller runs: `supabase db push` (or `--include-all` if out of order). Expected: `2026070810_pms_job_claims` applied.

- [ ] **Step 3: Add backend-only denial assertions to `rls-check.mjs`**

Find the section where other backend-only RPCs are asserted denied for anon/authenticated (search for `link_invited_member_tx` or `42501`). Append, mirroring that pattern, using the anon client and an authenticated (employee) client:

`rls-check.mjs` already imports `{ anonClient, signIn, adminClient }` and `{ USERS, PASSWORD }`. `signIn` returns `{ client, session, userId }`. A genuine backend-only denial surfaces SQLSTATE `42501` (the file has a comment noting a vacuous "some error" check is not enough — assert the code). Append:

```js
// --- Plan 4 claim RPCs are backend-only (not callable by anon or a logged-in employee) ---
{
  const anon = anonClient();
  const a1 = await anon.rpc('claim_email_jobs', { p_limit: 1 });
  check('claim_email_jobs denied for anon', a1.error?.code === '42501');
  const a2 = await anon.rpc('claim_background_job', {});
  check('claim_background_job denied for anon', a2.error?.code === '42501');
  const { client: empC } = await signIn(USERS.employee, PASSWORD);
  const e1 = await empC.rpc('claim_email_jobs', { p_limit: 1 });
  check('claim_email_jobs denied for authenticated employee', e1.error?.code === '42501');
}
```

- [ ] **Step 4: Controller runs the check**

Run: `node supabase/verify/seed-foundation.mjs && node supabase/verify/rls-check.mjs`
Expected: `rls-check: PASS (58 assertions)` (55 + 3). Trust the printed count.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/2026070810_pms_job_claims.sql supabase/verify/rls-check.mjs
git commit -m "feat(jobs): concurrency-safe claim RPCs (FOR UPDATE SKIP LOCKED), backend-only"
```

---

### Task 2: Pure email template renderer

**Files:**
- Create: `supabase/functions/_shared/emailTemplates.ts`
- Create: `supabase/functions/_shared/emailTemplates.test.ts`

**Interfaces:**
- Produces (used by Task 3):
  - `type RenderedEmail = { subject: string; html: string; text: string }`
  - `renderEmail(templateKey: string, payload: Record<string, unknown>, fallbackSubject?: string) → RenderedEmail` — supports `invite`, `reminder`, `publish`, and a safe generic fallback for unknown keys. Escapes HTML from payload values. Never throws on a missing payload field (renders a sensible default).

- [ ] **Step 1: Write failing tests**

`supabase/functions/_shared/emailTemplates.test.ts`:

```ts
import { assertEquals, assertStringIncludes } from 'jsr:@std/assert@1';
import { renderEmail } from './emailTemplates.ts';

Deno.test('invite renders the action link and a subject', () => {
  const r = renderEmail('invite', { actionLink: 'https://app/set?token=abc', orgName: 'Acme' });
  assertStringIncludes(r.subject.toLowerCase(), 'invit');
  assertStringIncludes(r.html, 'https://app/set?token=abc');
  assertStringIncludes(r.text, 'https://app/set?token=abc');
});

Deno.test('publish renders a results-ready message', () => {
  const r = renderEmail('publish', { cycleName: 'FY26', orgName: 'Acme' });
  assertStringIncludes(r.subject.toLowerCase(), 'result');
  assertStringIncludes(r.html, 'FY26');
});

Deno.test('reminder renders the stage', () => {
  const r = renderEmail('reminder', { stage: 'self evaluation', cycleName: 'FY26' });
  assertStringIncludes(r.text.toLowerCase(), 'self evaluation');
});

Deno.test('unknown template falls back safely (no throw)', () => {
  const r = renderEmail('mystery', { subject: 'Hi there' }, 'Notification');
  assertEquals(typeof r.html, 'string');
  assertEquals(typeof r.text, 'string');
  assertStringIncludes(r.subject, 'Hi there');
});

Deno.test('payload values are HTML-escaped', () => {
  const r = renderEmail('publish', { cycleName: '<script>x</script>', orgName: 'Acme' });
  assertEquals(r.html.includes('<script>x</script>'), false);
  assertStringIncludes(r.html, '&lt;script&gt;');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `deno test supabase/functions/_shared/emailTemplates.test.ts`
Expected: FAIL — `Module not found ... emailTemplates.ts`.

- [ ] **Step 3: Implement `emailTemplates.ts`**

`supabase/functions/_shared/emailTemplates.ts`:

```ts
export type RenderedEmail = { subject: string; html: string; text: string };

function esc(v: unknown): string {
  return String(v ?? '')
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

function layout(title: string, bodyHtml: string): string {
  return `<div style="font-family:system-ui,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#0f172a">`
    + `<div style="font-size:12px;font-weight:700;letter-spacing:.08em;color:#2563eb;text-transform:uppercase">PMS</div>`
    + `<h1 style="font-size:22px;margin:8px 0 16px">${esc(title)}</h1>${bodyHtml}</div>`;
}

export function renderEmail(
  templateKey: string,
  payload: Record<string, unknown>,
  fallbackSubject = 'Notification',
): RenderedEmail {
  const org = esc(payload.orgName ?? 'your organization');
  const cycle = esc(payload.cycleName ?? 'the current cycle');
  switch (templateKey) {
    case 'invite': {
      const link = esc(payload.actionLink ?? '');
      const subject = 'You have been invited to the appraisal system';
      const html = layout('You have been invited', link
        ? `<p>${org} has invited you. Set your password to get started:</p><p><a href="${link}">Set your password</a></p><p style="color:#64748b;font-size:13px">If the link doesn't work, paste this into your browser:<br>${link}</p>`
        : `<p>${org} has invited you to the appraisal system. Please contact HR for your sign-in link.</p>`);
      const text = link ? `You have been invited by ${payload.orgName ?? 'your organization'}. Set your password: ${payload.actionLink}` : `You have been invited by ${payload.orgName ?? 'your organization'}.`;
      return { subject, html, text };
    }
    case 'publish': {
      const subject = 'Your appraisal results are published';
      const html = layout('Results published', `<p>Your appraisal results for <strong>${cycle}</strong> at ${org} are now available. Sign in to review them.</p>`);
      const text = `Your appraisal results for ${payload.cycleName ?? 'the current cycle'} are now available. Sign in to review them.`;
      return { subject, html, text };
    }
    case 'reminder': {
      const stage = esc(payload.stage ?? 'your appraisal task');
      const subject = `Reminder: ${String(payload.stage ?? 'appraisal task')}`;
      const html = layout('Reminder', `<p>This is a reminder to complete <strong>${stage}</strong> for ${cycle}.</p>`);
      const text = `Reminder: please complete ${payload.stage ?? 'your appraisal task'} for ${payload.cycleName ?? 'the current cycle'}.`;
      return { subject, html, text };
    }
    default: {
      const subject = esc(payload.subject ?? fallbackSubject);
      const bodyText = String(payload.body ?? payload.message ?? '');
      const html = layout(String(payload.subject ?? fallbackSubject), `<p>${esc(bodyText)}</p>`);
      return { subject: String(payload.subject ?? fallbackSubject), html, text: bodyText || String(payload.subject ?? fallbackSubject) };
    }
  }
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `deno test supabase/functions/_shared/emailTemplates.test.ts`
Expected: `ok | 5 passed | 0 failed`.

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/_shared/emailTemplates.ts supabase/functions/_shared/emailTemplates.test.ts
git commit -m "feat(jobs): pure email template renderer (invite/publish/reminder + escaped fallback)"
```

---

### Task 3: `pms-jobs` worker — email drain

**Files:**
- Create: `supabase/functions/pms-jobs/config.toml` (`verify_jwt = false`)
- Create: `supabase/functions/pms-jobs/index.ts` (entrypoint: service-role-bearer guard + action dispatch)
- Create: `supabase/functions/pms-jobs/emails.ts` (`jobs.drain-emails`)
- Create: `supabase/verify/jobs-check.mjs` (new suite)

**Interfaces:**
- Consumes: `pms.claim_email_jobs` (Task 1), `renderEmail` (Task 2), `_shared/validate.ts`.
- Produces action `jobs.drain-emails` `{limit?, transport?}` → `{claimed, sent, failed, requeued}` — claims up to `limit` (default 20) email jobs; for each, render + deliver (live via `send-email`, or simulated); append an `email_delivery_attempts` row; transition sent / requeue-with-backoff / failed. `transport ∈ 'live'|'simulate-success'|'simulate-fail'` (default `live`).
- Produces the entrypoint contract for Task 4 to extend (`background.ts` handlers spread into the same dispatch).

- [ ] **Step 1: config.toml**

`supabase/functions/pms-jobs/config.toml`:

```toml
verify_jwt = false
```

- [ ] **Step 2: Entrypoint with service-role-bearer guard**

`supabase/functions/pms-jobs/index.ts`:

```ts
import { createClient, SupabaseClient } from 'npm:@supabase/supabase-js@2';
import { emailHandlers } from './emails.ts';

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, content-type' };

export type JobsCtx = { admin: SupabaseClient; url: string; serviceKey: string };
export type JobsHandler = (payload: Record<string, unknown>, ctx: JobsCtx) => Promise<unknown>;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
}

const handlers: Record<string, JobsHandler> = { ...emailHandlers };

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  const url = Deno.env.get('SUPABASE_URL') ?? '';
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  const bearer = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
  if (!serviceKey || bearer !== serviceKey) {
    return json({ ok: false, error: { code: 'UNAUTHORIZED', message: 'Worker requires the service role key' } }, 401);
  }
  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ ok: false, error: { code: 'BAD_REQUEST', message: 'Invalid JSON' } }, 400); }
  const action = String(body.action ?? '');
  const handler = handlers[action];
  if (!handler) return json({ ok: false, error: { code: 'UNKNOWN_ACTION', message: action } }, 404);
  const admin = createClient(url, serviceKey, { auth: { persistSession: false }, db: { schema: 'pms' } });
  try {
    const data = await handler(body, { admin, url, serviceKey });
    return json({ ok: true, data });
  } catch (e) {
    const code = (e as { code?: string }).code ?? 'DB_ERROR';
    const status = (e as { status?: number }).status ?? 500;
    if (status >= 500) console.error('pms-jobs handler error', action, e);
    return json({ ok: false, error: { code, message: (e as Error).message ?? 'Error' } }, status);
  }
});
```

> Note: `db: { schema: 'pms' }` makes `.from('email_jobs')` resolve to `pms.email_jobs` (matches the kernel's convention). The `.rpc('claim_email_jobs', …)` resolves `pms.claim_email_jobs`.

- [ ] **Step 3: Email drain handler**

`supabase/functions/pms-jobs/emails.ts`:

```ts
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
```

- [ ] **Step 4: Controller deploys**

(Implementer STOPS — deploy is gated.) Controller: `supabase functions deploy pms-jobs`. Expected: deployed.

- [ ] **Step 5: `jobs-check.mjs` — email mechanics**

`supabase/verify/jobs-check.mjs` — `_clients.mjs` exports `SERVICE_KEY` (the service-role key) and calls `loadEnv()` at import, so env is bootstrapped automatically:

```js
import assert from 'node:assert/strict';
import { adminClient, SUPABASE_URL, SERVICE_KEY } from './_clients.mjs';

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
```

(Match `_clients.mjs`/`_env.mjs` exports for the service-role key — grep them; if the key is only in `_env.mjs` as e.g. `SERVICE_ROLE_KEY` or read from `process.env.SUPABASE_SERVICE_ROLE_KEY`, use that.)

- [ ] **Step 6: Controller runs the check**

Run: `node supabase/verify/seed-foundation.mjs && node supabase/verify/jobs-check.mjs`
Expected: `jobs-check: PASS (8 assertions)`.

- [ ] **Step 7: Commit**

```bash
git add supabase/functions/pms-jobs/config.toml supabase/functions/pms-jobs/index.ts supabase/functions/pms-jobs/emails.ts supabase/verify/jobs-check.mjs
git commit -m "feat(jobs): pms-jobs worker + email drain (claim/render/deliver/attempts/retry, simulate transport)"
```

---

### Task 4: `pms-jobs` — background job runner + tick

**Files:**
- Create: `supabase/functions/pms-jobs/background.ts` (`jobs.run-background`, `jobs.tick`)
- Modify: `supabase/functions/pms-jobs/index.ts` (spread `backgroundHandlers`)
- Modify: `supabase/verify/jobs-check.mjs` (background + tick assertions)

**Interfaces:**
- Consumes: `pms.claim_background_job` (Task 1), the email drain (Task 3).
- Produces:
  - `jobs.run-background` `{}` → `{ranJob: string|null, jobType?, result?}` — claims one background job; dispatches `publish_notification` / `reminder_batch`; sets progress/total, `status='done'`+`result` on success, or retry/backoff/`failed` on throw.
  - `jobs.tick` `{emailLimit?, transport?}` → `{emails, background}` — runs `jobs.drain-emails` then `jobs.run-background` (the every-minute cron entrypoint).

- [ ] **Step 1: Background runner**

`supabase/functions/pms-jobs/background.ts`:

```ts
import { JobsCtx, JobsHandler } from './index.ts';
import { emailHandlers } from './emails.ts';

function backoffMinutes(n: number): number { return Math.min(60, 2 ** n); }

type BgJob = { id: string; organization_id: string; cycle_id: string | null; job_type: string; payload: Record<string, unknown>; retry_count: number; max_retries: number };

// Insert an email job (queued) + always an in-app notification. Email is toggle-gated by the caller.
async function enqueueEmail(ctx: JobsCtx, orgId: string, cycleId: string | null, templateKey: string, email: string, memberId: string | null, subject: string, payload: Record<string, unknown>) {
  await ctx.admin.from('email_jobs').insert({ organization_id: orgId, cycle_id: cycleId, template_key: templateKey, recipient_email: email, recipient_member_id: memberId, subject, payload, status: 'queued' });
}
async function notify(ctx: JobsCtx, orgId: string, cycleId: string | null, memberId: string, type: string, title: string, body: string) {
  await ctx.admin.from('notifications').insert({ organization_id: orgId, cycle_id: cycleId, recipient_member_id: memberId, type, title, body });
}

// Is the cycle's email mirror toggle on? Snapshot notification block; default OFF unless explicitly enabled.
async function emailMirrorEnabled(ctx: JobsCtx, orgId: string, cycleId: string): Promise<boolean> {
  const { data } = await ctx.admin.from('cycle_config_snapshots').select('snapshot').eq('cycle_id', cycleId).eq('organization_id', orgId).maybeSingle();
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
  const { data } = await ctx.admin.from('org_members').select('id').eq('organization_id', orgId).eq('user_id', userId).maybeSingle();
  return data?.id ?? null;
}

async function runPublishNotification(ctx: JobsCtx, job: BgJob): Promise<{ emails: number; notifications: number }> {
  const cycleId = String(job.payload.cycleId ?? job.cycle_id ?? '');
  if (!cycleId) throw Object.assign(new Error('publish_notification requires cycleId'), { code: 'BAD_REQUEST', status: 400 });
  const emailOn = await emailMirrorEnabled(ctx, job.organization_id, cycleId);
  const parts = await participants(ctx, job.organization_id, cycleId);
  const { data: cyc } = await ctx.admin.from('appraisal_cycles').select('name').eq('id', cycleId).eq('organization_id', job.organization_id).maybeSingle();
  const cycleName = cyc?.name ?? 'your cycle';
  let emails = 0, notifications = 0, done = 0;
  for (const p of parts) {
    const e = p.employees as unknown as { email: string | null; user_id: string | null } | null;
    done += 1;
    await ctx.admin.from('background_jobs').update({ progress: done, total: parts.length }).eq('id', job.id);
    if (!e?.user_id) continue;
    const memberId = await memberIdForUser(ctx, job.organization_id, e.user_id);
    if (memberId) { await notify(ctx, job.organization_id, cycleId, memberId, 'result_published', 'Results published', `Your ${cycleName} results are available.`); notifications += 1; }
    if (emailOn && e.email) { await enqueueEmail(ctx, job.organization_id, cycleId, 'publish', e.email, memberId, 'Your appraisal results are published', { cycleName, orgName: '' }); emails += 1; }
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
  for (const p of parts) {
    const e = p.employees as unknown as { email: string | null; user_id: string | null } | null;
    done += 1;
    await ctx.admin.from('background_jobs').update({ progress: done, total: parts.length }).eq('id', job.id);
    if (!e?.user_id) continue;
    const memberId = await memberIdForUser(ctx, job.organization_id, e.user_id);
    if (memberId) { await notify(ctx, job.organization_id, cycleId, memberId, 'reminder', 'Reminder', `Please complete ${stage}.`); notifications += 1; }
    if (emailOn && e.email) { await enqueueEmail(ctx, job.organization_id, cycleId, 'reminder', e.email, memberId, `Reminder: ${stage}`, { stage, cycleName: '' }); emails += 1; }
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
```

- [ ] **Step 2: Wire the router**

In `supabase/functions/pms-jobs/index.ts`, add `import { backgroundHandlers } from './background.ts';` and change `const handlers = { ...emailHandlers };` to `const handlers = { ...emailHandlers, ...backgroundHandlers };`.

- [ ] **Step 3: Controller deploys**

(Implementer STOPS.) Controller: `supabase functions deploy pms-jobs`. Expected: deployed.

- [ ] **Step 4: Add background + tick assertions to `jobs-check.mjs`**

Before the final `console.log`, append. This builds a small published cycle with one linked participant (reuse the seed's EMP002/Eve who has a `user_id`) and an email-on snapshot, enqueues a `publish_notification`, runs it, and asserts notifications + email_jobs were produced:

```js
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
```

- [ ] **Step 5: Controller runs the check**

Run: `node supabase/verify/seed-foundation.mjs && node supabase/verify/jobs-check.mjs`
Expected: `jobs-check: PASS (14 assertions)` (8 + 6).

- [ ] **Step 6: Commit**

```bash
git add supabase/functions/pms-jobs/background.ts supabase/functions/pms-jobs/index.ts supabase/verify/jobs-check.mjs
git commit -m "feat(jobs): background runner (publish_notification/reminder_batch) + tick"
```

---

### Task 5: Enqueue integration (publish notifications + reminder batches)

**Files:**
- Modify: `supabase/functions/pms-admin/publishing.ts` (publish enqueues a `publish_notification` background job)
- Create: `supabase/functions/pms-admin/jobs.ts` (`jobs.enqueue-reminders` HR action)
- Modify: `supabase/functions/pms-admin/index.ts` (spread `jobsHandlers`)
- Modify: `supabase/verify/admin-check.mjs` (assert publish enqueues a job; enqueue-reminders creates one)

**Interfaces:**
- Consumes: `publish.publish` (Plan 3c), the `background_jobs` table.
- Produces:
  - `publish.publish` now ALSO inserts a `background_jobs` row `{job_type:'publish_notification', payload:{cycleId}, status:'queued'}` after the cycle flips to `published` (best-effort — a failure to enqueue must NOT fail the publish; log + continue).
  - `jobs.enqueue-reminders` `{orgId, cycleId, stage}` → `{jobId}` — HR/super only; inserts a `background_jobs` row `{job_type:'reminder_batch', payload:{cycleId, stage}, created_by, status:'queued'}`.

- [ ] **Step 1: Publish enqueues a publish_notification job**

In `supabase/functions/pms-admin/publishing.ts`, in `publish.publish`, AFTER the successful `versionedUpdate` that flips the cycle to `published` and BEFORE `return`, add a best-effort enqueue (must not throw out of the handler):

```ts
    // Queue the publish-notification fan-out (emails + in-app notifications) for the worker.
    const { error: jobErr } = await ctx.admin.from('background_jobs')
      .insert({ organization_id: orgId, cycle_id: cycleId, job_type: 'publish_notification', payload: { cycleId }, created_by: ctx.userId, status: 'queued' });
    if (jobErr) console.error('enqueue publish_notification', jobErr); // non-fatal: results are published regardless
```

(Place it right before the existing `await ctx.audit(...)` / `return { publication, cycle: freshCycle }`.)

- [ ] **Step 2: `jobs.enqueue-reminders` handler**

`supabase/functions/pms-admin/jobs.ts`:

```ts
import { ApiError, Handler } from '../_shared/kernel.ts';
import { reqString, reqUuid } from '../_shared/validate.ts';

export const jobsHandlers: Record<string, Handler> = {
  'jobs.enqueue-reminders': async (payload, ctx) => {
    const orgId = reqUuid(payload.orgId, 'orgId');
    ctx.requireOrgRole(orgId, ['hr_admin']);
    const cycleId = reqUuid(payload.cycleId, 'cycleId');
    const stage = reqString(payload.stage, 'stage', 100);
    const { data: cycle, error: cErr } = await ctx.admin.from('appraisal_cycles').select('id').eq('id', cycleId).eq('organization_id', orgId).maybeSingle();
    if (cErr) { console.error('enqueue-reminders cycle', cErr); throw new ApiError('DB_ERROR', 'Database error', 500); }
    if (!cycle) throw new ApiError('NOT_FOUND', 'Cycle not found', 404);
    const { data: job, error } = await ctx.admin.from('background_jobs')
      .insert({ organization_id: orgId, cycle_id: cycleId, job_type: 'reminder_batch', payload: { cycleId, stage }, created_by: ctx.userId, status: 'queued' })
      .select('id').single();
    if (error) { console.error('enqueue-reminders insert', error); throw new ApiError('DB_ERROR', 'Database error', 500); }
    await ctx.audit({ organizationId: orgId, cycleId, action: 'jobs.enqueue-reminders', entityType: 'background_job', entityId: job.id, note: `reminder_batch ${stage}` });
    return { jobId: job.id };
  },
};
```

- [ ] **Step 3: Wire the router**

In `supabase/functions/pms-admin/index.ts`, add `import { jobsHandlers } from './jobs.ts';` and `...jobsHandlers,` to the handler map.

- [ ] **Step 4: Controller deploys**

(Implementer STOPS.) Controller: `supabase functions deploy pms-admin`. Expected: deployed.

- [ ] **Step 5: admin-check assertions**

The gamma publish cycle in the existing publishing section flips to `published` via a forced publish — after that, a `publish_notification` job should exist. Append to that block (after `check('publish succeeds with force + reason', ...)`):

```js
  const { data: pubJob } = await admin.from('background_jobs').select('job_type, status').eq('cycle_id', pcycle.id).eq('job_type', 'publish_notification');
  check('publish enqueues a publish_notification background job', (pubJob ?? []).length === 1 && pubJob[0].status === 'queued');
```

And add a small standalone block (near the end, before the final `console.log`) for reminders:

```js
// --- jobs.enqueue-reminders (HR only) ---
{
  const { data: rc } = await admin.from('appraisal_cycles').select('id').eq('organization_id', gamma.id).order('created_at', { ascending: false }).limit(1).single();
  const denied = await callAdmin(empT, 'jobs.enqueue-reminders', { orgId: gamma.id, cycleId: rc.id, stage: 'self evaluation' });
  check('employee cannot enqueue reminders', denied.status === 403);
  const ok = await callAdmin(superT, 'jobs.enqueue-reminders', { orgId: gamma.id, cycleId: rc.id, stage: 'self evaluation' });
  check('HR enqueues a reminder_batch job', ok.status === 200 && ok.body.data.jobId);
  const { data: rj } = await admin.from('background_jobs').select('job_type').eq('id', ok.body.data.jobId).single();
  check('reminder_batch job created', rj.job_type === 'reminder_batch');
}
```

- [ ] **Step 6: Controller runs the check**

Run: `node supabase/verify/seed-foundation.mjs && node supabase/verify/admin-check.mjs`
Expected: `admin-check: PASS (101 assertions)` (97 + 4).

- [ ] **Step 7: Commit**

```bash
git add supabase/functions/pms-admin/publishing.ts supabase/functions/pms-admin/jobs.ts supabase/functions/pms-admin/index.ts supabase/verify/admin-check.mjs
git commit -m "feat(admin-backend): publish enqueues publish_notification; HR enqueue-reminders"
```

---

### Task 6: Wire the gate

**Files:**
- Modify: `supabase/verify/run-all.mjs` (add `jobs-check` to the suite list)

**Interfaces:**
- Consumes: everything above. Confirms the full gate green with `jobs-check` included.

> **Scheduling is an ops step, not code here.** Wiring the every-minute tick needs the service-role key held in Supabase Vault (pg_cron + pg_net → `net.http_post` to `pms-jobs` `jobs.tick`) or a Supabase dashboard Edge Function schedule — a secret that must NOT be committed to git. The worker is fully functional and drainable without it; the gate drives it directly via `jobs-check.mjs`. Scheduling is captured in the carried-forward notes for deploy/cutover.

- [ ] **Step 1: Wire `jobs-check` into `run-all.mjs`**

In `supabase/verify/run-all.mjs`, the ordered `scripts` array lists the `supabase/verify/*-check.mjs` suites. Append `'supabase/verify/jobs-check.mjs'` after `'supabase/verify/workflow-check.mjs'`, matching the existing string entries exactly (each entry is a full path string in the array).

- [ ] **Step 2: Controller runs the full gate**

Run: `node supabase/verify/run-all.mjs` (background if it exceeds 2 min).
Expected: all suites pass — `rls-check: PASS (58)`, `admin-check: PASS (101)`, `workflow-check: PASS (70)`, `jobs-check: PASS (14)` — final `FOUNDATION SMOKE: ALL PASS`, exit 0. (Trust the printed counts; recount if any differ.)

- [ ] **Step 3: Lint**

Run: `npm run lint`
Expected: no NEW problems under `supabase/**` (eslint does not scan `supabase/`; pre-existing `src/` findings out of scope — note, don't fix).

- [ ] **Step 4: Commit**

```bash
git add supabase/verify/run-all.mjs
git commit -m "chore(jobs): wire jobs-check into the smoke gate"
```

---

## Out of Scope (later plans)

- **Exports** (deferred by product decision): server-side generation of downloadable files (results CSV/PDF), Supabase Storage, HR download links — a later `export_batch` job type + its own plan.
- **Plan 5 (screens):** rewire the wizard/dashboards/portal to `callPms`/`callWorkflow` + RLS reads; the live job-status UI reads `email_jobs`/`background_jobs`/`notifications` (already `hr_read`-scoped); first-login set-password. The real `send-email` live-delivery smoke belongs here (this plan's gate uses the simulated transport only).
- **Plan 6 (cutover):** delete the `app_state` blob + old edge functions (including possibly folding `send-email` into `pms-jobs`); the dashboard "disable signups" toggle.
- **New-cycle carry-over** and **roster-import-commit** background job types (named in spec §8) — enqueue paths exist in Plans 2b; wiring them as `background_jobs` is a follow-up.

## Carried-forward notes

- **Go-live:** Supabase Auth signups must be disabled manually in the dashboard before production.
- **Scheduling (deploy/ops step):** wire the every-minute `jobs.tick` via pg_cron + pg_net (`net.http_post` to `pms-jobs` with the service-role bearer read from Supabase Vault) OR a Supabase dashboard Edge Function schedule. The key must live in Vault/secrets, never in a committed migration. Until scheduled, the worker only runs when invoked directly.
- **Live email smoke:** the `send-email` live path is implemented but only the simulated transport is gate-verified; do a single real-send smoke (to a controlled inbox) during Plan 5/cutover before relying on production delivery.

Nothing in this plan modifies old-world files (`send-email`, `app-auth`, `src/**`) or the 7 untracked old migrations.
