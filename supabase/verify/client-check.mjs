// Run: node supabase/verify/seed-foundation.mjs && node supabase/verify/client-check.mjs
// Exercises the browser client contract against the live backend, as a browser would:
// signInWithPassword (via the anon client) → whoami → deriveIdentity → a callWorkflow round-trip.
import assert from 'node:assert/strict';
import { signIn, SUPABASE_URL } from './_clients.mjs';
import { USERS, PASSWORD } from './seed-foundation.mjs';
import { deriveIdentity } from '../../src/backend/identity.js';
// The REAL browser client — exercised below with a PAYLOADED call so the wire-format
// contract ({action, payload} nested) is validated end-to-end, not just the backend.
import { postAction } from '../../src/backend/pmsClientCore.js';

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

// WIRE-FORMAT GUARD (regression: the client once sent {action, ...payload} spread, so the
// backend — which reads nested `body.payload` — saw an EMPTY payload for every payloaded
// action, silently breaking goal.context/save-items/org.create/etc. in the browser while the
// gate's own nested helpers stayed green). Exercise the REAL `postAction` with a payloaded
// call: if it reverts to spread, the backend can't see `orgId`, `goal.context` throws
// BAD_REQUEST, postAction rejects, and this assertion fails.
{
  const { session } = await signIn(USERS.employee, PASSWORD);
  const w = await callFn('pms-admin', session.access_token, 'admin.whoami');
  const orgId = w.body?.data?.memberships?.[0]?.organizationId;
  check('employee has an orgId for the payloaded-client check', typeof orgId === 'string' && orgId.length > 0);
  let ctx = null; let threw = null;
  try {
    ctx = await postAction({ baseUrl: SUPABASE_URL, fnName: 'pms-workflow', action: 'goal.context', payload: { orgId }, token: session.access_token });
  } catch (e) { threw = e; }
  check('REAL frontend postAction delivers a payloaded call (goal.context {orgId}) — {action,payload} nested wire format', !threw && ctx && typeof ctx === 'object' && ('cycle' in ctx || 'participant' in ctx));
}

console.log(`client-check: PASS (${n} assertions)`);
