# Employee Self-Evaluation Cutover Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate the employee self-evaluation flow off the old `app_state`/blob/localStorage architecture onto the new `pms-workflow` backend — an employee rates their approved goals (and competencies, if enabled) entirely via `callWorkflow`, with no blob source of truth.

**Architecture:** `pms-workflow` already exposes `eval.ensure` (creates the draft + seeds one score row per goal item), `eval.save-scores` (version-checked save), and `eval.submit` (draft→submitted, computes+freezes the overall) for the `self` stage. But `eval.get` returns only `{evaluation, goalScores, competencyScores}` — the score rows carry `goal_item_id` but NOT the goal titles/targets, the rating scale, or the config the UI needs to render. So this plan adds ONE scoped read `eval.context` (mirroring `goal.context`/`goal.review-queue`), builds a focused `EmployeeSelfEval` component on it, and reroutes the employee self-eval section (embedded + standalone) to it.

**Tech Stack:** React 19 + Vite (`callWorkflow`/`PmsError` from `src/backend/pmsClient.js`, `useApp()`); Supabase edge function `pms-workflow` (Deno) on the shared kernel; gate `node supabase/verify/run-all.mjs`.

## Global Constraints

- **Data layer = `callWorkflow` ONLY** for the migrated self-eval screen. No `stateStore`/`app_state`/`localStorage`/`ratingsStore`/`loadWorkflow`/`hydrate`/wizard-config/blob source of truth in the new component. (`feedback_plan5_scoped_reads`.)
- **Backend enforces everything:** self-stage scope (`callerEmployeeId` / `assertStageAuth`), prereqs (goals approved before self-eval), the `self_evaluation` window (HR bypass), version → `CONFLICT`, and the server computes+freezes the overall on submit. No client-supplied identity trusted for a plain employee.
- **Scoped reads only:** the employee reads only their OWN evaluation + own goal items. No full-org blob hydration.
- **Palette rule:** red and green reserved for validation/error/approved status ONLY — no red/green in decorative rating UI (`feedback_red_green_reserved`).
- **Do NOT break:** the employee `EmployeeGoals` (5b) and manager `ManagerGoalReview` paths, the manager EVALUATION review (`ManagerEvalPage`, `manager-eval` section), HR dashboards, and shared `src/backend/stateStore.js`. Leave entangled/dead code documented — correctness beats deletion completeness.
- **The old `SelfEvalPage.jsx` (1185 lines, blob-driven) is used two ways:** embedded in `EmployeePage.jsx` (`activeSection==='self-eval'` → `<SelfEvalPage embedded .../>`) AND as a standalone route in `App.jsx` (`route==='self-eval'`). Reroute BOTH employee entrypoints to the new component; leave `SelfEvalPage.jsx` itself in place for now (Plan 6 deletes).
- Build in an **isolated worktree off pushed `main`**; wire `.env`, symlink `node_modules`, copy `supabase/.temp`. Full gate green before merge.
- **Deploy handoff:** subagents CANNOT deploy. The Task 1 implementer writes the backend + `deno check` + STOPS (NEEDS_CONTEXT); the controller deploys `pms-workflow`, then resumes the agent for the live check + commit.
- Demo login: `pms-employee@example.com` / `Passw0rd!seed` (EMP002). Self-eval requires the employee's goal plan to be `approved` and the `self_evaluation` window open — the `workflow-check.mjs` fixture already exercises the self stage; extend that fixture.

---

### Task 1: `eval.context` backend read (self stage)

**Files:**
- Modify: `supabase/functions/pms-workflow/evals.ts` (add the `eval.context` handler to `evalHandlers`)
- Modify: `supabase/verify/workflow-check.mjs` (add eval.context assertions; keep existing 84 intact)

**Interfaces:**
- Consumes: existing `_shared/scope.ts` (`callerEmployeeId`, `isHrOrSuper`), `_shared/phase.ts` (`loadActiveCycle`/`loadEvaluableCycle`, `pureWindowOpen`), the `evals.ts` helpers (`readEvalBundle`, `scoringContext`, `ratingLevelFor`, `STAGE_WINDOW`), and the `employee_goal_items`/`employee_goal_plans`/`cycle_rating_scale_levels`/`cycle_competency_config`/`cycle_competency_assignments`/`cycle_target_types` tables.
- Produces: action `eval.context` returning, for the signed-in employee (HR/super may pass `employeeId`), stage fixed to `'self'`:
  ```
  {
    cycle: { id, name, status } | null,
    stage: 'self',
    available: boolean,           // goals approved AND (window open OR HR) — can they self-rate?
    reason: string | null,        // when !available: 'GOALS_NOT_APPROVED' | 'WINDOW_CLOSED' | 'NO_PLAN'
    window: { selfEvalOpen: boolean },
    config: {
      kpiRatingMode, targetLevelMode,
      ratingScale: [ { level, label, ... } ],       // cycle_rating_scale_levels
      autoRatingBands: [ { from_percent, to_percent, score } ],
      competency: { enabled: boolean, weight: number|null }
    },
    items: [ /* approved goal tree: KRA/KPI rows {id,item_type,parent_item_id,title,description,perspective,weight,target_type_key,target_value,display_order} each joined with its current self score {achievement_value, achievement_percent, score} (null if unseeded) */ ],
    competencies: [ /* cycle_competency_assignments the employee rates, each with its current self score */ ],
    evaluation: { id, version, status } | null    // the self evaluation draft (null if not yet ensured)
  }
  ```

