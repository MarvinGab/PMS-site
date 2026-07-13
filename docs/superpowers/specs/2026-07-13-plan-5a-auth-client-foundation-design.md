# Plan 5a — Auth & Client-API Foundation (Design)

**Status:** Approved 2026-07-13. First sub-plan of Plan 5 (frontend rewire).

## Context

Plans 1–4 built the server-first backend (`pms` schema, RLS, `pms-admin` / `pms-workflow` / `pms-jobs` edge functions on Supabase Auth). The frontend in `src/` still runs entirely on the **old architecture**: homegrown password auth (app-hashed credentials stored in the org blob), a custom localStorage session (`zarohr_auth_session`, `zarohr_emp_session`), a `serverSessionToken` validated by the old `app-auth`/`send-email` functions, and all data read from the `app_state` blob via `stateStore`. `src/` does **not** call the `pms` backend at all.

Plan 5 rewires the visible screens to the `pms` backend, decomposed into five sub-plans built in order:
- **5a — Auth + client-API foundation (this spec).**
- 5b — Employee portal (goals, self-eval, view results, accept/raise-concern).
- 5c — Manager/HOD evaluation pages.
- 5d — HR dashboards (cycle dashboard, review, calibration, publish, live job status).
- 5e — Config wizard (cycle authoring).

Everything is **test data** — there are no production users to disrupt, which is why 5a does a clean auth switch with no legacy fallback.

## Goal

Make **Supabase Auth + backend `whoami` the single source of authentication and authorization** for the app, and give every screen a typed client (`callPms` / `callWorkflow`) for backend calls — without yet migrating the data screens. After 5a: a user signs in through Supabase Auth, the app learns their role/org/employee identity only from `whoami`, and the client layer is ready for 5b–5e. Data screens keep reading the blob temporarily (5b–5e migrate them; Plan 6 deletes the blob).

## Scope

