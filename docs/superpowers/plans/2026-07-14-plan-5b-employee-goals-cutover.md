# Plan 5b — Employee Goal-Setting Cutover Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate the employee goal-setting flow to a self-contained `EmployeeGoals` React component backed ONLY by `callWorkflow`, fed by a new scoped `goal.context` `pms-workflow` read — with no `app_state`/`stateStore`/`localStorage`/wizard-config/ratings source of truth for goal data.

**Architecture:** A new `goal.context` action (pms-workflow, `goals.ts`) does one scoped read for the signed-in employee — active cycle + goal config + library/prefill + window-open + plan/items — reusing the existing `readPlanBundle`/`loadActiveCycle`/`pureWindowOpen`/scope helpers. A new `EmployeeGoals` component renders/edits/submits goals purely via `callWorkflow` (`goal.context`/`ensure-plan`/`save-items`/`submit`), porting the existing goal UI. The employee "goals" section routes to it; the old blob employee-goal code is retired without touching the still-deferred manager/HR review path.

**Tech Stack:** React 19 + Vite, `@supabase/supabase-js@2`, Supabase edge function `pms-workflow` (Deno), Node `.mjs` + `node:assert` integration checks against the live project `erqeugmibozdjvhqgwai`, `npm run build`, manual browser smoke.

**Spec:** `docs/superpowers/specs/2026-07-14-plan-5b-employee-goals-cutover-design.md`.

## Global Constraints

- **`EmployeeGoals` uses `callWorkflow` ONLY** for goal data. It must NOT import or call `stateStore`/`app_state`/`localStorage`/`ratingsStore`/wizard-config for any migrated goal data. A grep of the component for those must be empty.
- **`goal.context` is the SINGLE scoped read** carrying: active `cycle {id,name,status}`, `config` (`goalCreationMode`, `goalKpiMode`, `kpiRatingMode`, `targetLevelMode`, `targetTypes`, `ratingScale`, `canEditOwnGoals`, `goalRules`), `library` (the assigned goal-library KRA/KPI items for add-from-library) + `prefill` if applicable, `window {goalOpen}`, and `plan`/`items`/`competencies`.
- **`goal.save-items` replaces the tree; delete = the item is absent from the saved rows.** No 7-day trash/undo.
- **Backend enforces** employee scope (`callerEmployeeId`; HR/super may target another), phase/window (`goal_creation` → `WINDOW_CLOSED`, HR bypass), plan status (submitted/approved read-only), and version conflicts (`CONFLICT`). Raw DB errors never reach the client (generic `DB_ERROR`).
- **Retire the employee-goal blob path ONLY.** `GOAL_WORKFLOW_KEY`, `submitGoalsAction`, `approveGoalsAction`, `sendBackGoalsAction` live in shared `src/backend/stateStore.js` and are ALSO used by the manager/HR review path (deferred to 5c/5d). Do NOT delete them from `stateStore.js` or break `approveGoalsAction`/`sendBackGoalsAction`. Only stop routing employees through the old goal UI and remove the employee-only goal code that is cleanly separable.
- **Kernel/client contracts (from 5a):** `callWorkflow(action, payload) → data | throws PmsError(code,message,status)` (`src/backend/pmsClient.js`); `useApp()` exposes `role`, `orgId`, `employeeId`, `userId`. `pms-workflow` responses are `{ok:true,data}`/`{ok:false,error:{code,message}}`, `verify_jwt=true`.
- **Build in an ISOLATED WORKTREE off pushed `main`** (`rebuild-5b-goals`); wire `.env`, symlink `node_modules`, copy `supabase/.temp` (migrations all committed — no copying). Full gate green before merge.
- **Deploy is gated for subagents:** implementer writes code + `deno check`/`node --check` + STOPS; controller deploys `pms-workflow` + runs the live check; resumes agent to commit.
- Commit trailer: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- Verify counts at branch start: `rls-check` 58, `admin-check` 101, `workflow-check` 70, `jobs-check` 18, `client-check` 8. This plan grows `workflow-check`.

## File Structure

