# Rebuild Plan 3b: Evaluations & Scoring Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The rating half of the appraisal — self, manager, HOD, and HR-final evaluations of an employee's approved goals (and competencies), with achievement %, auto-rating, and overall score computed and stored server-side, stage-authorized, phase-gated, versioned, and audited.

**Architecture:** Extends the existing `pms-workflow` edge function (built in Plan 3a) with an evaluation domain (`evals.ts`) and a pure scoring engine (`_shared/scoring.ts`). Each of the four stages is one row in `pms.evaluations` (unique per cycle+employee+stage); per-goal-item and per-competency scores live in `evaluation_goal_scores` / `evaluation_competency_scores`. Scoring is deterministic and pure: achievement % from actual-vs-target (honoring `lower_is_better`), a rating from the cycle's auto-rating bands, KPI→KRA→overall weighted roll-up, and a competency-weighted blend. The evaluation's `version` is the optimistic-lock token; the goal plan must be `approved` before any stage opens.

**Tech Stack:** Supabase edge functions (Deno, `npm:@supabase/supabase-js@2`), Postgres, Node verify scripts with `node:assert`, Supabase CLI (linked project `mkjtdwrzmobahwkpumxx`).

**Spec:** `docs/superpowers/specs/2026-07-03-server-first-rebuild-design.md` §4.3.3 (target types / `lowerIsBetter`), §4.3.4 (rating scale, frozen per cycle), §4.3.5 (auto-rating bands), §4.3.10 (competencies), §4.3.12 (HOD stage `hod` / HR final `hr_final`), §5 (permissions: employee self-rates; manager rates direct reports; HOD mapped dept; HR final), §7 (phase windows self_evaluation / manager_evaluation / hod_review / hr_calibration).

## Scoring Model (authoritative — implement exactly this)

- **Scored level:** the group's `rating_level` (`kpi` default, or `kra`). When `kpi`, KPIs carry scores and roll up into their KRA; when `kra`, KRAs carry scores directly (their KPIs are informational).
- **Achievement %** (per scored item, when the evaluator supplies a numeric `achievementValue` and the item has a numeric `targetValue` whose `target_type_key` resolves to a `cycle_target_types` row with `is_numeric = true`):
  - `lower_is_better = false`: `pct = actual / target * 100`
  - `lower_is_better = true`: `pct = target / actual * 100` (if `actual = 0`, pct = 200)
  - clamp to `[0, 200]`; round to 2 decimals. Non-numeric target, missing value, or `target = 0` (upper-is-better) → `pct = null` (manual score required).
