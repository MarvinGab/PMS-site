# Manager Goal Approval Cutover Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the goal submit→approve loop broken by Plan 5b — move the manager's goal approve / send-back screen onto the new `pms-workflow` backend so a manager can see, approve, and send back their direct reports' submitted goal plans, entirely via `callWorkflow` with no blob source of truth.

**Architecture:** Plan 5b routed employee goal submit to `pms-workflow` (`goal.submit` → `employee_goal_plans.status='submitted'`), but the manager review UI still reads/writes the old `workflow` blob (`reviewSubmission` → `approveGoalsAction`/`sendBackGoalsAction`), so submitted plans are invisible to managers. The write actions (`goal.approve`, `goal.send-back`, `goal.reopen`) and the manager-scoped detail read (`goal.get-plan`, gated by `canAccessTarget`) already exist in the backend. Only a manager-scoped **list** read is missing. This plan adds that one read, builds a `ManagerGoalReview` component on it, and reroutes the manager Team-tab goal review to it.

**Tech Stack:** React 19 + Vite frontend (`callWorkflow`/`PmsError` from `src/backend/pmsClient.js`, `useApp()` from `src/AppContext.jsx`); Supabase edge function `pms-workflow` (Deno/TypeScript) on the shared kernel; gate `node supabase/verify/run-all.mjs`.

## Global Constraints

- **Data layer = `callWorkflow` ONLY** for the manager goal-approval path. No `stateStore`/`app_state`/`localStorage`/`ratingsStore`/`GOAL_WORKFLOW_KEY`/blob/wizard-config source of truth in the new component. (`feedback_plan5_scoped_reads`.)
- **Backend enforces everything:** manager scope via `manages()`, the `manager_approval` phase window (HR bypass), plan-status (`only a submitted plan can be approved/sent back`), and optimistic `version` → `CONFLICT`. No client-supplied identity is trusted for a plain manager.
- **Scoped reads only:** the manager sees only their own direct reports' rows — never a full-org blob hydration.
- **Palette rule:** red and green are reserved for validation/error/approved status ONLY — no red/green in decorative UI (`feedback_red_green_reserved`).
- **Do NOT break, in this plan:** the employee `EmployeeGoals` path (5b), the manager/HOD **evaluation** review (a later phase, `manager-eval`/`hod-calibration`), HR dashboards, and shared `src/backend/stateStore.js`. Leave any goal-review code entangled with those as dead/unreached code and document it — correctness beats deletion completeness.
- Build in an **isolated worktree off pushed `main`**; wire `.env`, symlink `node_modules`, copy `supabase/.temp` (migrations are all committed — no copying). Full gate green before merge.
- **Deploy handoff:** subagents CANNOT deploy. The Task 1 implementer writes the backend + `deno check` + STOPS (NEEDS_CONTEXT); the controller deploys `pms-workflow` from the worktree, then resumes the agent for the live check + commit.
- Demo login: `pms-manager@example.com` / `Passw0rd!seed`; the seed manager manages `pms-employee@example.com` (EMP002) — verify with the seed fixture during Task 1 discovery.

---

### Task 1: `goal.review-queue` backend read

**Files:**
- Modify: `supabase/functions/pms-workflow/goals.ts` (add the `goal.review-queue` handler alongside `goal.context`)
- Modify: `supabase/verify/workflow-check.mjs` (add manager-review-queue assertions; keep the existing 77 intact)

**Interfaces:**
- Consumes: existing `_shared/scope.ts` (`callerEmployeeId`, `manages`, `isHrOrSuper`), `_shared/phase.ts` (`loadActiveCycle`, `pureWindowOpen`), and the `reporting_relationships` / `employee_goal_plans` / `employees` / `cycle_participants` tables.
- Produces: action `goal.review-queue` returning, for the signed-in manager:
  ```
  {
    cycle: { id, name, status } | null,
    window: { approvalOpen: boolean },   // now() within manager_approval window, HR bypass
    reports: [ {
      employeeId, employeeName, employeeCode,
      planId: string|null, planStatus: 'draft'|'submitted'|'approved'|'sent_back'|'reopened'|null,
      planVersion: number|null, submittedAt: string|null, kraCount: number
    } ]
  }
  ```

