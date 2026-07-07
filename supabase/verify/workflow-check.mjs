// Run: node supabase/verify/seed-foundation.mjs && node supabase/verify/workflow-check.mjs
// End-to-end checks for the pms-workflow (goal-setting) actions on the live TEST project.
import assert from 'node:assert/strict';
import { adminClient, signIn, SUPABASE_URL, ANON_KEY } from './_clients.mjs';
import { USERS, PASSWORD } from './seed-foundation.mjs';

const FN_URL = `${SUPABASE_URL}/functions/v1/pms-workflow`;
const ADMIN_URL = `${SUPABASE_URL}/functions/v1/pms-admin`;

let n = 0;
export const check = (desc, cond) => { n += 1; assert.ok(cond, `FAIL: ${desc}`); console.log(`ok ${desc}`); };
export const admin = adminClient();

export async function callWorkflow(token, action, payload) {
  const res = await fetch(FN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: ANON_KEY, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ action, payload }),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}
export async function callAdmin(token, action, payload) {
  const res = await fetch(ADMIN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: ANON_KEY, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ action, payload }),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

export const tokens = {};
for (const [role, email] of Object.entries(USERS)) {
  tokens[role] = (await signIn(email, PASSWORD)).session.access_token;
}

// --- whoami sanity ---
{
  const noTok = await callWorkflow(null, 'workflow.whoami', {});
  check('workflow rejects missing token', noTok.status === 401);
  const eve = await callWorkflow(tokens.employee, 'workflow.whoami', {});
  check('workflow.whoami resolves the employee membership', eve.status === 200 && Array.isArray(eve.body.data.memberships));
}

// Build a self-contained ACTIVE cycle for acme with a participant (EMP002/Eve),
// an assigned library (1 KRA + 1 KPI) and a prefill row. Idempotent (delete-first).
export async function setupActiveCycle() {
  const { data: org } = await admin.from('organizations').select('id').eq('key', 'acme-test').single();
  const emp = {};
  for (const code of ['EMP001', 'EMP002', 'EMP003']) {
    const { data } = await admin.from('employees').select('id').eq('organization_id', org.id).eq('employee_code', code).single();
    emp[code] = data.id;
  }
  // Fresh cycle: archive any existing working cycle, then create ours.
  await admin.from('appraisal_cycles').update({ status: 'archived', archived_at: new Date().toISOString() })
    .eq('organization_id', org.id).neq('status', 'archived');
  const { data: cycle } = await admin.from('appraisal_cycles').insert({
    organization_id: org.id, name: 'WF Cycle', framework_id: 'kra-kpi', status: 'setup',
  }).select().single();
  const today = new Date();
  const iso = (d) => d.toISOString().slice(0, 10);
  const past = iso(new Date(today.getTime() - 5 * 864e5));
  const future = iso(new Date(today.getTime() + 30 * 864e5));
  await admin.from('cycle_phase_windows').insert([
    { organization_id: org.id, cycle_id: cycle.id, window_key: 'goal_creation', starts_on: past, ends_on: future },
    { organization_id: org.id, cycle_id: cycle.id, window_key: 'manager_approval', starts_on: past, ends_on: future },
  ]);
  const { data: group } = await admin.from('cycle_groups').insert({
    organization_id: org.id, cycle_id: cycle.id, name: 'Sales', target_level: 'kpi', rating_level: 'kpi', can_edit_own_goals: true,
  }).select().single();
  const { data: noEditGroup } = await admin.from('cycle_groups').insert({
    organization_id: org.id, cycle_id: cycle.id, name: 'NoEdit', target_level: 'kra', rating_level: 'kra', can_edit_own_goals: false,
  }).select().single();
  const { data: lib } = await admin.from('goal_libraries').insert({
    organization_id: org.id, name: `WF Lib ${cycle.id.slice(0, 8)}`,
  }).select().single();
  const { data: kra } = await admin.from('goal_library_items').insert({
    organization_id: org.id, goal_library_id: lib.id, item_type: 'kra', title: 'Grow Revenue', weight: 100, display_order: 0,
  }).select().single();
  await admin.from('goal_library_items').insert({
    organization_id: org.id, goal_library_id: lib.id, item_type: 'kpi', parent_item_id: kra.id, title: 'New ARR', weight: 100, display_order: 1,
  });
  const { data: pfd } = await admin.from('prefill_datasets').insert({
    organization_id: org.id, name: `WF Prefill ${cycle.id.slice(0, 8)}`,
  }).select().single();
  await admin.from('prefill_dataset_items').insert({
    organization_id: org.id, prefill_dataset_id: pfd.id, employee_code: 'EMP002',
    kra_title: 'Retention', kpi_title: 'Churn %', weight: 100, display_order: 0,
  });
  const parts = {};
  for (const code of ['EMP001', 'EMP002', 'EMP003']) {
    const { data: p } = await admin.from('cycle_participants').insert({
      organization_id: org.id, cycle_id: cycle.id, employee_id: emp[code],
    }).select().single();
    parts[code] = p.id;
  }
  await admin.from('cycle_participant_assignments').insert({
    organization_id: org.id, cycle_id: cycle.id, participant_id: parts.EMP002, employee_id: emp.EMP002,
    group_id: group.id, goal_library_id: lib.id, prefill_dataset_id: pfd.id,
  });
  await admin.from('cycle_participant_assignments').insert({
    organization_id: org.id, cycle_id: cycle.id, participant_id: parts.EMP003, employee_id: emp.EMP003, group_id: noEditGroup.id,
  });
  await admin.from('appraisal_cycles').update({ status: 'active', activated_at: new Date().toISOString() }).eq('id', cycle.id);
  return { orgId: org.id, cycleId: cycle.id, emp, groupId: group.id };
}

