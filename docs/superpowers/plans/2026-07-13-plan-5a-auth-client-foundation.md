# Plan 5a — Auth & Client-API Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Supabase Auth + backend `whoami` the single source of authentication and authorization for the React app, ship a typed `callPms`/`callWorkflow` client, and add first-login set-password — retiring all homegrown auth — without yet migrating the data screens.

**Architecture:** Pure, node-testable core modules (`identity.js` role-derivation, `pmsClientCore.js` request/error) with browser wiring on top (`pmsClient.js` uses the existing `supabaseClient` session). `AppContext` establishes identity ONLY from the Supabase session → `admin.whoami` → `deriveIdentity`. `LoginPage` uses `supabase.auth.signInWithPassword`; a new `SetPasswordPage` handles recovery/first-login. A Node integration check (`client-check.mjs`) validates the client+seed+whoami contract against the live backend; React UI is validated by that check plus a documented manual browser smoke (the repo has no component test runner and adding one is out of 5a scope).

**Tech Stack:** React 19 + Vite, `@supabase/supabase-js@2`, Node built-in test runner (`node --test`) for pure modules, Node `.mjs` + `node:assert` integration scripts against the live Supabase project `erqeugmibozdjvhqgwai`.

**Spec:** `docs/superpowers/specs/2026-07-13-plan-5a-auth-client-foundation-design.md`.

## Global Constraints

