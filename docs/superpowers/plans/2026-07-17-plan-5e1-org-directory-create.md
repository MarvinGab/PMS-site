# 5e-1 — Org Directory + Create Org (backend cutover) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the super-admin **Organizations directory** read real orgs from the pms backend, and make **Create Org** write through `pms-admin` (`org.create` + its draft cycle + calendar + branding) instead of the retired blob/`serverSessionToken` path — so a super-admin can create and see organizations from scratch.

**Architecture:** First sub-slice of the org-lifecycle cutover (Plan 5e). The backend org/cycle APIs already exist (`org.create`, `org.set-branding`, `cycle.create-draft`, `cycle.set-windows`); only a super-admin **list read** (`org.list`) is missing. This slice adds that read and rewires `OrganizationsPage.jsx` + `CreateOrgPage.jsx` to `callPms`, dropping `stateStore.saveOrganizationRecord`/`serverSessionToken`. The setup wizard, roster, and launch/invites are LATER sub-slices (5e-2/3/4) — untouched here.

**Tech Stack:** React 19 + Vite (`callPms`/`PmsError` from `src/backend/pmsClient.js`, `useApp()`); Supabase edge function `pms-admin` (Deno); gate `node supabase/verify/run-all.mjs`.

## Global Constraints
- **Data layer = `callPms` ONLY** for the migrated directory + create-org path. No `stateStore`/`saveOrganizationRecord`/`serverSessionToken`/`runWorkflowAction`/blob source of truth. Keep the blob `orgs`/`setOrgs` in context untouched (other un-migrated admin screens still use them) — but the DIRECTORY and CREATE screens must not depend on them.
- **Backend enforces auth:** `org.create`/`org.list` are super-admin only (`requireSuperAdmin`); `cycle.create-draft`/`set-windows`/`org.set-branding` per their existing role gates. No client-trusted identity.
- **Preserve the existing UI** (steps, layout, copy) — replace only the data layer. Don't restyle.
- **Copy rules:** never render "Outside PMS" (blank/"NONE"); RMs are employees first. **Palette:** red/green reserved for validation/status only.
- Build in an **isolated worktree off pushed `main`**; wire `.env`, symlink `node_modules`, copy `supabase/.temp`. Full gate green before merge.
- **Deploy handoff:** subagents can't deploy — Task 1 writes backend + `deno check` + STOPS; controller deploys `pms-admin`, resumes for live check + commit.
- Demo: super-admin `pms-super@example.com` / `Passw0rd!seed`. (The seed has orgs acme-test + beta-test — the directory should list them.)

## Out of Scope (later 5e sub-slices)
- The setup wizard config (perspectives/target-types/rating-scale/competencies/goal-rules/groups/bell-curve/windows editing) — 5e-2.
- Roster import + participants — 5e-3.
- HR-admin invite + cycle activation + launch emails — 5e-4.
- HRCycleDashboard internals, PMSWizard — later.
- Deleting stateStore/blob/old functions — Plan 6.

---

### Task 1: `org.list` super-admin read

**Files:**
- Modify: `supabase/functions/pms-admin/organizations.ts` (add `org.list` to the handlers map)
- Modify: `supabase/verify/admin-check.mjs` (add org.list assertions; keep existing 110 intact)

**Interfaces:**
- Produces: action `org.list` (super-admin only, `requireSuperAdmin`) returning `{ organizations: [ { id, key, name, createdAt, cycleCount, activeCycleStatus, participantCount, launched } ] }` — one row per org with a lightweight setup/summary. Derive: `launched` = has a cycle with status in ('active','review','published'); `activeCycleStatus` = the current cycle's status (or null); `cycleCount`; `participantCount` = active participants across the org's current cycle (or 0). Org-scoped reads; wrap errors as `ApiError('DB_ERROR',...,500)`; read-only.

