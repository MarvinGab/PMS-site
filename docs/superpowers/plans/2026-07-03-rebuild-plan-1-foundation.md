# Rebuild Plan 1: Foundation (Schema + RLS + Auth + Backend Kernel) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create the complete new server-first database schema (in a dedicated `pms` Postgres schema), row-level security for scoped reads, Supabase Auth wiring, seeded test identities, and the shared edge-function kernel with a first deployed `pms-admin` function — verified end-to-end against the live Supabase project.

**Architecture:** All new tables live in Postgres schema `pms` on the existing linked Supabase project (`mkjtdwrzmobahwkpumxx`), fully parallel to the old `public`-schema blob world, which is NOT touched. Browser clients get RLS-scoped SELECT only (plus marking own notifications read); all business writes will go through edge functions using the service-role key (which bypasses RLS). Optimistic concurrency via a `version` column auto-bumped by trigger; writers filter `WHERE version = expected`.

**Tech Stack:** Supabase (Postgres 15+, RLS, Auth, Edge Functions/Deno), supabase-js v2, Node verify scripts with `node:assert` (repo's existing test pattern — no test framework), Supabase CLI 2.95.4 (already linked).

**Spec:** `docs/superpowers/specs/2026-07-03-server-first-rebuild-design.md` — this plan implements spec §4 (data model), §5 (login & permissions), and the kernel half of §6.

## Global Constraints

- **Write rule (verbatim from spec):** The browser may only read rows allowed by RLS. All business writes go through backend functions. Direct table writes from browser clients are denied except harmless user-owned profile/session metadata if ever needed. (In this plan the only client write is `notifications.read_at`.)
- **One working cycle per org:** statuses draft/setup/active/review/published count as working; archived unlimited. DB-enforced (partial unique index).
- **Phase is never persisted as a flag** — windows are rows; current sub-phase always computed from dates + now.
- **Phase windows may overlap** — each window is an independent row; nothing reduces the cycle to one global phase.
- **Dead legacy fields are NOT carried into the new schema** (spec §4.1 list).
- **Old world untouched:** nothing in `public` schema, old edge functions, or old app code is modified or deleted in this plan. No old production data is deleted until the new schema passes fresh-org tests (spec §9).
- **Roster-only rule:** `employees.group_name = 'NONE'` marks roster-only people; never label them "Outside PMS" in any UI copy.
- **Conflict responses, never silent overwrites:** stale `version` → error code `CONFLICT`, HTTP 409, message "someone else changed this — reload". The `updated_at`/`version` pair exists for optimistic concurrency and therefore applies to EDITABLE tables only; append-only history tables (`cycle_config_versions`, `goal_workflow_events`, `calibrations`, `notifications`, `email_delivery_attempts`, `import_run_errors`, `audit_logs`) are never UPDATEd and intentionally omit them (clarified after Task 2 review).
- **Response shape for all edge actions:** `{ ok: true, data }` or `{ ok: false, error: { code, message } }`.
- All commands run from repo root `/Users/marvin/Desktop/PMS site`. The `.env` file is gitignored — never commit it.
- **Roles note (refines spec §5):** `org_members.roles` stores *granted* roles only: `super_admin` (row with `organization_id NULL`), `hr_admin`, `employee`. Manager and HOD capabilities are **derived** from `reporting_relationships` rows (`relation_type` = `manager` / `l2` / `hod`), not stored as roles — the roster is their source of truth, so they can't drift.

---

### Task 0: Prerequisites (manual, one-time)

**Files:**
- Modify: `.env` (local only, gitignored)

**Interfaces:**
- Produces: env vars `SUPABASE_SERVICE_ROLE_KEY` (new), reused `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`. A clean `supabase migration list` state so `supabase db push` only applies new files.

- [x] **Step 1: Add the service-role key to `.env`** *(done: fetched via `supabase projects api-keys -o json` and piped directly into `.env` without displaying it)*

Manual alternative: Supabase Dashboard → project `mkjtdwrzmobahwkpumxx` → Project Settings → API Keys → copy the `service_role` secret. Append to `.env`:

```bash
SUPABASE_SERVICE_ROLE_KEY=<paste service_role key>
```

- [ ] **Step 2: Reconcile migration history**

*(done: checked in-session — LOCAL and REMOTE already match for all 8 versions; no repair needed)*

Run: `supabase migration list --linked`

Every migration file that is already live but shows only under LOCAL must be marked applied so `db push` doesn't re-run it. For each such version (expected: `20260511`, `2026062501`, `2026062502`, `2026070101`, `2026070201`, `2026070202`, `2026070203`, `2026070301`):

```bash
supabase migration repair --status applied 20260511
supabase migration repair --status applied 2026062501
supabase migration repair --status applied 2026062502
supabase migration repair --status applied 2026070101
supabase migration repair --status applied 2026070201
supabase migration repair --status applied 2026070202
supabase migration repair --status applied 2026070203
supabase migration repair --status applied 2026070301
```

Re-run `supabase migration list --linked` — LOCAL and REMOTE columns must match before continuing. (Have the database password ready: Dashboard → Project Settings → Database.)

- [ ] **Step 3: Disable public signups (invite-only auth)**

Dashboard → Authentication → Sign In / Providers → Email: keep Email **enabled**, turn **OFF** "Allow new users to sign up". (Users are created only by our backend via the admin API.)

*(Status: pending — needs the user's dashboard access; does not block any task in this plan. Must be done before cutover.)*

---

### Task 1: Core org schema migration + verify harness

**Files:**
- Create: `supabase/migrations/2026070310_pms_core.sql`
- Create: `supabase/verify/_env.mjs`
- Create: `supabase/verify/_clients.mjs`
- Create: `supabase/verify/check-tables.mjs`

**Interfaces:**
- Produces: Postgres schema `pms`; function `pms.touch_row()`; tables `pms.organizations`, `pms.organization_branding`, `pms.org_members`, `pms.employees`, `pms.reporting_relationships`, `pms.org_grades`, `pms.competency_library`, `pms.goal_libraries`, `pms.goal_library_items`, `pms.prefill_datasets`, `pms.prefill_dataset_items`.
- Produces (JS): `loadEnv()` from `_env.mjs`; `adminClient()`, `anonClient()`, `signIn(email, password)` from `_clients.mjs` (all return supabase-js clients bound to schema `pms`).

- [ ] **Step 1: Write the env loader and client helpers**

`supabase/verify/_env.mjs`:

```js
// Minimal .env loader so verify scripts run on any Node ≥18 (no --env-file needed).
import { readFileSync } from 'node:fs';

export function loadEnv(path = '.env') {
  let text = '';
  try { text = readFileSync(path, 'utf8'); } catch { return; }
  for (const line of text.split('\n')) {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].trim();
  }
}
```

`supabase/verify/_clients.mjs`:

```js
import { createClient } from '@supabase/supabase-js';
import { loadEnv } from './_env.mjs';

loadEnv();

export const SUPABASE_URL = process.env.VITE_SUPABASE_URL;
export const ANON_KEY = process.env.VITE_SUPABASE_ANON_KEY;
export const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !ANON_KEY || !SERVICE_KEY) {
  console.error('Missing VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY in .env');
  process.exit(1);
}

const opts = { db: { schema: 'pms' }, auth: { persistSession: false } };

export function adminClient() {
  return createClient(SUPABASE_URL, SERVICE_KEY, opts);
}

export function anonClient() {
  return createClient(SUPABASE_URL, ANON_KEY, opts);
}

// Returns a client whose PostgREST requests carry the signed-in user's JWT.
export async function signIn(email, password) {
  const client = createClient(SUPABASE_URL, ANON_KEY, opts);
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error) throw new Error(`signIn(${email}) failed: ${error.message}`);
  return { client, session: data.session, userId: data.user.id };
}
```

- [ ] **Step 2: Write the failing table check**

`supabase/verify/check-tables.mjs`:

```js
// Run: node supabase/verify/check-tables.mjs
// Asserts every expected pms.* table is reachable via the service role.
import assert from 'node:assert/strict';
import { adminClient } from './_clients.mjs';

export const EXPECTED_TABLES = [
  // Task 1: core org
  'organizations', 'organization_branding', 'org_members', 'employees',
  'reporting_relationships', 'org_grades', 'competency_library',
  'goal_libraries', 'goal_library_items', 'prefill_datasets', 'prefill_dataset_items',
];

const admin = adminClient();
let failed = 0;
for (const table of EXPECTED_TABLES) {
  const { error } = await admin.from(table).select('id', { count: 'exact', head: true });
  if (error) { failed += 1; console.error(`MISSING pms.${table}: ${error.message}`); }
  else console.log(`ok pms.${table}`);
}
assert.equal(failed, 0, `${failed} table(s) missing`);
console.log('check-tables: PASS');
```

- [ ] **Step 3: Run it to verify it fails**

Run: `node supabase/verify/check-tables.mjs`
Expected: FAIL — every table logs `MISSING pms.<name>` (schema doesn't exist yet), exits non-zero.

- [ ] **Step 4: Write the core migration**

`supabase/migrations/2026070310_pms_core.sql`:

```sql
-- New server-first world lives in schema "pms"; old "public" blob world is untouched.
create schema if not exists pms;
create extension if not exists citext;

-- Optimistic concurrency: bump version + updated_at on every UPDATE.
-- Writers must filter WHERE version = <expected>; zero rows updated = conflict.
create or replace function pms.touch_row() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  new.version := old.version + 1;
  return new;
end $$;

create table pms.organizations (
  id uuid primary key default gen_random_uuid(),
  key text not null unique,
  name text not null,
  status text not null default 'active' check (status in ('active','archived')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version int not null default 1
);

create table pms.organization_branding (
  organization_id uuid primary key references pms.organizations(id) on delete cascade,
  payload jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version int not null default 1
);

create table pms.org_members (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid references pms.organizations(id) on delete cascade, -- NULL = global super admin row
  user_id uuid not null references auth.users(id) on delete cascade,
  roles text[] not null default '{}' check (roles <@ array['super_admin','hr_admin','employee']::text[]),
  status text not null default 'active' check (status in ('active','invited','disabled')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version int not null default 1,
  unique nulls not distinct (organization_id, user_id)
);
create index org_members_user_idx on pms.org_members(user_id);

create table pms.employees (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references pms.organizations(id) on delete cascade,
  employee_code text not null,
  full_name text not null,
  email citext,
  designation text,
  department text,
  grade text,
  group_name text, -- 'NONE' = roster-only (outside PMS); never shown as "Outside PMS" in UI
  user_id uuid references auth.users(id) on delete set null,
  status text not null default 'active' check (status in ('active','inactive')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version int not null default 1,
  unique (organization_id, employee_code),
  unique (organization_id, email)
);
create index employees_org_idx on pms.employees(organization_id);
create index employees_user_idx on pms.employees(user_id);

create table pms.reporting_relationships (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references pms.organizations(id) on delete cascade,
  employee_id uuid not null references pms.employees(id) on delete cascade,
  related_employee_id uuid not null references pms.employees(id) on delete cascade,
  relation_type text not null check (relation_type in ('manager','l2','hod')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version int not null default 1,
  unique (organization_id, employee_id, relation_type),
  check (employee_id <> related_employee_id)
);
create index rr_related_idx on pms.reporting_relationships(organization_id, related_employee_id, relation_type);

create table pms.org_grades (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references pms.organizations(id) on delete cascade,
  label text not null,
  display_order int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version int not null default 1,
  unique (organization_id, label)
);

create table pms.competency_library (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references pms.organizations(id) on delete cascade,
  name text not null,
  type text,
  description text,
  status text not null default 'active' check (status in ('active','archived')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version int not null default 1,
  unique (organization_id, name)
);

create table pms.goal_libraries (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references pms.organizations(id) on delete cascade,
  name text not null,
  description text,
  status text not null default 'active' check (status in ('active','archived')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version int not null default 1,
  unique (organization_id, name)
);

create table pms.goal_library_items (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references pms.organizations(id) on delete cascade,
  goal_library_id uuid not null references pms.goal_libraries(id) on delete cascade,
  item_type text not null check (item_type in ('kra','kpi')),
  parent_item_id uuid references pms.goal_library_items(id) on delete cascade,
  title text not null,
  description text,
  perspective text,
  weight numeric,
  target_type_key text,
  target_value text,
  display_order int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version int not null default 1
);
create index gli_library_idx on pms.goal_library_items(goal_library_id);

create table pms.prefill_datasets (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references pms.organizations(id) on delete cascade,
  name text not null,
  description text,
  status text not null default 'active' check (status in ('active','archived')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version int not null default 1,
  unique (organization_id, name)
);

create table pms.prefill_dataset_items (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references pms.organizations(id) on delete cascade,
  prefill_dataset_id uuid not null references pms.prefill_datasets(id) on delete cascade,
  employee_code text not null,
  kra_title text not null,
  kpi_title text,
  weight numeric,
  perspective text,
  target_type_key text,
  target_value text,
  display_order int not null default 0,
  extra jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version int not null default 1
);
create index pdi_dataset_idx on pms.prefill_dataset_items(prefill_dataset_id);
create index pdi_code_idx on pms.prefill_dataset_items(prefill_dataset_id, employee_code);

-- Attach the version/updated_at trigger to every pms table that has a version column.
-- (Idempotent; re-run at the end of each schema migration.)
do $$
declare t text;
begin
  for t in select table_name from information_schema.tables
           where table_schema = 'pms' and table_type = 'BASE TABLE'
  loop
    if exists (select 1 from information_schema.columns
               where table_schema = 'pms' and table_name = t and column_name = 'version') then
      execute format('drop trigger if exists touch on pms.%I', t);
      execute format('create trigger touch before update on pms.%I for each row execute function pms.touch_row()', t);
    end if;
  end loop;
end $$;

-- Expose pms to the REST API (SQL equivalent of Dashboard → Data API → Exposed schemas).
alter role authenticator set pgrst.db_schemas = 'public, storage, graphql_public, pms';
notify pgrst, 'reload config';
```

- [ ] **Step 5: Apply the migration**

Run: `supabase db push`
Expected: `Applying migration 2026070310_pms_core.sql... Finished supabase db push.` (only this file applied).

- [ ] **Step 6: Confirm the `pms` schema is exposed to the API**

The migration's final `alter role authenticator set pgrst.db_schemas ...` + `notify pgrst` handles this. Wait ~30 seconds after push. Fallback if Step 7 still reports every table missing with a schema error: Dashboard → Project Settings → Data API → "Exposed schemas" → add `pms` → Save.

- [ ] **Step 7: Run the table check to verify it passes**

Run: `node supabase/verify/check-tables.mjs`
Expected: `ok pms.<table>` for all 11 tables, then `check-tables: PASS`, exit 0.

- [ ] **Step 8: Commit**

```bash
git add supabase/migrations/2026070310_pms_core.sql supabase/verify/_env.mjs supabase/verify/_clients.mjs supabase/verify/check-tables.mjs
git commit -m "feat(foundation): pms schema core org tables + verify harness"
```

---

### Task 2: Cycle schema migration

**Files:**
- Create: `supabase/migrations/2026070312_pms_cycles.sql`
- Modify: `supabase/verify/check-tables.mjs` (extend `EXPECTED_TABLES`)

**Interfaces:**
- Consumes: `pms.organizations`, `pms.employees`, `pms.goal_libraries`, `pms.prefill_datasets`, `pms.competency_library`, `pms.touch_row()` (Task 1).
- Produces: tables `pms.appraisal_cycles`, `pms.cycle_phase_windows`, `pms.cycle_config_snapshots`, `pms.cycle_config_versions`, `pms.cycle_perspectives`, `pms.cycle_groups`, `pms.cycle_group_segment_values`, `pms.cycle_group_library_assignments`, `pms.cycle_target_types`, `pms.cycle_rating_scale_levels`, `pms.cycle_auto_rating_bands`, `pms.cycle_goal_rules`, `pms.cycle_competency_config`, `pms.cycle_competency_assignments`, `pms.cycle_bell_curve_bands`, `pms.cycle_participants`, `pms.cycle_participant_assignments`. Unique index `one_working_cycle_per_org`. Window keys: `goal_creation`, `manager_approval`, `self_evaluation`, `manager_evaluation`, `hod_review`, `hr_calibration`, `publishing_prep`, `acknowledgement`.
- Produces (JSON contract): `cycle_config_snapshots.snapshot.visibility` = `{ "manager_rating_visible": "immediate"|"after_publish"|"never", "final_rating_visible": "immediate"|"after_publish"|"never" }` (missing → `after_publish`). Later plans add sibling blocks (roster schema, notification config, target header, scale header, auto-rating header, bell header).

- [ ] **Step 1: Extend the table check (failing first)**

In `supabase/verify/check-tables.mjs`, append to `EXPECTED_TABLES`:

```js
  // Task 2: cycles
  'appraisal_cycles', 'cycle_phase_windows', 'cycle_config_snapshots', 'cycle_config_versions',
  'cycle_perspectives', 'cycle_groups', 'cycle_group_segment_values', 'cycle_group_library_assignments',
  'cycle_target_types', 'cycle_rating_scale_levels', 'cycle_auto_rating_bands', 'cycle_goal_rules',
  'cycle_competency_config', 'cycle_competency_assignments', 'cycle_bell_curve_bands',
  'cycle_participants', 'cycle_participant_assignments',
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node supabase/verify/check-tables.mjs`
Expected: FAIL — 17 `MISSING pms.<name>` lines for the new names; the 11 Task-1 tables still `ok`.

- [ ] **Step 3: Write the cycles migration**

`supabase/migrations/2026070312_pms_cycles.sql`:

```sql
create table pms.appraisal_cycles (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references pms.organizations(id) on delete cascade,
  name text not null,
  period_label text,
  framework_id text not null check (framework_id in ('bsc','kra-kpi','kra','custom')),
  status text not null default 'draft'
    check (status in ('draft','setup','active','review','published','archived')),
  feature_flags jsonb not null default '{}',
  activated_at timestamptz,
  archived_at timestamptz,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version int not null default 1
);
-- One WORKING cycle per org (draft/setup/active/review/published); archived history unlimited.
create unique index one_working_cycle_per_org
  on pms.appraisal_cycles(organization_id) where status <> 'archived';

create table pms.cycle_phase_windows (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references pms.organizations(id) on delete cascade,
  cycle_id uuid not null references pms.appraisal_cycles(id) on delete cascade,
  window_key text not null check (window_key in
    ('goal_creation','manager_approval','self_evaluation','manager_evaluation',
     'hod_review','hr_calibration','publishing_prep','acknowledgement')),
  starts_on date not null,
  ends_on date not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version int not null default 1,
  unique (cycle_id, window_key),
  check (ends_on >= starts_on)
);

create table pms.cycle_config_snapshots (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references pms.organizations(id) on delete cascade,
  cycle_id uuid not null unique references pms.appraisal_cycles(id) on delete cascade,
  snapshot jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version int not null default 1
);

create table pms.cycle_config_versions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references pms.organizations(id) on delete cascade,
  cycle_id uuid not null references pms.appraisal_cycles(id) on delete cascade,
  version_no int not null,
  snapshot jsonb not null,
  change_note text,
  changed_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  unique (cycle_id, version_no)
);

create table pms.cycle_perspectives (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references pms.organizations(id) on delete cascade,
  cycle_id uuid not null references pms.appraisal_cycles(id) on delete cascade,
  name text not null,
  weight numeric,
  color text,
  display_order int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version int not null default 1,
  unique (cycle_id, name)
);

create table pms.cycle_groups (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references pms.organizations(id) on delete cascade,
  cycle_id uuid not null references pms.appraisal_cycles(id) on delete cascade,
  name text not null,
  segment_attr text,
  is_catch_all boolean not null default false,
  can_edit_own_goals boolean not null default false,
  prefill_type text,
  has_library boolean not null default false,
  -- Kept separate on purpose (spec): where targets live vs where scores live.
  target_level text check (target_level in ('kra','kpi','custom')),
  rating_level text check (rating_level in ('kra','kpi')),
  kpi_rating_mode text,
  display_order int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version int not null default 1,
  unique (cycle_id, name)
);

create table pms.cycle_group_segment_values (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references pms.organizations(id) on delete cascade,
  cycle_id uuid not null references pms.appraisal_cycles(id) on delete cascade,
  group_id uuid not null references pms.cycle_groups(id) on delete cascade,
  value text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version int not null default 1,
  unique (group_id, value)
);

create table pms.cycle_group_library_assignments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references pms.organizations(id) on delete cascade,
  cycle_id uuid not null references pms.appraisal_cycles(id) on delete cascade,
  group_id uuid not null references pms.cycle_groups(id) on delete cascade,
  slot_key text not null,
  slot_label text,
  goal_library_id uuid references pms.goal_libraries(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version int not null default 1,
  unique (group_id, slot_key)
);

create table pms.cycle_target_types (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references pms.organizations(id) on delete cascade,
  cycle_id uuid not null references pms.appraisal_cycles(id) on delete cascade,
  target_type_key text not null,
  name text not null,
  is_numeric boolean not null default true,
  unit text,
  unit_position text check (unit_position in ('prefix','suffix')),
  min_value numeric,
  max_value numeric,
  lower_is_better boolean not null default false, -- real, used in scoring (spec §4.3.3)
  hidden boolean not null default false,
  display_order int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version int not null default 1,
  unique (cycle_id, target_type_key)
);

create table pms.cycle_rating_scale_levels (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references pms.organizations(id) on delete cascade,
  cycle_id uuid not null references pms.appraisal_cycles(id) on delete cascade,
  point numeric not null,
  label text not null,
  code text,
  range_from numeric,
  range_to numeric,
  display_order int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version int not null default 1,
  unique (cycle_id, point)
);

create table pms.cycle_auto_rating_bands (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references pms.organizations(id) on delete cascade,
  cycle_id uuid not null references pms.appraisal_cycles(id) on delete cascade,
  from_percent numeric not null,
  to_percent numeric not null,
  score numeric not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version int not null default 1,
  unique (cycle_id, from_percent)
);

create table pms.cycle_goal_rules (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references pms.organizations(id) on delete cascade,
  cycle_id uuid not null references pms.appraisal_cycles(id) on delete cascade,
  group_id uuid references pms.cycle_groups(id) on delete cascade, -- NULL = cycle-wide default
  min_kras int,
  max_kras int,
  min_kpis_per_kra int,
  max_kpis_per_kra int,
  min_kra_weight numeric,
  max_kra_weight numeric,
  min_kpi_weight numeric,
  weightage_ownership text,
  employee_can_add_goals boolean not null default false,
  max_employee_added_goals int,
  manager_can_add_goals boolean not null default false,
  approval_required boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version int not null default 1,
  unique nulls not distinct (cycle_id, group_id)
);

create table pms.cycle_competency_config (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references pms.organizations(id) on delete cascade,
  cycle_id uuid not null unique references pms.appraisal_cycles(id) on delete cascade,
  enabled boolean not null default false,
  max_per_employee int,
  competency_weight numeric,
  rated_by text,
  allow_self_rate boolean not null default false,
  employee_can_edit boolean not null default false,
  scope text not null default 'org' check (scope in ('org','group','group_role')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version int not null default 1
);

create table pms.cycle_competency_assignments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references pms.organizations(id) on delete cascade,
  cycle_id uuid not null references pms.appraisal_cycles(id) on delete cascade,
  group_id uuid references pms.cycle_groups(id) on delete cascade,   -- NULL = org-wide
  role_name text,                                                    -- NULL = whole group
  competency_id uuid references pms.competency_library(id),
  competency_name text not null, -- frozen name so history survives library edits
  kra_share numeric,
  competency_share numeric,
  display_order int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version int not null default 1
);
create index cca_cycle_idx on pms.cycle_competency_assignments(cycle_id);

create table pms.cycle_bell_curve_bands (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references pms.organizations(id) on delete cascade,
  cycle_id uuid not null references pms.appraisal_cycles(id) on delete cascade,
  rating_point numeric not null,
  target_percent numeric not null,
  tolerance_percent numeric not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version int not null default 1,
  unique (cycle_id, rating_point)
);

create table pms.cycle_participants (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references pms.organizations(id) on delete cascade,
  cycle_id uuid not null references pms.appraisal_cycles(id) on delete cascade,
  employee_id uuid not null references pms.employees(id) on delete cascade,
  status text not null default 'active' check (status in ('active','removed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version int not null default 1,
  unique (cycle_id, employee_id)
);
create index cp_employee_idx on pms.cycle_participants(employee_id);

create table pms.cycle_participant_assignments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references pms.organizations(id) on delete cascade,
  cycle_id uuid not null references pms.appraisal_cycles(id) on delete cascade,
  participant_id uuid not null unique references pms.cycle_participants(id) on delete cascade,
  employee_id uuid not null references pms.employees(id) on delete cascade, -- denormalized for RLS
  group_id uuid references pms.cycle_groups(id),
  goal_library_id uuid references pms.goal_libraries(id),
  prefill_dataset_id uuid references pms.prefill_datasets(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version int not null default 1
);

do $$
declare t text;
begin
  for t in select table_name from information_schema.tables
           where table_schema = 'pms' and table_type = 'BASE TABLE'
  loop
    if exists (select 1 from information_schema.columns
               where table_schema = 'pms' and table_name = t and column_name = 'version') then
      execute format('drop trigger if exists touch on pms.%I', t);
      execute format('create trigger touch before update on pms.%I for each row execute function pms.touch_row()', t);
    end if;
  end loop;
end $$;
```

- [ ] **Step 4: Apply and verify**

Run: `supabase db push`
Expected: `Applying migration 2026070312_pms_cycles.sql... Finished supabase db push.`

Run: `node supabase/verify/check-tables.mjs`
Expected: all 28 tables `ok`, `check-tables: PASS`.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/2026070312_pms_cycles.sql supabase/verify/check-tables.mjs
git commit -m "feat(foundation): cycle schema tables with one-working-cycle constraint"
```

---

### Task 3: Workflow + plumbing schema migration

**Files:**
- Create: `supabase/migrations/2026070313_pms_workflow.sql`
- Modify: `supabase/verify/check-tables.mjs` (extend `EXPECTED_TABLES`)

**Interfaces:**
- Consumes: Task 1–2 tables and `pms.touch_row()`.
- Produces: tables `pms.employee_goal_plans`, `pms.employee_goal_items`, `pms.employee_goal_plan_competencies`, `pms.goal_workflow_events`, `pms.evaluations`, `pms.evaluation_goal_scores`, `pms.evaluation_competency_scores`, `pms.calibrations`, `pms.cycle_publications`, `pms.rating_acknowledgements`, `pms.notifications`, `pms.email_jobs`, `pms.email_delivery_attempts`, `pms.background_jobs`, `pms.import_runs`, `pms.import_run_errors`, `pms.audit_logs`. Evaluation stages: `self` / `manager` / `hod` / `hr_final`.

- [ ] **Step 1: Extend the table check (failing first)**

Append to `EXPECTED_TABLES` in `supabase/verify/check-tables.mjs`:

```js
  // Task 3: workflow + plumbing
  'employee_goal_plans', 'employee_goal_items', 'employee_goal_plan_competencies',
  'goal_workflow_events', 'evaluations', 'evaluation_goal_scores', 'evaluation_competency_scores',
  'calibrations', 'cycle_publications', 'rating_acknowledgements',
  'notifications', 'email_jobs', 'email_delivery_attempts', 'background_jobs',
  'import_runs', 'import_run_errors', 'audit_logs',
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node supabase/verify/check-tables.mjs`
Expected: FAIL — 17 new `MISSING` lines.

- [ ] **Step 3: Write the workflow migration**

`supabase/migrations/2026070313_pms_workflow.sql`:

```sql
create table pms.employee_goal_plans (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references pms.organizations(id) on delete cascade,
  cycle_id uuid not null references pms.appraisal_cycles(id) on delete cascade,
  employee_id uuid not null references pms.employees(id) on delete cascade,
  status text not null default 'draft'
    check (status in ('draft','submitted','approved','sent_back','reopened')),
  submitted_at timestamptz,
  approved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version int not null default 1,
  unique (cycle_id, employee_id)
);
create index egp_employee_idx on pms.employee_goal_plans(cycle_id, employee_id);

create table pms.employee_goal_items (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references pms.organizations(id) on delete cascade,
  cycle_id uuid not null references pms.appraisal_cycles(id) on delete cascade,
  plan_id uuid not null references pms.employee_goal_plans(id) on delete cascade,
  employee_id uuid not null references pms.employees(id) on delete cascade, -- denormalized for RLS
  item_type text not null check (item_type in ('kra','kpi')),
  parent_item_id uuid references pms.employee_goal_items(id) on delete cascade,
  title text not null,
  description text,
  perspective text,
  weight numeric,
  target_type_key text,
  target_value text,
  source text not null default 'employee' check (source in ('library','prefill','employee','manager')),
  display_order int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version int not null default 1
);
create index egi_plan_idx on pms.employee_goal_items(plan_id);

create table pms.employee_goal_plan_competencies (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references pms.organizations(id) on delete cascade,
  cycle_id uuid not null references pms.appraisal_cycles(id) on delete cascade,
  plan_id uuid not null references pms.employee_goal_plans(id) on delete cascade,
  employee_id uuid not null references pms.employees(id) on delete cascade,
  competency_name text not null,
  display_order int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version int not null default 1,
  unique (plan_id, competency_name)
);

-- Append-only event log: no version column, no updates.
create table pms.goal_workflow_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references pms.organizations(id) on delete cascade,
  cycle_id uuid not null references pms.appraisal_cycles(id) on delete cascade,
  plan_id uuid not null references pms.employee_goal_plans(id) on delete cascade,
  employee_id uuid not null references pms.employees(id) on delete cascade,
  event_type text not null check (event_type in ('submitted','approved','sent_back','reopened','amended')),
  actor_user_id uuid references auth.users(id),
  actor_role text,
  note text,
  created_at timestamptz not null default now()
);
create index gwe_plan_idx on pms.goal_workflow_events(plan_id);

create table pms.evaluations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references pms.organizations(id) on delete cascade,
  cycle_id uuid not null references pms.appraisal_cycles(id) on delete cascade,
  employee_id uuid not null references pms.employees(id) on delete cascade,
  stage text not null check (stage in ('self','manager','hod','hr_final')),
  status text not null default 'draft' check (status in ('draft','submitted')),
  overall_score numeric,
  overall_comment text,
  submitted_at timestamptz,
  submitted_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version int not null default 1,
  unique (cycle_id, employee_id, stage)
);
create index eval_employee_idx on pms.evaluations(cycle_id, employee_id);

create table pms.evaluation_goal_scores (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references pms.organizations(id) on delete cascade,
  cycle_id uuid not null references pms.appraisal_cycles(id) on delete cascade,
  evaluation_id uuid not null references pms.evaluations(id) on delete cascade,
  goal_item_id uuid not null references pms.employee_goal_items(id) on delete cascade,
  achievement_value text,
  achievement_percent numeric,
  score numeric,
  comment text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version int not null default 1,
  unique (evaluation_id, goal_item_id)
);

create table pms.evaluation_competency_scores (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references pms.organizations(id) on delete cascade,
  cycle_id uuid not null references pms.appraisal_cycles(id) on delete cascade,
  evaluation_id uuid not null references pms.evaluations(id) on delete cascade,
  competency_name text not null,
  score numeric,
  comment text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version int not null default 1,
  unique (evaluation_id, competency_name)
);

-- Append-only: every calibration adjustment is its own row (before/after/actor).
create table pms.calibrations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references pms.organizations(id) on delete cascade,
  cycle_id uuid not null references pms.appraisal_cycles(id) on delete cascade,
  employee_id uuid not null references pms.employees(id) on delete cascade,
  stage text not null check (stage in ('hod','hr_final')),
  before_score numeric,
  after_score numeric,
  note text,
  actor_user_id uuid references auth.users(id),
  created_at timestamptz not null default now()
);
create index calib_employee_idx on pms.calibrations(cycle_id, employee_id);

