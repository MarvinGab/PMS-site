# Rebuild Plan 3a: Goal-Setting Workflow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The employee goal-setting loop — seed each participant's goal plan from their assigned library/prefill, let the employee build and submit it, let their manager approve or send it back, and let HR reopen — all server-side, phase-gated, permission-checked, versioned, and audited, in a new `pms-workflow` edge function.

**Architecture:** A new `pms-workflow` edge function (employee/manager actions) built on the same `_shared/kernel.ts` as `pms-admin`, kept separate from HR admin actions. Two new shared helper modules: `_shared/scope.ts` derives manager/HOD capability from `reporting_relationships` (the edge-side mirror of the RLS SQL helpers), and `_shared/phase.ts` checks whether a cycle phase window is open. Goal-rule validation runs before any write; plan-status transitions use the plan's `version` as the optimistic-lock token; every transition appends a `goal_workflow_events` row.

**Tech Stack:** Supabase edge functions (Deno, `npm:@supabase/supabase-js@2`), Postgres, Node verify scripts with `node:assert`, Supabase CLI (linked project `mkjtdwrzmobahwkpumxx`).

**Spec:** `docs/superpowers/specs/2026-07-03-server-first-rebuild-design.md` §4.4 (create-cycle transaction step 17 — initial goal plans), §5 (permissions: employee edits own; manager approves direct reports), §7 (overlapping phase windows; backend checks the specific action's window + prerequisites).

## Global Constraints

- **Write rule:** browser reads via RLS only; ALL business writes go through backend functions. No new grants to `anon`. No new tables in this plan (all workflow tables exist from Plan 1's `2026070313_pms_workflow.sql`).
- **Kernel contract (binding):** response `{ ok: true, data } | { ok: false, error: { code, message } }`; stale version → `CONFLICT` 409 "someone else changed this — reload"; `versionedUpdate(table, orgId, id, expectedVersion, patch)` is org-scoped; auth precedes routing; raw DB errors never reach clients (`console.error` + generic `DB_ERROR` 500). Validators in `_shared/validate.ts`. Membership carries `employeeId` (the caller's employee row id for that org, or null).
- **2b gotchas (binding):** (1) never raise a version conflict with SQLSTATE 40001/`serialization_failure` in an RPC — the pooler auto-retries and hangs; use a custom code like `'PT409'` and map it. (This plan uses no new RPCs, but any you add follow this.) (2) an optimistic write in an RPC needs `if not found then raise` after the version-guarded UPDATE. (3) any new backend-only SECURITY DEFINER RPC MUST carry `revoke all on function ... from public, anon, authenticated` in its migration + a live 42501 denial assertion. (4) a new migration numbered below an applied one needs `supabase db push --include-all`.
- **Derived capability, not roles (binding):** manager/HOD are NOT `org_members` roles — they are derived from `reporting_relationships` (`relation_type` in `manager`/`l2`/`hod`). Use `_shared/scope.ts`, never `requireOrgRole` for manager/HOD checks.
- **Phase gating (this plan's rule):** goal edit/submit require the `goal_creation` window open; approve/send-back require the `manager_approval` window open; `hr_admin`/`super_admin` bypass the window check (corrections). A missing window row = closed. Windows may overlap; each action checks only its own window. Closed → `WINDOW_CLOSED` 409.
- **Cycle status:** goal actions require the cycle to be `active` (not draft/setup/review/published/archived). Wrong status → `CYCLE_NOT_ACTIVE` 409.
- **Assignment status filters (2b-deferred, apply here):** when reading a participant's assigned goal library / prefill dataset for seeding, ignore `status='archived'` libraries/datasets (seed nothing from an archived source rather than erroring).
- Every handler: validate → resolve caller's employee + target scope → phase/status gate → write (version-checked) → append workflow event where applicable → audit → typed response.
- Repo has unrelated dirty old-app files: stage ONLY each task's files by explicit path. `.env` gitignored, never printed/committed. Old-world files (old edge functions, `public` schema, `src/`) untouched.
- Branch: `rebuild-3a-goal-workflow` (from `main`). If built in a git worktree, copy the 7 untracked old-app migrations (`2026062501..2026070301`) into it so `supabase db push` reconciles.
- Commit trailer on every commit: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`
- Verify counts at branch start: `admin-check` 86, `rls-check` 55. This plan adds a NEW `workflow-check.mjs` and wires it into `run-all.mjs`; each task states its expected `workflow-check` total.

---

### Task 1: `pms-workflow` function + shared scope & phase helpers

**Files:**
- Create: `supabase/functions/_shared/scope.ts`
- Create: `supabase/functions/_shared/scope.test.ts`
- Create: `supabase/functions/_shared/phase.ts`
- Create: `supabase/functions/_shared/phase.test.ts`
- Create: `supabase/functions/pms-workflow/index.ts`
- Create: `supabase/functions/pms-workflow/config.toml`
- Create: `supabase/verify/workflow-check.mjs`

**Interfaces:**
- Consumes: kernel (`serveActions`, `ApiError`, `Handler`, `HandlerCtx`, `Membership`).
- Produces (used by every later task):
  - `callerEmployeeId(ctx, orgId) → string` (throws `NO_EMPLOYEE` 403 if the caller has no employee row in the org).
  - `manages(ctx, orgId, targetEmployeeId) → Promise<boolean>` (true if the caller is the target's `manager` or `l2`).
  - `isHodOf(ctx, orgId, targetEmployeeId) → Promise<boolean>` (true if the caller is the target's `hod`).
  - `isHrOrSuper(ctx, orgId) → boolean`.
  - `pureWindowOpen(windows, windowKey, todayIso) → boolean` (pure; `windows` = array of `{window_key, starts_on, ends_on}`).
  - `requireWindowOrHr(ctx, orgId, cycleId, windowKey) → Promise<void>` (throws `WINDOW_CLOSED` 409 unless the window is open today or the caller is HR/super).
  - `loadActiveCycle(ctx, orgId, cycleId) → Promise<row>` (throws `NOT_FOUND` 404 / `CYCLE_NOT_ACTIVE` 409).
  - Deployed function `pms-workflow` with action `workflow.whoami`.
  - Verify helper `callWorkflow(token, action, payload)` + `check` in `workflow-check.mjs`.

- [ ] **Step 1: Write failing phase unit tests**

`supabase/functions/_shared/phase.test.ts`:

```ts
import { assertEquals } from 'jsr:@std/assert@1';
import { pureWindowOpen } from './phase.ts';

const windows = [
  { window_key: 'goal_creation', starts_on: '2027-04-01', ends_on: '2027-04-30' },
  { window_key: 'manager_approval', starts_on: '2027-04-15', ends_on: '2027-05-10' },
];

Deno.test('window open on a day inside the range (inclusive bounds)', () => {
  assertEquals(pureWindowOpen(windows, 'goal_creation', '2027-04-01'), true);
  assertEquals(pureWindowOpen(windows, 'goal_creation', '2027-04-30'), true);
  assertEquals(pureWindowOpen(windows, 'goal_creation', '2027-04-15'), true);
});

Deno.test('window closed before/after the range', () => {
  assertEquals(pureWindowOpen(windows, 'goal_creation', '2027-03-31'), false);
  assertEquals(pureWindowOpen(windows, 'goal_creation', '2027-05-01'), false);
});

Deno.test('overlapping windows are independent', () => {
  assertEquals(pureWindowOpen(windows, 'manager_approval', '2027-04-20'), true);
  assertEquals(pureWindowOpen(windows, 'manager_approval', '2027-04-10'), false);
});

Deno.test('missing window key is closed', () => {
  assertEquals(pureWindowOpen(windows, 'self_evaluation', '2027-04-20'), false);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `deno test supabase/functions/_shared/phase.test.ts`
Expected: FAIL — `Module not found ... phase.ts`.

- [ ] **Step 3: Implement `phase.ts`**

`supabase/functions/_shared/phase.ts`:

```ts
import { ApiError, HandlerCtx } from './kernel.ts';
import { isHrOrSuper } from './scope.ts';

type Window = { window_key: string; starts_on: string; ends_on: string };

// Pure: is `windowKey` open on `todayIso` (YYYY-MM-DD, inclusive bounds)?
export function pureWindowOpen(windows: Window[], windowKey: string, todayIso: string): boolean {
  const w = windows.find((x) => x.window_key === windowKey);
  if (!w) return false;
  return w.starts_on <= todayIso && todayIso <= w.ends_on;
}

function todayIso(): string {
  // Edge runtime allows Date; use UTC date. (Cycle windows are date-granular.)
  return new Date().toISOString().slice(0, 10);
}

export async function requireWindowOrHr(
  ctx: HandlerCtx, orgId: string, cycleId: string, windowKey: string,
): Promise<void> {
  if (isHrOrSuper(ctx, orgId)) return;
  const { data, error } = await ctx.admin.from('cycle_phase_windows')
    .select('window_key, starts_on, ends_on').eq('cycle_id', cycleId).eq('organization_id', orgId);
  if (error) { console.error('requireWindow read', error); throw new ApiError('DB_ERROR', 'Database error', 500); }
  if (!pureWindowOpen((data ?? []) as Window[], windowKey, todayIso())) {
    throw new ApiError('WINDOW_CLOSED', `The ${windowKey.replace('_', ' ')} window is not open`, 409);
  }
}

export async function loadActiveCycle(ctx: HandlerCtx, orgId: string, cycleId: string) {
  const { data: cycle, error } = await ctx.admin.from('appraisal_cycles')
    .select().eq('id', cycleId).eq('organization_id', orgId).maybeSingle();
  if (error) { console.error('loadActiveCycle', error); throw new ApiError('DB_ERROR', 'Database error', 500); }
  if (!cycle) throw new ApiError('NOT_FOUND', 'Cycle not found', 404);
  if (cycle.status !== 'active') throw new ApiError('CYCLE_NOT_ACTIVE', `The cycle is ${cycle.status}, not active`, 409);
  return cycle;
}
```

- [ ] **Step 4: Run phase tests to verify pass**

Run: `deno test supabase/functions/_shared/phase.test.ts`
Expected: `ok | 4 passed | 0 failed`.

- [ ] **Step 5: Write failing scope unit test**

`supabase/functions/_shared/scope.test.ts`:

```ts
import { assertEquals, assertThrows } from 'jsr:@std/assert@1';
import { ApiError } from './kernel.ts';
import { callerEmployeeId, isHrOrSuper } from './scope.ts';

function ctx(memberships: unknown) {
  return { memberships } as unknown as import('./kernel.ts').HandlerCtx;
}

Deno.test('callerEmployeeId returns the org employee id', () => {
  const c = ctx([{ organizationId: 'org1', roles: ['employee'], employeeId: 'emp1' }]);
  assertEquals(callerEmployeeId(c, 'org1'), 'emp1');
});

Deno.test('callerEmployeeId throws when no employee row in the org', () => {
  const c = ctx([{ organizationId: 'org1', roles: ['employee'], employeeId: null }]);
  assertThrows(() => callerEmployeeId(c, 'org1'), ApiError);
});

Deno.test('isHrOrSuper true for hr_admin, super_admin (global row), false for plain employee', () => {
  assertEquals(isHrOrSuper(ctx([{ organizationId: 'org1', roles: ['hr_admin'], employeeId: null }]), 'org1'), true);
  assertEquals(isHrOrSuper(ctx([{ organizationId: null, roles: ['super_admin'], employeeId: null }]), 'org1'), true);
  assertEquals(isHrOrSuper(ctx([{ organizationId: 'org1', roles: ['employee'], employeeId: 'e1' }]), 'org1'), false);
});
```

- [ ] **Step 6: Run to verify it fails**

Run: `deno test supabase/functions/_shared/scope.test.ts`
Expected: FAIL — `Module not found ... scope.ts`.

- [ ] **Step 7: Implement `scope.ts`**

`supabase/functions/_shared/scope.ts`:

```ts
import { ApiError, HandlerCtx } from './kernel.ts';

export function isHrOrSuper(ctx: HandlerCtx, orgId: string): boolean {
  return ctx.memberships.some((m) =>
    (m.organizationId === orgId && m.roles.includes('hr_admin')) ||
    (m.organizationId === null && m.roles.includes('super_admin')));
}

export function callerEmployeeId(ctx: HandlerCtx, orgId: string): string {
  const m = ctx.memberships.find((x) => x.organizationId === orgId);
  if (!m || !m.employeeId) throw new ApiError('NO_EMPLOYEE', 'This account has no employee record in this organization', 403);
  return m.employeeId;
}

// Optional employee id (null instead of throwing) — for callers who may be HR-only.
export function callerEmployeeIdOrNull(ctx: HandlerCtx, orgId: string): string | null {
  return ctx.memberships.find((x) => x.organizationId === orgId)?.employeeId ?? null;
}

async function hasRelation(
  ctx: HandlerCtx, orgId: string, targetEmployeeId: string, relTypes: string[],
): Promise<boolean> {
  const me = callerEmployeeIdOrNull(ctx, orgId);
  if (!me) return false;
  const { data, error } = await ctx.admin.from('reporting_relationships')
    .select('id').eq('organization_id', orgId).eq('employee_id', targetEmployeeId)
    .eq('related_employee_id', me).in('relation_type', relTypes).limit(1);
  if (error) { console.error('hasRelation', error); throw new ApiError('DB_ERROR', 'Database error', 500); }
  return (data ?? []).length > 0;
}

export function manages(ctx: HandlerCtx, orgId: string, targetEmployeeId: string): Promise<boolean> {
  return hasRelation(ctx, orgId, targetEmployeeId, ['manager', 'l2']);
}

export function isHodOf(ctx: HandlerCtx, orgId: string, targetEmployeeId: string): Promise<boolean> {
  return hasRelation(ctx, orgId, targetEmployeeId, ['hod']);
}
```

- [ ] **Step 8: Run scope tests to verify pass**

Run: `deno test supabase/functions/_shared/scope.test.ts`
Expected: `ok | 3 passed | 0 failed`.

- [ ] **Step 9: Write the `pms-workflow` function**

`supabase/functions/pms-workflow/index.ts`:

```ts
import { serveActions } from '../_shared/kernel.ts';

serveActions({
  'workflow.whoami': (_payload, ctx) =>
    Promise.resolve({ userId: ctx.userId, memberships: ctx.memberships }),
});
```

`supabase/functions/pms-workflow/config.toml`:

```toml
verify_jwt = true
```

- [ ] **Step 10: Deploy**

Run: `supabase functions deploy pms-workflow`
Expected: `Deployed Functions on project mkjtdwrzmobahwkpumxx: pms-workflow`.

- [ ] **Step 11: Write `workflow-check.mjs` (whoami + shared reusable helper)**

`supabase/verify/workflow-check.mjs`:

```js
// Run: node supabase/verify/seed-foundation.mjs && node supabase/verify/workflow-check.mjs
// End-to-end checks for the pms-workflow (goal-setting) actions on the live TEST project.
import assert from 'node:assert/strict';
import { adminClient, signIn, SUPABASE_URL, ANON_KEY } from './_clients.mjs';
import { USERS, PASSWORD } from './seed-foundation.mjs';

const FN_URL = `${SUPABASE_URL}/functions/v1/pms-workflow`;
const ADMIN_URL = `${SUPABASE_URL}/functions/v1/pms-admin`;

let n = 0;
export const check = (desc, cond) => { n += 1; assert.ok(cond, `FAIL: ${desc}`); console.log(`ok ${desc}`); };
export const admin = adminClient();

export async function callWorkflow(token, action, payload) {
  const res = await fetch(FN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: ANON_KEY, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ action, payload }),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}
export async function callAdmin(token, action, payload) {
  const res = await fetch(ADMIN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: ANON_KEY, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ action, payload }),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

export const tokens = {};
for (const [role, email] of Object.entries(USERS)) {
  tokens[role] = (await signIn(email, PASSWORD)).session.access_token;
}

// --- whoami sanity ---
{
  const noTok = await callWorkflow(null, 'workflow.whoami', {});
  check('workflow rejects missing token', noTok.status === 401);
  const eve = await callWorkflow(tokens.employee, 'workflow.whoami', {});
  check('workflow.whoami resolves the employee membership', eve.status === 200 && Array.isArray(eve.body.data.memberships));
}

// The end marker; later tasks append sections before this and bump the count.
console.log(`workflow-check: PASS (${n} assertions)`);
```

- [ ] **Step 12: Run the check**

Run: `node supabase/verify/seed-foundation.mjs && node supabase/verify/workflow-check.mjs`
Expected: 2 `ok` lines, `workflow-check: PASS (2 assertions)`, exit 0.

- [ ] **Step 13: Commit**

```bash
git add supabase/functions/_shared/scope.ts supabase/functions/_shared/scope.test.ts supabase/functions/_shared/phase.ts supabase/functions/_shared/phase.test.ts supabase/functions/pms-workflow/index.ts supabase/functions/pms-workflow/config.toml supabase/verify/workflow-check.mjs
git commit -m "feat(workflow): pms-workflow function + shared scope/phase helpers"
```

---

### Task 2: Active-cycle test fixture + goal plan read & seed

**Files:**
- Create: `supabase/functions/pms-workflow/goals.ts`
- Modify: `supabase/functions/pms-workflow/index.ts` (spread `goalHandlers`)
- Modify: `supabase/verify/workflow-check.mjs` (add an "active cycle fixture" + get/ensure-plan section)

**Interfaces:**
- Consumes: kernel, validators, `_shared/scope.ts`, `_shared/phase.ts`.
- Produces actions:
  - `goal.get-plan` `{orgId, cycleId, employeeId?}` → `{plan, items, competencies}` (own plan by default; a manager/HOD/HR may pass another `employeeId` in scope; else `FORBIDDEN`). Returns `{plan: null}` if no plan exists yet.
  - `goal.ensure-plan` `{orgId, cycleId}` → `{plan, items, competencies, seeded}` — idempotent: for the caller's own participant record, if no plan row exists, create a `draft` plan and seed `employee_goal_items` from the participant's assigned goal library (KRA/KPI tree) and prefill dataset rows matching the employee's code; `seeded` = count. Requires cycle active + caller is an active participant.
- Produces (fixture helper in workflow-check.mjs): `setupActiveCycle()` → builds via the admin client an org-`acme` active cycle `WF Cycle` with wide-open windows (goal_creation + manager_approval covering "today"), a `Sales` group, one goal library (1 KRA + 1 KPI), a prefill dataset (EMP002 row), participants EMP001/EMP002/EMP003 with EMP002 assigned the group+library+prefill, then flips the cycle to `active`. Returns `{ cycleId, empIds }`. (Built directly with the service-role admin client to keep the fixture self-contained and stable across runs; delete-first for idempotency.)

- [ ] **Step 1: Write the goals module (read + ensure/seed)**

`supabase/functions/pms-workflow/goals.ts`:

```ts
import { ApiError, Handler, HandlerCtx } from '../_shared/kernel.ts';
import { optUuid, reqUuid } from '../_shared/validate.ts';
import { callerEmployeeId, isHodOf, isHrOrSuper, manages } from '../_shared/scope.ts';
import { loadActiveCycle } from '../_shared/phase.ts';

async function readPlanBundle(ctx: HandlerCtx, orgId: string, cycleId: string, employeeId: string) {
  const { data: plan, error } = await ctx.admin.from('employee_goal_plans')
    .select().eq('cycle_id', cycleId).eq('employee_id', employeeId).eq('organization_id', orgId).maybeSingle();
  if (error) { console.error('readPlan', error); throw new ApiError('DB_ERROR', 'Database error', 500); }
  if (!plan) return { plan: null, items: [], competencies: [] };
  const { data: items } = await ctx.admin.from('employee_goal_items')
    .select().eq('plan_id', plan.id).order('display_order');
  const { data: comps } = await ctx.admin.from('employee_goal_plan_competencies')
    .select().eq('plan_id', plan.id).order('display_order');
  return { plan, items: items ?? [], competencies: comps ?? [] };
}

// May the caller read/act on this target employee's plan?
async function canAccessTarget(ctx: HandlerCtx, orgId: string, targetEmployeeId: string): Promise<boolean> {
  if (isHrOrSuper(ctx, orgId)) return true;
  if (callerEmployeeId(ctx, orgId) === targetEmployeeId) return true;
  if (await manages(ctx, orgId, targetEmployeeId)) return true;
  if (await isHodOf(ctx, orgId, targetEmployeeId)) return true;
  return false;
}

export const goalHandlers: Record<string, Handler> = {
  'goal.get-plan': async (payload, ctx) => {
    const orgId = reqUuid(payload.orgId, 'orgId');
    const cycleId = reqUuid(payload.cycleId, 'cycleId');
    const targetId = optUuid(payload.employeeId, 'employeeId') ?? callerEmployeeId(ctx, orgId);
    if (!(await canAccessTarget(ctx, orgId, targetId))) {
      throw new ApiError('FORBIDDEN', 'You cannot view this employee\'s goals', 403);
    }
    return await readPlanBundle(ctx, orgId, cycleId, targetId);
  },

  'goal.ensure-plan': async (payload, ctx) => {
    const orgId = reqUuid(payload.orgId, 'orgId');
    const cycleId = reqUuid(payload.cycleId, 'cycleId');
    await loadActiveCycle(ctx, orgId, cycleId);
    const employeeId = callerEmployeeId(ctx, orgId);

    const { data: participant, error: pErr } = await ctx.admin.from('cycle_participants')
      .select('id, status').eq('cycle_id', cycleId).eq('employee_id', employeeId).eq('organization_id', orgId).maybeSingle();
    if (pErr) { console.error('ensure participant', pErr); throw new ApiError('DB_ERROR', 'Database error', 500); }
    if (!participant || participant.status !== 'active') {
      throw new ApiError('NOT_A_PARTICIPANT', 'You are not an active participant in this cycle', 403);
    }

    const existing = await readPlanBundle(ctx, orgId, cycleId, employeeId);
    if (existing.plan) return { ...existing, seeded: 0 };

    // Create the draft plan.
    const { data: plan, error: planErr } = await ctx.admin.from('employee_goal_plans')
      .insert({ organization_id: orgId, cycle_id: cycleId, employee_id: employeeId, status: 'draft' })
      .select().single();
    if (planErr) {
      if (planErr.code === '23505') { // race: created concurrently
        const again = await readPlanBundle(ctx, orgId, cycleId, employeeId);
        return { ...again, seeded: 0 };
      }
      console.error('ensure plan insert', planErr);
      throw new ApiError('DB_ERROR', 'Database error', 500);
    }

    const seeded = await seedItems(ctx, orgId, cycleId, plan.id, employeeId);
    await ctx.audit({
      organizationId: orgId, cycleId, action: 'goal.ensure-plan',
      entityType: 'employee_goal_plan', entityId: plan.id, note: `seeded ${seeded} item(s)`,
    });
    const bundle = await readPlanBundle(ctx, orgId, cycleId, employeeId);
    return { ...bundle, seeded };
  },
};

// Seed goal items from the participant's assigned library (KRA/KPI tree) + prefill dataset.
// Archived libraries/datasets contribute nothing (2b-deferred rule).
async function seedItems(
  ctx: HandlerCtx, orgId: string, cycleId: string, planId: string, employeeId: string,
): Promise<number> {
  const { data: assign } = await ctx.admin.from('cycle_participant_assignments')
    .select('goal_library_id, prefill_dataset_id').eq('cycle_id', cycleId).eq('employee_id', employeeId).maybeSingle();
  if (!assign) return 0;

  let seeded = 0;

  // 1) Library KRA/KPI tree (only if the library is active).
  if (assign.goal_library_id) {
    const { data: lib } = await ctx.admin.from('goal_libraries')
      .select('id, status').eq('id', assign.goal_library_id).maybeSingle();
    if (lib && lib.status === 'active') {
      const { data: libItems } = await ctx.admin.from('goal_library_items')
        .select().eq('goal_library_id', assign.goal_library_id).order('display_order');
      const kraMap = new Map<string, string>(); // library kra id -> new goal item id
      for (const it of (libItems ?? []).filter((x) => x.item_type === 'kra')) {
        const { data: row, error } = await ctx.admin.from('employee_goal_items').insert({
          organization_id: orgId, cycle_id: cycleId, plan_id: planId, employee_id: employeeId,
          item_type: 'kra', title: it.title, description: it.description, perspective: it.perspective,
          weight: it.weight, target_type_key: it.target_type_key, target_value: it.target_value,
          source: 'library', display_order: it.display_order,
        }).select('id').single();
        if (error) { console.error('seed kra', error); throw new ApiError('DB_ERROR', 'Database error', 500); }
        kraMap.set(it.id, row.id); seeded += 1;
      }
      for (const it of (libItems ?? []).filter((x) => x.item_type === 'kpi')) {
        const parentId = it.parent_item_id ? kraMap.get(it.parent_item_id) ?? null : null;
        const { error } = await ctx.admin.from('employee_goal_items').insert({
          organization_id: orgId, cycle_id: cycleId, plan_id: planId, employee_id: employeeId,
          item_type: 'kpi', parent_item_id: parentId, title: it.title, description: it.description,
          perspective: it.perspective, weight: it.weight, target_type_key: it.target_type_key,
          target_value: it.target_value, source: 'library', display_order: it.display_order,
        });
        if (error) { console.error('seed kpi', error); throw new ApiError('DB_ERROR', 'Database error', 500); }
        seeded += 1;
      }
    }
  }

  // 2) Prefill rows for this employee's code (only if the dataset is active).
  if (assign.prefill_dataset_id) {
    const { data: ds } = await ctx.admin.from('prefill_datasets')
      .select('id, status').eq('id', assign.prefill_dataset_id).maybeSingle();
    const { data: emp } = await ctx.admin.from('employees').select('employee_code').eq('id', employeeId).single();
    if (ds && ds.status === 'active' && emp) {
      const { data: pf } = await ctx.admin.from('prefill_dataset_items')
        .select().eq('prefill_dataset_id', assign.prefill_dataset_id).eq('employee_code', emp.employee_code).order('display_order');
      for (const it of pf ?? []) {
        // Prefill rows are flat KRA(+optional KPI title) — seed the KRA; if kpi_title present, seed a child KPI.
        const { data: kraRow, error } = await ctx.admin.from('employee_goal_items').insert({
          organization_id: orgId, cycle_id: cycleId, plan_id: planId, employee_id: employeeId,
          item_type: 'kra', title: it.kra_title, perspective: it.perspective, weight: it.weight,
          target_type_key: it.target_type_key, target_value: it.target_value,
          source: 'prefill', display_order: 100 + it.display_order,
        }).select('id').single();
        if (error) { console.error('seed prefill kra', error); throw new ApiError('DB_ERROR', 'Database error', 500); }
        seeded += 1;
        if (it.kpi_title) {
          const { error: kErr } = await ctx.admin.from('employee_goal_items').insert({
            organization_id: orgId, cycle_id: cycleId, plan_id: planId, employee_id: employeeId,
            item_type: 'kpi', parent_item_id: kraRow.id, title: it.kpi_title, perspective: it.perspective,
            target_type_key: it.target_type_key, target_value: it.target_value,
            source: 'prefill', display_order: 100 + it.display_order,
          });
          if (kErr) { console.error('seed prefill kpi', kErr); throw new ApiError('DB_ERROR', 'Database error', 500); }
          seeded += 1;
        }
      }
    }
  }

  return seeded;
}
```

- [ ] **Step 2: Wire the router**

Replace `supabase/functions/pms-workflow/index.ts` with:

```ts
import { serveActions } from '../_shared/kernel.ts';
import { goalHandlers } from './goals.ts';

serveActions({
  'workflow.whoami': (_payload, ctx) =>
    Promise.resolve({ userId: ctx.userId, memberships: ctx.memberships }),
  ...goalHandlers,
});
```

- [ ] **Step 3: Deploy**

Run: `supabase functions deploy pms-workflow`
Expected: deployed.

- [ ] **Step 4: Add the active-cycle fixture + get/ensure-plan section**

In `supabase/verify/workflow-check.mjs`, add `setupActiveCycle()` above the whoami section and a new section before the final `console.log` (uses `admin`, `tokens`, `check`):

```js
// Build a self-contained ACTIVE cycle for acme with a participant (EMP002/Eve),
// an assigned library (1 KRA + 1 KPI) and a prefill row. Idempotent (delete-first).
export async function setupActiveCycle() {
  const { data: org } = await admin.from('organizations').select('id').eq('key', 'acme-test').single();
  const emp = {};
  for (const code of ['EMP001', 'EMP002', 'EMP003']) {
    const { data } = await admin.from('employees').select('id').eq('organization_id', org.id).eq('employee_code', code).single();
    emp[code] = data.id;
  }
  // Fresh cycle: archive any existing working cycle, then create ours.
  await admin.from('appraisal_cycles').update({ status: 'archived', archived_at: new Date().toISOString() })
    .eq('organization_id', org.id).neq('status', 'archived');
  const { data: cycle } = await admin.from('appraisal_cycles').insert({
    organization_id: org.id, name: 'WF Cycle', framework_id: 'kra-kpi', status: 'setup',
  }).select().single();
  const today = new Date();
  const iso = (d) => d.toISOString().slice(0, 10);
  const past = iso(new Date(today.getTime() - 5 * 864e5));
  const future = iso(new Date(today.getTime() + 30 * 864e5));
  await admin.from('cycle_phase_windows').insert([
    { organization_id: org.id, cycle_id: cycle.id, window_key: 'goal_creation', starts_on: past, ends_on: future },
    { organization_id: org.id, cycle_id: cycle.id, window_key: 'manager_approval', starts_on: past, ends_on: future },
  ]);
  const { data: group } = await admin.from('cycle_groups').insert({
    organization_id: org.id, cycle_id: cycle.id, name: 'Sales', target_level: 'kpi', rating_level: 'kpi', can_edit_own_goals: true,
  }).select().single();
  const { data: lib } = await admin.from('goal_libraries').insert({
    organization_id: org.id, name: `WF Lib ${cycle.id.slice(0, 8)}`,
  }).select().single();
  const { data: kra } = await admin.from('goal_library_items').insert({
    organization_id: org.id, goal_library_id: lib.id, item_type: 'kra', title: 'Grow Revenue', weight: 100, display_order: 0,
  }).select().single();
  await admin.from('goal_library_items').insert({
    organization_id: org.id, goal_library_id: lib.id, item_type: 'kpi', parent_item_id: kra.id, title: 'New ARR', weight: 100, display_order: 1,
  });
  const { data: pfd } = await admin.from('prefill_datasets').insert({
    organization_id: org.id, name: `WF Prefill ${cycle.id.slice(0, 8)}`,
  }).select().single();
  await admin.from('prefill_dataset_items').insert({
    organization_id: org.id, prefill_dataset_id: pfd.id, employee_code: 'EMP002',
    kra_title: 'Retention', kpi_title: 'Churn %', weight: 100, display_order: 0,
  });
  const parts = {};
  for (const code of ['EMP001', 'EMP002', 'EMP003']) {
    const { data: p } = await admin.from('cycle_participants').insert({
      organization_id: org.id, cycle_id: cycle.id, employee_id: emp[code],
    }).select().single();
    parts[code] = p.id;
  }
  await admin.from('cycle_participant_assignments').insert({
    organization_id: org.id, cycle_id: cycle.id, participant_id: parts.EMP002, employee_id: emp.EMP002,
    group_id: group.id, goal_library_id: lib.id, prefill_dataset_id: pfd.id,
  });
  await admin.from('appraisal_cycles').update({ status: 'active', activated_at: new Date().toISOString() }).eq('id', cycle.id);
  return { orgId: org.id, cycleId: cycle.id, emp, groupId: group.id };
}

export const fixture = await setupActiveCycle();

// --- goal.ensure-plan seeds from library + prefill; goal.get-plan reads it ---
{
  const ensure = await callWorkflow(tokens.employee, 'goal.ensure-plan', { orgId: fixture.orgId, cycleId: fixture.cycleId });
  check('ensure-plan creates a draft plan', ensure.status === 200 && ensure.body.data.plan.status === 'draft');
  check('ensure-plan seeds library + prefill items (2 kra + 2 kpi)', ensure.body.data.seeded === 4);

  const again = await callWorkflow(tokens.employee, 'goal.ensure-plan', { orgId: fixture.orgId, cycleId: fixture.cycleId });
  check('ensure-plan is idempotent (seeded 0 on second call)', again.status === 200 && again.body.data.seeded === 0);

  const get = await callWorkflow(tokens.employee, 'goal.get-plan', { orgId: fixture.orgId, cycleId: fixture.cycleId });
  check('get-plan returns the seeded items', get.status === 200 && get.body.data.items.length === 4);

  const mgrView = await callWorkflow(tokens.manager, 'goal.get-plan', { orgId: fixture.orgId, cycleId: fixture.cycleId, employeeId: fixture.emp.EMP002 });
  check('manager can view a direct report plan', mgrView.status === 200 && mgrView.body.data.plan !== null);

  const hodView = await callWorkflow(tokens.hod, 'goal.get-plan', { orgId: fixture.orgId, cycleId: fixture.cycleId, employeeId: fixture.emp.EMP002 });
  check('HOD can view a mapped employee plan', hodView.status === 200);

  // A non-manager peer cannot view someone else's plan. EMP003 (Harry) is EMP002's HOD, so use EMP001 viewing EMP003.
  const denied = await callWorkflow(tokens.employee, 'goal.get-plan', { orgId: fixture.orgId, cycleId: fixture.cycleId, employeeId: fixture.emp.EMP001 });
  check('employee cannot view another employee plan', denied.status === 403);
}
```

- [ ] **Step 5: Run the check**

Run: `node supabase/verify/seed-foundation.mjs && node supabase/verify/workflow-check.mjs`
Expected: `workflow-check: PASS (9 assertions)` (2 + 7), exit 0. (Trust the printed `n`; if it differs, recount the `check()` calls you added.)

- [ ] **Step 6: Commit**

```bash
git add supabase/functions/pms-workflow/goals.ts supabase/functions/pms-workflow/index.ts supabase/verify/workflow-check.mjs
git commit -m "feat(workflow): goal plan read + idempotent seed from library/prefill"
```

---

### Task 3: Employee goal editing with rule validation

**Files:**
- Create: `supabase/functions/pms-workflow/goalrules.ts`
- Create: `supabase/functions/pms-workflow/goalrules.test.ts`
- Modify: `supabase/functions/pms-workflow/goals.ts` (add `goal.save-items`)
- Modify: `supabase/verify/workflow-check.mjs` (add editing section)

**Interfaces:**
- Consumes: kernel, validators, scope, phase.
- Produces:
  - `validateGoalTree(items, rules) → void` (pure; throws `ApiError('GOAL_RULES', <message>, 422)` on violation). `items` = normalized array of `{ key, itemType, parentKey, title, weight, ... }`; `rules` = the merged `cycle_goal_rules` row (group rule over cycle-default). Checks: KRA count ∈ [min_kras, max_kras]; each KRA's KPI count ∈ [min_kpis_per_kra, max_kpis_per_kra]; each KRA weight ∈ [min_kra_weight, max_kra_weight] when set; KRA weights sum to 100 (±0.01); KPI weights within a KRA sum to 100 (±0.01) when any KPI weight is set; each KPI weight ≥ min_kpi_weight when set.
  - Action `goal.save-items` `{orgId, cycleId, planVersion, items}` → `{plan, items}` — replaces the caller's plan items with a validated tree; only when the plan status ∈ `draft`/`sent_back`/`reopened`, the `goal_creation` window is open (or HR), and the group has `can_edit_own_goals` (else `EDIT_NOT_ALLOWED` 403). Version-checked on the plan (bumps it via `versionedUpdate`).

- [ ] **Step 1: Write failing rule tests**

`supabase/functions/pms-workflow/goalrules.test.ts`:

```ts
import { assertThrows } from 'jsr:@std/assert@1';
import { ApiError } from '../_shared/kernel.ts';
import { validateGoalTree } from './goalrules.ts';

const rules = {
  min_kras: 1, max_kras: 3, min_kpis_per_kra: 1, max_kpis_per_kra: 3,
  min_kra_weight: null, max_kra_weight: null, min_kpi_weight: null,
};
const kra = (key: string, weight: number) => ({ key, itemType: 'kra', parentKey: null, weight });
const kpi = (key: string, parentKey: string, weight: number) => ({ key, itemType: 'kpi', parentKey, weight });

Deno.test('a valid tree passes', () => {
  validateGoalTree([kra('a', 100), kpi('a1', 'a', 100)], rules); // no throw
});

Deno.test('too few KRAs fails', () => {
  assertThrows(() => validateGoalTree([], rules), ApiError);
});

Deno.test('too many KRAs fails', () => {
  assertThrows(() => validateGoalTree([kra('a', 25), kra('b', 25), kra('c', 25), kra('d', 25)]
    .flatMap((k) => [k, kpi(`${k.key}1`, k.key, 100)]), rules), ApiError);
});

Deno.test('KRA weights not summing to 100 fails', () => {
  assertThrows(() => validateGoalTree([kra('a', 60), kpi('a1', 'a', 100)], rules), ApiError);
});

Deno.test('KPI weights within a KRA not summing to 100 fails', () => {
  assertThrows(() => validateGoalTree([kra('a', 100), kpi('a1', 'a', 60), kpi('a2', 'a', 30)], rules), ApiError);
});

Deno.test('a KRA with no KPIs fails min_kpis_per_kra', () => {
  assertThrows(() => validateGoalTree([kra('a', 100)], rules), ApiError);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `deno test supabase/functions/pms-workflow/goalrules.test.ts`
Expected: FAIL — `Module not found ... goalrules.ts`.

- [ ] **Step 3: Implement `goalrules.ts`**

`supabase/functions/pms-workflow/goalrules.ts`:

```ts
import { ApiError } from '../_shared/kernel.ts';

export type GoalNode = {
  key: string; itemType: string; parentKey: string | null; weight: number | null;
};
export type GoalRules = {
  min_kras: number | null; max_kras: number | null;
  min_kpis_per_kra: number | null; max_kpis_per_kra: number | null;
  min_kra_weight: number | null; max_kra_weight: number | null; min_kpi_weight: number | null;
};

const EPS = 0.01;
function bad(msg: string): never { throw new ApiError('GOAL_RULES', msg, 422); }
function sum(ns: number[]): number { return ns.reduce((a, b) => a + b, 0); }

export function validateGoalTree(items: GoalNode[], rules: GoalRules): void {
  const kras = items.filter((i) => i.itemType === 'kra');
  const kpis = items.filter((i) => i.itemType === 'kpi');

  if (rules.min_kras != null && kras.length < rules.min_kras) bad(`At least ${rules.min_kras} KRA(s) required`);
  if (rules.max_kras != null && kras.length > rules.max_kras) bad(`At most ${rules.max_kras} KRA(s) allowed`);

  const kraKeys = new Set(kras.map((k) => k.key));
  for (const kpi of kpis) {
    if (!kpi.parentKey || !kraKeys.has(kpi.parentKey)) bad(`KPI "${kpi.key}" must belong to a KRA in this plan`);
  }

  for (const kra of kras) {
    const children = kpis.filter((k) => k.parentKey === kra.key);
    if (rules.min_kpis_per_kra != null && children.length < rules.min_kpis_per_kra) {
      bad(`KRA "${kra.key}" needs at least ${rules.min_kpis_per_kra} KPI(s)`);
    }
    if (rules.max_kpis_per_kra != null && children.length > rules.max_kpis_per_kra) {
      bad(`KRA "${kra.key}" allows at most ${rules.max_kpis_per_kra} KPI(s)`);
    }
    if (rules.min_kra_weight != null && kra.weight != null && kra.weight < rules.min_kra_weight) {
      bad(`KRA "${kra.key}" weight is below the minimum ${rules.min_kra_weight}`);
    }
    if (rules.max_kra_weight != null && kra.weight != null && kra.weight > rules.max_kra_weight) {
      bad(`KRA "${kra.key}" weight is above the maximum ${rules.max_kra_weight}`);
    }
    const childWeights = children.map((c) => c.weight).filter((w): w is number => w != null);
    if (childWeights.length > 0) {
      if (rules.min_kpi_weight != null && childWeights.some((w) => w < rules.min_kpi_weight!)) {
        bad(`A KPI under "${kra.key}" is below the minimum weight ${rules.min_kpi_weight}`);
      }
      if (Math.abs(sum(childWeights) - 100) > EPS) bad(`KPI weights under "${kra.key}" must sum to 100`);
    }
  }

  const kraWeights = kras.map((k) => k.weight).filter((w): w is number => w != null);
  if (kraWeights.length > 0 && Math.abs(sum(kraWeights) - 100) > EPS) {
    bad('KRA weights must sum to 100');
  }
}
```

- [ ] **Step 4: Run rule tests to verify pass**

Run: `deno test supabase/functions/pms-workflow/goalrules.test.ts`
Expected: `ok | 6 passed | 0 failed`.

- [ ] **Step 5: Add `goal.save-items` to `goals.ts`**

Add these imports at the top of `supabase/functions/pms-workflow/goals.ts`:

```ts
import { optNumber, optString, reqArray, reqEnum, reqInt, reqObject, reqString } from '../_shared/validate.ts';
import { requireWindowOrHr } from '../_shared/phase.ts';
import { GoalNode, GoalRules, validateGoalTree } from './goalrules.ts';
```

Add a shared loader for the caller's editable plan + the merged goal rules (place above `goalHandlers`):

```ts
const EDITABLE_PLAN = ['draft', 'sent_back', 'reopened'];

async function mergedGoalRules(ctx: HandlerCtx, cycleId: string, groupId: string | null): Promise<GoalRules> {
  const { data } = await ctx.admin.from('cycle_goal_rules')
    .select().eq('cycle_id', cycleId);
  const rows = data ?? [];
  const groupRule = groupId ? rows.find((r) => r.group_id === groupId) : null;
  const defaultRule = rows.find((r) => r.group_id === null);
  return (groupRule ?? defaultRule ?? {
    min_kras: null, max_kras: null, min_kpis_per_kra: null, max_kpis_per_kra: null,
    min_kra_weight: null, max_kra_weight: null, min_kpi_weight: null,
  }) as GoalRules;
}

async function participantGroupId(ctx: HandlerCtx, cycleId: string, employeeId: string): Promise<string | null> {
  const { data } = await ctx.admin.from('cycle_participant_assignments')
    .select('group_id').eq('cycle_id', cycleId).eq('employee_id', employeeId).maybeSingle();
  return data?.group_id ?? null;
}
```

Add the handler inside `goalHandlers`:

```ts
  'goal.save-items': async (payload, ctx) => {
    const orgId = reqUuid(payload.orgId, 'orgId');
    const cycleId = reqUuid(payload.cycleId, 'cycleId');
    const planVersion = reqInt(payload.planVersion, 'planVersion');
    await loadActiveCycle(ctx, orgId, cycleId);
    const employeeId = callerEmployeeId(ctx, orgId);
    await requireWindowOrHr(ctx, orgId, cycleId, 'goal_creation');

    const { data: plan, error: pErr } = await ctx.admin.from('employee_goal_plans')
      .select().eq('cycle_id', cycleId).eq('employee_id', employeeId).eq('organization_id', orgId).maybeSingle();
    if (pErr) { console.error('save-items plan', pErr); throw new ApiError('DB_ERROR', 'Database error', 500); }
    if (!plan) throw new ApiError('NOT_FOUND', 'No goal plan — call ensure-plan first', 404);
    if (!EDITABLE_PLAN.includes(plan.status)) throw new ApiError('PLAN_LOCKED', `Goals can't be edited once the plan is ${plan.status}`, 409);

    // The group must permit self-editing (unless HR is acting).
    const groupId = await participantGroupId(ctx, cycleId, employeeId);
    if (!isHrOrSuper(ctx, orgId) && groupId) {
      const { data: group } = await ctx.admin.from('cycle_groups').select('can_edit_own_goals').eq('id', groupId).maybeSingle();
      if (group && group.can_edit_own_goals === false) throw new ApiError('EDIT_NOT_ALLOWED', 'Your group does not allow editing goals', 403);
    }

    // Parse + validate the incoming tree (payload keys are caller-local).
    const rawItems = reqArray(payload.items, 'items', 200).map((r, i) => {
      const o = reqObject(r, `items[${i}]`);
      return {
        key: reqString(o.key, `items[${i}].key`, 120),
        itemType: reqEnum(o.itemType, `items[${i}].itemType`, ['kra', 'kpi']),
        parentKey: optString(o.parentKey, `items[${i}].parentKey`, 120),
        title: reqString(o.title, `items[${i}].title`, 300),
        description: optString(o.description, `items[${i}].description`, 2000),
        perspective: optString(o.perspective, `items[${i}].perspective`, 120),
        weight: optNumber(o.weight, `items[${i}].weight`),
        target_type_key: optString(o.targetTypeKey, `items[${i}].targetTypeKey`, 60),
        target_value: optString(o.targetValue, `items[${i}].targetValue`, 200),
        display_order: reqInt(o.displayOrder ?? i, `items[${i}].displayOrder`),
      };
    });
    const keys = rawItems.map((r) => r.key);
    if (new Set(keys).size !== keys.length) throw new ApiError('BAD_REQUEST', 'items contain duplicate keys', 400);
    const rules = await mergedGoalRules(ctx, cycleId, groupId);
    validateGoalTree(rawItems as GoalNode[], rules);

    // Claim the version token first (so a stale editor is rejected before we rewrite rows).
    const freshPlan = await ctx.versionedUpdate('employee_goal_plans', orgId, plan.id, planVersion, { status: plan.status });

    // Full replace: delete then two-pass insert (KRAs first to resolve KPI parentKey).
    await ctx.admin.from('employee_goal_items').delete().eq('plan_id', plan.id).eq('organization_id', orgId);
    const keyToId = new Map<string, string>();
    for (const it of rawItems.filter((r) => r.itemType === 'kra')) {
      const { data: row, error } = await ctx.admin.from('employee_goal_items').insert({
        organization_id: orgId, cycle_id: cycleId, plan_id: plan.id, employee_id: employeeId,
        item_type: 'kra', title: it.title, description: it.description, perspective: it.perspective,
        weight: it.weight, target_type_key: it.target_type_key, target_value: it.target_value,
        source: 'employee', display_order: it.display_order,
      }).select('id').single();
      if (error) { console.error('save kra', error); throw new ApiError('DB_ERROR', 'Database error', 500); }
      keyToId.set(it.key, row.id);
    }
    for (const it of rawItems.filter((r) => r.itemType === 'kpi')) {
      const parentId = it.parentKey ? keyToId.get(it.parentKey) ?? null : null;
      const { error } = await ctx.admin.from('employee_goal_items').insert({
        organization_id: orgId, cycle_id: cycleId, plan_id: plan.id, employee_id: employeeId,
        item_type: 'kpi', parent_item_id: parentId, title: it.title, description: it.description,
        perspective: it.perspective, weight: it.weight, target_type_key: it.target_type_key,
        target_value: it.target_value, source: 'employee', display_order: it.display_order,
      });
      if (error) { console.error('save kpi', error); throw new ApiError('DB_ERROR', 'Database error', 500); }
    }
    await ctx.audit({
      organizationId: orgId, cycleId, action: 'goal.save-items',
      entityType: 'employee_goal_plan', entityId: plan.id, note: `${rawItems.length} item(s)`,
    });
    const { data: items } = await ctx.admin.from('employee_goal_items').select().eq('plan_id', plan.id).order('display_order');
    return { plan: freshPlan, items: items ?? [] };
  },
```

- [ ] **Step 6: Deploy**

Run: `supabase functions deploy pms-workflow`
Expected: deployed.

- [ ] **Step 7: Add the editing section to `workflow-check.mjs`**

Before the final `console.log`, append:

```js
// --- goal.save-items: validates rules, replaces the tree ---
{
  const get = await callWorkflow(tokens.employee, 'goal.get-plan', { orgId: fixture.orgId, cycleId: fixture.cycleId });
  const v = get.body.data.plan.version;
  // A valid replacement: 2 KRAs (60/40) each with 1 KPI (100).
  const goodItems = [
    { key: 'k1', itemType: 'kra', title: 'Revenue', weight: 60, displayOrder: 0 },
    { key: 'k1a', itemType: 'kpi', parentKey: 'k1', title: 'New ARR', weight: 100, displayOrder: 1 },
    { key: 'k2', itemType: 'kra', title: 'Retention', weight: 40, displayOrder: 2 },
    { key: 'k2a', itemType: 'kpi', parentKey: 'k2', title: 'Churn', weight: 100, displayOrder: 3 },
  ];
  const save = await callWorkflow(tokens.employee, 'goal.save-items', { orgId: fixture.orgId, cycleId: fixture.cycleId, planVersion: v, items: goodItems });
  check('save-items replaces the goal tree', save.status === 200 && save.body.data.items.length === 4);

  const badWeights = await callWorkflow(tokens.employee, 'goal.save-items', {
    orgId: fixture.orgId, cycleId: fixture.cycleId, planVersion: save.body.data.plan.version,
    items: [{ key: 'k1', itemType: 'kra', title: 'X', weight: 50, displayOrder: 0 }, { key: 'k1a', itemType: 'kpi', parentKey: 'k1', title: 'Y', weight: 100, displayOrder: 1 }],
  });
  check('save-items rejects KRA weights not summing to 100', badWeights.status === 422 && badWeights.body.error.code === 'GOAL_RULES');

  const stale = await callWorkflow(tokens.employee, 'goal.save-items', { orgId: fixture.orgId, cycleId: fixture.cycleId, planVersion: 1, items: goodItems });
  check('save-items rejects a stale plan version', stale.status === 409 && stale.body.error.code === 'CONFLICT');

  const notMine = await callWorkflow(tokens.manager, 'goal.save-items', { orgId: fixture.orgId, cycleId: fixture.cycleId, planVersion: 1, items: goodItems });
  check('a manager cannot edit as if it were their own missing plan', notMine.status === 404 || notMine.status === 409);
}
```

- [ ] **Step 8: Run the check**

Run: `node supabase/verify/seed-foundation.mjs && node supabase/verify/workflow-check.mjs`
Expected: `workflow-check: PASS (13 assertions)` (9 + 4), exit 0.

- [ ] **Step 9: Commit**

```bash
git add supabase/functions/pms-workflow/goalrules.ts supabase/functions/pms-workflow/goalrules.test.ts supabase/functions/pms-workflow/goals.ts supabase/verify/workflow-check.mjs
git commit -m "feat(workflow): employee goal editing with rule validation"
```

---

### Task 4: Submit / approve / send-back / reopen

**Files:**
- Create: `supabase/functions/pms-workflow/goalflow.ts`
- Modify: `supabase/functions/pms-workflow/index.ts` (spread `goalFlowHandlers`)
- Modify: `supabase/verify/workflow-check.mjs` (add the workflow-transition section)

**Interfaces:**
- Consumes: kernel, validators, scope, phase, `goalrules.ts`.
- Produces actions (each version-checked on the plan, each appends a `goal_workflow_events` row, each audited):
  - `goal.submit` `{orgId, cycleId, planVersion}` → `{plan}` — caller's own plan `draft`/`sent_back`/`reopened` → `submitted` (sets `submitted_at`); requires `goal_creation` window (or HR); re-validates the saved tree against the rules and refuses an empty plan.
  - `goal.approve` `{orgId, cycleId, employeeId, planVersion}` → `{plan}` — a manager of `employeeId` moves `submitted` → `approved` (sets `approved_at`); requires `manager_approval` window (or HR).
  - `goal.send-back` `{orgId, cycleId, employeeId, planVersion, note}` → `{plan}` — a manager moves `submitted` → `sent_back` with a required `note`; requires `manager_approval` window (or HR).
  - `goal.reopen` `{orgId, cycleId, employeeId, planVersion, note?}` → `{plan}` — HR/super only moves `approved` → `reopened`.

- [ ] **Step 1: Write the goalflow module**

`supabase/functions/pms-workflow/goalflow.ts`:

```ts
import { ApiError, Handler, HandlerCtx } from '../_shared/kernel.ts';
import { optString, reqInt, reqString, reqUuid } from '../_shared/validate.ts';
import { callerEmployeeId, isHrOrSuper, manages } from '../_shared/scope.ts';
import { loadActiveCycle, requireWindowOrHr } from '../_shared/phase.ts';
import { GoalNode, validateGoalTree } from './goalrules.ts';

async function loadPlanById(ctx: HandlerCtx, orgId: string, cycleId: string, employeeId: string) {
  const { data: plan, error } = await ctx.admin.from('employee_goal_plans')
    .select().eq('cycle_id', cycleId).eq('employee_id', employeeId).eq('organization_id', orgId).maybeSingle();
  if (error) { console.error('loadPlan', error); throw new ApiError('DB_ERROR', 'Database error', 500); }
  if (!plan) throw new ApiError('NOT_FOUND', 'Goal plan not found', 404);
  return plan;
}

async function appendEvent(ctx: HandlerCtx, orgId: string, cycleId: string, planId: string, employeeId: string, eventType: string, note: string | null) {
  const { error } = await ctx.admin.from('goal_workflow_events').insert({
    organization_id: orgId, cycle_id: cycleId, plan_id: planId, employee_id: employeeId,
    event_type: eventType, actor_user_id: ctx.userId, note,
  });
  if (error) { console.error('appendEvent', error); throw new ApiError('DB_ERROR', 'Database error', 500); }
}

// The merged-rules loader + node shape are duplicated minimally here to keep goalflow self-contained.
async function mergedRules(ctx: HandlerCtx, cycleId: string, employeeId: string) {
  const { data: assign } = await ctx.admin.from('cycle_participant_assignments')
    .select('group_id').eq('cycle_id', cycleId).eq('employee_id', employeeId).maybeSingle();
  const groupId = assign?.group_id ?? null;
  const { data } = await ctx.admin.from('cycle_goal_rules').select().eq('cycle_id', cycleId);
  const rows = data ?? [];
  return (rows.find((r) => groupId && r.group_id === groupId) ?? rows.find((r) => r.group_id === null) ?? {
    min_kras: null, max_kras: null, min_kpis_per_kra: null, max_kpis_per_kra: null,
    min_kra_weight: null, max_kra_weight: null, min_kpi_weight: null,
  });
}

export const goalFlowHandlers: Record<string, Handler> = {
  'goal.submit': async (payload, ctx) => {
    const orgId = reqUuid(payload.orgId, 'orgId');
    const cycleId = reqUuid(payload.cycleId, 'cycleId');
    const planVersion = reqInt(payload.planVersion, 'planVersion');
    await loadActiveCycle(ctx, orgId, cycleId);
    const employeeId = callerEmployeeId(ctx, orgId);
    await requireWindowOrHr(ctx, orgId, cycleId, 'goal_creation');
    const plan = await loadPlanById(ctx, orgId, cycleId, employeeId);
    if (!['draft', 'sent_back', 'reopened'].includes(plan.status)) {
      throw new ApiError('PLAN_LOCKED', `A ${plan.status} plan cannot be submitted`, 409);
    }
    // Re-validate the saved tree at submit time.
    const { data: items } = await ctx.admin.from('employee_goal_items').select('id, item_type, parent_item_id, weight').eq('plan_id', plan.id);
    if (!items || items.length === 0) throw new ApiError('GOAL_RULES', 'Add at least one goal before submitting', 422);
    const nodes: GoalNode[] = items.map((it) => ({
      key: it.id, itemType: it.item_type, parentKey: it.parent_item_id, weight: it.weight,
    }));
    validateGoalTree(nodes, await mergedRules(ctx, cycleId, employeeId) as any);
    const fresh = await ctx.versionedUpdate('employee_goal_plans', orgId, plan.id, planVersion, {
      status: 'submitted', submitted_at: new Date().toISOString(),
    });
    await appendEvent(ctx, orgId, cycleId, plan.id, employeeId, 'submitted', null);
    await ctx.audit({ organizationId: orgId, cycleId, action: 'goal.submit', entityType: 'employee_goal_plan', entityId: plan.id, before: { status: plan.status }, after: { status: 'submitted' } });
    return { plan: fresh };
  },

  'goal.approve': async (payload, ctx) => {
    const orgId = reqUuid(payload.orgId, 'orgId');
    const cycleId = reqUuid(payload.cycleId, 'cycleId');
    const employeeId = reqUuid(payload.employeeId, 'employeeId');
    const planVersion = reqInt(payload.planVersion, 'planVersion');
    await loadActiveCycle(ctx, orgId, cycleId);
    if (!isHrOrSuper(ctx, orgId) && !(await manages(ctx, orgId, employeeId))) {
      throw new ApiError('FORBIDDEN', 'Only the manager can approve this plan', 403);
    }
    await requireWindowOrHr(ctx, orgId, cycleId, 'manager_approval');
    const plan = await loadPlanById(ctx, orgId, cycleId, employeeId);
    if (plan.status !== 'submitted') throw new ApiError('PLAN_STATE', `Only a submitted plan can be approved (this is ${plan.status})`, 409);
    const fresh = await ctx.versionedUpdate('employee_goal_plans', orgId, plan.id, planVersion, {
      status: 'approved', approved_at: new Date().toISOString(),
    });
    await appendEvent(ctx, orgId, cycleId, plan.id, employeeId, 'approved', null);
    await ctx.audit({ organizationId: orgId, cycleId, action: 'goal.approve', entityType: 'employee_goal_plan', entityId: plan.id, before: { status: 'submitted' }, after: { status: 'approved' } });
    return { plan: fresh };
  },

  'goal.send-back': async (payload, ctx) => {
    const orgId = reqUuid(payload.orgId, 'orgId');
    const cycleId = reqUuid(payload.cycleId, 'cycleId');
    const employeeId = reqUuid(payload.employeeId, 'employeeId');
    const planVersion = reqInt(payload.planVersion, 'planVersion');
    const note = reqString(payload.note, 'note', 2000);
    await loadActiveCycle(ctx, orgId, cycleId);
    if (!isHrOrSuper(ctx, orgId) && !(await manages(ctx, orgId, employeeId))) {
      throw new ApiError('FORBIDDEN', 'Only the manager can send back this plan', 403);
    }
    await requireWindowOrHr(ctx, orgId, cycleId, 'manager_approval');
    const plan = await loadPlanById(ctx, orgId, cycleId, employeeId);
    if (plan.status !== 'submitted') throw new ApiError('PLAN_STATE', `Only a submitted plan can be sent back (this is ${plan.status})`, 409);
    const fresh = await ctx.versionedUpdate('employee_goal_plans', orgId, plan.id, planVersion, { status: 'sent_back' });
    await appendEvent(ctx, orgId, cycleId, plan.id, employeeId, 'sent_back', note);
    await ctx.audit({ organizationId: orgId, cycleId, action: 'goal.send-back', entityType: 'employee_goal_plan', entityId: plan.id, before: { status: 'submitted' }, after: { status: 'sent_back' }, note });
    return { plan: fresh };
  },

  'goal.reopen': async (payload, ctx) => {
    const orgId = reqUuid(payload.orgId, 'orgId');
    const cycleId = reqUuid(payload.cycleId, 'cycleId');
    const employeeId = reqUuid(payload.employeeId, 'employeeId');
    const planVersion = reqInt(payload.planVersion, 'planVersion');
    const note = optString(payload.note, 'note', 2000);
    await loadActiveCycle(ctx, orgId, cycleId);
    if (!isHrOrSuper(ctx, orgId)) throw new ApiError('FORBIDDEN', 'Only HR can reopen an approved plan', 403);
    const plan = await loadPlanById(ctx, orgId, cycleId, employeeId);
    if (plan.status !== 'approved') throw new ApiError('PLAN_STATE', `Only an approved plan can be reopened (this is ${plan.status})`, 409);
    const fresh = await ctx.versionedUpdate('employee_goal_plans', orgId, plan.id, planVersion, { status: 'reopened' });
    await appendEvent(ctx, orgId, cycleId, plan.id, employeeId, 'reopened', note);
    await ctx.audit({ organizationId: orgId, cycleId, action: 'goal.reopen', entityType: 'employee_goal_plan', entityId: plan.id, before: { status: 'approved' }, after: { status: 'reopened' }, note });
    return { plan: fresh };
  },
};
```

- [ ] **Step 2: Wire the router**

Replace `supabase/functions/pms-workflow/index.ts` with:

```ts
import { serveActions } from '../_shared/kernel.ts';
import { goalHandlers } from './goals.ts';
import { goalFlowHandlers } from './goalflow.ts';

serveActions({
  'workflow.whoami': (_payload, ctx) =>
    Promise.resolve({ userId: ctx.userId, memberships: ctx.memberships }),
  ...goalHandlers,
  ...goalFlowHandlers,
});
```

- [ ] **Step 3: Deploy**

Run: `supabase functions deploy pms-workflow`
Expected: deployed.

- [ ] **Step 4: Add the workflow-transition section**

Before the final `console.log` in `workflow-check.mjs`, append:

```js
// --- submit → send-back → resubmit → approve → reopen ---
{
  const get = await callWorkflow(tokens.employee, 'goal.get-plan', { orgId: fixture.orgId, cycleId: fixture.cycleId });
  let v = get.body.data.plan.version;

  const submit = await callWorkflow(tokens.employee, 'goal.submit', { orgId: fixture.orgId, cycleId: fixture.cycleId, planVersion: v });
  check('employee submits the plan', submit.status === 200 && submit.body.data.plan.status === 'submitted');
  v = submit.body.data.plan.version;

  const empApprove = await callWorkflow(tokens.employee, 'goal.approve', { orgId: fixture.orgId, cycleId: fixture.cycleId, employeeId: fixture.emp.EMP002, planVersion: v });
  check('employee cannot approve their own plan', empApprove.status === 403);

  const sendBack = await callWorkflow(tokens.manager, 'goal.send-back', { orgId: fixture.orgId, cycleId: fixture.cycleId, employeeId: fixture.emp.EMP002, planVersion: v, note: 'Tighten the churn target' });
  check('manager sends the plan back with a note', sendBack.status === 200 && sendBack.body.data.plan.status === 'sent_back');
  v = sendBack.body.data.plan.version;

  const resubmit = await callWorkflow(tokens.employee, 'goal.submit', { orgId: fixture.orgId, cycleId: fixture.cycleId, planVersion: v });
  check('employee resubmits after send-back', resubmit.status === 200 && resubmit.body.data.plan.status === 'submitted');
  v = resubmit.body.data.plan.version;

  const approve = await callWorkflow(tokens.manager, 'goal.approve', { orgId: fixture.orgId, cycleId: fixture.cycleId, employeeId: fixture.emp.EMP002, planVersion: v });
  check('manager approves the plan', approve.status === 200 && approve.body.data.plan.status === 'approved');
  v = approve.body.data.plan.version;

  const mgrReopen = await callWorkflow(tokens.manager, 'goal.reopen', { orgId: fixture.orgId, cycleId: fixture.cycleId, employeeId: fixture.emp.EMP002, planVersion: v });
  check('manager cannot reopen (HR only)', mgrReopen.status === 403);

  const reopen = await callWorkflow(tokens.hr, 'goal.reopen', { orgId: fixture.orgId, cycleId: fixture.cycleId, employeeId: fixture.emp.EMP002, planVersion: v });
  check('HR reopens the approved plan', reopen.status === 200 && reopen.body.data.plan.status === 'reopened');

  const { data: events } = await admin.from('goal_workflow_events').select('event_type').eq('cycle_id', fixture.cycleId).eq('employee_id', fixture.emp.EMP002);
  check('workflow events recorded (submitted/sent_back/submitted/approved/reopened)', (events ?? []).length >= 5);
}
```

- [ ] **Step 5: Run the check**

Run: `node supabase/verify/seed-foundation.mjs && node supabase/verify/workflow-check.mjs`
Expected: `workflow-check: PASS (21 assertions)` (13 + 8), exit 0.

- [ ] **Step 6: Commit**

```bash
git add supabase/functions/pms-workflow/goalflow.ts supabase/functions/pms-workflow/index.ts supabase/verify/workflow-check.mjs
git commit -m "feat(workflow): goal submit/approve/send-back/reopen transitions"
```

---

### Task 5: Phase-gating checks + smoke-gate wiring

**Files:**
- Modify: `supabase/verify/workflow-check.mjs` (add a closed-window section)
- Modify: `supabase/verify/run-all.mjs` (append `workflow-check.mjs` after `admin-check.mjs`)

**Interfaces:**
- Consumes: everything above.
- Produces: `workflow-check: PASS (24 assertions)`; full gate `node supabase/verify/run-all.mjs` → `FOUNDATION SMOKE: ALL PASS`.

- [ ] **Step 1: Add a closed-window section**

Before the final `console.log` in `workflow-check.mjs`, append (this builds a SECOND active cycle whose goal-creation window is in the past, to prove the gate):

```js
// --- phase gating: goal edits refused when the goal_creation window is closed ---
{
  const iso = (d) => d.toISOString().slice(0, 10);
  const now = new Date();
  const longAgoStart = iso(new Date(now.getTime() - 60 * 864e5));
  const longAgoEnd = iso(new Date(now.getTime() - 30 * 864e5));
  // Archive the WF cycle and stand up a closed-window cycle with EMP002 as participant.
  await admin.from('appraisal_cycles').update({ status: 'archived', archived_at: new Date().toISOString() })
    .eq('organization_id', fixture.orgId).neq('status', 'archived');
  const { data: c2 } = await admin.from('appraisal_cycles').insert({
    organization_id: fixture.orgId, name: 'WF Closed', framework_id: 'kra', status: 'setup',
  }).select().single();
  await admin.from('cycle_phase_windows').insert([
    { organization_id: fixture.orgId, cycle_id: c2.id, window_key: 'goal_creation', starts_on: longAgoStart, ends_on: longAgoEnd },
  ]);
  const { data: p2 } = await admin.from('cycle_participants').insert({
    organization_id: fixture.orgId, cycle_id: c2.id, employee_id: fixture.emp.EMP002,
  }).select().single();
  await admin.from('cycle_participant_assignments').insert({
    organization_id: fixture.orgId, cycle_id: c2.id, participant_id: p2.id, employee_id: fixture.emp.EMP002,
  });
  await admin.from('appraisal_cycles').update({ status: 'active', activated_at: new Date().toISOString() }).eq('id', c2.id);

  const ensure = await callWorkflow(tokens.employee, 'goal.ensure-plan', { orgId: fixture.orgId, cycleId: c2.id });
  check('ensure-plan works regardless of window', ensure.status === 200);
  const v = ensure.body.data.plan.version;
  const saveClosed = await callWorkflow(tokens.employee, 'goal.save-items', {
    orgId: fixture.orgId, cycleId: c2.id, planVersion: v,
    items: [{ key: 'k1', itemType: 'kra', title: 'X', weight: 100, displayOrder: 0 }, { key: 'k1a', itemType: 'kpi', parentKey: 'k1', title: 'Y', weight: 100, displayOrder: 1 }],
  });
  check('employee edit refused when goal_creation window closed', saveClosed.status === 409 && saveClosed.body.error.code === 'WINDOW_CLOSED');

  const hrSaveClosed = await callWorkflow(tokens.hr, 'goal.save-items', {
    orgId: fixture.orgId, cycleId: c2.id, planVersion: v,
    items: [{ key: 'k1', itemType: 'kra', title: 'X', weight: 100, displayOrder: 0 }, { key: 'k1a', itemType: 'kpi', parentKey: 'k1', title: 'Y', weight: 100, displayOrder: 1 }],
  });
  // HR has no employee row in acme, so save-items (which acts on the caller's own plan) is NO_EMPLOYEE, proving HR-bypass is about the window, not identity.
  check('HR save-items on own-plan path needs an employee row', hrSaveClosed.status === 403 && hrSaveClosed.body.error.code === 'NO_EMPLOYEE');
}
```

- [ ] **Step 2: Wire the smoke gate**

In `supabase/verify/run-all.mjs`, change the `scripts` array to end with the workflow check:

```js
const scripts = [
  'supabase/verify/check-tables.mjs',
  'supabase/verify/seed-foundation.mjs',
  'supabase/verify/rls-check.mjs',
  'supabase/verify/kernel-check.mjs',
  'supabase/verify/admin-check.mjs',
  'supabase/verify/workflow-check.mjs',
];
```

- [ ] **Step 3: Run the full gate**

Run: `node supabase/verify/run-all.mjs`
Expected: all six scripts pass — `admin-check: PASS (86 assertions)`, `workflow-check: PASS (24 assertions)` — final `FOUNDATION SMOKE: ALL PASS`, exit 0. (Run in background if it exceeds the 2-minute foreground limit.)

- [ ] **Step 4: Run lint**

Run: `npm run lint`
Expected: no NEW problems under `supabase/**` (pre-existing `src/` findings out of scope — note, don't fix).

- [ ] **Step 5: Commit**

```bash
git add supabase/verify/workflow-check.mjs supabase/verify/run-all.mjs
git commit -m "test(workflow): phase-gating checks + smoke-gate wiring"
```

---

## Out of Scope (Plan 3b — next)

- Self / manager / HOD / HR-final evaluations (`evaluations`, `evaluation_goal_scores`, `evaluation_competency_scores`), the scoring engine (achievement %, auto-rating bands, lower-is-better, competency share, final score) computed and stored server-side, HOD/HR calibration (`calibrations`), bell-curve checks, publishing (`cycle_publications`), and acknowledgements/concerns (`rating_acknowledgements`) with the accept/raise-concern/resolve flow.
- Manager/HOD manager-added goals (`cycle_goal_rules.manager_can_add_goals`) and employee-added goals beyond the library/prefill seed are deferrable to 3b if not needed by the evaluation flow.
- Competency selection on the plan (`employee_goal_plan_competencies`) surfaces in 3b where competency scores are captured; this plan leaves the table untouched.

Nothing in this plan modifies old-world files (old edge functions, `public` schema, `src/`), adds tables, or changes `pms-admin`.
