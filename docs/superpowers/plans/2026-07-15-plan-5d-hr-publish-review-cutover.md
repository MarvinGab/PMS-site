# HR Review & Publish (Core Path) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give HR a server-first review-and-publish screen — see every participant's final evaluation, calibrate scores, check the bell-curve distribution, and publish (or revoke) the cycle — entirely via `callPms`/`callWorkflow`, no blob source of truth. (Concern-resolution UI is a deferred follow-up.)

**Architecture:** The backend already exposes the whole publish path in `pms-admin/publishing.ts` (`publish.bell-check`, `publish.publish` with force+reason override, `publish.revoke`) and `pms-workflow/calibration.ts` (`calibration.adjust` — version-checked `overall_score` change on a submitted eval, HR any stage). What's missing is a scoped HR **read** that lists participants with their `hr_final` evaluation status/score plus the bell-curve summary and publication state. This plan adds that one read, builds a focused `HRPublishReview` screen on it, and reroutes the HR review/publish view to it.

**Tech Stack:** React 19 + Vite (`callPms`→pms-admin, `callWorkflow`→pms-workflow, `PmsError` from `src/backend/pmsClient.js`; `useApp()` → `role`/`orgId`); Supabase edge functions `pms-admin` + `pms-workflow` (Deno) on the shared kernel; gate `node supabase/verify/run-all.mjs`.

## Global Constraints

- **Data layer = `callPms`/`callWorkflow` ONLY** for the migrated HR review/publish screen. No `stateStore`/`app_state`/`localStorage`/`loadWorkflow`/`readRemoteState`/`writeRemoteState`/blob/wizard-config source of truth. (`feedback_plan5_scoped_reads`.)
- **Backend enforces everything:** HR authz (`ctx.requireOrgRole(orgId,['hr_admin'])` for publish reads/actions; `calibration.adjust` allows HR/super any stage), the review-status/publish guards (FINALS_INCOMPLETE / BELL_CURVE_VIOLATION unless force+reason / ALREADY_PUBLISHED / CYCLE_WRONG_STATUS / NOT_PUBLISHED), score-in-scale, and optimistic `version` → `CONFLICT`.
- **Scoped/paginated reads:** the HR list read returns the cycle's participants for ONE cycle; if participant counts can be large, page it (accept `limit`/`offset`, return a `total`). Never a full-org blob hydration.
- **Palette rule:** red and green are reserved for validation/error/approved/within-tolerance status ONLY — no red/green in decorative chrome (`feedback_red_green_reserved`). A red "outside tolerance"/error and a green "within tolerance"/"published" are status and fine.
- **Copy rule:** never label rows "Outside PMS"; use blank or "NONE" (`feedback_outside_pms_label`). Reporting managers are employees first (`feedback_reporting_manager_external`).
- **Do NOT break:** the employee `EmployeeGoals`/`EmployeeSelfEval` paths, `ManagerGoalReview`, the manager/HOD EVALUATION review, and the rest of `HRCycleDashboard.jsx`/`HRReviewPage.jsx` (cycle setup, roster, wizard, monitoring). Only the HR review/publish view migrates here; leave everything else, and any entangled blob code, as documented dead/unreached code — correctness beats deletion completeness.
- Build in an **isolated worktree off pushed `main`**; wire `.env`, symlink `node_modules`, copy `supabase/.temp`. Full gate green before merge.
- **Deploy handoff:** subagents CANNOT deploy. The Task 1 implementer writes the backend + `deno check` + STOPS (NEEDS_CONTEXT); the controller deploys `pms-admin`, then resumes the agent for the live check + commit.
- Demo login: `pms-hr@example.com` / `Passw0rd!seed` (hr_admin). The `admin-check.mjs` fixture exercises publish/calibration; extend it (or `workflow-check`) for the new read.

## Out of Scope (deferred follow-ups / later slices)
- **Concern-resolution UI** (`ack.*` concerns list → `concern.resolve`) — deferred per the user's "core publish path first" scope.
- HR doing the `hr_final` scoring itself (`eval.*` hr_final stage authoring UI) — a separate HR-eval slice; this screen SHOWS finals and calibrates submitted ones, and reports "missing final" (publish blocks) when absent.
- HR cycle setup / wizard / roster / monitoring in `HRCycleDashboard.jsx` — Plan 5e.
- Deleting `HRReviewPage.jsx`/`stateStore`/old blob publish code — Plan 6.

