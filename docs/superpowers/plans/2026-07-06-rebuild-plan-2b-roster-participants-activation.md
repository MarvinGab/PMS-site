# Rebuild Plan 2b: Roster, Participants, Invites & Activation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Populate a draft cycle with people and turn it on — org-level goal-library/prefill CRUD, roster import (validate → preview → atomic commit), cycle participants + per-participant assignments, Supabase-Auth invites queued as email jobs, and an atomic prerequisite-checked activation transaction.

**Architecture:** Extends the Plan 2a `pms-admin` edge function with new domain handler modules (`libraries.ts`, `imports.ts`, `participants.ts`, `invites.ts`, `activation.ts`) on the shared kernel. Multi-table mutations run inside SECURITY DEFINER Postgres RPCs (roster commit, member linking, activation) — each explicitly revoked from public/anon/authenticated with a live 42501 denial assertion, per the systemic lesson from Plan 2a. Auth users are created via the GoTrue admin API (service role); linking + email-job queuing happen in an atomic RPC. Email jobs are only QUEUED here; sending is Plan 4's worker.

**Tech Stack:** Supabase edge functions (Deno, `npm:@supabase/supabase-js@2`), Postgres RLS + SECURITY DEFINER RPCs, GoTrue admin API, Node verify scripts with `node:assert`, Supabase CLI (linked project `mkjtdwrzmobahwkpumxx`).

**Spec:** `docs/superpowers/specs/2026-07-03-server-first-rebuild-design.md` §4.3.9 (upload), §4.4 (create-cycle transaction steps 13–18), §5 (roster-only rule), §7 (lifecycle), §8 (jobs/emails).

## Key Decisions (review these first)

1. **Import contract = pre-parsed JSON rows.** The browser (Plan 5) parses the Excel/CSV and maps headers to canonical keys; the backend receives `rows: [{ employeeCode, fullName, email, designation?, department?, grade?, groupName, managerCode?, l2Code?, hodCode? }]`. The backend owns all validation, not the parsing.
2. **Invites create Supabase-Auth users now, but only QUEUE the email.** Invite = find-or-create `auth.users` row (random password, `email_confirm: true`, so GoTrue sends nothing) → atomic RPC links `org_members` (status `invited`, roles `['employee']`) + sets `employees.user_id` + inserts `email_jobs` (status `queued`, template `invite`, payload carries a generated recovery link) + audits. Actual send is Plan 4. Roster-only (`group_name = 'NONE'`) people are never invited.
3. **Activation does NOT seed goal plans.** `activate_cycle_tx` validates prerequisites and flips `draft`/`setup` → `active` (sets `activated_at`). Creating `employee_goal_plans` (empty or prefill-populated) is Plan 3's domain, where the goal-item/library/prefill resolution logic lives. Activation here is structural only.

## Global Constraints

- **Write rule:** browser reads via RLS only; ALL business writes go through backend functions. No new grants to `anon`.
- **SYSTEMIC LESSON (Plan 2a, binding):** every backend-only SECURITY DEFINER RPC MUST carry its own explicit `revoke all on function <exact-signature> from public, anon, authenticated;` in the same migration that creates it — the default-privilege revoke does NOT cover later-created functions. Each such RPC also gets a live `42501` denial assertion (authenticated + anon) in the verify suite.
- **Kernel contract (binding):** response `{ ok: true, data } | { ok: false, error: { code, message } }`; stale version → `CONFLICT` 409 "someone else changed this — reload"; `versionedUpdate(table, orgId, id, expectedVersion, patch)` is org-scoped; auth precedes routing; raw DB errors never reach clients (`console.error` + generic `DB_ERROR` 500). Validators live in `_shared/validate.ts`.
- **Roster-only rule (spec §5):** every `managerCode`/`l2Code`/`hodCode` must resolve to an `employees` row in the same org. `group_name = 'NONE'` = roster-only: referenceable as manager/HOD, excluded from participation and invites, never labelled "Outside PMS" in any copy.
- **Cycle lifecycle:** participants/assignments/invites editable only while cycle status ∈ `draft`/`setup` (else `CYCLE_LOCKED` 409). Activation requires status ∈ `draft`/`setup`. One working cycle per org already DB-enforced.
- **Permission:** all actions require `ctx.requireOrgRole(orgId, ['hr_admin'])` (super admin passes via kernel fallback).
- Every handler: validate → permission → write → audit → typed response.
- Repo has unrelated dirty files: stage ONLY each task's files. `.env` gitignored, never printed/committed. Old-world files (old edge functions, `public` schema, `src/`) untouched.
- All commands run from `/Users/marvin/Desktop/PMS site`. Branch: `rebuild-2b-roster-activation` (create from `main` at start).
- Commit trailer on every commit: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`
- Existing verify counts at branch start: `rls-check` 49, `admin-check` 39. This plan grows both; each task states the new expected total.

---

### Task 1: Goal library & prefill CRUD actions

**Files:**
- Create: `supabase/functions/pms-admin/libraries.ts`
- Modify: `supabase/functions/pms-admin/index.ts` (spread `libraryHandlers`)
- Modify: `supabase/verify/admin-check.mjs` (append a "libraries" section)

**Interfaces:**
- Consumes: kernel (`serveActions`, `ApiError`, `Handler`), validators, `callAdmin`/`check` from admin-check.mjs.
- Produces actions (all `hr_admin`-or-super, editable in any non-archived cycle status since libraries are org-level, not cycle-scoped): `library.save` `{orgId, libraryId?, name, description?, items: [{itemType, parentKey?, key, title, description?, perspective?, weight?, targetTypeKey?, targetValue?, displayOrder?}]}` → `{library, items}` (creates or version-checked updates the library, full-replaces its items; `parentKey` links a kpi row to its kra row by the payload-local `key`); `library.list` `{orgId}` → `{libraries}`; `library.archive` `{orgId, libraryId, expectedVersion}` → `{library}`; `prefill.save` `{orgId, datasetId?, name, description?, items: [{employeeCode, kraTitle, kpiTitle?, weight?, perspective?, targetTypeKey?, targetValue?, displayOrder?}]}` → `{dataset, items}`; `prefill.list` `{orgId}` → `{datasets}`.

- [ ] **Step 1: Write the libraries module**

`supabase/functions/pms-admin/libraries.ts`:

```ts
import { ApiError, Handler, HandlerCtx } from '../_shared/kernel.ts';
import {
  optNumber, optString, optUuid, reqArray, reqEnum, reqInt, reqObject, reqString, reqUuid,
} from '../_shared/validate.ts';

async function replaceLibraryItems(
  ctx: HandlerCtx, orgId: string, libraryId: string, rawItems: unknown,
): Promise<number> {
  // Two-pass: insert KRA rows first (capturing payload-key → new uuid), then KPI
  // rows resolving parentKey against that map. Payload keys are caller-local.
  const items = reqArray(rawItems, 'items', 500).map((r, i) => {
    const o = reqObject(r, `items[${i}]`);
    return {
      itemType: reqEnum(o.itemType, `items[${i}].itemType`, ['kra', 'kpi']),
      key: reqString(o.key, `items[${i}].key`, 120),
      parentKey: optString(o.parentKey, `items[${i}].parentKey`, 120),
      title: reqString(o.title, `items[${i}].title`, 300),
      description: optString(o.description, `items[${i}].description`, 2000),
      perspective: optString(o.perspective, `items[${i}].perspective`, 120),
      weight: optNumber(o.weight, `items[${i}].weight`),
      target_type_key: optString(o.targetTypeKey, `items[${i}].targetTypeKey`, 60),
      target_value: optString(o.targetValue, `items[${i}].targetValue`, 200),
      display_order: reqInt(o.displayOrder ?? i, `items[${i}].displayOrder`),
    };
  });
  const keys = items.map((it) => it.key);
  if (new Set(keys).size !== keys.length) throw new ApiError('BAD_REQUEST', 'items contain duplicate keys', 400);

  await ctx.admin.from('goal_library_items').delete()
    .eq('goal_library_id', libraryId).eq('organization_id', orgId);

  const keyToId = new Map<string, string>();
  const kras = items.filter((it) => it.itemType === 'kra');
  const kpis = items.filter((it) => it.itemType === 'kpi');
  for (const it of kras) {
    const { data, error } = await ctx.admin.from('goal_library_items').insert({
      organization_id: orgId, goal_library_id: libraryId, item_type: 'kra',
      title: it.title, description: it.description, perspective: it.perspective,
      weight: it.weight, target_type_key: it.target_type_key, target_value: it.target_value,
      display_order: it.display_order,
    }).select('id').single();
    if (error) { console.error('library items kra', error); throw new ApiError('DB_ERROR', 'Database error', 500); }
    keyToId.set(it.key, data.id);
  }
  for (const it of kpis) {
    const parentId = it.parentKey ? keyToId.get(it.parentKey) : null;
    if (it.parentKey && !parentId) {
      throw new ApiError('BAD_REQUEST', `items: kpi "${it.key}" references unknown parentKey "${it.parentKey}"`, 400);
    }
    const { error } = await ctx.admin.from('goal_library_items').insert({
      organization_id: orgId, goal_library_id: libraryId, item_type: 'kpi', parent_item_id: parentId,
      title: it.title, description: it.description, perspective: it.perspective,
      weight: it.weight, target_type_key: it.target_type_key, target_value: it.target_value,
      display_order: it.display_order,
    });
    if (error) { console.error('library items kpi', error); throw new ApiError('DB_ERROR', 'Database error', 500); }
  }
  return items.length;
}

