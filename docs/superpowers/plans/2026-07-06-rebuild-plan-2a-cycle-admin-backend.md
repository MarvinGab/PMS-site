# Rebuild Plan 2a: Cycle & Org Admin Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Server-side org creation and full cycle configuration authoring — every wizard config section written to real `pms` tables through validated, audited, conflict-safe `pms-admin` actions — plus the RLS refinements deferred from Plan 1 (draft-evaluation privacy, disabled-member gating, HR-only admin config).

**Architecture:** Extends the Plan-1 foundation: new handlers live as domain modules inside the deployed `pms-admin` edge function (kernel from `_shared/kernel.ts` does auth → membership → routing → audit → versioned writes). Config authoring uses the cycle row's `version` as a concurrency token (claim token → rewrite section rows → audit); multi-table atomic transactions (activation, import) are Plan 2b via Postgres RPC. HR-only config blocks go in a new `pms.cycle_admin_config` table, never into the member-readable snapshot.

**Tech Stack:** Supabase edge functions (Deno, `npm:@supabase/supabase-js@2`), Postgres RLS, Node verify scripts with `node:assert` (repo convention), Supabase CLI (linked project `mkjtdwrzmobahwkpumxx`).

**Spec:** `docs/superpowers/specs/2026-07-03-server-first-rebuild-design.md` §4.3 (wizard mapping), §6 (backend org), §7 (lifecycle). Deferred-decisions source: `.superpowers/sdd/progress.md`.

## Global Constraints

- **Write rule:** browser reads via RLS only; ALL business writes go through backend functions. No new grants to `anon`; new tables need explicit RLS enable + policy (the Plan-1 DO loop ran once).
- **Kernel contract (from Plan 1, binding):** response `{ ok: true, data } | { ok: false, error: { code, message } }`; stale version → `CONFLICT` 409 "someone else changed this — reload"; `versionedUpdate(table, orgId, id, expectedVersion, patch)` is org-scoped; auth precedes routing; raw DB errors never reach clients (log + generic `DB_ERROR`).
- **Config lock stages (spec §4.3.15):** sections editable only in `draft`/`setup` → after activation locked (amendments are Plan 2b). Locked → error code `CYCLE_LOCKED` 409.
- **Phase windows are the exception:** editable in ANY non-archived status (the calendar governs live cycles; super-admin/HR edits, last-write-wins with version token, audited). Archived → `CYCLE_LOCKED`.
- **One working cycle per org** — DB-enforced; map the unique violation to `WORKING_CYCLE_EXISTS` 409.
- **Draft privacy decision (locked in this plan):** unsubmitted (`status <> 'submitted'`) evaluations are visible only to their author (owner for `self`, the manager for `manager`, the HOD for `hod`) and HR/super. Enforced in RLS.
- **HR-only config decision:** bell-curve header (and future HR-only blocks) live in `pms.cycle_admin_config` (HR-read policy), NOT in `cycle_config_snapshots`.
- **New pms functions referenced by RLS policies need explicit `grant execute ... to authenticated`** (Plan-1 default privileges revoke PUBLIC). SQL RPCs for backend use get NO authenticated grant (service_role only, via default privileges).
- **Target level ≠ rating level** — separate per-group fields, never collapsed.
- Never label roster-only rows "Outside PMS" in any copy; `group_name = 'NONE'` is the marker.
- Every handler: validate input → permission check → write → audit row → typed response. Audit uses `ctx.audit`.
- The repo has unrelated dirty files: stage ONLY each task's files. `.env` is gitignored, never printed/committed. Old-world files (old edge functions, `public` schema, `src/`) untouched.
- All commands run from `/Users/marvin/Desktop/PMS site`. Work on branch `rebuild-2a-admin-backend` (create from `main` at start: `git checkout -b rebuild-2a-admin-backend`).
- Commit trailer on every commit: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`

---

### Task 1: Migration — cycle_admin_config + deferred RLS refinements

**Files:**
- Create: `supabase/migrations/2026070610_pms_admin_config_and_policy_refinements.sql`
- Modify: `supabase/verify/check-tables.mjs` (append 1 table name)

**Interfaces:**
- Consumes: Plan-1 schema (`pms.*`), helpers (`pms.is_org_member`, `pms.is_org_reader`, `pms.manages`, `pms.is_hod_of`, `pms.stage_visible`, `pms.touch_row`).
- Produces: table `pms.cycle_admin_config(id, organization_id, cycle_id unique, payload jsonb, created_at, updated_at, version)` (HR-read); `pms.self_employee_id(p_org)` now requires ACTIVE membership; `pms.can_read_evaluation(p_org, p_cycle, p_emp, p_stage, p_status)` (5-arg, draft-private) replacing the 4-arg version; policy `employees_scoped_read` pivots on `self_employee_id`; check constraint `auto_band_range` on `cycle_auto_rating_bands`.

- [ ] **Step 1: Extend the table check (failing first)**

In `supabase/verify/check-tables.mjs`, append to `EXPECTED_TABLES`:

```js
  // Plan 2a: HR-only cycle admin config
  'cycle_admin_config',
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node supabase/verify/check-tables.mjs`
Expected: FAIL — `MISSING pms.cycle_admin_config`, 45 others `ok`, exit non-zero.

- [ ] **Step 3: Write the migration**

`supabase/migrations/2026070610_pms_admin_config_and_policy_refinements.sql`:

```sql
-- HR-only per-cycle admin config (bell-curve header etc.) — deliberately NOT in
-- member-readable cycle_config_snapshots (Plan-1 final-review decision).
create table pms.cycle_admin_config (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references pms.organizations(id) on delete cascade,
  cycle_id uuid not null unique references pms.appraisal_cycles(id) on delete cascade,
  payload jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version int not null default 1
);
alter table pms.cycle_admin_config enable row level security;
create policy hr_read on pms.cycle_admin_config for select
  using (pms.is_org_reader(organization_id));
drop trigger if exists touch on pms.cycle_admin_config;
create trigger touch before update on pms.cycle_admin_config
  for each row execute function pms.touch_row();

-- Band sanity (deferred from Plan-1 review).
alter table pms.cycle_auto_rating_bands
  add constraint auto_band_range check (to_percent >= from_percent);

-- self_employee_id now requires an ACTIVE membership, so disabled/invited members
-- lose every self-pivot read (plans, items, participants, acks, reporting rows).
create or replace function pms.self_employee_id(p_org uuid) returns uuid
language sql stable security definer set search_path = pms, public as $$
  select e.id from pms.employees e
  where e.organization_id = p_org and e.user_id = auth.uid()
    and pms.is_org_member(p_org)
  limit 1;
$$;

-- employees: replace the raw user_id pivot with the membership-gated helper.
drop policy employees_scoped_read on pms.employees;
create policy employees_scoped_read on pms.employees for select
  using (pms.is_org_reader(organization_id)
         or id = pms.self_employee_id(organization_id)
         or pms.manages(organization_id, id)
         or pms.is_hod_of(organization_id, id)
         or pms.is_my_related(organization_id, id));

-- Draft privacy: unsubmitted evaluations are visible only to their author + HR.
drop policy eval_visibility_read on pms.evaluations;
drop policy eval_scores_visibility_read on pms.evaluation_goal_scores;
drop policy eval_comp_scores_visibility_read on pms.evaluation_competency_scores;
drop function pms.can_read_evaluation(uuid, uuid, uuid, text);

create function pms.can_read_evaluation(
  p_org uuid, p_cycle uuid, p_emp uuid, p_stage text, p_status text
) returns boolean
language plpgsql stable security definer set search_path = pms, public as $$
declare me uuid;
begin
  if pms.is_org_reader(p_org) then return true; end if;
  if not pms.is_org_member(p_org) then return false; end if; -- cross-org oracle guard
  me := pms.self_employee_id(p_org);
  if me is null then return false; end if;
  if p_status is distinct from 'submitted' then
    -- Drafts: only the author. self → the employee; manager/hod → the evaluator.
    if p_stage = 'self' then return p_emp = me; end if;
    if p_stage = 'manager' then return pms.manages(p_org, p_emp); end if;
    if p_stage = 'hod' then return pms.is_hod_of(p_org, p_emp); end if;
    return false; -- hr_final drafts: HR only (handled by is_org_reader above)
  end if;
  -- Submitted rows: Plan-1 stage-visibility rules.
  if p_stage = 'self' then
    return p_emp = me or pms.manages(p_org, p_emp) or pms.is_hod_of(p_org, p_emp);
  elsif p_stage = 'manager' then
    if pms.manages(p_org, p_emp) or pms.is_hod_of(p_org, p_emp) then return true; end if;
    return p_emp = me and pms.stage_visible(p_cycle, 'manager_rating_visible');
  elsif p_stage = 'hod' then
    return pms.is_hod_of(p_org, p_emp);
  elsif p_stage = 'hr_final' then
    if pms.is_hod_of(p_org, p_emp) then return true; end if;
    if p_emp = me or pms.manages(p_org, p_emp) then
      return pms.stage_visible(p_cycle, 'final_rating_visible');
    end if;
  end if;
  return false;
end $$;

-- Plan-1 default privileges revoked PUBLIC execute; policies evaluate with the
-- querying role's privileges, so authenticated needs execute explicitly.
grant execute on function pms.can_read_evaluation(uuid, uuid, uuid, text, text) to authenticated;

create policy eval_visibility_read on pms.evaluations for select
  using (pms.can_read_evaluation(organization_id, cycle_id, employee_id, stage, status));
