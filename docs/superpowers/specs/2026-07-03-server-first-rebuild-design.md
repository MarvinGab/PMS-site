# Server-First Rebuild — Design Spec

**Date:** 2026-07-03
**Status:** Approved design, pre-implementation
**Approach:** Freeze feature work → build new server-first foundation → rewire screens → cut over → delete blob architecture.

---

## 1. Goal

Rebuild the PMS app's data and operation layer from a local-first "one big org JSON blob" MVP into a server-first, table-backed, cycle-based, permission-checked platform where every workflow action is small, authorized, auditable, and fast.

**Final target behaviors:**

- Backend/database is the sole source of truth; the browser only caches UI data.
- Real appraisal-cycle model with history.
- All business writes go through backend functions with validation, permission + phase checks, transactions, and audit logs.
- Reads are scoped and paginated — no screen downloads the whole organization.
- Safe concurrent edits (version checks, conflict responses — never silent overwrites).
- Slow work (invites, reminders, publish notifications, exports, imports) runs as background jobs with retry and status.
- Scales to hundreds/thousands of employees per org.

## 2. Decisions Made (with user)

| Decision | Choice |
|---|---|
| Existing data | Test/demo only — design tables freely, start fresh; no data migration required |
| Rollout | Freeze & rebuild: build the whole new backend first, then reconnect screens |
| Login | Supabase Auth replaces custom passwords/OTP system |
| Cycle model | One **working** cycle per org (draft/setup/active/review/published), enforced by the database; archived cycles are unlimited history |
| Screens | Keep current look & behavior; rewire data access only; split big files only where necessary |
| Architecture | **Hybrid**: browser reads RLS-scoped rows directly (pagination + realtime stay cheap); all business writes go through backend functions |

**Write rule (exact wording):** The browser may only read rows allowed by RLS. All business writes go through backend functions. Direct table writes from browser clients are denied except harmless user-owned profile/session metadata if ever needed. Reason: RLS can safely allow scoped reads, but PMS workflow writes need phase checks, prerequisite checks, audit, and multi-table transactions.

## 3. Current State (summary)

- **Blob**: `app_state` table holds whole-org JSONB blobs (`app_data`, `wizard_state`, `workflow`, `ratings`, `messages`, sessions, OTPs), written directly with the anon key; localStorage mirrors everything.
- **Partially normalized**: wizard fans out into `goal_libraries`, `employees`, `pms_configs`, etc., but driven from the client and delete-all-reinsert style.
- **Already server-first (keep the logic, move into new structure)**: ratings submit/clear/publish/revoke/acknowledge/concern (`pms-actions`), goals submit/approve/send-back/reopen, org save, auth/sessions (`app-auth`), email engine (`send-email`, `email-config`), phase-calendar math (`cyclePhase.js`).
- **Security gaps**: RLS effectively absent on business tables; anon key can read/write employees, ratings, etc.; org config (incl. cycle windows) nests in `organizations.setup_payload.orgData`.
- **No** cycle model, pagination, background jobs, or clean new-cycle flow.

## 4. Data Model

### 4.1 Conventions

- **Tables** for anything multi-row, or that is assigned, filtered, joined, paginated, edited, or audited per employee/group/cycle.
- **Frozen JSON** (`cycle_config_snapshots`) only for singleton rule blocks read solely by runtime logic (roster schema flags, notification config, bell/auto-rating enable flags, target config header, etc.).
- Every row carries `organization_id` (and `cycle_id` where applicable), `updated_at`, and a `version` integer for optimistic concurrency. Stale-version writes return a conflict response.
- **Dead/legacy fields are deleted, not migrated**: `ratingLevels`, `selfVisibility`, `l1Visibility`, `managerOverride`, `peerVisibility`, `finalRatingOwner`, `commentRequiredAt`, `freezeGoalSetting`, `managerUnlockGoals`, `freezeSelfEval`, `hrReopenSelf`, `midYearRevision`, `bellPerDept`, `bellNotify`, and `enabledModules` entries for unbuilt modules (questionnaire, IDP, potential, peer/subordinate, midyear). `enabledModules` becomes explicit per-cycle feature flags for modules that exist.

### 4.2 Core tables