export const fixture = await setupActiveCycle();

// Fresh active cycle for the evaluation tests: EMP002 has an APPROVED plan with
// 2 KRAs (each one numeric-target KPI), a frozen rating scale + auto bands, and
// self/manager_evaluation windows open. Self-contained; archives acme's working cycle first.
export async function setupEvalCycle() {
  const { data: org } = await admin.from('organizations').select('id').eq('key', 'acme-test').single();
  const emp = {};
  for (const code of ['EMP001', 'EMP002', 'EMP003']) {
    const { data } = await admin.from('employees').select('id').eq('organization_id', org.id).eq('employee_code', code).single();
    emp[code] = data.id;
  }
  await admin.from('appraisal_cycles').update({ status: 'archived', archived_at: new Date().toISOString() })
    .eq('organization_id', org.id).neq('status', 'archived');
  const { data: cycle } = await admin.from('appraisal_cycles').insert({
    organization_id: org.id, name: 'Eval Cycle', framework_id: 'kra-kpi', status: 'active', activated_at: new Date().toISOString(),
  }).select().single();
  const iso2 = (d) => d.toISOString().slice(0, 10);
  const pastW = iso2(new Date(Date.now() - 3 * 864e5));
  const futW = iso2(new Date(Date.now() + 30 * 864e5));
  await admin.from('cycle_phase_windows').insert([
    { organization_id: org.id, cycle_id: cycle.id, window_key: 'self_evaluation', starts_on: pastW, ends_on: futW },
    { organization_id: org.id, cycle_id: cycle.id, window_key: 'manager_evaluation', starts_on: pastW, ends_on: futW },
  ]);
  await admin.from('cycle_rating_scale_levels').insert([
    { organization_id: org.id, cycle_id: cycle.id, point: 2, label: 'Below', range_from: 0, range_to: 59 },
    { organization_id: org.id, cycle_id: cycle.id, point: 3, label: 'Meets', range_from: 60, range_to: 89 },
    { organization_id: org.id, cycle_id: cycle.id, point: 5, label: 'Exceeds', range_from: 90, range_to: 200 },
  ]);
  await admin.from('cycle_auto_rating_bands').insert([
    { organization_id: org.id, cycle_id: cycle.id, from_percent: 0, to_percent: 59, score: 2 },
    { organization_id: org.id, cycle_id: cycle.id, from_percent: 60, to_percent: 89, score: 3 },
    { organization_id: org.id, cycle_id: cycle.id, from_percent: 90, to_percent: 200, score: 5 },
  ]);
  await admin.from('cycle_target_types').insert({
    organization_id: org.id, cycle_id: cycle.id, target_type_key: 'number', name: 'Number', is_numeric: true, lower_is_better: false,
  });
  // EMP002 assigned to a rating_level=kpi group (so KPIs carry scores).
  const { data: group } = await admin.from('cycle_groups').insert({
    organization_id: org.id, cycle_id: cycle.id, name: 'Sales', target_level: 'kpi', rating_level: 'kpi',
  }).select().single();
  const { data: part } = await admin.from('cycle_participants').insert({
    organization_id: org.id, cycle_id: cycle.id, employee_id: emp.EMP002,
  }).select().single();
  await admin.from('cycle_participant_assignments').insert({
    organization_id: org.id, cycle_id: cycle.id, participant_id: part.id, employee_id: emp.EMP002, group_id: group.id,
  });
  const { data: eplan } = await admin.from('employee_goal_plans').insert({
    organization_id: org.id, cycle_id: cycle.id, employee_id: emp.EMP002, status: 'approved', approved_at: new Date().toISOString(),
  }).select().single();
  const mk = async (fields) => (await admin.from('employee_goal_items').insert({
    organization_id: org.id, cycle_id: cycle.id, plan_id: eplan.id, employee_id: emp.EMP002, ...fields,
  }).select().single()).data;
  const kraA = await mk({ item_type: 'kra', title: 'Revenue', weight: 60, display_order: 0 });
  await mk({ item_type: 'kpi', parent_item_id: kraA.id, title: 'New ARR', weight: 100, target_type_key: 'number', target_value: '100', display_order: 1 });
  const kraB = await mk({ item_type: 'kra', title: 'Retention', weight: 40, display_order: 2 });
  await mk({ item_type: 'kpi', parent_item_id: kraB.id, title: 'Churn', weight: 100, target_type_key: 'number', target_value: '100', display_order: 3 });
  return { orgId: org.id, cycleId: cycle.id, emp, planId: eplan.id };
}