- `supabase/functions/pms-workflow/goals.ts` (MODIFY) — add the `goal.context` handler (reuses `readPlanBundle`, `loadActiveCycle`, `pureWindowOpen`, `callerEmployeeId`, `isHrOrSuper`).
- `supabase/verify/workflow-check.mjs` (MODIFY) — add a `goal.context` + goal-flow section (the `setupActiveCycle` fixture already exists with a `goal_creation` window, a group, library, prefill, EMP002 participant).
- `src/pages/EmployeeGoals.jsx` (NEW) — the employee goal-setting component; `callWorkflow` only.
- `src/pages/EmployeePage.jsx` (MODIFY) — route the employee "goals" section to `EmployeeGoals`; remove employee-only blob goal code (keep manager-review path).

---

### Task 0: Worktree setup

**Files:** none — sets up the build worktree off pushed `main`.

- [ ] **Step 1: Create + wire the worktree**

```bash
git worktree add .worktrees/rebuild-5b-goals main -b rebuild-5b-goals
cp .env .worktrees/rebuild-5b-goals/.env
ln -s "$(pwd)/node_modules" .worktrees/rebuild-5b-goals/node_modules
mkdir -p .worktrees/rebuild-5b-goals/supabase/.temp && cp -R supabase/.temp/. .worktrees/rebuild-5b-goals/supabase/.temp/
```

Expected: `git -C .worktrees/rebuild-5b-goals status --short` clean; `cat .worktrees/rebuild-5b-goals/supabase/.temp/project-ref` = `erqeugmibozdjvhqgwai`.

- [ ] **Step 2: Baseline gate**

Run (in the worktree): `node supabase/verify/run-all.mjs` (background if >2 min).
Expected: `FOUNDATION SMOKE: ALL PASS` (rls 58, admin 101, workflow 70, jobs 18, client-check 8). A transient `TypeError: fetch failed` = network blip, re-run.

---

### Task 1: `goal.context` backend action

**Files:**
- Modify: `supabase/functions/pms-workflow/goals.ts`
- Modify: `supabase/verify/workflow-check.mjs`

**Interfaces:**
- Consumes: `readPlanBundle(ctx, orgId, cycleId, employeeId) → {plan, items, competencies}`, `callerEmployeeId`, `isHrOrSuper`, `pureWindowOpen`, `todayIso` (all already imported/available in `goals.ts`/`phase.ts`).
- Produces action `goal.context` `{orgId, employeeId?}` → `{ cycle, participant, config, library, prefill, window, plan, items, competencies }` (shapes below). Scoped to `callerEmployeeId` unless HR/super passes `employeeId`.

- [ ] **Step 1: Discover the exact config field locations (avoid guessing)**

The goal config the UI needs (`goalCreationMode`, `goalKpiMode`, `kpiRatingMode`, `targetLevelMode`) is spread across per-group columns (`cycle_groups`) and the frozen snapshot (`cycle_config_snapshots.snapshot`). Before coding, print the real shapes for the seeded acme cycle so the assembly reads the RIGHT columns/paths. In the worktree run:

```bash
node -e '
import("./supabase/verify/_clients.mjs").then(async ({ adminClient }) => {
  const admin = adminClient();
  const { data: org } = await admin.from("organizations").select("id").eq("key","acme-test").single();
  const { data: cyc } = await admin.from("appraisal_cycles").select("id,name,status").eq("organization_id",org.id).eq("status","active").maybeSingle();
  console.log("CYCLE", cyc);
  const { data: groups } = await admin.from("cycle_groups").select("*").eq("cycle_id", cyc.id).limit(2);
  console.log("GROUP COLS", groups?.[0] && Object.keys(groups[0]));
  console.log("GROUP0", groups?.[0]);
  const { data: snap } = await admin.from("cycle_config_snapshots").select("snapshot").eq("cycle_id", cyc.id).maybeSingle();
  console.log("SNAPSHOT KEYS", snap?.snapshot && Object.keys(snap.snapshot));
  console.log("SNAPSHOT.targets", snap?.snapshot?.targets);
  const { data: tt } = await admin.from("cycle_target_types").select("*").eq("cycle_id", cyc.id);
  console.log("TARGET_TYPES", tt);
  const { data: gr } = await admin.from("cycle_goal_rules").select("*").eq("cycle_id", cyc.id);
  console.log("GOAL_RULES", gr);
})'
```

Record which source holds each of `goalCreationMode`/`goalKpiMode`/`kpiRatingMode` (expected: `cycle_groups` columns `goal_creation_mode`/`goal_kpi_mode`/`kpi_rating_mode`) and `targetLevelMode` (expected: `snapshot.targets.targetLevelMode`). Use the REAL keys in Step 2; if a field is absent, default it (`goalCreationMode` → `'employee-self'`, `kpiRatingMode` → `'rated'`) and note it.