create table pms.cycle_publications (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references pms.organizations(id) on delete cascade,
  cycle_id uuid not null references pms.appraisal_cycles(id) on delete cascade,
  published_at timestamptz not null default now(),
  published_by uuid references auth.users(id),
  revoked_at timestamptz,
  revoked_by uuid references auth.users(id),
  reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version int not null default 1
);
create index cpub_cycle_idx on pms.cycle_publications(cycle_id);

create table pms.rating_acknowledgements (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references pms.organizations(id) on delete cascade,
  cycle_id uuid not null references pms.appraisal_cycles(id) on delete cascade,
  employee_id uuid not null references pms.employees(id) on delete cascade,
  decision text not null check (decision in ('accepted','concern')),
  reason text,
  submitted_at timestamptz not null default now(),
  resolution_status text check (resolution_status in ('open','explained','recalibrated')),
  resolution_note text,
  resolved_by uuid references auth.users(id),
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version int not null default 1,
  unique (cycle_id, employee_id)
);

-- No version column: append + owner marks read_at (the one allowed client write).
create table pms.notifications (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references pms.organizations(id) on delete cascade,
  cycle_id uuid references pms.appraisal_cycles(id) on delete set null,
  recipient_member_id uuid not null references pms.org_members(id) on delete cascade,
  type text not null,
  title text not null,
  body text,
  read_at timestamptz,
  created_at timestamptz not null default now()
);
create index notif_recipient_idx on pms.notifications(recipient_member_id, created_at desc);