// --- goal.ensure-plan seeds from library + prefill; goal.get-plan reads it ---
{
  const ensure = await callWorkflow(tokens.employee, 'goal.ensure-plan', { orgId: fixture.orgId, cycleId: fixture.cycleId });
  check('ensure-plan creates a draft plan', ensure.status === 200 && ensure.body.data.plan.status === 'draft');
  check('ensure-plan seeds library + prefill items (2 kra + 2 kpi)', ensure.body.data.seeded === 4);

  const again = await callWorkflow(tokens.employee, 'goal.ensure-plan', { orgId: fixture.orgId, cycleId: fixture.cycleId });
  check('ensure-plan is idempotent (seeded 0 on second call)', again.status === 200 && again.body.data.seeded === 0);

  const get = await callWorkflow(tokens.employee, 'goal.get-plan', { orgId: fixture.orgId, cycleId: fixture.cycleId });
  check('get-plan returns the seeded items', get.status === 200 && get.body.data.items.length === 4);

  const mgrView = await callWorkflow(tokens.manager, 'goal.get-plan', { orgId: fixture.orgId, cycleId: fixture.cycleId, employeeId: fixture.emp.EMP002 });
  check('manager can view a direct report plan', mgrView.status === 200 && mgrView.body.data.plan !== null);

  const hodView = await callWorkflow(tokens.hod, 'goal.get-plan', { orgId: fixture.orgId, cycleId: fixture.cycleId, employeeId: fixture.emp.EMP002 });
  check('HOD can view a mapped employee plan', hodView.status === 200);

  // Eve (EMP002) is not Mary's (EMP001) manager/HOD — the reverse relation exists — so this must 403.
  const denied = await callWorkflow(tokens.employee, 'goal.get-plan', { orgId: fixture.orgId, cycleId: fixture.cycleId, employeeId: fixture.emp.EMP001 });
  check('employee cannot view another employee plan', denied.status === 403);
}

