// Run: node supabase/verify/seed-foundation.mjs && node supabase/verify/client-check.mjs
// Exercises the browser client contract against the live backend, as a browser would:
// signInWithPassword (via the anon client) → whoami → deriveIdentity → a callWorkflow round-trip.
import assert from 'node:assert/strict';
import { signIn, SUPABASE_URL } from './_clients.mjs';
import { USERS, PASSWORD } from './seed-foundation.mjs';
import { deriveIdentity } from '../../src/backend/identity.js';

let n = 0;
const check = (d, c) => { n += 1; assert.ok(c, `FAIL: ${d}`); console.log(`ok ${d}`); };
async function callFn(fn, token, action, payload = {}) {
  const res = await fetch(`${SUPABASE_URL}/functions/v1/${fn}`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, ...payload }),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

// Each seeded role signs in, whoami resolves, deriveIdentity yields the expected role.
for (const [key, expected] of [['superadmin', 'super_admin'], ['hr', 'hr_admin'], ['employee', 'employee']]) {
  const { session } = await signIn(USERS[key], PASSWORD);
  const w = await callFn('pms-admin', session.access_token, 'admin.whoami');
  check(`${key}: admin.whoami returns memberships`, w.status === 200 && Array.isArray(w.body?.data?.memberships));
  check(`${key}: deriveIdentity → ${expected}`, deriveIdentity(w.body.data.memberships).role === expected);
}

// callWorkflow round-trip works with the same session token.
const { session: empS } = await signIn(USERS.employee, PASSWORD);
const ww = await callFn('pms-workflow', empS.access_token, 'workflow.whoami');
check('employee: workflow.whoami ok', ww.status === 200 && Array.isArray(ww.body?.data?.memberships));

// A call with NO session bearer is rejected (verify_jwt gateway).
const noTok = await fetch(`${SUPABASE_URL}/functions/v1/pms-admin`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'admin.whoami' }),
});
check('no-session call rejected', noTok.status === 401);

console.log(`client-check: PASS (${n} assertions)`);
