-- New server-first world lives in schema "pms"; old "public" blob world is untouched.
create schema if not exists pms;
create extension if not exists citext;

-- Optimistic concurrency: bump version + updated_at on every UPDATE.
-- Writers must filter WHERE version = <expected>; zero rows updated = conflict.
create or replace function pms.touch_row() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  new.version := old.version + 1;
  return new;
end $$;

create table pms.organizations (
  id uuid primary key default gen_random_uuid(),
  key text not null unique,
  name text not null,
  status text not null default 'active' check (status in ('active','archived')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version int not null default 1
);

create table pms.organization_branding (
  organization_id uuid primary key references pms.organizations(id) on delete cascade,
  payload jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version int not null default 1
);

create table pms.org_members (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid references pms.organizations(id) on delete cascade, -- NULL = global super admin row
  user_id uuid not null references auth.users(id) on delete cascade,
  roles text[] not null default '{}' check (roles <@ array['super_admin','hr_admin','employee']::text[]),
  status text not null default 'active' check (status in ('active','invited','disabled')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version int not null default 1,
  unique nulls not distinct (organization_id, user_id)
);
create index org_members_user_idx on pms.org_members(user_id);

create table pms.employees (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references pms.organizations(id) on delete cascade,
  employee_code text not null,
  full_name text not null,
  email citext,
  designation text,
  department text,
  grade text,
  group_name text, -- 'NONE' = roster-only (outside PMS); never shown as "Outside PMS" in UI
  user_id uuid references auth.users(id) on delete set null,
  status text not null default 'active' check (status in ('active','inactive')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version int not null default 1,
  unique (organization_id, employee_code),
  unique (organization_id, email)
);
create index employees_org_idx on pms.employees(organization_id);
create index employees_user_idx on pms.employees(user_id);

create table pms.reporting_relationships (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references pms.organizations(id) on delete cascade,
  employee_id uuid not null references pms.employees(id) on delete cascade,
  related_employee_id uuid not null references pms.employees(id) on delete cascade,
  relation_type text not null check (relation_type in ('manager','l2','hod')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version int not null default 1,
  unique (organization_id, employee_id, relation_type),
  check (employee_id <> related_employee_id)
);
create index rr_related_idx on pms.reporting_relationships(organization_id, related_employee_id, relation_type);

create table pms.org_grades (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references pms.organizations(id) on delete cascade,
  label text not null,
  display_order int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version int not null default 1,
  unique (organization_id, label)
);

create table pms.competency_library (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references pms.organizations(id) on delete cascade,
  name text not null,
  type text,
  description text,
  status text not null default 'active' check (status in ('active','archived')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version int not null default 1,
  unique (organization_id, name)
);

create table pms.goal_libraries (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references pms.organizations(id) on delete cascade,
  name text not null,
  description text,
  status text not null default 'active' check (status in ('active','archived')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version int not null default 1,
  unique (organization_id, name)
);

create table pms.goal_library_items (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references pms.organizations(id) on delete cascade,
  goal_library_id uuid not null references pms.goal_libraries(id) on delete cascade,
  item_type text not null check (item_type in ('kra','kpi')),
  parent_item_id uuid references pms.goal_library_items(id) on delete cascade,
  title text not null,
  description text,
  perspective text,
  weight numeric,
  target_type_key text,
  target_value text,
  display_order int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version int not null default 1
);
create index gli_library_idx on pms.goal_library_items(goal_library_id);

create table pms.prefill_datasets (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references pms.organizations(id) on delete cascade,
  name text not null,
  description text,
  status text not null default 'active' check (status in ('active','archived')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version int not null default 1,
  unique (organization_id, name)
);

create table pms.prefill_dataset_items (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references pms.organizations(id) on delete cascade,
  prefill_dataset_id uuid not null references pms.prefill_datasets(id) on delete cascade,
  employee_code text not null,
  kra_title text not null,
  kpi_title text,
  weight numeric,
  perspective text,
  target_type_key text,
  target_value text,
  display_order int not null default 0,
  extra jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version int not null default 1
);
create index pdi_dataset_idx on pms.prefill_dataset_items(prefill_dataset_id);
create index pdi_code_idx on pms.prefill_dataset_items(prefill_dataset_id, employee_code);

-- Attach the version/updated_at trigger to every pms table that has a version column.
-- (Idempotent; re-run at the end of each schema migration.)
do $$
declare t text;
begin
  for t in select table_name from information_schema.tables
           where table_schema = 'pms' and table_type = 'BASE TABLE'
  loop
    if exists (select 1 from information_schema.columns
               where table_schema = 'pms' and table_name = t and column_name = 'version') then
      execute format('drop trigger if exists touch on pms.%I', t);
      execute format('create trigger touch before update on pms.%I for each row execute function pms.touch_row()', t);
    end if;
  end loop;
end $$;

-- Expose pms to the REST API (SQL equivalent of Dashboard → Data API → Exposed schemas).
alter role authenticator set pgrst.db_schemas = 'public, storage, graphql_public, pms';
notify pgrst, 'reload config';
