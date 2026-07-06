// Run: node supabase/verify/seed-foundation.mjs && node supabase/verify/rls-check.mjs
// Proves the RLS contract: anon = nothing; employee/manager/HOD = scoped rows;
// HR = whole org; browser writes to business tables = denied; version bump + working-cycle constraint work.
import assert from 'node:assert/strict';
import { anonClient, signIn, adminClient } from './_clients.mjs';
import { USERS, PASSWORD, ORG_KEY, ORG_B_KEY } from './seed-foundation.mjs';

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
  const { data: bands } = await client.from('cycle_bell_curve_bands').select('id');
  check('HR sees the seeded bell band', (bands ?? []).length === 1);
  const { data: pfi } = await client.from('prefill_dataset_items').select('id');
  check('HR sees the seeded prefill item', (pfi ?? []).length === 1);
  const { data: audit, error: auditErr } = await client.from('audit_logs').select('id').limit(5);
  check('HR reads the seeded audit row', auditErr === null && (audit ?? []).length >= 1);
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

// --- draft evaluations are private to their author (+ HR) ---
{
  const { data: eve } = await admin.from('employees')
    .select('id').eq('organization_id', org.id).eq('employee_code', 'EMP002').single();
  const { data: cyc } = await admin.from('appraisal_cycles')
    .select('id').eq('organization_id', org.id).eq('status', 'draft').single();
  await admin.from('evaluations').delete().eq('cycle_id', cyc.id).eq('employee_id', eve.id);
  const { data: draftEval, error: draftErr } = await admin.from('evaluations').insert({
    organization_id: org.id, cycle_id: cyc.id, employee_id: eve.id, stage: 'self', status: 'draft',
  }).select().single();
  assert.equal(draftErr, null, draftErr?.message);
  const { client: eveC } = await signIn(USERS.employee, PASSWORD);
  const { data: eveSees } = await eveC.from('evaluations').select('id');
  check('employee sees own draft self-evaluation', (eveSees ?? []).length === 1);
  const { client: maryC } = await signIn(USERS.manager, PASSWORD);
  const { data: maryDraft } = await maryC.from('evaluations').select('id');
  check('manager cannot see report draft self-evaluation', (maryDraft ?? []).length === 0);
  await admin.from('evaluations')
    .update({ status: 'submitted', submitted_at: new Date().toISOString() }).eq('id', draftEval.id);
  const { data: marySubmitted } = await maryC.from('evaluations').select('id');
  check('manager sees report submitted self-evaluation', (marySubmitted ?? []).length === 1);
  await admin.from('evaluations').update({ status: 'draft' }).eq('id', draftEval.id);
  const { client: hrC } = await signIn(USERS.hr, PASSWORD);
  const { data: hrSees } = await hrC.from('evaluations').select('id');
  check('HR sees draft evaluations', (hrSees ?? []).length === 1);
  await admin.from('evaluations').delete().eq('id', draftEval.id);
}

// --- manager-stage drafts are private to the manager (author) ---
{
  const { data: eve } = await admin.from('employees')
    .select('id').eq('organization_id', org.id).eq('employee_code', 'EMP002').single();
  const { data: cyc } = await admin.from('appraisal_cycles')
    .select('id').eq('organization_id', org.id).eq('status', 'draft').single();
  await admin.from('evaluations').delete().eq('cycle_id', cyc.id).eq('employee_id', eve.id);
  const { data: mgrEval, error: mgrErr } = await admin.from('evaluations').insert({
    organization_id: org.id, cycle_id: cyc.id, employee_id: eve.id, stage: 'manager', status: 'draft',
  }).select().single();
  assert.equal(mgrErr, null, mgrErr?.message);
  const { client: maryC } = await signIn(USERS.manager, PASSWORD);
  const { data: marySees } = await maryC.from('evaluations').select('id');
  check('manager sees own draft manager evaluation', (marySees ?? []).length === 1);
  const { client: hodC } = await signIn(USERS.hod, PASSWORD);
  const { data: hodSees } = await hodC.from('evaluations').select('id');
  check('HOD cannot see draft manager evaluation (author-only)', (hodSees ?? []).length === 0);
  const { client: eveC } = await signIn(USERS.employee, PASSWORD);
  const { data: eveSeesDraft } = await eveC.from('evaluations').select('id');
  check('employee cannot see draft manager evaluation', (eveSeesDraft ?? []).length === 0);
  await admin.from('evaluations')
    .update({ status: 'submitted', submitted_at: new Date().toISOString() }).eq('id', mgrEval.id);
  const { data: hodSubmitted } = await hodC.from('evaluations').select('id');
  check('HOD sees submitted manager evaluation', (hodSubmitted ?? []).length === 1);
  const { data: eveSubmitted } = await eveC.from('evaluations').select('id');
  check('employee still cannot see manager evaluation before publish (after_publish)', (eveSubmitted ?? []).length === 0);
  await admin.from('evaluations').delete().eq('id', mgrEval.id);
}

