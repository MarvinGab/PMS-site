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

console.log(`admin-check: PASS (${n} assertions)`);
