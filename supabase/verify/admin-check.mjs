// Run: node supabase/verify/seed-foundation.mjs && node supabase/verify/admin-check.mjs
// End-to-end checks for pms-admin org/cycle admin actions against the live TEST project.
import assert from 'node:assert/strict';
import { adminClient, anonClient, signIn, SUPABASE_URL, ANON_KEY } from './_clients.mjs';
import { USERS, PASSWORD } from './seed-foundation.mjs';

const FN_URL = `${SUPABASE_URL}/functions/v1/pms-admin`;
const GAMMA_KEY = 'gamma-test';

let n = 0;
const check = (desc, cond) => { n += 1; assert.ok(cond, `FAIL: ${desc}`); console.log(`ok ${desc}`); };

export async function callAdmin(token, action, payload) {
  const res = await fetch(FN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: ANON_KEY,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ action, payload }),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

const admin = adminClient();
await admin.from('organizations').delete().eq('key', GAMMA_KEY); // idempotent fixture reset

const superT = (await signIn(USERS.superadmin, PASSWORD)).session.access_token;
const hrT = (await signIn(USERS.hr, PASSWORD)).session.access_token;
const empT = (await signIn(USERS.employee, PASSWORD)).session.access_token;
const betaT = (await signIn(USERS.beta, PASSWORD)).session.access_token;

// --- org.create ---
{
  const denied = await callAdmin(hrT, 'org.create', { key: GAMMA_KEY, name: 'Gamma Test Org' });
  check('org.create denied for HR (super admin only)', denied.status === 403 && denied.body.error.code === 'FORBIDDEN');
  const created = await callAdmin(superT, 'org.create', { key: GAMMA_KEY, name: 'Gamma Test Org' });
  check('org.create succeeds for super admin', created.status === 200 && created.body.data.organization.key === GAMMA_KEY);
  const dup = await callAdmin(superT, 'org.create', { key: GAMMA_KEY, name: 'Dup' });
  check('duplicate org key rejected', dup.status === 409 && dup.body.error.code === 'ORG_KEY_TAKEN');
  const { data: branding } = await admin.from('organization_branding')
    .select('organization_id').eq('organization_id', created.body.data.organization.id);
  check('branding row created with org', (branding ?? []).length === 1);
}

const { data: gamma } = await admin.from('organizations').select().eq('key', GAMMA_KEY).single();

// --- org.update / org.set-branding ---
{
  const stale = await callAdmin(superT, 'org.update', { orgId: gamma.id, expectedVersion: 999, name: 'Nope' });
  check('org.update with stale version conflicts', stale.status === 409 && stale.body.error.code === 'CONFLICT');
  const ok = await callAdmin(superT, 'org.update', { orgId: gamma.id, expectedVersion: gamma.version, name: 'Gamma Renamed' });
  check('org.update succeeds with fresh version', ok.status === 200 && ok.body.data.organization.name === 'Gamma Renamed');
  const crossOrg = await callAdmin(betaT, 'org.update', {
    orgId: gamma.id, expectedVersion: ok.body.data.organization.version, name: 'Hijack',
  });
  check('other-org HR cannot update gamma', crossOrg.status === 403 && crossOrg.body.error.code === 'FORBIDDEN');
  const brand = await callAdmin(superT, 'org.set-branding', {
    orgId: gamma.id, expectedVersion: 1, payload: { logoUrl: null, primaryColor: '#334155' },
  });
  check('org.set-branding succeeds', brand.status === 200 && brand.body.data.branding.payload.primaryColor === '#334155');
  const empTry = await callAdmin(empT, 'org.update', { orgId: gamma.id, expectedVersion: 2, name: 'Emp' });
  check('employee cannot call org actions', empTry.status === 403);
}

// --- cycle.create-draft ---
let cycle;
{
  const denied = await callAdmin(empT, 'cycle.create-draft', {
    orgId: gamma.id, name: 'FY27 Gamma Cycle', frameworkId: 'kra-kpi',
  });
  check('cycle.create-draft denied for employee', denied.status === 403);
  const created = await callAdmin(superT, 'cycle.create-draft', {
    orgId: gamma.id, name: 'FY27 Gamma Cycle', periodLabel: 'FY 2027-28', frameworkId: 'kra-kpi',
  });
  check('cycle.create-draft succeeds', created.status === 200 && created.body.data.cycle.status === 'draft');
  cycle = created.body.data.cycle;
  const second = await callAdmin(superT, 'cycle.create-draft', {
    orgId: gamma.id, name: 'Second Working', frameworkId: 'kra',
  });
  check('second working cycle rejected', second.status === 409 && second.body.error.code === 'WORKING_CYCLE_EXISTS');
  const { data: snapRows } = await admin.from('cycle_config_snapshots').select('id').eq('cycle_id', cycle.id);
  const { data: acRows } = await admin.from('cycle_admin_config').select('id').eq('cycle_id', cycle.id);
  check('snapshot + admin-config rows created with draft', (snapRows ?? []).length === 1 && (acRows ?? []).length === 1);
}