### In scope
1. **`callPms` / `callWorkflow` client helpers** (`src/backend/pmsClient.js`) — the browser twin of the verify suites' `callAdmin`/`callWorkflow`. Attach the current Supabase session's access token as `Authorization: Bearer`, POST `{action, ...payload}` to `/functions/v1/pms-admin` (or `pms-workflow`), return `data` on `{ok:true}` or throw a typed `PmsError(code, message, status)` on `{ok:false}` / non-2xx. Surface `CONFLICT`/`FORBIDDEN`/`WINDOW_CLOSED`/etc. codes to callers.
2. **Login via Supabase Auth** — `LoginPage` calls `supabase.auth.signInWithPassword({ email, password })`. The Supabase client owns the session (auto-persisted in localStorage). Clear, friendly errors on bad credentials.
3. **First-login set-password** — invited users (GoTrue users created by Plan 2b's invite flow, delivered a recovery link) land on a **SetPasswordPage** via the recovery token; `supabase.auth.updateUser({ password })` sets it and signs them in. Also serves "forgot password" (request a reset email → same page).
4. **`whoami`-driven identity/authz** — after a session exists, the shell calls `admin.whoami` (returns `{ userId, memberships }`; no role gate, any authenticated user may call it) and derives:
   - **super admin** — a membership with `organization_id = null` and `roles` containing `super_admin`;
   - otherwise the active-org membership's `roles` (`hr_admin` / `employee`) + its `employeeId` + `organizationId`.
   `AppContext` holds `{ userId, role, orgId, employeeId, memberships }` sourced **only** from `whoami`. Multi-org users default to their single membership; super admin selects an org (out of 5a beyond a default — one membership is the common case).
5. **Routing/UI gating by `whoami` role** — `App.jsx` redirects unauthenticated users to login and shows role-appropriate screens based on the `whoami` role. This is UX only; the backend independently enforces authz on every write (`requireOrgRole`, derived scope).
6. **Logout** — `supabase.auth.signOut()` + clear the in-memory identity.
7. **Retire from the real path** — `serverSessionToken`, `zarohr_auth_session`/`zarohr_emp_session`, app-hashed credential login (`authService` resolveHrUser/materializeCredentialRecord), and any local/dev auth bypass. Auth state derives only from the Supabase session; role/org/employee only from `whoami`.
8. **Seed demo/test auth users** — before cutover, ensure Supabase Auth users + `org_members` (+ `employees.user_id` links) exist with known passwords for each role (super admin, HR admin, employee, manager, HOD) so login/demo works immediately. Extend the existing `supabase/verify/seed-foundation.mjs` (or a sibling demo-seed) so the seeded `pms-*@example.com` users are the login accounts; document the demo credentials.

### Out of scope (later sub-plans / Plan 6)
- Rewiring data screens (goals, evals, dashboards, wizard) to the backend — 5b–5e. They keep reading the blob for **data** in the interim; only **auth + authz** move now.
- Deleting the blob / `app_state` / `stateStore` and the old `app-auth`/`send-email` functions — Plan 6 cutover.
- Multi-org switching UI beyond a sensible default.

## Architecture & Data Flow

```
Login: LoginPage → supabase.auth.signInWithPassword → Supabase session (localStorage, client-managed)
Boot:  AppContext (onAuthStateChange) → session? → callPms('admin.whoami') → memberships → derive {role, orgId, employeeId} → authReady
Calls: screen → callPms/callWorkflow(action,payload) → fetch /functions/v1/pms-* with Bearer <session access_token> → {ok,data} | throw PmsError
Recovery: invite/reset link → onAuthStateChange('PASSWORD_RECOVERY') → SetPasswordPage → updateUser({password})
Logout: supabase.auth.signOut() → clear identity → redirect login
```

### Components (units, each independently testable)
- `src/backend/pmsClient.js` — `callPms(action, payload)`, `callWorkflow(action, payload)`, `PmsError`. Depends only on `supabaseClient` (for the session token) + env URL. No React.
- `src/backend/supabaseClient.js` (exists) — confirm `persistSession: true`, `autoRefreshToken: true`; add `onAuthStateChange` consumers in AppContext.
- `src/pages/LoginPage.jsx` — email/password form → `signInWithPassword`; links to set/forgot password.
- `src/pages/SetPasswordPage.jsx` (new) — recovery-token session → `updateUser({password})`; also request-reset entry.
- `src/AppContext.jsx` — session + `whoami` identity, `authReady`, `signOut`; the ONLY place identity is established. Remove custom-session reads from the auth path.
- `src/App.jsx` — auth gate + role-based routing off `AppContext`.
- `authService.js` / `serverAuth.js` — strip the auth responsibilities (login, session token, bypass); anything still needed purely for blob **data** reads by not-yet-migrated screens stays but is clearly no longer an auth authority.
- Seed: `supabase/verify/seed-foundation.mjs` (extend) or `supabase/verify/seed-demo.mjs` — demo auth users + memberships + employee links with known passwords.

## Error Handling
- `PmsError(code, message, status)` from the client; screens show friendly messages, and the shell treats `401`/expired session as "signed out" → redirect to login (with a token-refresh attempt first via the Supabase client).
- `whoami` returning zero memberships → a clear "your account isn't set up for any organization — contact HR" state, not a crash.
- Bad login credentials, unconfirmed users, and recovery-link expiry each get specific copy.

## Testing
- **Node integration script** (`supabase/verify/client-check.mjs`, wired into `run-all.mjs`): using `@supabase/supabase-js` as a browser would — `signInWithPassword` as each seeded role → `admin.whoami` returns the expected memberships/role → a representative `callPms`/`callWorkflow` round-trip succeeds → an anon/no-session call is rejected. This validates the client contract + seed against the live backend deterministically, like the existing suites.
- **Manual browser smoke** (documented steps): sign in as each role, first-login set-password via a recovery link, logout, and an expired/invalid session redirecting to login.
- The existing foundation gate (`rls`/`admin`/`workflow`/`jobs`) must stay green.

## Build & Rollout
- **Baseline commit first:** commit the current app (`src/` + its new files + deps) to `main` as the pre-5a baseline, so nothing is lost and 5a builds on a clean, versioned starting point.
- Build 5a in an **isolated worktree off the newly-committed `main`**; standard wiring (`.env`, `node_modules`, `supabase/.temp`); full gate green before merge.
- Because it's test data, the clean auth switch can land without a legacy fallback; if login breaks it's because the demo users aren't seeded — hence the seed step is part of 5a, run/verified before the switch is considered done.

## Success Criteria
- Login, logout, and first-login set-password work through Supabase Auth for every seeded role.
- `AppContext` exposes role/org/employee derived **only** from `whoami`; no code path reads `serverSessionToken` / `zarohr_auth_session` / app-hashed credentials for auth.
- `callPms`/`callWorkflow` succeed with the session token and fail cleanly without one.
- `client-check.mjs` green and wired into `run-all.mjs`; the rest of the gate stays green.
- Data screens still render (from the blob) for a signed-in user — no functional regression to the visible app beyond the auth swap.