// --- disabled membership suspends scoped reads ---
{
  const { data: eveEmp } = await admin.from('employees')
    .select('user_id').eq('organization_id', org.id).eq('employee_code', 'EMP002').single();
  await admin.from('org_members').update({ status: 'disabled' })
    .eq('organization_id', org.id).eq('user_id', eveEmp.user_id);
  const { client: eveC } = await signIn(USERS.employee, PASSWORD);
  const { data: whileDisabled } = await eveC.from('employees').select('id');
  check('disabled member reads no roster rows', (whileDisabled ?? []).length === 0);
  await admin.from('org_members').update({ status: 'active' })
    .eq('organization_id', org.id).eq('user_id', eveEmp.user_id);
  const { client: eveC2 } = await signIn(USERS.employee, PASSWORD);
  const { data: reEnabled } = await eveC2.from('employees').select('id');
  check('re-activated member reads roster rows again', (reEnabled ?? []).length === 3);
}

// --- cycle_admin_config is HR-only ---
{
  const { data: cyc } = await admin.from('appraisal_cycles')
    .select('id').eq('organization_id', org.id).eq('status', 'draft').single();
  await admin.from('cycle_admin_config').delete().eq('cycle_id', cyc.id);
  const { error: cfgErr } = await admin.from('cycle_admin_config').insert({
    organization_id: org.id, cycle_id: cyc.id,
    payload: { bell: { enabled: true, mode: 'org', preset: 'standard' } },
  });
  assert.equal(cfgErr, null, cfgErr?.message);
  const { client: eveC } = await signIn(USERS.employee, PASSWORD);
  const { data: eveCfg, error: eveCfgErr } = await eveC.from('cycle_admin_config').select('id');
  check('employee cannot read cycle_admin_config', eveCfgErr !== null || (eveCfg ?? []).length === 0);
  const { client: hrC } = await signIn(USERS.hr, PASSWORD);
  const { data: hrCfg } = await hrC.from('cycle_admin_config').select('id');
  check('HR reads cycle_admin_config', (hrCfg ?? []).length === 1);
}

// --- RPC hardening: helper functions must not act as a cross-org oracle ---
{
  const { client } = await signIn(USERS.employee, PASSWORD);
  const { data, error } = await client.rpc('stage_visible', {
    p_cycle: '00000000-0000-0000-0000-000000000000',
    p_key: 'manager_rating_visible',
  });
  check('rpc stage_visible answers false (never null) for foreign cycle', error === null && data === false);
  const anon = anonClient();
  const { error: anonErr } = await anon.rpc('stage_visible', {
    p_cycle: '00000000-0000-0000-0000-000000000000',
    p_key: 'manager_rating_visible',
  });
  check('anon cannot call pms rpc helpers', anonErr !== null);
}