export const libraryHandlers: Record<string, Handler> = {
  'library.save': async (payload, ctx) => {
    const orgId = reqUuid(payload.orgId, 'orgId');
    ctx.requireOrgRole(orgId, ['hr_admin']);
    const name = reqString(payload.name, 'name', 200);
    const description = optString(payload.description, 'description', 2000);
    const libraryId = optUuid(payload.libraryId, 'libraryId');
    let library: Record<string, unknown>;
    if (libraryId) {
      const expectedVersion = reqInt(payload.expectedVersion, 'expectedVersion');
      library = await ctx.versionedUpdate('goal_libraries', orgId, libraryId, expectedVersion, { name, description });
    } else {
      const { data, error } = await ctx.admin.from('goal_libraries')
        .insert({ organization_id: orgId, name, description }).select().single();
      if (error) {
        if (error.code === '23505') throw new ApiError('LIBRARY_NAME_TAKEN', 'A library with this name already exists', 409);
        console.error('library.save insert', error);
        throw new ApiError('DB_ERROR', 'Database error', 500);
      }
      library = data;
    }
    const count = await replaceLibraryItems(ctx, orgId, library.id as string, payload.items ?? []);
    await ctx.audit({
      organizationId: orgId, action: 'library.save',
      entityType: 'goal_library', entityId: library.id as string, note: `${count} item(s)`,
    });
    return { library, items: count };
  },

  'library.list': async (payload, ctx) => {
    const orgId = reqUuid(payload.orgId, 'orgId');
    ctx.requireOrgRole(orgId, ['hr_admin']);
    const { data, error } = await ctx.admin.from('goal_libraries')
      .select().eq('organization_id', orgId).order('name');
    if (error) { console.error('library.list', error); throw new ApiError('DB_ERROR', 'Database error', 500); }
    return { libraries: data ?? [] };
  },

  'library.archive': async (payload, ctx) => {
    const orgId = reqUuid(payload.orgId, 'orgId');
    ctx.requireOrgRole(orgId, ['hr_admin']);
    const libraryId = reqUuid(payload.libraryId, 'libraryId');
    const expectedVersion = reqInt(payload.expectedVersion, 'expectedVersion');
    const library = await ctx.versionedUpdate('goal_libraries', orgId, libraryId, expectedVersion, { status: 'archived' });
    await ctx.audit({
      organizationId: orgId, action: 'library.archive',
      entityType: 'goal_library', entityId: libraryId, after: { status: 'archived' },
    });
    return { library };
  },

  'prefill.save': async (payload, ctx) => {
    const orgId = reqUuid(payload.orgId, 'orgId');
    ctx.requireOrgRole(orgId, ['hr_admin']);
    const name = reqString(payload.name, 'name', 200);
    const description = optString(payload.description, 'description', 2000);
    const datasetId = optUuid(payload.datasetId, 'datasetId');
    let dataset: Record<string, unknown>;
    if (datasetId) {
      const expectedVersion = reqInt(payload.expectedVersion, 'expectedVersion');
      dataset = await ctx.versionedUpdate('prefill_datasets', orgId, datasetId, expectedVersion, { name, description });
    } else {
      const { data, error } = await ctx.admin.from('prefill_datasets')
        .insert({ organization_id: orgId, name, description }).select().single();
      if (error) {
        if (error.code === '23505') throw new ApiError('PREFILL_NAME_TAKEN', 'A prefill dataset with this name already exists', 409);
        console.error('prefill.save insert', error);
        throw new ApiError('DB_ERROR', 'Database error', 500);
      }
      dataset = data;
    }
    const rows = reqArray(payload.items ?? [], 'items', 2000).map((r, i) => {
      const o = reqObject(r, `items[${i}]`);
      return {
        organization_id: orgId, prefill_dataset_id: dataset.id,
        employee_code: reqString(o.employeeCode, `items[${i}].employeeCode`, 60),
        kra_title: reqString(o.kraTitle, `items[${i}].kraTitle`, 300),
        kpi_title: optString(o.kpiTitle, `items[${i}].kpiTitle`, 300),
        weight: optNumber(o.weight, `items[${i}].weight`),
        perspective: optString(o.perspective, `items[${i}].perspective`, 120),
        target_type_key: optString(o.targetTypeKey, `items[${i}].targetTypeKey`, 60),
        target_value: optString(o.targetValue, `items[${i}].targetValue`, 200),
        display_order: reqInt(o.displayOrder ?? i, `items[${i}].displayOrder`),
      };
    });
    await ctx.admin.from('prefill_dataset_items').delete()
      .eq('prefill_dataset_id', dataset.id).eq('organization_id', orgId);
    if (rows.length) {
      const { error } = await ctx.admin.from('prefill_dataset_items').insert(rows);
      if (error) { console.error('prefill items', error); throw new ApiError('DB_ERROR', 'Database error', 500); }
    }
    await ctx.audit({
      organizationId: orgId, action: 'prefill.save',
      entityType: 'prefill_dataset', entityId: dataset.id as string, note: `${rows.length} item(s)`,
    });
    return { dataset, items: rows.length };
  },

  'prefill.list': async (payload, ctx) => {
    const orgId = reqUuid(payload.orgId, 'orgId');
    ctx.requireOrgRole(orgId, ['hr_admin']);
    const { data, error } = await ctx.admin.from('prefill_datasets')
      .select().eq('organization_id', orgId).order('name');
    if (error) { console.error('prefill.list', error); throw new ApiError('DB_ERROR', 'Database error', 500); }
    return { datasets: data ?? [] };
  },
};
```

- [ ] **Step 2: Wire the router**

In `supabase/functions/pms-admin/index.ts`, add the import and spread:

```ts
import { libraryHandlers } from './libraries.ts';
```
and add `...libraryHandlers,` to the `serveActions({...})` object (alongside the existing `...organizationHandlers, ...cycleHandlers`).

- [ ] **Step 3: Deploy**

Run: `supabase functions deploy pms-admin`
Expected: `Deployed Functions on project mkjtdwrzmobahwkpumxx: pms-admin`.

- [ ] **Step 4: Append the verify section**

In `supabase/verify/admin-check.mjs`, before the final `console.log`, append:

```js
// --- goal libraries + prefill (org-level) ---
{
  const lib = await callAdmin(superT, 'library.save', {
    orgId: gamma.id, name: 'Sales Playbook', description: 'Standard sales KRAs',
    items: [
      { itemType: 'kra', key: 'k1', title: 'Revenue', perspective: 'Financial', weight: 60, displayOrder: 0 },
      { itemType: 'kpi', key: 'k1a', parentKey: 'k1', title: 'New ARR', weight: 100, displayOrder: 1 },
      { itemType: 'kra', key: 'k2', title: 'Customer Success', perspective: 'Customer', weight: 40, displayOrder: 2 },
    ],
  });
  check('library.save creates library + items', lib.status === 200 && lib.body.data.items === 3);
  const libId = lib.body.data.library.id;
  const { data: itemRows } = await admin.from('goal_library_items').select('id, item_type, parent_item_id').eq('goal_library_id', libId);
  check('library items persisted (2 kra + 1 kpi)', (itemRows ?? []).length === 3);
  const kpi = (itemRows ?? []).find((r) => r.item_type === 'kpi');
  check('kpi parent linked by payload key', kpi && kpi.parent_item_id !== null);

  const badParent = await callAdmin(superT, 'library.save', {
    orgId: gamma.id, name: 'Broken', items: [{ itemType: 'kpi', key: 'x', parentKey: 'nope', title: 'Orphan' }],
  });
  check('kpi with unknown parentKey rejected', badParent.status === 400);

  const listed = await callAdmin(superT, 'library.list', { orgId: gamma.id });
  check('library.list returns the saved library', listed.status === 200 && (listed.body.data.libraries ?? []).some((l) => l.id === libId));

  const arch = await callAdmin(superT, 'library.archive', {
    orgId: gamma.id, libraryId: libId, expectedVersion: lib.body.data.library.version,
  });
  check('library.archive sets status archived', arch.status === 200 && arch.body.data.library.status === 'archived');

  const pf = await callAdmin(superT, 'prefill.save', {
    orgId: gamma.id, name: 'Q1 Prefill',
    items: [{ employeeCode: 'GAMMA001', kraTitle: 'Onboarding', kpiTitle: 'Time to value', weight: 100, displayOrder: 0 }],
  });
  check('prefill.save creates dataset + items', pf.status === 200 && pf.body.data.items === 1);
  const empDenied = await callAdmin(empT, 'library.list', { orgId: gamma.id });
  check('employee cannot list libraries', empDenied.status === 403);
}
```

- [ ] **Step 5: Run the verify**

Run: `node supabase/verify/seed-foundation.mjs && node supabase/verify/admin-check.mjs`
Expected: prior 39 + 8 new = `admin-check: PASS (47 assertions)`, exit 0. (Counts are brittle — trust the printed `n`; if it differs, recount the `check()` calls you added before assuming a failure.)

- [ ] **Step 6: Commit**

```bash
git add supabase/functions/pms-admin/libraries.ts supabase/functions/pms-admin/index.ts supabase/verify/admin-check.mjs
git commit -m "feat(admin-backend): goal library and prefill dataset CRUD actions"
```

---

### Task 2: Roster import — validate & preview

**Files:**
- Create: `supabase/functions/pms-admin/imports.ts`
- Modify: `supabase/functions/pms-admin/index.ts` (spread `importHandlers`)
- Modify: `supabase/verify/admin-check.mjs` (append an "import validate" section)

**Interfaces:**
- Consumes: kernel + validators.
- Produces actions: `import.validate-roster` `{orgId, cycleId?, rows}` → `{importRun, errors, validCount, errorCount}`; `import.get-preview` `{orgId, importRunId}` → `{importRun, errors}`; `import.discard` `{orgId, importRunId, expectedVersion}` → `{importRun}`. Validation is pure (no writes to `employees`); it records an `import_runs` row (status `preview_ready` or `failed`) plus `import_run_errors`. Canonical row shape and validation rules (below) are the contract Task 3's commit RPC also enforces. Exports `CANONICAL_COLUMNS` and `validateRosterRows(rows)` → `{ clean: NormalizedRow[], errors: RowError[] }` reused by Task 3.

- [ ] **Step 1: Write the imports module**

`supabase/functions/pms-admin/imports.ts`:

```ts
import { ApiError, Handler, HandlerCtx } from '../_shared/kernel.ts';
import { reqArray, reqInt, reqObject, reqUuid } from '../_shared/validate.ts';