Org-level (evolves over time): `organizations`, `org_members`, `employees`, `reporting_relationships`, `org_grades`, `competency_library`, `goal_libraries`, `goal_library_items`, `prefill_datasets`, `prefill_dataset_items`, `organization_branding`.

Cycle-level (pinned per cycle): `appraisal_cycles`, `cycle_phase_windows`, `cycle_config_snapshots`, `cycle_config_versions`, `cycle_perspectives`, `cycle_groups`, `cycle_group_segment_values`, `cycle_group_library_assignments`, `cycle_target_types`, `cycle_rating_scale_levels`, `cycle_auto_rating_bands`, `cycle_goal_rules`, `cycle_competency_config`, `cycle_competency_assignments`, `cycle_bell_curve_bands`, `cycle_participants`, `cycle_participant_assignments`.

Workflow: `employee_goal_plans`, `employee_goal_items`, `employee_goal_plan_competencies`, `goal_workflow_events`, `evaluations` (stage: self / manager / hod / hr_final), `evaluation_goal_scores`, `evaluation_competency_scores`, `calibrations` (before/after score, note, actor), `cycle_publications`, `rating_acknowledgements` (cycle-scoped, replacing org-scoped versions).

Plumbing: `notifications`, `email_jobs`, `email_delivery_attempts`, `background_jobs`, `import_runs`, `import_run_errors`, `audit_logs`.

### 4.3 Wizard → schema mapping (authoritative)

The wizard stops being a config-blob builder and becomes a **server-side cycle creation workflow**. Field-by-field mapping:

1. **Framework selection** — `frameworkId` → `appraisal_cycles.framework_id` + snapshot; BSC perspectives → `cycle_perspectives` (name, weight, color, display_order; weights feed final score). `enabledModules` → explicit cycle feature flags.
2. **Groups & strategy** — `goalGroups` → `cycle_groups` (name, segment_attr, is_catch_all, can_edit_own_goals, prefill_type, has_library, target_level, kpi_rating_mode) + `cycle_group_segment_values` + `cycle_group_library_assignments` (slot_key, slot_label, goal_library_id). Group rules drive upload validation, library assignment, prefill, target level, competencies, HR filters, reports — must be tables, not blob.
3. **Target setup** — `targetTypes` → `cycle_target_types` (key, name, is_numeric, unit, unit_position, min/max, lower_is_better, hidden). `lowerIsBetter` is real and used in scoring — keep. Target config header (targetsEnabled, targetLevelMode) → snapshot.
4. **Rating scale** — scale header (points, input_mode, precision, rating_choice_display, final_rating_display, manager_comment_mode, visibility-from settings) → snapshot; per-point rows → `cycle_rating_scale_levels` (point, label, code, range_from, range_to). **Frozen per cycle** — old results must show old labels forever.
5. **Auto-rating** — enabled + manager_can_override → snapshot; bands → `cycle_auto_rating_bands` (from_percent, to_percent, score). Feeds suggested scores and lower-is-better scoring.
6. **Goal libraries / prefill** — `goal_libraries` + `goal_library_items` + `prefill_datasets` + `prefill_dataset_items` at org level; cycle pins usage via `cycle_group_library_assignments`. Server actions write these directly (no client fan-out).
7. **Goal limits & rules** — → `cycle_goal_rules` (nullable group_id for per-group overrides): min/max KRAs, min/max KPIs per KRA, weight bounds, weightage_ownership, employee_can_add_goals, max_employee_added_goals, manager_can_add_goals, approval_required. **Server-enforced**, not just frontend validation.
8. **Employee settings / roster schema** — manager_levels, require_email, hod_enabled, hod_detailed_calibration, grade_enabled → snapshot (roster schema block); grade labels → `org_grades`. Roster → `employees`, `reporting_relationships`, `cycle_participants`.
9. **Employee upload** — browser parses/previews only. Backend: `import_runs` + `import_run_errors`; validate all rows → return preview/errors → commit step writes `employees`, `cycle_participants`, `cycle_participant_assignments`, `reporting_relationships` in one transaction; queues invites via `email_jobs`. No browser-side credential creation; no delete-all-and-reinsert from the client.
10. **Competencies** — org `competency_library`; `cycle_competency_config` (enabled, max_per_employee, competency_weight, allow_self_rate, employee_can_edit, scope: org/group/group_role); `cycle_competency_assignments` (nullable group_id, nullable role_name, competency ref, kra_share, competency_share); employee-selected → `employee_goal_plan_competencies`. Resolution order: employee-selected (if editing enabled) → role override → group → org. Frozen per cycle; group/role mapping depends on uploaded designations and must be preserved historically.
11. **Bell curve** — bell_enabled, bell_mode, bell_preset → snapshot (calibration config block); bands → `cycle_bell_curve_bands` (rating_point, target_percent, tolerance_percent). Drives HR review tab, publish blocking, distribution chart, exports. `bellPerDept` / `bellNotify` deleted (not wired).
12. **HOD / HR calibration** — evaluation stages self/manager/hod/hr_final in `evaluations`; every calibration adjustment also writes a `calibrations` row (before_score, after_score, note, actor_id, created_at) — audited, conflict-protected, never a loose payload.
13. **Publishing / acknowledgement** — `cycle_publications` (published_at/by, revoked_at/by, reason) and `rating_acknowledgements` (decision, reason, submitted_at, resolution_status, resolution_note, resolved_by/at) — both **cycle-scoped** (current tables are org-scoped; rebuild makes them per-cycle). Gated by finalEmployeeAcceptanceEnabled and visibility-from settings in the snapshot.
14. **Notifications / email** — `notifications` (org_id, cycle_id, recipient_member_id, type, title, body, read_at); `email_jobs` + `email_delivery_attempts`. Email toggle lives in cycle notification config (snapshot block). New events route through notify → notifications row + email mirror when enabled.
15. **Quick config after launch** — lock stages: **draft/setup** freely editable → **active** controlled amendments → **after first submission** versioned amendment with audit (`cycle_config_versions`) → **after publish** locked.
16. **Target level vs rating level are separate settings, per group.** Target level = where targets/achievements are captured (KRA / KPI / custom per group). Rating level = where employee/manager scores are captured (KRA / KPI). Never collapsed; both stored per cycle group.