- [ ] **Step 1 — DISCOVERY (print real shapes; do not guess):** In a scratch `deno` snippet against the live project, print: (a) `cycle_rating_scale_levels` columns; (b) `cycle_competency_config` + `cycle_competency_assignments` columns; (c) `evaluation_goal_scores` columns (confirmed: `goal_item_id, achievement_value, achievement_percent, score`) and how they join to `employee_goal_items`; (d) how `assertPrereqs(...,'self')` determines "goals approved" (read the function) and the exact `STAGE_WINDOW['self']` window key. Paste findings into the report; build queries against the REAL columns.

- [ ] **Step 2 — Write the handler.** `employeeId = requested && (await isHrOrSuper) ? requested : callerEmployeeId`. Resolve the active/evaluable cycle. `available`/`reason`: derive from the approved goal plan (status `approved`) + the `self_evaluation` window (`pureWindowOpen(..., STAGE_WINDOW['self'], todayIso()) || isHrOrSuper`). Load the approved goal items; load the current self `evaluation` (if any) via `readEvalBundle(...,'self')` and LEFT-join its `goalScores`/`competencyScores` onto the items/competencies by `goal_item_id`/competency id. Assemble `config` from `scoringContext` + `cycle_rating_scale_levels`. Wrap primary-query errors as `ApiError('DB_ERROR','Database error',500)`; never leak raw Postgres text. This is a READ — do NOT create the evaluation (that's `eval.ensure`); return `evaluation: null` if none.

- [ ] **Step 3 — Assertions in `workflow-check.mjs`.** Using the fixture where EMP002's plan is approved and the self window is open, assert: (a) `eval.context` returns the active cycle, `stage:'self'`, `available:true`, `window.selfEvalOpen` boolean; (b) `items` includes the approved KRA/KPI rows with titles (join worked) and a score field (null before ensure); (c) `config.ratingScale` is an array and `config.competency.enabled` is a boolean; (d) after `eval.ensure` + a `eval.save-scores`, `eval.context` reflects the saved score on the right item; (e) a non-owner non-HR caller is FORBIDDEN or gets `available:false` appropriately. Keep the existing 84 green.

- [ ] **Step 4 — `deno check` + `node --check`, then STOP (NEEDS_CONTEXT) for the controller to deploy `pms-workflow`.** After deploy, run `node supabase/verify/seed-foundation.mjs && node supabase/verify/workflow-check.mjs` (expect the new total, all pass), then commit: `feat(workflow): eval.context — scoped self-evaluation read (goals+scores+config+window)`.

---

### Task 2: `EmployeeSelfEval` component (callWorkflow only)

**Files:**
- Create: `src/pages/EmployeeSelfEval.jsx`

**Interfaces:**
- Consumes: `callWorkflow`/`PmsError` (`src/backend/pmsClient`), `useApp()` (`orgId`). Backend `eval.context`, `eval.ensure`, `eval.save-scores`, `eval.submit`.
- Produces: a default-exported `EmployeeSelfEval` component rendering the employee's self-evaluation screen entirely from `callWorkflow`.

- [ ] **Step 1 — Scaffold + load.** On mount (when `orgId`): `eval.context {orgId}`. Hold `{cycle, available, reason, window, config, items, competencies, evaluation}`. If `available` and `evaluation` is null → offer/auto `eval.ensure {orgId, cycleId, stage:'self'}` to create the draft + seed, then re-render from its returned bundle mapped through `eval.context` shape (or re-call `eval.context`). States: loading, error+Retry, no active cycle, not-available (show `reason`: "Your goals aren't approved yet." / "The self-evaluation window is closed." / "No goal plan found."), editable, and read-only (evaluation.status==='submitted').

- [ ] **Step 2 — Rating UI + save/submit.** For each goal item render its title/target/weight (READ-ONLY goal content — the employee rates, does not edit goals) + a rating input driven by `config`: if the rating is achievement-based, an achievement value/percent input; if level-based, a rating-scale `<select>` from `config.ratingScale`; honor `config.kpiRatingMode`/`targetLevelMode` for which rows are rated (mirror EmployeeGoals' KRA/KPI grammar). If `config.competency.enabled`, render the competencies with their rating inputs. **Save** → `eval.save-scores {orgId, cycleId, employeeId, stage:'self', evalVersion, scores:[...]}` (shape the scores per the backend's `eval.save-scores` payload — verify its exact expected shape in `evals.ts` during implementation). **Submit** → `eval.submit {orgId, cycleId, employeeId, stage:'self', evalVersion}` → read-only. Surface `PmsError` `CONFLICT` (reload) / `WINDOW_CLOSED` / `PREREQ`/`FORBIDDEN` with friendly messages + refetch. No blob/localStorage.

- [ ] **Step 3 — Build + blob grep.** `npm run build` succeeds; `grep -nE "stateStore|app_state|localStorage|ratingsStore|GOAL_WORKFLOW_KEY|loadWorkflow|hydrate|wizardConfig" src/pages/EmployeeSelfEval.jsx` → empty. Commit: `feat(eval): EmployeeSelfEval — self-evaluation via callWorkflow only`.

---

### Task 3: Route employee self-eval to `EmployeeSelfEval` + retire the blob self-eval path

**Files:**
- Modify: `src/pages/EmployeePage.jsx`
- Modify: `src/App.jsx`

**Interfaces:**
- Consumes: `EmployeeSelfEval` (Task 2).
- Produces: both employee self-eval entrypoints render `<EmployeeSelfEval/>`; the old blob self-eval UI no longer runs for the employee.

- [ ] **Step 1 — Reroute embedded.** In `EmployeePage.jsx`, `import EmployeeSelfEval from './EmployeeSelfEval';`. Replace `{activeSection === 'self-eval' && (<SelfEvalPage embedded .../>)}` (~line 7653) with `<EmployeeSelfEval />`. Also handle the goals-section self-eval-phase branch if it renders self-eval (the `currentPhase === 'self-evaluation' ? renderSelfEvaluation()` at the goals dispatch — reroute the EMPLOYEE self-eval render to `<EmployeeSelfEval/>` too, or confirm it's already covered by the self-eval section). Discover the exact branches (grep `self-eval`, `renderSelfEvaluation`, `selfEvalPct`) and record them.
- [ ] **Step 2 — Reroute standalone.** In `App.jsx`, the `route === 'self-eval'` case (~line 371) renders `<SelfEvalPage/>` for the employee — route it to `<EmployeeSelfEval/>` (keep the Suspense/boot shell if needed; EmployeeSelfEval isn't lazy so it can render directly).
- [ ] **Step 3 — Suppress stale blob self-eval hero.** The `renderHero` `currentPhase === 'self-evaluation'` branch shows `selfEvalPct` (blob-derived "Self-rating progress"). After cutover the employee rates on the backend, so this blob stat goes stale — suppress it for the employee self-eval (set that hero panel to null), same fix as the 5b goals hero and the manager team hero.
- [ ] **Step 4 — Retire the now-dead employee blob self-eval code surgically** (only what's cleanly employee-self-eval-only; leave anything entangled with shared `workflow` blob / manager paths as documented dead code). DO NOT touch `SelfEvalPage.jsx`, `stateStore.js`, `ManagerEvalPage`, or the manager EVAL path.
- [ ] **Step 5 — Build + static verification.** `npm run build` succeeds. Grep-confirm both employee self-eval entrypoints render `<EmployeeSelfEval/>`; the manager EVAL path + EmployeeGoals + ManagerGoalReview are intact.
- [ ] **Step 6 — Full gate.** `node supabase/verify/run-all.mjs` (background) → all suites pass incl. the new workflow-check total + `FOUNDATION SMOKE: ALL PASS`.
- [ ] **Step 7 — Browser smoke (documented, controller/user runs).** As `pms-employee@example.com` with an approved plan in the self window: open self-eval → rate goals → Save → reload (persists) → Submit → read-only. Confirm no blob self-eval write fires.
- [ ] **Step 8 — Commit + final whole-branch review → merge to main.** Commit: `feat(eval): route employee self-eval to EmployeeSelfEval; retire blob self-eval path (manager eval untouched)`.

---

## Out of Scope (later slices)
- Manager/HOD evaluation + calibration screens (`ManagerEvalPage`, `hod-calibration`) — 5d.
- HR review/publish (`publish.*`/`calibration.adjust`/`concern.resolve`) + HR dashboards — 5d.
- Results/acknowledgement view + notifications — later employee-portal slice.
- Deleting `SelfEvalPage.jsx`/`stateStore`/old blob functions/dead render code — Plan 6.