export const CANONICAL_COLUMNS = [
  'employeeCode', 'fullName', 'email', 'designation', 'department', 'grade',
  'groupName', 'managerCode', 'l2Code', 'hodCode',
];

export type NormalizedRow = {
  employee_code: string; full_name: string; email: string | null;
  designation: string | null; department: string | null; grade: string | null;
  group_name: string; manager_code: string | null; l2_code: string | null; hod_code: string | null;
};
export type RowError = { row_number: number; column_name: string | null; error: string; row_data: unknown };

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function cell(o: Record<string, unknown>, k: string): string | null {
  const v = o[k];
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}

// Pure validation: shape, required fields, per-org uniqueness within the batch,
// and reference resolvability (manager/l2/hod codes must appear as a row's
// employeeCode in the same batch). Roster-only groupName='NONE' is allowed and
// excluded from PMS participation downstream — never surfaced as "Outside PMS".
export function validateRosterRows(rows: unknown): { clean: NormalizedRow[]; errors: RowError[] } {
  const arr = reqArray(rows, 'rows', 5000);
  const clean: NormalizedRow[] = [];
  const errors: RowError[] = [];
  const seenCodes = new Set<string>();
  const seenEmails = new Set<string>();
  const allCodes = new Set<string>();

  arr.forEach((r) => {
    const o = (r && typeof r === 'object' && !Array.isArray(r)) ? r as Record<string, unknown> : {};
    const code = cell(o, 'employeeCode');
    if (code) allCodes.add(code);
  });

  arr.forEach((r, idx) => {
    const rowNum = idx + 1;
    if (!r || typeof r !== 'object' || Array.isArray(r)) {
      errors.push({ row_number: rowNum, column_name: null, error: 'row is not an object', row_data: r });
      return;
    }
    const o = r as Record<string, unknown>;
    const code = cell(o, 'employeeCode');
    const name = cell(o, 'fullName');
    const email = cell(o, 'email');
    const group = cell(o, 'groupName');
    const rowErrs: RowError[] = [];
    if (!code) rowErrs.push({ row_number: rowNum, column_name: 'employeeCode', error: 'required', row_data: o });
    if (!name) rowErrs.push({ row_number: rowNum, column_name: 'fullName', error: 'required', row_data: o });
    if (!group) rowErrs.push({ row_number: rowNum, column_name: 'groupName', error: 'required (use "NONE" for roster-only)', row_data: o });
    if (email && !EMAIL_RE.test(email)) rowErrs.push({ row_number: rowNum, column_name: 'email', error: 'not a valid email', row_data: o });
    if (group !== 'NONE' && !email) rowErrs.push({ row_number: rowNum, column_name: 'email', error: 'required for PMS participants (groupName != NONE)', row_data: o });
    if (code && seenCodes.has(code)) rowErrs.push({ row_number: rowNum, column_name: 'employeeCode', error: 'duplicate employeeCode in file', row_data: o });
    if (email && seenEmails.has(email.toLowerCase())) rowErrs.push({ row_number: rowNum, column_name: 'email', error: 'duplicate email in file', row_data: o });
    for (const refCol of ['managerCode', 'l2Code', 'hodCode']) {
      const ref = cell(o, refCol);
      if (ref) {
        if (ref === code) rowErrs.push({ row_number: rowNum, column_name: refCol, error: 'cannot reference self', row_data: o });
        else if (!allCodes.has(ref)) rowErrs.push({ row_number: rowNum, column_name: refCol, error: `"${ref}" is not an employeeCode in this file`, row_data: o });
      }
    }
    if (rowErrs.length) { errors.push(...rowErrs); return; }
    if (code) seenCodes.add(code);
    if (email) seenEmails.add(email.toLowerCase());
    clean.push({
      employee_code: code!, full_name: name!, email,
      designation: cell(o, 'designation'), department: cell(o, 'department'), grade: cell(o, 'grade'),
      group_name: group!, manager_code: cell(o, 'managerCode'),
      l2_code: cell(o, 'l2Code'), hod_code: cell(o, 'hodCode'),
    });
  });
  return { clean, errors };
}

export const importHandlers: Record<string, Handler> = {
  'import.validate-roster': async (payload, ctx) => {
    const orgId = reqUuid(payload.orgId, 'orgId');
    ctx.requireOrgRole(orgId, ['hr_admin']);
    const cycleId = payload.cycleId ? reqUuid(payload.cycleId, 'cycleId') : null;
    const rows = reqArray(payload.rows, 'rows', 5000);
    const { clean, errors } = validateRosterRows(rows);
    const status = errors.length ? 'failed' : 'preview_ready';
    const { data: run, error } = await ctx.admin.from('import_runs').insert({
      organization_id: orgId, cycle_id: cycleId, kind: 'roster', status,
      total_rows: rows.length, valid_rows: clean.length, error_rows: errors.length,
      created_by: ctx.userId,
    }).select().single();
    if (error) { console.error('import run insert', error); throw new ApiError('DB_ERROR', 'Database error', 500); }
    if (errors.length) {
      const errRows = errors.slice(0, 2000).map((e) => ({ import_run_id: run.id, ...e }));
      const { error: eErr } = await ctx.admin.from('import_run_errors').insert(errRows);
      if (eErr) { console.error('import errors insert', eErr); throw new ApiError('DB_ERROR', 'Database error', 500); }
    }
    await ctx.audit({
      organizationId: orgId, cycleId, action: 'import.validate-roster',
      entityType: 'import_run', entityId: run.id, note: `${clean.length} valid / ${errors.length} error`,
    });
    return { importRun: run, errors: errors.slice(0, 2000), validCount: clean.length, errorCount: errors.length };
  },

  'import.get-preview': async (payload, ctx) => {
    const orgId = reqUuid(payload.orgId, 'orgId');
    ctx.requireOrgRole(orgId, ['hr_admin']);
    const importRunId = reqUuid(payload.importRunId, 'importRunId');
    const { data: run, error } = await ctx.admin.from('import_runs')
      .select().eq('id', importRunId).eq('organization_id', orgId).maybeSingle();
    if (error) { console.error('import preview read', error); throw new ApiError('DB_ERROR', 'Database error', 500); }
    if (!run) throw new ApiError('NOT_FOUND', 'Import run not found', 404);
    const { data: errs } = await ctx.admin.from('import_run_errors')
      .select().eq('import_run_id', importRunId).order('row_number');
    return { importRun: run, errors: errs ?? [] };
  },

  'import.discard': async (payload, ctx) => {
    const orgId = reqUuid(payload.orgId, 'orgId');
    ctx.requireOrgRole(orgId, ['hr_admin']);
    const importRunId = reqUuid(payload.importRunId, 'importRunId');
    const expectedVersion = reqInt(payload.expectedVersion, 'expectedVersion');
    const run = await ctx.versionedUpdate('import_runs', orgId, importRunId, expectedVersion, { status: 'discarded' });
    await ctx.audit({
      organizationId: orgId, action: 'import.discard',
      entityType: 'import_run', entityId: importRunId, after: { status: 'discarded' },
    });
    return { importRun: run };
  },
};
```

- [ ] **Step 2: Wire the router**

In `supabase/functions/pms-admin/index.ts`, add `import { importHandlers } from './imports.ts';` and `...importHandlers,` to `serveActions`.

- [ ] **Step 3: Deploy**

Run: `supabase functions deploy pms-admin`
Expected: deployed.

- [ ] **Step 4: Append the verify section**

In `supabase/verify/admin-check.mjs`, before the final `console.log`, append:

```js
// --- roster import: validate & preview ---
let goodRun;
{
  const bad = await callAdmin(superT, 'import.validate-roster', {
    orgId: gamma.id, rows: [
      { employeeCode: 'G1', fullName: 'Ann', email: 'ann@x.com', groupName: 'Sales', managerCode: 'GHOST' },
      { employeeCode: 'G1', fullName: 'Dup', email: 'bad-email', groupName: '' },
    ],
  });
  check('validate flags bad rows', bad.status === 200 && bad.body.data.errorCount >= 3 && bad.body.data.importRun.status === 'failed');

  const good = await callAdmin(superT, 'import.validate-roster', {
    orgId: gamma.id, rows: [
      { employeeCode: 'G100', fullName: 'Boss Bea', email: 'bea@x.com', groupName: 'Leadership', department: 'Exec' },
      { employeeCode: 'G101', fullName: 'Rep Rita', email: 'rita@x.com', groupName: 'Sales', department: 'Sales', managerCode: 'G100', hodCode: 'G100' },
      { employeeCode: 'G102', fullName: 'Ext Ed', email: 'ed@x.com', groupName: 'NONE', designation: 'Advisor' },
    ],
  });
  check('validate accepts a clean roster', good.status === 200 && good.body.data.errorCount === 0 && good.body.data.validCount === 3);
  check('clean run is preview_ready', good.body.data.importRun.status === 'preview_ready');
  goodRun = good.body.data.importRun;

  const preview = await callAdmin(superT, 'import.get-preview', { orgId: gamma.id, importRunId: goodRun.id });
  check('get-preview returns the run', preview.status === 200 && preview.body.data.importRun.id === goodRun.id);
}
```

- [ ] **Step 5: Run the verify**

Run: `node supabase/verify/seed-foundation.mjs && node supabase/verify/admin-check.mjs`
Expected: prior 47 + 4 new = `admin-check: PASS (51 assertions)`, exit 0.

- [ ] **Step 6: Commit**

```bash
git add supabase/functions/pms-admin/imports.ts supabase/functions/pms-admin/index.ts supabase/verify/admin-check.mjs
git commit -m "feat(admin-backend): roster import validation and preview"
```

---

### Task 3: Roster import — atomic commit RPC

**Files:**
- Create: `supabase/migrations/2026070620_pms_commit_roster_rpc.sql`
- Modify: `supabase/functions/pms-admin/imports.ts` (add `import.commit-roster` handler)
- Modify: `supabase/verify/admin-check.mjs` (append a "commit" section)
- Modify: `supabase/verify/rls-check.mjs` (append a 42501 denial assertion for the new RPC)

**Interfaces:**
- Consumes: Task 2's `validateRosterRows`; kernel; the `import_runs` row from validate.
- Produces: RPC `pms.commit_roster_import_tx(p_org uuid, p_import_run uuid, p_actor uuid, p_rows jsonb)` returning `jsonb` `{ inserted, updated, relationships }` — upserts `employees` by `(organization_id, employee_code)`, then resolves manager/l2/hod codes to employee ids and upserts `reporting_relationships`, marks the run `committed`, audits, all atomically; handler `import.commit-roster` `{orgId, importRunId, rows}` → `{result}`. The RPC is revoked from public/anon/authenticated.

- [ ] **Step 1: Add the 42501 denial assertion (failing first)**

In `supabase/verify/rls-check.mjs`, inside the existing "creation RPCs are backend-only" block (right after the `create_cycle_draft_tx` employee check), add:

```js
  const { error: rosterRpcErr } = await eveC.rpc('commit_roster_import_tx', {
    p_org: org.id, p_import_run: '00000000-0000-0000-0000-000000000000',
    p_actor: '00000000-0000-0000-0000-000000000000', p_rows: [],
  });
  check('authenticated user cannot call commit_roster_import_tx', rosterRpcErr?.code === '42501');
