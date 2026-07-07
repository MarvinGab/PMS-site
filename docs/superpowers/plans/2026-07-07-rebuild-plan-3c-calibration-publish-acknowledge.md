# Rebuild Plan 3c: Calibration, Publishing & Acknowledgements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close out an appraisal cycle server-side — HOD/HR calibration with before/after audit records, a bell-curve distribution check that can block publishing, publish/revoke of results, and the post-publish employee accept / raise-concern flow with HR resolution — all permission-checked, phase-aware, versioned, and audited.

**Architecture:** Employee/HOD-derived actions extend the existing `pms-workflow` function (`calibration.ts`, `acknowledge.ts`) reusing the 3a/3b helpers; HR-only actions (bell-check, publish, revoke, concern resolution) extend `pms-admin` (`publishing.ts`) reusing the kernel's `requireOrgRole`. A pure `_shared/bellcurve.ts` computes the rating distribution and compares it to the cycle's frozen bell-curve bands. Publishing writes a `cycle_publications` row and flips the cycle to `published`, which (via 3b's existing `visibleToReader`) unblocks each employee's own final-rating view. No new tables, no migrations.

**Tech Stack:** Supabase edge functions (Deno, `npm:@supabase/supabase-js@2`), Postgres, Node verify scripts with `node:assert`, Supabase CLI (linked project `mkjtdwrzmobahwkpumxx`).

**Spec:** `docs/superpowers/specs/2026-07-03-server-first-rebuild-design.md` §4.3.11 (bell curve → publish blocking / distribution), §4.3.12 (HOD/HR calibration — before/after, actor, audit; not a loose payload), §4.3.13 (publishing / revoke; acknowledgement/concern; `finalEmployeeAcceptanceEnabled`), §5 (HOD calibrates mapped dept; HR publishes/calibrates; employee acknowledges only own published result).

## Closeout Model (authoritative — implement exactly this)

- **Calibration** is a moderation adjustment to a stage's frozen `overall_score`. `calibration.adjust` records a `calibrations` row (`before_score` = the stage evaluation's current `overall_score`, `after_score` = the new value, `note`, `actor_user_id`, `stage`) AND updates the evaluation's `overall_score` to `after_score` (version-checked). HOD may calibrate the `hod` stage of a mapped employee; HR may calibrate `hod` or `hr_final` of anyone. The stage evaluation must already be `submitted`. Calibration is only open while the cycle is `review`.
- **Bell-curve check** buckets every participant's **`hr_final`** submitted `overall_score` to the nearest `cycle_rating_scale_levels.point`, computes each point's share of the total, and compares to `cycle_bell_curve_bands` `target_percent ± tolerance_percent`. Returns per-point `{ point, actualPercent, targetPercent, tolerancePercent, withinTolerance }` and an overall `withinTolerance`. If there are no bell bands, `withinTolerance = true` (no constraint).
- **Publish** requires: cycle status `review`; every active participant has a `submitted` `hr_final` evaluation (else `FINALS_INCOMPLETE` 409); the bell-curve check passes OR `force: true` with a `reason` (else `BELL_CURVE_VIOLATION` 409). On success: insert a `cycle_publications` row (`published_by`, `reason`), flip the cycle to `published`. Publishing while an unrevoked publication already exists → `ALREADY_PUBLISHED` 409.
- **Revoke** sets the active (unrevoked) publication's `revoked_at`/`revoked_by`/`reason` and flips the cycle back to `review`. No active publication → `NOT_PUBLISHED` 409.
- **Final visibility** needs no new code: 3b's `visibleToReader` already returns an employee their own `hr_final`/`manager` stage once a non-revoked `cycle_publications` row exists (snapshot default `after_publish`). This plan's tests confirm the seam.
- **Acknowledgement** is gated on `snapshot.features.finalEmployeeAcceptanceEnabled === true` (else `ACK_NOT_ENABLED` 409) AND a live (non-revoked) publication (else `NOT_PUBLISHED` 409). `ack.accept` writes `rating_acknowledgements(decision='accepted')`; `ack.raise-concern {reason}` writes `decision='concern', resolution_status='open'`. One row per `(cycle,employee)` — a second call updates it (upsert), but not after it is resolved (`ACK_RESOLVED` 409). The employee acts only on their own row.
- **Concern resolution** (HR) sets `resolution_status` to `explained` (explain-and-close) or `recalibrated`, plus `resolution_note`, `resolved_by`, `resolved_at`, on a `concern` row whose `resolution_status = 'open'` (else `NOT_OPEN` 409). Recalibration itself is a separate `calibration.adjust` call; `concern.resolve` only records the resolution.

## Global Constraints