create policy eval_scores_visibility_read on pms.evaluation_goal_scores for select
  using (exists (select 1 from pms.evaluations e where e.id = evaluation_id
                 and pms.can_read_evaluation(e.organization_id, e.cycle_id, e.employee_id, e.stage, e.status)));
create policy eval_comp_scores_visibility_read on pms.evaluation_competency_scores for select
  using (exists (select 1 from pms.evaluations e where e.id = evaluation_id
                 and pms.can_read_evaluation(e.organization_id, e.cycle_id, e.employee_id, e.stage, e.status)));
```

- [ ] **Step 4: Apply and verify**

Run: `supabase db push`
Expected: `Applying migration 2026070610_pms_admin_config_and_policy_refinements.sql... Finished supabase db push.`

Run: `node supabase/verify/check-tables.mjs`
Expected: 46 `ok`, `check-tables: PASS`.

Run: `node supabase/verify/seed-foundation.mjs && node supabase/verify/rls-check.mjs`
Expected: `rls-check: PASS (33 assertions)` — the Plan-1 suite must still pass unchanged (proves no regression; new behaviors get their own assertions in Task 2).

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/2026070610_pms_admin_config_and_policy_refinements.sql supabase/verify/check-tables.mjs
git commit -m "feat(admin-backend): cycle_admin_config + draft-privacy and membership-gated RLS refinements"
```

---

### Task 2: RLS suite — assertions for the three new behaviors

**Files:**
- Modify: `supabase/verify/rls-check.mjs` (insert three sections immediately BEFORE the `// --- RPC hardening ...` section)

**Interfaces:**
- Consumes: seed identities (`USERS`, `PASSWORD`, `ORG_KEY`), `admin`/`signIn` clients, the `check(desc, cond)` helper, `org` row already loaded at top of script.
- Produces: `rls-check: PASS (41 assertions)` — new count consumed by Task 6's gate expectations.

- [ ] **Step 1: Add the draft-privacy section**

Insert into `supabase/verify/rls-check.mjs` (before the RPC-hardening block):

```js
// --- draft evaluations are private to their author (+ HR) ---
{
  const { data: eve } = await admin.from('employees')
    .select('id').eq('organization_id', org.id).eq('employee_code', 'EMP002').single();
  const { data: cyc } = await admin.from('appraisal_cycles')
    .select('id').eq('organization_id', org.id).eq('status', 'draft').single();
  await admin.from('evaluations').delete().eq('cycle_id', cyc.id).eq('employee_id', eve.id);
  const { data: draftEval, error: draftErr } = await admin.from('evaluations').insert({
    organization_id: org.id, cycle_id: cyc.id, employee_id: eve.id, stage: 'self', status: 'draft',
  }).select().single();
  assert.equal(draftErr, null, draftErr?.message);
  const { client: eveC } = await signIn(USERS.employee, PASSWORD);
  const { data: eveSees } = await eveC.from('evaluations').select('id');
  check('employee sees own draft self-evaluation', (eveSees ?? []).length === 1);
  const { client: maryC } = await signIn(USERS.manager, PASSWORD);
  const { data: maryDraft } = await maryC.from('evaluations').select('id');
  check('manager cannot see report draft self-evaluation', (maryDraft ?? []).length === 0);
  await admin.from('evaluations')
    .update({ status: 'submitted', submitted_at: new Date().toISOString() }).eq('id', draftEval.id);
  const { data: marySubmitted } = await maryC.from('evaluations').select('id');
  check('manager sees report submitted self-evaluation', (marySubmitted ?? []).length === 1);
  await admin.from('evaluations').update({ status: 'draft' }).eq('id', draftEval.id);
  const { client: hrC } = await signIn(USERS.hr, PASSWORD);
  const { data: hrSees } = await hrC.from('evaluations').select('id');
  check('HR sees draft evaluations', (hrSees ?? []).length === 1);
  await admin.from('evaluations').delete().eq('id', draftEval.id);
}
```

- [ ] **Step 2: Add the disabled-membership section**

```js
// --- disabled membership suspends scoped reads ---
{
  const { data: eveEmp } = await admin.from('employees')
    .select('user_id').eq('organization_id', org.id).eq('employee_code', 'EMP002').single();
  await admin.from('org_members').update({ status: 'disabled' })
    .eq('organization_id', org.id).eq('user_id', eveEmp.user_id);
  const { client: eveC } = await signIn(USERS.employee, PASSWORD);
  const { data: whileDisabled } = await eveC.from('employees').select('id');
  check('disabled member reads no roster rows', (whileDisabled ?? []).length === 0);
  await admin.from('org_members').update({ status: 'active' })
    .eq('organization_id', org.id).eq('user_id', eveEmp.user_id);
  const { client: eveC2 } = await signIn(USERS.employee, PASSWORD);
  const { data: reEnabled } = await eveC2.from('employees').select('id');
  check('re-activated member reads roster rows again', (reEnabled ?? []).length === 3);
}
```

- [ ] **Step 3: Add the admin-config section**

```js
// --- cycle_admin_config is HR-only ---
{
  const { data: cyc } = await admin.from('appraisal_cycles')
    .select('id').eq('organization_id', org.id).eq('status', 'draft').single();
  await admin.from('cycle_admin_config').delete().eq('cycle_id', cyc.id);
  const { error: cfgErr } = await admin.from('cycle_admin_config').insert({
    organization_id: org.id, cycle_id: cyc.id,
    payload: { bell: { enabled: true, mode: 'org', preset: 'standard' } },
  });
  assert.equal(cfgErr, null, cfgErr?.message);
  const { client: eveC } = await signIn(USERS.employee, PASSWORD);
  const { data: eveCfg, error: eveCfgErr } = await eveC.from('cycle_admin_config').select('id');
  check('employee cannot read cycle_admin_config', eveCfgErr !== null || (eveCfg ?? []).length === 0);
  const { client: hrC } = await signIn(USERS.hr, PASSWORD);
  const { data: hrCfg } = await hrC.from('cycle_admin_config').select('id');
  check('HR reads cycle_admin_config', (hrCfg ?? []).length === 1);
}
```

- [ ] **Step 4: Run the suite**

Run: `node supabase/verify/seed-foundation.mjs && node supabase/verify/rls-check.mjs`
Expected: every line `ok ...`, final `rls-check: PASS (41 assertions)`, exit 0. If a NEW assertion fails, diagnose: policy bug in Task 1's migration (fix via an additional migration — applied files are immutable) vs wrong expectation (fix the script, justify in report).

- [ ] **Step 5: Commit**

```bash
git add supabase/verify/rls-check.mjs
git commit -m "test(admin-backend): RLS assertions for draft privacy, disabled members, admin config"
```

---

### Task 3: Validation helpers (`_shared/validate.ts`)

**Files:**
- Create: `supabase/functions/_shared/validate.ts`
- Test: `supabase/functions/_shared/validate.test.ts`

**Interfaces:**
- Consumes: `ApiError` from `./kernel.ts`.
- Produces (every later handler task imports these): `reqString(v, name, maxLen?)`, `optString(v, name, maxLen?)`, `reqUuid(v, name)`, `optUuid(v, name)`, `reqInt(v, name)`, `optInt(v, name)`, `reqNumber(v, name)`, `optNumber(v, name)`, `optBool(v, name, dflt?)`, `reqEnum(v, name, allowed)`, `optEnum(v, name, allowed)`, `reqArray(v, name, maxItems?)`, `reqObject(v, name)`, `reqIsoDate(v, name)`. All throw `ApiError('BAD_REQUEST', <message naming the field>, 400)` on invalid input.

- [ ] **Step 1: Write failing tests**

`supabase/functions/_shared/validate.test.ts`:

```ts
import { assertEquals, assertThrows } from 'jsr:@std/assert@1';
import { ApiError } from './kernel.ts';
import {
  optBool, optString, reqArray, reqEnum, reqInt, reqIsoDate, reqNumber,
  reqObject, reqString, reqUuid,
} from './validate.ts';

Deno.test('reqString trims and enforces max length', () => {
  assertEquals(reqString('  hi  ', 'f'), 'hi');
  assertThrows(() => reqString('', 'f'), ApiError);
  assertThrows(() => reqString('abc', 'f', 2), ApiError);
  assertThrows(() => reqString(42, 'f'), ApiError);
});

Deno.test('optString returns null for empty-ish values', () => {
  assertEquals(optString(undefined, 'f'), null);
  assertEquals(optString(null, 'f'), null);
  assertEquals(optString('', 'f'), null);
  assertEquals(optString('x', 'f'), 'x');
});

Deno.test('reqUuid validates and lowercases', () => {
  assertEquals(reqUuid('00000000-0000-0000-0000-0000000000AB', 'f'),
    '00000000-0000-0000-0000-0000000000ab');
  assertThrows(() => reqUuid('not-a-uuid', 'f'), ApiError);
});

Deno.test('reqInt rejects floats and strings', () => {
  assertEquals(reqInt(3, 'f'), 3);
  assertThrows(() => reqInt(3.5, 'f'), ApiError);
  assertThrows(() => reqInt('3', 'f'), ApiError);
});

Deno.test('reqNumber rejects NaN and Infinity', () => {
  assertEquals(reqNumber(2.5, 'f'), 2.5);
  assertThrows(() => reqNumber(Number.NaN, 'f'), ApiError);
  assertThrows(() => reqNumber(Infinity, 'f'), ApiError);
});

Deno.test('optBool defaults and rejects non-booleans', () => {
  assertEquals(optBool(undefined, 'f'), false);
  assertEquals(optBool(undefined, 'f', true), true);
  assertEquals(optBool(true, 'f'), true);
  assertThrows(() => optBool('yes', 'f'), ApiError);
});

Deno.test('reqEnum names the allowed values in its error', () => {
  assertEquals(reqEnum('a', 'f', ['a', 'b']), 'a');
  try { reqEnum('c', 'f', ['a', 'b']); throw new Error('should throw'); }
  catch (e) { assertEquals((e as ApiError).message.includes('a, b'), true); }
});

Deno.test('reqArray enforces max items', () => {
  assertEquals(reqArray([1, 2], 'f').length, 2);
  assertThrows(() => reqArray('x', 'f'), ApiError);
  assertThrows(() => reqArray([1, 2, 3], 'f', 2), ApiError);
});

Deno.test('reqObject rejects arrays and null', () => {
  assertEquals(reqObject({ a: 1 }, 'f').a, 1);
  assertThrows(() => reqObject([], 'f'), ApiError);
  assertThrows(() => reqObject(null, 'f'), ApiError);
});

Deno.test('reqIsoDate wants YYYY-MM-DD', () => {
  assertEquals(reqIsoDate('2026-04-01', 'f'), '2026-04-01');
  assertThrows(() => reqIsoDate('01/04/2026', 'f'), ApiError);
  assertThrows(() => reqIsoDate('2026-13-99', 'f'), ApiError);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `deno test supabase/functions/_shared/validate.test.ts`
Expected: FAIL — `Module not found ... validate.ts`.

- [ ] **Step 3: Implement**

`supabase/functions/_shared/validate.ts`:

```ts
// Input validators for edge handlers. Every failure is a client-facing
// ApiError('BAD_REQUEST', ...) that names the offending field.
import { ApiError } from './kernel.ts';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function bad(name: string, want: string): never {
  throw new ApiError('BAD_REQUEST', `${name} must be ${want}`, 400);
}