```

Run: `node supabase/verify/seed-foundation.mjs && node supabase/verify/rls-check.mjs`
Expected: FAIL on this new assertion (RPC doesn't exist yet → error code is not 42501; likely `PGRST202`/404). This proves the assertion is live before the RPC exists.

- [ ] **Step 2: Write the commit RPC migration**

`supabase/migrations/2026070620_pms_commit_roster_rpc.sql`:

```sql
-- Atomic roster commit: upsert employees, then resolve+upsert reporting rows.
-- SECURITY DEFINER + explicit revoke (SYSTEMIC LESSON: default-priv revoke does
-- not cover later-created functions). Backend-only; service_role calls it.
create or replace function pms.commit_roster_import_tx(
  p_org uuid, p_import_run uuid, p_actor uuid, p_rows jsonb
) returns jsonb
language plpgsql security definer set search_path = pms, public as $$
declare
  r jsonb;
  v_code text;
  v_ref text;
  v_rel text;
  v_emp_id uuid;
  v_ref_id uuid;
  v_inserted int := 0;
  v_updated int := 0;
  v_rels int := 0;
  v_existed boolean;
begin
  -- Pass 1: upsert every employee row.
  for r in select * from jsonb_array_elements(p_rows) loop
    v_code := r->>'employee_code';
    select exists(select 1 from pms.employees where organization_id = p_org and employee_code = v_code)
      into v_existed;
    insert into pms.employees (
      organization_id, employee_code, full_name, email, designation, department, grade, group_name
    ) values (
      p_org, v_code, r->>'full_name', nullif(r->>'email','')::citext,
      r->>'designation', r->>'department', r->>'grade', r->>'group_name'
    )
    on conflict (organization_id, employee_code) do update set
      full_name = excluded.full_name, email = excluded.email,
      designation = excluded.designation, department = excluded.department,
      grade = excluded.grade, group_name = excluded.group_name;
    if v_existed then v_updated := v_updated + 1; else v_inserted := v_inserted + 1; end if;
  end loop;

  -- Pass 2: resolve manager/l2/hod codes to ids and upsert reporting rows.
  for r in select * from jsonb_array_elements(p_rows) loop
    v_code := r->>'employee_code';
    select id into v_emp_id from pms.employees where organization_id = p_org and employee_code = v_code;
    for v_rel, v_ref in
      select rel, r->>col from (values ('manager','manager_code'),('l2','l2_code'),('hod','hod_code')) as m(rel,col)
    loop
      if v_ref is not null and v_ref <> '' then
        select id into v_ref_id from pms.employees where organization_id = p_org and employee_code = v_ref;
        if v_ref_id is null then
          raise exception 'reporting reference % for % does not resolve', v_ref, v_code
            using errcode = 'foreign_key_violation';
        end if;
        insert into pms.reporting_relationships (organization_id, employee_id, related_employee_id, relation_type)
        values (p_org, v_emp_id, v_ref_id, v_rel)
        on conflict (organization_id, employee_id, relation_type)
          do update set related_employee_id = excluded.related_employee_id;
        v_rels := v_rels + 1;
      end if;
    end loop;
  end loop;

  update pms.import_runs
    set status = 'committed', committed_at = now()
    where id = p_import_run and organization_id = p_org;

  insert into pms.audit_logs (organization_id, actor_user_id, action, entity_type, entity_id, after)
  values (p_org, p_actor, 'import.commit-roster', 'import_run', p_import_run,
          jsonb_build_object('inserted', v_inserted, 'updated', v_updated, 'relationships', v_rels));

  return jsonb_build_object('inserted', v_inserted, 'updated', v_updated, 'relationships', v_rels);
end $$;

revoke all on function pms.commit_roster_import_tx(uuid, uuid, uuid, jsonb) from public, anon, authenticated;
```

- [ ] **Step 3: Apply the migration**

Run: `supabase db push`
Expected: `Finished supabase db push.`

- [ ] **Step 4: Add the commit handler**

In `supabase/functions/pms-admin/imports.ts`, add to `importHandlers`:

```ts
  'import.commit-roster': async (payload, ctx) => {
    const orgId = reqUuid(payload.orgId, 'orgId');
    ctx.requireOrgRole(orgId, ['hr_admin']);
    const importRunId = reqUuid(payload.importRunId, 'importRunId');
    const rows = reqArray(payload.rows, 'rows', 5000);
    // Re-validate server-side; the client's earlier preview is advisory only.
    const { clean, errors } = validateRosterRows(rows);
    if (errors.length) {
      throw new ApiError('IMPORT_INVALID', `Roster still has ${errors.length} error(s); re-validate before committing`, 400);
    }
    const { data: run, error: runErr } = await ctx.admin.from('import_runs')
      .select('status').eq('id', importRunId).eq('organization_id', orgId).maybeSingle();
    if (runErr) { console.error('commit run read', runErr); throw new ApiError('DB_ERROR', 'Database error', 500); }
    if (!run) throw new ApiError('NOT_FOUND', 'Import run not found', 404);
    if (run.status === 'committed') throw new ApiError('IMPORT_ALREADY_COMMITTED', 'This import was already committed', 409);
    const { data: result, error } = await ctx.admin.rpc('commit_roster_import_tx', {
      p_org: orgId, p_import_run: importRunId, p_actor: ctx.userId, p_rows: clean,
    });
    if (error) {
      if (error.code === '23503') throw new ApiError('BAD_REQUEST', 'A reporting reference did not resolve', 400);
      console.error('commit_roster_import_tx', error);
      throw new ApiError('DB_ERROR', 'Database error', 500);
    }
    return { result };
  },
