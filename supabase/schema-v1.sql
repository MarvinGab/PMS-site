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
  library_key text,
  name text not null,
  library_type text not null,
  scope_type text,
  status text,
  version integer not null default 1,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table goal_libraries
  add column if not exists library_key text,
  add column if not exists scope_type text,
  add column if not exists status text,
  add column if not exists version integer not null default 1;

create unique index if not exists idx_goal_libraries_org_library_key
  on goal_libraries (organization_id, library_key)
  where library_key is not null;

create index if not exists idx_goal_libraries_org_type
  on goal_libraries (organization_id, library_type);

create table if not exists goal_library_assignments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  group_id text,
  group_name text not null,
  segment_attr text,
  slot_key text not null,
  slot_label text not null,
  source_library_id uuid references goal_libraries(id) on delete set null,
  source_library_key text,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists idx_goal_library_assignments_org_slot
  on goal_library_assignments (organization_id, group_id, slot_key);

create index if not exists idx_goal_library_assignments_org_library
  on goal_library_assignments (organization_id, source_library_id);

create table if not exists prefill_datasets (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  group_id text,
  group_name text not null,
  segment_attr text,
  slot_key text not null,
  slot_label text not null,
  prefill_type text not null,
  source_type text not null default 'custom',
  source_library_id uuid references goal_libraries(id) on delete set null,
  source_library_key text,
  status text not null default 'active',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists idx_prefill_datasets_org_slot
  on prefill_datasets (organization_id, group_id, slot_key);

create index if not exists idx_prefill_datasets_org_status
  on prefill_datasets (organization_id, status);

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

create table if not exists email_deliveries (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid references organizations(id) on delete cascade,
  recipient_email text not null,
  recipient_code text,
  delivery_type text not null,
  subject text not null,
  status text not null default 'queued',
  provider text,
  provider_message_id text,
  error_message text,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  sent_at timestamptz
);

create index if not exists idx_email_deliveries_org_created
  on email_deliveries (organization_id, created_at desc);

create index if not exists idx_email_deliveries_status
  on email_deliveries (status, created_at desc);

create table if not exists email_templates (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid references organizations(id) on delete cascade,
  owner_key text not null default 'global',
  template_key text not null,
  name text not null,
  subject text not null,
  config jsonb not null default '{}'::jsonb,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (owner_key, template_key)
);

create index if not exists idx_email_templates_template_key
  on email_templates (template_key, owner_key);

create table if not exists email_smtp_settings (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  is_enabled boolean not null default false,
  use_tls boolean not null default true,
  smtp_host text,
  smtp_port integer,
  smtp_username text,
  smtp_password text,
  from_name text,
  from_email text,
  footer_text text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id)
);

-- Multi-provider mail (SMTP / Microsoft Graph / Google Gmail API).
-- All secret-bearing columns store ciphertext using the same
-- enc:v1:<iv>:<ct> convention as smtp_password.
alter table email_smtp_settings
  add column if not exists provider text not null default 'smtp',
  add column if not exists ms_tenant_id text,
  add column if not exists ms_client_id text,
  add column if not exists ms_client_secret text,
  add column if not exists google_client_id text,
  add column if not exists google_client_secret text,
  add column if not exists google_refresh_token text;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'email_smtp_settings_provider_check'
  ) then
    alter table email_smtp_settings
      add constraint email_smtp_settings_provider_check
      check (provider in ('smtp', 'microsoft', 'google'));
  end if;
end $$;

create table if not exists app_audit_logs (
  id uuid primary key default gen_random_uuid(),
  org_key text,
  actor_role text,
  actor_code text,
  actor_name text,
  action_type text not null,
  target_type text,
  target_code text,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_app_audit_logs_org_created
  on app_audit_logs (org_key, created_at desc);

create index if not exists idx_app_audit_logs_action_created
  on app_audit_logs (action_type, created_at desc);

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