create table pms.email_jobs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references pms.organizations(id) on delete cascade,
  cycle_id uuid references pms.appraisal_cycles(id) on delete set null,
  template_key text not null,
  recipient_email citext not null,
  recipient_member_id uuid references pms.org_members(id) on delete set null,
  subject text,
  payload jsonb not null default '{}',
  status text not null default 'queued'
    check (status in ('queued','sending','sent','failed','cancelled')),
  scheduled_at timestamptz not null default now(),
  sent_at timestamptz,
  last_error text,
  attempts int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version int not null default 1
);
create index ejobs_status_idx on pms.email_jobs(status, scheduled_at);

create table pms.email_delivery_attempts (
  id uuid primary key default gen_random_uuid(),
  email_job_id uuid not null references pms.email_jobs(id) on delete cascade,
  status text not null,
  provider text,
  provider_response text,
  attempted_at timestamptz not null default now()
);
create index eda_job_idx on pms.email_delivery_attempts(email_job_id);

create table pms.background_jobs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references pms.organizations(id) on delete cascade,
  cycle_id uuid references pms.appraisal_cycles(id) on delete set null,
  job_type text not null,
  status text not null default 'queued'
    check (status in ('queued','running','done','failed','cancelled')),
  progress int not null default 0,
  total int,
  payload jsonb not null default '{}',
  result jsonb,
  error text,
  retry_count int not null default 0,
  max_retries int not null default 3,
  scheduled_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version int not null default 1
);
create index bjobs_status_idx on pms.background_jobs(status, scheduled_at);