```

- [ ] **Step 5: Deploy**

Run: `supabase functions deploy pms-admin`
Expected: deployed.

- [ ] **Step 6: Append the verify section**

In `supabase/verify/admin-check.mjs`, before the final `console.log`, append (note `goodRun` and the 3-row roster are from Task 2's section — this section reuses them):

```js
// --- roster import: commit ---
{
  const goodRows = [
    { employeeCode: 'G100', fullName: 'Boss Bea', email: 'bea@x.com', groupName: 'Leadership', department: 'Exec' },
    { employeeCode: 'G101', fullName: 'Rep Rita', email: 'rita@x.com', groupName: 'Sales', department: 'Sales', managerCode: 'G100', hodCode: 'G100' },
    { employeeCode: 'G102', fullName: 'Ext Ed', email: 'ed@x.com', groupName: 'NONE', designation: 'Advisor' },
  ];
  const commit = await callAdmin(superT, 'import.commit-roster', { orgId: gamma.id, importRunId: goodRun.id, rows: goodRows });
  check('commit-roster succeeds', commit.status === 200 && commit.body.data.result.inserted === 3);
  check('commit created reporting relationships', commit.body.data.result.relationships === 2);
  const { data: emps } = await admin.from('employees').select('employee_code, group_name').eq('organization_id', gamma.id).in('employee_code', ['G100', 'G101', 'G102']);
  check('all 3 employees persisted', (emps ?? []).length === 3);
  check('roster-only employee kept group NONE', (emps ?? []).find((e) => e.employee_code === 'G102')?.group_name === 'NONE');
  const { data: rels } = await admin.from('reporting_relationships').select('relation_type').eq('organization_id', gamma.id);
  check('manager + hod relationships resolved', (rels ?? []).filter((x) => ['manager', 'hod'].includes(x.relation_type)).length >= 2);

  const recommit = await callAdmin(superT, 'import.commit-roster', { orgId: gamma.id, importRunId: goodRun.id, rows: goodRows });
  check('re-commit of same run rejected', recommit.status === 409 && recommit.body.error.code === 'IMPORT_ALREADY_COMMITTED');
}
```

- [ ] **Step 7: Run both suites**

Run: `node supabase/verify/seed-foundation.mjs && node supabase/verify/rls-check.mjs && node supabase/verify/admin-check.mjs`
Expected: `rls-check: PASS (50 assertions)` (49 + 1 new denial), `admin-check: PASS (57 assertions)` (51 + 6 new), exit 0.

- [ ] **Step 8: Commit**

```bash
git add supabase/migrations/2026070620_pms_commit_roster_rpc.sql supabase/functions/pms-admin/imports.ts supabase/verify/admin-check.mjs supabase/verify/rls-check.mjs
git commit -m "feat(admin-backend): atomic roster commit RPC (employees + reporting relationships)"
```

---

### Task 4: Cycle participants & assignments

**Files:**
- Create: `supabase/functions/pms-admin/participants.ts`
- Modify: `supabase/functions/pms-admin/index.ts` (spread `participantHandlers`)
- Modify: `supabase/verify/admin-check.mjs` (append a "participants" section)

**Interfaces:**
- Consumes: kernel + validators; `employees`, `cycle_participants`, `cycle_participant_assignments`, `cycle_groups`.
- Produces actions (editable only while cycle draft/setup, else `CYCLE_LOCKED`): `cycle.add-participants` `{orgId, cycleId, employeeCodes: string[]}` → `{added, skipped}` (adds active participants for the given codes; skips roster-only `NONE`, skips already-added, errors on unknown code); `cycle.remove-participant` `{orgId, cycleId, participantId, expectedVersion}` → `{participant}` (sets status `removed`); `cycle.assign-participant` `{orgId, cycleId, participantId, groupName?, goalLibraryName?, prefillDatasetName?}` → `{assignment}` (resolves names to ids in this cycle/org, upserts the assignment row); `cycle.list-participants` `{orgId, cycleId}` → `{participants}`.

- [ ] **Step 1: Write the participants module**

`supabase/functions/pms-admin/participants.ts`:

```ts
import { ApiError, Handler, HandlerCtx } from '../_shared/kernel.ts';
import { optString, reqArray, reqInt, reqString, reqUuid } from '../_shared/validate.ts';

const EDITABLE = ['draft', 'setup'];

async function loadEditableCycle(ctx: HandlerCtx, orgId: string, cycleId: string) {
  const { data: cycle, error } = await ctx.admin.from('appraisal_cycles')
    .select().eq('id', cycleId).eq('organization_id', orgId).maybeSingle();
  if (error) { console.error('loadCycle', error); throw new ApiError('DB_ERROR', 'Database error', 500); }
  if (!cycle) throw new ApiError('NOT_FOUND', 'Cycle not found', 404);
  if (!EDITABLE.includes(cycle.status)) {
    throw new ApiError('CYCLE_LOCKED', `Participants can't be changed once a cycle is ${cycle.status}`, 409);
  }
  return cycle;
}