// --- goal.save-items: validates rules, replaces the tree ---
{
  const get = await callWorkflow(tokens.employee, 'goal.get-plan', { orgId: fixture.orgId, cycleId: fixture.cycleId });
  const v = get.body.data.plan.version;
  // A valid replacement: 2 KRAs (60/40) each with 1 KPI (100).
  const goodItems = [
    { key: 'k1', itemType: 'kra', title: 'Revenue', weight: 60, displayOrder: 0 },
    { key: 'k1a', itemType: 'kpi', parentKey: 'k1', title: 'New ARR', weight: 100, displayOrder: 1 },
    { key: 'k2', itemType: 'kra', title: 'Retention', weight: 40, displayOrder: 2 },
    { key: 'k2a', itemType: 'kpi', parentKey: 'k2', title: 'Churn', weight: 100, displayOrder: 3 },
  ];
  const save = await callWorkflow(tokens.employee, 'goal.save-items', { orgId: fixture.orgId, cycleId: fixture.cycleId, planVersion: v, items: goodItems });
  check('save-items replaces the goal tree', save.status === 200 && save.body.data.items.length === 4);

  const badWeights = await callWorkflow(tokens.employee, 'goal.save-items', {
    orgId: fixture.orgId, cycleId: fixture.cycleId, planVersion: save.body.data.plan.version,
    items: [{ key: 'k1', itemType: 'kra', title: 'X', weight: 50, displayOrder: 0 }, { key: 'k1a', itemType: 'kpi', parentKey: 'k1', title: 'Y', weight: 100, displayOrder: 1 }],
  });
  check('save-items rejects KRA weights not summing to 100', badWeights.status === 422 && badWeights.body.error.code === 'GOAL_RULES');

  const stale = await callWorkflow(tokens.employee, 'goal.save-items', { orgId: fixture.orgId, cycleId: fixture.cycleId, planVersion: 1, items: goodItems });
  check('save-items rejects a stale plan version', stale.status === 409 && stale.body.error.code === 'CONFLICT');

  const notMine = await callWorkflow(tokens.manager, 'goal.save-items', { orgId: fixture.orgId, cycleId: fixture.cycleId, planVersion: 1, items: goodItems });
  check('a manager cannot edit as if it were their own missing plan', notMine.status === 404 || notMine.status === 409);

  const harryEnsure = await callWorkflow(tokens.hod, 'goal.ensure-plan', { orgId: fixture.orgId, cycleId: fixture.cycleId });
  const harrySave = await callWorkflow(tokens.hod, 'goal.save-items', {
    orgId: fixture.orgId, cycleId: fixture.cycleId, planVersion: harryEnsure.body.data.plan.version,
    items: [{ key: 'k1', itemType: 'kra', title: 'X', weight: 100, displayOrder: 0 }, { key: 'k1a', itemType: 'kpi', parentKey: 'k1', title: 'Y', weight: 100, displayOrder: 1 }],
  });
  check('save-items refused for a no-edit group (EDIT_NOT_ALLOWED)', harrySave.status === 403 && harrySave.body.error.code === 'EDIT_NOT_ALLOWED');
}

// --- submit → send-back → resubmit → approve → reopen ---
{
  const get = await callWorkflow(tokens.employee, 'goal.get-plan', { orgId: fixture.orgId, cycleId: fixture.cycleId });
  let v = get.body.data.plan.version;

  const submit = await callWorkflow(tokens.employee, 'goal.submit', { orgId: fixture.orgId, cycleId: fixture.cycleId, planVersion: v });
  check('employee submits the plan', submit.status === 200 && submit.body.data.plan.status === 'submitted');
  v = submit.body.data.plan.version;

  const empApprove = await callWorkflow(tokens.employee, 'goal.approve', { orgId: fixture.orgId, cycleId: fixture.cycleId, employeeId: fixture.emp.EMP002, planVersion: v });
  check('employee cannot approve their own plan', empApprove.status === 403);

  const sendBack = await callWorkflow(tokens.manager, 'goal.send-back', { orgId: fixture.orgId, cycleId: fixture.cycleId, employeeId: fixture.emp.EMP002, planVersion: v, note: 'Tighten the churn target' });
  check('manager sends the plan back with a note', sendBack.status === 200 && sendBack.body.data.plan.status === 'sent_back');
  v = sendBack.body.data.plan.version;

  const resubmit = await callWorkflow(tokens.employee, 'goal.submit', { orgId: fixture.orgId, cycleId: fixture.cycleId, planVersion: v });
  check('employee resubmits after send-back', resubmit.status === 200 && resubmit.body.data.plan.status === 'submitted');
  v = resubmit.body.data.plan.version;

  const isoD = (d) => d.toISOString().slice(0, 10);
  // The window's starts_on is 5 days ago (set in setupActiveCycle) and the table has a
  // check (ends_on >= starts_on) constraint, so "closed" here means ends_on = yesterday
  // (still >= starts_on, but < today so the window reads as closed).
  const pastEnd = isoD(new Date(Date.now() - 1 * 864e5));
  await admin.from('cycle_phase_windows').update({ ends_on: pastEnd }).eq('cycle_id', fixture.cycleId).eq('window_key', 'manager_approval');
  const closedApprove = await callWorkflow(tokens.manager, 'goal.approve', { orgId: fixture.orgId, cycleId: fixture.cycleId, employeeId: fixture.emp.EMP002, planVersion: v });
  check('approve refused when manager_approval window closed', closedApprove.status === 409 && closedApprove.body.error.code === 'WINDOW_CLOSED');
  const futureEnd = isoD(new Date(Date.now() + 30 * 864e5));
  await admin.from('cycle_phase_windows').update({ ends_on: futureEnd }).eq('cycle_id', fixture.cycleId).eq('window_key', 'manager_approval');

  const approve = await callWorkflow(tokens.manager, 'goal.approve', { orgId: fixture.orgId, cycleId: fixture.cycleId, employeeId: fixture.emp.EMP002, planVersion: v });
  check('manager approves the plan', approve.status === 200 && approve.body.data.plan.status === 'approved');
  v = approve.body.data.plan.version;

  const mgrOther = await callWorkflow(tokens.manager, 'goal.approve', { orgId: fixture.orgId, cycleId: fixture.cycleId, employeeId: fixture.emp.EMP003, planVersion: 1 });
  check('manager cannot approve a non-report (EMP003)', mgrOther.status === 403 && mgrOther.body.error.code === 'FORBIDDEN');

  const mgrReopen = await callWorkflow(tokens.manager, 'goal.reopen', { orgId: fixture.orgId, cycleId: fixture.cycleId, employeeId: fixture.emp.EMP002, planVersion: v });
  check('manager cannot reopen (HR only)', mgrReopen.status === 403);

  const reopen = await callWorkflow(tokens.hr, 'goal.reopen', { orgId: fixture.orgId, cycleId: fixture.cycleId, employeeId: fixture.emp.EMP002, planVersion: v });
  check('HR reopens the approved plan', reopen.status === 200 && reopen.body.data.plan.status === 'reopened');

  const { data: events } = await admin.from('goal_workflow_events').select('event_type').eq('cycle_id', fixture.cycleId).eq('employee_id', fixture.emp.EMP002);
  check('workflow events recorded (submitted/sent_back/submitted/approved/reopened)', (events ?? []).length >= 5);
}

