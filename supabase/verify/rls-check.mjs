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

console.log(`rls-check: PASS (${n} assertions)`);