export const participantHandlers: Record<string, Handler> = {
  'cycle.add-participants': async (payload, ctx) => {
    const orgId = reqUuid(payload.orgId, 'orgId');
    ctx.requireOrgRole(orgId, ['hr_admin']);
    const cycleId = reqUuid(payload.cycleId, 'cycleId');
    await loadEditableCycle(ctx, orgId, cycleId);
    const codes = reqArray(payload.employeeCodes, 'employeeCodes', 5000)
      .map((c, i) => reqString(c, `employeeCodes[${i}]`, 60));
    const { data: emps, error } = await ctx.admin.from('employees')
      .select('id, employee_code, group_name').eq('organization_id', orgId).in('employee_code', codes);
    if (error) { console.error('add-participants emps', error); throw new ApiError('DB_ERROR', 'Database error', 500); }
    const byCode = new Map((emps ?? []).map((e) => [e.employee_code, e]));
    const unknown = codes.filter((c) => !byCode.has(c));
    if (unknown.length) throw new ApiError('BAD_REQUEST', `unknown employee code(s): ${unknown.slice(0, 10).join(', ')}`, 400);
    const { data: existing } = await ctx.admin.from('cycle_participants')
      .select('employee_id').eq('cycle_id', cycleId);
    const already = new Set((existing ?? []).map((p) => p.employee_id));
    const skipped: string[] = [];
    const toInsert: Record<string, unknown>[] = [];
    for (const code of codes) {
      const e = byCode.get(code)!;
      if (e.group_name === 'NONE') { skipped.push(`${code} (roster-only)`); continue; }
      if (already.has(e.id)) { skipped.push(`${code} (already added)`); continue; }
      toInsert.push({ organization_id: orgId, cycle_id: cycleId, employee_id: e.id });
    }
    let added = 0;
    if (toInsert.length) {
      const { error: insErr, count } = await ctx.admin.from('cycle_participants')
        .insert(toInsert, { count: 'exact' });
      if (insErr) { console.error('add-participants insert', insErr); throw new ApiError('DB_ERROR', 'Database error', 500); }
      added = count ?? toInsert.length;
    }
    await ctx.audit({
      organizationId: orgId, cycleId, action: 'cycle.add-participants',
      entityType: 'cycle_participants', note: `added ${added}, skipped ${skipped.length}`,
    });
    return { added, skipped };
  },

  'cycle.remove-participant': async (payload, ctx) => {
    const orgId = reqUuid(payload.orgId, 'orgId');
    ctx.requireOrgRole(orgId, ['hr_admin']);
    const cycleId = reqUuid(payload.cycleId, 'cycleId');
    await loadEditableCycle(ctx, orgId, cycleId);
    const participantId = reqUuid(payload.participantId, 'participantId');
    const expectedVersion = reqInt(payload.expectedVersion, 'expectedVersion');
    const participant = await ctx.versionedUpdate('cycle_participants', orgId, participantId, expectedVersion, { status: 'removed' });
    await ctx.audit({
      organizationId: orgId, cycleId, action: 'cycle.remove-participant',
      entityType: 'cycle_participant', entityId: participantId, after: { status: 'removed' },
    });
    return { participant };
  },

  'cycle.assign-participant': async (payload, ctx) => {
    const orgId = reqUuid(payload.orgId, 'orgId');
    ctx.requireOrgRole(orgId, ['hr_admin']);
    const cycleId = reqUuid(payload.cycleId, 'cycleId');
    await loadEditableCycle(ctx, orgId, cycleId);
    const participantId = reqUuid(payload.participantId, 'participantId');
    const groupName = optString(payload.groupName, 'groupName', 120);
    const goalLibraryName = optString(payload.goalLibraryName, 'goalLibraryName', 200);
    const prefillDatasetName = optString(payload.prefillDatasetName, 'prefillDatasetName', 200);

    const { data: participant, error: pErr } = await ctx.admin.from('cycle_participants')
      .select('id, employee_id').eq('id', participantId).eq('cycle_id', cycleId).eq('organization_id', orgId).maybeSingle();
    if (pErr) { console.error('assign read participant', pErr); throw new ApiError('DB_ERROR', 'Database error', 500); }
    if (!participant) throw new ApiError('NOT_FOUND', 'Participant not found', 404);

    let groupId: string | null = null;
    if (groupName) {
      const { data: g } = await ctx.admin.from('cycle_groups')
        .select('id').eq('cycle_id', cycleId).eq('name', groupName).maybeSingle();
      if (!g) throw new ApiError('BAD_REQUEST', `group "${groupName}" is not a group in this cycle`, 400);
      groupId = g.id;
    }
    let goalLibraryId: string | null = null;
    if (goalLibraryName) {
      const { data: l } = await ctx.admin.from('goal_libraries')
        .select('id').eq('organization_id', orgId).eq('name', goalLibraryName).maybeSingle();
      if (!l) throw new ApiError('BAD_REQUEST', `goal library "${goalLibraryName}" not found`, 400);
      goalLibraryId = l.id;
    }
    let prefillDatasetId: string | null = null;
    if (prefillDatasetName) {
      const { data: d } = await ctx.admin.from('prefill_datasets')
        .select('id').eq('organization_id', orgId).eq('name', prefillDatasetName).maybeSingle();
      if (!d) throw new ApiError('BAD_REQUEST', `prefill dataset "${prefillDatasetName}" not found`, 400);
      prefillDatasetId = d.id;
    }
    const { data: assignment, error } = await ctx.admin.from('cycle_participant_assignments')
      .upsert({
        organization_id: orgId, cycle_id: cycleId, participant_id: participantId,
        employee_id: participant.employee_id, group_id: groupId,
        goal_library_id: goalLibraryId, prefill_dataset_id: prefillDatasetId,
      }, { onConflict: 'participant_id' }).select().single();
    if (error) { console.error('assign upsert', error); throw new ApiError('DB_ERROR', 'Database error', 500); }
    await ctx.audit({
      organizationId: orgId, cycleId, action: 'cycle.assign-participant',
      entityType: 'cycle_participant_assignment', entityId: assignment.id,
      after: { group_id: groupId, goal_library_id: goalLibraryId, prefill_dataset_id: prefillDatasetId },
    });
    return { assignment };
  },

  'cycle.list-participants': async (payload, ctx) => {
    const orgId = reqUuid(payload.orgId, 'orgId');
    ctx.requireOrgRole(orgId, ['hr_admin']);
    const cycleId = reqUuid(payload.cycleId, 'cycleId');
    const { data, error } = await ctx.admin.from('cycle_participants')
      .select('id, employee_id, status, version, employees(employee_code, full_name, email, group_name)')
      .eq('cycle_id', cycleId).eq('organization_id', orgId);
    if (error) { console.error('list-participants', error); throw new ApiError('DB_ERROR', 'Database error', 500); }
    return { participants: data ?? [] };
  },
};
```

- [ ] **Step 2: Wire the router**

In `supabase/functions/pms-admin/index.ts`, add `import { participantHandlers } from './participants.ts';` and `...participantHandlers,`.

- [ ] **Step 3: Deploy**

Run: `supabase functions deploy pms-admin`
Expected: deployed.

- [ ] **Step 4: Append the verify section**

In `supabase/verify/admin-check.mjs`, before the final `console.log`, append (this reuses `cycle` from the Task-6-of-2a "cycle.create-draft" section — which is archived by that section's lock-stage tests. So create a FRESH draft cycle here for participant tests, since gamma can hold only one working cycle and the earlier one was archived):

```js
// --- participants & assignments (fresh draft cycle; gamma's earlier one is archived) ---
{
  const created = await callAdmin(superT, 'cycle.create-draft', {
    orgId: gamma.id, name: 'FY28 Participation Cycle', frameworkId: 'kra-kpi',
  });
  check('fresh draft cycle for participants', created.status === 200);
  const pcycle = created.body.data.cycle;
  // Need a group to assign to.
  await callAdmin(superT, 'cycle.save-section', {
    orgId: gamma.id, cycleId: pcycle.id, cycleVersion: pcycle.version, section: 'groups',
    rows: [{ name: 'Sales', targetLevel: 'kpi', ratingLevel: 'kpi' }],
  });

  const add = await callAdmin(superT, 'cycle.add-participants', {
    orgId: gamma.id, cycleId: pcycle.id, employeeCodes: ['G100', 'G101', 'G102'],
  });
  check('add-participants adds PMS employees, skips roster-only', add.status === 200 && add.body.data.added === 2 && add.body.data.skipped.some((s) => s.includes('G102')));

  const unknown = await callAdmin(superT, 'cycle.add-participants', {
    orgId: gamma.id, cycleId: pcycle.id, employeeCodes: ['NOPE'],
  });
  check('add-participants rejects unknown code', unknown.status === 400);

  const list = await callAdmin(superT, 'cycle.list-participants', { orgId: gamma.id, cycleId: pcycle.id });
  check('list-participants returns 2 rows', list.status === 200 && (list.body.data.participants ?? []).length === 2);
  const rita = list.body.data.participants.find((p) => p.employees.employee_code === 'G101');

  const assign = await callAdmin(superT, 'cycle.assign-participant', {
    orgId: gamma.id, cycleId: pcycle.id, participantId: rita.id, groupName: 'Sales', goalLibraryName: 'Sales Playbook',
  });
  check('assign-participant resolves group + library', assign.status === 200 && assign.body.data.assignment.group_id !== null);

  const badGroup = await callAdmin(superT, 'cycle.assign-participant', {
    orgId: gamma.id, cycleId: pcycle.id, participantId: rita.id, groupName: 'Ghost Group',
  });
  check('assign-participant rejects unknown group', badGroup.status === 400);

  const remove = await callAdmin(superT, 'cycle.remove-participant', {
    orgId: gamma.id, cycleId: pcycle.id, participantId: rita.id, expectedVersion: rita.version,
  });
  check('remove-participant sets status removed', remove.status === 200 && remove.body.data.participant.status === 'removed');

  // stash pcycle id for Task 5/6 by re-reading in those sections via admin
}
```

- [ ] **Step 5: Run the verify**

Run: `node supabase/verify/seed-foundation.mjs && node supabase/verify/admin-check.mjs`
Expected: prior 57 + 7 new = `admin-check: PASS (64 assertions)`, exit 0.

- [ ] **Step 6: Commit**

```bash
git add supabase/functions/pms-admin/participants.ts supabase/functions/pms-admin/index.ts supabase/verify/admin-check.mjs
git commit -m "feat(admin-backend): cycle participants and per-participant assignments"
```

---

### Task 5: Invites (Supabase-Auth users + queued email jobs)

**Files:**
- Create: `supabase/migrations/2026070621_pms_link_member_rpc.sql`
- Create: `supabase/functions/pms-admin/invites.ts`
- Modify: `supabase/functions/pms-admin/index.ts` (spread `inviteHandlers`)
- Modify: `supabase/verify/admin-check.mjs` (append an "invites" section)
- Modify: `supabase/verify/rls-check.mjs` (append a 42501 denial assertion for the new RPC)

**Interfaces:**
- Consumes: kernel; GoTrue admin API via `ctx.admin.auth.admin`; `employees`, `org_members`, `email_jobs`.
- Produces: RPC `pms.link_invited_member_tx(p_org uuid, p_user uuid, p_employee uuid, p_email text, p_link text, p_actor uuid)` returning `jsonb` `{ member_id, email_job_id }` — upserts `org_members` (roles `['employee']`, status `invited`), sets `employees.user_id`, inserts an `email_jobs` row (template `invite`, status `queued`, payload `{ actionLink: p_link }`), audits, atomically; revoked from public/anon/authenticated. Handler `cycle.invite-participants` `{orgId, cycleId}` → `{invited, alreadyLinked, skipped}` — invites every active participant employee (non-`NONE`, no `user_id`) by find-or-creating a GoTrue user, generating a recovery link, and calling the RPC per employee.

- [ ] **Step 1: Add the 42501 denial assertion (failing first)**

In `supabase/verify/rls-check.mjs`, inside the "creation RPCs are backend-only" block, add:

```js
  const { error: linkRpcErr } = await eveC.rpc('link_invited_member_tx', {
    p_org: org.id, p_user: '00000000-0000-0000-0000-000000000000',
    p_employee: '00000000-0000-0000-0000-000000000000', p_email: 'x@x.com', p_link: 'x', p_actor: '00000000-0000-0000-0000-000000000000',
  });
  check('authenticated user cannot call link_invited_member_tx', linkRpcErr?.code === '42501');
```

Run: `node supabase/verify/seed-foundation.mjs && node supabase/verify/rls-check.mjs`
Expected: FAIL on this assertion (RPC absent).

- [ ] **Step 2: Write the link RPC migration**

`supabase/migrations/2026070621_pms_link_member_rpc.sql`:

```sql
-- Atomically link an invited auth user to their org membership + employee row,
-- and queue the invite email. GoTrue user creation happens in the edge handler
-- (not transactional with PG); this RPC makes the PG side atomic.
create or replace function pms.link_invited_member_tx(
  p_org uuid, p_user uuid, p_employee uuid, p_email text, p_link text, p_actor uuid
) returns jsonb
language plpgsql security definer set search_path = pms, public as $$
declare v_member_id uuid; v_job_id uuid;
begin
  insert into pms.org_members (organization_id, user_id, roles, status)
  values (p_org, p_user, array['employee']::text[], 'invited')
  on conflict (organization_id, user_id) do update set status = 'invited'
  returning id into v_member_id;

  update pms.employees set user_id = p_user where id = p_employee and organization_id = p_org;

  insert into pms.email_jobs (organization_id, template_key, recipient_email, recipient_member_id, subject, payload, status)
  values (p_org, 'invite', p_email::citext, v_member_id, 'You have been invited to the appraisal system',
          jsonb_build_object('actionLink', p_link), 'queued')
  returning id into v_job_id;

  insert into pms.audit_logs (organization_id, actor_user_id, action, entity_type, entity_id, after)
  values (p_org, p_actor, 'cycle.invite-member', 'org_member', v_member_id,
          jsonb_build_object('email', p_email, 'email_job_id', v_job_id));

  return jsonb_build_object('member_id', v_member_id, 'email_job_id', v_job_id);
