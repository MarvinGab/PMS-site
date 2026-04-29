# Supabase rollout plan

## Current scope for v1

Productionize only the modules that are already operational in the local app:

- organization setup
- branding
- employee upload and routing
- goal libraries and prefill
- employee goal creation
- manager review / send-back / approve
- basic team messaging
- admin monitoring dashboards

Do not try to backend the unfinished runtime modules in the first pass:

- self-evaluation
- manager rating
- HR review
- results publishing
- competencies runtime
- questionnaire runtime
- bell curve / normalization runtime
- IDP / potential flows

These should show as `Coming soon` / `Not enabled for this cycle`, not as broken half-wired surfaces.

## Auth decision

Employee login must support:

1. employee code + password
2. email + password when email exists for that employee

For v1 this should be implemented as a custom app login flow backed by Supabase tables, not by exposing privileged keys in the browser.

## Security rule

- Frontend uses only:
  - `VITE_SUPABASE_URL`
  - `VITE_SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY` must stay server-side only.

## Integration phases

### Phase 1: foundation

- add Supabase client
- add environment-based backend mode
- keep localhost fallback while migrating
- create a data-access boundary so components stop talking directly to browser storage

### Phase 2: schema and persistence

Move these browser-storage areas first:

- organizations
- wizard config
- employees
- goal workflow submissions
- messages
- notifications
- branding assets

### Phase 3: authentication

- custom employee login by employee code or email
- password verification against backend-managed credentials
- role-aware session model for:
  - super admin
  - hr admin
  - employee
  - manager

### Phase 4: production hardening

- file upload storage
- audit trail for approvals and send-backs
- row-level access rules
- multi-user validation across devices

## What changes first in code

Replace direct browser persistence behind a backend adapter for:

- `src/AppContext.jsx`
- `src/PMSWizard.jsx`
- `src/pages/EmployeePage.jsx`
- `src/pages/HRCycleDashboard.jsx`
- `src/pages/LoginPage.jsx`

## Immediate next implementation step

Build the adapter layer for:

- auth
- org/app data
- workflow
- messages

Then wire one flow end to end before touching everything else:

1. login
2. load org/config/employees
3. load workflow
4. save submission
5. manager review