export function reqString(v: unknown, name: string, maxLen = 500): string {
  if (typeof v !== 'string' || v.trim() === '' || v.length > maxLen) {
    bad(name, `a non-empty string (max ${maxLen} chars)`);
  }
  return (v as string).trim();
}

export function optString(v: unknown, name: string, maxLen = 2000): string | null {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v !== 'string' || v.length > maxLen) bad(name, `a string (max ${maxLen} chars)`);
  return v as string;
}

export function reqUuid(v: unknown, name: string): string {
  if (typeof v !== 'string' || !UUID_RE.test(v)) bad(name, 'a UUID');
  return (v as string).toLowerCase();
}

export function optUuid(v: unknown, name: string): string | null {
  if (v === undefined || v === null || v === '') return null;
  return reqUuid(v, name);
}

export function reqInt(v: unknown, name: string): number {
  if (typeof v !== 'number' || !Number.isInteger(v)) bad(name, 'an integer');
  return v as number;
}

export function optInt(v: unknown, name: string): number | null {
  if (v === undefined || v === null || v === '') return null;
  return reqInt(v, name);
}

export function reqNumber(v: unknown, name: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) bad(name, 'a number');
  return v as number;
}

export function optNumber(v: unknown, name: string): number | null {
  if (v === undefined || v === null || v === '') return null;
  return reqNumber(v, name);
}

export function optBool(v: unknown, name: string, dflt = false): boolean {
  if (v === undefined || v === null) return dflt;
  if (typeof v !== 'boolean') bad(name, 'true or false');
  return v as boolean;
}

export function reqEnum(v: unknown, name: string, allowed: string[]): string {
  if (typeof v !== 'string' || !allowed.includes(v)) bad(name, `one of: ${allowed.join(', ')}`);
  return v as string;
}

export function optEnum(v: unknown, name: string, allowed: string[]): string | null {
  if (v === undefined || v === null || v === '') return null;
  return reqEnum(v, name, allowed);
}

export function reqArray(v: unknown, name: string, maxItems = 500): unknown[] {
  if (!Array.isArray(v) || v.length > maxItems) bad(name, `an array (max ${maxItems} items)`);
  return v as unknown[];
}

export function reqObject(v: unknown, name: string): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) bad(name, 'an object');
  return v as Record<string, unknown>;
}