end $$;

revoke all on function pms.link_invited_member_tx(uuid, uuid, uuid, text, text, uuid) from public, anon, authenticated;
```

- [ ] **Step 3: Apply the migration**

Run: `supabase db push`
Expected: `Finished supabase db push.`

- [ ] **Step 4: Write the invites module**

`supabase/functions/pms-admin/invites.ts`:

```ts
import { ApiError, Handler } from '../_shared/kernel.ts';
import { reqUuid } from '../_shared/validate.ts';

// Find an existing GoTrue user by email, else create one. Random password +
// email_confirm so GoTrue sends nothing; our own email_jobs carry the invite.
async function findOrCreateUser(admin: any, email: string): Promise<string> {
  // listUsers is paginated; for the TEST scale a single large page is fine.
  const { data: list, error: listErr } = await admin.auth.admin.listUsers({ perPage: 1000 });
  if (listErr) { console.error('listUsers', listErr); throw new ApiError('DB_ERROR', 'Auth lookup failed', 500); }
  const found = list.users.find((u: { email?: string }) => u.email?.toLowerCase() === email.toLowerCase());
  if (found) return found.id;
  const pw = `Inv!${crypto.randomUUID()}`;
  const { data, error } = await admin.auth.admin.createUser({ email, password: pw, email_confirm: true });
  if (error) { console.error('createUser', error); throw new ApiError('DB_ERROR', 'Could not create the invited user', 500); }
  return data.user.id;
}

async function recoveryLink(admin: any, email: string): Promise<string> {
  const { data, error } = await admin.auth.admin.generateLink({ type: 'recovery', email });
  if (error) { console.error('generateLink', error); return ''; }
  return data?.properties?.action_link ?? '';
}

export const inviteHandlers: Record<string, Handler> = {
  'cycle.invite-participants': async (payload, ctx) => {
    const orgId = reqUuid(payload.orgId, 'orgId');
    ctx.requireOrgRole(orgId, ['hr_admin']);
    const cycleId = reqUuid(payload.cycleId, 'cycleId');
    // Active participants whose employee is non-NONE and not yet linked to a user.
    const { data: parts, error } = await ctx.admin.from('cycle_participants')
      .select('employee_id, employees(id, email, group_name, user_id)')
      .eq('cycle_id', cycleId).eq('organization_id', orgId).eq('status', 'active');
    if (error) { console.error('invite participants read', error); throw new ApiError('DB_ERROR', 'Database error', 500); }
    let invited = 0, alreadyLinked = 0;
    const skipped: string[] = [];
    for (const p of parts ?? []) {
      const e = p.employees as { id: string; email: string | null; group_name: string | null; user_id: string | null };
      if (!e) continue;
      if (e.group_name === 'NONE') { skipped.push('roster-only'); continue; }
      if (e.user_id) { alreadyLinked += 1; continue; }
      if (!e.email) { skipped.push('no email'); continue; }
      const userId = await findOrCreateUser(ctx.admin, e.email);
      const link = await recoveryLink(ctx.admin, e.email);
      const { error: rpcErr } = await ctx.admin.rpc('link_invited_member_tx', {
        p_org: orgId, p_user: userId, p_employee: e.id, p_email: e.email, p_link: link, p_actor: ctx.userId,
      });
      if (rpcErr) { console.error('link_invited_member_tx', rpcErr); throw new ApiError('DB_ERROR', 'Database error', 500); }
      invited += 1;
    }
    await ctx.audit({
      organizationId: orgId, cycleId, action: 'cycle.invite-participants',
      entityType: 'cycle', entityId: cycleId, note: `invited ${invited}, already ${alreadyLinked}, skipped ${skipped.length}`,
    });
    return { invited, alreadyLinked, skipped };
  },
};
```

- [ ] **Step 5: Wire the router**

In `supabase/functions/pms-admin/index.ts`, add `import { inviteHandlers } from './invites.ts';` and `...inviteHandlers,`.

- [ ] **Step 6: Deploy**

Run: `supabase functions deploy pms-admin`
Expected: deployed.

- [ ] **Step 7: Append the verify section**

In `supabase/verify/admin-check.mjs`, before the final `console.log`, append:

```js
// --- invites (uses the fresh participation cycle; re-derive it via admin) ---
{
  const { data: pcycle } = await admin.from('appraisal_cycles')
    .select('id').eq('organization_id', gamma.id).eq('name', 'FY28 Participation Cycle').single();
  // After Task 4, G100 (Bea) is still an active participant (only Rita/G101 was
  // removed). This add is a no-op if already present; it just guarantees a target.
  await callAdmin(superT, 'cycle.add-participants', { orgId: gamma.id, cycleId: pcycle.id, employeeCodes: ['G100'] });
  const inv = await callAdmin(superT, 'cycle.invite-participants', { orgId: gamma.id, cycleId: pcycle.id });
  check('invite-participants invites active PMS participants', inv.status === 200 && inv.body.data.invited >= 1);
  const { data: bea } = await admin.from('employees').select('user_id').eq('organization_id', gamma.id).eq('employee_code', 'G100').single();
  check('invited employee is now linked to a user', bea.user_id !== null);
  const { data: member } = await admin.from('org_members').select('status').eq('organization_id', gamma.id).eq('user_id', bea.user_id).single();
  check('invited member row is status invited', member.status === 'invited');
  const { data: jobs } = await admin.from('email_jobs').select('template_key, status').eq('organization_id', gamma.id).eq('template_key', 'invite');
  check('invite email job queued', (jobs ?? []).some((j) => j.status === 'queued'));
  const reinvite = await callAdmin(superT, 'cycle.invite-participants', { orgId: gamma.id, cycleId: pcycle.id });
  check('re-invite counts already-linked, no duplicate', reinvite.status === 200 && reinvite.body.data.alreadyLinked >= 1);
}
```

- [ ] **Step 8: Run both suites**

Run: `node supabase/verify/seed-foundation.mjs && node supabase/verify/rls-check.mjs && node supabase/verify/admin-check.mjs`
Expected: `rls-check: PASS (51 assertions)` (50 + 1 new denial), `admin-check: PASS (69 assertions)` (64 + 5 new), exit 0.

- [ ] **Step 9: Commit**

```bash
git add supabase/migrations/2026070621_pms_link_member_rpc.sql supabase/functions/pms-admin/invites.ts supabase/functions/pms-admin/index.ts supabase/verify/admin-check.mjs supabase/verify/rls-check.mjs
git commit -m "feat(admin-backend): participant invites (auth users + queued email jobs)"
```

---

### Task 6: Cycle activation transaction + smoke gate

**Files:**
- Create: `supabase/migrations/2026070622_pms_activate_cycle_rpc.sql`
- Create: `supabase/functions/pms-admin/activation.ts`
- Modify: `supabase/functions/pms-admin/index.ts` (spread `activationHandlers`)
- Modify: `supabase/verify/admin-check.mjs` (append an "activation" section)
- Modify: `supabase/verify/rls-check.mjs` (append a 42501 denial assertion for the new RPC)

**Interfaces:**
- Consumes: kernel; `appraisal_cycles`, `cycle_participants`, `cycle_phase_windows`, `cycle_rating_scale_levels`.
- Produces: RPC `pms.activate_cycle_tx(p_org uuid, p_cycle uuid, p_expected_version int, p_actor uuid)` returning `jsonb` `{ status, activated_at }` — verifies status ∈ draft/setup, ≥1 active participant, ≥1 phase window, ≥1 rating scale level; flips to `active`, sets `activated_at`, version-checks, audits; raises `insufficient_privilege`-free named exceptions for each unmet prerequisite (SQLSTATE mapped to app codes by the handler); revoked from public/anon/authenticated. Handler `cycle.activate` `{orgId, cycleId, expectedVersion}` → `{cycle}`.

- [ ] **Step 1: Add the 42501 denial assertion (failing first)**

In `supabase/verify/rls-check.mjs`, inside the "creation RPCs are backend-only" block, add:

```js
  const { error: activateRpcErr } = await eveC.rpc('activate_cycle_tx', {
    p_org: org.id, p_cycle: '00000000-0000-0000-0000-000000000000', p_expected_version: 1, p_actor: '00000000-0000-0000-0000-000000000000',
  });
  check('authenticated user cannot call activate_cycle_tx', activateRpcErr?.code === '42501');