create table pms.import_runs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references pms.organizations(id) on delete cascade,
  cycle_id uuid references pms.appraisal_cycles(id) on delete set null,
  kind text not null default 'roster',
  status text not null default 'validating'
    check (status in ('validating','preview_ready','committing','committed','failed','discarded')),
  file_name text,
  total_rows int,
  valid_rows int,
  error_rows int,
  created_by uuid references auth.users(id),
  committed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version int not null default 1
);

create table pms.import_run_errors (
  id uuid primary key default gen_random_uuid(),
  import_run_id uuid not null references pms.import_runs(id) on delete cascade,
  row_number int,
  column_name text,
  error text not null,
  row_data jsonb,
  created_at timestamptz not null default now()
);
create index ire_run_idx on pms.import_run_errors(import_run_id);

-- Append-only audit trail.
create table pms.audit_logs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references pms.organizations(id) on delete cascade,
  cycle_id uuid references pms.appraisal_cycles(id) on delete set null,
  actor_user_id uuid references auth.users(id),
  actor_role text,
  action text not null,
  entity_type text,
  entity_id uuid,
  before jsonb,
  after jsonb,
  note text,
  created_at timestamptz not null default now()
);
create index audit_org_idx on pms.audit_logs(organization_id, created_at desc);

do $$
declare t text;
begin
  for t in select table_name from information_schema.tables
           where table_schema = 'pms' and table_type = 'BASE TABLE'
  loop
    if exists (select 1 from information_schema.columns
               where table_schema = 'pms' and table_name = t and column_name = 'version') then
      execute format('drop trigger if exists touch on pms.%I', t);
      execute format('create trigger touch before update on pms.%I for each row execute function pms.touch_row()', t);
    end if;
  end loop;
end $$;
```

- [ ] **Step 4: Apply and verify**

Run: `supabase db push`
Expected: `Applying migration 2026070313_pms_workflow.sql... Finished supabase db push.`

Run: `node supabase/verify/check-tables.mjs`
Expected: all 45 tables `ok`, `check-tables: PASS`.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/2026070313_pms_workflow.sql supabase/verify/check-tables.mjs
git commit -m "feat(foundation): workflow, publishing, jobs, import and audit tables"
```

---

### Task 4: Seed test identities and a draft cycle

**Files:**
- Create: `supabase/verify/seed-foundation.mjs`

**Interfaces:**
- Consumes: Task 1–3 tables; `adminClient()` from `_clients.mjs`; `SUPABASE_SERVICE_ROLE_KEY`.
- Produces (exported constants used by Tasks 6–8): `ORG_KEY = 'acme-test'`, `PASSWORD = 'Passw0rd!seed'`, `USERS = { superadmin, hr, manager, employee, hod }` (emails below), employee codes `EMP001` (manager, user), `EMP002` (employee, user, reports to EMP001, HOD EMP003), `EMP003` (HOD, user), `EMP004` (roster-only, `group_name='NONE'`, no user). One draft `appraisal_cycles` row named `FY26 Test Cycle` with snapshot `{ visibility: { manager_rating_visible: 'after_publish', final_rating_visible: 'after_publish' } }`, two phase windows, three participants.
- Script is idempotent: re-running it resets the org's rows.

- [ ] **Step 1: Write the seed script**

`supabase/verify/seed-foundation.mjs`:

```js
// Run: node supabase/verify/seed-foundation.mjs
// Creates auth users + org + roster + members + one draft cycle on the live TEST project.
// Idempotent: deletes and recreates the org's pms rows on each run.
import assert from 'node:assert/strict';
import { adminClient, SUPABASE_URL, SERVICE_KEY } from './_clients.mjs';
import { createClient } from '@supabase/supabase-js';

export const ORG_KEY = 'acme-test';
export const PASSWORD = 'Passw0rd!seed';
export const USERS = {
  superadmin: 'pms-super@example.com',
  hr: 'pms-hr@example.com',
  manager: 'pms-manager@example.com',
  employee: 'pms-employee@example.com',
  hod: 'pms-hod@example.com',
};

const isMain = process.argv[1] && process.argv[1].endsWith('seed-foundation.mjs');
if (isMain) {
  const admin = adminClient();
  // auth admin API lives outside schema selection — separate default client.
  const authAdmin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

  // 1. Ensure auth users exist.
  const userIds = {};
  const { data: existing, error: listErr } = await authAdmin.auth.admin.listUsers({ perPage: 1000 });
  assert.equal(listErr, null, listErr?.message);
  for (const [role, email] of Object.entries(USERS)) {
    const found = existing.users.find((u) => u.email === email);
    if (found) { userIds[role] = found.id; continue; }
    const { data, error } = await authAdmin.auth.admin.createUser({
      email, password: PASSWORD, email_confirm: true,
    });
    assert.equal(error, null, error?.message);
    userIds[role] = data.user.id;
  }

  // 2. Reset org (cascades to every org-scoped row).
  await admin.from('organizations').delete().eq('key', ORG_KEY);
  const { data: org, error: orgErr } = await admin.from('organizations')
    .insert({ key: ORG_KEY, name: 'Acme Test Org' }).select().single();
  assert.equal(orgErr, null, orgErr?.message);

  // 3. Global super admin member row (organization_id NULL) — idempotent upsert.
  await admin.from('org_members').delete().is('organization_id', null).eq('user_id', userIds.superadmin);
  const { error: superErr } = await admin.from('org_members')
    .insert({ organization_id: null, user_id: userIds.superadmin, roles: ['super_admin'] });
  assert.equal(superErr, null, superErr?.message);

  // 4. Org members.
  const memberRows = [
    { organization_id: org.id, user_id: userIds.hr, roles: ['hr_admin'] },
    { organization_id: org.id, user_id: userIds.manager, roles: ['employee'] },
    { organization_id: org.id, user_id: userIds.employee, roles: ['employee'] },
    { organization_id: org.id, user_id: userIds.hod, roles: ['employee'] },
  ];
  const { error: memErr } = await admin.from('org_members').insert(memberRows);
  assert.equal(memErr, null, memErr?.message);

  // 5. Roster. EMP004 is roster-only (group_name NONE, no login).
  const { data: emps, error: empErr } = await admin.from('employees').insert([
    { organization_id: org.id, employee_code: 'EMP001', full_name: 'Manager Mary', email: USERS.manager, designation: 'Team Lead', department: 'Sales', group_name: 'Sales', user_id: userIds.manager },
    { organization_id: org.id, employee_code: 'EMP002', full_name: 'Employee Eve', email: USERS.employee, designation: 'Executive', department: 'Sales', group_name: 'Sales', user_id: userIds.employee },
    { organization_id: org.id, employee_code: 'EMP003', full_name: 'Hod Harry', email: USERS.hod, designation: 'Department Head', department: 'Sales', group_name: 'Sales', user_id: userIds.hod },
    { organization_id: org.id, employee_code: 'EMP004', full_name: 'Outside Ollie', email: 'pms-outside@example.com', designation: 'CFO', department: 'Finance', group_name: 'NONE', user_id: null },
  ]).select();
  assert.equal(empErr, null, empErr?.message);
  const byCode = Object.fromEntries(emps.map((e) => [e.employee_code, e.id]));

  // 6. Reporting: Eve reports to Mary; Eve's HOD is Harry; Mary's manager is roster-only Ollie.
  const { error: rrErr } = await admin.from('reporting_relationships').insert([
    { organization_id: org.id, employee_id: byCode.EMP002, related_employee_id: byCode.EMP001, relation_type: 'manager' },
    { organization_id: org.id, employee_id: byCode.EMP002, related_employee_id: byCode.EMP003, relation_type: 'hod' },
    { organization_id: org.id, employee_id: byCode.EMP001, related_employee_id: byCode.EMP004, relation_type: 'manager' },
  ]);
  assert.equal(rrErr, null, rrErr?.message);

  // 7. Draft cycle + snapshot + windows + participants.
  const { data: cycle, error: cycErr } = await admin.from('appraisal_cycles').insert({
    organization_id: org.id, name: 'FY26 Test Cycle', period_label: 'FY 2026-27',
    framework_id: 'kra-kpi', status: 'draft', created_by: userIds.hr,
  }).select().single();
  assert.equal(cycErr, null, cycErr?.message);

  const { error: snapErr } = await admin.from('cycle_config_snapshots').insert({
    organization_id: org.id, cycle_id: cycle.id,
    snapshot: { visibility: { manager_rating_visible: 'after_publish', final_rating_visible: 'after_publish' } },
  });
  assert.equal(snapErr, null, snapErr?.message);

  const { error: winErr } = await admin.from('cycle_phase_windows').insert([
    { organization_id: org.id, cycle_id: cycle.id, window_key: 'goal_creation', starts_on: '2026-04-01', ends_on: '2026-04-30' },
    { organization_id: org.id, cycle_id: cycle.id, window_key: 'self_evaluation', starts_on: '2027-02-01', ends_on: '2027-02-28' },
  ]);
  assert.equal(winErr, null, winErr?.message);

  const { data: parts, error: partErr } = await admin.from('cycle_participants').insert([
    { organization_id: org.id, cycle_id: cycle.id, employee_id: byCode.EMP001 },
    { organization_id: org.id, cycle_id: cycle.id, employee_id: byCode.EMP002 },
    { organization_id: org.id, cycle_id: cycle.id, employee_id: byCode.EMP003 },
  ]).select();
  assert.equal(partErr, null, partErr?.message);
  assert.equal(parts.length, 3);

  console.log(`seed-foundation: PASS (org ${org.id}, cycle ${cycle.id})`);
}
```

- [ ] **Step 2: Run the seed**

Run: `node supabase/verify/seed-foundation.mjs`
Expected: `seed-foundation: PASS (org <uuid>, cycle <uuid>)`, exit 0.

- [ ] **Step 3: Re-run to prove idempotency**

Run: `node supabase/verify/seed-foundation.mjs`
Expected: same PASS output, no unique-violation errors.

- [ ] **Step 4: Commit**

```bash
git add supabase/verify/seed-foundation.mjs
git commit -m "feat(foundation): idempotent test-identity and draft-cycle seed"
```

---

### Task 5: RLS helpers, grants, and policies

**Files:**
- Create: `supabase/migrations/2026070314_pms_rls.sql`