// --- cycle.save-section: every section round-trips ---
{
  let v = cycle.version;
  const save = async (section, body) => {
    const res = await callAdmin(superT, 'cycle.save-section', {
      orgId: gamma.id, cycleId: cycle.id, cycleVersion: v, section, ...body,
    });
    assert.equal(res.status, 200, `save ${section}: ${JSON.stringify(res.body)}`);
    v = res.body.data.cycle.version;
    return res.body.data.rows;
  };

  check('perspectives save', await save('perspectives', { rows: [
    { name: 'Financial', weight: 40, color: '#3b82f6', displayOrder: 0 },
    { name: 'Customer', weight: 60, color: '#8b5cf6', displayOrder: 1 },
  ] }) === 2);

  check('groups save (with segments + assignment slots)', await save('groups', { rows: [
    { name: 'Sales', segmentAttr: 'Department', segmentValues: ['Sales', 'Field Sales'],
      canEditOwnGoals: true, hasLibrary: true, targetLevel: 'kpi', ratingLevel: 'kpi',
      libraryAssignments: [{ slotKey: 'primary', slotLabel: 'Primary library', goalLibraryId: null }] },
    { name: 'Everyone Else', isCatchAll: true, targetLevel: 'kra', ratingLevel: 'kra' },
  ] }) === 2);

  const { data: segRows } = await admin.from('cycle_group_segment_values').select('id').eq('cycle_id', cycle.id);
  check('segment values written', (segRows ?? []).length === 2);

  check('target_types save', await save('target_types', { rows: [
    { key: 'number', name: 'Number', isNumeric: true },
    { key: 'percent', name: 'Percentage', isNumeric: true, unit: '%', unitPosition: 'suffix', lowerIsBetter: false },
  ] }) === 2);

  check('rating_scale_levels save', await save('rating_scale_levels', { rows: [
    { point: 1, label: 'Needs Improvement', code: 'NI', rangeFrom: 0, rangeTo: 39 },
    { point: 2, label: 'Developing', code: 'DE', rangeFrom: 40, rangeTo: 59 },
    { point: 3, label: 'Meets Expectations', code: 'ME', rangeFrom: 60, rangeTo: 79 },
    { point: 4, label: 'Exceeds', code: 'EX', rangeFrom: 80, rangeTo: 94 },
    { point: 5, label: 'Outstanding', code: 'OU', rangeFrom: 95, rangeTo: 100 },
  ] }) === 5);

  check('auto_rating_bands save', await save('auto_rating_bands', { rows: [
    { fromPercent: 0, toPercent: 59, score: 2 },
    { fromPercent: 60, toPercent: 94, score: 3.5 },
    { fromPercent: 95, toPercent: 200, score: 5 },
  ] }) === 3);

  const badBand = await callAdmin(superT, 'cycle.save-section', {
    orgId: gamma.id, cycleId: cycle.id, cycleVersion: v, section: 'auto_rating_bands',
    rows: [{ fromPercent: 50, toPercent: 10, score: 1 }],
  });
  check('inverted auto-rating band rejected', badBand.status === 400 && badBand.body.error.code === 'BAD_REQUEST');
  // Validation failures (400) do not consume a version bump (validate-first); we
  // still re-read the fresh version from the DB as belt-and-braces.
  const { data: cycNow } = await admin.from('appraisal_cycles').select('version').eq('id', cycle.id).single();
  v = cycNow.version;

  check('goal_rules save (cycle-wide + per-group)', await save('goal_rules', { rows: [
    { groupName: null, minKras: 3, maxKras: 6, maxKpisPerKra: 4, minKpiWeight: 5, approvalRequired: true },
    { groupName: 'Sales', minKras: 2, maxKras: 5, employeeCanAddGoals: true, maxEmployeeAddedGoals: 2 },
  ] }) === 2);

  const badRule = await callAdmin(superT, 'cycle.save-section', {
    orgId: gamma.id, cycleId: cycle.id, cycleVersion: v, section: 'goal_rules',
    rows: [{ groupName: 'No Such Group', minKras: 1 }],
  });
  check('goal rule with unknown group rejected', badRule.status === 400);
  {
    const { data: cycNow2 } = await admin.from('appraisal_cycles').select('version').eq('id', cycle.id).single();
    v = cycNow2.version;
  }

  check('competency_config save', await save('competency_config', { config: {
    enabled: true, maxPerEmployee: 4, competencyWeight: 20, ratedBy: 'manager',
    allowSelfRate: false, employeeCanEdit: false, scope: 'group',
  } }) === 1);

  check('competency_assignments save', await save('competency_assignments', { rows: [
    { groupName: 'Sales', competencyName: 'Customer Focus', kraShare: 80, competencyShare: 20 },
    { groupName: null, competencyName: 'Integrity' },
  ] }) === 2);

  check('bell_curve_bands save', await save('bell_curve_bands', { rows: [
    { ratingPoint: 2, targetPercent: 10, tolerancePercent: 5 },
    { ratingPoint: 3, targetPercent: 60, tolerancePercent: 10 },
    { ratingPoint: 5, targetPercent: 10, tolerancePercent: 5 },
  ] }) === 3);

  const stale = await callAdmin(superT, 'cycle.save-section', {
    orgId: gamma.id, cycleId: cycle.id, cycleVersion: 1, section: 'perspectives', rows: [],
  });
  check('stale cycleVersion conflicts', stale.status === 409 && stale.body.error.code === 'CONFLICT');

  cycle.version = v;
}

