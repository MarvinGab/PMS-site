# Plan 5b — Employee Goal-Setting Cutover (Design)

**Status:** Approved 2026-07-14. Second frontend sub-plan of Plan 5 (5a auth foundation merged at b7a4ae3).

## Context

Plan 5a moved auth/identity/authz to Supabase Auth + `whoami`; `AppContext` now exposes `userId`, `role`, `orgId`, `employeeId`, and the app has a typed `callPms`/`callWorkflow` client. The employee portal (`EmployeePage.jsx`, ~8k lines) still runs on the old `app_state`/blob/`localStorage` architecture for its data (goals, self-eval, results, notifications). Per [[feedback-plan5-scoped-reads]], each migrated screen must fetch ONLY the signed-in user's scoped rows and hold NO blob source of truth.

The employee portal is being cut over one flow at a time. **5b is the first flow: employee goal-setting.** Self-evaluation, results/acknowledgement, and notifications are separate follow-up slices (own spec → plan → review → smoke each).

`pms-workflow` already exposes the goal actions: `goal.get-plan`, `goal.ensure-plan` (create draft + seed from the assigned library/prefill), `goal.save-items` (replace the goal tree, version-checked, group-`can_edit_own_goals`-gated), `goal.submit` (draft→submitted). It does NOT expose the cycle goal **config** the UI needs to render — the old screen reads that from the blob.

## Goal

Migrate the employee goal-setting flow to a self-contained `EmployeeGoals` component backed **only** by `callWorkflow`, with a new scoped `goal.context` backend read supplying the cycle + config + window + plan in one round-trip. After 5b, an employee sets/edits/submits goals entirely against `pms-workflow` (scoped to themselves, phase/status/conflict enforced server-side), with **no** `app_state`/`stateStore`/`localStorage`/wizard-config/ratings source of truth for goal data.

## Scope

### In scope
1. **New backend action `goal.context`** (`pms-workflow/goals.ts`) — a pure, scoped read for the signed-in employee (`callerEmployeeId`; HR/super may pass an `employeeId`). Returns in ONE response:
   - `cycle`: the org's active cycle `{ id, name, status }` (resolve via the employee's active `cycle_participants` row / `loadActiveCycle`).
   - `config`: the goal config the UI needs — `goalCreationMode` (admin-library / employee-self), `goalKpiMode` (kra-kpi / kra-only), `kpiRatingMode` (rated / free-text), `targetLevelMode`, `targetTypes` (from `cycle_target_types`), `ratingScale` (from `cycle_rating_scale_levels`), the employee's group `canEditOwnGoals` (from `cycle_groups`), and the applicable `goalRules` (weights/count constraints) — assembled from `cycle_config_snapshots` + `cycle_groups` + `cycle_target_types` + `cycle_rating_scale_levels` + `goal_rules`, all org-scoped.
   - `window`: `{ goalOpen: boolean }` — is `now()` within the `goal_creation` (or equivalent) `cycle_phase_windows` row (via `_shared/phase` `pureWindowOpen`); HR bypass reflected.
   - `plan`, `items`, `competencies`: the current plan bundle (same shape as `goal.get-plan`; `plan:null`/`items:[]` if none).
   Exact snapshot field names are verified against the live `cycle_config_snapshots.snapshot` shape during implementation.
2. **New frontend component `EmployeeGoals`** (`src/pages/EmployeeGoals.jsx` or `src/components/`), data layer = `callWorkflow` ONLY:
   - Mount → `goal.context`. If `plan` is null and `window.goalOpen` and the employee may create → `goal.ensure-plan` (creates draft + seeds) → re-render with the seeded items.
   - Edit (add/edit/delete KRA + KPI, add-from-library, set targets) is local component state over the backend items; **save** persists via `goal.save-items` (replaces the tree). **Delete = the item is simply absent from the saved rows** (no trash).
   - **Submit** via `goal.submit`; the plan status (draft → submitted → approved / sent_back) is displayed from the backend.
   - Ports the existing goal UI/look; introduces NO blob/localStorage read or write for goal data.
