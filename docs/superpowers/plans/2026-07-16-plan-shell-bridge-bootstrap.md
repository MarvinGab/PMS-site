# Shell / Navigation Bootstrap Bridge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the app's shell (login → landing → employee/manager navigation) resolve identity, org, "launched", the current cycle phase, and manager/HOD/report status from the **pms backend** instead of the old blob/localStorage — so the already-migrated screens (EmployeeGoals, ManagerGoalReview, EmployeeSelfEval, HRPublishReview) become reachable by clicking through in a browser (and in production).

**Architecture:** After Plan 5a, `AppContext` gets `role`/`orgId`/`employeeId` from `whoami`, but `orgKey`, the `orgs`/`launched` list, the employee `session` (orgKey/empCode), `currentPhase`, and manager/HOD/report derivation all still come from the old blob (`organizationsData`, `config.employeeUploadData`) and localStorage (`zarohr_emp_session`) — which a clean Supabase-Auth login into a seeded org never populates. This plan adds ONE backend `bootstrap` read that returns everything the shell needs for the signed-in user, feeds it through `AppContext`, and rewires `EmployeePage` + `App.jsx` to consume it. **Scope is strictly shell/navigation/bootstrap** — NO eval cutover, NO wizard rewrite, NO broad HRCycleDashboard refactor (that stays for Plan 5e).

**Tech Stack:** React 19 + Vite (`callWorkflow`/`PmsError` from `src/backend/pmsClient.js`, `useApp()` from `src/AppContext.jsx`); Supabase edge function `pms-workflow` (Deno) on the shared kernel; gate `node supabase/verify/run-all.mjs`.

## Global Constraints

- **Bootstrap is a scoped read for the signed-in caller only** — derives identity from the session (`callerEmployeeId`/membership), never trusts client-supplied identity. Works for every role (employee/manager/hod/hr_admin/super_admin) — HR/super simply get `employee: null`, `isManager: false`.
- **No new blob dependency.** The shell values this adds must come from the pms tables. Keep the transitional blob reads that OTHER un-migrated screens still need (self-eval-results, notifications, HRCycleDashboard internals) — only replace the shell's identity/phase/manager derivation.
- **currentPhase is derived from `cycle_phase_windows` + now()** (the calendar is the source of truth — never a persisted flag), mapped to the frontend phase ids. Frontend phase ids: `goal-setting`, `self-evaluation`, `manager-rating`, `hr-review` (`ALL_PHASES` in EmployeePage). Window keys include `goal_creation`, `manager_approval`, `self_evaluation`, `manager_evaluation`, `hod_review`, `hr_calibration` — the EXACT window-key → phase-id mapping is verified live in Task 1 discovery.
- **HR dashboard navigation stays blob-coupled (Plan 5e).** For the HR publish smoke, the direct `#hr-review` → `HRPublishReview` route is acceptable TEMPORARILY — but it MUST be marked smoke-only (a code comment) as long as reaching it via the real dashboard nav is still blob-coupled.
- **Do NOT break** the migrated screens (they already use `useApp().orgId`), the manager/HOD EVALUATION paths, HRCycleDashboard's own rendering, or `stateStore.js`. Leave entangled blob code as documented dead/unreached code.
- Build in an **isolated worktree off pushed `main`**; wire `.env`, symlink `node_modules`, copy `supabase/.temp`. Full gate green before merge.
- **Deploy handoff:** subagents CANNOT deploy. The Task 1 implementer writes the backend + `deno check` + STOPS (NEEDS_CONTEXT); the controller deploys `pms-workflow`, then resumes for the live check + commit.
- Demo logins (org `acme-test`): `pms-hr@` (hr_admin), `pms-manager@` (EMP001 Mary, manages EMP002), `pms-employee@` (EMP002 Eve), `pms-hod@` (EMP003 Harry) — all `Passw0rd!seed`.

## Out of Scope (later)
- Full HRCycleDashboard bridge (org list, launch flow, cycle setup, roster, monitoring) — Plan 5e.
- Manager/HOD/HR-final EVALUATION authoring+review cutover; results/acknowledgement; concern UI — later slices.
- Deleting blob/stateStore/localStorage session/old functions — Plan 6.

---

### Task 1: `workflow.bootstrap` backend read

**Files:**
- Create: `supabase/functions/pms-workflow/bootstrap.ts` (handler), register it in `supabase/functions/pms-workflow/index.ts`
- Modify: `supabase/verify/workflow-check.mjs` (add bootstrap assertions; keep existing 100 intact)