// --- windows, snapshot, admin config ---
{
  const win = await callAdmin(superT, 'cycle.set-windows', {
    orgId: gamma.id, cycleId: cycle.id, cycleVersion: cycle.version,
    windows: [
      { key: 'goal_creation', startsOn: '2027-04-01', endsOn: '2027-04-20' },
      { key: 'manager_approval', startsOn: '2027-04-15', endsOn: '2027-04-30' },
      { key: 'self_evaluation', startsOn: '2028-02-01', endsOn: '2028-02-28' },
      { key: 'manager_evaluation', startsOn: '2028-02-20', endsOn: '2028-03-15' },
      { key: 'hod_review', startsOn: '2028-03-10', endsOn: '2028-03-25' },
      { key: 'hr_calibration', startsOn: '2028-03-20', endsOn: '2028-04-05' },
      { key: 'publishing_prep', startsOn: '2028-04-01', endsOn: '2028-04-10' },
      { key: 'acknowledgement', startsOn: '2028-04-10', endsOn: '2028-04-25' },
    ],
  });
  check('set-windows saves all 8 (overlaps allowed)', win.status === 200 && win.body.data.rows === 8);
  cycle.version = win.body.data.cycle.version;

  const badKey = await callAdmin(superT, 'cycle.set-windows', {
    orgId: gamma.id, cycleId: cycle.id, cycleVersion: cycle.version,
    windows: [{ key: 'lunch_break', startsOn: '2027-04-01', endsOn: '2027-04-02' }],
  });
  check('unknown window key rejected', badKey.status === 400);

  const snap = await callAdmin(superT, 'cycle.set-snapshot-block', {
    orgId: gamma.id, cycleId: cycle.id, snapshotVersion: 1, block: 'visibility',
    data: { manager_rating_visible: 'after_publish', final_rating_visible: 'after_publish' },
  });
  check('snapshot visibility block saves', snap.status === 200);

  const badVis = await callAdmin(superT, 'cycle.set-snapshot-block', {
    orgId: gamma.id, cycleId: cycle.id, snapshotVersion: 2, block: 'visibility',
    data: { manager_rating_visible: 'whenever', final_rating_visible: 'never' },
  });
  check('invalid visibility value rejected', badVis.status === 400);

  const ac = await callAdmin(superT, 'cycle.set-admin-config', {
    orgId: gamma.id, cycleId: cycle.id, adminConfigVersion: 1, block: 'bell',
    data: { enabled: true, mode: 'org', preset: 'standard' },
  });
  check('admin-config bell block saves', ac.status === 200);
}