- **Write rule:** browser reads via RLS only; ALL business writes go through backend functions. No new grants to `anon`. **No new tables and no migrations** (`calibrations`, `cycle_publications`, `rating_acknowledgements`, `cycle_bell_curve_bands` all exist from Plans 1/2). No SECURITY DEFINER RPCs.
- **Kernel contract (binding):** response `{ ok: true, data } | { ok: false, error: { code, message } }`; stale version → `CONFLICT` 409 "someone else changed this — reload"; `versionedUpdate(table, orgId, id, expectedVersion, patch)` is org-scoped; raw DB errors never reach clients (`console.error` + generic `DB_ERROR` 500). Validators in `_shared/validate.ts`. Every non-trivial read is org-scoped (`.eq('organization_id', orgId)`) — a 3b-review lesson.
- **Reuse (don't duplicate):** `pms-workflow` — `_shared/scope.ts` (`callerEmployeeId`, `isHrOrSuper`, `manages`, `isHodOf`), `_shared/phase.ts` (`loadEvaluableCycle`); `pms-admin` — kernel `requireOrgRole(orgId, ['hr_admin'])` (super passes via fallback). Auth check runs BEFORE cycle load (3a/3b convention).
- **`calibrations` is append-only** (no `version`/`updated_at`) — every adjustment is a new row; the evaluation row it points at is the version-checked mutable state.
- **Cycle status gates:** calibration + publish require `review`; acknowledgement/concern require `published`; concern resolution allowed in `published` (or `review` after revoke). Wrong status → `CYCLE_WRONG_STATUS` 409 with a message naming the required status.
- **Score visibility already correct (3b):** do NOT re-implement `visibleToReader`; publishing is what flips employee final visibility on.
- Every handler: validate → auth (role/derived, before cycle load) → status gate → prerequisite → version-checked write (+ append calibration/acknowledgement row) → audit → typed response.
- Repo has unrelated dirty old-app files: stage ONLY each task's files by explicit path. `.env` gitignored, never printed/committed. Old-world files (old edge functions, `public` schema, `src/`) untouched.
- **Build in an ISOLATED WORKTREE off pushed `main`** (`rebuild-3c-closeout`) — never build in the dirty parent folder. Wire `.env`, symlink `node_modules`, copy `supabase/.temp`, and copy the 7 untracked old-app migrations (`2026062501..2026070301`) so `supabase db push` reconciles (this plan pushes none, but keep consistency). If deno modifies `deno.lock`, do NOT stage it.
- Commit trailer on every commit: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`
- Verify counts at branch start: `admin-check` 86, `rls-check` 55, `workflow-check` 55. This plan grows `workflow-check` AND `admin-check`; each task states its expected totals.
- **Go-live note (carry forward, unchanged):** Supabase Auth signups must be disabled manually in the dashboard before production — not automatable here.

## Carried Over From Plan 3b (deferred items — status in this plan)

- **Manual/calibrated score not validated against the rating scale** → CLOSED in Task 2: `calibration.adjust` rejects an `afterScore` outside the cycle's scale range (`BAD_REQUEST`). (3b's `eval.save-scores` manual path is still unbounded — a later hardening pass, not this plan.)
- **Competency-path integration test** (seed→save→blend→overall with competencies enabled, untested server-side) → STILL DEFERRED — belongs to a scoring-hardening pass, not the closeout flow.
- **Non-atomic multi-row `save-scores`** (concurrent-editor window) → STILL DEFERRED — pre-existing 3b behavior, out of 3c scope.
- **`hr_final` requires only `manager` submitted (not `hod`)** → BY DESIGN, unchanged.
- **Employee never sees the `hod` stage via `eval.get`** → BY DESIGN, unchanged; publishing (Task 3) unblocks only the employee's own `manager`/`hr_final` view.

---

### Task 1: Pure bell-curve engine

**Files:**
- Create: `supabase/functions/_shared/bellcurve.ts`
- Create: `supabase/functions/_shared/bellcurve.test.ts`

**Interfaces:**
- Produces (used by Task 3):
  - `type BellBand = { rating_point: number; target_percent: number; tolerance_percent: number }`
  - `nearestPoint(score: number, points: number[]) → number | null` (nearest scale point to a score; null if no points)
  - `type BellRow = { point: number; count: number; actualPercent: number; targetPercent: number; tolerancePercent: number; withinTolerance: boolean }`
  - `computeBellCurve(scores: number[], points: number[], bands: BellBand[]) → { rows: BellRow[]; withinTolerance: boolean }` — buckets each score to its nearest point, computes each band point's share, flags per-point + overall tolerance. No bands → `withinTolerance: true` and rows built from the observed points only.

- [ ] **Step 1: Write failing tests**

`supabase/functions/_shared/bellcurve.test.ts`:

```ts
import { assertEquals } from 'jsr:@std/assert@1';
import { computeBellCurve, nearestPoint } from './bellcurve.ts';

Deno.test('nearestPoint picks the closest scale point', () => {
  assertEquals(nearestPoint(4.2, [1, 2, 3, 4, 5]), 4);
  assertEquals(nearestPoint(3.5, [1, 2, 3, 4, 5]), 4); // ties round up to the higher point
  assertEquals(nearestPoint(0.9, [2, 3, 5]), 2);
  assertEquals(nearestPoint(5, []), null);
});

Deno.test('computeBellCurve flags within/out of tolerance', () => {
  // 10 people: 2 at point2, 6 at point3, 2 at point5. bands target 20/60/20 ±5.
  const scores = [2, 2, 3, 3, 3, 3, 3, 3, 5, 5];
  const points = [2, 3, 5];
  const bands = [
    { rating_point: 2, target_percent: 20, tolerance_percent: 5 },
    { rating_point: 3, target_percent: 60, tolerance_percent: 5 },
    { rating_point: 5, target_percent: 20, tolerance_percent: 5 },
  ];
  const res = computeBellCurve(scores, points, bands);
  assertEquals(res.withinTolerance, true);
  assertEquals(res.rows.find((r) => r.point === 3)?.actualPercent, 60);
});

Deno.test('computeBellCurve detects a violation outside tolerance', () => {
  // Everyone at point 5 → 100% vs target 20 ±5 → violation.
  const scores = [5, 5, 5, 5];
  const points = [2, 3, 5];
  const bands = [
    { rating_point: 2, target_percent: 20, tolerance_percent: 5 },
    { rating_point: 3, target_percent: 60, tolerance_percent: 5 },
    { rating_point: 5, target_percent: 20, tolerance_percent: 5 },
  ];
  const res = computeBellCurve(scores, points, bands);
  assertEquals(res.withinTolerance, false);
  assertEquals(res.rows.find((r) => r.point === 5)?.withinTolerance, false);
});

Deno.test('no bands means no constraint', () => {
  const res = computeBellCurve([3, 3, 5], [2, 3, 5], []);
  assertEquals(res.withinTolerance, true);
});

Deno.test('empty scores are within tolerance (nothing to distribute)', () => {
  const bands = [{ rating_point: 3, target_percent: 100, tolerance_percent: 0 }];
  const res = computeBellCurve([], [3], bands);
  assertEquals(res.withinTolerance, true);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `deno test supabase/functions/_shared/bellcurve.test.ts`
Expected: FAIL — `Module not found ... bellcurve.ts`.

- [ ] **Step 3: Implement `bellcurve.ts`**

`supabase/functions/_shared/bellcurve.ts`:

```ts
export type BellBand = { rating_point: number; target_percent: number; tolerance_percent: number };
export type BellRow = {
  point: number; count: number; actualPercent: number;
  targetPercent: number; tolerancePercent: number; withinTolerance: boolean;
};

// Nearest scale point to a score; ties round to the higher point.
export function nearestPoint(score: number, points: number[]): number | null {
  if (points.length === 0) return null;
  let best = points[0];
  let bestDist = Infinity;
  for (const p of points) {
    const d = Math.abs(p - score);
    if (d < bestDist || (d === bestDist && p > best)) { bestDist = d; best = p; }
  }
  return best;
}

function round2(n: number): number { return Math.round((n + Number.EPSILON) * 100) / 100; }

export function computeBellCurve(
  scores: number[], points: number[], bands: BellBand[],
): { rows: BellRow[]; withinTolerance: boolean } {
  const total = scores.length;
  const counts = new Map<number, number>();
  for (const s of scores) {
    const p = nearestPoint(s, points);
    if (p != null) counts.set(p, (counts.get(p) ?? 0) + 1);
  }
  // Row set = union of band points and observed points.
  const bandByPoint = new Map(bands.map((b) => [b.rating_point, b]));
  const rowPoints = new Set<number>([...bandByPoint.keys(), ...counts.keys()]);
  const rows: BellRow[] = [];
  let overall = true;
  for (const point of [...rowPoints].sort((a, b) => a - b)) {
    const count = counts.get(point) ?? 0;
    const actualPercent = total === 0 ? 0 : round2((count / total) * 100);
    const band = bandByPoint.get(point);
    const targetPercent = band?.target_percent ?? 0;
    const tolerancePercent = band?.tolerance_percent ?? 0;
    // Only band-constrained points can violate; and empty distributions never violate.
    const withinTolerance = !band || total === 0
      ? true
      : Math.abs(actualPercent - targetPercent) <= tolerancePercent + 1e-9;
    if (!withinTolerance) overall = false;
    rows.push({ point, count, actualPercent, targetPercent, tolerancePercent, withinTolerance });
  }
  return { rows, withinTolerance: overall };
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `deno test supabase/functions/_shared/bellcurve.test.ts`
Expected: `ok | 5 passed | 0 failed`.

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/_shared/bellcurve.ts supabase/functions/_shared/bellcurve.test.ts
git commit -m "feat(workflow): pure bell-curve distribution engine"
```

---

### Task 2: Calibration (HOD/HR before-after adjustment)

**Files:**
- Create: `supabase/functions/pms-workflow/calibration.ts`
- Modify: `supabase/functions/pms-workflow/index.ts` (spread `calibrationHandlers`)
- Modify: `supabase/verify/workflow-check.mjs` (extend the eval fixture to `review` + add a calibration section)

**Interfaces:**
- Consumes: kernel, validators, `_shared/scope.ts`.
- Produces action `calibration.adjust` `{orgId, cycleId, employeeId, stage, evalVersion, afterScore, note?}` → `{evaluation, calibration}` — stage ∈ `hod`/`hr_final`; auth: HR/super OR (stage `hod` AND `isHodOf(caller, employeeId)`); cycle must be `review` (else `CYCLE_WRONG_STATUS` 409); the stage evaluation must be `submitted` (else `EVAL_NOT_SUBMITTED` 409); insert a `calibrations` row (`before_score` = current `overall_score`, `after_score`, `note`, `actor_user_id`, `stage`) then version-check-update the evaluation's `overall_score` to `afterScore`; audited.

- [ ] **Step 1: Write the calibration module**

`supabase/functions/pms-workflow/calibration.ts`:

```ts
import { ApiError, Handler, HandlerCtx } from '../_shared/kernel.ts';
import { optString, reqInt, reqNumber, reqUuid, reqEnum } from '../_shared/validate.ts';
import { isHodOf, isHrOrSuper } from '../_shared/scope.ts';

const CALIBRATABLE = ['hod', 'hr_final'];

async function loadReviewCycle(ctx: HandlerCtx, orgId: string, cycleId: string) {
  const { data: cycle, error } = await ctx.admin.from('appraisal_cycles')
    .select('id, status').eq('id', cycleId).eq('organization_id', orgId).maybeSingle();
  if (error) { console.error('loadReviewCycle', error); throw new ApiError('DB_ERROR', 'Database error', 500); }
  if (!cycle) throw new ApiError('NOT_FOUND', 'Cycle not found', 404);
  if (cycle.status !== 'review') throw new ApiError('CYCLE_WRONG_STATUS', 'Calibration is only open while the cycle is in review', 409);
  return cycle;
}

// Guard a calibrated score against the cycle's rating scale (closes a 3b deferral: an
// unbounded afterScore would store garbage and skew the bell curve). No scale defined → no bound.
async function assertScoreInScale(ctx: HandlerCtx, orgId: string, cycleId: string, afterScore: number) {
  const { data: pts, error } = await ctx.admin.from('cycle_rating_scale_levels')
    .select('point').eq('cycle_id', cycleId).eq('organization_id', orgId);
  if (error) { console.error('assertScoreInScale', error); throw new ApiError('DB_ERROR', 'Database error', 500); }
  const points = (pts ?? []).map((p) => Number(p.point));
  if (points.length === 0) return;
  const lo = Math.min(...points);
  const hi = Math.max(...points);
  if (afterScore < lo || afterScore > hi) {
    throw new ApiError('BAD_REQUEST', `afterScore must be within the rating scale (${lo}–${hi})`, 400);
  }
}

export const calibrationHandlers: Record<string, Handler> = {
  'calibration.adjust': async (payload, ctx) => {
    const orgId = reqUuid(payload.orgId, 'orgId');
    const cycleId = reqUuid(payload.cycleId, 'cycleId');
    const employeeId = reqUuid(payload.employeeId, 'employeeId');
    const stage = reqEnum(payload.stage, 'stage', CALIBRATABLE);
    const evalVersion = reqInt(payload.evalVersion, 'evalVersion');
    const afterScore = reqNumber(payload.afterScore, 'afterScore');
    const note = optString(payload.note, 'note', 2000);

    // Auth BEFORE cycle load. HR/super may calibrate any stage; a HOD only the hod stage of a mapped employee.
    if (!isHrOrSuper(ctx, orgId)) {
      if (!(stage === 'hod' && await isHodOf(ctx, orgId, employeeId))) {
        throw new ApiError('FORBIDDEN', 'You cannot calibrate this evaluation', 403);
      }
    }
    await loadReviewCycle(ctx, orgId, cycleId);
    await assertScoreInScale(ctx, orgId, cycleId, afterScore);

    const { data: evaluation, error: eErr } = await ctx.admin.from('evaluations')
      .select().eq('cycle_id', cycleId).eq('employee_id', employeeId).eq('stage', stage).eq('organization_id', orgId).maybeSingle();
    if (eErr) { console.error('calibration eval', eErr); throw new ApiError('DB_ERROR', 'Database error', 500); }
    if (!evaluation) throw new ApiError('NOT_FOUND', 'Evaluation not found', 404);
    if (evaluation.status !== 'submitted') throw new ApiError('EVAL_NOT_SUBMITTED', 'Only a submitted evaluation can be calibrated', 409);

    // Append-only before/after record.
    const { data: calibration, error: cErr } = await ctx.admin.from('calibrations').insert({
      organization_id: orgId, cycle_id: cycleId, employee_id: employeeId, stage,
      before_score: evaluation.overall_score, after_score: afterScore, note, actor_user_id: ctx.userId,
    }).select().single();
    if (cErr) { console.error('calibration insert', cErr); throw new ApiError('DB_ERROR', 'Database error', 500); }

    const fresh = await ctx.versionedUpdate('evaluations', orgId, evaluation.id, evalVersion, { overall_score: afterScore });
    await ctx.audit({
      organizationId: orgId, cycleId, action: 'calibration.adjust', entityType: 'evaluation', entityId: evaluation.id,
      before: { overall_score: evaluation.overall_score }, after: { overall_score: afterScore }, note: `${stage} calibrated`,
    });
    return { evaluation: fresh, calibration };
  },
};
```

- [ ] **Step 2: Wire the router**

In `supabase/functions/pms-workflow/index.ts`, add `import { calibrationHandlers } from './calibration.ts';` and `...calibrationHandlers,` to `serveActions` (keep whoami + goalHandlers + goalFlowHandlers + evalHandlers).

- [ ] **Step 3: Deploy**

Run: `supabase functions deploy pms-workflow`
Expected: deployed.

- [ ] **Step 4: Extend the eval fixture to review + add a calibration section**

The 3b `setupEvalCycle()` leaves the cycle `active` with a submitted `hr_final` evaluation for EMP002 (from the 3b eval sections that ran earlier in the file). For 3c, add a standalone `setupCloseoutCycle()` that reuses the same shape but drives EMP002 to a **submitted `hr_final`** evaluation and flips the cycle to `review`, with bell bands + hod_review/hr_calibration windows. Add this helper after `setupEvalCycle`:

```js
// Fresh cycle in `review` with EMP002's hr_final evaluation submitted (overall 3.8),
// bell bands, and a snapshot enabling final acceptance — the closeout starting point.
export async function setupCloseoutCycle() {
  const { data: org } = await admin.from('organizations').select('id').eq('key', 'acme-test').single();
  const emp = {};
  for (const code of ['EMP001', 'EMP002', 'EMP003']) {
    const { data } = await admin.from('employees').select('id').eq('organization_id', org.id).eq('employee_code', code).single();
    emp[code] = data.id;
  }
  await admin.from('appraisal_cycles').update({ status: 'archived', archived_at: new Date().toISOString() })
    .eq('organization_id', org.id).neq('status', 'archived');
  const { data: cycle } = await admin.from('appraisal_cycles').insert({
    organization_id: org.id, name: 'Closeout Cycle', framework_id: 'kra-kpi', status: 'review',
  }).select().single();
  const iso = (d) => d.toISOString().slice(0, 10);
  const past = iso(new Date(Date.now() - 3 * 864e5));
  const fut = iso(new Date(Date.now() + 30 * 864e5));
  await admin.from('cycle_phase_windows').insert([
    { organization_id: org.id, cycle_id: cycle.id, window_key: 'hod_review', starts_on: past, ends_on: fut },
    { organization_id: org.id, cycle_id: cycle.id, window_key: 'hr_calibration', starts_on: past, ends_on: fut },
  ]);
  await admin.from('cycle_rating_scale_levels').insert([
    { organization_id: org.id, cycle_id: cycle.id, point: 2, label: 'Below', range_from: 0, range_to: 59 },
    { organization_id: org.id, cycle_id: cycle.id, point: 3, label: 'Meets', range_from: 60, range_to: 89 },
    { organization_id: org.id, cycle_id: cycle.id, point: 5, label: 'Exceeds', range_from: 90, range_to: 200 },
  ]);
  await admin.from('cycle_bell_curve_bands').insert([
    { organization_id: org.id, cycle_id: cycle.id, rating_point: 2, target_percent: 0, tolerance_percent: 100 },
    { organization_id: org.id, cycle_id: cycle.id, rating_point: 3, target_percent: 50, tolerance_percent: 100 },
    { organization_id: org.id, cycle_id: cycle.id, rating_point: 5, target_percent: 50, tolerance_percent: 100 },
  ]);
  await admin.from('cycle_config_snapshots').insert({
    organization_id: org.id, cycle_id: cycle.id,
    snapshot: { visibility: { manager_rating_visible: 'after_publish', final_rating_visible: 'after_publish' }, features: { finalEmployeeAcceptanceEnabled: true } },
  });
  const { data: part } = await admin.from('cycle_participants').insert({ organization_id: org.id, cycle_id: cycle.id, employee_id: emp.EMP002 }).select().single();
  await admin.from('cycle_participant_assignments').insert({ organization_id: org.id, cycle_id: cycle.id, participant_id: part.id, employee_id: emp.EMP002 });
  // A submitted hr_final evaluation with overall 4 (the number under calibration).
  await admin.from('evaluations').insert({
    organization_id: org.id, cycle_id: cycle.id, employee_id: emp.EMP002, stage: 'hr_final', status: 'submitted', overall_score: 4, submitted_at: new Date().toISOString(),
  });
  // Also a submitted hod evaluation for the HOD-calibration test.
  await admin.from('evaluations').insert({
    organization_id: org.id, cycle_id: cycle.id, employee_id: emp.EMP002, stage: 'hod', status: 'submitted', overall_score: 4, submitted_at: new Date().toISOString(),
  });
  return { orgId: org.id, cycleId: cycle.id, emp };
}
```

Then append the calibration section before the final `console.log` (creates `closeout` used by Tasks 2–5):

```js
// ============ CLOSEOUT (Plan 3c) ============
export const closeout = await setupCloseoutCycle();

// --- calibration records before/after and updates the evaluation ---
{
  const { data: hodEval } = await admin.from('evaluations').select('id, version, overall_score').eq('cycle_id', closeout.cycleId).eq('employee_id', closeout.emp.EMP002).eq('stage', 'hod').single();
  const hodCal = await callWorkflow(tokens.hod, 'calibration.adjust', { orgId: closeout.orgId, cycleId: closeout.cycleId, employeeId: closeout.emp.EMP002, stage: 'hod', evalVersion: hodEval.version, afterScore: 3, note: 'Moderated down' });
  check('HOD calibrates the hod stage', hodCal.status === 200 && Number(hodCal.body.data.evaluation.overall_score) === 3);
  check('calibration records before/after', Number(hodCal.body.data.calibration.before_score) === 4 && Number(hodCal.body.data.calibration.after_score) === 3);

  const empCal = await callWorkflow(tokens.employee, 'calibration.adjust', { orgId: closeout.orgId, cycleId: closeout.cycleId, employeeId: closeout.emp.EMP002, stage: 'hr_final', evalVersion: 1, afterScore: 5 });
  check('employee cannot calibrate', empCal.status === 403);

  // afterScore outside the cycle's rating scale (2–5) is rejected before any write.
  const oob = await callWorkflow(tokens.hr, 'calibration.adjust', { orgId: closeout.orgId, cycleId: closeout.cycleId, employeeId: closeout.emp.EMP002, stage: 'hr_final', evalVersion: 1, afterScore: 99 });
  check('calibration rejects a score outside the rating scale', oob.status === 400 && oob.body.error.code === 'BAD_REQUEST');

  const { data: hrEval } = await admin.from('evaluations').select('id, version').eq('cycle_id', closeout.cycleId).eq('employee_id', closeout.emp.EMP002).eq('stage', 'hr_final').single();
  const hrCal = await callWorkflow(tokens.hr, 'calibration.adjust', { orgId: closeout.orgId, cycleId: closeout.cycleId, employeeId: closeout.emp.EMP002, stage: 'hr_final', evalVersion: hrEval.version, afterScore: 3 });
  check('HR calibrates the hr_final stage', hrCal.status === 200 && Number(hrCal.body.data.evaluation.overall_score) === 3);
}
```

- [ ] **Step 5: Run the check**

Run: `node supabase/verify/seed-foundation.mjs && node supabase/verify/workflow-check.mjs`
Expected: `workflow-check: PASS (60 assertions)` (55 + 5). (Trust the printed `n`; recount if it differs.)

- [ ] **Step 6: Commit**

```bash
git add supabase/functions/pms-workflow/calibration.ts supabase/functions/pms-workflow/index.ts supabase/verify/workflow-check.mjs
git commit -m "feat(workflow): HOD/HR calibration with before/after records"
```

---

### Task 3: Bell-curve check + publish + revoke (HR)

**Files:**
- Create: `supabase/functions/pms-admin/publishing.ts`
- Modify: `supabase/functions/pms-admin/index.ts` (spread `publishingHandlers`)
- Modify: `supabase/verify/admin-check.mjs` (append a publishing section that reuses the closeout cycle built by the workflow fixture — see note)

**Interfaces:**
- Consumes: kernel `requireOrgRole`, validators, `_shared/bellcurve.ts`.
- Produces actions (all `hr_admin`-or-super):
  - `publish.bell-check` `{orgId, cycleId}` → `{ rows, withinTolerance }` — reads submitted `hr_final` overall scores of active participants + the cycle's scale points + bell bands, runs `computeBellCurve`.
  - `publish.publish` `{orgId, cycleId, force?, reason?}` → `{publication, cycle}` — cycle `review`; every active participant has a submitted `hr_final` (`FINALS_INCOMPLETE` 409); bell within tolerance OR `force===true`+`reason` (`BELL_CURVE_VIOLATION` 409); no live publication (`ALREADY_PUBLISHED` 409); insert `cycle_publications`, flip cycle to `published`; audited.
  - `publish.revoke` `{orgId, cycleId, reason}` → `{cycle}` — set the live publication's `revoked_at`/`revoked_by`/`reason`, flip cycle to `review`; no live publication → `NOT_PUBLISHED` 409.

- [ ] **Step 1: Write the publishing module**

`supabase/functions/pms-admin/publishing.ts`:

```ts
import { ApiError, Handler, HandlerCtx } from '../_shared/kernel.ts';
import { optBool, optString, reqString, reqUuid } from '../_shared/validate.ts';
import { BellBand, computeBellCurve } from '../_shared/bellcurve.ts';

async function finalScores(ctx: HandlerCtx, orgId: string, cycleId: string): Promise<{ scores: number[]; missing: number }> {
  const { data: parts, error } = await ctx.admin.from('cycle_participants')
    .select('employee_id').eq('cycle_id', cycleId).eq('organization_id', orgId).eq('status', 'active');
  if (error) { console.error('finalScores parts', error); throw new ApiError('DB_ERROR', 'Database error', 500); }
  const ids = (parts ?? []).map((p) => p.employee_id);
  if (ids.length === 0) return { scores: [], missing: 0 };
  const { data: evals, error: eErr } = await ctx.admin.from('evaluations')
    .select('employee_id, overall_score, status').eq('cycle_id', cycleId).eq('organization_id', orgId).eq('stage', 'hr_final').in('employee_id', ids);
  if (eErr) { console.error('finalScores evals', eErr); throw new ApiError('DB_ERROR', 'Database error', 500); }
  const submitted = (evals ?? []).filter((e) => e.status === 'submitted');
  const scores = submitted.filter((e) => e.overall_score != null).map((e) => Number(e.overall_score));
  const missing = ids.length - submitted.length;
  return { scores, missing };
}

async function bellContext(ctx: HandlerCtx, orgId: string, cycleId: string) {
  const { data: pts } = await ctx.admin.from('cycle_rating_scale_levels').select('point').eq('cycle_id', cycleId).eq('organization_id', orgId);
  const { data: bands } = await ctx.admin.from('cycle_bell_curve_bands').select('rating_point, target_percent, tolerance_percent').eq('cycle_id', cycleId).eq('organization_id', orgId);
  return { points: (pts ?? []).map((p) => Number(p.point)), bands: (bands ?? []) as BellBand[] };
}

async function livePublication(ctx: HandlerCtx, orgId: string, cycleId: string) {
  const { data } = await ctx.admin.from('cycle_publications')
    .select().eq('cycle_id', cycleId).eq('organization_id', orgId).is('revoked_at', null).order('published_at', { ascending: false }).limit(1);
  return (data ?? [])[0] ?? null;
}

export const publishingHandlers: Record<string, Handler> = {
  'publish.bell-check': async (payload, ctx) => {
    const orgId = reqUuid(payload.orgId, 'orgId');
    ctx.requireOrgRole(orgId, ['hr_admin']);
    const cycleId = reqUuid(payload.cycleId, 'cycleId');
    const { scores } = await finalScores(ctx, orgId, cycleId);
    const { points, bands } = await bellContext(ctx, orgId, cycleId);
    return computeBellCurve(scores, points, bands);
  },

  'publish.publish': async (payload, ctx) => {
    const orgId = reqUuid(payload.orgId, 'orgId');
    ctx.requireOrgRole(orgId, ['hr_admin']);
    const cycleId = reqUuid(payload.cycleId, 'cycleId');
    const force = optBool(payload.force, 'force');
    const reason = optString(payload.reason, 'reason', 2000);

    const { data: cycle, error: cErr } = await ctx.admin.from('appraisal_cycles').select('id, status, version').eq('id', cycleId).eq('organization_id', orgId).maybeSingle();
    if (cErr) { console.error('publish cycle', cErr); throw new ApiError('DB_ERROR', 'Database error', 500); }
    if (!cycle) throw new ApiError('NOT_FOUND', 'Cycle not found', 404);
    if (cycle.status !== 'review') throw new ApiError('CYCLE_WRONG_STATUS', 'Only a cycle in review can be published', 409);
    if (await livePublication(ctx, orgId, cycleId)) throw new ApiError('ALREADY_PUBLISHED', 'This cycle is already published', 409);

    const { scores, missing } = await finalScores(ctx, orgId, cycleId);
    if (missing > 0) throw new ApiError('FINALS_INCOMPLETE', `${missing} participant(s) have no submitted final evaluation`, 409);
    const { points, bands } = await bellContext(ctx, orgId, cycleId);
    const bell = computeBellCurve(scores, points, bands);
    if (!bell.withinTolerance && !(force && reason)) {
      throw new ApiError('BELL_CURVE_VIOLATION', 'The rating distribution is outside the bell-curve tolerance; publish with force + reason to override', 409);
    }

    const { data: publication, error: pErr } = await ctx.admin.from('cycle_publications')
      .insert({ organization_id: orgId, cycle_id: cycleId, published_by: ctx.userId, reason: force ? reason : null }).select().single();
    if (pErr) { console.error('publish insert', pErr); throw new ApiError('DB_ERROR', 'Database error', 500); }
    const freshCycle = await ctx.versionedUpdate('appraisal_cycles', orgId, cycleId, cycle.version, { status: 'published' });
    await ctx.audit({ organizationId: orgId, cycleId, action: 'publish.publish', entityType: 'cycle_publication', entityId: publication.id, note: force ? `forced: ${reason}` : 'within tolerance' });
    return { publication, cycle: freshCycle };
  },

  'publish.revoke': async (payload, ctx) => {
    const orgId = reqUuid(payload.orgId, 'orgId');
    ctx.requireOrgRole(orgId, ['hr_admin']);
    const cycleId = reqUuid(payload.cycleId, 'cycleId');
    const reason = reqString(payload.reason, 'reason', 2000);
    const pub = await livePublication(ctx, orgId, cycleId);
    if (!pub) throw new ApiError('NOT_PUBLISHED', 'This cycle has no active publication', 409);
    const updated = await ctx.versionedUpdate('cycle_publications', orgId, pub.id, pub.version, {
      revoked_at: new Date().toISOString(), revoked_by: ctx.userId, reason,
    });
    const { data: cycle } = await ctx.admin.from('appraisal_cycles').select('version').eq('id', cycleId).single();
    const freshCycle = await ctx.versionedUpdate('appraisal_cycles', orgId, cycleId, cycle.version, { status: 'review' });
    await ctx.audit({ organizationId: orgId, cycleId, action: 'publish.revoke', entityType: 'cycle_publication', entityId: pub.id, note: reason });
    return { cycle: freshCycle, publication: updated };
  },
};
```

- [ ] **Step 2: Wire the router**

In `supabase/functions/pms-admin/index.ts`, add `import { publishingHandlers } from './publishing.ts';` and `...publishingHandlers,` to `serveActions`.

- [ ] **Step 3: Deploy**

Run: `supabase functions deploy pms-admin`
Expected: deployed.

- [ ] **Step 4: Append the publishing section to `admin-check.mjs`**

The closeout cycle is built by the WORKFLOW check, which runs AFTER admin-check in `run-all.mjs`. So admin-check cannot reuse it. Instead, admin-check builds its OWN closeout cycle for gamma via the admin client at the top of this section (gamma is admin-check's own org). Append before the final `console.log` in `supabase/verify/admin-check.mjs`:

```js
// --- publishing: bell-check, publish (blocked/forced), revoke ---
{
  // Build a review-status gamma cycle with 2 participants who both have submitted hr_final finals.
  await admin.from('appraisal_cycles').update({ status: 'archived', archived_at: new Date().toISOString() }).eq('organization_id', gamma.id).neq('status', 'archived');
  const { data: pcycle } = await admin.from('appraisal_cycles').insert({ organization_id: gamma.id, name: 'Publish Cycle', framework_id: 'kra', status: 'review' }).select().single();
  await admin.from('cycle_rating_scale_levels').insert([
    { organization_id: gamma.id, cycle_id: pcycle.id, point: 3, label: 'Meets', range_from: 60, range_to: 89 },
    { organization_id: gamma.id, cycle_id: pcycle.id, point: 5, label: 'Exceeds', range_from: 90, range_to: 200 },
  ]);
  // Bell bands demanding a 50/50 split with 0 tolerance — two people both at 5 will VIOLATE.
  await admin.from('cycle_bell_curve_bands').insert([
    { organization_id: gamma.id, cycle_id: pcycle.id, rating_point: 3, target_percent: 50, tolerance_percent: 0 },
    { organization_id: gamma.id, cycle_id: pcycle.id, rating_point: 5, target_percent: 50, tolerance_percent: 0 },
  ]);
  // Two employees, both participants, each a submitted hr_final at score 5.
  const empIds = [];
  for (const code of ['PUB1', 'PUB2']) {
    const { data: e } = await admin.from('employees').upsert({ organization_id: gamma.id, employee_code: code, full_name: code, email: `${code.toLowerCase()}@x.com`, group_name: 'Sales' }, { onConflict: 'organization_id,employee_code' }).select().single();
    empIds.push(e.id);
    await admin.from('cycle_participants').insert({ organization_id: gamma.id, cycle_id: pcycle.id, employee_id: e.id });
    await admin.from('evaluations').insert({ organization_id: gamma.id, cycle_id: pcycle.id, employee_id: e.id, stage: 'hr_final', status: 'submitted', overall_score: 5, submitted_at: new Date().toISOString() });
  }

  const bell = await callAdmin(superT, 'publish.bell-check', { orgId: gamma.id, cycleId: pcycle.id });
  check('bell-check reports out of tolerance (both at 5)', bell.status === 200 && bell.body.data.withinTolerance === false);

  const blocked = await callAdmin(superT, 'publish.publish', { orgId: gamma.id, cycleId: pcycle.id });
  check('publish blocked by bell-curve violation', blocked.status === 409 && blocked.body.error.code === 'BELL_CURVE_VIOLATION');

  const empPub = await callAdmin(empT, 'publish.publish', { orgId: gamma.id, cycleId: pcycle.id });
  check('employee cannot publish', empPub.status === 403);

  const forced = await callAdmin(superT, 'publish.publish', { orgId: gamma.id, cycleId: pcycle.id, force: true, reason: 'Exec sign-off' });
  check('publish succeeds with force + reason', forced.status === 200 && forced.body.data.cycle.status === 'published');

  const again = await callAdmin(superT, 'publish.publish', { orgId: gamma.id, cycleId: pcycle.id, force: true, reason: 'x' });
  check('re-publish rejected while already published', again.status === 409 && again.body.error.code === 'ALREADY_PUBLISHED');

  const revoke = await callAdmin(superT, 'publish.revoke', { orgId: gamma.id, cycleId: pcycle.id, reason: 'Correction needed' });
  check('revoke returns the cycle to review', revoke.status === 200 && revoke.body.data.cycle.status === 'review');

  const revokeAgain = await callAdmin(superT, 'publish.revoke', { orgId: gamma.id, cycleId: pcycle.id, reason: 'x' });
  check('revoke with no live publication rejected', revokeAgain.status === 409 && revokeAgain.body.error.code === 'NOT_PUBLISHED');
}
```

- [ ] **Step 5: Run the check**

Run: `node supabase/verify/seed-foundation.mjs && node supabase/verify/admin-check.mjs`
Expected: `admin-check: PASS (93 assertions)` (86 + 7).

- [ ] **Step 6: Commit**

```bash
git add supabase/functions/pms-admin/publishing.ts supabase/functions/pms-admin/index.ts supabase/verify/admin-check.mjs
git commit -m "feat(admin-backend): bell-curve check + publish/revoke with distribution blocking"
```

---

### Task 4: Acknowledgement (employee) + concern resolution (HR)

**Files:**
- Create: `supabase/functions/pms-workflow/acknowledge.ts`
- Modify: `supabase/functions/pms-workflow/index.ts` (spread `ackHandlers`)
- Create: `supabase/functions/pms-admin/concerns.ts`
- Modify: `supabase/functions/pms-admin/index.ts` (spread `concernHandlers`)
- Modify: `supabase/verify/workflow-check.mjs` (add an acknowledgement section that publishes the closeout cycle first via admin, then employee accepts/concerns, then HR resolves through the admin fn)

**Interfaces:**
- Produces (pms-workflow) `ackHandlers`:
  - `ack.get {orgId, cycleId}` → `{acknowledgement}` (own; null if none).
  - `ack.accept {orgId, cycleId}` → `{acknowledgement}` — requires snapshot `features.finalEmployeeAcceptanceEnabled` (else `ACK_NOT_ENABLED` 409), a live publication (else `NOT_PUBLISHED` 409), caller is the subject employee; upsert `decision='accepted'`; refuse if the existing row is already resolved (`ACK_RESOLVED` 409).
  - `ack.raise-concern {orgId, cycleId, reason}` → `{acknowledgement}` — same gates; upsert `decision='concern', resolution_status='open'`, required `reason`.
- Produces (pms-admin) `concernHandlers`:
  - `concern.resolve {orgId, cycleId, employeeId, resolution, note}` → `{acknowledgement}` — `hr_admin`/super; `resolution` ∈ `explained`/`recalibrated`; the row must be a `concern` with `resolution_status='open'` (else `NOT_OPEN` 409); set `resolution_status`, `resolution_note`, `resolved_by`, `resolved_at` (version-checked).

- [ ] **Step 1: Write the acknowledge module**

`supabase/functions/pms-workflow/acknowledge.ts`:

```ts
import { ApiError, Handler, HandlerCtx } from '../_shared/kernel.ts';
import { reqString, reqUuid } from '../_shared/validate.ts';
import { callerEmployeeId } from '../_shared/scope.ts';

async function ackGate(ctx: HandlerCtx, orgId: string, cycleId: string) {
  const { data: snap } = await ctx.admin.from('cycle_config_snapshots').select('snapshot').eq('cycle_id', cycleId).eq('organization_id', orgId).maybeSingle();
  const enabled = (snap?.snapshot?.features ?? {}).finalEmployeeAcceptanceEnabled === true;
  if (!enabled) throw new ApiError('ACK_NOT_ENABLED', 'Final acceptance is not enabled for this cycle', 409);
  const { data: pub } = await ctx.admin.from('cycle_publications').select('id').eq('cycle_id', cycleId).eq('organization_id', orgId).is('revoked_at', null).limit(1);
  if ((pub ?? []).length === 0) throw new ApiError('NOT_PUBLISHED', 'Results are not published', 409);
}

async function readAck(ctx: HandlerCtx, orgId: string, cycleId: string, employeeId: string) {
  const { data, error } = await ctx.admin.from('rating_acknowledgements')
    .select().eq('cycle_id', cycleId).eq('employee_id', employeeId).eq('organization_id', orgId).maybeSingle();
  if (error) { console.error('readAck', error); throw new ApiError('DB_ERROR', 'Database error', 500); }
  return data ?? null;
}

async function upsertAck(ctx: HandlerCtx, orgId: string, cycleId: string, employeeId: string, decision: string, reason: string | null) {
  const existing = await readAck(ctx, orgId, cycleId, employeeId);
  if (existing && existing.resolution_status && existing.resolution_status !== 'open') {
    throw new ApiError('ACK_RESOLVED', 'This acknowledgement has already been resolved and cannot be changed', 409);
  }
  const row = {
    organization_id: orgId, cycle_id: cycleId, employee_id: employeeId, decision, reason,
    resolution_status: decision === 'concern' ? 'open' : null, submitted_at: new Date().toISOString(),
  };
  const { data, error } = await ctx.admin.from('rating_acknowledgements')
    .upsert(row, { onConflict: 'cycle_id,employee_id' }).select().single();
  if (error) { console.error('upsertAck', error); throw new ApiError('DB_ERROR', 'Database error', 500); }
  return data;
}

export const ackHandlers: Record<string, Handler> = {
  'ack.get': async (payload, ctx) => {
    const orgId = reqUuid(payload.orgId, 'orgId');
    const cycleId = reqUuid(payload.cycleId, 'cycleId');
    const employeeId = callerEmployeeId(ctx, orgId);
    return { acknowledgement: await readAck(ctx, orgId, cycleId, employeeId) };
  },

  'ack.accept': async (payload, ctx) => {
    const orgId = reqUuid(payload.orgId, 'orgId');
    const cycleId = reqUuid(payload.cycleId, 'cycleId');
    const employeeId = callerEmployeeId(ctx, orgId);
    await ackGate(ctx, orgId, cycleId);
    const acknowledgement = await upsertAck(ctx, orgId, cycleId, employeeId, 'accepted', null);
    await ctx.audit({ organizationId: orgId, cycleId, action: 'ack.accept', entityType: 'rating_acknowledgement', entityId: acknowledgement.id, after: { decision: 'accepted' } });
    return { acknowledgement };
  },

  'ack.raise-concern': async (payload, ctx) => {
    const orgId = reqUuid(payload.orgId, 'orgId');
    const cycleId = reqUuid(payload.cycleId, 'cycleId');
    const reason = reqString(payload.reason, 'reason', 2000);
    const employeeId = callerEmployeeId(ctx, orgId);
    await ackGate(ctx, orgId, cycleId);
    const acknowledgement = await upsertAck(ctx, orgId, cycleId, employeeId, 'concern', reason);
    await ctx.audit({ organizationId: orgId, cycleId, action: 'ack.raise-concern', entityType: 'rating_acknowledgement', entityId: acknowledgement.id, after: { decision: 'concern' } });
    return { acknowledgement };
  },
};
```

- [ ] **Step 2: Write the concerns module (HR)**

`supabase/functions/pms-admin/concerns.ts`:

```ts
import { ApiError, Handler } from '../_shared/kernel.ts';
import { reqEnum, reqString, reqUuid } from '../_shared/validate.ts';

export const concernHandlers: Record<string, Handler> = {
  'concern.resolve': async (payload, ctx) => {
    const orgId = reqUuid(payload.orgId, 'orgId');
    ctx.requireOrgRole(orgId, ['hr_admin']);
    const cycleId = reqUuid(payload.cycleId, 'cycleId');
    const employeeId = reqUuid(payload.employeeId, 'employeeId');
    const resolution = reqEnum(payload.resolution, 'resolution', ['explained', 'recalibrated']);
    const note = reqString(payload.note, 'note', 2000);

    const { data: ack, error } = await ctx.admin.from('rating_acknowledgements')
      .select().eq('cycle_id', cycleId).eq('employee_id', employeeId).eq('organization_id', orgId).maybeSingle();
    if (error) { console.error('concern read', error); throw new ApiError('DB_ERROR', 'Database error', 500); }
    if (!ack) throw new ApiError('NOT_FOUND', 'No acknowledgement for this employee', 404);
    if (ack.decision !== 'concern' || ack.resolution_status !== 'open') {
      throw new ApiError('NOT_OPEN', 'Only an open concern can be resolved', 409);
    }
    const updated = await ctx.versionedUpdate('rating_acknowledgements', orgId, ack.id, ack.version, {
      resolution_status: resolution, resolution_note: note, resolved_by: ctx.userId, resolved_at: new Date().toISOString(),
    });
    await ctx.audit({ organizationId: orgId, cycleId, action: 'concern.resolve', entityType: 'rating_acknowledgement', entityId: ack.id, before: { resolution_status: 'open' }, after: { resolution_status: resolution }, note });
    return { acknowledgement: updated };
  },
};
```

- [ ] **Step 3: Wire both routers**

In `supabase/functions/pms-workflow/index.ts`: add `import { ackHandlers } from './acknowledge.ts';` and `...ackHandlers,`.
In `supabase/functions/pms-admin/index.ts`: add `import { concernHandlers } from './concerns.ts';` and `...concernHandlers,`.

- [ ] **Step 4: Deploy both**

Run: `supabase functions deploy pms-workflow && supabase functions deploy pms-admin`
Expected: both deployed.

- [ ] **Step 5: Add the acknowledgement section to `workflow-check.mjs`**

Before the final `console.log`, append (this publishes the closeout cycle via the admin fn using the HR token, then exercises accept→concern→resolve; note the closeout cycle's finals were calibrated to 3 in Task 2, and it has bell tolerance 100 so publish passes):

```js
// --- publish the closeout cycle, then employee accept / raise-concern / HR resolve ---
{
  const superT = tokens.superadmin; const hrT = tokens.hr;
  // Before publish: acceptance is blocked (NOT_PUBLISHED).
  const early = await callWorkflow(tokens.employee, 'ack.accept', { orgId: closeout.orgId, cycleId: closeout.cycleId });
  check('accept blocked before publish', early.status === 409 && early.body.error.code === 'NOT_PUBLISHED');

  const pub = await callAdmin(superT, 'publish.publish', { orgId: closeout.orgId, cycleId: closeout.cycleId });
  check('closeout cycle publishes (within tolerance)', pub.status === 200 && pub.body.data.cycle.status === 'published');

  // Now the employee can see their final rating (3b visibility seam).
  const finalView = await callWorkflow(tokens.employee, 'eval.get', { orgId: closeout.orgId, cycleId: closeout.cycleId, employeeId: closeout.emp.EMP002, stage: 'hr_final' });
  check('employee sees their final rating after publish', finalView.status === 200 && finalView.body.data.evaluation !== null);

  const concern = await callWorkflow(tokens.employee, 'ack.raise-concern', { orgId: closeout.orgId, cycleId: closeout.cycleId, reason: 'Expected higher' });
  check('employee raises a concern', concern.status === 200 && concern.body.data.acknowledgement.decision === 'concern' && concern.body.data.acknowledgement.resolution_status === 'open');

  const otherResolve = await callAdmin(tokens.employee, 'concern.resolve', { orgId: closeout.orgId, cycleId: closeout.cycleId, employeeId: closeout.emp.EMP002, resolution: 'explained', note: 'x' });
  check('employee cannot resolve a concern', otherResolve.status === 403);

  const resolve = await callAdmin(hrT, 'concern.resolve', { orgId: closeout.orgId, cycleId: closeout.cycleId, employeeId: closeout.emp.EMP002, resolution: 'explained', note: 'Discussed in 1:1' });
  check('HR resolves the concern (explained)', resolve.status === 200 && resolve.body.data.acknowledgement.resolution_status === 'explained');

  const afterResolved = await callWorkflow(tokens.employee, 'ack.accept', { orgId: closeout.orgId, cycleId: closeout.cycleId });
  check('a resolved acknowledgement cannot be changed', afterResolved.status === 409 && afterResolved.body.error.code === 'ACK_RESOLVED');
}
```

- [ ] **Step 6: Run the check**

Run: `node supabase/verify/seed-foundation.mjs && node supabase/verify/workflow-check.mjs`
Expected: `workflow-check: PASS (67 assertions)` (60 + 7).

- [ ] **Step 7: Commit**

```bash
git add supabase/functions/pms-workflow/acknowledge.ts supabase/functions/pms-workflow/index.ts supabase/functions/pms-admin/concerns.ts supabase/functions/pms-admin/index.ts supabase/verify/workflow-check.mjs
git commit -m "feat(workflow): employee acknowledge/concern + HR concern resolution"
```

---

### Task 5: Full smoke gate

**Files:**
- Modify: `supabase/verify/workflow-check.mjs` (add one `ack.get` read-back assertion) — small
- (No `run-all.mjs` change — admin-check + workflow-check already wired.)

**Interfaces:**
- Consumes: everything above. Confirms the full gate green with the new counts.

- [ ] **Step 1: Add an acknowledgement read-back assertion**

The accepted-decision happy path and the resolved-lock path are both already covered in Task 4. This step adds one read-back assertion confirming `ack.get` returns the employee's own resolved concern. Append before the final `console.log` in `workflow-check.mjs`:

```js
// --- ack.get reflects the resolved concern ---
{
  const got = await callWorkflow(tokens.employee, 'ack.get', { orgId: closeout.orgId, cycleId: closeout.cycleId });
  check('ack.get returns the employee\'s resolved acknowledgement', got.status === 200 && got.body.data.acknowledgement.decision === 'concern' && got.body.data.acknowledgement.resolution_status === 'explained');
}
```

- [ ] **Step 2: Run the full gate**

Run: `node supabase/verify/run-all.mjs`
Expected: all six scripts pass — `admin-check: PASS (93 assertions)`, `workflow-check: PASS (68 assertions)` (67 + 1) — final `FOUNDATION SMOKE: ALL PASS`, exit 0. (Run in background if it exceeds the 2-minute foreground limit.)

- [ ] **Step 3: Run lint**

Run: `npm run lint`
Expected: no NEW problems under `supabase/**` (pre-existing `src/` findings out of scope — note, don't fix).

- [ ] **Step 4: Commit**

```bash
git add supabase/verify/workflow-check.mjs
git commit -m "test(workflow): acknowledgement read-back + full closeout gate"
```

---

## Out of Scope (later plans)

- Plan 4: job worker — drains `email_jobs` (invite/reminder/publish-notification emails) and `background_jobs`; exports; the publish action here does NOT send emails (a later job does).
- Plan 5: screens — wizard/dashboards/portal rewired to `callPms`/`callWorkflow` + RLS reads; the first-login set-password flow.
- Plan 6: cutover — delete `app_state` blob usage, localStorage sync, old edge functions; final lockdown; the dashboard "disable signups" toggle.
- Recalibration-after-concern automation (concern.resolve `recalibrated` currently just records the status; the actual re-score is a separate `calibration.adjust` + re-publish) — a future UX convenience.

Nothing in this plan modifies old-world files, adds tables, or runs migrations.