**Interfaces:**
- Consumes: `_shared/scope.ts` (`callerEmployeeIdOrNull`, `isHrOrSuper`, `manages`/`isHodOf` or a direct `reporting_relationships` count), `_shared/phase.ts` (`pureWindowOpen`, window loading), and the `organizations`/`employees`/`appraisal_cycles`/`cycle_phase_windows`/`reporting_relationships`/`cycle_participants` tables.
- Produces: action `workflow.bootstrap` (any authenticated member; NO role gate, like `workflow.whoami`) returning for the signed-in caller:
  ```
  {
    org: { id, key, name, launched: boolean },          // launched = org has a cycle with status in ('active','review','published')
    employee: { id, code, name, designation, managerCode } | null,   // null for HR/super with no employee row
    cycle: { id, name, status } | null,                 // the org's current cycle (active > review > published > newest draft)
    currentPhase: 'goal-setting'|'self-evaluation'|'manager-rating'|'hr-review'|null,   // from windows + now()
    isManager: boolean,                                  // caller has ≥1 direct report (relation manager/l2)
    directReportsCount: number,
    hodReportsCount: number
  }
  ```

- [ ] **Step 1 — DISCOVERY (print real shapes; do not guess):** Scratch `deno` snippet against the live project (delete before committing; load creds from `.env` like a `supabase/verify/*.mjs`): print (a) `organizations` columns (`id, key, name, ...`); (b) the `appraisal_cycles` statuses present for acme-test; (c) all distinct `cycle_phase_windows.window_key` values for the seeded cycle; (d) the `employees` columns for name/code/designation + how the caller's `managerCode` is found (via `reporting_relationships` where the caller `employee_id` has a `relation_type='manager'` related employee → that employee's `employee_code`); (e) confirm the acme-test seed: EMP001 manages EMP002 (so EMP001 bootstrap → isManager true, directReportsCount≥1), EMP002 → isManager false. Record the window-key → phase-id mapping you'll use (e.g. `goal_creation`/`manager_approval` → `goal-setting`; `self_evaluation` → `self-evaluation`; `manager_evaluation` → `manager-rating`; `hr_calibration`/`hod_review` → `hr-review`), plus the fallback when no window is open (use the cycle status, else `goal-setting`).

- [ ] **Step 2 — Write the handler** in `bootstrap.ts` and register in `index.ts`'s handler map. Resolve the caller's membership org; `org.launched` from the cycle-status check; `employee` from the caller's `employees` row (null if none); `cycle` = the org's current cycle (prefer active, then review, then published, then newest); `currentPhase` from the open `cycle_phase_windows` (mapped per discovery, HR bypass NOT relevant — this is a display value); `isManager`/`directReportsCount`/`hodReportsCount` from `reporting_relationships` (`related_employee_id` = caller, `relation_type in ('manager','l2')` for reports, `'hod'` for hod). Wrap primary-query errors as `ApiError('DB_ERROR','Database error',500)`; never leak raw Postgres text. Read-only.

- [ ] **Step 3 — Assertions in `workflow-check.mjs`.** As the seed users: EMP001 bootstrap → `org.key==='acme-test'`, `employee.code==='EMP001'`, `isManager===true`, `directReportsCount>=1`; EMP002 → `employee.code==='EMP002'`, `isManager===false`; HR → `employee===null`, `org.launched` boolean; `currentPhase` is one of the allowed ids or null; `cycle` present or null consistently. Keep the existing 100 green.

- [ ] **Step 4 — `deno check` + `node --check`, then STOP (NEEDS_CONTEXT) for the controller to deploy `pms-workflow`.** After deploy, run `node supabase/verify/seed-foundation.mjs && node supabase/verify/workflow-check.mjs` (expect the new total, all pass), then commit: `feat(workflow): workflow.bootstrap — shell identity/org/cycle-phase/reports read`.

---

### Task 2: `AppContext` consumes bootstrap

**Files:**
- Modify: `src/AppContext.jsx`

**Interfaces:**
- Consumes: `callWorkflow` (already imported or add), the Task 1 `workflow.bootstrap`.
- Produces: `useApp()` additionally exposes `orgKey`, `orgName`, `launched`, `employeeCode`, `employeeName`, `managerCode`, `designation`, `currentPhase`, `isManager`, `directReportsCount`, `hodReportsCount` (all `null`/`false`/`0` until loaded). Existing fields (`userId`, `role`, `orgId`, `employeeId`, `memberships`, `orgs`, `authReady`, ...) unchanged.