// --- lock stages ---
{
  await admin.from('appraisal_cycles').update({ status: 'active' }).eq('id', cycle.id);
  const { data: cycNow } = await admin.from('appraisal_cycles').select('version').eq('id', cycle.id).single();
  const locked = await callAdmin(superT, 'cycle.save-section', {
    orgId: gamma.id, cycleId: cycle.id, cycleVersion: cycNow.version, section: 'perspectives', rows: [],
  });
  check('save-section locked once active', locked.status === 409 && locked.body.error.code === 'CYCLE_LOCKED');
  const winLive = await callAdmin(superT, 'cycle.set-windows', {
    orgId: gamma.id, cycleId: cycle.id, cycleVersion: cycNow.version,
    windows: [{ key: 'acknowledgement', startsOn: '2028-04-10', endsOn: '2028-05-01' }],
  });
  check('windows still editable while active (calendar governs)', winLive.status === 200);
  await admin.from('appraisal_cycles').update({ status: 'archived', archived_at: new Date().toISOString() }).eq('id', cycle.id);
  const { data: cycArch } = await admin.from('appraisal_cycles').select('version').eq('id', cycle.id).single();
  const winArch = await callAdmin(superT, 'cycle.set-windows', {
    orgId: gamma.id, cycleId: cycle.id, cycleVersion: cycArch.version,
    windows: [{ key: 'acknowledgement', startsOn: '2028-04-10', endsOn: '2028-05-01' }],
  });
  check('windows locked once archived', winArch.status === 409 && winArch.body.error.code === 'CYCLE_LOCKED');
}

// --- audit trail exists ---
{
  const { data: audits } = await admin.from('audit_logs')
    .select('action').eq('organization_id', gamma.id);
  check('audit rows written for admin actions', (audits ?? []).length >= 15);
}

// --- groups resave cascade-resets dependent per-group rows (documented behavior) ---
{
  const { data: beforeCa } = await admin.from('cycle_competency_assignments')
    .select('id').eq('cycle_id', cycle.id).not('group_id', 'is', null);
  check('group-scoped competency assignments exist before groups resave', (beforeCa ?? []).length === 1);
  // cycle is archived by the lock-stage section; use a status flip to allow one more save
  await admin.from('appraisal_cycles').update({ status: 'draft' }).eq('id', cycle.id);
  const { data: cycV } = await admin.from('appraisal_cycles').select('version').eq('id', cycle.id).single();
  const resave = await callAdmin(superT, 'cycle.save-section', {
    orgId: gamma.id, cycleId: cycle.id, cycleVersion: cycV.version, section: 'groups',
    rows: [{ name: 'Sales', targetLevel: 'kpi', ratingLevel: 'kpi' }],
  });
  check('groups resave succeeds', resave.status === 200);
  const { data: afterCa } = await admin.from('cycle_competency_assignments')
    .select('id').eq('cycle_id', cycle.id).not('group_id', 'is', null);
  check('groups resave cascade-cleared group-scoped competency assignments', (afterCa ?? []).length === 0);
  await admin.from('appraisal_cycles').update({ status: 'archived' }).eq('id', cycle.id);
}

// --- role denial inside one's own org ---
{
  const { data: acme } = await admin.from('organizations').select('id, version').eq('key', 'acme-test').single();
  const ownOrg = await callAdmin(empT, 'org.update', {
    orgId: acme.id, expectedVersion: acme.version, name: 'Employee Rename Attempt',
  });
  check('employee denied org.update in own org (role check)', ownOrg.status === 403 && ownOrg.body.error.code === 'FORBIDDEN');
}

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

  const second = await callAdmin(superT, 'library.save', { orgId: gamma.id, name: 'Second Lib', items: [] });
  const rename = await callAdmin(superT, 'library.save', {
    orgId: gamma.id, libraryId: second.body.data.library.id,
    expectedVersion: second.body.data.library.version, name: 'Sales Playbook', items: [],
  });
  check('rename to an existing library name returns 409', rename.status === 409 && rename.body.error.code === 'LIBRARY_NAME_TAKEN');

  const orphan = await callAdmin(superT, 'library.save', {
    orgId: gamma.id, name: 'Orphan Test', items: [{ itemType: 'kpi', key: 'x', parentKey: 'ghost', title: 'X' }],
  });
  check('bad-payload library.save rejected before header write', orphan.status === 400);
  const { data: orphanRows } = await admin.from('goal_libraries').select('id').eq('organization_id', gamma.id).eq('name', 'Orphan Test');
  check('no orphan library header left behind on bad payload', (orphanRows ?? []).length === 0);

  const empDenied = await callAdmin(empT, 'library.list', { orgId: gamma.id });
  check('employee cannot list libraries', empDenied.status === 403);
}

console.log(`admin-check: PASS (${n} assertions)`);
