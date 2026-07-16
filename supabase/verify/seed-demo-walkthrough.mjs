// Run AFTER seed-foundation:
//   node supabase/verify/seed-foundation.mjs
//   node supabase/verify/seed-demo-walkthrough.mjs [active|review]
//
// Puts the acme-test demo org into a browser-smoke-able state on top of seed-foundation's
// baseline (which leaves a DRAFT cycle with closed windows — nothing to click through).
//
// acme-test can only have ONE working (non-archived) cycle at a time
// (`one_working_cycle_per_org` unique index on appraisal_cycles(organization_id) where
// status <> 'archived' — see supabase/migrations/2026070312_pms_cycles.sql). Flows 1-3
// (goal creation / manager approval / self-evaluation) need an ACTIVE cycle; flow 4 (HR
// publish/revoke) needs a cycle in REVIEW with submitted finals. Those statuses can't
// coexist on one cycle, so this script takes a mode argument and archives any existing
// working cycle before building the requested one. Idempotent: re-running (same or
// different mode) archives the previous demo cycle and creates a fresh one — no errors,
// no duplicate active/review cycles.
import assert from 'node:assert/strict';
import { adminClient } from './_clients.mjs';
import { ORG_KEY, USERS, PASSWORD } from './seed-foundation.mjs';

const admin = adminClient();
const mode = (process.argv[2] || 'active').toLowerCase();
if (!['active', 'review'].includes(mode)) {
  console.error(`Unknown mode "${mode}". Use "active" (default) or "review".`);
  process.exit(1);
}

const iso = (d) => d.toISOString().slice(0, 10);
const past = iso(new Date(Date.now() - 30 * 864e5));
const future = iso(new Date(Date.now() + 30 * 864e5));

const { data: org, error: orgErr } = await admin.from('organizations').select('id').eq('key', ORG_KEY).single();
assert.equal(orgErr, null, orgErr?.message);
assert.ok(org, `org "${ORG_KEY}" not found — run seed-foundation.mjs first`);

const emp = {};
for (const code of ['EMP001', 'EMP002', 'EMP003']) {
  const { data, error } = await admin.from('employees').select('id').eq('organization_id', org.id).eq('employee_code', code).single();
  assert.equal(error, null, error?.message);
  emp[code] = data.id;
}

// Archive whatever working (non-archived) cycle exists — see the unique-index note above.
const { error: archiveErr } = await admin.from('appraisal_cycles')
  .update({ status: 'archived', archived_at: new Date().toISOString() })
  .eq('organization_id', org.id).neq('status', 'archived');
assert.equal(archiveErr, null, archiveErr?.message);

async function insertOne(table, row, label) {
  const { data, error } = await admin.from(table).insert(row).select().single();
  assert.equal(error, null, `${label ?? table}: ${error?.message}`);
  return data;
}
async function insertMany(table, rows, label) {
  const { data, error } = await admin.from(table).insert(rows).select();
  assert.equal(error, null, `${label ?? table}: ${error?.message}`);
  return data;
}

let summary;