// --- phase gating: goal edits refused when the goal_creation window is closed ---
{
  const iso = (d) => d.toISOString().slice(0, 10);
  const now = new Date();
  const longAgoStart = iso(new Date(now.getTime() - 60 * 864e5));
  const longAgoEnd = iso(new Date(now.getTime() - 30 * 864e5));
  // Archive the WF cycle and stand up a closed-window cycle with EMP002 as participant.
  await admin.from('appraisal_cycles').update({ status: 'archived', archived_at: new Date().toISOString() })
    .eq('organization_id', fixture.orgId).neq('status', 'archived');
  const { data: c2 } = await admin.from('appraisal_cycles').insert({
    organization_id: fixture.orgId, name: 'WF Closed', framework_id: 'kra', status: 'setup',
  }).select().single();
  await admin.from('cycle_phase_windows').insert([
    { organization_id: fixture.orgId, cycle_id: c2.id, window_key: 'goal_creation', starts_on: longAgoStart, ends_on: longAgoEnd },
  ]);
  const { data: p2 } = await admin.from('cycle_participants').insert({
    organization_id: fixture.orgId, cycle_id: c2.id, employee_id: fixture.emp.EMP002,
  }).select().single();
  await admin.from('cycle_participant_assignments').insert({
    organization_id: fixture.orgId, cycle_id: c2.id, participant_id: p2.id, employee_id: fixture.emp.EMP002,
  });
  await admin.from('appraisal_cycles').update({ status: 'active', activated_at: new Date().toISOString() }).eq('id', c2.id);

  const ensure = await callWorkflow(tokens.employee, 'goal.ensure-plan', { orgId: fixture.orgId, cycleId: c2.id });
  check('ensure-plan works regardless of window', ensure.status === 200);
  const v = ensure.body.data.plan.version;
  const saveClosed = await callWorkflow(tokens.employee, 'goal.save-items', {
    orgId: fixture.orgId, cycleId: c2.id, planVersion: v,
    items: [{ key: 'k1', itemType: 'kra', title: 'X', weight: 100, displayOrder: 0 }, { key: 'k1a', itemType: 'kpi', parentKey: 'k1', title: 'Y', weight: 100, displayOrder: 1 }],
  });
  check('employee edit refused when goal_creation window closed', saveClosed.status === 409 && saveClosed.body.error.code === 'WINDOW_CLOSED');

  const hrSaveClosed = await callWorkflow(tokens.hr, 'goal.save-items', {
    orgId: fixture.orgId, cycleId: c2.id, planVersion: v,
    items: [{ key: 'k1', itemType: 'kra', title: 'X', weight: 100, displayOrder: 0 }, { key: 'k1a', itemType: 'kpi', parentKey: 'k1', title: 'Y', weight: 100, displayOrder: 1 }],
  });
  // HR has no employee row in acme, so save-items (which acts on the caller's own plan) is NO_EMPLOYEE, proving HR-bypass is about the window, not identity.
  check('HR save-items on own-plan path needs an employee row', hrSaveClosed.status === 403 && hrSaveClosed.body.error.code === 'NO_EMPLOYEE');
}