- **Auto rating** (per scored item, when `pct` is non-null and the cycle has auto-rating bands): the `score` of the band whose `[from_percent, to_percent]` contains `pct` (inclusive); if none contains it, the nearest band by distance; if no bands, null.
- **Stored item score:** the evaluator's manual `score` if provided, else the auto rating. (Both stages may override; there is no separate "override allowed" gate in 3b — the evaluator's explicit score always wins.)
- **KRA roll-up** (only when `rating_level = kpi`): a KRA's score = weight-average of its KPI scores by KPI `weight` (KPIs with null weight are treated as equal weight); a KRA with no scored KPIs is skipped.
- **Goal score:** weight-average of KRA scores by KRA `weight` (null weight → equal). When `rating_level = kra`, use the KRA scores directly.
- **Competency score** (only when `cycle_competency_config.enabled`): plain average of the stage's competency scores that are non-null.
- **Overall score:** competencies enabled AND a competency score exists → `goal * (1 - cw/100) + competency * (cw/100)` where `cw = competency_weight` (0 if null); competencies disabled, OR enabled but no competency score yet → `goal` (goal-only; do NOT deflate the overall for competencies the evaluator hasn't scored). Round to 2 decimals. If nothing is scored, overall = null.

## Global Constraints

- **Write rule:** browser reads via RLS only; ALL business writes go through backend functions. No new grants to `anon`. **No new tables and no migrations in this plan** (all evaluation tables exist from Plan 1's `2026070313_pms_workflow.sql`; scoring inputs from Plan 2's cycle tables). No SECURITY DEFINER RPCs.
- **Kernel contract (binding):** response `{ ok: true, data } | { ok: false, error: { code, message } }`; stale version → `CONFLICT` 409 "someone else changed this — reload"; `versionedUpdate(table, orgId, id, expectedVersion, patch)` is org-scoped; raw DB errors never reach clients (`console.error` + generic `DB_ERROR` 500). Validators in `_shared/validate.ts`.
- **3a helpers (reuse, don't duplicate):** `_shared/scope.ts` — `callerEmployeeId`, `isHrOrSuper`, `manages`, `isHodOf`; `_shared/phase.ts` — `loadActiveCycle`, `requireWindowOrHr`. Auth check runs BEFORE `loadActiveCycle` (3a convention — closes the existence oracle).
- **Stage authorization (binding):** `self` → caller is the employee (own); `manager` → `manages(caller, employee)`; `hod` → `isHodOf(caller, employee)`; `hr_final` → `isHrOrSuper`. Manager/HOD are DERIVED from `reporting_relationships`, never roles. HR/super may act on any stage (override) but the row's `stage` still records which stage.
- **Phase windows (binding):** `self` gated by `self_evaluation`; `manager` by `manager_evaluation`; `hod` by `hod_review`; `hr_final` by `hr_calibration`. HR/super bypass windows. Closed → `WINDOW_CLOSED` 409.
- **Prerequisites (binding):** an evaluation can be created/edited only when the employee's `employee_goal_plans` row is `approved` (else `GOALS_NOT_APPROVED` 409). The `manager` stage additionally requires the `self` stage `submitted` (else `SELF_NOT_SUBMITTED` 409). `hod` requires `manager` submitted; `hr_final` requires `manager` submitted. (self has no prerequisite beyond approved goals.)
- **Cycle status:** evaluations require cycle `active` OR `review` (self/manager typically in active; hod/hr_final in review). Wrong status → `CYCLE_NOT_EVALUABLE` 409. Use a shared `loadEvaluableCycle` (accepts active/review).
- **Score visibility (binding, honors the snapshot):** reading another employee's `manager`/`hr_final` evaluation follows the same rule as the RLS `stage_visible` — the reader sees a submitted manager/final stage only when the snapshot `visibility.manager_rating_visible` / `visibility.final_rating_visible` allows it (immediate / after a non-revoked publication / never). The employee always sees their own `self`; managers/HOD always see stages of their reports. Enforce in `eval.get`.
- **Frozen scale (binding):** all scoring reads the cycle's own `cycle_rating_scale_levels` / `cycle_auto_rating_bands` / `cycle_target_types` — never a global default — so historical results never shift.
- Every handler: validate → resolve caller + target scope (auth first) → cycle-status/prereq/phase gate → compute scores → version-checked write → audit → typed response.
- Repo has unrelated dirty old-app files: stage ONLY each task's files by explicit path. `.env` gitignored, never printed/committed. Old-world files (old edge functions, `public` schema, `src/`) untouched. `pms-admin` untouched.
- Branch: `rebuild-3b-evaluations` in an ISOLATED WORKTREE off pushed `main` (never build in the dirty parent folder). Copy the 7 untracked old-app migrations (`2026062501..2026070301`) into the worktree so `supabase db push` reconciles (this plan pushes no migrations, but keep the worktree consistent). Wire `.env`, symlink `node_modules`, copy `supabase/.temp`.
- Commit trailer on every commit: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`
- Verify counts at branch start: `admin-check` 86, `rls-check` 55, `workflow-check` 27. This plan grows `workflow-check`; each task states its expected total.

---

### Task 1: Pure scoring engine

**Files:**
- Create: `supabase/functions/_shared/scoring.ts`
- Create: `supabase/functions/_shared/scoring.test.ts`

**Interfaces:**
- Produces (used by Tasks 3–4):
  - `achievementPercent(actual: number | null, target: number | null, lowerIsBetter: boolean) → number | null`
  - `ratingFromBands(pct: number | null, bands: Band[]) → number | null` where `Band = { from_percent, to_percent, score }`
  - `type ScoredItem = { itemId: string; itemType: 'kra' | 'kpi'; parentId: string | null; weight: number | null; score: number | null }`
  - `computeGoalScore(items: ScoredItem[], ratingLevel: 'kra' | 'kpi') → number | null`
  - `computeOverall(goalScore: number | null, competencyScore: number | null, competenciesEnabled: boolean, competencyWeight: number | null) → number | null`
  - `round2(n: number) → number`

- [ ] **Step 1: Write failing tests**

`supabase/functions/_shared/scoring.test.ts`:

```ts
import { assertEquals } from 'jsr:@std/assert@1';
import {
  achievementPercent, computeGoalScore, computeOverall, ratingFromBands, round2,
} from './scoring.ts';

Deno.test('achievementPercent upper-is-better', () => {
  assertEquals(achievementPercent(80, 100, false), 80);
  assertEquals(achievementPercent(120, 100, false), 120);
  assertEquals(achievementPercent(250, 100, false), 200); // clamp
});

Deno.test('achievementPercent lower-is-better', () => {
  assertEquals(achievementPercent(5, 10, true), 200);   // target/actual capped
  assertEquals(achievementPercent(10, 10, true), 100);
  assertEquals(achievementPercent(20, 10, true), 50);
  assertEquals(achievementPercent(0, 10, true), 200);   // actual 0 → best
});

Deno.test('achievementPercent null cases', () => {
  assertEquals(achievementPercent(null, 100, false), null);
  assertEquals(achievementPercent(80, null, false), null);
  assertEquals(achievementPercent(80, 0, false), null);  // divide by zero, upper
});

Deno.test('ratingFromBands picks the containing band, then nearest', () => {
  const bands = [
    { from_percent: 0, to_percent: 59, score: 2 },
    { from_percent: 60, to_percent: 89, score: 3 },
    { from_percent: 90, to_percent: 200, score: 5 },
  ];
  assertEquals(ratingFromBands(75, bands), 3);
  assertEquals(ratingFromBands(90, bands), 5);
  assertEquals(ratingFromBands(59, bands), 2);
  assertEquals(ratingFromBands(null, bands), null);
  assertEquals(ratingFromBands(75, []), null);
});

Deno.test('computeGoalScore rolls KPIs into KRAs into overall (kpi level)', () => {
  // KRA a (weight 60): kpi a1(w100,score4). KRA b (weight 40): kpi b1(w100,score2).
  const items = [
    { itemId: 'a', itemType: 'kra' as const, parentId: null, weight: 60, score: null },
    { itemId: 'a1', itemType: 'kpi' as const, parentId: 'a', weight: 100, score: 4 },
    { itemId: 'b', itemType: 'kra' as const, parentId: null, weight: 40, score: null },
    { itemId: 'b1', itemType: 'kpi' as const, parentId: 'b', weight: 100, score: 2 },
  ];
  // a=4, b=2 → 4*0.6 + 2*0.4 = 3.2
  assertEquals(computeGoalScore(items, 'kpi'), 3.2);
});

Deno.test('computeGoalScore at kra level uses KRA scores directly', () => {
  const items = [
    { itemId: 'a', itemType: 'kra' as const, parentId: null, weight: 50, score: 4 },
    { itemId: 'b', itemType: 'kra' as const, parentId: null, weight: 50, score: 3 },
  ];
  assertEquals(computeGoalScore(items, 'kra'), 3.5);
});

Deno.test('computeGoalScore null when nothing scored', () => {
  assertEquals(computeGoalScore([{ itemId: 'a', itemType: 'kra', parentId: null, weight: 100, score: null }], 'kra'), null);
});

Deno.test('computeOverall blends competencies', () => {
  assertEquals(computeOverall(4, 2, true, 25), 3.5);   // 4*0.75 + 2*0.25
  assertEquals(computeOverall(4, 2, false, 25), 4);    // disabled → goal
  assertEquals(computeOverall(4, null, true, 25), 4);  // enabled but no competency score yet → goal-only (don't deflate for unscored competencies)
});

Deno.test('round2', () => {
  assertEquals(round2(3.14159), 3.14);
  assertEquals(round2(3.2), 3.2);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `deno test supabase/functions/_shared/scoring.test.ts`
Expected: FAIL — `Module not found ... scoring.ts`.

- [ ] **Step 3: Implement `scoring.ts`**

`supabase/functions/_shared/scoring.ts`:

```ts
export type Band = { from_percent: number; to_percent: number; score: number };
export type ScoredItem = {
  itemId: string; itemType: 'kra' | 'kpi'; parentId: string | null;
  weight: number | null; score: number | null;
};

export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

export function achievementPercent(actual: number | null, target: number | null, lowerIsBetter: boolean): number | null {
  if (actual == null || target == null) return null;
  let pct: number;
  if (lowerIsBetter) {
    if (actual === 0) return 200;
    pct = (target / actual) * 100;
  } else {
    if (target === 0) return null;
    pct = (actual / target) * 100;
  }
  pct = Math.max(0, Math.min(200, pct));
  return round2(pct);
}

export function ratingFromBands(pct: number | null, bands: Band[]): number | null {
  if (pct == null || bands.length === 0) return null;
  const containing = bands.find((b) => pct >= b.from_percent && pct <= b.to_percent);
  if (containing) return containing.score;
  // nearest by distance to the band range
  let best: Band | null = null;
  let bestDist = Infinity;
  for (const b of bands) {
    const dist = pct < b.from_percent ? b.from_percent - pct : pct - b.to_percent;
    if (dist < bestDist) { bestDist = dist; best = b; }
  }
  return best ? best.score : null;
}

// Weight-average a set of {weight, score}; null weights count as equal (1).
function weightedAverage(entries: { weight: number | null; score: number | null }[]): number | null {
  const scored = entries.filter((e) => e.score != null);
  if (scored.length === 0) return null;
  const anyWeight = scored.some((e) => e.weight != null && e.weight > 0);
  let num = 0, den = 0;
  for (const e of scored) {
    const w = anyWeight ? (e.weight ?? 0) : 1;
    num += w * (e.score as number);
    den += w;
  }
  return den === 0 ? null : num / den;
}

export function computeGoalScore(items: ScoredItem[], ratingLevel: 'kra' | 'kpi'): number | null {
  const kras = items.filter((i) => i.itemType === 'kra');
  if (ratingLevel === 'kra') {
    const avg = weightedAverage(kras.map((k) => ({ weight: k.weight, score: k.score })));
    return avg == null ? null : round2(avg);
  }
  // kpi level: roll each KRA's KPIs up, then average the KRA rollups
  const kraScores: { weight: number | null; score: number | null }[] = kras.map((kra) => {
    const kpis = items.filter((i) => i.itemType === 'kpi' && i.parentId === kra.itemId);
    const rolled = weightedAverage(kpis.map((k) => ({ weight: k.weight, score: k.score })));
    return { weight: kra.weight, score: rolled };
  });
  const avg = weightedAverage(kraScores);
  return avg == null ? null : round2(avg);
}

export function computeOverall(
  goalScore: number | null, competencyScore: number | null,
  competenciesEnabled: boolean, competencyWeight: number | null,
): number | null {
  if (!competenciesEnabled || competencyScore == null) {
    return goalScore == null ? null : round2(goalScore);
  }
  const cw = (competencyWeight ?? 0) / 100;
  const g = goalScore ?? 0;
  return round2(g * (1 - cw) + competencyScore * cw);
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `deno test supabase/functions/_shared/scoring.test.ts`
Expected: `ok | 9 passed | 0 failed`.

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/_shared/scoring.ts supabase/functions/_shared/scoring.test.ts
git commit -m "feat(workflow): pure scoring engine (achievement %, bands, roll-up, overall)"
```

---

### Task 2: Evaluation read + ensure (seed score rows)

**Files:**
- Create: `supabase/functions/pms-workflow/evals.ts`
- Modify: `supabase/functions/pms-workflow/index.ts` (spread `evalHandlers`)
- Modify: `supabase/verify/workflow-check.mjs` (extend the fixture to an evaluable cycle + add an eval get/ensure section)

**Interfaces:**
- Consumes: kernel, validators, `_shared/scope.ts`, `_shared/phase.ts`.
- Produces:
  - Shared: `loadEvaluableCycle(ctx, orgId, cycleId)` → cycle row (throws `NOT_FOUND` 404 / `CYCLE_NOT_EVALUABLE` 409 unless status ∈ `active`/`review`); `STAGE_WINDOW` map (`self→self_evaluation`, `manager→manager_evaluation`, `hod→hod_review`, `hr_final→hr_calibration`); `assertStageAuth(ctx, orgId, employeeId, stage)` (self=own, manager=manages, hod=isHodOf, hr_final=HR; HR bypass on all; else `FORBIDDEN` 403); `assertPrereqs(ctx, orgId, cycleId, employeeId, stage)` (goals approved; manager/hod/hr_final need self/manager submitted per the Global Constraints).
  - `eval.get {orgId, cycleId, employeeId, stage}` → `{evaluation, goalScores, competencyScores}` (visibility-gated per the score-visibility rule; own-self always; else `FORBIDDEN`). `{evaluation:null}` if none.
  - `eval.ensure {orgId, cycleId, stage}` → `{evaluation, goalScores, competencyScores, seeded}` — creates the caller's (or, for manager/hod/hr_final acting on a report, the passed `employeeId`) evaluation row for the stage if absent, seeding one `evaluation_goal_scores` row per scored goal item (per `rating_level`) and one `evaluation_competency_scores` row per the plan's competencies (when competencies enabled). `eval.ensure` payload is `{orgId, cycleId, stage, employeeId?}` — `employeeId` defaults to the caller's own (self); required for manager/hod/hr_final.

- [ ] **Step 1: Write the evals module (read + ensure)**

`supabase/functions/pms-workflow/evals.ts`:

```ts
import { ApiError, Handler, HandlerCtx } from '../_shared/kernel.ts';
import { optUuid, reqEnum, reqUuid } from '../_shared/validate.ts';
import { callerEmployeeId, isHodOf, isHrOrSuper, manages } from '../_shared/scope.ts';

export const STAGES = ['self', 'manager', 'hod', 'hr_final'];
export const STAGE_WINDOW: Record<string, string> = {
  self: 'self_evaluation', manager: 'manager_evaluation', hod: 'hod_review', hr_final: 'hr_calibration',
};

export async function loadEvaluableCycle(ctx: HandlerCtx, orgId: string, cycleId: string) {
  const { data: cycle, error } = await ctx.admin.from('appraisal_cycles')
    .select().eq('id', cycleId).eq('organization_id', orgId).maybeSingle();
  if (error) { console.error('loadEvaluableCycle', error); throw new ApiError('DB_ERROR', 'Database error', 500); }
  if (!cycle) throw new ApiError('NOT_FOUND', 'Cycle not found', 404);
  if (!['active', 'review'].includes(cycle.status)) {
    throw new ApiError('CYCLE_NOT_EVALUABLE', `The cycle is ${cycle.status}; evaluations are not open`, 409);
  }
  return cycle;
}

export async function assertStageAuth(ctx: HandlerCtx, orgId: string, employeeId: string, stage: string): Promise<void> {
  if (isHrOrSuper(ctx, orgId)) return;
  if (stage === 'self') {
    if (callerEmployeeId(ctx, orgId) === employeeId) return;
  } else if (stage === 'manager') {
    if (await manages(ctx, orgId, employeeId)) return;
  } else if (stage === 'hod') {
    if (await isHodOf(ctx, orgId, employeeId)) return;
  } else if (stage === 'hr_final') {
    // HR-only; already returned above for HR/super.
  }
  throw new ApiError('FORBIDDEN', `You cannot act on the ${stage} evaluation for this employee`, 403);
}

async function stageStatus(ctx: HandlerCtx, cycleId: string, employeeId: string, stage: string): Promise<string | null> {
  const { data } = await ctx.admin.from('evaluations')
    .select('status').eq('cycle_id', cycleId).eq('employee_id', employeeId).eq('stage', stage).maybeSingle();
  return data?.status ?? null;
}

export async function assertPrereqs(ctx: HandlerCtx, orgId: string, cycleId: string, employeeId: string, stage: string): Promise<void> {
  const { data: plan, error } = await ctx.admin.from('employee_goal_plans')
    .select('status').eq('cycle_id', cycleId).eq('employee_id', employeeId).eq('organization_id', orgId).maybeSingle();
  if (error) { console.error('assertPrereqs plan', error); throw new ApiError('DB_ERROR', 'Database error', 500); }
  if (!plan || plan.status !== 'approved') throw new ApiError('GOALS_NOT_APPROVED', 'The employee\'s goals must be approved first', 409);
  if (stage === 'manager' && (await stageStatus(ctx, cycleId, employeeId, 'self')) !== 'submitted') {
    throw new ApiError('SELF_NOT_SUBMITTED', 'The self evaluation must be submitted first', 409);
  }
  if ((stage === 'hod' || stage === 'hr_final') && (await stageStatus(ctx, cycleId, employeeId, 'manager')) !== 'submitted') {
    throw new ApiError('MANAGER_NOT_SUBMITTED', 'The manager evaluation must be submitted first', 409);
  }
}

async function readEvalBundle(ctx: HandlerCtx, orgId: string, cycleId: string, employeeId: string, stage: string) {
  const { data: evaluation, error } = await ctx.admin.from('evaluations')
    .select().eq('cycle_id', cycleId).eq('employee_id', employeeId).eq('stage', stage).eq('organization_id', orgId).maybeSingle();
  if (error) { console.error('readEval', error); throw new ApiError('DB_ERROR', 'Database error', 500); }
  if (!evaluation) return { evaluation: null, goalScores: [], competencyScores: [] };
  const { data: gs } = await ctx.admin.from('evaluation_goal_scores').select().eq('evaluation_id', evaluation.id);
  const { data: cs } = await ctx.admin.from('evaluation_competency_scores').select().eq('evaluation_id', evaluation.id);
  return { evaluation, goalScores: gs ?? [], competencyScores: cs ?? [] };
}

// Score-visibility for reading someone else's manager/hr_final stage (mirrors RLS stage_visible).
async function visibleToReader(ctx: HandlerCtx, orgId: string, cycleId: string, employeeId: string, stage: string): Promise<boolean> {
  if (isHrOrSuper(ctx, orgId)) return true;
  const me = ctx.memberships.find((m) => m.organizationId === orgId)?.employeeId ?? null;
  const isOwn = me === employeeId;
  const isMgr = await manages(ctx, orgId, employeeId);
  const isHod = await isHodOf(ctx, orgId, employeeId);
  if (stage === 'self') return isOwn || isMgr || isHod;
  if (stage === 'hod') return isHod;
  if (stage === 'manager' || stage === 'hr_final') {
    if (isMgr || isHod) return true;
    if (!isOwn) return false;
    // own view of manager/final: gated by the snapshot visibility + publication
    const key = stage === 'manager' ? 'manager_rating_visible' : 'final_rating_visible';
    const { data: snap } = await ctx.admin.from('cycle_config_snapshots').select('snapshot').eq('cycle_id', cycleId).maybeSingle();
    const v = (snap?.snapshot?.visibility ?? {})[key] ?? 'after_publish';
    if (v === 'never') return false;
    if (v === 'immediate') return true;
    const { data: pub } = await ctx.admin.from('cycle_publications').select('id').eq('cycle_id', cycleId).is('revoked_at', null).limit(1);
    return (pub ?? []).length > 0;
  }
  return false;
}

export const evalHandlers: Record<string, Handler> = {
  'eval.get': async (payload, ctx) => {
    const orgId = reqUuid(payload.orgId, 'orgId');
    const cycleId = reqUuid(payload.cycleId, 'cycleId');
    const employeeId = reqUuid(payload.employeeId, 'employeeId');
    const stage = reqEnum(payload.stage, 'stage', STAGES);
    if (!(await visibleToReader(ctx, orgId, cycleId, employeeId, stage))) {
      throw new ApiError('FORBIDDEN', 'You cannot view this evaluation', 403);
    }
    return await readEvalBundle(ctx, orgId, cycleId, employeeId, stage);
  },

  'eval.ensure': async (payload, ctx) => {
    const orgId = reqUuid(payload.orgId, 'orgId');
    const cycleId = reqUuid(payload.cycleId, 'cycleId');
    const stage = reqEnum(payload.stage, 'stage', STAGES);
    const employeeId = optUuid(payload.employeeId, 'employeeId') ?? callerEmployeeId(ctx, orgId);
    await assertStageAuth(ctx, orgId, employeeId, stage);
    await loadEvaluableCycle(ctx, orgId, cycleId);
    await assertPrereqs(ctx, orgId, cycleId, employeeId, stage);

    const existing = await readEvalBundle(ctx, orgId, cycleId, employeeId, stage);
    if (existing.evaluation) return { ...existing, seeded: 0 };

    const { data: evaluation, error } = await ctx.admin.from('evaluations')
      .insert({ organization_id: orgId, cycle_id: cycleId, employee_id: employeeId, stage, status: 'draft' })
      .select().single();
    if (error) {
      if (error.code === '23505') { const again = await readEvalBundle(ctx, orgId, cycleId, employeeId, stage); return { ...again, seeded: 0 }; }
      console.error('eval.ensure insert', error); throw new ApiError('DB_ERROR', 'Database error', 500);
    }
    let seeded = 0;
    try {
      seeded = await seedScores(ctx, orgId, cycleId, employeeId, evaluation.id);
    } catch (err) {
      await ctx.admin.from('evaluations').delete().eq('id', evaluation.id).eq('organization_id', orgId);
      throw err;
    }
    await ctx.audit({ organizationId: orgId, cycleId, action: 'eval.ensure', entityType: 'evaluation', entityId: evaluation.id, note: `${stage}: seeded ${seeded}` });
    const bundle = await readEvalBundle(ctx, orgId, cycleId, employeeId, stage);
    return { ...bundle, seeded };
  },
};

// Seed a goal-score row per scored item (per rating_level) + a competency-score row per plan competency.
async function seedScores(ctx: HandlerCtx, orgId: string, cycleId: string, employeeId: string, evaluationId: string): Promise<number> {
  const { data: plan, error: pErr } = await ctx.admin.from('employee_goal_plans')
    .select('id').eq('cycle_id', cycleId).eq('employee_id', employeeId).eq('organization_id', orgId).maybeSingle();
  if (pErr) { console.error('seedScores plan', pErr); throw new ApiError('DB_ERROR', 'Database error', 500); }
  if (!plan) return 0;
  const ratingLevel = await ratingLevelFor(ctx, cycleId, employeeId);
  const { data: items, error: iErr } = await ctx.admin.from('employee_goal_items')
    .select('id, item_type').eq('plan_id', plan.id);
  if (iErr) { console.error('seedScores items', iErr); throw new ApiError('DB_ERROR', 'Database error', 500); }
  const scored = (items ?? []).filter((i) => i.item_type === ratingLevel);
  let seeded = 0;
  if (scored.length) {
    const { error } = await ctx.admin.from('evaluation_goal_scores').insert(
      scored.map((it) => ({ organization_id: orgId, cycle_id: cycleId, evaluation_id: evaluationId, goal_item_id: it.id })),
    );
    if (error) { console.error('seedScores goal', error); throw new ApiError('DB_ERROR', 'Database error', 500); }
    seeded += scored.length;
  }
  const { data: cfg } = await ctx.admin.from('cycle_competency_config').select('enabled').eq('cycle_id', cycleId).maybeSingle();
  if (cfg?.enabled) {
    const { data: comps } = await ctx.admin.from('employee_goal_plan_competencies').select('competency_name').eq('plan_id', plan.id);
    if ((comps ?? []).length) {
      const { error } = await ctx.admin.from('evaluation_competency_scores').insert(
        (comps ?? []).map((c) => ({ organization_id: orgId, cycle_id: cycleId, evaluation_id: evaluationId, competency_name: c.competency_name })),
      );
      if (error) { console.error('seedScores comp', error); throw new ApiError('DB_ERROR', 'Database error', 500); }
      seeded += (comps ?? []).length;
    }
  }
  return seeded;
}

export async function ratingLevelFor(ctx: HandlerCtx, cycleId: string, employeeId: string): Promise<'kra' | 'kpi'> {
  const { data: assign } = await ctx.admin.from('cycle_participant_assignments').select('group_id').eq('cycle_id', cycleId).eq('employee_id', employeeId).maybeSingle();
  if (!assign?.group_id) return 'kpi';
  const { data: group } = await ctx.admin.from('cycle_groups').select('rating_level').eq('id', assign.group_id).maybeSingle();
  return (group?.rating_level === 'kra' ? 'kra' : 'kpi');
}
```

- [ ] **Step 2: Wire the router**

In `supabase/functions/pms-workflow/index.ts`, add `import { evalHandlers } from './evals.ts';` and `...evalHandlers,` to `serveActions` (keep existing whoami + goalHandlers + goalFlowHandlers).

- [ ] **Step 3: Deploy**

Run: `supabase functions deploy pms-workflow`
Expected: deployed.

- [ ] **Step 4: Add a standalone eval-cycle fixture + the eval get/ensure section**

IMPORTANT — do NOT extend `setupActiveCycle()`. The 3a goal sections already own EMP002's plan on that cycle and 3a's last section archives it. Instead add a NEW self-contained `setupEvalCycle()` that stands up a fresh active cycle for acme with EMP002 already `approved` with numeric-target goals + a frozen scale/bands, and call it at the top of the eval section (it runs AFTER all 3a sections). Add this helper anywhere after `setupActiveCycle` in `workflow-check.mjs`:

```js
// Fresh active cycle for the evaluation tests: EMP002 has an APPROVED plan with
// 2 KRAs (each one numeric-target KPI), a frozen rating scale + auto bands, and
// self/manager_evaluation windows open. Self-contained; archives acme's working cycle first.
export async function setupEvalCycle() {
  const { data: org } = await admin.from('organizations').select('id').eq('key', 'acme-test').single();
  const emp = {};
  for (const code of ['EMP001', 'EMP002', 'EMP003']) {
    const { data } = await admin.from('employees').select('id').eq('organization_id', org.id).eq('employee_code', code).single();
    emp[code] = data.id;
  }
  await admin.from('appraisal_cycles').update({ status: 'archived', archived_at: new Date().toISOString() })
    .eq('organization_id', org.id).neq('status', 'archived');
  const { data: cycle } = await admin.from('appraisal_cycles').insert({
    organization_id: org.id, name: 'Eval Cycle', framework_id: 'kra-kpi', status: 'active', activated_at: new Date().toISOString(),
  }).select().single();
  const iso2 = (d) => d.toISOString().slice(0, 10);
  const pastW = iso2(new Date(Date.now() - 3 * 864e5));
  const futW = iso2(new Date(Date.now() + 30 * 864e5));
  await admin.from('cycle_phase_windows').insert([
    { organization_id: org.id, cycle_id: cycle.id, window_key: 'self_evaluation', starts_on: pastW, ends_on: futW },
    { organization_id: org.id, cycle_id: cycle.id, window_key: 'manager_evaluation', starts_on: pastW, ends_on: futW },
  ]);
  await admin.from('cycle_rating_scale_levels').insert([
    { organization_id: org.id, cycle_id: cycle.id, point: 2, label: 'Below', range_from: 0, range_to: 59 },
    { organization_id: org.id, cycle_id: cycle.id, point: 3, label: 'Meets', range_from: 60, range_to: 89 },
    { organization_id: org.id, cycle_id: cycle.id, point: 5, label: 'Exceeds', range_from: 90, range_to: 200 },
  ]);
  await admin.from('cycle_auto_rating_bands').insert([
    { organization_id: org.id, cycle_id: cycle.id, from_percent: 0, to_percent: 59, score: 2 },
    { organization_id: org.id, cycle_id: cycle.id, from_percent: 60, to_percent: 89, score: 3 },
    { organization_id: org.id, cycle_id: cycle.id, from_percent: 90, to_percent: 200, score: 5 },
  ]);
  await admin.from('cycle_target_types').insert({
    organization_id: org.id, cycle_id: cycle.id, target_type_key: 'number', name: 'Number', is_numeric: true, lower_is_better: false,
  });
  // EMP002 assigned to a rating_level=kpi group (so KPIs carry scores).
  const { data: group } = await admin.from('cycle_groups').insert({
    organization_id: org.id, cycle_id: cycle.id, name: 'Sales', target_level: 'kpi', rating_level: 'kpi',
  }).select().single();
  const { data: part } = await admin.from('cycle_participants').insert({
    organization_id: org.id, cycle_id: cycle.id, employee_id: emp.EMP002,
  }).select().single();
  await admin.from('cycle_participant_assignments').insert({
    organization_id: org.id, cycle_id: cycle.id, participant_id: part.id, employee_id: emp.EMP002, group_id: group.id,
  });
  const { data: eplan } = await admin.from('employee_goal_plans').insert({
    organization_id: org.id, cycle_id: cycle.id, employee_id: emp.EMP002, status: 'approved', approved_at: new Date().toISOString(),
  }).select().single();
  const mk = async (fields) => (await admin.from('employee_goal_items').insert({
    organization_id: org.id, cycle_id: cycle.id, plan_id: eplan.id, employee_id: emp.EMP002, ...fields,
  }).select().single()).data;
  const kraA = await mk({ item_type: 'kra', title: 'Revenue', weight: 60, display_order: 0 });
  await mk({ item_type: 'kpi', parent_item_id: kraA.id, title: 'New ARR', weight: 100, target_type_key: 'number', target_value: '100', display_order: 1 });
  const kraB = await mk({ item_type: 'kra', title: 'Retention', weight: 40, display_order: 2 });
  await mk({ item_type: 'kpi', parent_item_id: kraB.id, title: 'Churn', weight: 100, target_type_key: 'number', target_value: '100', display_order: 3 });
  return { orgId: org.id, cycleId: cycle.id, emp, planId: eplan.id };
}
```

Then append this section before the final `console.log` (it creates `evalFixture` used by all 3b sections):

```js
// ============ EVALUATIONS (Plan 3b) ============
export const evalFixture = await setupEvalCycle();

// --- eval.ensure seeds score rows; eval.get reads them (self stage) ---
{
  const ensure = await callWorkflow(tokens.employee, 'eval.ensure', { orgId: evalFixture.orgId, cycleId: evalFixture.cycleId, stage: 'self' });
  check('eval.ensure creates a draft self evaluation', ensure.status === 200 && ensure.body.data.evaluation.stage === 'self' && ensure.body.data.evaluation.status === 'draft');
  check('eval.ensure seeds a goal-score row per KPI (2)', ensure.body.data.goalScores.length === 2);

  const again = await callWorkflow(tokens.employee, 'eval.ensure', { orgId: evalFixture.orgId, cycleId: evalFixture.cycleId, stage: 'self' });
  check('eval.ensure is idempotent (seeded 0)', again.status === 200 && again.body.data.seeded === 0);

  const get = await callWorkflow(tokens.employee, 'eval.get', { orgId: evalFixture.orgId, cycleId: evalFixture.cycleId, employeeId: evalFixture.emp.EMP002, stage: 'self' });
  check('eval.get returns own self evaluation', get.status === 200 && get.body.data.goalScores.length === 2);

  const mgrPrereq = await callWorkflow(tokens.manager, 'eval.ensure', { orgId: evalFixture.orgId, cycleId: evalFixture.cycleId, stage: 'manager', employeeId: evalFixture.emp.EMP002 });
  check('manager eval blocked until self submitted', mgrPrereq.status === 409 && mgrPrereq.body.error.code === 'SELF_NOT_SUBMITTED');

  const peek = await callWorkflow(tokens.employee, 'eval.get', { orgId: evalFixture.orgId, cycleId: evalFixture.cycleId, employeeId: evalFixture.emp.EMP001, stage: 'self' });
  check('employee cannot view another employee evaluation', peek.status === 403);
}
```

- [ ] **Step 5: Run the check**

Run: `node supabase/verify/seed-foundation.mjs && node supabase/verify/workflow-check.mjs`
Expected: `workflow-check: PASS (33 assertions)` (27 + 6). (Trust the printed `n`; recount if it differs.)

- [ ] **Step 6: Commit**

```bash
git add supabase/functions/pms-workflow/evals.ts supabase/functions/pms-workflow/index.ts supabase/verify/workflow-check.mjs
git commit -m "feat(workflow): evaluation read + ensure with score-row seeding"
```

---

### Task 3: Save scores (compute achievement % + auto rating + overall)

**Files:**
- Modify: `supabase/functions/pms-workflow/evals.ts` (add `eval.save-scores`)
- Modify: `supabase/verify/workflow-check.mjs` (add a scoring section)

**Interfaces:**
- Consumes: Task 1 scoring engine, Task 2 helpers.
- Produces action `eval.save-scores` `{orgId, cycleId, employeeId, stage, evalVersion, goalScores:[{goalItemId, achievementValue?, score?, comment?}], competencyScores?:[{competencyName, score?, comment?}], overallComment?}` → `{evaluation, goalScores, competencyScores}` — auth (assertStageAuth), cycle evaluable, prereqs, stage window (requireWindowOrHr), evaluation status `draft` (else `EVAL_LOCKED` 409). For each goal score: look up the goal item's target + target-type `lower_is_better`, compute `achievement_percent`, compute the auto rating from the cycle's bands, store `score = manual ?? auto`; update the row (upsert by `(evaluation_id, goal_item_id)`). Competency scores stored as given. Recompute `overall_score` via the engine and version-check the evaluation row (bumps version, sets `overall_comment`).

- [ ] **Step 1: Add imports + `eval.save-scores` to `evals.ts`**

Add to the imports at the top of `supabase/functions/pms-workflow/evals.ts`:

```ts
import { optNumber, optString, reqArray, reqInt, reqObject, reqString } from '../_shared/validate.ts';
import { requireWindowOrHr } from '../_shared/phase.ts';
import { achievementPercent, Band, computeGoalScore, computeOverall, ratingFromBands, ScoredItem } from '../_shared/scoring.ts';
```

Add a scoring-context loader (place above `evalHandlers`):

```ts
async function scoringContext(ctx: HandlerCtx, orgId: string, cycleId: string, employeeId: string) {
  const { data: bands } = await ctx.admin.from('cycle_auto_rating_bands')
    .select('from_percent, to_percent, score').eq('cycle_id', cycleId).eq('organization_id', orgId);
  const { data: targetTypes } = await ctx.admin.from('cycle_target_types')
    .select('target_type_key, is_numeric, lower_is_better').eq('cycle_id', cycleId).eq('organization_id', orgId);
  const { data: cfg } = await ctx.admin.from('cycle_competency_config').select('enabled, competency_weight').eq('cycle_id', cycleId).maybeSingle();
  const ratingLevel = await ratingLevelFor(ctx, cycleId, employeeId);
  const lowerByKey = new Map<string, { isNumeric: boolean; lower: boolean }>(
    (targetTypes ?? []).map((t) => [t.target_type_key, { isNumeric: t.is_numeric, lower: t.lower_is_better }]),
  );
  return { bands: (bands ?? []) as Band[], lowerByKey, cfg: cfg ?? { enabled: false, competency_weight: null }, ratingLevel };
}

function num(v: string | null): number | null {
  if (v == null || v.trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
```

Add the handler inside `evalHandlers`:

```ts
  'eval.save-scores': async (payload, ctx) => {
    const orgId = reqUuid(payload.orgId, 'orgId');
    const cycleId = reqUuid(payload.cycleId, 'cycleId');
    const employeeId = reqUuid(payload.employeeId, 'employeeId');
    const stage = reqEnum(payload.stage, 'stage', STAGES);
    const evalVersion = reqInt(payload.evalVersion, 'evalVersion');
    await assertStageAuth(ctx, orgId, employeeId, stage);
    await loadEvaluableCycle(ctx, orgId, cycleId);
    await assertPrereqs(ctx, orgId, cycleId, employeeId, stage);
    await requireWindowOrHr(ctx, orgId, cycleId, STAGE_WINDOW[stage]);

    const { data: evaluation, error: eErr } = await ctx.admin.from('evaluations')
      .select().eq('cycle_id', cycleId).eq('employee_id', employeeId).eq('stage', stage).eq('organization_id', orgId).maybeSingle();
    if (eErr) { console.error('save-scores eval', eErr); throw new ApiError('DB_ERROR', 'Database error', 500); }
    if (!evaluation) throw new ApiError('NOT_FOUND', 'No evaluation — call eval.ensure first', 404);
    if (evaluation.status !== 'draft') throw new ApiError('EVAL_LOCKED', `A ${evaluation.status} evaluation cannot be edited`, 409);

    const octx = await scoringContext(ctx, orgId, cycleId, employeeId);

    // Resolve the goal items for target lookups (only the plan's items).
    const { data: plan } = await ctx.admin.from('employee_goal_plans').select('id').eq('cycle_id', cycleId).eq('employee_id', employeeId).maybeSingle();
    const { data: goalItems } = await ctx.admin.from('employee_goal_items')
      .select('id, item_type, parent_item_id, weight, target_type_key, target_value').eq('plan_id', plan.id);
    const itemById = new Map((goalItems ?? []).map((g) => [g.id, g]));

    // Apply each submitted goal score.
    const goalRows = reqArray(payload.goalScores ?? [], 'goalScores', 500);
    for (let i = 0; i < goalRows.length; i++) {
      const o = reqObject(goalRows[i], `goalScores[${i}]`);
      const goalItemId = reqUuid(o.goalItemId, `goalScores[${i}].goalItemId`);
      const item = itemById.get(goalItemId);
      if (!item) throw new ApiError('BAD_REQUEST', `goalScores[${i}] references an item not in this plan`, 400);
      const achievementValue = optString(o.achievementValue, `goalScores[${i}].achievementValue`, 200);
      const manualScore = optNumber(o.score, `goalScores[${i}].score`);
      const comment = optString(o.comment, `goalScores[${i}].comment`, 2000);
      const tt = item.target_type_key ? octx.lowerByKey.get(item.target_type_key) : undefined;
      const pct = (tt?.isNumeric ?? false)
        ? achievementPercent(num(achievementValue), num(item.target_value), tt?.lower ?? false)
        : null;
      const auto = ratingFromBands(pct, octx.bands);
      const score = manualScore ?? auto;
      const { error } = await ctx.admin.from('evaluation_goal_scores').upsert({
        organization_id: orgId, cycle_id: cycleId, evaluation_id: evaluation.id, goal_item_id: goalItemId,
        achievement_value: achievementValue, achievement_percent: pct, score, comment,
      }, { onConflict: 'evaluation_id,goal_item_id' });
      if (error) { console.error('save goal score', error); throw new ApiError('DB_ERROR', 'Database error', 500); }
    }

    // Apply competency scores (if any provided).
    const compRows = reqArray(payload.competencyScores ?? [], 'competencyScores', 200);
    for (let i = 0; i < compRows.length; i++) {
      const o = reqObject(compRows[i], `competencyScores[${i}]`);
      const competencyName = reqString(o.competencyName, `competencyScores[${i}].competencyName`, 200);
      const { error } = await ctx.admin.from('evaluation_competency_scores').upsert({
        organization_id: orgId, cycle_id: cycleId, evaluation_id: evaluation.id, competency_name: competencyName,
        score: optNumber(o.score, `competencyScores[${i}].score`), comment: optString(o.comment, `competencyScores[${i}].comment`, 2000),
      }, { onConflict: 'evaluation_id,competency_name' });
      if (error) { console.error('save comp score', error); throw new ApiError('DB_ERROR', 'Database error', 500); }
    }

    // Recompute overall from the persisted score rows.
    const overall = await recomputeOverall(ctx, orgId, evaluation.id, goalItems ?? [], octx);
    const overallComment = optString(payload.overallComment, 'overallComment', 4000);
    const fresh = await ctx.versionedUpdate('evaluations', orgId, evaluation.id, evalVersion, {
      overall_score: overall, overall_comment: overallComment,
    });
    await ctx.audit({ organizationId: orgId, cycleId, action: 'eval.save-scores', entityType: 'evaluation', entityId: evaluation.id, note: `${stage} overall=${overall}` });
    const bundle = await readEvalBundle(ctx, orgId, cycleId, employeeId, stage);
    return bundle;
  },
```

Add the recompute helper (below `seedScores`):

```ts
async function recomputeOverall(
  ctx: HandlerCtx, orgId: string, evaluationId: string,
  goalItems: { id: string; item_type: string; parent_item_id: string | null; weight: number | null }[],
  octx: { cfg: { enabled: boolean; competency_weight: number | null }; ratingLevel: 'kra' | 'kpi' },
): Promise<number | null> {
  const { data: gs } = await ctx.admin.from('evaluation_goal_scores').select('goal_item_id, score').eq('evaluation_id', evaluationId);
  const scoreByItem = new Map((gs ?? []).map((r) => [r.goal_item_id, r.score]));
  const scored: ScoredItem[] = goalItems.map((it) => ({
    itemId: it.id, itemType: it.item_type as 'kra' | 'kpi', parentId: it.parent_item_id, weight: it.weight,
    score: scoreByItem.has(it.id) ? (scoreByItem.get(it.id) as number | null) : null,
  }));
  const goalScore = computeGoalScore(scored, octx.ratingLevel);
  let competencyScore: number | null = null;
  if (octx.cfg.enabled) {
    const { data: cs } = await ctx.admin.from('evaluation_competency_scores').select('score').eq('evaluation_id', evaluationId);
    const vals = (cs ?? []).map((r) => r.score).filter((s): s is number => s != null);
    competencyScore = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
  }
  return computeOverall(goalScore, competencyScore, octx.cfg.enabled, octx.cfg.competency_weight);
}
```

- [ ] **Step 2: Deploy**

Run: `supabase functions deploy pms-workflow`
Expected: deployed.

- [ ] **Step 3: Add the scoring section to `workflow-check.mjs`**

Before the final `console.log`, append:

```js
// --- eval.save-scores computes achievement % + auto rating + overall ---
{
  const get = await callWorkflow(tokens.employee, 'eval.get', { orgId: evalFixture.orgId, cycleId: evalFixture.cycleId, employeeId: evalFixture.emp.EMP002, stage: 'self' });
  const v = get.body.data.evaluation.version;
  const ids = get.body.data.goalScores.map((r) => r.goal_item_id);
  // Score KPI A at 120% (→ band score 5) and KPI B at 50% (→ band score 2).
  const save = await callWorkflow(tokens.employee, 'eval.save-scores', {
    orgId: evalFixture.orgId, cycleId: evalFixture.cycleId, employeeId: evalFixture.emp.EMP002, stage: 'self', evalVersion: v,
    goalScores: [
      { goalItemId: ids[0], achievementValue: '120' },
      { goalItemId: ids[1], achievementValue: '50' },
    ],
    overallComment: 'Solid year',
  });
  check('save-scores succeeds', save.status === 200);
  const scoreA = save.body.data.goalScores.find((r) => r.goal_item_id === ids[0]);
  check('achievement % computed (120)', Number(scoreA.achievement_percent) === 120);
  check('auto rating from bands (5)', Number(scoreA.score) === 5);
  // KRA A=5 (w60), KRA B=2 (w40) → 5*0.6 + 2*0.4 = 3.8
  check('overall rolled up (3.8)', Number(save.body.data.evaluation.overall_score) === 3.8);

  const manual = await callWorkflow(tokens.employee, 'eval.save-scores', {
    orgId: evalFixture.orgId, cycleId: evalFixture.cycleId, employeeId: evalFixture.emp.EMP002, stage: 'self', evalVersion: save.body.data.evaluation.version,
    goalScores: [{ goalItemId: ids[0], achievementValue: '120', score: 3 }],
  });
  const scoreAManual = manual.body.data.goalScores.find((r) => r.goal_item_id === ids[0]);
  check('manual score overrides auto rating', Number(scoreAManual.score) === 3);

  const stale = await callWorkflow(tokens.employee, 'eval.save-scores', {
    orgId: evalFixture.orgId, cycleId: evalFixture.cycleId, employeeId: evalFixture.emp.EMP002, stage: 'self', evalVersion: 1,
    goalScores: [],
  });
  check('save-scores rejects a stale eval version', stale.status === 409 && stale.body.error.code === 'CONFLICT');
}
```

- [ ] **Step 4: Run the check**

Run: `node supabase/verify/seed-foundation.mjs && node supabase/verify/workflow-check.mjs`
Expected: `workflow-check: PASS (39 assertions)` (33 + 6).

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/pms-workflow/evals.ts supabase/verify/workflow-check.mjs
git commit -m "feat(workflow): eval.save-scores with server-side achievement/auto-rating/overall"
```

---

### Task 4: Submit + stage progression (self → manager → hod → hr_final)

**Files:**
- Modify: `supabase/functions/pms-workflow/evals.ts` (add `eval.submit`)
- Modify: `supabase/verify/workflow-check.mjs` (add the stage-progression section)

**Interfaces:**
- Consumes: Task 2/3 helpers.
- Produces action `eval.submit` `{orgId, cycleId, employeeId, stage, evalVersion}` → `{evaluation}` — auth + evaluable + prereqs + stage window; evaluation `draft` → `submitted` (sets `submitted_at`, `submitted_by`); recompute overall once more (freeze); refuses if no goal item has a score (`NOTHING_SCORED` 422); version-checked; audited. Submitting the `self` stage unlocks the `manager` stage (its prereq); manager unlocks hod/hr_final.

- [ ] **Step 1: Add `eval.submit` to `evals.ts`**

Add inside `evalHandlers`:

```ts
  'eval.submit': async (payload, ctx) => {
    const orgId = reqUuid(payload.orgId, 'orgId');
    const cycleId = reqUuid(payload.cycleId, 'cycleId');
    const employeeId = reqUuid(payload.employeeId, 'employeeId');
    const stage = reqEnum(payload.stage, 'stage', STAGES);
    const evalVersion = reqInt(payload.evalVersion, 'evalVersion');
    await assertStageAuth(ctx, orgId, employeeId, stage);
    await loadEvaluableCycle(ctx, orgId, cycleId);
    await assertPrereqs(ctx, orgId, cycleId, employeeId, stage);
    await requireWindowOrHr(ctx, orgId, cycleId, STAGE_WINDOW[stage]);

    const { data: evaluation, error: eErr } = await ctx.admin.from('evaluations')
      .select().eq('cycle_id', cycleId).eq('employee_id', employeeId).eq('stage', stage).eq('organization_id', orgId).maybeSingle();
    if (eErr) { console.error('submit eval', eErr); throw new ApiError('DB_ERROR', 'Database error', 500); }
    if (!evaluation) throw new ApiError('NOT_FOUND', 'No evaluation to submit', 404);
    if (evaluation.status !== 'draft') throw new ApiError('EVAL_LOCKED', `A ${evaluation.status} evaluation cannot be submitted again`, 409);

    const { data: scores } = await ctx.admin.from('evaluation_goal_scores').select('score').eq('evaluation_id', evaluation.id);
    if (!(scores ?? []).some((s) => s.score != null)) throw new ApiError('NOTHING_SCORED', 'Score at least one goal before submitting', 422);

    // Freeze the overall one more time.
    const octx = await scoringContext(ctx, orgId, cycleId, employeeId);
    const { data: plan } = await ctx.admin.from('employee_goal_plans').select('id').eq('cycle_id', cycleId).eq('employee_id', employeeId).maybeSingle();
    const { data: goalItems } = await ctx.admin.from('employee_goal_items').select('id, item_type, parent_item_id, weight').eq('plan_id', plan.id);
    const overall = await recomputeOverall(ctx, orgId, evaluation.id, goalItems ?? [], octx);

    const fresh = await ctx.versionedUpdate('evaluations', orgId, evaluation.id, evalVersion, {
      status: 'submitted', submitted_at: new Date().toISOString(), submitted_by: ctx.userId, overall_score: overall,
    });
    await ctx.audit({ organizationId: orgId, cycleId, action: 'eval.submit', entityType: 'evaluation', entityId: evaluation.id, before: { status: 'draft' }, after: { status: 'submitted', overall_score: overall } });
    return { evaluation: fresh };
  },
```

- [ ] **Step 2: Deploy**

Run: `supabase functions deploy pms-workflow`
Expected: deployed.

- [ ] **Step 3: Add the stage-progression section**

Before the final `console.log`, append:

```js
// --- self submit unlocks manager; manager rates + submits ---
{
  // Ensure self is scored (Task 3 left it draft with scores) then submit.
  const selfGet = await callWorkflow(tokens.employee, 'eval.get', { orgId: evalFixture.orgId, cycleId: evalFixture.cycleId, employeeId: evalFixture.emp.EMP002, stage: 'self' });
  const selfSubmit = await callWorkflow(tokens.employee, 'eval.submit', { orgId: evalFixture.orgId, cycleId: evalFixture.cycleId, employeeId: evalFixture.emp.EMP002, stage: 'self', evalVersion: selfGet.body.data.evaluation.version });
  check('employee submits self evaluation', selfSubmit.status === 200 && selfSubmit.body.data.evaluation.status === 'submitted');

  const reSubmit = await callWorkflow(tokens.employee, 'eval.submit', { orgId: evalFixture.orgId, cycleId: evalFixture.cycleId, employeeId: evalFixture.emp.EMP002, stage: 'self', evalVersion: selfSubmit.body.data.evaluation.version });
  check('re-submitting a submitted self evaluation is rejected', reSubmit.status === 409 && reSubmit.body.error.code === 'EVAL_LOCKED');

  // Now the manager stage is unlocked.
  const mgrEnsure = await callWorkflow(tokens.manager, 'eval.ensure', { orgId: evalFixture.orgId, cycleId: evalFixture.cycleId, stage: 'manager', employeeId: evalFixture.emp.EMP002 });
  check('manager eval unlocked after self submitted', mgrEnsure.status === 200 && mgrEnsure.body.data.evaluation.stage === 'manager');
  const mIds = mgrEnsure.body.data.goalScores.map((r) => r.goal_item_id);

  const empRatesMgr = await callWorkflow(tokens.employee, 'eval.save-scores', { orgId: evalFixture.orgId, cycleId: evalFixture.cycleId, employeeId: evalFixture.emp.EMP002, stage: 'manager', evalVersion: mgrEnsure.body.data.evaluation.version, goalScores: [] });
  check('employee cannot write the manager stage', empRatesMgr.status === 403);

  const mgrSave = await callWorkflow(tokens.manager, 'eval.save-scores', {
    orgId: evalFixture.orgId, cycleId: evalFixture.cycleId, employeeId: evalFixture.emp.EMP002, stage: 'manager', evalVersion: mgrEnsure.body.data.evaluation.version,
    goalScores: [{ goalItemId: mIds[0], achievementValue: '95' }, { goalItemId: mIds[1], achievementValue: '95' }],
  });
  check('manager saves scores', mgrSave.status === 200 && Number(mgrSave.body.data.evaluation.overall_score) === 5);

  const mgrSubmit = await callWorkflow(tokens.manager, 'eval.submit', { orgId: evalFixture.orgId, cycleId: evalFixture.cycleId, employeeId: evalFixture.emp.EMP002, stage: 'manager', evalVersion: mgrSave.body.data.evaluation.version });
  check('manager submits evaluation', mgrSubmit.status === 200 && mgrSubmit.body.data.evaluation.status === 'submitted');

  // Employee cannot yet see the manager rating (after_publish default, unpublished).
  const empView = await callWorkflow(tokens.employee, 'eval.get', { orgId: evalFixture.orgId, cycleId: evalFixture.cycleId, employeeId: evalFixture.emp.EMP002, stage: 'manager' });
  check('employee cannot see manager rating before publish', empView.status === 403);
}
```

- [ ] **Step 4: Run the check**

Run: `node supabase/verify/seed-foundation.mjs && node supabase/verify/workflow-check.mjs`
Expected: `workflow-check: PASS (46 assertions)` (39 + 7).

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/pms-workflow/evals.ts supabase/verify/workflow-check.mjs
git commit -m "feat(workflow): eval.submit + self→manager stage progression"
```

---

### Task 5: HOD/HR-final visibility + smoke-gate confirmation

**Files:**
- Modify: `supabase/verify/workflow-check.mjs` (add a HOD-visibility + HR-final section)

**Interfaces:**
- Consumes: everything above. `run-all.mjs` already runs `workflow-check.mjs` (wired in Plan 3a) — no change needed there; this task confirms the full gate.

- [ ] **Step 1: Add the HOD/HR-final section**

Before the final `console.log`, append (HOD and HR act in `review` status; flip the cycle to `review` via admin and add hod_review/hr_calibration windows):

```js
// --- HOD sees mapped employee stages; HR-final closes it out ---
{
  const iso3 = (d) => d.toISOString().slice(0, 10);
  const pastW = iso3(new Date(Date.now() - 3 * 864e5));
  const futW = iso3(new Date(Date.now() + 30 * 864e5));
  await admin.from('cycle_phase_windows').insert([
    { organization_id: evalFixture.orgId, cycle_id: evalFixture.cycleId, window_key: 'hod_review', starts_on: pastW, ends_on: futW },
    { organization_id: evalFixture.orgId, cycle_id: evalFixture.cycleId, window_key: 'hr_calibration', starts_on: pastW, ends_on: futW },
  ]);
  await admin.from('appraisal_cycles').update({ status: 'review' }).eq('id', evalFixture.cycleId);

  // HOD (Harry, EMP003 maps EMP002 via hod) can view the submitted manager stage.
  const hodView = await callWorkflow(tokens.hod, 'eval.get', { orgId: evalFixture.orgId, cycleId: evalFixture.cycleId, employeeId: evalFixture.emp.EMP002, stage: 'manager' });
  check('HOD can view the manager evaluation of a mapped employee', hodView.status === 200 && hodView.body.data.evaluation !== null);

  // HOD stage ensure + submit.
  const hodEnsure = await callWorkflow(tokens.hod, 'eval.ensure', { orgId: evalFixture.orgId, cycleId: evalFixture.cycleId, stage: 'hod', employeeId: evalFixture.emp.EMP002 });
  check('HOD stage can be created after manager submitted', hodEnsure.status === 200);
  const hIds = hodEnsure.body.data.goalScores.map((r) => r.goal_item_id);
  const hodSave = await callWorkflow(tokens.hod, 'eval.save-scores', { orgId: evalFixture.orgId, cycleId: evalFixture.cycleId, employeeId: evalFixture.emp.EMP002, stage: 'hod', evalVersion: hodEnsure.body.data.evaluation.version, goalScores: [{ goalItemId: hIds[0], score: 4 }, { goalItemId: hIds[1], score: 4 }] });
  check('HOD saves calibrated scores', hodSave.status === 200 && Number(hodSave.body.data.evaluation.overall_score) === 4);

  // HR-final (hr user has no employee row but is hr_admin — HR bypass on stage + window).
  const hrEnsure = await callWorkflow(tokens.hr, 'eval.ensure', { orgId: evalFixture.orgId, cycleId: evalFixture.cycleId, stage: 'hr_final', employeeId: evalFixture.emp.EMP002 });
  check('HR-final stage can be created', hrEnsure.status === 200 && hrEnsure.body.data.evaluation.stage === 'hr_final');
  const fIds = hrEnsure.body.data.goalScores.map((r) => r.goal_item_id);
  const hrSave = await callWorkflow(tokens.hr, 'eval.save-scores', { orgId: evalFixture.orgId, cycleId: evalFixture.cycleId, employeeId: evalFixture.emp.EMP002, stage: 'hr_final', evalVersion: hrEnsure.body.data.evaluation.version, goalScores: [{ goalItemId: fIds[0], score: 5 }, { goalItemId: fIds[1], score: 3 }] });
  check('HR saves final scores', hrSave.status === 200);
  const hrSubmit = await callWorkflow(tokens.hr, 'eval.submit', { orgId: evalFixture.orgId, cycleId: evalFixture.cycleId, employeeId: evalFixture.emp.EMP002, stage: 'hr_final', evalVersion: hrSave.body.data.evaluation.version });
  check('HR submits the final evaluation', hrSubmit.status === 200 && hrSubmit.body.data.evaluation.status === 'submitted');
}
```

- [ ] **Step 2: Run the full gate**

Run: `node supabase/verify/run-all.mjs`
Expected: all six scripts pass — `admin-check: PASS (86 assertions)`, `workflow-check: PASS (52 assertions)` (46 + 6) — final `FOUNDATION SMOKE: ALL PASS`, exit 0. (Run in background if it exceeds the 2-minute foreground limit.)

- [ ] **Step 3: Run lint**

Run: `npm run lint`
Expected: no NEW problems under `supabase/**` (pre-existing `src/` findings out of scope — note, don't fix).

- [ ] **Step 4: Commit**

```bash
git add supabase/verify/workflow-check.mjs
git commit -m "test(workflow): HOD/HR-final visibility + full evaluation gate"
```

---

## Out of Scope (Plan 3c — next)

- Calibration adjustment records (`calibrations` — before/after/actor per stage), bell-curve distribution checks and publish-blocking (`cycle_bell_curve_bands`), publishing / revoke-publish (`cycle_publications`), and the acknowledgement/concern flow (`rating_acknowledgements` — employee accept or raise-concern; HR resolve via explain-and-close or recalibrate), gated on the snapshot `finalEmployeeAcceptanceEnabled`.
- Honoring `cycle_goal_rules.approval_required` (deferred from 3a) if it affects when `hr_final` may open.
- Notifications/emails for stage transitions (Plan 4 jobs).

Nothing in this plan modifies old-world files, `pms-admin`, adds tables, or runs migrations.