- [ ] **Step 1 — DISCOVERY (print real shapes, do not guess):** In a scratch `deno` snippet against the live project, print: (a) `reporting_relationships` columns + how a manager's direct reports are expressed (the memory says caller=`related_employee_id`, target=`employee_id`, with a relationship/type column — confirm the exact column + the value that means "manager"); (b) `employee_goal_plans` columns + the `status` enum values actually present; (c) the `employees` columns holding display name + code; (d) confirm the seed manager (`pms-manager@example.com`) → their `employeeId` and that it manages EMP002. Paste findings into the task report. Build the query against the REAL columns, not this plan's assumed names.

- [ ] **Step 2 — Write the handler.** Resolve `managerEmployeeId = callerEmployeeId(ctx, orgId)`; `loadActiveCycle` for the cycle; the reports = the manager's direct reports (via `reporting_relationships`) intersected with the cycle's participants; left-join each report's `employee_goal_plans` row for `(orgId, cycleId, employeeId)` to get status/version/submitted_at; `kraCount` = count of `employee_goal_items` with `item_type='kra'` for that plan (0 if no plan). `window.approvalOpen = pureWindowOpen(windows, 'manager_approval', todayIso()) || isHrOrSuper(ctx, orgId)`. If `isHrOrSuper`, returning the caller's own reports is still correct (HR uses a different screen later) — keep it scoped to `manages`; a manager with zero reports returns `reports: []` (not an error). Wrap primary-query Supabase errors as `ApiError('DB_ERROR','Database error',500)`; never leak raw Postgres text.

- [ ] **Step 3 — Assertions in `workflow-check.mjs`.** Using the existing active-cycle fixture (and its manager/EMP002 seed), after the employee submits a plan, assert: (a) the seed manager's `goal.review-queue` returns the active cycle and a `reports` array containing EMP002 with `planStatus` reflecting the submitted plan and a numeric `planVersion`; (b) `window.approvalOpen` is a boolean matching the fixture's `manager_approval` window; (c) a NON-manager caller (e.g. the employee) gets `reports: []` (they manage no one) — NOT another employee's data; (d) `kraCount` is a number. Keep the pre-existing assertions green (total goes 77 → ~81+).

- [ ] **Step 4 — `deno check` + `node --check`, then STOP (NEEDS_CONTEXT) for the controller to deploy `pms-workflow`.** After deploy, run `node supabase/verify/seed-foundation.mjs && node supabase/verify/workflow-check.mjs` (expect the new total, all pass), then commit both files: `feat(workflow): goal.review-queue — manager-scoped direct-reports goal-plan list (manager approval cutover)`.

---

### Task 2: `ManagerGoalReview` component (callWorkflow only)

**Files:**
- Create: `src/pages/ManagerGoalReview.jsx`

**Interfaces:**
- Consumes: `callWorkflow`/`PmsError` (`src/backend/pmsClient`), `useApp()` (`orgId`). Backend `goal.review-queue`, `goal.get-plan`, `goal.approve`, `goal.send-back`.
- Produces: a default-exported `ManagerGoalReview` component rendering the manager's direct-reports goal-review screen entirely from `callWorkflow`.

- [ ] **Step 1 — Scaffold + queue load.** On mount (when `orgId`), `callWorkflow('goal.review-queue', { orgId })` → hold `{cycle, window, reports}` in state. Render a list of reports with a status pill per report (Submitted / Approved / Sent back / Draft / Not started). States: loading, error+Retry, no active cycle, empty (`You have no direct reports in this cycle.`).

- [ ] **Step 2 — Detail + actions.** Selecting a report calls `goal.get-plan { orgId, cycleId: cycle.id, employeeId }` and renders the goal tree READ-ONLY (KRA cards → KPI rows → target/weight/perspective). Port the read-only visual grammar from `EmployeeGoals.jsx` (reuse its KRA/KPI display; do NOT import EmployeePage). Actions on the selected report:
  - **Approve** — visible only when `report.planStatus === 'submitted'`; enabled only when `window.approvalOpen`. Calls `goal.approve { orgId, cycleId, employeeId, planVersion }`.
  - **Send back** — visible when `submitted` + `approvalOpen`; requires a non-blank note (textarea); calls `goal.send-back { orgId, cycleId, employeeId, planVersion, note }`.
  - After either action, refresh the queue (and clear/refresh the open detail). Show a friendly message + refresh on `PmsError` `CONFLICT` ("someone changed this — reloading"), `PLAN_STATE`, `WINDOW_CLOSED`, `FORBIDDEN`. When `!window.approvalOpen`, show an inline "The manager approval window isn't open yet." note instead of enabled buttons.
  - No blob/localStorage read or write.

