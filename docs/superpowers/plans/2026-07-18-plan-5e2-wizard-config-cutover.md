# 5e-2 — Setup Wizard Config Cutover Implementation Plan

> REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Continuous execution — no approval gates between tasks.

**Goal:** The setup wizard (`PMSWizard.jsx`) loads/saves ALL cycle config to the pms-admin backend instead of the blob — so a created org can be configured end-to-end server-side. UI/steps unchanged; only the persistence + load boundary is rewired.

**Architecture:** The backend already has every write: `cycle.save-section` (perspectives, groups, target_types, rating_scale_levels, auto_rating_bands, goal_rules, competency_config, competency_assignments, bell_curve_bands), `cycle.set-snapshot-block` (visibility, roster_schema, notifications, targets, rating_scale, auto_rating, features), `cycle.set-windows`, `cycle.set-admin-config` (bell), `library.save/list/archive`, `prefill.save/list`. What's missing is ONE READ (`cycle.get-config`) so the wizard can load/resume. This slice adds that read, then replaces the wizard's blob `saveWizardState`/`readWizardState` with a backend push/load that maps the wizard config object ↔ the section actions. Roster import + participants = 5e-3; launch/invites = 5e-4.

**Tech Stack:** React 19 + Vite (`callPms`/`PmsError`, `useApp()`); pms-admin (Deno); gate `node supabase/verify/run-all.mjs`.

## Global Constraints
- Config load/save = `callPms` ONLY. No `saveWizardState`/`readWizardState`/blob/localStorage/serverSessionToken as the config source of truth for a real (backend) cycle. (A blob draft cache for an UNSAVED new cycle before it has a cycleId is acceptable transitional, but once the cycle exists, the backend is the source of truth.)
- Backend enforces auth (`requireOrgRole hr_admin`, super_admin bypass) + optimistic `version` → CONFLICT.
- Preserve the wizard UI/steps. This is a data-layer rewire.
- Palette red/green for status only; never render "Outside PMS"; RMs are employees first.
- Isolated worktree off pushed main; full gate green before merge; deploy-handoff (controller deploys pms-admin).

## Out of Scope (next sub-slices)
- Roster upload/import + participants/reporting-lines UI → 5e-3.
- Launch/activate + invites (Supabase Auth users + email jobs) → 5e-4.
- Deleting old blob wizard code → Plan 6 removal pass.

---

### Task 1: `cycle.get-config` backend read
**Files:** Modify `supabase/functions/pms-admin/cycles.ts` (add `cycle.get-config`), `supabase/verify/admin-check.mjs` (+assertions; keep 117).
- [ ] DISCOVERY: print the columns of every config table (cycle_perspectives, cycle_groups, cycle_group_segment_values, cycle_target_types, cycle_rating_scale_levels, cycle_auto_rating_bands, cycle_goal_rules, cycle_competency_config, cycle_competency_assignments, cycle_bell_curve_bands, cycle_phase_windows, cycle_config_snapshots, cycle_admin_config) + goal_libraries/goal_library_items + prefill_datasets. Record shapes.
- [ ] Add `cycle.get-config` (`requireOrgRole hr_admin`, super bypass): `{orgId, cycleId}` → `{ cycle:{id,name,status,version,frameworkId}, sections:{perspectives:[...], groups:[...], targetTypes:[...], ratingScale:[...], autoRatingBands:[...], goalRules:[...], competencyConfig:{...}, competencyAssignments:[...], bellCurveBands:[...]}, windows:[...], snapshot:{...}, adminConfig:{...}, libraries:[{...,items:[...]}], prefill:[...] }`. Batched reads, group in JS, DB_ERROR wrapping, read-only.
- [ ] Assertions: as HR/super on a fixture cycle, get-config returns the cycle + a well-shaped sections object; non-HR 403. Keep 117.
- [ ] deno check + node check → STOP (NEEDS_CONTEXT) for controller deploy. Then live check + commit `feat(admin): cycle.get-config — full cycle config read for the setup wizard`.

---

### Task 2: Wizard load + save via backend
**Files:** Modify `src/PMSWizard.jsx` (+ a small `src/backend/wizardConfigMap.js` pure mapper if it aids testability).
- [ ] DISCOVERY: read how the wizard holds config in memory (its `config`/`form` state shape) + where `saveWizardState`/`readWizardState` are called (3 save, 2 read). Map each wizard config field ↔ a backend section/snapshot/window/admin/library payload. Record the field map.
- [ ] **Load:** when editing a cycle that has a backend `cycleId`, populate the wizard from `callPms('cycle.get-config', {orgId, cycleId})` (mapped to the wizard shape) instead of `readWizardState`. For a brand-new unsaved cycle, a local draft is fine until first save.
- [ ] **Save:** replace `saveWizardState(...)` (blob) with a backend push that, per changed step, calls the matching action: `cycle.save-section` (the 9 sections), `cycle.set-snapshot-block` (visibility/roster_schema/notifications/targets/rating_scale/auto_rating/features), `cycle.set-windows`, `cycle.set-admin-config` (bell), `library.save`/`prefill.save` for goal libraries. Use the cycle `version` for optimistic concurrency; on `CONFLICT` reload from get-config. Surface `PmsError` messages in the wizard's existing feedback area.
- [ ] Keep the wizard UI/steps unchanged; only the persist/load boundary changes. `grep saveWizardState|readWizardState|serverSessionToken src/PMSWizard.jsx` → none live for a saved cycle (document any transitional draft-cache).
- [ ] Build + full gate green. Commit `feat(admin): setup wizard loads/saves cycle config via pms-admin (cycle.get-config + save-section/snapshot/windows/admin/library)`.
- [ ] Final whole-branch review → merge.