- [ ] **Step 1 — Fetch bootstrap after whoami.** In the auth effect (right after `admin.whoami` → `deriveIdentity`), call `callWorkflow('workflow.bootstrap', {})`; store the result in state; expose the fields above via the context `value`. If bootstrap fails, leave the fields null (don't crash the app; `authReady` still resolves). Add a `refreshBootstrap()` for later use. (Do NOT remove the existing blob `orgs`/`setOrgs` etc. — un-migrated screens still use them.)

- [ ] **Step 2 — Build check.** `npm run build` succeeds. Commit: `feat(shell): AppContext exposes bootstrap (orgKey/employee/currentPhase/isManager) from the backend`.

---

### Task 3: `EmployeePage` + `App.jsx` consume context (controller-implemented)

**Files:**
- Modify: `src/pages/EmployeePage.jsx`, `src/App.jsx`

- [ ] **Step 1 — Discover the blob-sourced shell values in EmployeePage** and their downstream use: `session` (from `zarohr_emp_session` localStorage — fields used: `orgKey`, `empCode`, `name`, `managerCode`, `userName`, `designation`); `currentPhase` (line ~2217, from blob org) + `calendarSubPhase` (~2224); `isManagerForSomeone`/`hodReports`/`directReports` (from `config.employeeUploadData`). Record the minimal replacement for each from `useApp()` bootstrap fields.

- [ ] **Step 2 — Bridge them.** Build `session` from `useApp()` (`{ orgKey, empCode: employeeCode, name: employeeName, managerCode, designation, userName: employeeName }`) when the localStorage session is absent (keep the localStorage path as a fallback for the old impersonation flow so it doesn't regress). Source `currentPhase` from `useApp().currentPhase` (fall back to the existing blob derivation if null). Gate the Team tab / manager UI on `useApp().isManager` / `directReportsCount` (fall back to the blob derivation). Keep everything else. The migrated screens (`<EmployeeGoals/>`, `<EmployeeSelfEval/>`, `<ManagerGoalReview/>`) already use `useApp().orgId` — they just need to be REACHED, which these fixes enable.

- [ ] **Step 3 — App.jsx HR landing uses backend `launched`.** Use `useApp().launched` (bootstrap) for the `role === 'hr_admin'` dashboard-vs-setup decision instead of `orgs.find(...).launched`. Add a comment on the `route === 'hr-review'` → `<HRPublishReview/>` branch marking it the SMOKE-ONLY HR entry until the HRCycleDashboard nav is bridged in Plan 5e.

- [ ] **Step 4 — Build + static verification.** `npm run build` succeeds. Confirm: an employee/manager with only a Supabase-Auth session (no localStorage `zarohr_emp_session`) gets a non-empty `session` (orgKey/empCode) + a `currentPhase` from context; the migrated screens still render; nothing else regressed.

- [ ] **Step 5 — Commit.** `feat(shell): EmployeePage + App derive session/currentPhase/manager-flags/launched from backend bootstrap (browser-navigable)`.

---

### Task 4: Seed walk-through demo state + gate + browser smoke + merge

**Files:**
- Create: `supabase/verify/seed-demo-walkthrough.mjs` (committed, reproducible)

- [ ] **Step 1 — Write a seed script** that puts the acme-test demo into browser-smoke-able states (idempotent; reuses `seed-foundation`'s org/users). It should provide, clearly labelled:
  - **Flows 1–3 (goals / manager-approval / self-eval):** the acme-test cycle `status='active'` with `goal_creation` AND `self_evaluation` windows OPEN (spanning today), `manager_approval` open too; EMP002 a participant with an **approved** goal plan (so self-eval is available) and EMP001 (Mary) as the approving manager.
  - **Flow 4 (HR publish/revoke):** a cycle in `review` status with submitted `hr_final` evaluations for its participants + bell bands configured (so `publish.review-list`/`publish.publish`/`revoke` have real data). If one cycle can't be both `active` (flows 1–3) and `review` (flow 4) at once, seed flow 4 on a SECOND cycle/org (e.g. beta-test) OR make the script take a mode arg — document which login+workspace to use for the HR smoke. Print the exact logins + workspace + which flow each state supports.
- [ ] **Step 2 — Full gate.** `node supabase/verify/run-all.mjs` (background) → all suites pass incl. the new workflow-check total + `FOUNDATION SMOKE: ALL PASS`.
- [ ] **Step 3 — Browser smoke (documented; controller/user runs).** With the walk-through seed applied: sign in as `pms-employee@` → Goals renders + save/submit; `pms-manager@` → Team → ManagerGoalReview sees the submitted plan → approve; `pms-employee@` → self-eval; `pms-hr@` (or `#hr-review`) → HRPublishReview → calibrate → publish/revoke. Record what worked.
- [ ] **Step 4 — Commit + final whole-branch review → merge to main.** Commit: `test(seed): demo walk-through states for browser smoke (active goals/self-eval + review-with-finals)`.