- **Auth + authz come ONLY from Supabase Auth + backend `whoami`.** No code path in the real login/session flow may read `serverSessionToken`, `zarohr_auth_session`/`zarohr_emp_session`, app-hashed credentials, `SUPER_ADMIN_EMAIL`/`SUPER_ADMIN_PASS`, `LOCAL_MEETING_PASSWORD`/`localMeetingLogin`, or the separate `EMP_SESSION_KEY` employee session. All are removed from the real path.
- **Clean switch, no legacy fallback** (test data only — no production users to disrupt). Demo/test Supabase Auth users must be seeded FIRST so login works: the existing `supabase/verify/seed-foundation.mjs` already creates `pms-*@example.com` (super/hr/manager/employee/hod) with password `Passw0rd!seed`, `email_confirm:true`, `org_members`, and `employees.user_id` links — these ARE the demo login accounts.
- **Blob stays for DATA reads only.** Not-yet-migrated screens keep reading `stateStore`/`app_state` for their DATA; they must NOT be an auth authority. Do not delete the blob or `app-auth`/`send-email` (Plan 6).
- **Pure testable modules must not import `config.js`/`supabaseClient.js`** (they read `import.meta.env`, which crashes under Node). `identity.js` and `pmsClientCore.js` stay dependency-free so `node --test` can import them; browser wiring lives in `pmsClient.js`.
- **Backend contract:** `admin.whoami` / `workflow.whoami` require a valid Supabase session bearer (functions are `verify_jwt=true`) but no role gate; both return `{ userId, memberships }` where each membership is `{ memberId, organizationId, roles: string[], employeeId }` (camelCase; `organizationId=null` + `roles:['super_admin']` = super admin). Responses are `{ok:true,data}` / `{ok:false,error:{code,message}}`.
- **Env:** `.env` has `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` (project `erqeugmibozdjvhqgwai`) and (for verify scripts) `SUPABASE_SERVICE_ROLE_KEY`. Never print/commit `.env`.
- **Build in an ISOLATED WORKTREE off the newly-committed `main`** (`rebuild-5a-auth`) after Step 0; wire `.env`, symlink `node_modules`, copy `supabase/.temp`, copy the untracked old-app migrations so `db push` reconciles. Full gate green before merge.
- Commit trailer on every commit: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`
- The existing foundation gate (`rls`/`kernel`/`admin`/`workflow`/`jobs`) must stay green; this plan ADDS `client-check.mjs`.

## File Structure

- `src/backend/identity.js` (NEW, pure) — `deriveIdentity(memberships)` → `{ role, orgId, employeeId, memberships }`.
- `src/backend/pmsClientCore.js` (NEW, pure) — `PmsError`, `postAction({ baseUrl, fnName, action, payload, token, fetchImpl })`.
- `src/backend/pmsClient.js` (NEW, browser) — `callPms(action, payload)`, `callWorkflow(action, payload)` wiring `supabaseClient` session + env into `postAction`.
- `src/backend/identity.test.mjs`, `src/backend/pmsClientCore.test.mjs` (NEW) — `node --test`.
- `supabase/verify/client-check.mjs` (NEW) — live integration; imports the pure `identity.js`.
- `src/AppContext.jsx` (MODIFY) — identity from session→whoami→deriveIdentity; remove custom session/bypasses.
- `src/pages/LoginPage.jsx` (MODIFY) — Supabase Auth login; remove meeting/super-admin/serverAuth bypasses.
- `src/pages/SetPasswordPage.jsx` (NEW) — recovery/first-login + forgot-password.
- `src/App.jsx` (MODIFY) — route gate by `whoami` identity; route to SetPasswordPage on recovery.
- `supabase/verify/run-all.mjs` (MODIFY) — add `client-check.mjs`.

---

### Task 0: Baseline commit + worktree

**Files:** none created — this commits the current working tree and sets up the build worktree.

- [ ] **Step 1: Review what's dirty**

Run: `git status --short` and `git diff --stat main -- src supabase`
Confirm the categories: the current app (`src/**`), new-project backend fixes (any modified `supabase/migrations/**`, `supabase/functions/**`, `supabase/schema-v1.sql`), deps (`package.json`, `package-lock.json`, `deno.lock`), and artifacts to EXCLUDE (`tmp-hr-review*.png` and any other `tmp-*`/screenshot).

- [ ] **Step 2: Stage the intended baseline, excluding artifacts**

Stage the app + backend fixes + deps by explicit path/globs; do NOT stage temp screenshots. Example (adjust to the actual dirty set from Step 1):

```bash
git add src supabase package.json package-lock.json deno.lock docs
git reset -- 'tmp-*.png' 2>/dev/null || true
git status --short          # verify NO tmp-*.png staged; verify the app + backend files ARE staged
```

- [ ] **Step 3: Commit the baseline**

```bash
git commit -m "chore(baseline): current app + new-project backend fixes as the pre-5a baseline (exclude temp artifacts)

The blob-based app as it runs today on Supabase project erqeugmibozdjvhqgwai,
committed as the versioned starting point for the Plan 5 frontend rewire.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
git push origin main
```

- [ ] **Step 4: Create + wire the worktree**

```bash
git worktree add .worktrees/rebuild-5a-auth main -b rebuild-5a-auth
cp .env .worktrees/rebuild-5a-auth/.env
ln -s "$(pwd)/node_modules" .worktrees/rebuild-5a-auth/node_modules
mkdir -p .worktrees/rebuild-5a-auth/supabase/.temp && cp -R supabase/.temp/. .worktrees/rebuild-5a-auth/supabase/.temp/
```

Expected: `git -C .worktrees/rebuild-5a-auth status --short` is clean; `cat .worktrees/rebuild-5a-auth/supabase/.temp/project-ref` prints `erqeugmibozdjvhqgwai`.

- [ ] **Step 5: Baseline gate**

Run (in the worktree): `node supabase/verify/run-all.mjs`
Expected: `FOUNDATION SMOKE: ALL PASS`. Record the starting counts.

---

### Task 1: Pure client core — `identity` + `pmsClientCore`

**Files:**
- Create: `src/backend/identity.js`, `src/backend/identity.test.mjs`
- Create: `src/backend/pmsClientCore.js`, `src/backend/pmsClientCore.test.mjs`

**Interfaces:**
- Produces (used by Tasks 2–6):
  - `deriveIdentity(memberships: Array<{organizationId, roles, employeeId}>) → { role: 'super_admin'|'hr_admin'|'employee'|null, orgId: string|null, employeeId: string|null, memberships }`
  - `class PmsError extends Error { code: string; status: number }`
  - `postAction({ baseUrl, fnName, action, payload, token, fetchImpl }) → Promise<data>` — POSTs `{action,...payload}` to `${baseUrl}/functions/v1/${fnName}` with `Authorization: Bearer ${token}`; returns `data` on `{ok:true}`, throws `PmsError(code,message,status)` on `{ok:false}` or non-2xx, throws `PmsError('NO_SESSION',...,401)` if `token` is falsy.

- [ ] **Step 1: Write failing tests for `deriveIdentity`**

`src/backend/identity.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveIdentity } from './identity.js';

test('super admin from org-null super_admin membership', () => {
  const id = deriveIdentity([{ memberId: 'm', organizationId: null, roles: ['super_admin'], employeeId: null }]);
  assert.equal(id.role, 'super_admin');
  assert.equal(id.orgId, null);
});

test('hr_admin from org membership', () => {
  const id = deriveIdentity([{ memberId: 'm', organizationId: 'org1', roles: ['hr_admin'], employeeId: 'e1' }]);
  assert.equal(id.role, 'hr_admin');
  assert.equal(id.orgId, 'org1');
  assert.equal(id.employeeId, 'e1');
});

test('employee from org membership', () => {
  const id = deriveIdentity([{ memberId: 'm', organizationId: 'org1', roles: ['employee'], employeeId: 'e2' }]);
  assert.equal(id.role, 'employee');
  assert.equal(id.employeeId, 'e2');
});

test('super admin wins even with an org membership present', () => {
  const id = deriveIdentity([
    { organizationId: 'org1', roles: ['employee'], employeeId: 'e2' },
    { organizationId: null, roles: ['super_admin'], employeeId: null },
  ]);
  assert.equal(id.role, 'super_admin');
});

test('no memberships → null role', () => {
  const id = deriveIdentity([]);
  assert.equal(id.role, null);
  assert.equal(id.orgId, null);
});

test('undefined input does not throw', () => {
  const id = deriveIdentity(undefined);
  assert.equal(id.role, null);
});
```

- [ ] **Step 2: Run to verify fail**

Run: `node --test src/backend/identity.test.mjs`
Expected: FAIL — `Cannot find module ... identity.js`.

- [ ] **Step 3: Implement `identity.js`**

`src/backend/identity.js`:

```js
// Derive the app identity from backend whoami memberships. This is the ONLY place role/org/employee
// are computed; kept pure (no browser/env imports) so it is unit-testable and shared with client-check.
// Membership shape (from admin.whoami / workflow.whoami): { memberId, organizationId, roles: string[], employeeId }.
export function deriveIdentity(memberships) {
  const list = Array.isArray(memberships) ? memberships : [];
  const superM = list.find((m) => m && m.organizationId == null && Array.isArray(m.roles) && m.roles.includes('super_admin'));
  if (superM) return { role: 'super_admin', orgId: null, employeeId: null, memberships: list };
  const orgM = list.find((m) => m && m.organizationId != null);
  if (!orgM) return { role: null, orgId: null, employeeId: null, memberships: list };
  const roles = Array.isArray(orgM.roles) ? orgM.roles : [];
  const role = roles.includes('hr_admin') ? 'hr_admin' : roles.includes('employee') ? 'employee' : (roles[0] || null);
  return { role, orgId: orgM.organizationId, employeeId: orgM.employeeId ?? null, memberships: list };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `node --test src/backend/identity.test.mjs`
Expected: `pass 6`.

- [ ] **Step 5: Write failing tests for `pmsClientCore`**

`src/backend/pmsClientCore.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { postAction, PmsError } from './pmsClientCore.js';

function fakeFetch(status, body) {
  return async () => ({ status, ok: status >= 200 && status < 300, json: async () => body, text: async () => JSON.stringify(body) });
}

test('returns data on ok:true', async () => {
  const data = await postAction({ baseUrl: 'http://x', fnName: 'pms-admin', action: 'a', payload: {}, token: 't', fetchImpl: fakeFetch(200, { ok: true, data: { hi: 1 } }) });
  assert.deepEqual(data, { hi: 1 });
});

test('throws PmsError with code on ok:false', async () => {
  await assert.rejects(
    () => postAction({ baseUrl: 'http://x', fnName: 'pms-admin', action: 'a', payload: {}, token: 't', fetchImpl: fakeFetch(409, { ok: false, error: { code: 'CONFLICT', message: 'stale' } }) }),
    (e) => e instanceof PmsError && e.code === 'CONFLICT' && e.status === 409,
  );
});

test('throws NO_SESSION when token missing', async () => {
  await assert.rejects(
    () => postAction({ baseUrl: 'http://x', fnName: 'pms-admin', action: 'a', payload: {}, token: '', fetchImpl: fakeFetch(200, {}) }),
    (e) => e instanceof PmsError && e.code === 'NO_SESSION' && e.status === 401,
  );
});

test('non-2xx non-JSON throws DB_ERROR-ish PmsError', async () => {
  const badFetch = async () => ({ status: 500, ok: false, json: async () => { throw new Error('no json'); }, text: async () => 'oops' });
  await assert.rejects(
    () => postAction({ baseUrl: 'http://x', fnName: 'pms-admin', action: 'a', payload: {}, token: 't', fetchImpl: badFetch }),
    (e) => e instanceof PmsError && e.status === 500,
  );
});
```

- [ ] **Step 6: Run to verify fail**

Run: `node --test src/backend/pmsClientCore.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 7: Implement `pmsClientCore.js`**

`src/backend/pmsClientCore.js`:

```js
// Pure request/error core for the pms backend. No browser/env imports — unit-testable.
export class PmsError extends Error {
  constructor(code, message, status) {
    super(message || code);
    this.name = 'PmsError';
    this.code = code || 'ERROR';
    this.status = status || 0;
  }
}

// POST {action,...payload} to ${baseUrl}/functions/v1/${fnName} with a bearer token.
// Resolve to `data` on {ok:true}; throw PmsError otherwise. fetchImpl defaults to global fetch.
export async function postAction({ baseUrl, fnName, action, payload = {}, token, fetchImpl }) {
  if (!token) throw new PmsError('NO_SESSION', 'You are signed out. Please sign in again.', 401);
  const doFetch = fetchImpl || fetch;
  let res;
  try {
    res = await doFetch(`${baseUrl}/functions/v1/${fnName}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, ...payload }),
    });
  } catch (e) {
    throw new PmsError('NETWORK', e?.message || 'Network error', 0);
  }
  let body = null;
  try { body = await res.json(); } catch { /* non-JSON */ }
  if (body && body.ok === true) return body.data;
  if (body && body.ok === false && body.error) throw new PmsError(body.error.code || 'ERROR', body.error.message || 'Request failed', res.status);
  throw new PmsError('DB_ERROR', `Request failed (HTTP ${res.status})`, res.status);
}
```

- [ ] **Step 8: Run to verify pass**

Run: `node --test src/backend/pmsClientCore.test.mjs`
Expected: `pass 4`.

- [ ] **Step 9: Commit**

```bash
git add src/backend/identity.js src/backend/identity.test.mjs src/backend/pmsClientCore.js src/backend/pmsClientCore.test.mjs
git commit -m "feat(client): pure identity derivation + pms request/error core (node-tested)"
```

---

### Task 2: Browser client + live integration check

**Files:**
- Create: `src/backend/pmsClient.js`
- Create: `supabase/verify/client-check.mjs`
- Modify: `supabase/verify/run-all.mjs`

**Interfaces:**
- Consumes: `postAction`/`PmsError` (Task 1), `deriveIdentity` (Task 1), the existing `supabase` client (`src/backend/supabaseClient.js`) and `supabaseEnv` (`src/backend/config.js`), and `signIn`/`SUPABASE_URL` + `USERS`/`PASSWORD` from the verify suite.
- Produces (used by Tasks 3–6): `callPms(action, payload) → Promise<data>`, `callWorkflow(action, payload) → Promise<data>`, re-exported `PmsError`.

- [ ] **Step 1: Implement `pmsClient.js`**

`src/backend/pmsClient.js`:

```js
// Browser wiring: attach the current Supabase session token to the pure postAction core.
import { supabase } from './supabaseClient';
import { supabaseEnv } from './config';
import { postAction, PmsError } from './pmsClientCore';