```

Run: `node supabase/verify/seed-foundation.mjs && node supabase/verify/rls-check.mjs`
Expected: FAIL on this assertion (RPC absent).

- [ ] **Step 2: Write the activation RPC migration**

`supabase/migrations/2026070622_pms_activate_cycle_rpc.sql`:

```sql
-- Atomic activation: prerequisite checks + status flip. Named exceptions carry
-- distinct SQLSTATEs the handler maps to app error codes. Backend-only.
create or replace function pms.activate_cycle_tx(
  p_org uuid, p_cycle uuid, p_expected_version int, p_actor uuid
) returns jsonb
language plpgsql security definer set search_path = pms, public as $$
declare v_status text; v_version int; v_when timestamptz;
begin
  select status, version into v_status, v_version
    from pms.appraisal_cycles where id = p_cycle and organization_id = p_org;
  if v_status is null then raise exception 'cycle not found' using errcode = 'no_data_found'; end if;
  if v_status not in ('draft','setup') then
    raise exception 'cycle is % not draft/setup', v_status using errcode = 'object_not_in_prerequisite_state';
  end if;
  if v_version <> p_expected_version then
    raise exception 'version conflict' using errcode = 'serialization_failure';
  end if;
  if not exists (select 1 from pms.cycle_participants where cycle_id = p_cycle and status = 'active') then
    raise exception 'no active participants' using errcode = 'check_violation';
  end if;
  if not exists (select 1 from pms.cycle_phase_windows where cycle_id = p_cycle) then
    raise exception 'no phase windows' using errcode = 'check_violation';
  end if;
  if not exists (select 1 from pms.cycle_rating_scale_levels where cycle_id = p_cycle) then
    raise exception 'no rating scale' using errcode = 'check_violation';
  end if;

  update pms.appraisal_cycles
    set status = 'active', activated_at = now()
    where id = p_cycle and organization_id = p_org and version = p_expected_version
    returning activated_at into v_when;

  insert into pms.audit_logs (organization_id, cycle_id, actor_user_id, action, entity_type, entity_id, before, after)
  values (p_org, p_cycle, p_actor, 'cycle.activate', 'appraisal_cycle', p_cycle,
          jsonb_build_object('status', v_status), jsonb_build_object('status','active','activated_at', v_when));

  return jsonb_build_object('status', 'active', 'activated_at', v_when);
end $$;

revoke all on function pms.activate_cycle_tx(uuid, uuid, int, uuid) from public, anon, authenticated;
```

- [ ] **Step 3: Apply the migration**

Run: `supabase db push`
Expected: `Finished supabase db push.`

- [ ] **Step 4: Write the activation module**

`supabase/functions/pms-admin/activation.ts`:

```ts
import { ApiError, Handler } from '../_shared/kernel.ts';
import { reqInt, reqUuid } from '../_shared/validate.ts';

const SQLSTATE_TO_APP: Record<string, { code: string; status: number; message: string }> = {
  no_data_found: { code: 'NOT_FOUND', status: 404, message: 'Cycle not found' },
  P0002: { code: 'NOT_FOUND', status: 404, message: 'Cycle not found' },
  object_not_in_prerequisite_state: { code: 'CYCLE_LOCKED', status: 409, message: 'Only a draft or setup cycle can be activated' },
  '55000': { code: 'CYCLE_LOCKED', status: 409, message: 'Only a draft or setup cycle can be activated' },
  serialization_failure: { code: 'CONFLICT', status: 409, message: 'someone else changed this — reload' },
  '40001': { code: 'CONFLICT', status: 409, message: 'someone else changed this — reload' },
  check_violation: { code: 'ACTIVATION_PREREQ', status: 422, message: 'Cycle is missing prerequisites (participants, phase windows, or rating scale)' },
  '23514': { code: 'ACTIVATION_PREREQ', status: 422, message: 'Cycle is missing prerequisites (participants, phase windows, or rating scale)' },
};

export const activationHandlers: Record<string, Handler> = {
  'cycle.activate': async (payload, ctx) => {
    const orgId = reqUuid(payload.orgId, 'orgId');
    ctx.requireOrgRole(orgId, ['hr_admin']);
    const cycleId = reqUuid(payload.cycleId, 'cycleId');
    const expectedVersion = reqInt(payload.expectedVersion, 'expectedVersion');
    const { data, error } = await ctx.admin.rpc('activate_cycle_tx', {
      p_org: orgId, p_cycle: cycleId, p_expected_version: expectedVersion, p_actor: ctx.userId,
    });
    if (error) {
      const mapped = SQLSTATE_TO_APP[error.code ?? ''];
      if (mapped) throw new ApiError(mapped.code, mapped.message, mapped.status);
      console.error('activate_cycle_tx', error);
      throw new ApiError('DB_ERROR', 'Database error', 500);
    }
    return { cycle: data };
  },
};
```

- [ ] **Step 5: Wire the router**

In `supabase/functions/pms-admin/index.ts`, add `import { activationHandlers } from './activation.ts';` and `...activationHandlers,`.

- [ ] **Step 6: Deploy**

Run: `supabase functions deploy pms-admin`
Expected: deployed.

- [ ] **Step 7: Append the verify section**

In `supabase/verify/admin-check.mjs`, before the final `console.log`, append:

```js
// --- activation ---
{
  // gamma allows only one WORKING cycle; the FY28 participation cycle from Task 4
  // is still draft (working). Archive it via admin so the bare cycle can be created.
  await admin.from('appraisal_cycles')
    .update({ status: 'archived', archived_at: new Date().toISOString() })
    .eq('organization_id', gamma.id).eq('name', 'FY28 Participation Cycle');

  // A brand-new draft cycle with NO prerequisites must fail activation.
  const bare = await callAdmin(superT, 'cycle.create-draft', {
    orgId: gamma.id, name: 'FY29 Bare Cycle', frameworkId: 'kra',
  });
  check('bare draft created', bare.status === 200);
  const bareCycle = bare.body.data.cycle;
  const prereqFail = await callAdmin(superT, 'cycle.activate', {
    orgId: gamma.id, cycleId: bareCycle.id, expectedVersion: bareCycle.version,
  });
  check('activation blocked without prerequisites', prereqFail.status === 422 && prereqFail.body.error.code === 'ACTIVATION_PREREQ');

  // Build the minimum: one rating level, one window, one participant.
  let v = bareCycle.version;
  const scale = await callAdmin(superT, 'cycle.save-section', {
    orgId: gamma.id, cycleId: bareCycle.id, cycleVersion: v, section: 'rating_scale_levels',
    rows: [{ point: 3, label: 'Meets', code: 'ME', rangeFrom: 60, rangeTo: 79 }],
  });
  v = scale.body.data.cycle.version;
  const win = await callAdmin(superT, 'cycle.set-windows', {
    orgId: gamma.id, cycleId: bareCycle.id, cycleVersion: v,
    windows: [{ key: 'goal_creation', startsOn: '2029-04-01', endsOn: '2029-04-30' }],
  });
  v = win.body.data.cycle.version;
  await callAdmin(superT, 'cycle.add-participants', { orgId: gamma.id, cycleId: bareCycle.id, employeeCodes: ['G100'] });

  const staleActivate = await callAdmin(superT, 'cycle.activate', {
    orgId: gamma.id, cycleId: bareCycle.id, expectedVersion: 1,
  });
  check('activation with stale version conflicts', staleActivate.status === 409 && staleActivate.body.error.code === 'CONFLICT');

  const activate = await callAdmin(superT, 'cycle.activate', {
    orgId: gamma.id, cycleId: bareCycle.id, expectedVersion: v,
  });
  check('activation succeeds with prerequisites met', activate.status === 200 && activate.body.data.cycle.status === 'active');

  const { data: activated } = await admin.from('appraisal_cycles').select('status, activated_at').eq('id', bareCycle.id).single();
  check('cycle row is active with activated_at set', activated.status === 'active' && activated.activated_at !== null);

  const reactivate = await callAdmin(superT, 'cycle.activate', {
    orgId: gamma.id, cycleId: bareCycle.id, expectedVersion: activate.body.data.cycle ? v + 1 : v,
  });
  check('re-activating an active cycle is rejected', reactivate.status === 409 && reactivate.body.error.code === 'CYCLE_LOCKED');
}
```

- [ ] **Step 8: Run the full gate**

Run: `node supabase/verify/run-all.mjs`
Expected: deno tests pass; all five scripts pass — `rls-check: PASS (52 assertions)` (51 + 1 new denial), `admin-check: PASS (75 assertions)` (69 + 6 new); final `FOUNDATION SMOKE: ALL PASS`, exit 0.
(Run in background if it exceeds the 2-minute foreground limit.)

- [ ] **Step 9: Run lint**

Run: `npm run lint`
Expected: no NEW problems in `supabase/**` (pre-existing `src/` findings out of scope — note, don't fix).

- [ ] **Step 10: Commit**

```bash
git add supabase/migrations/2026070622_pms_activate_cycle_rpc.sql supabase/functions/pms-admin/activation.ts supabase/functions/pms-admin/index.ts supabase/verify/admin-check.mjs supabase/verify/rls-check.mjs
git commit -m "feat(admin-backend): atomic cycle activation with prerequisite checks + smoke gate"
```

---

## Out of Scope (later plans)

- Plan 3: workflow backend — employee goal plans (seeded from prefill/library at goal-setting time), goal submit/approve/send-back, self/manager/hod/hr_final evaluations, calibration, publishing, acknowledgements, scoring. Kernel derived-capability helper (manager/HOD via `reporting_relationships`) lands here.
- Plan 4: job worker — drains `email_jobs` (sends the queued invites via the existing multi-provider engine) and `background_jobs`; exports.
- Plan 5: screens — wizard/dashboards/portal rewired to `callPms` + RLS reads; the first-login set-password flow that consumes the invite recovery link.
- Plan 6: cutover — delete `app_state` blob usage, localStorage sync, old edge functions; final lockdown; the dashboard "disable signups" toggle.

Nothing in this plan modifies old-world files (old edge functions, `public` schema, `src/`).
