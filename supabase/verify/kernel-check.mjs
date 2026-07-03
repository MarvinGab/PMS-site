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