export { PmsError };

async function currentToken() {
  if (!supabase) return null;
  const { data } = await supabase.auth.getSession();
  return data?.session?.access_token || null;
}

export async function callPms(action, payload = {}) {
  const token = await currentToken();
  return postAction({ baseUrl: supabaseEnv.url, fnName: 'pms-admin', action, payload, token });
}

export async function callWorkflow(action, payload = {}) {
  const token = await currentToken();
  return postAction({ baseUrl: supabaseEnv.url, fnName: 'pms-workflow', action, payload, token });
}
```

(If `config.js` exports the URL under a different name than `supabaseEnv.url`, match it — grep `src/backend/config.js`.)

- [ ] **Step 2: Write `client-check.mjs` (live integration)**

`supabase/verify/client-check.mjs`:

```js
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
```

- [ ] **Step 3: Run the check**

Run: `node supabase/verify/seed-foundation.mjs && node supabase/verify/client-check.mjs`
Expected: `client-check: PASS (8 assertions)`. (If `deriveIdentity` role mismatches, the whoami membership keys differ from the assumed camelCase — fix `identity.js` to match the actual JSON and re-run; do not weaken the assertion.)

- [ ] **Step 4: Wire into `run-all.mjs`**

In `supabase/verify/run-all.mjs`, append `'supabase/verify/client-check.mjs'` to the `scripts` array after `'supabase/verify/jobs-check.mjs'`.

- [ ] **Step 5: Full gate**

Run: `node supabase/verify/run-all.mjs` (background if >2 min).
Expected: all suites pass incl. `client-check: PASS (8 assertions)`, final `FOUNDATION SMOKE: ALL PASS`.

- [ ] **Step 6: Commit**

```bash
git add src/backend/pmsClient.js supabase/verify/client-check.mjs supabase/verify/run-all.mjs
git commit -m "feat(client): callPms/callWorkflow + live client-check (login→whoami→round-trip) wired into the gate"
```

---

### Task 3: `AppContext` — identity from Supabase session + whoami

**Files:**
- Modify: `src/AppContext.jsx`

**Interfaces:**
- Consumes: `supabase` (supabaseClient), `callPms` (Task 2), `deriveIdentity` (Task 1).
- Produces (used by Tasks 4–6, and read by existing screens via `useApp()`): context now exposes `{ userId, role, orgId, employeeId, memberships, userEmail, authReady, signOut, refreshIdentity }`. `role` values: `'super_admin'|'hr_admin'|'employee'|null`. Keeps `orgs`/`saveAppData`/`loadAppData` (blob data) UNCHANGED for not-yet-migrated screens.

- [ ] **Step 1: Replace the auth-state core**

In `src/AppContext.jsx`, remove the custom-session auth path and establish identity from Supabase + whoami. Concretely:
- DELETE the exports/consts `SUPER_ADMIN_EMAIL`, `SUPER_ADMIN_PASS`, and any `readSessionSync`/`persistAuthSession`/`clearAuthSession` usage for AUTH.
- Replace the auth state block with:

```jsx
const [authReady, setAuthReady] = useState(false);
const [userId, setUserId] = useState(null);
const [userEmail, setUserEmail] = useState('');
const [role, setRole] = useState(null);
const [orgId, setOrgId] = useState(null);
const [employeeId, setEmployeeId] = useState(null);
const [memberships, setMemberships] = useState([]);