### 4.4 "Create cycle" transaction

One backend transaction: create cycle row → phase windows → frozen config snapshot → perspectives → groups + segment values → target types → rating scale levels → auto-rating bands → goal rules → competency config + assignments → bell config + bands → notification/publishing config → import/attach employees → validate RM/HOD/L2 codes → create participants → per-participant group/library/prefill assignments → initial goal plans where applicable → queue invites → audit the whole operation.

## 5. Login & Permissions

- Every person gets one **Supabase Auth** account (email + password, managed resets). Custom password hashes, OTP reset system, and browser credential storage retire.
- `org_members` links auth user → org with roles (super_admin / hr_admin / hod / manager / employee); one person may hold several roles.
- Roster import queues **invite emails**; users set their own password on first login. HR can re-invite/reset but never sees or sets passwords.
- **Reads (RLS):** employee → own rows; manager → direct reports (only stages they may see, honoring visible-after-publish settings); HOD → mapped department; HR admin → own org; super admin → all orgs.
- **Writes:** backend functions only (see §2 write rule). Every handler re-checks: valid login → org membership → role → target employee in scope → cycle status + phase window allows action → prerequisites complete. Then one transaction + one audit row.
- **Roster-only rule (server-side):** every reporting manager / HOD / L2 must be an `employees` row. `Group Name = NONE` = roster-only, outside PMS: referenceable as manager/HOD, excluded from PMS participation/screens/invites unless they hold an operational role (then they get only that role's access). Never label these "Outside PMS" in the UI — blank or literal "NONE".

## 6. Backend Organization

- Domain modules: auth, organizations, cycles, employees (incl. imports), goals, evaluations, calibration, publishing, acknowledgements, notifications, emails, exports, jobs, audit.
- Deployed as a few grouped edge functions (e.g. `pms-admin`, `pms-workflow`, `pms-jobs`) to limit cold starts; code organized one module per domain with a shared kernel: session check → org/role resolution → input validation → handler dispatch. Adding an action = one small handler file.
- **Handler contract:** validate input → permission + cycle-state/phase check → transaction-safe row writes with version check → audit log entry → consistent response shape (ok / data / error-code / human message). Stale version → explicit conflict response ("someone else changed this — reload"), never silent overwrite.
- **Phase logic lives once:** one shared calendar module (windows + now → active sub-phases) used by frontend for display and backend for enforcement; backend is authoritative. Ends the current JS/TS duplication.
- **Scoring lives once, server-side:** achievement %, auto-rating bands, lower-is-better, competency share, final score — computed and stored at submit/calibrate/publish time; frontend only previews.
- Frontend gets one thin API client (`callPms('domain.action', payload)`) plus per-screen read helpers (paginated, filtered server-side). No page talks to tables for writes.

## 7. Cycle Lifecycle

- **Statuses:** draft → setup → active → review → published → archived. One working cycle (draft/setup/active/review/published) per org, DB-enforced; archived cycles unlimited.
- **draft/setup** — wizard collects choices; config freely editable; invisible to employees.
- **active** — created via the create-cycle transaction; goal setting & evaluations run by the phase calendar; config changes per lock stages (§4.3.15).
- **review** — evaluation windows over; HOD/HR calibration + bell-curve checks.
- **published** — results visible per visibility settings; acknowledgement/concern flow runs; config locked; revoke-publish possible (audited) → back to review.
- **archived** — read-only forever; history views and exports.
- **Phase calendar stays king:** windows in `cycle_phase_windows`; sub-phase always computed from dates + now, never persisted as a flag. Super-admin edits win over HR-admin (last-write-wins with version check, both audited).
- **Phase windows may overlap:** goal creation, manager goal approval, self-evaluation, manager evaluation, HOD/HR review, calibration, publishing prep, and acknowledgement are independent windows. The backend checks the specific action's window plus that employee's prerequisites; it must not reduce the cycle to one global current phase.
- **"Start new cycle" replaces "clean organization":** archive current cycle (nothing deleted) → create new draft → HR chooses carry-over (settings snapshot, goal libraries/prefill, roster & reporting lines, participants with add/remove) → re-validate carried data → same create-cycle transaction. No manual deletion; no leftover state; old cycle stays queryable under its cycle id.
- **Org-level vs cycle-level:** roster, reporting relationships, grades, competency library, branding, goal libraries evolve at org level; each cycle pins what it uses (participants, assignments, frozen snapshot) so history never shifts.

## 8. Jobs, Notifications, Emails, Exports

- **`background_jobs`**: queued → running → done/failed, with progress %, retry count, failure reason; worked by a scheduled backend function (every minute). Job types: invite batches, reminder batches, publish notifications, exports, roster import commits, new-cycle carry-over. Screens show live job status; nothing slow runs inside a button click.
- **Emails:** every email is an `email_jobs` row first (queued/sent/failed, attempts logged in `email_delivery_attempts`), sent by the job worker through the existing multi-provider engine (SMTP / Graph / Gmail). Failed sends visible and retryable.
- **Notifications:** bell = `notifications` rows; new events email-mirror through the same path when the per-cycle email toggle is on.
- **Exports:** generated server-side as jobs; HR gets a download link when ready.

## 9. Cutover Plan

1. Build the full new schema + auth + API alongside the old system (old app untouched while building).
2. Rewire screens one by one against the new backend — same look, scoped paginated data.
3. Verify end-to-end with a fresh test org: wizard → invite → goals → approvals → self/manager eval → HOD → HR calibrate → publish → acknowledge → new cycle.
4. Delete the old world: `app_state` blob usage, localStorage sync layer, browser credential handling, old edge-function code paths, dead config fields. RLS ends deny-by-default on every business table.

**Safety rule:** No old production data is deleted until the new schema has passed fresh-org tests and any required migration/export backup has been verified.

## 10. Testing

- Automated tests for backend permission checks, phase gating, and scoring rules — the parts that must never silently break.
- **Concurrency tests:** two HR/managers editing the same employee/cycle row with stale versions must produce a conflict response, not an overwrite.
- Per-domain smoke scripts run against a test org before cutover.
- End-to-end walkthrough (§9.3) is the cutover gate.