export function reqIsoDate(v: unknown, name: string): string {
  if (typeof v !== 'string' || !ISO_DATE_RE.test(v) || Number.isNaN(Date.parse(v))) {
    bad(name, 'a date like 2026-04-01');
  }
  return v as string;
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `deno test supabase/functions/_shared/validate.test.ts`
Expected: `ok | 10 passed | 0 failed`.

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/_shared/validate.ts supabase/functions/_shared/validate.test.ts
git commit -m "feat(admin-backend): input validation helpers for edge handlers"
```

---

### Task 4: Organization admin actions

**Files:**
- Create: `supabase/functions/pms-admin/organizations.ts`
- Modify: `supabase/functions/pms-admin/index.ts`
- Create: `supabase/verify/admin-check.mjs` (org sections; grows in Tasks 5–6)

**Interfaces:**
- Consumes: kernel (`serveActions`, `ApiError`, `Handler`, `HandlerCtx`), validators (Task 3), seed identities.
- Produces: actions `org.create` (super admin only; payload `{key, name}` → `{organization}`; duplicate key → `ORG_KEY_TAKEN` 409), `org.update` (`{orgId, expectedVersion, name}` → `{organization}`), `org.set-branding` (`{orgId, expectedVersion, payload}` → `{branding}`); exported helper `requireSuperAdmin(ctx)`; verify helper `callAdmin(token, action, payload)` in `admin-check.mjs` reused by Tasks 5–6.

- [ ] **Step 1: Write the organizations module**

`supabase/functions/pms-admin/organizations.ts`:

```ts
import { ApiError, Handler, HandlerCtx } from '../_shared/kernel.ts';
import { reqInt, reqObject, reqString, reqUuid } from '../_shared/validate.ts';

export function requireSuperAdmin(ctx: HandlerCtx): void {
  const ok = ctx.memberships.some((m) => m.organizationId === null && m.roles.includes('super_admin'));
  if (!ok) throw new ApiError('FORBIDDEN', 'Super admin only', 403);
}

export const organizationHandlers: Record<string, Handler> = {
  'org.create': async (payload, ctx) => {
    requireSuperAdmin(ctx);
    const key = reqString(payload.key, 'key', 60).toLowerCase();
    const name = reqString(payload.name, 'name', 200);
    const { data: org, error } = await ctx.admin.from('organizations')
      .insert({ key, name }).select().single();
    if (error) {
      if (error.code === '23505') {
        throw new ApiError('ORG_KEY_TAKEN', 'An organization with this key already exists', 409);
      }
      console.error('org.create', error);
      throw new ApiError('DB_ERROR', 'Database error', 500);
    }
    const { error: brandErr } = await ctx.admin.from('organization_branding')
      .insert({ organization_id: org.id });
    if (brandErr) {
      console.error('org.create branding', brandErr);
      throw new ApiError('DB_ERROR', 'Database error', 500);
    }
    await ctx.audit({
      organizationId: org.id, action: 'org.create',
      entityType: 'organization', entityId: org.id, after: org,
    });
    return { organization: org };
  },

  'org.update': async (payload, ctx) => {
    const orgId = reqUuid(payload.orgId, 'orgId');
    ctx.requireOrgRole(orgId, ['hr_admin']);
    const expectedVersion = reqInt(payload.expectedVersion, 'expectedVersion');
    const name = reqString(payload.name, 'name', 200);
    const { data: before, error: readErr } = await ctx.admin.from('organizations')
      .select().eq('id', orgId).maybeSingle();
    if (readErr) { console.error('org.update read', readErr); throw new ApiError('DB_ERROR', 'Database error', 500); }
    if (!before) throw new ApiError('NOT_FOUND', 'Organization not found', 404);
    // organizations has no organization_id column, so versionedUpdate (org-scoped)
    // doesn't apply; same contract implemented directly.
    const { data: updated, error } = await ctx.admin.from('organizations')
      .update({ name }).eq('id', orgId).eq('version', expectedVersion).select().maybeSingle();
    if (error) { console.error('org.update', error); throw new ApiError('DB_ERROR', 'Database error', 500); }
    if (!updated) throw new ApiError('CONFLICT', 'someone else changed this — reload', 409);
    await ctx.audit({
      organizationId: orgId, action: 'org.update',
      entityType: 'organization', entityId: orgId, before, after: updated,
    });
    return { organization: updated };
  },

  'org.set-branding': async (payload, ctx) => {
    const orgId = reqUuid(payload.orgId, 'orgId');
    ctx.requireOrgRole(orgId, ['hr_admin']);
    const expectedVersion = reqInt(payload.expectedVersion, 'expectedVersion');
    const brandingPayload = reqObject(payload.payload, 'payload');
    // organization_branding's PK is organization_id (no id column) — direct
    // version-checked update, same conflict contract as versionedUpdate.
    const { data: updated, error } = await ctx.admin.from('organization_branding')
      .update({ payload: brandingPayload })
      .eq('organization_id', orgId).eq('version', expectedVersion)
      .select().maybeSingle();
    if (error) { console.error('org.set-branding', error); throw new ApiError('DB_ERROR', 'Database error', 500); }
    if (!updated) {
      const { data: row } = await ctx.admin.from('organization_branding')
        .select('organization_id').eq('organization_id', orgId).maybeSingle();
      if (!row) throw new ApiError('NOT_FOUND', 'Branding row not found', 404);
      throw new ApiError('CONFLICT', 'someone else changed this — reload', 409);
    }
    await ctx.audit({
      organizationId: orgId, action: 'org.set-branding',
      entityType: 'organization_branding', entityId: orgId, after: updated,
    });
    return { branding: updated };
  },
};
```

- [ ] **Step 2: Wire the router**

Replace `supabase/functions/pms-admin/index.ts` with:

```ts
import { serveActions } from '../_shared/kernel.ts';
import { organizationHandlers } from './organizations.ts';

serveActions({
  'admin.whoami': (_payload, ctx) =>
    Promise.resolve({ userId: ctx.userId, memberships: ctx.memberships }),
  ...organizationHandlers,
});
```

- [ ] **Step 3: Deploy**

Run: `supabase functions deploy pms-admin`
Expected: `Deployed Functions on project mkjtdwrzmobahwkpumxx: pms-admin`.

- [ ] **Step 4: Write the failing org checks**

Create `supabase/verify/admin-check.mjs`:

```js
// Run: node supabase/verify/seed-foundation.mjs && node supabase/verify/admin-check.mjs
// End-to-end checks for pms-admin org/cycle admin actions against the live TEST project.
import assert from 'node:assert/strict';
import { adminClient, anonClient, signIn, SUPABASE_URL, ANON_KEY } from './_clients.mjs';
import { USERS, PASSWORD } from './seed-foundation.mjs';

const FN_URL = `${SUPABASE_URL}/functions/v1/pms-admin`;
const GAMMA_KEY = 'gamma-test';

let n = 0;
const check = (desc, cond) => { n += 1; assert.ok(cond, `FAIL: ${desc}`); console.log(`ok ${desc}`); };

export async function callAdmin(token, action, payload) {
  const res = await fetch(FN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: ANON_KEY,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ action, payload }),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

const admin = adminClient();
await admin.from('organizations').delete().eq('key', GAMMA_KEY); // idempotent fixture reset

const superT = (await signIn(USERS.superadmin, PASSWORD)).session.access_token;
const hrT = (await signIn(USERS.hr, PASSWORD)).session.access_token;
const empT = (await signIn(USERS.employee, PASSWORD)).session.access_token;
const betaT = (await signIn(USERS.beta, PASSWORD)).session.access_token;

// --- org.create ---
{
  const denied = await callAdmin(hrT, 'org.create', { key: GAMMA_KEY, name: 'Gamma Test Org' });
  check('org.create denied for HR (super admin only)', denied.status === 403 && denied.body.error.code === 'FORBIDDEN');
  const created = await callAdmin(superT, 'org.create', { key: GAMMA_KEY, name: 'Gamma Test Org' });
  check('org.create succeeds for super admin', created.status === 200 && created.body.data.organization.key === GAMMA_KEY);
  const dup = await callAdmin(superT, 'org.create', { key: GAMMA_KEY, name: 'Dup' });
  check('duplicate org key rejected', dup.status === 409 && dup.body.error.code === 'ORG_KEY_TAKEN');
  const { data: branding } = await admin.from('organization_branding')
    .select('organization_id').eq('organization_id', created.body.data.organization.id);
  check('branding row created with org', (branding ?? []).length === 1);
}

const { data: gamma } = await admin.from('organizations').select().eq('key', GAMMA_KEY).single();

// --- org.update / org.set-branding ---
{
  const stale = await callAdmin(superT, 'org.update', { orgId: gamma.id, expectedVersion: 999, name: 'Nope' });
  check('org.update with stale version conflicts', stale.status === 409 && stale.body.error.code === 'CONFLICT');
  const ok = await callAdmin(superT, 'org.update', { orgId: gamma.id, expectedVersion: gamma.version, name: 'Gamma Renamed' });
  check('org.update succeeds with fresh version', ok.status === 200 && ok.body.data.organization.name === 'Gamma Renamed');
  const crossOrg = await callAdmin(betaT, 'org.update', {
    orgId: gamma.id, expectedVersion: ok.body.data.organization.version, name: 'Hijack',
  });
  check('other-org HR cannot update gamma', crossOrg.status === 403 && crossOrg.body.error.code === 'FORBIDDEN');
  const brand = await callAdmin(superT, 'org.set-branding', {
    orgId: gamma.id, expectedVersion: 1, payload: { logoUrl: null, primaryColor: '#334155' },
  });
  check('org.set-branding succeeds', brand.status === 200 && brand.body.data.branding.payload.primaryColor === '#334155');
  const empTry = await callAdmin(empT, 'org.update', { orgId: gamma.id, expectedVersion: 2, name: 'Emp' });
  check('employee cannot call org actions', empTry.status === 403);
}

console.log(`admin-check: PASS (${n} assertions)`);
```

- [ ] **Step 5: Run it**

Run: `node supabase/verify/seed-foundation.mjs && node supabase/verify/admin-check.mjs`
Expected: 9 `ok` lines, `admin-check: PASS (9 assertions)`, exit 0.

- [ ] **Step 6: Commit**

```bash
git add supabase/functions/pms-admin/organizations.ts supabase/functions/pms-admin/index.ts supabase/verify/admin-check.mjs
git commit -m "feat(admin-backend): organization admin actions (create/update/branding)"
```

---

### Task 5: Cycle draft-config authoring actions

**Files:**
- Create: `supabase/functions/pms-admin/cycles.ts`
- Modify: `supabase/functions/pms-admin/index.ts`

**Interfaces:**
- Consumes: kernel + validators; tables from Plans 1/2a Task 1.
- Produces actions (all `hr_admin`-or-super, org-scoped):
  - `cycle.create-draft` `{orgId, name, periodLabel?, frameworkId}` → `{cycle}`; second working cycle → `WORKING_CYCLE_EXISTS` 409. Also creates the cycle's `cycle_config_snapshots` and `cycle_admin_config` rows.
  - `cycle.save-section` `{orgId, cycleId, cycleVersion, section, rows|config}` → `{cycle, rows}`; sections: `perspectives | groups | target_types | rating_scale_levels | auto_rating_bands | goal_rules | competency_config | competency_assignments | bell_curve_bands`; only in `draft`/`setup` (else `CYCLE_LOCKED` 409); cycle row version is the concurrency token (stale → `CONFLICT`).
  - `cycle.set-windows` `{orgId, cycleId, cycleVersion, windows: [{key, startsOn, endsOn}]}` → `{cycle, rows}`; allowed in ANY status except `archived`. FULL REPLACE semantics — callers always send the complete calendar, not a delta.
  - `cycle.set-snapshot-block` `{orgId, cycleId, snapshotVersion, block, data}` → `{snapshot}`; blocks: `visibility | roster_schema | notifications | targets | rating_scale | auto_rating | features`; `visibility` values validated against `immediate|after_publish|never`; draft/setup only.
  - `cycle.set-admin-config` `{orgId, cycleId, adminConfigVersion, block, data}` → `{adminConfig}`; blocks: `bell`; draft/setup only.
- Note for reviewers: section saves are token-serialized (claim version → rewrite rows) but not atomic across statements; that is accepted for draft-stage authoring. Atomic multi-table transactions arrive with Plan 2b's SQL RPCs.

- [ ] **Step 1: Write the cycles module**

`supabase/functions/pms-admin/cycles.ts`:

```ts
import { ApiError, Handler, HandlerCtx } from '../_shared/kernel.ts';
import {
  optBool, optEnum, optInt, optNumber, optString, optUuid,
  reqArray, reqEnum, reqInt, reqIsoDate, reqNumber, reqObject, reqString, reqUuid,
} from '../_shared/validate.ts';

const EDITABLE = ['draft', 'setup'];
const FRAMEWORKS = ['bsc', 'kra-kpi', 'kra', 'custom'];
const WINDOW_KEYS = [
  'goal_creation', 'manager_approval', 'self_evaluation', 'manager_evaluation',
  'hod_review', 'hr_calibration', 'publishing_prep', 'acknowledgement',
];
const SECTIONS = [
  'perspectives', 'groups', 'target_types', 'rating_scale_levels', 'auto_rating_bands',
  'goal_rules', 'competency_config', 'competency_assignments', 'bell_curve_bands',
];
const SNAPSHOT_BLOCKS = [
  'visibility', 'roster_schema', 'notifications', 'targets', 'rating_scale', 'auto_rating', 'features',
];
const ADMIN_BLOCKS = ['bell'];
const VISIBILITY_VALUES = ['immediate', 'after_publish', 'never'];

async function loadCycle(ctx: HandlerCtx, orgId: string, cycleId: string) {
  const { data: cycle, error } = await ctx.admin.from('appraisal_cycles')
    .select().eq('id', cycleId).eq('organization_id', orgId).maybeSingle();
  if (error) { console.error('loadCycle', error); throw new ApiError('DB_ERROR', 'Database error', 500); }
  if (!cycle) throw new ApiError('NOT_FOUND', 'Cycle not found', 404);
  return cycle;
}

function assertEditable(cycle: Record<string, unknown>) {
  if (!EDITABLE.includes(cycle.status as string)) {
    throw new ApiError('CYCLE_LOCKED', `Configuration is locked once a cycle is ${cycle.status}`, 409);
  }
}

// The cycle row's version is the concurrency token for section/window saves:
// two admins racing on the same cycle — the loser gets CONFLICT and reloads.
async function claimCycleToken(ctx: HandlerCtx, orgId: string, cycle: Record<string, unknown>, expectedVersion: number) {
  return await ctx.versionedUpdate('appraisal_cycles', orgId, cycle.id as string, expectedVersion, {
    period_label: cycle.period_label ?? null,
  });
}

async function replaceRows(
  ctx: HandlerCtx, table: string, orgId: string, cycleId: string, rows: Record<string, unknown>[],
): Promise<number> {
  const { error: delErr } = await ctx.admin.from(table).delete()
    .eq('cycle_id', cycleId).eq('organization_id', orgId);
  if (delErr) { console.error(`replace ${table} delete`, delErr); throw new ApiError('DB_ERROR', 'Database error', 500); }
  if (rows.length === 0) return 0;
  const { error: insErr } = await ctx.admin.from(table).insert(rows);
  if (insErr) {
    if (insErr.code === '23505') throw new ApiError('BAD_REQUEST', `rows contain duplicates not allowed in ${table}`, 400);
    console.error(`replace ${table} insert`, insErr);
    throw new ApiError('DB_ERROR', 'Database error', 500);
  }
  return rows.length;
}

// ---------- per-section row builders ----------

function perspectiveRows(orgId: string, cycleId: string, raw: unknown) {
  return reqArray(raw, 'rows', 50).map((r, i) => {
    const o = reqObject(r, `rows[${i}]`);
    return {
      organization_id: orgId, cycle_id: cycleId,
      name: reqString(o.name, `rows[${i}].name`, 120),
      weight: optNumber(o.weight, `rows[${i}].weight`),
      color: optString(o.color, `rows[${i}].color`, 40),
      display_order: reqInt(o.displayOrder ?? i, `rows[${i}].displayOrder`),
    };
  });
}

function targetTypeRows(orgId: string, cycleId: string, raw: unknown) {
  return reqArray(raw, 'rows', 100).map((r, i) => {
    const o = reqObject(r, `rows[${i}]`);
    return {
      organization_id: orgId, cycle_id: cycleId,
      target_type_key: reqString(o.key, `rows[${i}].key`, 60),
      name: reqString(o.name, `rows[${i}].name`, 120),
      is_numeric: optBool(o.isNumeric, `rows[${i}].isNumeric`, true),
      unit: optString(o.unit, `rows[${i}].unit`, 30),
      unit_position: optEnum(o.unitPosition, `rows[${i}].unitPosition`, ['prefix', 'suffix']),
      min_value: optNumber(o.minValue, `rows[${i}].minValue`),
      max_value: optNumber(o.maxValue, `rows[${i}].maxValue`),
      lower_is_better: optBool(o.lowerIsBetter, `rows[${i}].lowerIsBetter`),
      hidden: optBool(o.hidden, `rows[${i}].hidden`),
      display_order: reqInt(o.displayOrder ?? i, `rows[${i}].displayOrder`),
    };
  });
}

function ratingScaleLevelRows(orgId: string, cycleId: string, raw: unknown) {
  return reqArray(raw, 'rows', 20).map((r, i) => {
    const o = reqObject(r, `rows[${i}]`);
    return {
      organization_id: orgId, cycle_id: cycleId,
      point: reqNumber(o.point, `rows[${i}].point`),
      label: reqString(o.label, `rows[${i}].label`, 120),
      code: optString(o.code, `rows[${i}].code`, 30),
      range_from: optNumber(o.rangeFrom, `rows[${i}].rangeFrom`),
      range_to: optNumber(o.rangeTo, `rows[${i}].rangeTo`),
      display_order: reqInt(o.displayOrder ?? i, `rows[${i}].displayOrder`),
    };
  });
}

function autoRatingBandRows(orgId: string, cycleId: string, raw: unknown) {
  return reqArray(raw, 'rows', 20).map((r, i) => {
    const o = reqObject(r, `rows[${i}]`);
    const fromPercent = reqNumber(o.fromPercent, `rows[${i}].fromPercent`);
    const toPercent = reqNumber(o.toPercent, `rows[${i}].toPercent`);
    if (toPercent < fromPercent) {
      throw new ApiError('BAD_REQUEST', `rows[${i}]: toPercent must be >= fromPercent`, 400);
    }
    return {
      organization_id: orgId, cycle_id: cycleId,
      from_percent: fromPercent, to_percent: toPercent,
      score: reqNumber(o.score, `rows[${i}].score`),
    };
  });
}

function bellBandRows(orgId: string, cycleId: string, raw: unknown) {
  return reqArray(raw, 'rows', 20).map((r, i) => {
    const o = reqObject(r, `rows[${i}]`);
    return {
      organization_id: orgId, cycle_id: cycleId,
      rating_point: reqNumber(o.ratingPoint, `rows[${i}].ratingPoint`),
      target_percent: reqNumber(o.targetPercent, `rows[${i}].targetPercent`),
      tolerance_percent: reqNumber(o.tolerancePercent ?? 0, `rows[${i}].tolerancePercent`),
    };
  });
}

async function cycleGroupMap(ctx: HandlerCtx, cycleId: string): Promise<Map<string, string>> {
  const { data, error } = await ctx.admin.from('cycle_groups').select('id, name').eq('cycle_id', cycleId);
  if (error) { console.error('cycleGroupMap', error); throw new ApiError('DB_ERROR', 'Database error', 500); }
  return new Map((data ?? []).map((g: { name: string; id: string }) => [g.name, g.id]));
}

async function goalRuleRows(ctx: HandlerCtx, orgId: string, cycleId: string, raw: unknown) {
  const byName = await cycleGroupMap(ctx, cycleId);
  return reqArray(raw, 'rows', 101).map((r, i) => {
    const o = reqObject(r, `rows[${i}]`);
    const groupName = optString(o.groupName, `rows[${i}].groupName`, 120);
    let groupId: string | null = null;
    if (groupName !== null) {
      groupId = byName.get(groupName) ?? null;
      if (!groupId) throw new ApiError('BAD_REQUEST', `rows[${i}].groupName "${groupName}" is not a group in this cycle`, 400);
    }
    return {
      organization_id: orgId, cycle_id: cycleId, group_id: groupId,
      min_kras: optInt(o.minKras, `rows[${i}].minKras`),
      max_kras: optInt(o.maxKras, `rows[${i}].maxKras`),
      min_kpis_per_kra: optInt(o.minKpisPerKra, `rows[${i}].minKpisPerKra`),
      max_kpis_per_kra: optInt(o.maxKpisPerKra, `rows[${i}].maxKpisPerKra`),
      min_kra_weight: optNumber(o.minKraWeight, `rows[${i}].minKraWeight`),
      max_kra_weight: optNumber(o.maxKraWeight, `rows[${i}].maxKraWeight`),
      min_kpi_weight: optNumber(o.minKpiWeight, `rows[${i}].minKpiWeight`),
      weightage_ownership: optString(o.weightageOwnership, `rows[${i}].weightageOwnership`, 60),
      employee_can_add_goals: optBool(o.employeeCanAddGoals, `rows[${i}].employeeCanAddGoals`),
      max_employee_added_goals: optInt(o.maxEmployeeAddedGoals, `rows[${i}].maxEmployeeAddedGoals`),
      manager_can_add_goals: optBool(o.managerCanAddGoals, `rows[${i}].managerCanAddGoals`),
      approval_required: optBool(o.approvalRequired, `rows[${i}].approvalRequired`, true),
    };
  });
}

async function competencyAssignmentRows(ctx: HandlerCtx, orgId: string, cycleId: string, raw: unknown) {
  const byName = await cycleGroupMap(ctx, cycleId);
  return reqArray(raw, 'rows', 500).map((r, i) => {
    const o = reqObject(r, `rows[${i}]`);
    const groupName = optString(o.groupName, `rows[${i}].groupName`, 120);
    let groupId: string | null = null;
    if (groupName !== null) {
      groupId = byName.get(groupName) ?? null;
      if (!groupId) throw new ApiError('BAD_REQUEST', `rows[${i}].groupName "${groupName}" is not a group in this cycle`, 400);
    }
    return {
      organization_id: orgId, cycle_id: cycleId, group_id: groupId,
      role_name: optString(o.roleName, `rows[${i}].roleName`, 120),
      competency_id: optUuid(o.competencyId, `rows[${i}].competencyId`),
      competency_name: reqString(o.competencyName, `rows[${i}].competencyName`, 200),
      kra_share: optNumber(o.kraShare, `rows[${i}].kraShare`),
      competency_share: optNumber(o.competencyShare, `rows[${i}].competencyShare`),
      display_order: reqInt(o.displayOrder ?? i, `rows[${i}].displayOrder`),
    };
  });
}

async function saveGroups(ctx: HandlerCtx, orgId: string, cycleId: string, raw: unknown): Promise<number> {
  const groups = reqArray(raw, 'rows', 100).map((r, i) => {
    const o = reqObject(r, `rows[${i}]`);
    return {
      row: {
        organization_id: orgId, cycle_id: cycleId,
        name: reqString(o.name, `rows[${i}].name`, 120),
        segment_attr: optString(o.segmentAttr, `rows[${i}].segmentAttr`, 120),
        is_catch_all: optBool(o.isCatchAll, `rows[${i}].isCatchAll`),
        can_edit_own_goals: optBool(o.canEditOwnGoals, `rows[${i}].canEditOwnGoals`),
        prefill_type: optString(o.prefillType, `rows[${i}].prefillType`, 60),
        has_library: optBool(o.hasLibrary, `rows[${i}].hasLibrary`),
        target_level: optEnum(o.targetLevel, `rows[${i}].targetLevel`, ['kra', 'kpi', 'custom']),
        rating_level: optEnum(o.ratingLevel, `rows[${i}].ratingLevel`, ['kra', 'kpi']),
        kpi_rating_mode: optString(o.kpiRatingMode, `rows[${i}].kpiRatingMode`, 60),
        display_order: reqInt(o.displayOrder ?? i, `rows[${i}].displayOrder`),
      },
      segmentValues: reqArray(o.segmentValues ?? [], `rows[${i}].segmentValues`, 200)
        .map((v, j) => reqString(v, `rows[${i}].segmentValues[${j}]`, 200)),
      libraryAssignments: reqArray(o.libraryAssignments ?? [], `rows[${i}].libraryAssignments`, 20)
        .map((a, j) => {
          const ao = reqObject(a, `rows[${i}].libraryAssignments[${j}]`);
          return {
            slot_key: reqString(ao.slotKey, `rows[${i}].libraryAssignments[${j}].slotKey`, 60),
            slot_label: optString(ao.slotLabel, `rows[${i}].libraryAssignments[${j}].slotLabel`, 120),
            goal_library_id: optUuid(ao.goalLibraryId, `rows[${i}].libraryAssignments[${j}].goalLibraryId`),
          };
        }),
    };
  });
  // Deleting groups cascades segment values, library assignments AND per-group
  // goal rules — clients must save groups BEFORE goal_rules/competency_assignments.
  await replaceRows(ctx, 'cycle_groups', orgId, cycleId, []);
  let count = 0;
  for (const g of groups) {
    const { data: inserted, error } = await ctx.admin.from('cycle_groups').insert(g.row).select('id').single();
    if (error) {
      if (error.code === '23505') throw new ApiError('BAD_REQUEST', `duplicate group name "${g.row.name}"`, 400);
      console.error('saveGroups insert', error);
      throw new ApiError('DB_ERROR', 'Database error', 500);
    }
    count += 1;
    if (g.segmentValues.length) {
      const { error: svErr } = await ctx.admin.from('cycle_group_segment_values').insert(
        g.segmentValues.map((v) => ({ organization_id: orgId, cycle_id: cycleId, group_id: inserted.id, value: v })),
      );
      if (svErr) { console.error('saveGroups segment values', svErr); throw new ApiError('DB_ERROR', 'Database error', 500); }
    }
    if (g.libraryAssignments.length) {
      const { error: laErr } = await ctx.admin.from('cycle_group_library_assignments').insert(
        g.libraryAssignments.map((a) => ({ organization_id: orgId, cycle_id: cycleId, group_id: inserted.id, ...a })),
      );
      if (laErr) { console.error('saveGroups library assignments', laErr); throw new ApiError('DB_ERROR', 'Database error', 500); }
    }
  }
  return count;
}

async function saveCompetencyConfig(ctx: HandlerCtx, orgId: string, cycleId: string, raw: unknown): Promise<number> {
  const o = reqObject(raw, 'config');
  const row = {
    organization_id: orgId, cycle_id: cycleId,
    enabled: optBool(o.enabled, 'config.enabled'),
    max_per_employee: optInt(o.maxPerEmployee, 'config.maxPerEmployee'),
    competency_weight: optNumber(o.competencyWeight, 'config.competencyWeight'),
    rated_by: optString(o.ratedBy, 'config.ratedBy', 60),
    allow_self_rate: optBool(o.allowSelfRate, 'config.allowSelfRate'),
    employee_can_edit: optBool(o.employeeCanEdit, 'config.employeeCanEdit'),
    scope: reqEnum(o.scope ?? 'org', 'config.scope', ['org', 'group', 'group_role']),
  };
  const { error } = await ctx.admin.from('cycle_competency_config')
    .upsert(row, { onConflict: 'cycle_id' });
  if (error) { console.error('saveCompetencyConfig', error); throw new ApiError('DB_ERROR', 'Database error', 500); }
  return 1;
}

// ---------- handlers ----------

export const cycleHandlers: Record<string, Handler> = {
  'cycle.create-draft': async (payload, ctx) => {
    const orgId = reqUuid(payload.orgId, 'orgId');
    ctx.requireOrgRole(orgId, ['hr_admin']);
    const name = reqString(payload.name, 'name', 200);
    const periodLabel = optString(payload.periodLabel, 'periodLabel', 100);
    const frameworkId = reqEnum(payload.frameworkId, 'frameworkId', FRAMEWORKS);
    const { data: cycle, error } = await ctx.admin.from('appraisal_cycles').insert({
      organization_id: orgId, name, period_label: periodLabel,
      framework_id: frameworkId, status: 'draft', created_by: ctx.userId,
    }).select().single();
    if (error) {
      if (error.code === '23505') {
        throw new ApiError('WORKING_CYCLE_EXISTS', 'This organization already has a working cycle', 409);
      }
      console.error('cycle.create-draft', error);
      throw new ApiError('DB_ERROR', 'Database error', 500);
    }
    const { error: snapErr } = await ctx.admin.from('cycle_config_snapshots')
      .insert({ organization_id: orgId, cycle_id: cycle.id });
    if (snapErr) { console.error('create-draft snapshot', snapErr); throw new ApiError('DB_ERROR', 'Database error', 500); }
    const { error: acErr } = await ctx.admin.from('cycle_admin_config')
      .insert({ organization_id: orgId, cycle_id: cycle.id });
    if (acErr) { console.error('create-draft admin config', acErr); throw new ApiError('DB_ERROR', 'Database error', 500); }
    await ctx.audit({
      organizationId: orgId, cycleId: cycle.id, action: 'cycle.create-draft',
      entityType: 'appraisal_cycle', entityId: cycle.id, after: cycle,
    });
    return { cycle };
  },

  'cycle.save-section': async (payload, ctx) => {
    const orgId = reqUuid(payload.orgId, 'orgId');
    ctx.requireOrgRole(orgId, ['hr_admin']);
    const cycleId = reqUuid(payload.cycleId, 'cycleId');
    const cycleVersion = reqInt(payload.cycleVersion, 'cycleVersion');
    const section = reqEnum(payload.section, 'section', SECTIONS);
    const cycle = await loadCycle(ctx, orgId, cycleId);
    assertEditable(cycle);
    const fresh = await claimCycleToken(ctx, orgId, cycle, cycleVersion);
    let count = 0;
    switch (section) {
      case 'perspectives':
        count = await replaceRows(ctx, 'cycle_perspectives', orgId, cycleId, perspectiveRows(orgId, cycleId, payload.rows));
        break;
      case 'groups':
        count = await saveGroups(ctx, orgId, cycleId, payload.rows);
        break;
      case 'target_types':
        count = await replaceRows(ctx, 'cycle_target_types', orgId, cycleId, targetTypeRows(orgId, cycleId, payload.rows));
        break;
      case 'rating_scale_levels':
        count = await replaceRows(ctx, 'cycle_rating_scale_levels', orgId, cycleId, ratingScaleLevelRows(orgId, cycleId, payload.rows));
        break;
      case 'auto_rating_bands':
        count = await replaceRows(ctx, 'cycle_auto_rating_bands', orgId, cycleId, autoRatingBandRows(orgId, cycleId, payload.rows));
        break;
      case 'goal_rules':
        count = await replaceRows(ctx, 'cycle_goal_rules', orgId, cycleId, await goalRuleRows(ctx, orgId, cycleId, payload.rows));
        break;
      case 'competency_config':
        count = await saveCompetencyConfig(ctx, orgId, cycleId, payload.config);
        break;
      case 'competency_assignments':
        count = await replaceRows(ctx, 'cycle_competency_assignments', orgId, cycleId, await competencyAssignmentRows(ctx, orgId, cycleId, payload.rows));
        break;
      case 'bell_curve_bands':
        count = await replaceRows(ctx, 'cycle_bell_curve_bands', orgId, cycleId, bellBandRows(orgId, cycleId, payload.rows));
        break;
    }
    await ctx.audit({
      organizationId: orgId, cycleId, action: 'cycle.section.save',
      entityType: 'cycle_section', note: `${section}: ${count} row(s)`,
    });
    return { cycle: fresh, rows: count };
  },

  'cycle.set-windows': async (payload, ctx) => {
    const orgId = reqUuid(payload.orgId, 'orgId');
    ctx.requireOrgRole(orgId, ['hr_admin']);
    const cycleId = reqUuid(payload.cycleId, 'cycleId');
    const cycleVersion = reqInt(payload.cycleVersion, 'cycleVersion');
    const windows = reqArray(payload.windows, 'windows', 8).map((w, i) => {
      const o = reqObject(w, `windows[${i}]`);
      const startsOn = reqIsoDate(o.startsOn, `windows[${i}].startsOn`);
      const endsOn = reqIsoDate(o.endsOn, `windows[${i}].endsOn`);
      if (endsOn < startsOn) throw new ApiError('BAD_REQUEST', `windows[${i}]: endsOn must be >= startsOn`, 400);
      return {
        organization_id: orgId, cycle_id: cycleId,
        window_key: reqEnum(o.key, `windows[${i}].key`, WINDOW_KEYS),
        starts_on: startsOn, ends_on: endsOn,
      };
    });
    const keys = windows.map((w) => w.window_key);
    if (new Set(keys).size !== keys.length) throw new ApiError('BAD_REQUEST', 'windows contains duplicate keys', 400);
    const cycle = await loadCycle(ctx, orgId, cycleId);
    // The calendar governs LIVE cycles: windows stay editable in every status
    // except archived (spec: super-admin/HR edit, last-write-wins, audited).
    if (cycle.status === 'archived') {
      throw new ApiError('CYCLE_LOCKED', 'Archived cycles are read-only', 409);
    }
    const fresh = await claimCycleToken(ctx, orgId, cycle, cycleVersion);
    const count = await replaceRows(ctx, 'cycle_phase_windows', orgId, cycleId, windows);
    await ctx.audit({
      organizationId: orgId, cycleId, action: 'cycle.windows.set',
      entityType: 'cycle_phase_windows', note: `${count} window(s)`,
    });
    return { cycle: fresh, rows: count };
  },

  'cycle.set-snapshot-block': async (payload, ctx) => {
    const orgId = reqUuid(payload.orgId, 'orgId');
    ctx.requireOrgRole(orgId, ['hr_admin']);
    const cycleId = reqUuid(payload.cycleId, 'cycleId');
    const snapshotVersion = reqInt(payload.snapshotVersion, 'snapshotVersion');
    const block = reqEnum(payload.block, 'block', SNAPSHOT_BLOCKS);
    const data = reqObject(payload.data, 'data');
    if (block === 'visibility') {
      reqEnum(data.manager_rating_visible, 'data.manager_rating_visible', VISIBILITY_VALUES);
      reqEnum(data.final_rating_visible, 'data.final_rating_visible', VISIBILITY_VALUES);
    }
    const cycle = await loadCycle(ctx, orgId, cycleId);
    assertEditable(cycle);
    const { data: snap, error } = await ctx.admin.from('cycle_config_snapshots')
      .select().eq('cycle_id', cycleId).eq('organization_id', orgId).maybeSingle();
    if (error) { console.error('set-snapshot read', error); throw new ApiError('DB_ERROR', 'Database error', 500); }
    if (!snap) throw new ApiError('NOT_FOUND', 'Snapshot row not found', 404);
    const merged = { ...(snap.snapshot ?? {}), [block]: data };
    const updated = await ctx.versionedUpdate('cycle_config_snapshots', orgId, snap.id, snapshotVersion, { snapshot: merged });
    await ctx.audit({
      organizationId: orgId, cycleId, action: 'cycle.snapshot.set',
      entityType: 'cycle_config_snapshot', entityId: snap.id,
      before: { [block]: (snap.snapshot ?? {})[block] ?? null }, after: { [block]: data },
    });
    return { snapshot: updated };
  },

  'cycle.set-admin-config': async (payload, ctx) => {
    const orgId = reqUuid(payload.orgId, 'orgId');
    ctx.requireOrgRole(orgId, ['hr_admin']);
    const cycleId = reqUuid(payload.cycleId, 'cycleId');
    const adminConfigVersion = reqInt(payload.adminConfigVersion, 'adminConfigVersion');
    const block = reqEnum(payload.block, 'block', ADMIN_BLOCKS);
    const data = reqObject(payload.data, 'data');
    const cycle = await loadCycle(ctx, orgId, cycleId);
    assertEditable(cycle);
    const { data: cfg, error } = await ctx.admin.from('cycle_admin_config')
      .select().eq('cycle_id', cycleId).eq('organization_id', orgId).maybeSingle();
    if (error) { console.error('set-admin-config read', error); throw new ApiError('DB_ERROR', 'Database error', 500); }
    if (!cfg) throw new ApiError('NOT_FOUND', 'Admin config row not found', 404);
    const merged = { ...(cfg.payload ?? {}), [block]: data };
    const updated = await ctx.versionedUpdate('cycle_admin_config', orgId, cfg.id, adminConfigVersion, { payload: merged });
    await ctx.audit({
      organizationId: orgId, cycleId, action: 'cycle.admin_config.set',
      entityType: 'cycle_admin_config', entityId: cfg.id,
      before: { [block]: (cfg.payload ?? {})[block] ?? null }, after: { [block]: data },
    });
    return { adminConfig: updated };
  },
};
```

- [ ] **Step 2: Wire the router**

Replace `supabase/functions/pms-admin/index.ts` with:

```ts
import { serveActions } from '../_shared/kernel.ts';
import { organizationHandlers } from './organizations.ts';
import { cycleHandlers } from './cycles.ts';

serveActions({
  'admin.whoami': (_payload, ctx) =>
    Promise.resolve({ userId: ctx.userId, memberships: ctx.memberships }),
  ...organizationHandlers,
  ...cycleHandlers,
});
```

- [ ] **Step 3: Deploy**

Run: `supabase functions deploy pms-admin`
Expected: `Deployed Functions on project mkjtdwrzmobahwkpumxx: pms-admin`.

- [ ] **Step 4: Quick live probe (full checks in Task 6)**

Run: `node supabase/verify/kernel-check.mjs`
Expected: still `kernel-check: PASS` (whoami untouched by the new modules).

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/pms-admin/cycles.ts supabase/functions/pms-admin/index.ts
git commit -m "feat(admin-backend): cycle draft config authoring actions"
```

---

### Task 6: Admin end-to-end verification + smoke gate wiring

**Files:**
- Modify: `supabase/verify/admin-check.mjs` (append cycle sections after the org sections)
- Modify: `supabase/verify/run-all.mjs` (append `'supabase/verify/admin-check.mjs'` to the `scripts` array — it must run AFTER `seed-foundation.mjs` since it imports seed constants and expects seeded users)

**Interfaces:**
- Consumes: `callAdmin`, tokens, `admin`, `gamma` org from Task 4's sections; actions from Task 5.
- Produces: `admin-check: PASS (35 assertions)`; full gate `node supabase/verify/run-all.mjs` → `FOUNDATION SMOKE: ALL PASS`.

- [ ] **Step 1: Append the cycle sections**

Append to `supabase/verify/admin-check.mjs` (before the final `console.log`; note `gamma` version is now 2 after the rename and branding steps — always thread versions from responses, never hardcode):

```js
// --- cycle.create-draft ---
let cycle;
{
  const denied = await callAdmin(empT, 'cycle.create-draft', {
    orgId: gamma.id, name: 'FY27 Gamma Cycle', frameworkId: 'kra-kpi',
  });
  check('cycle.create-draft denied for employee', denied.status === 403);
  const created = await callAdmin(superT, 'cycle.create-draft', {
    orgId: gamma.id, name: 'FY27 Gamma Cycle', periodLabel: 'FY 2027-28', frameworkId: 'kra-kpi',
  });
  check('cycle.create-draft succeeds', created.status === 200 && created.body.data.cycle.status === 'draft');
  cycle = created.body.data.cycle;
  const second = await callAdmin(superT, 'cycle.create-draft', {
    orgId: gamma.id, name: 'Second Working', frameworkId: 'kra',
  });
  check('second working cycle rejected', second.status === 409 && second.body.error.code === 'WORKING_CYCLE_EXISTS');
  const { data: snapRows } = await admin.from('cycle_config_snapshots').select('id').eq('cycle_id', cycle.id);
  const { data: acRows } = await admin.from('cycle_admin_config').select('id').eq('cycle_id', cycle.id);
  check('snapshot + admin-config rows created with draft', (snapRows ?? []).length === 1 && (acRows ?? []).length === 1);
}

// --- cycle.save-section: every section round-trips ---
{
  let v = cycle.version;
  const save = async (section, body) => {
    const res = await callAdmin(superT, 'cycle.save-section', {
      orgId: gamma.id, cycleId: cycle.id, cycleVersion: v, section, ...body,
    });
    assert.equal(res.status, 200, `save ${section}: ${JSON.stringify(res.body)}`);
    v = res.body.data.cycle.version;
    return res.body.data.rows;
  };

  check('perspectives save', await save('perspectives', { rows: [
    { name: 'Financial', weight: 40, color: '#3b82f6', displayOrder: 0 },
    { name: 'Customer', weight: 60, color: '#8b5cf6', displayOrder: 1 },
  ] }) === 2);

  check('groups save (with segments + assignment slots)', await save('groups', { rows: [
    { name: 'Sales', segmentAttr: 'Department', segmentValues: ['Sales', 'Field Sales'],
      canEditOwnGoals: true, hasLibrary: true, targetLevel: 'kpi', ratingLevel: 'kpi',
      libraryAssignments: [{ slotKey: 'primary', slotLabel: 'Primary library', goalLibraryId: null }] },
    { name: 'Everyone Else', isCatchAll: true, targetLevel: 'kra', ratingLevel: 'kra' },
  ] }) === 2);

  const { data: segRows } = await admin.from('cycle_group_segment_values').select('id').eq('cycle_id', cycle.id);
  check('segment values written', (segRows ?? []).length === 2);

  check('target_types save', await save('target_types', { rows: [
    { key: 'number', name: 'Number', isNumeric: true },
    { key: 'percent', name: 'Percentage', isNumeric: true, unit: '%', unitPosition: 'suffix', lowerIsBetter: false },
  ] }) === 2);

  check('rating_scale_levels save', await save('rating_scale_levels', { rows: [
    { point: 1, label: 'Needs Improvement', code: 'NI', rangeFrom: 0, rangeTo: 39 },
    { point: 2, label: 'Developing', code: 'DE', rangeFrom: 40, rangeTo: 59 },
    { point: 3, label: 'Meets Expectations', code: 'ME', rangeFrom: 60, rangeTo: 79 },
    { point: 4, label: 'Exceeds', code: 'EX', rangeFrom: 80, rangeTo: 94 },
    { point: 5, label: 'Outstanding', code: 'OU', rangeFrom: 95, rangeTo: 100 },
  ] }) === 5);

  check('auto_rating_bands save', await save('auto_rating_bands', { rows: [
    { fromPercent: 0, toPercent: 59, score: 2 },
    { fromPercent: 60, toPercent: 94, score: 3.5 },
    { fromPercent: 95, toPercent: 200, score: 5 },
  ] }) === 3);

  const badBand = await callAdmin(superT, 'cycle.save-section', {
    orgId: gamma.id, cycleId: cycle.id, cycleVersion: v, section: 'auto_rating_bands',
    rows: [{ fromPercent: 50, toPercent: 10, score: 1 }],
  });
  check('inverted auto-rating band rejected', badBand.status === 400 && badBand.body.error.code === 'BAD_REQUEST');
  // NOTE: the failed save above still consumed the version token (token is claimed
  // before rows are validated? No — validation happens before the token claim only
  // for shape; band range check happens inside the row builder BEFORE claimCycleToken
  // is reached in this handler order). Read the fresh version from the DB to be safe:
  const { data: cycNow } = await admin.from('appraisal_cycles').select('version').eq('id', cycle.id).single();
  v = cycNow.version;

  check('goal_rules save (cycle-wide + per-group)', await save('goal_rules', { rows: [
    { groupName: null, minKras: 3, maxKras: 6, maxKpisPerKra: 4, minKpiWeight: 5, approvalRequired: true },
    { groupName: 'Sales', minKras: 2, maxKras: 5, employeeCanAddGoals: true, maxEmployeeAddedGoals: 2 },
  ] }) === 2);

  const badRule = await callAdmin(superT, 'cycle.save-section', {
    orgId: gamma.id, cycleId: cycle.id, cycleVersion: v, section: 'goal_rules',
    rows: [{ groupName: 'No Such Group', minKras: 1 }],
  });
  check('goal rule with unknown group rejected', badRule.status === 400);
  {
    const { data: cycNow2 } = await admin.from('appraisal_cycles').select('version').eq('id', cycle.id).single();
    v = cycNow2.version;
  }

  check('competency_config save', await save('competency_config', { config: {
    enabled: true, maxPerEmployee: 4, competencyWeight: 20, ratedBy: 'manager',
    allowSelfRate: false, employeeCanEdit: false, scope: 'group',
  } }) === 1);

  check('competency_assignments save', await save('competency_assignments', { rows: [
    { groupName: 'Sales', competencyName: 'Customer Focus', kraShare: 80, competencyShare: 20 },
    { groupName: null, competencyName: 'Integrity' },
  ] }) === 2);

  check('bell_curve_bands save', await save('bell_curve_bands', { rows: [
    { ratingPoint: 2, targetPercent: 10, tolerancePercent: 5 },
    { ratingPoint: 3, targetPercent: 60, tolerancePercent: 10 },
    { ratingPoint: 5, targetPercent: 10, tolerancePercent: 5 },
  ] }) === 3);

  const stale = await callAdmin(superT, 'cycle.save-section', {
    orgId: gamma.id, cycleId: cycle.id, cycleVersion: 1, section: 'perspectives', rows: [],
  });
  check('stale cycleVersion conflicts', stale.status === 409 && stale.body.error.code === 'CONFLICT');

  cycle.version = v;
}

// --- windows, snapshot, admin config ---
{
  const win = await callAdmin(superT, 'cycle.set-windows', {
    orgId: gamma.id, cycleId: cycle.id, cycleVersion: cycle.version,
    windows: [
      { key: 'goal_creation', startsOn: '2027-04-01', endsOn: '2027-04-20' },
      { key: 'manager_approval', startsOn: '2027-04-15', endsOn: '2027-04-30' },
      { key: 'self_evaluation', startsOn: '2028-02-01', endsOn: '2028-02-28' },
      { key: 'manager_evaluation', startsOn: '2028-02-20', endsOn: '2028-03-15' },
      { key: 'hod_review', startsOn: '2028-03-10', endsOn: '2028-03-25' },
      { key: 'hr_calibration', startsOn: '2028-03-20', endsOn: '2028-04-05' },
      { key: 'publishing_prep', startsOn: '2028-04-01', endsOn: '2028-04-10' },
      { key: 'acknowledgement', startsOn: '2028-04-10', endsOn: '2028-04-25' },
    ],
  });
  check('set-windows saves all 8 (overlaps allowed)', win.status === 200 && win.body.data.rows === 8);
  cycle.version = win.body.data.cycle.version;

  const badKey = await callAdmin(superT, 'cycle.set-windows', {
    orgId: gamma.id, cycleId: cycle.id, cycleVersion: cycle.version,
    windows: [{ key: 'lunch_break', startsOn: '2027-04-01', endsOn: '2027-04-02' }],
  });
  check('unknown window key rejected', badKey.status === 400);

  const snap = await callAdmin(superT, 'cycle.set-snapshot-block', {
    orgId: gamma.id, cycleId: cycle.id, snapshotVersion: 1, block: 'visibility',
    data: { manager_rating_visible: 'after_publish', final_rating_visible: 'after_publish' },
  });
  check('snapshot visibility block saves', snap.status === 200);

  const badVis = await callAdmin(superT, 'cycle.set-snapshot-block', {
    orgId: gamma.id, cycleId: cycle.id, snapshotVersion: 2, block: 'visibility',
    data: { manager_rating_visible: 'whenever', final_rating_visible: 'never' },
  });
  check('invalid visibility value rejected', badVis.status === 400);

  const ac = await callAdmin(superT, 'cycle.set-admin-config', {
    orgId: gamma.id, cycleId: cycle.id, adminConfigVersion: 1, block: 'bell',
    data: { enabled: true, mode: 'org', preset: 'standard' },
  });
  check('admin-config bell block saves', ac.status === 200);
}

// --- lock stages ---
{
  await admin.from('appraisal_cycles').update({ status: 'active' }).eq('id', cycle.id);
  const { data: cycNow } = await admin.from('appraisal_cycles').select('version').eq('id', cycle.id).single();
  const locked = await callAdmin(superT, 'cycle.save-section', {
    orgId: gamma.id, cycleId: cycle.id, cycleVersion: cycNow.version, section: 'perspectives', rows: [],
  });
  check('save-section locked once active', locked.status === 409 && locked.body.error.code === 'CYCLE_LOCKED');
  const winLive = await callAdmin(superT, 'cycle.set-windows', {
    orgId: gamma.id, cycleId: cycle.id, cycleVersion: cycNow.version,
    windows: [{ key: 'acknowledgement', startsOn: '2028-04-10', endsOn: '2028-05-01' }],
  });
  check('windows still editable while active (calendar governs)', winLive.status === 200);
  await admin.from('appraisal_cycles').update({ status: 'archived', archived_at: new Date().toISOString() }).eq('id', cycle.id);
  const { data: cycArch } = await admin.from('appraisal_cycles').select('version').eq('id', cycle.id).single();
  const winArch = await callAdmin(superT, 'cycle.set-windows', {
    orgId: gamma.id, cycleId: cycle.id, cycleVersion: cycArch.version,
    windows: [{ key: 'acknowledgement', startsOn: '2028-04-10', endsOn: '2028-05-01' }],
  });
  check('windows locked once archived', winArch.status === 409 && winArch.body.error.code === 'CYCLE_LOCKED');
}

// --- audit trail exists ---
{
  const { data: audits } = await admin.from('audit_logs')
    .select('action').eq('organization_id', gamma.id);
  check('audit rows written for admin actions', (audits ?? []).length >= 15);
}
```

- [ ] **Step 2: Fix the token-claim ordering note**

The inline NOTE in Step 1's `save` flow flags an ordering subtlety: in `cycle.save-section`, row-builder validation for simple sections runs AFTER `claimCycleToken` (the switch body executes post-claim), so a failed validation there HAS consumed a version bump — which is why the script re-reads the fresh version from the DB after each expected-failure save. Keep those re-reads; they are not optional.

- [ ] **Step 3: Wire the smoke gate**

In `supabase/verify/run-all.mjs`, change the `scripts` array to:

```js
const scripts = [
  'supabase/verify/check-tables.mjs',
  'supabase/verify/seed-foundation.mjs',
  'supabase/verify/rls-check.mjs',
  'supabase/verify/kernel-check.mjs',
  'supabase/verify/admin-check.mjs',
];
```

- [ ] **Step 4: Run the full gate**

Run: `node supabase/verify/run-all.mjs`
Expected: deno kernel tests pass, then all five scripts pass (`rls-check: PASS (41 assertions)`, `admin-check: PASS (35 assertions)`), final `FOUNDATION SMOKE: ALL PASS`, exit 0.

- [ ] **Step 5: Run lint**

Run: `npm run lint`
Expected: no NEW problems in `supabase/verify/**` or `supabase/functions/**` (pre-existing `src/` findings are out of scope — note, don't fix).

- [ ] **Step 6: Commit**

```bash
git add supabase/verify/admin-check.mjs supabase/verify/run-all.mjs
git commit -m "test(admin-backend): admin backend end-to-end verification + smoke gate wiring"
```

---

## Out of Scope (Plan 2b — next)

- Goal libraries / prefill dataset CRUD (org-level), roster import (`import_runs` validate → preview → commit), participants + assignments, invite queuing (`email_jobs` + auth user creation), activation transaction (SQL RPC `pms.activate_cycle_tx`), start-new-cycle / archive carry-over RPC, versioned config amendments after activation (`cycle_config_versions` + `amend_config_tx`).
- Kernel derived-capability helper (manager/HOD via `reporting_relationships`) — first needed by Plan 3 workflow actions.
- Job worker (Plan 4), screens (Plan 5), cutover (Plan 6).

Nothing in this plan modifies old-world files (old edge functions, `public` schema, `src/`).