// ============ EVALUATIONS (Plan 3b) ============
export const evalFixture = await setupEvalCycle();

// --- eval.ensure seeds score rows; eval.get reads them (self stage) ---
{
  const ensure = await callWorkflow(tokens.employee, 'eval.ensure', { orgId: evalFixture.orgId, cycleId: evalFixture.cycleId, stage: 'self' });
  check('eval.ensure creates a draft self evaluation', ensure.status === 200 && ensure.body.data.evaluation.stage === 'self' && ensure.body.data.evaluation.status === 'draft');
  check('eval.ensure seeds a goal-score row per KPI (2)', ensure.body.data.goalScores.length === 2);

  const again = await callWorkflow(tokens.employee, 'eval.ensure', { orgId: evalFixture.orgId, cycleId: evalFixture.cycleId, stage: 'self' });
  check('eval.ensure is idempotent (seeded 0)', again.status === 200 && again.body.data.seeded === 0);

  const get = await callWorkflow(tokens.employee, 'eval.get', { orgId: evalFixture.orgId, cycleId: evalFixture.cycleId, employeeId: evalFixture.emp.EMP002, stage: 'self' });
  check('eval.get returns own self evaluation', get.status === 200 && get.body.data.goalScores.length === 2);

  const mgrPrereq = await callWorkflow(tokens.manager, 'eval.ensure', { orgId: evalFixture.orgId, cycleId: evalFixture.cycleId, stage: 'manager', employeeId: evalFixture.emp.EMP002 });
  check('manager eval blocked until self submitted', mgrPrereq.status === 409 && mgrPrereq.body.error.code === 'SELF_NOT_SUBMITTED');

  const peek = await callWorkflow(tokens.employee, 'eval.get', { orgId: evalFixture.orgId, cycleId: evalFixture.cycleId, employeeId: evalFixture.emp.EMP001, stage: 'self' });
  check('employee cannot view another employee evaluation', peek.status === 403);
}

// --- eval.save-scores computes achievement % + auto rating + overall ---
{
  const get = await callWorkflow(tokens.employee, 'eval.get', { orgId: evalFixture.orgId, cycleId: evalFixture.cycleId, employeeId: evalFixture.emp.EMP002, stage: 'self' });
  const v = get.body.data.evaluation.version;
  const ids = get.body.data.goalScores.map((r) => r.goal_item_id);
  // Score KPI A at 120% (→ band score 5) and KPI B at 50% (→ band score 2).
  const save = await callWorkflow(tokens.employee, 'eval.save-scores', {
    orgId: evalFixture.orgId, cycleId: evalFixture.cycleId, employeeId: evalFixture.emp.EMP002, stage: 'self', evalVersion: v,
    goalScores: [
      { goalItemId: ids[0], achievementValue: '120' },
      { goalItemId: ids[1], achievementValue: '50' },
    ],
    overallComment: 'Solid year',
  });
  check('save-scores succeeds', save.status === 200);
  const scoreA = save.body.data.goalScores.find((r) => r.goal_item_id === ids[0]);
  check('achievement % computed (120)', Number(scoreA.achievement_percent) === 120);
  check('auto rating from bands (5)', Number(scoreA.score) === 5);
  // KRA A=5 (w60), KRA B=2 (w40) → 5*0.6 + 2*0.4 = 3.8
  check('overall rolled up (3.8)', Number(save.body.data.evaluation.overall_score) === 3.8);

  const manual = await callWorkflow(tokens.employee, 'eval.save-scores', {
    orgId: evalFixture.orgId, cycleId: evalFixture.cycleId, employeeId: evalFixture.emp.EMP002, stage: 'self', evalVersion: save.body.data.evaluation.version,
    goalScores: [{ goalItemId: ids[0], achievementValue: '120', score: 3 }],
  });
  const scoreAManual = manual.body.data.goalScores.find((r) => r.goal_item_id === ids[0]);
  check('manual score overrides auto rating', Number(scoreAManual.score) === 3);

  const stale = await callWorkflow(tokens.employee, 'eval.save-scores', {
    orgId: evalFixture.orgId, cycleId: evalFixture.cycleId, employeeId: evalFixture.emp.EMP002, stage: 'self', evalVersion: 1,
    goalScores: [],
  });
  check('save-scores rejects a stale eval version', stale.status === 409 && stale.body.error.code === 'CONFLICT');
}