const applyIdentity = useCallback((session) => {
  setUserId(session?.user?.id || null);
  setUserEmail(session?.user?.email || '');
}, []);

const refreshIdentity = useCallback(async () => {
  try {
    const who = await callPms('admin.whoami', {});
    const id = deriveIdentity(who.memberships);
    setRole(id.role); setOrgId(id.orgId); setEmployeeId(id.employeeId); setMemberships(id.memberships);
  } catch {
    setRole(null); setOrgId(null); setEmployeeId(null); setMemberships([]);
  }
}, []);

useEffect(() => {
  if (!supabase) { setAuthReady(true); return; }
  let active = true;
  supabase.auth.getSession().then(async ({ data }) => {
    if (!active) return;
    applyIdentity(data.session);
    if (data.session) await refreshIdentity();
    setAuthReady(true);
  });
  const { data: sub } = supabase.auth.onAuthStateChange(async (_event, session) => {
    applyIdentity(session);
    if (session) await refreshIdentity(); else { setRole(null); setOrgId(null); setEmployeeId(null); setMemberships([]); }
  });
  return () => { active = false; sub?.subscription?.unsubscribe?.(); };
}, [applyIdentity, refreshIdentity]);

const signOut = useCallback(async () => {
  try { await supabase?.auth.signOut(); } finally {
    setRole(null); setOrgId(null); setEmployeeId(null); setMemberships([]); setUserId(null); setUserEmail('');
  }
}, []);
```

- Add imports at the top: `import { supabase } from './backend/supabaseClient';`, `import { callPms } from './backend/pmsClient';`, `import { deriveIdentity } from './backend/identity';`.
- Update the context `value` to expose `userId, role, orgId, employeeId, memberships, userEmail, authReady, signOut, refreshIdentity` (keep `orgs, saveAppData, loadAppData` and other blob-data members as-is). Remove `login`/`logout` from the auth path; if existing screens still import `logout`, alias `logout: signOut` temporarily and note it for 5b-5e cleanup.

- [ ] **Step 2: Remove the employee-only session bypass**

Search `src/AppContext.jsx` (and `src/App.jsx`) for `EMP_SESSION_KEY` / `zarohr_emp_session` and remove its use as an AUTH source — the employee identity now comes from `whoami` like every other role. (Employee DATA reads from the blob stay until 5b.)

- [ ] **Step 3: Verify it compiles + the app boots**

Run: `npm run build`
Expected: build succeeds. Removing `SUPER_ADMIN_EMAIL`/`SUPER_ADMIN_PASS`/`persistAuthSession` will break `LoginPage.jsx` (it imports `SUPER_ADMIN_EMAIL/PASS`) and possibly others — fix each now-broken import by deleting the dead usage (this is a small preview of Task 4's LoginPage cleanup; that's expected and fine). The build must be green before commit.

- [ ] **Step 4: Commit**

```bash
git add src/AppContext.jsx
git commit -m "feat(auth): AppContext identity from Supabase session + whoami; remove custom-session/super-admin/emp-session bypasses"
```

---

### Task 4: `LoginPage` — Supabase Auth sign-in; remove bypasses

**Files:**
- Modify: `src/pages/LoginPage.jsx`

**Interfaces:**
- Consumes: `supabase` (supabaseClient), `useApp()` (`authReady`, `role`).
- Produces: a login form that calls `supabase.auth.signInWithPassword`; on success the AppContext `onAuthStateChange` establishes identity and the app routes by role.

- [ ] **Step 1: Delete the legacy auth code**

In `src/pages/LoginPage.jsx`, remove:
- `const LOCAL_MEETING_PASSWORD = '123456';` and the entire `localMeetingLogin(...)` function and its call site (`user = localMeetingLogin(...)`).
- Imports and calls of `loginWithServerSession`, `changePasswordOnServer`, `requestPasswordReset`, `confirmPasswordReset` from `../backend/serverAuth`, and `resolveLoginUser`/`changeEmployeePassword` from `../backend/authService`, and `SUPER_ADMIN_EMAIL`/`SUPER_ADMIN_PASS` from `../AppContext` — for the LOGIN path.
- The `resolveWorkspaceForLogin`/`serverSessionToken`/workspace-slug auth branches and the `login('employee'|'hr-admin'|'super-admin', ...)` calls.

- [ ] **Step 2: Implement the Supabase Auth submit**

Replace the login `handleSubmit` with:

```jsx
async function handleSubmit(e) {
  e.preventDefault();
  setError('');
  setSubmitting(true);
  const email = String(identifier || '').trim().toLowerCase();
  try {
    const { error: authErr } = await supabase.auth.signInWithPassword({ email, password });
    if (authErr) { setError(mapAuthError(authErr)); return; }
    // AppContext's onAuthStateChange picks up the session, calls whoami, and sets role → App routes.
  } catch (err) {
    setError('Sign-in failed. Please try again.');
  } finally {
    setSubmitting(false);
  }
}

