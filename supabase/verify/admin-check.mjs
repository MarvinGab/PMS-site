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

// --- org.list (super-admin directory read) ---
{
  const denied = await callAdmin(hrT, 'org.list', {});
  check('org.list denied for non-super-admin (HR)', denied.status === 403 && denied.body.error.code === 'FORBIDDEN');
  const empDenied = await callAdmin(empT, 'org.list', {});
  check('org.list denied for employee', empDenied.status === 403 && empDenied.body.error.code === 'FORBIDDEN');

  const listed = await callAdmin(superT, 'org.list', {});
  check('org.list succeeds for super admin', listed.status === 200 && Array.isArray(listed.body.data.organizations));
  const orgs = listed.body.data.organizations;
  check('org.list includes the acme-test and beta-test seed orgs', orgs.some((o) => o.key === 'acme-test') && orgs.some((o) => o.key === 'beta-test'));
  check('org.list rows carry string key/name + boolean launched + numeric cycleCount', orgs.every((o) =>
    typeof o.key === 'string' && typeof o.name === 'string' && typeof o.launched === 'boolean' && typeof o.cycleCount === 'number'));

  // gamma-test was just created above and has no cycles yet — a fully deterministic zero-state row.
  const gammaRow = orgs.find((o) => o.key === GAMMA_KEY);
  check('org.list shows freshly-created gamma-test with a zero-cycle summary', !!gammaRow &&
    gammaRow.cycleCount === 0 && gammaRow.launched === false &&
    gammaRow.activeCycleStatus === null && gammaRow.participantCount === 0);
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

  const dupRows = [{ employeeCode: 'G200', fullName: 'Dup Email', email: 'bea@x.com', groupName: 'Sales' }];
  const dupVal = await callAdmin(superT, 'import.validate-roster', { orgId: gamma.id, rows: dupRows });
  const dupCommit = await callAdmin(superT, 'import.commit-roster', { orgId: gamma.id, importRunId: dupVal.body.data.importRun.id, rows: dupRows });
  check('duplicate email vs existing employee → 409', dupCommit.status === 409 && dupCommit.body.error.code === 'IMPORT_EMAIL_TAKEN');
}

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
  const bea = list.body.data.participants.find((p) => p.employees.employee_code === 'G100');

  // dedup: duplicate codes in one call must not collide on the unique constraint (no 500)
  const dedup = await callAdmin(superT, 'cycle.add-participants', {
    orgId: gamma.id, cycleId: pcycle.id, employeeCodes: ['G100', 'G100'],
  });
  check('add-participants dedups duplicate codes (no unique-constraint 500)', dedup.status === 200);

  const assign = await callAdmin(superT, 'cycle.assign-participant', {
    orgId: gamma.id, cycleId: pcycle.id, participantId: rita.id, groupName: 'Sales', goalLibraryName: 'Sales Playbook',
  });
  check('assign-participant resolves group + library', assign.status === 200 && assign.body.data.assignment.group_id !== null);

  // merge: assigning only a group then only a library must preserve the group
  const beaGroupOnly = await callAdmin(superT, 'cycle.assign-participant', {
    orgId: gamma.id, cycleId: pcycle.id, participantId: bea.id, groupName: 'Sales',
  });
  check('assign-participant with only group succeeds', beaGroupOnly.status === 200);
  const beaLibOnly = await callAdmin(superT, 'cycle.assign-participant', {
    orgId: gamma.id, cycleId: pcycle.id, participantId: bea.id, goalLibraryName: 'Sales Playbook',
  });
  check('assign-participant with only library succeeds', beaLibOnly.status === 200);
  const { data: beaAssign } = await admin.from('cycle_participant_assignments').select('group_id, goal_library_id').eq('participant_id', bea.id).single();
  check('assign-participant merges (group preserved when only library set)', (beaAssign?.group_id ?? null) !== null && (beaAssign?.goal_library_id ?? null) !== null);

  const badGroup = await callAdmin(superT, 'cycle.assign-participant', {
    orgId: gamma.id, cycleId: pcycle.id, participantId: rita.id, groupName: 'Ghost Group',
  });
  check('assign-participant rejects unknown group', badGroup.status === 400);

  const remove = await callAdmin(superT, 'cycle.remove-participant', {
    orgId: gamma.id, cycleId: pcycle.id, participantId: rita.id, expectedVersion: rita.version,
  });
  check('remove-participant sets status removed', remove.status === 200 && remove.body.data.participant.status === 'removed');

  // reactivate: re-adding a removed participant flips them back to active
  const reactivate = await callAdmin(superT, 'cycle.add-participants', {
    orgId: gamma.id, cycleId: pcycle.id, employeeCodes: ['G101'],
  });
  check('add-participants reactivates a removed participant', reactivate.status === 200 && reactivate.body.data.reactivated >= 1);
  const relist = await callAdmin(superT, 'cycle.list-participants', { orgId: gamma.id, cycleId: pcycle.id });
  const ritaAgain = relist.body.data.participants.find((p) => p.employees.employee_code === 'G101');
  check('reactivated participant is active again', ritaAgain?.status === 'active');

  // stash pcycle id for Task 5/6 by re-reading in those sections via admin
}

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

  // downgrade guard: an employee whose member is already 'active' must NOT be
  // flipped back to 'invited' by a (re-)invite — that would lock them out.
  async function ensureAuthUser(email) {
    const { data: list } = await admin.auth.admin.listUsers({ perPage: 1000 });
    const found = list.users.find((u) => u.email === email);
    if (found) return found.id;
    const { data } = await admin.auth.admin.createUser({ email, password: 'Passw0rd!dg', email_confirm: true });
    return data.user.id;
  }
  {
    const dgId = await ensureAuthUser('gamma-active@example.com');
    await admin.from('org_members').delete().eq('organization_id', gamma.id).eq('user_id', dgId);
    await admin.from('org_members').insert({ organization_id: gamma.id, user_id: dgId, roles: ['hr_admin'], status: 'active' });
    await admin.from('employees').delete().eq('organization_id', gamma.id).eq('employee_code', 'GDG1');
    await admin.from('employees').insert({ organization_id: gamma.id, employee_code: 'GDG1', full_name: 'Active Amy', email: 'gamma-active@example.com', group_name: 'Sales', user_id: null });
    await callAdmin(superT, 'cycle.add-participants', { orgId: gamma.id, cycleId: pcycle.id, employeeCodes: ['GDG1'] });
    await callAdmin(superT, 'cycle.invite-participants', { orgId: gamma.id, cycleId: pcycle.id });
    const { data: dgMember } = await admin.from('org_members').select('status').eq('organization_id', gamma.id).eq('user_id', dgId).single();
    check('invite does not downgrade an already-active member', dgMember.status === 'active');
  }
}

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