- [ ] **Step 1 — DISCOVERY:** scratch `deno` snippet (delete before commit): print `organizations` columns, `appraisal_cycles` columns/statuses for the seed orgs, and confirm `requireSuperAdmin` (organizations.ts:4) is the gate to reuse. Confirm the seed super-admin (`pms-super`) sees acme-test + beta-test.
- [ ] **Step 2 — Write the handler:** `requireSuperAdmin(ctx)`; select all `organizations` (RLS `org_select` already permits super-admin to read all, but this runs on the service `ctx.admin` client — so filter is unnecessary; return all); for each, compute the summary fields via `appraisal_cycles` + `cycle_participants` (a couple of batched queries, not N+1 per org — fetch cycles/participants for all org ids and group in JS). No writes.
- [ ] **Step 3 — Assertions in `admin-check.mjs`:** as super-admin, `org.list` returns an array including the fixture orgs with `key`/`name`/`launched` (boolean)/`cycleCount` (number); a non-super caller (HR) is denied (403). Keep the existing 110 green.
- [ ] **Step 4 — `deno check` + `node --check`, STOP (NEEDS_CONTEXT) for deploy.** After deploy: `node supabase/verify/seed-foundation.mjs && node supabase/verify/admin-check.mjs` (expect new total), commit: `feat(admin): org.list — super-admin organization directory read`.

---

### Task 2: `OrganizationsPage` reads `org.list`

**Files:**
- Modify: `src/pages/OrganizationsPage.jsx`

- [ ] **Step 1 — Load from backend.** On mount (super-admin), `callPms('org.list', {})`; hold `{organizations}` in state (loading/error/empty states). Map the backend rows into the existing directory table + the 4 summary cards (Organizations / Configured / In Progress / Employees) using the backend summary fields (`launched`/`activeCycleStatus`/`participantCount`/`cycleCount`) instead of `getOrganizationSetupMeta`/`getOrganizationEmployeeCount` (blob). Keep the existing table/card markup + "＋ Add Org" (→ `#create-org`).
- [ ] **Step 2 — Realtime-ish refresh:** re-fetch on window focus or after returning from create-org (a simple `load()` on mount + an exposed refresh is enough; no blob writes). Row actions that still depend on the blob (edit/reopen/delete) may remain but should be guarded/hidden if they'd hit the retired path — note any left for 5e-2+.
- [ ] **Step 3 — Build + blob grep.** `npm run build` succeeds; `grep -nE "getOrganizationSetupMeta|getOrganizationEmployeeCount|saveOrganizationRecord|serverSessionToken|stateStore" src/pages/OrganizationsPage.jsx` → only clearly-guarded/deferred references remain (document them). Commit: `feat(admin): Organizations directory reads org.list (real orgs, no blob)`.

---

### Task 3: `CreateOrgPage` writes via `pms-admin`

**Files:**
- Modify: `src/pages/CreateOrgPage.jsx`

- [ ] **Step 1 — Rewire the create submit.** Replace `saveOrganizationRecord(nextOrg)` (stateStore/serverSessionToken) with: `callPms('org.create', { key, name })` → then, from the returned `organization.id`: `callPms('cycle.create-draft', {...})` for the org's first cycle, `callPms('cycle.set-windows', { orgId, cycleId, windows })` from the Cycle-Calendar step, and `callPms('org.set-branding', {...})` if branding was set. Keep the 3-step wizard UI (Workspace Setup / Cycle Calendar / Admin Access) and its client-side validation. On `PmsError` `ORG_KEY_TAKEN` show a friendly "that key is taken"; other errors show the message. On success, go to `#` (directory) or the org's setup.
- [ ] **Step 2 — HR-admin step (deferred invite).** The "Admin Access" step still collects the HR admin name/email, but the actual invite/user-creation is a LATER sub-slice (5e-4). For now, capture it and either (a) store it via `org.set-branding`/`cycle.set-admin-config` metadata if a field exists, or (b) show the existing "send the invite from Communications when ready" note and do NOT call the retired credential path. Do NOT block org creation on the invite. Document the deferral.
- [ ] **Step 3 — Remove the retired path.** Drop the `stateStore.saveOrganizationRecord` import + any `serverSessionToken` usage from CreateOrgPage. `grep -nE "saveOrganizationRecord|serverSessionToken|runWorkflowAction" src/pages/CreateOrgPage.jsx` → empty (or only clearly-deferred, documented).
- [ ] **Step 4 — Build + full gate.** `npm run build` succeeds. `node supabase/verify/run-all.mjs` → all pass incl. the new admin-check total + FOUNDATION SMOKE: ALL PASS.
- [ ] **Step 5 — Browser smoke (documented; controller/user runs).** As `pms-super@`: Organizations directory lists acme-test + beta-test (real); click ＋ Add Org → fill Workspace + Calendar + Admin → Create → the new org appears in the directory; no "Sign in again to continue".
- [ ] **Step 6 — Commit + final whole-branch review → merge.** Commit: `feat(admin): Create Org writes via pms-admin (org.create + draft cycle + windows); drop blob/serverSessionToken path`.