// --- self submit unlocks manager; manager rates + submits ---
{
  // Ensure self is scored (Task 3 left it draft with scores) then submit.
  const selfGet = await callWorkflow(tokens.employee, 'eval.get', { orgId: evalFixture.orgId, cycleId: evalFixture.cycleId, employeeId: evalFixture.emp.EMP002, stage: 'self' });
  const selfSubmit = await callWorkflow(tokens.employee, 'eval.submit', { orgId: evalFixture.orgId, cycleId: evalFixture.cycleId, employeeId: evalFixture.emp.EMP002, stage: 'self', evalVersion: selfGet.body.data.evaluation.version });
  check('employee submits self evaluation', selfSubmit.status === 200 && selfSubmit.body.data.evaluation.status === 'submitted');

  const reSubmit = await callWorkflow(tokens.employee, 'eval.submit', { orgId: evalFixture.orgId, cycleId: evalFixture.cycleId, employeeId: evalFixture.emp.EMP002, stage: 'self', evalVersion: selfSubmit.body.data.evaluation.version });
  check('re-submitting a submitted self evaluation is rejected', reSubmit.status === 409 && reSubmit.body.error.code === 'EVAL_LOCKED');

  // Now the manager stage is unlocked.
  const mgrEnsure = await callWorkflow(tokens.manager, 'eval.ensure', { orgId: evalFixture.orgId, cycleId: evalFixture.cycleId, stage: 'manager', employeeId: evalFixture.emp.EMP002 });
  check('manager eval unlocked after self submitted', mgrEnsure.status === 200 && mgrEnsure.body.data.evaluation.stage === 'manager');
  const mIds = mgrEnsure.body.data.goalScores.map((r) => r.goal_item_id);

  const empRatesMgr = await callWorkflow(tokens.employee, 'eval.save-scores', { orgId: evalFixture.orgId, cycleId: evalFixture.cycleId, employeeId: evalFixture.emp.EMP002, stage: 'manager', evalVersion: mgrEnsure.body.data.evaluation.version, goalScores: [] });
  check('employee cannot write the manager stage', empRatesMgr.status === 403);

  const mgrSave = await callWorkflow(tokens.manager, 'eval.save-scores', {
    orgId: evalFixture.orgId, cycleId: evalFixture.cycleId, employeeId: evalFixture.emp.EMP002, stage: 'manager', evalVersion: mgrEnsure.body.data.evaluation.version,
    goalScores: [{ goalItemId: mIds[0], achievementValue: '95' }, { goalItemId: mIds[1], achievementValue: '95' }],
  });
  check('manager saves scores', mgrSave.status === 200 && Number(mgrSave.body.data.evaluation.overall_score) === 5);

  const mgrSubmit = await callWorkflow(tokens.manager, 'eval.submit', { orgId: evalFixture.orgId, cycleId: evalFixture.cycleId, employeeId: evalFixture.emp.EMP002, stage: 'manager', evalVersion: mgrSave.body.data.evaluation.version });
  check('manager submits evaluation', mgrSubmit.status === 200 && mgrSubmit.body.data.evaluation.status === 'submitted');

  // Employee cannot yet see the manager rating (after_publish default, unpublished).
  const empView = await callWorkflow(tokens.employee, 'eval.get', { orgId: evalFixture.orgId, cycleId: evalFixture.cycleId, employeeId: evalFixture.emp.EMP002, stage: 'manager' });
  check('employee cannot see manager rating before publish', empView.status === 403);
}