---

### Task 1: `publish.review-list` HR read

**Files:**
- Modify: `supabase/functions/pms-admin/publishing.ts` (add `publish.review-list` to `publishingHandlers`)
- Modify: `supabase/verify/admin-check.mjs` (add review-list assertions; keep the existing 101 intact)

**Interfaces:**
- Consumes: the existing `publishing.ts` helpers `finalScores`, `bellContext`, `livePublication`, plus `computeBellCurve` (`_shared/bellcurve.ts`), `cycle_participants`, `evaluations` (stage `hr_final`), `employees`, `appraisal_cycles`.
- Produces: action `publish.review-list` (HR-only) returning:
  ```
  {
    cycle: { id, name, status },
    publication: { live: boolean, publishedAt: string|null, reason: string|null } ,
    bell: <computeBellCurve(scores, points, bands) result — the distribution + withinTolerance + per-band actual/target/tolerance>,
    finalsMissing: number,                     // participants with no submitted hr_final
    total: number,
    participants: [ {
      employeeId, employeeName, employeeCode,
      finalStatus: 'submitted'|'draft'|'missing',
      finalScore: number|null,
      evalId: string|null, evalVersion: number|null
    } ]                                         // page of active participants (limit/offset)
  }
  ```

- [ ] **Step 1 — DISCOVERY (print real shapes; do not guess):** In a scratch `deno` snippet against the live project, print: the `computeBellCurve` return shape (read `_shared/bellcurve.ts`), the `evaluations` columns for stage `hr_final` (`id, employee_id, overall_score, status, version`), the `employees` name/code columns (`full_name`, `employee_code` per prior slices), and confirm the `admin-check.mjs` fixture's cycle can reach a `review`-status cycle with ≥1 submitted `hr_final` eval (or how to set that up). Paste findings into the report.

- [ ] **Step 2 — Write the handler.** `ctx.requireOrgRole(orgId, ['hr_admin'])`. Read active `cycle_participants` (paginated by `optInt` `limit`/`offset`, default e.g. 200/0, with a `total` count), their `employees` name/code, and each one's `hr_final` `evaluations` row; derive `finalStatus`/`finalScore`/`evalId`/`evalVersion`. Compute `bell` via `finalScores`+`bellContext`+`computeBellCurve` (reuse the existing helpers). `publication` via `livePublication`. Wrap primary-query errors as `ApiError('DB_ERROR','Database error',500)`; never leak raw Postgres text. Read-only — no writes.

- [ ] **Step 3 — Assertions in `admin-check.mjs`.** As HR: `publish.review-list` returns the cycle + a participants array (each with employeeName + finalStatus), a `bell` object with a boolean `withinTolerance`, a numeric `finalsMissing`/`total`, and the `publication.live` boolean; a non-HR caller is denied. Keep the existing 101 green.

- [ ] **Step 4 — `deno check` + `node --check`, then STOP (NEEDS_CONTEXT) for the controller to deploy `pms-admin`.** After deploy, run `node supabase/verify/seed-foundation.mjs && node supabase/verify/admin-check.mjs` (expect the new total, all pass), then commit: `feat(admin): publish.review-list — scoped HR read of participant finals + bell + publication`.

---

### Task 2: `HRPublishReview` component (callPms/callWorkflow only)

**Files:**
- Create: `src/pages/HRPublishReview.jsx`

**Interfaces:**
- Consumes: `callPms`/`callWorkflow`/`PmsError` (`src/backend/pmsClient`), `useApp()` (`orgId`, `role`). Backend `publish.review-list`, `publish.bell-check`, `publish.publish`, `publish.revoke` (all `callPms`); `calibration.adjust` (`callWorkflow`).
- Produces: a default-exported `HRPublishReview` component rendering the HR review/publish screen entirely from `callPms`/`callWorkflow`.

- [ ] **Step 1 — Scaffold + load.** On mount (when `orgId` and `role` is `hr_admin`/`super_admin`): `callPms('publish.review-list', { orgId })`. Hold `{cycle, publication, bell, participants, finalsMissing, total}`. States: loading, error+Retry, no active/review cycle, and the review table. Render a bell-curve summary panel (per-band actual vs target±tolerance; `withinTolerance` shown as a status — green within / red outside, status colors only) and a participants table (name, code, final status pill, final score).