3. **Route the employee "goals" section to `EmployeeGoals`** and **retire** the old blob goal code on the employee path: the goals-section rendering in `EmployeePage.jsx`, the employee-side `submitGoalsAction`, and the `GOAL_WORKFLOW_KEY` localStorage. (`approveGoalsAction`/`sendBackGoalsAction` are manager/HR goal *review* — untouched here, migrated in 5c/5d.)
4. **Gate:** a Node integration check (extend `workflow-check.mjs` or a new `goals-check.mjs`) exercising `goal.context` → `ensure-plan` → `save-items` → `submit` as the seeded employee (asserting scope, window, status transitions, and a stale-version conflict), wired into `run-all.mjs`.
5. **Browser smoke** of the goals tab after build (documented steps).

### Out of scope (later slices / plans)
- Self-eval (`eval.*`), results + acknowledgement (`eval.get` published + `ack.*`), and notifications — later employee-portal slices.
- Manager/HOD/HR goal **review** (approve / send-back / reopen) — 5c/5d.
- Deleting the blob / `stateStore` / `app_state` and old functions — Plan 6.

## Architecture & Data Flow

```
Mount: EmployeeGoals → callWorkflow('goal.context', {}) → { cycle, config, window, plan, items }
Start: plan==null && window.goalOpen && canCreate → callWorkflow('goal.ensure-plan') → { plan, items, seeded }
Edit:  local component state (KRA/KPI tree) over `items`; Save → callWorkflow('goal.save-items', { items, planVersion }) → { plan, items }
Submit: callWorkflow('goal.submit', { planVersion }) → { plan } (status submitted)
Read-only: window closed OR status in {submitted, approved} → render read-only; WINDOW_CLOSED/CONFLICT → friendly message + refresh
```

### Components (isolated units)
- `goal.context` handler (backend) — one scoped read; depends on `_shared/scope`, `_shared/phase`, existing goal-plan bundle helper.
- `EmployeeGoals` (frontend) — one component owning the goals UI + its `callWorkflow` calls; depends on `callWorkflow`, `useApp()` (employeeId/role), and the goal config shape from `goal.context`. No blob deps.
- (Optional) a small pure helper for goal-tree ↔ save-items shaping, if it aids testability.

## Error Handling & Enforcement (server-side)
- **Scope:** `goal.context`/`save-items`/`submit` derive the employee from the session (`callerEmployeeId`); an employee can only read/write their OWN plan (HR/super may target another). No client-supplied identity is trusted.
- **Phase/window:** editing/submitting outside the goal window → `WINDOW_CLOSED` (HR bypass); the UI reflects `window.goalOpen` (disable edit) and surfaces the error if it races.
- **Plan status:** submit/edit gated by status server-side; a submitted/approved plan is read-only.
- **Conflicts:** `goal.save-items`/`submit` are version-checked → `CONFLICT` on stale writes; the client shows "someone else changed this — reload" and refetches `goal.context`.
- No raw DB errors reach the client (generic `DB_ERROR`).

## Testing
- **Node integration** (gate): as the seeded employee — `goal.context` returns the active cycle + config + `goalOpen` + plan; `ensure-plan` seeds; `save-items` persists a tree; `submit` transitions to submitted; a second `save-items` with a stale `planVersion` → `CONFLICT`; an out-of-window edit (or a non-participant) is rejected. Wired into `run-all.mjs`; the rest of the gate stays green.
- **Browser smoke** (documented): sign in as the seeded employee → open the goals tab → it loads from `goal.context` (no blob), shows the seeded/prior goals, add/edit/delete a KRA+KPI, save (persists), submit (goes read-only), reload (state comes back from the backend). Confirm no `app_state`/`stateStore`/`localStorage` goal reads/writes fire (network + a source grep).

## Build & Rollout
- Build in an **isolated worktree off pushed `main`** (`rebuild-5b-goals`); wire `.env`, symlink `node_modules`, copy `supabase/.temp` (migrations are all committed now — no copying). Full gate green before merge.
- Deploy `pms-workflow` for the new `goal.context` action (controller handles the gated deploy).

## Success Criteria
- Employee goal-setting reads/writes go **only** through `callWorkflow` (`goal.context`/`ensure-plan`/`save-items`/`submit`); a grep of `EmployeeGoals` shows no `app_state`/`stateStore`/`localStorage`/ratings/wizard-config import.
- Scope, window, plan-status, and conflicts are all enforced by the backend and reflected in the UI.
- `goal.context` + the goal-flow integration check are green in `run-all.mjs`; the rest of the gate stays green.
- The goals tab works end-to-end in the browser smoke; the old blob goal-setting code on the employee path is removed.
