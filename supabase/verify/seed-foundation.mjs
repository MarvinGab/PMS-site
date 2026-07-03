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