// --- publishing: bell-check, publish (blocked/forced), revoke ---
{
  // Build a review-status gamma cycle with 2 participants who both have submitted hr_final finals.
  await admin.from('appraisal_cycles').update({ status: 'archived', archived_at: new Date().toISOString() }).eq('organization_id', gamma.id).neq('status', 'archived');
  const { data: pcycle } = await admin.from('appraisal_cycles').insert({ organization_id: gamma.id, name: 'Publish Cycle', framework_id: 'kra', status: 'review' }).select().single();
  await admin.from('cycle_rating_scale_levels').insert([
    { organization_id: gamma.id, cycle_id: pcycle.id, point: 3, label: 'Meets', range_from: 60, range_to: 89 },
    { organization_id: gamma.id, cycle_id: pcycle.id, point: 5, label: 'Exceeds', range_from: 90, range_to: 200 },
  ]);
  // Bell bands demanding a 50/50 split with 0 tolerance — two people both at 5 will VIOLATE.
  await admin.from('cycle_bell_curve_bands').insert([
    { organization_id: gamma.id, cycle_id: pcycle.id, rating_point: 3, target_percent: 50, tolerance_percent: 0 },
    { organization_id: gamma.id, cycle_id: pcycle.id, rating_point: 5, target_percent: 50, tolerance_percent: 0 },
  ]);
  // Two employees, both participants, each a submitted hr_final at score 5.
  const empIds = [];
  for (const code of ['PUB1', 'PUB2']) {
    const { data: e } = await admin.from('employees').upsert({ organization_id: gamma.id, employee_code: code, full_name: code, email: `${code.toLowerCase()}@x.com`, group_name: 'Sales' }, { onConflict: 'organization_id,employee_code' }).select().single();
    empIds.push(e.id);
    await admin.from('cycle_participants').insert({ organization_id: gamma.id, cycle_id: pcycle.id, employee_id: e.id });
    await admin.from('evaluations').insert({ organization_id: gamma.id, cycle_id: pcycle.id, employee_id: e.id, stage: 'hr_final', status: 'submitted', overall_score: 5, submitted_at: new Date().toISOString() });
  }

  // A third active participant with NO submitted final must block publish (FINALS_INCOMPLETE).
  const { data: pub3 } = await admin.from('employees').upsert({ organization_id: gamma.id, employee_code: 'PUB3', full_name: 'PUB3', email: 'pub3@x.com', group_name: 'Sales' }, { onConflict: 'organization_id,employee_code' }).select().single();
  await admin.from('cycle_participants').insert({ organization_id: gamma.id, cycle_id: pcycle.id, employee_id: pub3.id });
  const incomplete = await callAdmin(superT, 'publish.publish', { orgId: gamma.id, cycleId: pcycle.id });
  check('publish blocked when a participant has no submitted final', incomplete.status === 409 && incomplete.body.error.code === 'FINALS_INCOMPLETE');
  // Give PUB3 a submitted final at 3 so the remaining assertions proceed (distribution 2@5 + 1@3 is still a bell violation).
  await admin.from('evaluations').insert({ organization_id: gamma.id, cycle_id: pcycle.id, employee_id: pub3.id, stage: 'hr_final', status: 'submitted', overall_score: 3, submitted_at: new Date().toISOString() });

  const bell = await callAdmin(superT, 'publish.bell-check', { orgId: gamma.id, cycleId: pcycle.id });
  check('bell-check reports out of tolerance (both at 5)', bell.status === 200 && bell.body.data.withinTolerance === false);

  // --- publish.review-list: scoped HR read (cycle + bell + publication + participants) ---
  const review = await callAdmin(superT, 'publish.review-list', { orgId: gamma.id, cycleId: pcycle.id });
  check('review-list returns the cycle + all 3 active participants', review.status === 200 && review.body.data.cycle.id === pcycle.id && review.body.data.participants.length === 3);
  check('review-list participant rows carry employeeName + finalStatus', review.body.data.participants.every((p) => typeof p.employeeName === 'string' && ['submitted', 'draft', 'missing'].includes(p.finalStatus)));
  check('review-list bell object mirrors bell-check (out of tolerance)', review.body.data.bell.withinTolerance === false && Array.isArray(review.body.data.bell.rows));
  check('review-list finalsMissing/total are numeric (all 3 finals submitted)', review.body.data.finalsMissing === 0 && review.body.data.total === 3);
  check('review-list publication.live is false before publish', review.body.data.publication.live === false && review.body.data.publication.publishedAt === null);

  const pagedReview = await callAdmin(superT, 'publish.review-list', { orgId: gamma.id, cycleId: pcycle.id, limit: 2, offset: 0 });
  check('review-list paginates (limit=2 of total=3)', pagedReview.status === 200 && pagedReview.body.data.participants.length === 2 && pagedReview.body.data.total === 3);

  // No cycleId → the handler auto-resolves the org's reviewable cycle (gamma's only cycle,
  // currently in review) so the UI needs no separate cycle-discovery read.
  const autoReview = await callAdmin(superT, 'publish.review-list', { orgId: gamma.id });
  check('review-list auto-resolves the review cycle when cycleId is omitted', autoReview.status === 200 && autoReview.body.data.cycle?.id === pcycle.id);

  const empReview = await callAdmin(empT, 'publish.review-list', { orgId: gamma.id, cycleId: pcycle.id });
  check('employee cannot call review-list', empReview.status === 403);

  const blocked = await callAdmin(superT, 'publish.publish', { orgId: gamma.id, cycleId: pcycle.id });
  check('publish blocked by bell-curve violation', blocked.status === 409 && blocked.body.error.code === 'BELL_CURVE_VIOLATION');

  const empBell = await callAdmin(empT, 'publish.bell-check', { orgId: gamma.id, cycleId: pcycle.id });
  check('employee cannot run bell-check', empBell.status === 403);

  const empPub = await callAdmin(empT, 'publish.publish', { orgId: gamma.id, cycleId: pcycle.id });
  check('employee cannot publish', empPub.status === 403);

  const forceBlank = await callAdmin(superT, 'publish.publish', { orgId: gamma.id, cycleId: pcycle.id, force: true, reason: '   ' });
  check('forced publish requires a non-blank reason', forceBlank.status === 400 && forceBlank.body.error.code === 'BAD_REQUEST');

  const forced = await callAdmin(superT, 'publish.publish', { orgId: gamma.id, cycleId: pcycle.id, force: true, reason: 'Exec sign-off' });
  check('publish succeeds with force + reason', forced.status === 200 && forced.body.data.cycle.status === 'published');

  // At this point gamma's only non-archived cycle is pcycle ("Publish Cycle"), now
  // 'published' with 3 active participants (PUB1/PUB2/PUB3) — a fully deterministic
  // check of org.list's launched/activeCycleStatus/cycleCount/participantCount derivation.
  const afterPublishList = await callAdmin(superT, 'org.list', {});
  const gammaAfterPublish = afterPublishList.body.data.organizations.find((o) => o.key === GAMMA_KEY);
  check('org.list reflects gamma as launched+published with 1 cycle and 3 participants', !!gammaAfterPublish &&
    gammaAfterPublish.launched === true && gammaAfterPublish.activeCycleStatus === 'published' &&
    gammaAfterPublish.cycleCount === 1 && gammaAfterPublish.participantCount === 3);

  const reviewAfterPublish = await callAdmin(superT, 'publish.review-list', { orgId: gamma.id, cycleId: pcycle.id });
  check('review-list reflects the live publication after publish', reviewAfterPublish.body.data.publication.live === true && reviewAfterPublish.body.data.publication.publishedAt !== null);

  const { data: pubJob } = await admin.from('background_jobs').select('job_type, status').eq('cycle_id', pcycle.id).eq('job_type', 'publish_notification');
  check('publish enqueues a publish_notification background job', (pubJob ?? []).length === 1 && pubJob[0].status === 'queued');

  const again = await callAdmin(superT, 'publish.publish', { orgId: gamma.id, cycleId: pcycle.id, force: true, reason: 'x' });
  check('re-publish rejected while already published', again.status === 409 && again.body.error.code === 'ALREADY_PUBLISHED');

  const empRevoke = await callAdmin(empT, 'publish.revoke', { orgId: gamma.id, cycleId: pcycle.id, reason: 'x' });
  check('employee cannot revoke', empRevoke.status === 403);

  const revoke = await callAdmin(superT, 'publish.revoke', { orgId: gamma.id, cycleId: pcycle.id, reason: 'Correction needed' });
  check('revoke returns the cycle to review', revoke.status === 200 && revoke.body.data.cycle.status === 'review');

  const revokeAgain = await callAdmin(superT, 'publish.revoke', { orgId: gamma.id, cycleId: pcycle.id, reason: 'x' });
  check('revoke with no live publication rejected', revokeAgain.status === 409 && revokeAgain.body.error.code === 'NOT_PUBLISHED');
}

// --- jobs.enqueue-reminders (HR only) ---
{
  const { data: rc } = await admin.from('appraisal_cycles').select('id').eq('organization_id', gamma.id).order('created_at', { ascending: false }).limit(1).single();
  const denied = await callAdmin(empT, 'jobs.enqueue-reminders', { orgId: gamma.id, cycleId: rc.id, stage: 'self evaluation' });
  check('employee cannot enqueue reminders', denied.status === 403);
  const ok = await callAdmin(superT, 'jobs.enqueue-reminders', { orgId: gamma.id, cycleId: rc.id, stage: 'self evaluation' });
  check('HR enqueues a reminder_batch job', ok.status === 200 && ok.body.data.jobId);
  const { data: rj } = await admin.from('background_jobs').select('job_type').eq('id', ok.body.data.jobId).single();
  check('reminder_batch job created', rj.job_type === 'reminder_batch');
}

console.log(`admin-check: PASS (${n} assertions)`);