**Interfaces:**
- Consumes: all Task 1–3 tables; seeded rows (for the next task's checks).
- Produces (SQL functions later plans may call): `pms.is_super_admin() → boolean`, `pms.member_roles(p_org uuid) → text[]`, `pms.has_role(p_org uuid, p_role text) → boolean`, `pms.is_org_member(p_org uuid) → boolean`, `pms.is_org_reader(p_org uuid) → boolean`, `pms.self_employee_id(p_org uuid) → uuid`, `pms.manages(p_org uuid, p_emp uuid) → boolean`, `pms.is_hod_of(p_org uuid, p_emp uuid) → boolean`, `pms.is_my_related(p_org uuid, p_emp uuid) → boolean`, `pms.stage_visible(p_cycle uuid, p_key text) → boolean`, `pms.can_read_evaluation(p_org uuid, p_cycle uuid, p_emp uuid, p_stage text) → boolean`.
- Produces: RLS enabled on every `pms` table; SELECT-only grants to `authenticated` (plus `UPDATE(read_at)` on notifications); zero grants to `anon`; realtime publication on `pms.notifications` and `pms.cycle_publications`.

- [ ] **Step 1: Write the RLS migration**

`supabase/migrations/2026070314_pms_rls.sql`:

```sql
-- ============ helper functions (SECURITY DEFINER so policies don't recurse) ============
create or replace function pms.is_super_admin() returns boolean
language sql stable security definer set search_path = pms, public as $$
  select exists (
    select 1 from pms.org_members
    where user_id = auth.uid() and organization_id is null
      and 'super_admin' = any(roles) and status = 'active'
  );
$$;

create or replace function pms.member_roles(p_org uuid) returns text[]
language sql stable security definer set search_path = pms, public as $$
  select coalesce(
    (select roles from pms.org_members
     where user_id = auth.uid() and organization_id = p_org and status = 'active'),
    '{}'::text[]);
$$;

create or replace function pms.has_role(p_org uuid, p_role text) returns boolean
language sql stable security definer set search_path = pms, public as $$
  select p_role = any(pms.member_roles(p_org));
$$;

create or replace function pms.is_org_member(p_org uuid) returns boolean
language sql stable security definer set search_path = pms, public as $$
  select pms.is_super_admin() or cardinality(pms.member_roles(p_org)) > 0;
$$;

create or replace function pms.is_org_reader(p_org uuid) returns boolean
language sql stable security definer set search_path = pms, public as $$
  select pms.is_super_admin() or pms.has_role(p_org, 'hr_admin');
$$;

create or replace function pms.self_employee_id(p_org uuid) returns uuid
language sql stable security definer set search_path = pms, public as $$
  select id from pms.employees
  where organization_id = p_org and user_id = auth.uid()
  limit 1;
$$;

create or replace function pms.manages(p_org uuid, p_emp uuid) returns boolean
language sql stable security definer set search_path = pms, public as $$
  select exists (
    select 1 from pms.reporting_relationships
    where organization_id = p_org and employee_id = p_emp
      and relation_type = 'manager'
      and related_employee_id = pms.self_employee_id(p_org)
  );
$$;

create or replace function pms.is_hod_of(p_org uuid, p_emp uuid) returns boolean
language sql stable security definer set search_path = pms, public as $$
  select exists (
    select 1 from pms.reporting_relationships
    where organization_id = p_org and employee_id = p_emp
      and relation_type = 'hod'
      and related_employee_id = pms.self_employee_id(p_org)
  );
$$;

-- "People related to me": my manager / L2 / HOD rows, so their names can render.
create or replace function pms.is_my_related(p_org uuid, p_emp uuid) returns boolean
language sql stable security definer set search_path = pms, public as $$
  select exists (
    select 1 from pms.reporting_relationships
    where organization_id = p_org
      and employee_id = pms.self_employee_id(p_org)
      and related_employee_id = p_emp
  );
$$;

-- Visibility of manager/final stages to the employee (and their manager),
-- driven by the frozen snapshot: immediate | after_publish (default) | never.
create or replace function pms.stage_visible(p_cycle uuid, p_key text) returns boolean
language plpgsql stable security definer set search_path = pms, public as $$
declare v text;
begin
  select coalesce(snapshot #>> array['visibility', p_key], 'after_publish')
    into v from pms.cycle_config_snapshots where cycle_id = p_cycle;
  v := coalesce(v, 'after_publish');
  if v = 'never' then return false; end if;
  if v = 'immediate' then return true; end if;
  return exists (
    select 1 from pms.cycle_publications
    where cycle_id = p_cycle and revoked_at is null
  );
end $$;

create or replace function pms.can_read_evaluation(p_org uuid, p_cycle uuid, p_emp uuid, p_stage text) returns boolean
language plpgsql stable security definer set search_path = pms, public as $$
declare me uuid;
begin
  if pms.is_org_reader(p_org) then return true; end if;
  me := pms.self_employee_id(p_org);
  if p_stage = 'self' then
    return p_emp = me or pms.manages(p_org, p_emp) or pms.is_hod_of(p_org, p_emp);
  elsif p_stage = 'manager' then
    if pms.manages(p_org, p_emp) or pms.is_hod_of(p_org, p_emp) then return true; end if;
    return p_emp = me and pms.stage_visible(p_cycle, 'manager_rating_visible');
  elsif p_stage = 'hod' then
    return pms.is_hod_of(p_org, p_emp);
  elsif p_stage = 'hr_final' then
    if pms.is_hod_of(p_org, p_emp) then return true; end if;
    if p_emp = me or pms.manages(p_org, p_emp) then
      return pms.stage_visible(p_cycle, 'final_rating_visible');
    end if;
  end if;
  return false;
end $$;

-- ============ enable RLS everywhere ============
do $$
declare t text;
begin
  for t in select table_name from information_schema.tables
           where table_schema = 'pms' and table_type = 'BASE TABLE'
  loop
    execute format('alter table pms.%I enable row level security', t);
  end loop;
end $$;

-- ============ grants: logged-in users read (RLS gates rows); anon gets nothing ============
grant usage on schema pms to authenticated;
grant select on all tables in schema pms to authenticated;
grant update (read_at) on pms.notifications to authenticated;
alter default privileges in schema pms grant select on tables to authenticated;

-- ============ SELECT policies ============
create policy org_select on pms.organizations for select
  using (pms.is_super_admin() or pms.is_org_member(id));

-- Org members may read shared org/cycle configuration.
create policy member_read on pms.organization_branding for select using (pms.is_org_member(organization_id));
create policy member_read on pms.org_grades for select using (pms.is_org_member(organization_id));
create policy member_read on pms.competency_library for select using (pms.is_org_member(organization_id));
create policy member_read on pms.goal_libraries for select using (pms.is_org_member(organization_id));
create policy member_read on pms.goal_library_items for select using (pms.is_org_member(organization_id));
create policy member_read on pms.appraisal_cycles for select using (pms.is_org_member(organization_id));
create policy member_read on pms.cycle_phase_windows for select using (pms.is_org_member(organization_id));
create policy member_read on pms.cycle_config_snapshots for select using (pms.is_org_member(organization_id));
create policy member_read on pms.cycle_perspectives for select using (pms.is_org_member(organization_id));
create policy member_read on pms.cycle_groups for select using (pms.is_org_member(organization_id));
create policy member_read on pms.cycle_group_segment_values for select using (pms.is_org_member(organization_id));
create policy member_read on pms.cycle_group_library_assignments for select using (pms.is_org_member(organization_id));
create policy member_read on pms.cycle_target_types for select using (pms.is_org_member(organization_id));
create policy member_read on pms.cycle_rating_scale_levels for select using (pms.is_org_member(organization_id));
create policy member_read on pms.cycle_auto_rating_bands for select using (pms.is_org_member(organization_id));
create policy member_read on pms.cycle_goal_rules for select using (pms.is_org_member(organization_id));
create policy member_read on pms.cycle_competency_config for select using (pms.is_org_member(organization_id));
create policy member_read on pms.cycle_competency_assignments for select using (pms.is_org_member(organization_id));
create policy member_read on pms.cycle_publications for select using (pms.is_org_member(organization_id));

-- HR/super-admin only.
create policy hr_read on pms.prefill_datasets for select using (pms.is_org_reader(organization_id));
create policy hr_read on pms.prefill_dataset_items for select using (pms.is_org_reader(organization_id));
create policy hr_read on pms.cycle_bell_curve_bands for select using (pms.is_org_reader(organization_id));
create policy hr_read on pms.cycle_config_versions for select using (pms.is_org_reader(organization_id));
create policy hr_read on pms.email_jobs for select using (pms.is_org_reader(organization_id));
create policy hr_read on pms.background_jobs for select using (pms.is_org_reader(organization_id));
create policy hr_read on pms.import_runs for select using (pms.is_org_reader(organization_id));
create policy hr_read on pms.audit_logs for select using (pms.is_org_reader(organization_id));
create policy hr_read on pms.email_delivery_attempts for select
  using (exists (select 1 from pms.email_jobs j
                 where j.id = email_job_id and pms.is_org_reader(j.organization_id)));
create policy hr_read on pms.import_run_errors for select
  using (exists (select 1 from pms.import_runs r
                 where r.id = import_run_id and pms.is_org_reader(r.organization_id)));

-- Own membership rows + HR.
create policy member_self_read on pms.org_members for select
  using (user_id = auth.uid()
         or (organization_id is not null and pms.is_org_reader(organization_id)));

-- Roster: self, people I manage / HOD over, people related to me, HR.
create policy employees_scoped_read on pms.employees for select
  using (pms.is_org_reader(organization_id)
         or user_id = auth.uid()
         or pms.manages(organization_id, id)
         or pms.is_hod_of(organization_id, id)
         or pms.is_my_related(organization_id, id));

create policy rr_scoped_read on pms.reporting_relationships for select
  using (pms.is_org_reader(organization_id)
         or employee_id = pms.self_employee_id(organization_id)
         or related_employee_id = pms.self_employee_id(organization_id));

-- Participation: self, manager, HOD, HR.
create policy participants_scoped_read on pms.cycle_participants for select
  using (pms.is_org_reader(organization_id)
         or employee_id = pms.self_employee_id(organization_id)
         or pms.manages(organization_id, employee_id)
         or pms.is_hod_of(organization_id, employee_id));
create policy assignments_scoped_read on pms.cycle_participant_assignments for select
  using (pms.is_org_reader(organization_id)
         or employee_id = pms.self_employee_id(organization_id)
         or pms.manages(organization_id, employee_id)
         or pms.is_hod_of(organization_id, employee_id));

-- Goal plans and their children: self, manager, HOD, HR.
create policy plans_scoped_read on pms.employee_goal_plans for select
  using (pms.is_org_reader(organization_id)
         or employee_id = pms.self_employee_id(organization_id)
         or pms.manages(organization_id, employee_id)
         or pms.is_hod_of(organization_id, employee_id));
create policy items_scoped_read on pms.employee_goal_items for select
  using (pms.is_org_reader(organization_id)
         or employee_id = pms.self_employee_id(organization_id)
         or pms.manages(organization_id, employee_id)
         or pms.is_hod_of(organization_id, employee_id));
create policy plan_comps_scoped_read on pms.employee_goal_plan_competencies for select
  using (pms.is_org_reader(organization_id)
         or employee_id = pms.self_employee_id(organization_id)
         or pms.manages(organization_id, employee_id)
         or pms.is_hod_of(organization_id, employee_id));
create policy gwe_scoped_read on pms.goal_workflow_events for select
  using (pms.is_org_reader(organization_id)
         or employee_id = pms.self_employee_id(organization_id)
         or pms.manages(organization_id, employee_id)
         or pms.is_hod_of(organization_id, employee_id));

-- Evaluations: stage-aware visibility.
create policy eval_visibility_read on pms.evaluations for select
  using (pms.can_read_evaluation(organization_id, cycle_id, employee_id, stage));
create policy eval_scores_visibility_read on pms.evaluation_goal_scores for select
  using (exists (select 1 from pms.evaluations e where e.id = evaluation_id
                 and pms.can_read_evaluation(e.organization_id, e.cycle_id, e.employee_id, e.stage)));
create policy eval_comp_scores_visibility_read on pms.evaluation_competency_scores for select
  using (exists (select 1 from pms.evaluations e where e.id = evaluation_id
                 and pms.can_read_evaluation(e.organization_id, e.cycle_id, e.employee_id, e.stage)));

-- Calibrations: HR + the HOD who covers that employee.
create policy calibrations_scoped_read on pms.calibrations for select
  using (pms.is_org_reader(organization_id)
         or pms.is_hod_of(organization_id, employee_id));

-- Acknowledgements: own + HR.
create policy ack_scoped_read on pms.rating_acknowledgements for select
  using (pms.is_org_reader(organization_id)
         or employee_id = pms.self_employee_id(organization_id));

-- Notifications: recipient only; recipient may mark read (column grant limits to read_at).
create policy notif_recipient_read on pms.notifications for select
  using (exists (select 1 from pms.org_members m
                 where m.id = recipient_member_id and m.user_id = auth.uid()));
create policy notif_recipient_mark_read on pms.notifications for update
  using (exists (select 1 from pms.org_members m
                 where m.id = recipient_member_id and m.user_id = auth.uid()))
  with check (exists (select 1 from pms.org_members m
                      where m.id = recipient_member_id and m.user_id = auth.uid()));

-- ============ realtime ============
do $$
begin
  begin
    alter publication supabase_realtime add table pms.notifications;
  exception when duplicate_object then null;
  end;
  begin
    alter publication supabase_realtime add table pms.cycle_publications;
  exception when duplicate_object then null;
  end;
end $$;
```

- [ ] **Step 2: Apply the migration**

Run: `supabase db push`
Expected: `Applying migration 2026070314_pms_rls.sql... Finished supabase db push.`

- [ ] **Step 3: Quick sanity check (service role unaffected)**

Run: `node supabase/verify/check-tables.mjs`
Expected: still all `ok` + `check-tables: PASS` (service role bypasses RLS).

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/2026070314_pms_rls.sql
git commit -m "feat(foundation): RLS helpers, deny-by-default grants, scoped read policies"
```

---

### Task 6: RLS verification suite

**Files:**
- Create: `supabase/verify/rls-check.mjs`

**Interfaces:**
- Consumes: seeded identities from `seed-foundation.mjs` (`USERS`, `PASSWORD`, `ORG_KEY`); `anonClient()`, `signIn()`, `adminClient()`.
- Produces: `node supabase/verify/rls-check.mjs` → prints `rls-check: PASS (N assertions)`; exits non-zero on any leak.

- [ ] **Step 1: Write the failing RLS checks**

`supabase/verify/rls-check.mjs`:

```js
// Run: node supabase/verify/seed-foundation.mjs && node supabase/verify/rls-check.mjs
// Proves the RLS contract: anon = nothing; employee/manager/HOD = scoped rows;
// HR = whole org; browser writes to business tables = denied; version bump + working-cycle constraint work.
import assert from 'node:assert/strict';
import { anonClient, signIn, adminClient } from './_clients.mjs';
import { USERS, PASSWORD, ORG_KEY } from './seed-foundation.mjs';

let n = 0;
const check = (desc, cond) => { n += 1; assert.ok(cond, `FAIL: ${desc}`); console.log(`ok ${desc}`); };

const admin = adminClient();
const { data: org } = await admin.from('organizations').select('id').eq('key', ORG_KEY).single();
assert.ok(org, 'seed org missing — run seed-foundation.mjs first');

// --- anon: schema not granted, everything fails ---
{
  const anon = anonClient();
  const { data, error } = await anon.from('employees').select('id');
  check('anon cannot read employees', error !== null || (data ?? []).length === 0);
}

// --- employee (Eve): own row + related people only; no writes ---
{
  const { client } = await signIn(USERS.employee, PASSWORD);
  const { data: emps } = await client.from('employees').select('employee_code');
  const codes = (emps ?? []).map((e) => e.employee_code).sort();
  check('employee sees self + manager + HOD only', JSON.stringify(codes) === JSON.stringify(['EMP001', 'EMP002', 'EMP003']));
  const { data: windows } = await client.from('cycle_phase_windows').select('window_key');
  check('employee can read phase windows', (windows ?? []).length === 2);
  const { error: insErr } = await client.from('employees').insert({
    organization_id: org.id, employee_code: 'EMP999', full_name: 'Hacker', group_name: 'Sales',
  });
  check('employee cannot insert employees', insErr !== null);
  const { data: upd } = await client.from('employees')
    .update({ full_name: 'Renamed' }).eq('employee_code', 'EMP002').select();
  check('employee cannot update own roster row', (upd ?? []).length === 0);
  const { data: bell, error: bellErr } = await client.from('cycle_bell_curve_bands').select('id');
  check('employee cannot read bell curve bands', bellErr !== null || (bell ?? []).length === 0);
  const { data: prefill, error: preErr } = await client.from('prefill_dataset_items').select('id');
  check('employee cannot read prefill items', preErr !== null || (prefill ?? []).length === 0);
}

// --- manager (Mary): self + direct report + own manager; not the HOD ---
{
  const { client } = await signIn(USERS.manager, PASSWORD);
  const { data: emps } = await client.from('employees').select('employee_code');
  const codes = (emps ?? []).map((e) => e.employee_code).sort();
  check('manager sees self + report + own manager', JSON.stringify(codes) === JSON.stringify(['EMP001', 'EMP002', 'EMP004']));
  const { data: parts } = await client.from('cycle_participants').select('employee_id');
  check('manager sees own + report participation (2 rows)', (parts ?? []).length === 2);
}

// --- HOD (Harry): sees mapped employee via hod relation ---
{
  const { client } = await signIn(USERS.hod, PASSWORD);
  const { data: emps } = await client.from('employees').select('employee_code');
  const codes = (emps ?? []).map((e) => e.employee_code).sort();
  check('HOD sees self + mapped employee', JSON.stringify(codes) === JSON.stringify(['EMP002', 'EMP003']));
}

// --- HR: whole org, including roster-only EMP004 ---
{
  const { client } = await signIn(USERS.hr, PASSWORD);
  const { data: emps } = await client.from('employees').select('employee_code');
  check('HR sees all 4 roster rows', (emps ?? []).length === 4);
  const { data: audit, error: auditErr } = await client.from('audit_logs').select('id').limit(1);
  check('HR can read audit logs', auditErr === null);
  const { error: delErr, count } = await client.from('employees')
    .delete({ count: 'exact' }).eq('employee_code', 'EMP004');
  check('HR cannot delete roster rows from browser', delErr !== null || count === 0 || count === null);
}

// --- super admin: sees the org ---
{
  const { client } = await signIn(USERS.superadmin, PASSWORD);
  const { data: orgs } = await client.from('organizations').select('key');
  check('super admin sees organizations', (orgs ?? []).some((o) => o.key === ORG_KEY));
}

// --- version trigger + working-cycle constraint (service role) ---
{
  const { data: before } = await admin.from('employees')
    .select('id, version').eq('organization_id', org.id).eq('employee_code', 'EMP004').single();
  const { data: after } = await admin.from('employees')
    .update({ designation: 'Group CFO' }).eq('id', before.id).select('version').single();
  check('version auto-bumps on update', after.version === before.version + 1);
  const { error: cycleErr } = await admin.from('appraisal_cycles').insert({
    organization_id: org.id, name: 'Illegal Second Cycle', framework_id: 'kra',
  });
  check('second working cycle rejected', cycleErr !== null && /duplicate|unique/i.test(cycleErr.message));
}

console.log(`rls-check: PASS (${n} assertions)`);
```

- [ ] **Step 2: Reseed, then run the checks**

Run: `node supabase/verify/seed-foundation.mjs && node supabase/verify/rls-check.mjs`
Expected: every line `ok ...`, ending `rls-check: PASS (16 assertions)`, exit 0. If any assertion fails, fix the policy in a new migration (do not edit the applied one) before proceeding.

- [ ] **Step 3: Commit**

```bash
git add supabase/verify/rls-check.mjs
git commit -m "test(foundation): RLS scope and write-denial verification suite"
```

---

### Task 7: Edge-function kernel + first deployed function (`pms-admin`)

**Files:**
- Create: `supabase/functions/_shared/kernel.ts`
- Create: `supabase/functions/_shared/kernel.test.ts`
- Create: `supabase/functions/pms-admin/index.ts`
- Create: `supabase/functions/pms-admin/config.toml`
- Create: `supabase/verify/kernel-check.mjs`

**Interfaces:**
- Consumes: `pms.org_members`, `pms.employees`, `pms.audit_logs`; env `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` (auto-injected into edge functions); seed identities.
- Produces (TypeScript, used by every later backend plan):
  - `class ApiError(code: string, message: string, status?: number)`
  - `parseActionBody(body: unknown) → { action: string, payload: Record<string, unknown> }`
  - `toResponse(result, status?) → Response`
  - `type Membership = { memberId: string, organizationId: string | null, roles: string[], employeeId: string | null }`
  - `type HandlerCtx = { admin, userId, memberships, requireOrgRole(orgId, roles), audit(entry), versionedUpdate(table, id, expectedVersion, patch) }`
  - `serveActions(handlers: Record<string, (payload, ctx) => Promise<unknown>>)` — request contract: POST JSON `{ action: 'domain.action', payload: {...} }` with the user's `Authorization: Bearer <jwt>`; response `{ ok, data | error }`.
  - Deployed function `pms-admin` with action `admin.whoami`.

- [ ] **Step 1: Write failing kernel unit tests**

`supabase/functions/_shared/kernel.test.ts`:

```ts
import { assertEquals, assertThrows } from 'jsr:@std/assert@1';
import { ApiError, parseActionBody, toResponse } from './kernel.ts';

Deno.test('parseActionBody accepts a valid action and defaults payload', () => {
  const parsed = parseActionBody({ action: 'admin.whoami' });
  assertEquals(parsed.action, 'admin.whoami');
  assertEquals(parsed.payload, {});
});

Deno.test('parseActionBody rejects a missing action', () => {
  assertThrows(() => parseActionBody({}), ApiError);
});

Deno.test('parseActionBody rejects a non-namespaced action', () => {
  assertThrows(() => parseActionBody({ action: 'whoami' }), ApiError);
});

Deno.test('parseActionBody rejects an array payload', () => {
  assertThrows(() => parseActionBody({ action: 'a.b', payload: [] }), ApiError);
});

Deno.test('toResponse wraps success and error shapes', async () => {
  const okRes = toResponse({ ok: true, data: { x: 1 } });
  assertEquals(okRes.status, 200);
  assertEquals(await okRes.json(), { ok: true, data: { x: 1 } });
  const errRes = toResponse({ ok: false, error: { code: 'CONFLICT', message: 'someone else changed this — reload' } }, 409);
  assertEquals(errRes.status, 409);
  const body = await errRes.json();
  assertEquals(body.error.code, 'CONFLICT');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `deno test supabase/functions/_shared/kernel.test.ts`
Expected: FAIL — `error: Module not found ... kernel.ts`.

- [ ] **Step 3: Write the kernel**

`supabase/functions/_shared/kernel.ts`:

```ts
// Shared kernel for all pms-* edge functions.
// Contract: POST { action: 'domain.action', payload: {} } with the user's JWT.
// Every handler: validate → permission check → transactional write → audit → { ok, data }.
import { createClient, SupabaseClient } from 'npm:@supabase/supabase-js@2';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

export class ApiError extends Error {
  constructor(public code: string, message: string, public status = 400) {
    super(message);
  }
}

export type Membership = {
  memberId: string;
  organizationId: string | null;
  roles: string[];
  employeeId: string | null;
};

export type AuditEntry = {
  organizationId: string;
  cycleId?: string | null;
  action: string;
  entityType?: string;
  entityId?: string | null;
  before?: unknown;
  after?: unknown;
  note?: string;
};

export type HandlerCtx = {
  admin: SupabaseClient;
  userId: string;
  memberships: Membership[];
  requireOrgRole(orgId: string, roles: string[]): Membership;
  audit(entry: AuditEntry): Promise<void>;
  versionedUpdate(
    table: string,
    id: string,
    expectedVersion: number,
    patch: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;
};

export type Handler = (payload: Record<string, unknown>, ctx: HandlerCtx) => Promise<unknown>;

export function parseActionBody(body: unknown): { action: string; payload: Record<string, unknown> } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new ApiError('BAD_REQUEST', 'Request body must be a JSON object', 400);
  }
  const { action, payload } = body as Record<string, unknown>;
  if (typeof action !== 'string' || !action.includes('.')) {
    throw new ApiError('BAD_REQUEST', 'Missing or invalid "action" (expected "domain.action")', 400);
  }
  if (payload !== undefined && (payload === null || typeof payload !== 'object' || Array.isArray(payload))) {
    throw new ApiError('BAD_REQUEST', '"payload" must be an object when provided', 400);
  }
  return { action, payload: (payload ?? {}) as Record<string, unknown> };
}

export function toResponse(
  result: { ok: true; data: unknown } | { ok: false; error: { code: string; message: string } },
  status = 200,
): Response {
  return new Response(JSON.stringify(result), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

async function buildCtx(req: Request): Promise<HandlerCtx> {
  const url = Deno.env.get('SUPABASE_URL')!;
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!;
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

  const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
  if (!token) throw new ApiError('AUTH_REQUIRED', 'Sign in required', 401);

  const authClient = createClient(url, anonKey, { auth: { persistSession: false } });
  const { data: userData, error: userErr } = await authClient.auth.getUser(token);
  if (userErr || !userData?.user) throw new ApiError('AUTH_REQUIRED', 'Sign in required', 401);
  const userId = userData.user.id;

  const admin = createClient(url, serviceKey, {
    db: { schema: 'pms' },
    auth: { persistSession: false },
  });

  const { data: memberRows, error: memberErr } = await admin
    .from('org_members')
    .select('id, organization_id, roles, status')
    .eq('user_id', userId)
    .eq('status', 'active');
  if (memberErr) throw new ApiError('DB_ERROR', memberErr.message, 500);

  const { data: empRows, error: empErr } = await admin
    .from('employees')
    .select('id, organization_id')
    .eq('user_id', userId);
  if (empErr) throw new ApiError('DB_ERROR', empErr.message, 500);

  const memberships: Membership[] = (memberRows ?? []).map((m) => ({
    memberId: m.id,
    organizationId: m.organization_id,
    roles: m.roles ?? [],
    employeeId: (empRows ?? []).find((e) => e.organization_id === m.organization_id)?.id ?? null,
  }));
  if (memberships.length === 0) {
    throw new ApiError('NO_MEMBERSHIP', 'This account has no organization access', 403);
  }

  const isSuperAdmin = memberships.some(
    (m) => m.organizationId === null && m.roles.includes('super_admin'),
  );

  const ctx: HandlerCtx = {
    admin,
    userId,
    memberships,
    requireOrgRole(orgId, roles) {
      const membership = memberships.find((m) => m.organizationId === orgId);
      if (membership && roles.some((r) => membership.roles.includes(r))) return membership;
      if (isSuperAdmin) {
        return { memberId: '', organizationId: orgId, roles: ['super_admin'], employeeId: null };
      }
      throw new ApiError('FORBIDDEN', 'You do not have permission for this action', 403);
    },
    async audit(entry) {
      const { error } = await admin.from('audit_logs').insert({
        organization_id: entry.organizationId,
        cycle_id: entry.cycleId ?? null,
        actor_user_id: userId,
        actor_role: memberships.find((m) => m.organizationId === entry.organizationId)?.roles.join(',') ??
          (isSuperAdmin ? 'super_admin' : null),
        action: entry.action,
        entity_type: entry.entityType ?? null,
        entity_id: entry.entityId ?? null,
        before: entry.before ?? null,
        after: entry.after ?? null,
        note: entry.note ?? null,
      });
      if (error) throw new ApiError('DB_ERROR', `audit failed: ${error.message}`, 500);
    },
    async versionedUpdate(table, id, expectedVersion, patch) {
      const { data, error } = await admin
        .from(table)
        .update(patch)
        .eq('id', id)
        .eq('version', expectedVersion)
        .select()
        .maybeSingle();
      if (error) throw new ApiError('DB_ERROR', error.message, 500);
      if (data) return data;
      const { data: row } = await admin.from(table).select('id').eq('id', id).maybeSingle();
      if (!row) throw new ApiError('NOT_FOUND', `${table} row not found`, 404);
      throw new ApiError('CONFLICT', 'someone else changed this — reload', 409);
    },
  };
  return ctx;
}

export function serveActions(handlers: Record<string, Handler>): void {
  Deno.serve(async (req) => {
    if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
    try {
      if (req.method !== 'POST') throw new ApiError('BAD_REQUEST', 'POST only', 405);
      let body: unknown;
      try {
        body = await req.json();
      } catch {
        throw new ApiError('BAD_REQUEST', 'Body must be valid JSON', 400);
      }
      const { action, payload } = parseActionBody(body);
      const handler = handlers[action];
      if (!handler) throw new ApiError('UNKNOWN_ACTION', `Unknown action "${action}"`, 404);
      const ctx = await buildCtx(req);
      const data = await handler(payload, ctx);
      return toResponse({ ok: true, data });
    } catch (err) {
      if (err instanceof ApiError) {
        return toResponse({ ok: false, error: { code: err.code, message: err.message } }, err.status);
      }
      console.error('unhandled', err);
      return toResponse(
        { ok: false, error: { code: 'INTERNAL', message: 'Something went wrong' } },
        500,
      );
    }
  });
}
```

- [ ] **Step 4: Run kernel tests to verify they pass**

Run: `deno test supabase/functions/_shared/kernel.test.ts`
Expected: `ok | 5 passed | 0 failed`.

- [ ] **Step 5: Write the `pms-admin` function**

`supabase/functions/pms-admin/index.ts`:

```ts
import { serveActions } from '../_shared/kernel.ts';

serveActions({
  'admin.whoami': (_payload, ctx) =>
    Promise.resolve({ userId: ctx.userId, memberships: ctx.memberships }),
});
```

`supabase/functions/pms-admin/config.toml`:

```toml
verify_jwt = true
```

- [ ] **Step 6: Deploy**

Run: `supabase functions deploy pms-admin`
Expected: `Deployed Functions on project mkjtdwrzmobahwkpumxx: pms-admin`.

- [ ] **Step 7: Write the live kernel check**

`supabase/verify/kernel-check.mjs`:

```js
// Run: node supabase/verify/kernel-check.mjs (after seed-foundation.mjs)
import assert from 'node:assert/strict';
import { signIn, SUPABASE_URL, ANON_KEY } from './_clients.mjs';
import { USERS, PASSWORD, ORG_KEY } from './seed-foundation.mjs';
import { adminClient } from './_clients.mjs';

const FN_URL = `${SUPABASE_URL}/functions/v1/pms-admin`;

async function call(token, body) {
  const res = await fetch(FN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: ANON_KEY,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

const admin = adminClient();
const { data: org } = await admin.from('organizations').select('id').eq('key', ORG_KEY).single();
const { data: eve } = await admin.from('employees')
  .select('id').eq('organization_id', org.id).eq('employee_code', 'EMP002').single();

// 1. No token → gateway or kernel rejects.
{
  const { status } = await call(null, { action: 'admin.whoami' });
  assert.ok(status === 401, `expected 401 without token, got ${status}`);
  console.log('ok rejects missing token');
}

// 2. Signed-in employee → memberships include employeeId.
{
  const { session } = await signIn(USERS.employee, PASSWORD);
  const { status, body } = await call(session.access_token, { action: 'admin.whoami' });
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  const m = body.data.memberships.find((x) => x.organizationId === org.id);
  assert.ok(m, 'membership for org missing');
  assert.equal(m.employeeId, eve.id, 'employeeId mismatch');
  console.log('ok whoami resolves membership + employee link');
}

// 3. Unknown action → 404 UNKNOWN_ACTION.
{
  const { session } = await signIn(USERS.employee, PASSWORD);
  const { status, body } = await call(session.access_token, { action: 'admin.nope' });
  assert.equal(status, 404);
  assert.equal(body.error.code, 'UNKNOWN_ACTION');
  console.log('ok unknown action rejected');
}

console.log('kernel-check: PASS');
```

- [ ] **Step 8: Run the live check**

Run: `node supabase/verify/kernel-check.mjs`
Expected: three `ok ...` lines then `kernel-check: PASS`, exit 0.

- [ ] **Step 9: Commit**

```bash
git add supabase/functions/_shared/kernel.ts supabase/functions/_shared/kernel.test.ts supabase/functions/pms-admin/index.ts supabase/functions/pms-admin/config.toml supabase/verify/kernel-check.mjs
git commit -m "feat(foundation): edge kernel (auth, roles, audit, versioned writes) + pms-admin whoami"
```

---

### Task 8: Foundation smoke runner

**Files:**
- Create: `supabase/verify/run-all.mjs`

**Interfaces:**
- Consumes: all Task 1–7 scripts.
- Produces: single command `node supabase/verify/run-all.mjs` → `FOUNDATION SMOKE: ALL PASS`; the gate later plans re-run before building on top.

- [ ] **Step 1: Write the runner**

`supabase/verify/run-all.mjs`:

```js
// Run: node supabase/verify/run-all.mjs
// Foundation gate: schema present, seed fresh, RLS holds, kernel live.
import { spawnSync } from 'node:child_process';

const scripts = [
  'supabase/verify/check-tables.mjs',
  'supabase/verify/seed-foundation.mjs',
  'supabase/verify/rls-check.mjs',
  'supabase/verify/kernel-check.mjs',
];

for (const script of scripts) {
  console.log(`\n=== ${script} ===`);
  const res = spawnSync(process.execPath, [script], { stdio: 'inherit' });
  if (res.status !== 0) {
    console.error(`\nFOUNDATION SMOKE: FAILED at ${script}`);
    process.exit(res.status ?? 1);
  }
}
console.log('\nFOUNDATION SMOKE: ALL PASS');
```

- [ ] **Step 2: Run the full gate**

Run: `node supabase/verify/run-all.mjs`
Expected: each section passes; final line `FOUNDATION SMOKE: ALL PASS`, exit 0.

- [ ] **Step 3: Run lint to keep the repo clean**

Run: `npm run lint`
Expected: exits 0 (verify scripts are plain ESM; fix any reported issue in them before committing).

- [ ] **Step 4: Commit**

```bash
git add supabase/verify/run-all.mjs
git commit -m "test(foundation): one-command foundation smoke gate"
```

---

## Out of Scope (later plans)

- Plan 2: cycle-creation backend (wizard transaction, imports, invites, participants) — builds on `serveActions` + these tables.
- Plan 3: workflow backend (goals, evaluations, calibration, publishing, acknowledgements, scoring).
- Plan 4: jobs backend (background worker, email queue draining, exports).
- Plan 5: screen rewiring (frontend reads via RLS + `callPms` client).
- Plan 6: cutover (delete `app_state` blob usage, old functions, localStorage sync; final lockdown).

Nothing in this plan modifies or deletes any existing `public`-schema table, old edge function, or frontend file.