// --- cross-tenant isolation: org B (beta-test) rows must never leak into org A queries ---
{
  const { client: betaClient } = await signIn(USERS.beta, PASSWORD);
  const { data: betaEmps } = await betaClient.from('employees').select('employee_code');
  const betaCodes = (betaEmps ?? []).map((e) => e.employee_code).sort();
  check('beta user sees only BETA001 (org A roster invisible)', JSON.stringify(betaCodes) === JSON.stringify(['BETA001']));

  const { data: betaOrgs } = await betaClient.from('organizations').select('key');
  const betaOrgKeys = (betaOrgs ?? []).map((o) => o.key);
  check('beta user sees beta-test org', betaOrgKeys.includes(ORG_B_KEY));
  check('beta user cannot see acme-test org', !betaOrgKeys.includes(ORG_KEY));

  const { data: betaWindows } = await betaClient.from('cycle_phase_windows').select('id');
  check('beta user sees no org A phase windows', (betaWindows ?? []).length === 0);
}

// --- org A HR must not see org B's org or roster row ---
{
  const { client } = await signIn(USERS.hr, PASSWORD);
  const { data: hrOrgs } = await client.from('organizations').select('key');
  check('org A HR does not see beta-test org', !(hrOrgs ?? []).some((o) => o.key === ORG_B_KEY));
  const { data: hrEmps } = await client.from('employees').select('employee_code');
  check('org A HR does not see BETA001', !(hrEmps ?? []).some((e) => e.employee_code === 'BETA001'));
}

// --- super admin: sees every org, not just its own ---
{
  const { client } = await signIn(USERS.superadmin, PASSWORD);
  const { data: orgs } = await client.from('organizations').select('key');
  const keys = (orgs ?? []).map((o) => o.key);
  check('super admin sees acme-test and beta-test', keys.includes(ORG_KEY) && keys.includes(ORG_B_KEY));
}

// --- notifications.read_at: the one allowed client write ---
{
  const { data: eveRow } = await admin.from('employees').select('user_id')
    .eq('organization_id', org.id).eq('employee_code', 'EMP002').single();
  const { data: eveMember } = await admin.from('org_members').select('id')
    .eq('organization_id', org.id).eq('user_id', eveRow.user_id).single();
  // Reset so re-runs against a not-freshly-reseeded org stay deterministic.
  await admin.from('notifications').delete().eq('recipient_member_id', eveMember.id);
  const { error: notifInsErr } = await admin.from('notifications').insert({
    organization_id: org.id, recipient_member_id: eveMember.id, type: 'test', title: 'Seed note',
  });
  assert.equal(notifInsErr, null, notifInsErr?.message);

  const { client: eveClient } = await signIn(USERS.employee, PASSWORD);
  const { data: eveNotifs } = await eveClient.from('notifications').select('id, read_at');
  check('Eve sees exactly 1 notification', (eveNotifs ?? []).length === 1);
  const notifId = eveNotifs[0].id;

  const { data: markRead, error: markErr } = await eveClient.from('notifications')
    .update({ read_at: new Date().toISOString() }).eq('id', notifId).select();
  check('Eve can mark her notification read', markErr === null && (markRead ?? [])[0]?.read_at != null);

  const { error: hackErr } = await eveClient.from('notifications')
    .update({ title: 'hacked' }).eq('id', notifId).select();
  check('Eve cannot update notification title (column grant)', hackErr !== null);

  const { client: betaNotifClient } = await signIn(USERS.beta, PASSWORD);
  const { data: betaNotifs } = await betaNotifClient.from('notifications').select('id');
  check('beta user sees 0 notifications', (betaNotifs ?? []).length === 0);
  const { data: betaUpd } = await betaNotifClient.from('notifications')
    .update({ read_at: new Date().toISOString() }).eq('id', notifId).select();
  check("beta user updating Eve's notification has no effect", (betaUpd ?? []).length === 0);
}

// --- archived-cycle allowance: partial unique index only guards non-archived cycles ---
{
  const { error: archivedErr } = await admin.from('appraisal_cycles').insert({
    organization_id: org.id, name: 'Old Archived Cycle', framework_id: 'kra',
    status: 'archived', archived_at: new Date().toISOString(),
  });
  check('archived cycle insert succeeds alongside the working cycle', archivedErr === null);
}

console.log(`rls-check: PASS (${n} assertions)`);
