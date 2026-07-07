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

// The end marker; later tasks append sections before this and bump the count.
console.log(`workflow-check: PASS (${n} assertions)`);