- [ ] **Step 2: Implement `goal.context`**

Add to `supabase/functions/pms-workflow/goals.ts` inside the exported handlers object (adjust the exact config keys per Step 1's findings):

```ts
  'goal.context': async (payload, ctx) => {
    const orgId = reqUuid(payload.orgId, 'orgId');
    const requested = optUuid(payload.employeeId, 'employeeId');
    const employeeId = requested && (await isHrOrSuper(ctx, orgId)) ? requested : callerEmployeeId(ctx, orgId);

    // Active/working cycle for the org (one active cycle per org).
    const { data: cycle, error: cErr } = await ctx.admin.from('appraisal_cycles')
      .select('id, name, status').eq('organization_id', orgId).eq('status', 'active').maybeSingle();
    if (cErr) { console.error('goal.context cycle', cErr); throw new ApiError('DB_ERROR', 'Database error', 500); }
    if (!cycle) return { cycle: null, participant: false, config: null, library: { items: [] }, prefill: { items: [] }, window: { goalOpen: false }, plan: null, items: [], competencies: [] };
    const cycleId = cycle.id;

    const { data: part, error: pErr } = await ctx.admin.from('cycle_participants')
      .select('id').eq('cycle_id', cycleId).eq('employee_id', employeeId).eq('organization_id', orgId).maybeSingle();
    if (pErr) { console.error('goal.context participant', pErr); throw new ApiError('DB_ERROR', 'Database error', 500); }
    const cycleOut = { id: cycle.id, name: cycle.name, status: cycle.status };
    if (!part) return { cycle: cycleOut, participant: false, config: null, library: { items: [] }, prefill: { items: [] }, window: { goalOpen: false }, plan: null, items: [], competencies: [] };

    const { data: assign } = await ctx.admin.from('cycle_participant_assignments')
      .select('group_id, goal_library_id, prefill_dataset_id').eq('cycle_id', cycleId).eq('employee_id', employeeId).eq('organization_id', orgId).maybeSingle();

    let group = null;
    if (assign?.group_id) {
      const { data: g } = await ctx.admin.from('cycle_groups')
        .select('can_edit_own_goals, kpi_rating_mode, goal_creation_mode, goal_kpi_mode').eq('id', assign.group_id).eq('organization_id', orgId).maybeSingle();
      group = g;
    }

    const { data: snapRow } = await ctx.admin.from('cycle_config_snapshots').select('snapshot').eq('cycle_id', cycleId).eq('organization_id', orgId).maybeSingle();
    const snap = (snapRow?.snapshot ?? {}) as Record<string, any>;
    const { data: targetTypes } = await ctx.admin.from('cycle_target_types').select().eq('cycle_id', cycleId).eq('organization_id', orgId).order('display_order');
    const { data: ratingScale } = await ctx.admin.from('cycle_rating_scale_levels').select().eq('cycle_id', cycleId).eq('organization_id', orgId).order('point');
    const { data: goalRules } = await ctx.admin.from('cycle_goal_rules').select().eq('cycle_id', cycleId).eq('organization_id', orgId);

    // Library items (add-from-library) — only if the assigned library is active.
    let library: { id?: string; items: unknown[] } = { items: [] };
    if (assign?.goal_library_id) {
      const { data: lib } = await ctx.admin.from('goal_libraries').select('id, status').eq('id', assign.goal_library_id).eq('organization_id', orgId).maybeSingle();
      if (lib?.status === 'active') {
        const { data: libItems } = await ctx.admin.from('goal_library_items').select().eq('goal_library_id', assign.goal_library_id).order('display_order');
        library = { id: lib.id, items: libItems ?? [] };
      }
    }

    // Prefill rows for this employee (by employee_code).
    let prefill: { items: unknown[] } = { items: [] };
    if (assign?.prefill_dataset_id) {
      const { data: ds } = await ctx.admin.from('prefill_datasets').select('id, status').eq('id', assign.prefill_dataset_id).eq('organization_id', orgId).maybeSingle();
      if (ds?.status === 'active') {
        const { data: emp } = await ctx.admin.from('employees').select('employee_code').eq('id', employeeId).eq('organization_id', orgId).maybeSingle();
        if (emp?.employee_code) {
          const { data: pf } = await ctx.admin.from('prefill_dataset_items').select().eq('prefill_dataset_id', assign.prefill_dataset_id).eq('employee_code', emp.employee_code).order('display_order');
          prefill = { items: pf ?? [] };
        }
      }
    }

    const { data: windows } = await ctx.admin.from('cycle_phase_windows').select('window_key, starts_on, ends_on').eq('cycle_id', cycleId).eq('organization_id', orgId);
    const goalOpen = pureWindowOpen((windows ?? []) as { window_key: string; starts_on: string; ends_on: string }[], 'goal_creation', todayIso()) || (await isHrOrSuper(ctx, orgId));

    const bundle = await readPlanBundle(ctx, orgId, cycleId, employeeId);

    return {
      cycle: cycleOut,
      participant: true,
      config: {
        goalCreationMode: group?.goal_creation_mode ?? 'employee-self',
        goalKpiMode: group?.goal_kpi_mode ?? snap?.targets?.goalKpiMode ?? 'kra-kpi',
        kpiRatingMode: group?.kpi_rating_mode ?? 'rated',
        targetLevelMode: snap?.targets?.targetLevelMode ?? 'KPI',
        targetTypes: targetTypes ?? [],
        ratingScale: ratingScale ?? [],
        canEditOwnGoals: group?.can_edit_own_goals ?? false,
        goalRules: goalRules ?? [],
      },
      library,
      prefill,
      window: { goalOpen },
      ...bundle,
    };
  },
```

Ensure `todayIso` is imported/available — if `phase.ts` does not export it, use `new Date().toISOString().slice(0,10)` inline. Ensure `optUuid` is imported (it is, per the top of `goals.ts`).

- [ ] **Step 3: Type-check + STOP for deploy**

Run: `deno check supabase/functions/pms-workflow/index.ts`. Fix any type error. Then STOP and report NEEDS_CONTEXT: "goal.context written + deno check clean; ready for controller to deploy pms-workflow, then I'll run workflow-check and commit."

- [ ] **Step 4 (controller): deploy** `supabase functions deploy pms-workflow`.

- [ ] **Step 5: Add `goal.context` assertions to `workflow-check.mjs`**

The `setupActiveCycle()` fixture (already in the file, `fixture`) gives an active acme cycle with a `goal_creation` window, a group, an assigned library (1 KRA + 1 KPI) + prefill, and EMP002 as a participant. Append, near the existing goal tests:

```js
// --- goal.context: one scoped read for the employee's goal screen ---
{
  const ctxRes = await callWorkflow(tokens.employee, 'goal.context', { orgId: fixture.orgId });
  check('goal.context returns the active cycle', ctxRes.status === 200 && ctxRes.body.data.cycle?.id === fixture.cycleId);
  check('goal.context marks the employee a participant', ctxRes.body.data.participant === true);
  check('goal.context carries goal config', !!ctxRes.body.data.config && typeof ctxRes.body.data.config.goalCreationMode === 'string' && Array.isArray(ctxRes.body.data.config.targetTypes));
  check('goal.context carries the library items for add-from-library', Array.isArray(ctxRes.body.data.library?.items) && ctxRes.body.data.library.items.length >= 1);
  check('goal.context reports the goal window open', ctxRes.body.data.window?.goalOpen === true);
  check('goal.context includes the plan bundle (plan/items)', 'plan' in ctxRes.body.data && Array.isArray(ctxRes.body.data.items));

  // A non-participant HR viewing themselves (not in this cycle) → participant:false, no crash.
  const hrCtx = await callWorkflow(tokens.hr, 'goal.context', { orgId: fixture.orgId });
  check('goal.context for a non-participant returns participant:false', hrCtx.status === 200 && hrCtx.body.data.participant === false);
}
```

- [ ] **Step 6 (controller/agent): run the check**

Run: `node supabase/verify/seed-foundation.mjs && node supabase/verify/workflow-check.mjs`
Expected: `workflow-check: PASS (77 assertions)` (70 + 7). Trust the printed count.

- [ ] **Step 7: Commit**

```bash
git add supabase/functions/pms-workflow/goals.ts supabase/verify/workflow-check.mjs
git commit -m "feat(workflow): goal.context — one scoped read (cycle+config+library+window+plan) for the employee goals screen"
```

---

### Task 2: `EmployeeGoals` component (callWorkflow only)

**Files:**
- Create: `src/pages/EmployeeGoals.jsx`

**Interfaces:**
- Consumes: `callWorkflow`/`PmsError` (`src/backend/pmsClient`), `useApp()` (`orgId`, `employeeId`, `role`). Backend actions `goal.context`, `goal.ensure-plan`, `goal.save-items`, `goal.submit`.
- Produces: a default-exported `EmployeeGoals` component rendering the employee's goal-setting screen entirely from `callWorkflow`.

- [ ] **Step 1: Scaffold the component + data load**

`src/pages/EmployeeGoals.jsx` — load context on mount, drive UI state from it. Port the VISUAL design (markup/classes) from the existing goals section in `EmployeePage.jsx` (read it for the JSX/styles), but the DATA layer is `callWorkflow` only:

```jsx
import { useEffect, useState, useCallback } from 'react';
import { useApp } from '../AppContext';
import { callWorkflow, PmsError } from '../backend/pmsClient';
import '../admin.css';

export default function EmployeeGoals() {
  const { orgId } = useApp();
  const [ctx, setCtx] = useState(null);     // goal.context result (source of truth)
  const [items, setItems] = useState([]);   // editable goal tree (local mirror of ctx.items)
  const [status, setStatus] = useState('loading'); // loading | ready | error
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setStatus('loading'); setError('');
    try {
      const data = await callWorkflow('goal.context', { orgId });
      setCtx(data);
      setItems(Array.isArray(data.items) ? data.items : []);
      setStatus('ready');
    } catch (e) {
      setError(e instanceof PmsError ? e.message : 'Could not load your goals.');
      setStatus('error');
    }
  }, [orgId]);

  useEffect(() => { if (orgId) load(); }, [orgId, load]);

  const plan = ctx?.plan || null;
  const config = ctx?.config || {};
  const windowOpen = !!ctx?.window?.goalOpen;
  const planStatus = plan?.status || null; // draft | sent_back | reopened | submitted | approved
  const readOnly = !windowOpen || planStatus === 'submitted' || planStatus === 'approved' || (config.canEditOwnGoals === false && ctx?.config?.goalCreationMode !== 'employee-self');
  const canEdit = !readOnly;

  async function ensurePlan() {
    setBusy(true); setError('');
    try { const data = await callWorkflow('goal.ensure-plan', { orgId, cycleId: ctx.cycle.id }); setCtx((c) => ({ ...c, plan: data.plan, items: data.items })); setItems(data.items || []); }
    catch (e) { setError(e instanceof PmsError ? e.message : 'Could not start your goal plan.'); }
    finally { setBusy(false); }
  }

  async function save() {
    setBusy(true); setError('');
    try {
      const data = await callWorkflow('goal.save-items', { orgId, cycleId: ctx.cycle.id, planVersion: plan?.version, items: toSaveItems(items) });
      setCtx((c) => ({ ...c, plan: data.plan, items: data.items })); setItems(data.items || []);
    } catch (e) {
      if (e instanceof PmsError && e.code === 'CONFLICT') { setError('Someone else changed this — reloading.'); await load(); }
      else if (e instanceof PmsError && e.code === 'WINDOW_CLOSED') { setError('The goal-setting window is closed.'); await load(); }
      else setError(e instanceof PmsError ? e.message : 'Could not save your goals.');
    } finally { setBusy(false); }
  }

  async function submit() {
    setBusy(true); setError('');
    try { const data = await callWorkflow('goal.submit', { orgId, cycleId: ctx.cycle.id, planVersion: plan?.version }); setCtx((c) => ({ ...c, plan: data.plan })); await load(); }
    catch (e) { if (e instanceof PmsError && e.code === 'CONFLICT') { await load(); } setError(e instanceof PmsError ? e.message : 'Could not submit your goals.'); }
    finally { setBusy(false); }
  }

  if (status === 'loading') return <div className="emp-goals-shell">Loading your goals…</div>;
  if (status === 'error') return <div className="emp-goals-shell"><div className="login-error">{error}</div><button className="btn" onClick={load}>Retry</button></div>;
  if (ctx && !ctx.cycle) return <div className="emp-goals-shell">No active appraisal cycle yet.</div>;
  if (ctx && !ctx.participant) return <div className="emp-goals-shell">You're not a participant in the current cycle — contact HR.</div>;

  return (
    <div className="emp-goals-shell">
      {/* Port the goals UI from EmployeePage's goals section: KRA/KPI tree editor honoring
          config.goalCreationMode / goalKpiMode / kpiRatingMode / targetLevelMode / targetTypes /
          ratingScale; add-from-library uses ctx.library.items; add/edit/delete update `items`
          (delete = remove from `items`); Save calls save()/Submit calls submit(). */}
      {error && <div className="login-error">{error}</div>}
      {!plan && canEdit && <button className="btn btn-primary" disabled={busy} onClick={ensurePlan}>Start my goals</button>}
      {/* ...goal tree editor... */}
      {plan && canEdit && <><button className="btn" disabled={busy} onClick={save}>Save</button><button className="btn btn-primary" disabled={busy} onClick={submit}>Submit for approval</button></>}
      {readOnly && <div className="emp-goals-readonly">Status: {planStatus || 'read-only'} {windowOpen ? '' : '(window closed)'}</div>}
    </div>
  );
}
```

**Read↔save shape transform (REQUIRED — the read and save shapes differ):**
- `goal.context`/`goal.get-plan` return `employee_goal_items` DB ROWS: `{ id, item_type: 'kra'|'kpi', parent_id, title, description, perspective, weight, target_type_id, target_value, display_order, source }`.
- `goal.save-items` expects CALLER-LOCAL items keyed by string: `{ key, itemType: 'kra'|'kpi', parentKey?, title, description?, perspective?, weight?, targetTypeKey?, targetValue?, displayOrder }` (KRA↔KPI linked by `key`/`parentKey`, NOT ids; target linked by `targetTypeKey`, a `cycle_target_types.key`, NOT `target_type_id`).

So `EmployeeGoals` keeps its local editable `items` in a shape it controls (give each a stable local `key`; new items get a fresh key like `k${n}`), and maps at the boundaries. Add these pure helpers in the file:

```jsx
// DB rows → local editable items (stable key = the row id, or a temp key for unsaved).
function fromPlanItems(rows = [], targetTypes = []) {
  const idToKey = new Map(rows.map((r) => [r.id, r.id]));
  const ttIdToKey = new Map(targetTypes.map((t) => [t.id, t.key]));
  return rows.map((r) => ({
    key: r.id, itemType: r.item_type, parentKey: r.parent_id ? (idToKey.get(r.parent_id) || null) : null,
    title: r.title || '', description: r.description || '', perspective: r.perspective || '',
    weight: r.weight, targetTypeKey: r.target_type_id ? (ttIdToKey.get(r.target_type_id) || null) : null,
    targetValue: r.target_value || '', displayOrder: r.display_order ?? 0,
  }));
}
// Local items → goal.save-items payload shape.
function toSaveItems(local = []) {
  return local.map((it, i) => ({
    key: it.key, itemType: it.itemType, parentKey: it.parentKey || undefined,
    title: it.title, description: it.description || undefined, perspective: it.perspective || undefined,
    weight: it.weight ?? undefined, targetTypeKey: it.targetTypeKey || undefined,
    targetValue: it.targetValue || undefined, displayOrder: it.displayOrder ?? i,
  }));
}
```

Then in `load()`/`ensurePlan()` set `setItems(fromPlanItems(data.items, data.config?.targetTypes || config.targetTypes))` instead of the raw rows, and `save()` sends `toSaveItems(items)` (as wired above — drop the unused `config.targetTypes` arg if you don't need it in `toSaveItems`).

Port the KRA/KPI tree EDITOR markup/behaviour from `EmployeePage.jsx`'s goals section (its rendering of goals, KPIs, targets, the goal-library picker), honoring `config.goalCreationMode`/`goalKpiMode`/`kpiRatingMode`/`targetLevelMode`. Add/edit/delete mutate the local `items` array (delete = `setItems(items.filter(...))`); add-from-library appends items built from `ctx.library.items`. `save()` sends the mapped array to `goal.save-items` (full tree replace). Do NOT read/write any blob/localStorage.

- [ ] **Step 2: Build check**

Run: `npm run build`
Expected: succeeds. Confirm no blob deps: `grep -nE "stateStore|app_state|localStorage|ratingsStore|GOAL_WORKFLOW_KEY|hydrate" src/pages/EmployeeGoals.jsx` → empty.

- [ ] **Step 3: Commit**

```bash
git add src/pages/EmployeeGoals.jsx
git commit -m "feat(goals): EmployeeGoals component — goal-setting via callWorkflow only (goal.context/ensure/save/submit)"
```

---

### Task 3: Route employees to `EmployeeGoals` + retire the employee blob-goal path

**Files:**
- Modify: `src/pages/EmployeePage.jsx`

**Interfaces:**
- Consumes: `EmployeeGoals` (Task 2), `useApp()` (`role`).
- Produces: the employee's "goals" section renders `EmployeeGoals`; the old blob employee-goal code no longer runs for employees.

- [ ] **Step 1: Route the goals section to `EmployeeGoals`**

In `src/pages/EmployeePage.jsx`, `import EmployeeGoals from './EmployeeGoals';`. Where the goals section renders (the `activeSection === 'goals'` render path — search for `activeSection` and the goals render), replace the OLD employee goal-setting UI with `<EmployeeGoals />` for the employee. Keep the surrounding section shell/nav.

- [ ] **Step 2: Remove the employee-only blob goal code (surgically)**

Remove code that is used ONLY by the employee goal-setting UI you just replaced:
- the employee-side `submitGoalsAction(...)` call (the employee submit handler now lives in `EmployeeGoals` via `goal.submit`);
- the employee goal `GOAL_WORKFLOW_KEY` localStorage read/writes in `EmployeePage.jsx` (e.g. around the goals section);
- the now-dead employee goal-tree state/effects that fed the old UI.

DO NOT touch, in this task:
- `src/backend/stateStore.js` (`GOAL_WORKFLOW_KEY`, `submitGoalsAction`, `approveGoalsAction`, `sendBackGoalsAction`) — shared infra, still used by the manager/HR review path;
- `approveGoalsAction`/`sendBackGoalsAction` calls (the manager review path, `EmployeePage.jsx` ~3630) — deferred to 5c;
- `HRCycleDashboard.jsx`'s `GOAL_WORKFLOW_KEY` — 5d.

If a piece of employee goal code is entangled with the manager-review path and can't be cleanly removed, LEAVE it (unreached by employees now) and note it in the report for 5c — correctness (not breaking manager review) beats deletion completeness.

- [ ] **Step 3: Build + confirm the employee goals path is blob-free**

Run: `npm run build` → succeeds.
Confirm employees no longer reach blob goal code: the `activeSection==='goals'` employee render path now returns `<EmployeeGoals/>` (which is blob-free). `approveGoalsAction`/`sendBackGoalsAction` remain (manager path).

- [ ] **Step 4: Full gate**

Run: `node supabase/verify/run-all.mjs` (background if >2 min).
Expected: all suites pass incl. `workflow-check: PASS (77)`, `FOUNDATION SMOKE: ALL PASS`.

- [ ] **Step 5: Browser smoke (documented)**

Run `npm run dev`; sign in as `pms-employee@example.com` / `Passw0rd!seed`; open the goals tab and confirm (record in the report):
1. The goals screen loads from `goal.context` (Network shows a `pms-workflow` `goal.context` POST; NO `app_state`/blob fetch for goals).
2. "Start my goals" seeds the plan (or prior goals render); add/edit/delete a KRA + KPI; Save persists (reload shows the saved tree from the backend).
3. Submit → the screen goes read-only, status "submitted".
4. Reload the page → goal state comes back from the backend (not localStorage).
5. No console error; `localStorage` has no new `zarohr_goal_workflow` writes from the employee goals flow.
6. (Regression) manager/HR goal review is untouched — not exercised here, just not broken by the build.

- [ ] **Step 6: Commit**

```bash
git add src/pages/EmployeePage.jsx
git commit -m "feat(goals): route employees to EmployeeGoals; retire employee blob-goal path (manager review untouched)"
```

---

## Out of Scope (later slices / plans)

- Employee self-eval (`eval.*`), results + acknowledgement (`eval.get` published + `ack.*`), notifications — later employee-portal slices.
- Manager/HOD/HR goal review (approve/send-back/reopen) + their `GOAL_WORKFLOW_KEY`/`stateStore` usage — 5c/5d.
- Deleting `stateStore`/`app_state`/old functions — Plan 6.

## Carried-forward notes

- Go-live: disable Supabase Auth signups; live SMTP smoke; schedule `jobs.tick`; ensure `VITE_SUPER_ADMIN_*` absent from prod build.
- Governing rule [[feedback-plan5-scoped-reads]]: migrated screens fetch scoped rows only, no blob source of truth, remove blob writes as each screen migrates.