function mapAuthError(err) {
  const m = String(err?.message || '').toLowerCase();
  if (m.includes('invalid login')) return 'Incorrect email or password.';
  if (m.includes('email not confirmed')) return 'Please confirm your email, or set your password from your invite link.';
  return err?.message || 'Sign-in failed.';
}
```

Add `import { supabase } from '../backend/supabaseClient';` and ensure `identifier`, `password`, `error`, `submitting` state exist (keep the existing form fields/markup; only the submit logic changes). Add a link/button routing to `#set-password` ("First time here? Set your password" / "Forgot password?").

- [ ] **Step 3: Build check**

Run: `npm run build`
Expected: succeeds; no remaining imports of the removed `serverAuth`/`authService` login symbols or `LOCAL_MEETING_PASSWORD` in `LoginPage.jsx` (`grep -n "LOCAL_MEETING\|localMeetingLogin\|loginWithServerSession\|SUPER_ADMIN_PASS" src/pages/LoginPage.jsx` → empty).

- [ ] **Step 4: Commit**

```bash
git add src/pages/LoginPage.jsx
git commit -m "feat(auth): LoginPage on Supabase Auth; remove local meeting bypass + serverAuth/super-admin login paths"
```

---

### Task 5: `SetPasswordPage` — first-login + recovery + forgot