- [ ] **Step 3 — Build check + blob grep.** `npm run build` succeeds. `grep -nE "stateStore|app_state|localStorage|ratingsStore|GOAL_WORKFLOW_KEY|hydrate|wizardConfig" src/pages/ManagerGoalReview.jsx` → empty. Commit: `feat(goals): ManagerGoalReview — manager goal approve/send-back via callWorkflow only`.

---

### Task 3: Route the manager Team-tab goal review to `ManagerGoalReview` + retire the blob review path

**Files:**
- Modify: `src/pages/EmployeePage.jsx`

**Interfaces:**
- Consumes: `ManagerGoalReview` (Task 2).
- Produces: the manager's Team-tab goal-review renders `<ManagerGoalReview/>`; the old blob goal `reviewSubmission` path no longer runs for goal approval.

- [ ] **Step 1 — Discover the exact render path.** In `EmployeePage.jsx`, find where the Team tab (`activeSection === 'team'`) renders the goal-review UI during the goal-setting / manager_approval phase (grep `activeSection === 'team'`, `renderTeam`, `reviewSubmission`, the report-list render). Confirm which render branch is GOAL review vs which is later-phase manager EVALUATION review (do NOT touch the eval branch). Record the branches in the report.

- [ ] **Step 2 — Reroute.** `import ManagerGoalReview from './ManagerGoalReview';`. Replace the GOAL-review body of the Team tab (the goal-setting/manager_approval-phase branch) with `<ManagerGoalReview />`. Preserve the Team section shell/nav and the manager EVALUATION branch (later phase) untouched.

- [ ] **Step 3 — Retire the now-dead blob goal-review UI surgically.** Remove the goal-review pieces made dead by the reroute IF cleanly removable (the goal `reviewSubmission` invocation on the goal path, any blob-derived team goal hero stat like `teamSubmitted`/`teamApproved`/`teamPct` shown on the goal-review screen). Per the safety rule, LEAVE anything entangled with the shared `workflow` blob or the manager EVAL path as dead/unreached code and document it. DO NOT touch `stateStore.js`, `approveGoalsAction`/`sendBackGoalsAction` definitions, or the manager EVAL review.

- [ ] **Step 4 — Build + static verification.** `npm run build` succeeds. Grep-confirm: the Team goal-review path renders `<ManagerGoalReview/>`; the goal `reviewSubmission` blob call is off the live goal path; the manager EVAL review branch is intact.

- [ ] **Step 5 — Full gate.** `node supabase/verify/run-all.mjs` (background) → all suites pass incl. the new workflow-check total and `FOUNDATION SMOKE: ALL PASS`.

- [ ] **Step 6 — Browser smoke (documented, controller/user runs).** Sign in as `pms-employee@example.com`, submit goals; sign in as `pms-manager@example.com`, open Team → see the report's submitted plan, open detail, Approve (or Send back with a note); reload → status reflects the backend. Confirm no blob goal review write fires.

- [ ] **Step 7 — Commit + merge.** Commit: `feat(goals): route manager goal review to ManagerGoalReview; retire blob goal-review path (eval review untouched)`. Then final whole-branch review → merge to main.

---

## Out of Scope (later slices)
- Employee self-eval (`eval.*`), results/acknowledgement, notifications — Plan 5c.
- HR review/publish (`publish.*`/`calibration.adjust`/`concern.resolve`) dashboards — Plan 5d.
- HOD calibration screen; the `goal.reopen` (HR) UI — later HR slice.
- Deleting `stateStore`/`reviewSubmission`/`renderGoalSetting` dead code — Plan 6.