// --- HOD sees mapped employee stages; HR-final closes it out ---
{
  const iso3 = (d) => d.toISOString().slice(0, 10);
  const pastW = iso3(new Date(Date.now() - 3 * 864e5));
  const futW = iso3(new Date(Date.now() + 30 * 864e5));
  await admin.from('cycle_phase_windows').insert([
    { organization_id: evalFixture.orgId, cycle_id: evalFixture.cycleId, window_key: 'hod_review', starts_on: pastW, ends_on: futW },
    { organization_id: evalFixture.orgId, cycle_id: evalFixture.cycleId, window_key: 'hr_calibration', starts_on: pastW, ends_on: futW },
  ]);
  await admin.from('appraisal_cycles').update({ status: 'review' }).eq('id', evalFixture.cycleId);

  const empSubmitMgr = await callWorkflow(tokens.employee, 'eval.submit', { orgId: evalFixture.orgId, cycleId: evalFixture.cycleId, employeeId: evalFixture.emp.EMP002, stage: 'manager', evalVersion: 1 });
  check('employee cannot submit the manager stage', empSubmitMgr.status === 403);

  // HOD (Harry, EMP003 maps EMP002 via hod) can view the submitted manager stage.
  const hodView = await callWorkflow(tokens.hod, 'eval.get', { orgId: evalFixture.orgId, cycleId: evalFixture.cycleId, employeeId: evalFixture.emp.EMP002, stage: 'manager' });
  check('HOD can view the manager evaluation of a mapped employee', hodView.status === 200 && hodView.body.data.evaluation !== null);

  // HOD stage ensure + submit.
  const hodEnsure = await callWorkflow(tokens.hod, 'eval.ensure', { orgId: evalFixture.orgId, cycleId: evalFixture.cycleId, stage: 'hod', employeeId: evalFixture.emp.EMP002 });
  check('HOD stage can be created after manager submitted', hodEnsure.status === 200);
  const hIds = hodEnsure.body.data.goalScores.map((r) => r.goal_item_id);

  const hodEmpty = await callWorkflow(tokens.hod, 'eval.submit', { orgId: evalFixture.orgId, cycleId: evalFixture.cycleId, employeeId: evalFixture.emp.EMP002, stage: 'hod', evalVersion: hodEnsure.body.data.evaluation.version });
  check('submit refused when nothing is scored (NOTHING_SCORED)', hodEmpty.status === 422 && hodEmpty.body.error.code === 'NOTHING_SCORED');

  const hodSave = await callWorkflow(tokens.hod, 'eval.save-scores', { orgId: evalFixture.orgId, cycleId: evalFixture.cycleId, employeeId: evalFixture.emp.EMP002, stage: 'hod', evalVersion: hodEnsure.body.data.evaluation.version, goalScores: [{ goalItemId: hIds[0], score: 4 }, { goalItemId: hIds[1], score: 4 }] });
  check('HOD saves calibrated scores', hodSave.status === 200 && Number(hodSave.body.data.evaluation.overall_score) === 4);

  // HR-final (hr user has no employee row but is hr_admin — HR bypass on stage + window).
  const hrEnsure = await callWorkflow(tokens.hr, 'eval.ensure', { orgId: evalFixture.orgId, cycleId: evalFixture.cycleId, stage: 'hr_final', employeeId: evalFixture.emp.EMP002 });
  check('HR-final stage can be created', hrEnsure.status === 200 && hrEnsure.body.data.evaluation.stage === 'hr_final');
  const fIds = hrEnsure.body.data.goalScores.map((r) => r.goal_item_id);
  const hrSave = await callWorkflow(tokens.hr, 'eval.save-scores', { orgId: evalFixture.orgId, cycleId: evalFixture.cycleId, employeeId: evalFixture.emp.EMP002, stage: 'hr_final', evalVersion: hrEnsure.body.data.evaluation.version, goalScores: [{ goalItemId: fIds[0], score: 5 }, { goalItemId: fIds[1], score: 3 }] });
  check('HR saves final scores', hrSave.status === 200);
  const hrSubmit = await callWorkflow(tokens.hr, 'eval.submit', { orgId: evalFixture.orgId, cycleId: evalFixture.cycleId, employeeId: evalFixture.emp.EMP002, stage: 'hr_final', evalVersion: hrSave.body.data.evaluation.version });
  check('HR submits the final evaluation', hrSubmit.status === 200 && hrSubmit.body.data.evaluation.status === 'submitted');
}

// The end marker; later tasks append sections before this and bump the count.
console.log(`workflow-check: PASS (${n} assertions)`);