- [ ] **Step 2 — Calibrate.** For a participant whose `finalStatus === 'submitted'`, an inline "Adjust" control opens a small editor (new score within the rating scale + optional note) → `callWorkflow('calibration.adjust', { orgId, cycleId: cycle.id, employeeId, stage: 'hr_final', evalVersion, afterScore, note })`. On success, refresh the list (background refetch, no full-screen blank — mirror the ManagerGoalReview/EmployeeSelfEval background-refetch pattern). Handle `PmsError` `CONFLICT` (reload), `EVAL_NOT_SUBMITTED`, `FORBIDDEN`, score-scale errors with friendly messages.

- [ ] **Step 3 — Publish / revoke.** A "Check distribution" action calls `publish.bell-check` and shows the result. "Publish results" calls `publish.publish { orgId, cycleId }`; on `FINALS_INCOMPLETE` show how many finals are missing; on `BELL_CURVE_VIOLATION` open a force-confirm modal requiring a non-blank reason, then retry with `{ force: true, reason }`. When a live publication exists, show published state + a "Revoke" action → `publish.revoke { orgId, cycleId, reason }` (reason required). Refresh after each. No blob/localStorage.

- [ ] **Step 4 — Build + blob grep.** `npm run build` succeeds; `grep -nE "stateStore|app_state|localStorage|loadWorkflow|readRemoteState|writeRemoteState|hydrate|ratingsStore|wizardConfig" src/pages/HRPublishReview.jsx` → empty. Commit: `feat(publish): HRPublishReview — HR review/calibrate/publish via callPms/callWorkflow only`.

---

### Task 3: Route the HR review/publish view to `HRPublishReview` + retire the blob publish path

**Files:**
- Modify: `src/pages/HRCycleDashboard.jsx` and/or `src/pages/HRReviewPage.jsx` and/or `src/App.jsx` (whichever hosts the current HR bell-curve/publish view — discover it)

**Interfaces:**
- Consumes: `HRPublishReview` (Task 2).
- Produces: the HR review/publish view renders `<HRPublishReview/>`; the old blob publish/calibration UI no longer runs for HR.

- [ ] **Step 1 — Discover the current HR publish view.** Grep `HRCycleDashboard.jsx`/`HRReviewPage.jsx`/`App.jsx` for where HR currently does bell-curve/publish/calibration (`bell`, `publish`, `computeBell`, `calibrat`, `revoke`, and the `hr-review` route / any "Publish"/"Calibration" tab/section). Identify the exact render branch to replace and confirm what is review/publish (migrate) vs cycle-setup/roster/wizard/monitoring (leave). Record findings in the report.

- [ ] **Step 2 — Reroute.** Import and render `<HRPublishReview/>` in place of the old blob HR review/publish view (a route case in `App.jsx` and/or a tab/section render in the HR dashboard). Preserve the surrounding HR nav/shell and every non-publish HR view untouched.

- [ ] **Step 3 — Retire the now-dead blob publish/calibration UI surgically** (only what's cleanly HR-publish-only; leave anything entangled with shared blob / cycle-setup as documented dead code). Suppress any stale blob-derived publish/bell hero or summary that would sit next to the new screen. DO NOT touch `stateStore.js`, the wizard, or non-publish HR views.

- [ ] **Step 4 — Build + static verification.** `npm run build` succeeds. Grep-confirm the HR publish view renders `<HRPublishReview/>`; the employee/manager/self-eval paths and non-publish HR views are intact.

- [ ] **Step 5 — Full gate.** `node supabase/verify/run-all.mjs` (background) → all suites pass incl. the new admin-check total + `FOUNDATION SMOKE: ALL PASS`.

- [ ] **Step 6 — Browser smoke (documented, controller/user runs).** As `pms-hr@example.com` on a `review`-status cycle with submitted finals: open the review/publish view → see participants + finals + bell curve → adjust a score → check distribution → publish (force+reason if outside tolerance) → see published state → revoke with a reason. Confirm no blob publish write fires.

- [ ] **Step 7 — Commit + final whole-branch review → merge to main.** Commit: `feat(publish): route HR review/publish to HRPublishReview; retire blob publish path (cycle setup untouched)`.
