-- Supabase schema draft for PMS v1
-- Scope: current live modules only.
-- Do not include unfinished rating / competency runtime in this first migration.

create extension if not exists pgcrypto;

create table if not exists app_state (
  id uuid primary key default gen_random_uuid(),
  state_key text not null,
  org_key text not null default '',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (state_key, org_key)
);

create table if not exists organizations (
  id uuid primary key default gen_random_uuid(),
  org_key text not null unique,
  org_code text,
  name text not null,
  workspace_slug text,
  domain text,
  industry text,
  hr_admin_name text,
  hr_admin_email text,
  pms_calendar text,
  launched boolean not null default false,
  current_phase text not null default 'goal-setting',
  status text,
  setup_pct integer not null default 0,
  setup_payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists idx_organizations_workspace_slug
  on organizations (workspace_slug)
  where workspace_slug is not null;

create unique index if not exists idx_organizations_domain
  on organizations (domain)
  where domain is not null;

create table if not exists organization_branding (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  brand_name text,
  brand_logo_url text,
  brand_palette jsonb not null default '{}'::jsonb,
  brand_hero jsonb not null default '{}'::jsonb,
  brand_cards text,
  brand_fill text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id)
);

create table if not exists employees (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  employee_code text not null,
  employee_name text not null,
  email text,
  password_hash text,
  designation text,
  department text,
  group_name text,
  manager_code text,
  manager_name text,
  manager_email text,
  pms_stage text not null default 'goal-creation',
  is_in_pms boolean not null default true,
  raw_payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, employee_code)
);

create index if not exists idx_employees_org_email on employees (organization_id, email);
create index if not exists idx_employees_org_manager on employees (organization_id, manager_code);

create table if not exists pms_configs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  framework_id text not null,
  config jsonb not null default '{}'::jsonb,
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id)
);

create table if not exists goal_workflows (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  employee_code text not null,
  status text not null default 'draft',
  submitted_at timestamptz,
  approved_at timestamptz,
  manager_decision_at timestamptz,
  manager_note text not null default '',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, employee_code)
);

create index if not exists idx_goal_workflows_org_status on goal_workflows (organization_id, status);

create table if not exists goal_libraries (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  group_id text,
  name text not null,
  library_type text not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists messages (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  conversation_key text not null,
  sender_code text not null,
  recipient_code text not null,
  body text not null,
  sent_at timestamptz not null default now(),
  read_at timestamptz
);

create index if not exists idx_messages_org_conversation on messages (organization_id, conversation_key, sent_at);

create table if not exists notifications (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  recipient_code text not null,
  sender_code text,
  submission_code text,
  type text not null,
  title text not null,
  message text not null,
  read boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists idx_notifications_org_recipient on notifications (organization_id, recipient_code, created_at desc);

-- Notes
-- 1. `app_state` is the fast migration path for localhost parity.
--    Use it first for:
--    - app_data
--    - wizard_state
--    - workflow
--    - messages
-- 2. Password verification should move to a server-side function or secure auth service flow.
-- 3. The frontend anon key must never be used to write unrestricted employee credentials.
-- 4. Rating / competency tables should be added only when those runtime flows are genuinely shipped.