**Files:**
- Create: `src/pages/SetPasswordPage.jsx`
- Modify: `src/App.jsx` (route `#set-password` + recovery detection)

**Interfaces:**
- Consumes: `supabase` (supabaseClient). Recovery links open the app with a recovery session (the client's `detectSessionInUrl` handles the token); `onAuthStateChange` fires `PASSWORD_RECOVERY`.
- Produces: a page that sets a new password via `supabase.auth.updateUser({ password })`, and a "request reset email" entry via `supabase.auth.resetPasswordForEmail(email, { redirectTo })`.

- [ ] **Step 1: Implement `SetPasswordPage.jsx`**

`src/pages/SetPasswordPage.jsx`:

```jsx
import { useEffect, useState } from 'react';
import { supabase } from '../backend/supabaseClient';
import '../admin.css';

export default function SetPasswordPage() {
  const [mode, setMode] = useState('loading'); // 'set' (have a session) | 'request' (no session) | 'done'
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setMode(data.session ? 'set' : 'request'));
    const { data: sub } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === 'PASSWORD_RECOVERY' || session) setMode('set');
    });
    return () => sub?.subscription?.unsubscribe?.();
  }, []);

  async function submitSet(e) {
    e.preventDefault();
    setError('');
    if (password.length < 8) { setError('Use at least 8 characters.'); return; }
    if (password !== confirm) { setError('Passwords do not match.'); return; }
    setBusy(true);
    const { error: err } = await supabase.auth.updateUser({ password });
    setBusy(false);
    if (err) { setError(err.message || 'Could not set password.'); return; }
    window.location.hash = '#login';
    setMode('done');
  }

  async function submitRequest(e) {
    e.preventDefault();
    setError('');
    setBusy(true);
    const redirectTo = `${window.location.origin}${window.location.pathname}#set-password`;
    const { error: err } = await supabase.auth.resetPasswordForEmail(String(email).trim().toLowerCase(), { redirectTo });
    setBusy(false);
    if (err) { setError(err.message || 'Could not send reset email.'); return; }
    setMode('done');
  }

  if (mode === 'loading') return <div className="login-shell">Loading…</div>;
  if (mode === 'done') return <div className="login-shell">Check your email for the reset link, or <a href="#login">return to sign in</a>.</div>;

  return (
    <div className="login-shell">
      {mode === 'set' ? (
        <form className="login-form" onSubmit={submitSet}>
          <h2>Set your password</h2>
          <input type="password" placeholder="New password" value={password} onChange={(e) => setPassword(e.target.value)} />
          <input type="password" placeholder="Confirm password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
          {error && <div className="login-error">{error}</div>}
          <button disabled={busy} type="submit">Set password</button>
        </form>
      ) : (
        <form className="login-form" onSubmit={submitRequest}>
          <h2>Reset your password</h2>
          <input type="email" placeholder="Your email" value={email} onChange={(e) => setEmail(e.target.value)} />
          {error && <div className="login-error">{error}</div>}
          <button disabled={busy} type="submit">Email me a reset link</button>
          <a href="#login">Back to sign in</a>
        </form>
      )}
    </div>
  );
}
```

(Match existing class names in `admin.css` for `login-shell`/`login-form`/`login-error`; if they differ, use the ones `LoginPage` uses.)

- [ ] **Step 2: Route it in `App.jsx`**

In `src/App.jsx`: import `SetPasswordPage`; add `if (route === 'set-password') return <SetPasswordPage />;` BEFORE the auth-gate redirect; and in the auth-gate effect, do not bounce `set-password` to login. Also, if `onAuthStateChange` reports `PASSWORD_RECOVERY`, force `window.location.hash = '#set-password'` (a small listener in `App` or `AppContext`).

- [ ] **Step 3: Build check**

Run: `npm run build`
Expected: succeeds.

- [ ] **Step 4: Commit**

```bash
git add src/pages/SetPasswordPage.jsx src/App.jsx
git commit -m "feat(auth): first-login/recovery set-password page + routing"
```

---

### Task 6: Route gate by whoami role + retire legacy + verify

**Files:**
- Modify: `src/App.jsx`
- (Cleanup) `src/pages/LoginPage.jsx`, `src/AppContext.jsx` residuals

**Interfaces:**
- Consumes: `useApp()` (`authReady`, `role`, `signOut`).
- Produces: unauthenticated → login; authenticated → role-appropriate screen; a clean grep for retired symbols.

- [ ] **Step 1: Gate routing by identity**

In `src/App.jsx`, ensure:
- `if (!authReady) return <Loading/>;`
- unauthenticated (`!role`) and not on `login`/`set-password` → redirect `#login`.
- **Signed-in-but-no-membership** (a Supabase session exists — `userId` truthy — but `role` is null because `whoami` returned zero memberships): do NOT redirect to login (that loops, since they're already authenticated). Render a simple "Your account isn't linked to an organization yet — contact HR." screen with a `signOut` button. Gate the login-redirect on `!userId`, not just `!role`.
- route the role to its screen using the new `role` values (`super_admin`/`hr_admin`/`employee`); update any comparisons that used old role strings (`'hr-admin'`, `'super-admin'`) to the new ones.
- `logout` buttons call `signOut`.

- [ ] **Step 2: Retire legacy auth symbols from the real path**

Run these greps at the repo root — each MUST be empty (or only in clearly-dead/not-imported files slated for Plan 6):

```bash
grep -rn "LOCAL_MEETING_PASSWORD\|localMeetingLogin" src/
grep -rn "serverSessionToken" src/pages src/AppContext.jsx src/App.jsx
grep -rn "zarohr_auth_session\|zarohr_emp_session\|EMP_SESSION_KEY" src/AppContext.jsx src/App.jsx
grep -rn "SUPER_ADMIN_PASS\|SUPER_ADMIN_EMAIL" src/pages src/App.jsx src/AppContext.jsx
```

Remove any remaining real-path references (leave blob DATA helpers that non-migrated screens still import, but not as an auth authority).

- [ ] **Step 3: Build + full gate**

Run: `npm run build && node supabase/verify/run-all.mjs`
Expected: build OK; `FOUNDATION SMOKE: ALL PASS` incl. `client-check`.

- [ ] **Step 4: Manual browser smoke (documented)**

Run `npm run dev` and verify (record results in the PR/commit message):
1. Sign in as `pms-hr@example.com` / `Passw0rd!seed` → lands on the HR view; `whoami` role = hr_admin.
2. Sign in as `pms-employee@example.com` → employee view.
3. Sign in as `pms-super@example.com` → super-admin view.
4. Wrong password → friendly error, no crash, not signed in.
5. Logout → returns to login; refresh stays logged out.
6. `#set-password` request-reset path renders and submits without error.
7. No console references to `serverSessionToken`/meeting bypass; the app does not read the old localStorage session.

- [ ] **Step 5: Commit**

```bash
git add src/App.jsx src/AppContext.jsx src/pages/LoginPage.jsx
git commit -m "feat(auth): route gate by whoami role; retire remaining legacy auth from the real path"
```

---

## Out of Scope (later sub-plans / Plan 6)

- 5b–5e: rewire data screens (employee portal, manager/HOD, HR dashboards, wizard) to `callPms`/`callWorkflow` + RLS reads.
- Plan 6 cutover: delete the blob/`app_state`/`stateStore`, old `app-auth`/`send-email` functions, and any residual legacy-auth files kept only for blob DATA reads.
- Multi-org switching UI beyond the single-membership default; adding a component test runner (vitest) if component-level tests become warranted.

## Carried-forward notes

- Go-live: disable Supabase Auth signups before production; live SMTP smoke for `pms-jobs`; schedule `jobs.tick`.
- Demo credentials: `pms-{super,hr,manager,employee,hod}@example.com` / `Passw0rd!seed` (seeded by `seed-foundation.mjs`).