if (mode === 'active') {
  // --- Flows 1-3: goal creation, manager approval, self-evaluation ---
  const cycle = await insertOne('appraisal_cycles', {
    organization_id: org.id, name: 'Demo Walkthrough (Active)', period_label: 'FY 2026-27',
    framework_id: 'kra-kpi', status: 'active', activated_at: new Date().toISOString(),
  });

  await insertOne('cycle_config_snapshots', {
    organization_id: org.id, cycle_id: cycle.id,
    snapshot: { visibility: { manager_rating_visible: 'after_publish', final_rating_visible: 'after_publish' } },
  }, 'cycle_config_snapshots');

  await insertMany('cycle_phase_windows', [
    { organization_id: org.id, cycle_id: cycle.id, window_key: 'goal_creation', starts_on: past, ends_on: future },
    { organization_id: org.id, cycle_id: cycle.id, window_key: 'manager_approval', starts_on: past, ends_on: future },
    { organization_id: org.id, cycle_id: cycle.id, window_key: 'self_evaluation', starts_on: past, ends_on: future },
  ], 'cycle_phase_windows');

  const group = await insertOne('cycle_groups', {
    organization_id: org.id, cycle_id: cycle.id, name: 'Sales',
    can_edit_own_goals: true, has_library: true, target_level: 'kpi', rating_level: 'kpi',
  }, 'cycle_groups');

  const lib = await insertOne('goal_libraries', { organization_id: org.id, name: `Demo Library ${cycle.id.slice(0, 8)}` }, 'goal_libraries');
  const kraLib = await insertOne('goal_library_items', {
    organization_id: org.id, goal_library_id: lib.id, item_type: 'kra', title: 'Grow Revenue', weight: 100, display_order: 0,
  }, 'goal_library_items(kra)');
  await insertOne('goal_library_items', {
    organization_id: org.id, goal_library_id: lib.id, item_type: 'kpi', parent_item_id: kraLib.id, title: 'New ARR', weight: 100, display_order: 1,
  }, 'goal_library_items(kpi)');

  const pfd = await insertOne('prefill_datasets', { organization_id: org.id, name: `Demo Prefill ${cycle.id.slice(0, 8)}` }, 'prefill_datasets');
  await insertOne('prefill_dataset_items', {
    organization_id: org.id, prefill_dataset_id: pfd.id, employee_code: 'EMP002',
    kra_title: 'Retention', kpi_title: 'Churn %', weight: 100, display_order: 0,
  }, 'prefill_dataset_items');

  await insertMany('cycle_target_types', [
    { organization_id: org.id, cycle_id: cycle.id, target_type_key: 'number', name: 'Number', is_numeric: true, lower_is_better: false },
  ], 'cycle_target_types');
  await insertMany('cycle_rating_scale_levels', [
    { organization_id: org.id, cycle_id: cycle.id, point: 2, label: 'Below', range_from: 0, range_to: 59 },
    { organization_id: org.id, cycle_id: cycle.id, point: 3, label: 'Meets', range_from: 60, range_to: 89 },
    { organization_id: org.id, cycle_id: cycle.id, point: 5, label: 'Exceeds', range_from: 90, range_to: 200 },
  ], 'cycle_rating_scale_levels');
  await insertMany('cycle_auto_rating_bands', [
    { organization_id: org.id, cycle_id: cycle.id, from_percent: 0, to_percent: 59, score: 2 },
    { organization_id: org.id, cycle_id: cycle.id, from_percent: 60, to_percent: 89, score: 3 },
    { organization_id: org.id, cycle_id: cycle.id, from_percent: 90, to_percent: 200, score: 5 },
  ], 'cycle_auto_rating_bands');

  // Participants: all three roster logins, so any of them can be used to poke around.
  const parts = {};
  for (const code of ['EMP001', 'EMP002', 'EMP003']) {
    const p = await insertOne('cycle_participants', { organization_id: org.id, cycle_id: cycle.id, employee_id: emp[code] }, `cycle_participants(${code})`);
    parts[code] = p.id;
  }
  // EMP002 gets the library/prefill assignment (goal.context add-from-library + prefill).
  await insertOne('cycle_participant_assignments', {
    organization_id: org.id, cycle_id: cycle.id, participant_id: parts.EMP002, employee_id: emp.EMP002,
    group_id: group.id, goal_library_id: lib.id, prefill_dataset_id: pfd.id,
  }, 'cycle_participant_assignments(EMP002)');

  // EMP002's goal plan: pre-APPROVED (2 KRAs x 1 KPI each), so self-evaluation is turnkey
  // available and the Goals screen renders a real tree. (This means the plan is not
  // sitting in "submitted" waiting on Mary's approval today — to walk flow 2 live, have
  // HR reopen it via goal.reopen, or use Mary/Eve to draft+submit+approve a fresh plan;
  // the manager_approval window is open either way.)
  const plan = await insertOne('employee_goal_plans', {
    organization_id: org.id, cycle_id: cycle.id, employee_id: emp.EMP002, status: 'approved', approved_at: new Date().toISOString(),
  }, 'employee_goal_plans(EMP002)');
  const mkItem = async (fields, label) => insertOne('employee_goal_items', {
    organization_id: org.id, cycle_id: cycle.id, plan_id: plan.id, employee_id: emp.EMP002, ...fields,
  }, label);
  const kraA = await mkItem({ item_type: 'kra', title: 'Revenue', weight: 60, display_order: 0 }, 'goal item KRA Revenue');
  await mkItem({ item_type: 'kpi', parent_item_id: kraA.id, title: 'New ARR', weight: 100, target_type_key: 'number', target_value: '100', display_order: 1 }, 'goal item KPI New ARR');
  const kraB = await mkItem({ item_type: 'kra', title: 'Retention', weight: 40, display_order: 2 }, 'goal item KRA Retention');
  await mkItem({ item_type: 'kpi', parent_item_id: kraB.id, title: 'Churn', weight: 100, target_type_key: 'number', target_value: '100', display_order: 3 }, 'goal item KPI Churn');

  summary = {
    mode: 'active', cycleId: cycle.id, cycleName: cycle.name,
    flows: [
      '1. Goal creation — pms-manager@example.com or pms-hod@example.com (EMP001/EMP003, no plan yet): sign in, workspace acme-test, Goals screen, create/save/submit a plan (goal_creation window open).',
      '2. Manager approval — pms-manager@example.com: Team > review queue shows Eve (EMP002); her plan is pre-approved, so nothing pends today. To see a live approve, have HR reopen Eve\'s plan (goal.reopen) or use EMP001/EMP003 to submit a fresh plan for approval (manager_approval window open).',
      '3. Self-evaluation — pms-employee@example.com (EMP002/Eve): sign in, workspace acme-test, Self-Evaluation screen — goals are approved and self_evaluation window is open, so scoring is available immediately.',
    ],
  };
} else {
  // --- Flow 4: HR publish/revoke ---
  const cycle = await insertOne('appraisal_cycles', {
    organization_id: org.id, name: 'Demo Walkthrough (Review)', period_label: 'FY 2026-27',
    framework_id: 'kra-kpi', status: 'review',
  }, 'appraisal_cycles');

  await insertOne('cycle_config_snapshots', {
    organization_id: org.id, cycle_id: cycle.id,
    snapshot: { visibility: { manager_rating_visible: 'after_publish', final_rating_visible: 'after_publish' } },
  }, 'cycle_config_snapshots');

  await insertMany('cycle_phase_windows', [
    { organization_id: org.id, cycle_id: cycle.id, window_key: 'hod_review', starts_on: past, ends_on: future },
    { organization_id: org.id, cycle_id: cycle.id, window_key: 'hr_calibration', starts_on: past, ends_on: future },
  ], 'cycle_phase_windows');

  await insertMany('cycle_rating_scale_levels', [
    { organization_id: org.id, cycle_id: cycle.id, point: 2, label: 'Below', range_from: 0, range_to: 59 },
    { organization_id: org.id, cycle_id: cycle.id, point: 3, label: 'Meets', range_from: 60, range_to: 89 },
    { organization_id: org.id, cycle_id: cycle.id, point: 5, label: 'Exceeds', range_from: 90, range_to: 200 },
  ], 'cycle_rating_scale_levels');
  // Generous tolerance so publish.bell-check / publish.publish succeed unforced out of the box.
  await insertMany('cycle_bell_curve_bands', [
    { organization_id: org.id, cycle_id: cycle.id, rating_point: 2, target_percent: 33, tolerance_percent: 100 },
    { organization_id: org.id, cycle_id: cycle.id, rating_point: 3, target_percent: 34, tolerance_percent: 100 },
    { organization_id: org.id, cycle_id: cycle.id, rating_point: 5, target_percent: 33, tolerance_percent: 100 },
  ], 'cycle_bell_curve_bands');

  // Three active participants, each with a submitted hr_final evaluation spread across the
  // rating scale (2 / 3 / 5) so the bell-curve summary has real, varied data.
  const scoreByCode = { EMP001: 3, EMP002: 5, EMP003: 2 };
  for (const code of ['EMP001', 'EMP002', 'EMP003']) {
    await insertOne('cycle_participants', { organization_id: org.id, cycle_id: cycle.id, employee_id: emp[code] }, `cycle_participants(${code})`);
    await insertOne('evaluations', {
      organization_id: org.id, cycle_id: cycle.id, employee_id: emp[code], stage: 'hr_final',
      status: 'submitted', overall_score: scoreByCode[code], submitted_at: new Date().toISOString(),
    }, `evaluations(hr_final,${code})`);
  }

  summary = {
    mode: 'review', cycleId: cycle.id, cycleName: cycle.name,
    flows: [
      '4. HR publish/revoke — pms-hr@example.com: sign in, workspace acme-test, HR Publish/Review screen. All 3 participants (EMP001/EMP002/EMP003) have submitted hr_final scores (3/5/2) and the bell curve is within tolerance, so Publish should succeed without force; Revoke afterward re-opens the cycle to review.',
    ],
  };
}

console.log('');
console.log('================================================================');
console.log(`seed-demo-walkthrough: PASS — mode "${summary.mode}"`);
console.log(`  org: ${ORG_KEY}   cycle: "${summary.cycleName}" (${summary.cycleId})`);
console.log('  shared password for every login below:', PASSWORD);
console.log('  logins (all workspace/org: acme-test):');
for (const [role, email] of Object.entries(USERS)) console.log(`    ${role.padEnd(10)} ${email}`);
console.log('');
console.log('  flows enabled by this mode:');
for (const line of summary.flows) console.log('    - ' + line);
console.log('');
console.log('  switch modes with:');
console.log('    node supabase/verify/seed-demo-walkthrough.mjs active   # flows 1-3: goals / manager approval / self-eval');
console.log('    node supabase/verify/seed-demo-walkthrough.mjs review   # flow 4: HR publish / revoke');
console.log('================================================================');
