create table pms.appraisal_cycles (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references pms.organizations(id) on delete cascade,
  name text not null,
  period_label text,
  framework_id text not null check (framework_id in ('bsc','kra-kpi','kra','custom')),
  status text not null default 'draft'
    check (status in ('draft','setup','active','review','published','archived')),
  feature_flags jsonb not null default '{}',
  activated_at timestamptz,
  archived_at timestamptz,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version int not null default 1
);
-- One WORKING cycle per org (draft/setup/active/review/published); archived history unlimited.
create unique index one_working_cycle_per_org
  on pms.appraisal_cycles(organization_id) where status <> 'archived';

create table pms.cycle_phase_windows (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references pms.organizations(id) on delete cascade,
  cycle_id uuid not null references pms.appraisal_cycles(id) on delete cascade,
  window_key text not null check (window_key in
    ('goal_creation','manager_approval','self_evaluation','manager_evaluation',
     'hod_review','hr_calibration','publishing_prep','acknowledgement')),
  starts_on date not null,
  ends_on date not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version int not null default 1,
  unique (cycle_id, window_key),
  check (ends_on >= starts_on)
);

create table pms.cycle_config_snapshots (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references pms.organizations(id) on delete cascade,
  cycle_id uuid not null unique references pms.appraisal_cycles(id) on delete cascade,
  snapshot jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version int not null default 1
);

create table pms.cycle_config_versions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references pms.organizations(id) on delete cascade,
  cycle_id uuid not null references pms.appraisal_cycles(id) on delete cascade,
  version_no int not null,
  snapshot jsonb not null,
  change_note text,
  changed_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  unique (cycle_id, version_no)
);

create table pms.cycle_perspectives (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references pms.organizations(id) on delete cascade,
  cycle_id uuid not null references pms.appraisal_cycles(id) on delete cascade,
  name text not null,
  weight numeric,
  color text,
  display_order int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version int not null default 1,
  unique (cycle_id, name)
);

create table pms.cycle_groups (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references pms.organizations(id) on delete cascade,
  cycle_id uuid not null references pms.appraisal_cycles(id) on delete cascade,
  name text not null,
  segment_attr text,
  is_catch_all boolean not null default false,
  can_edit_own_goals boolean not null default false,
  prefill_type text,
  has_library boolean not null default false,
  -- Kept separate on purpose (spec): where targets live vs where scores live.
  target_level text check (target_level in ('kra','kpi','custom')),
  rating_level text check (rating_level in ('kra','kpi')),
  kpi_rating_mode text,
  display_order int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version int not null default 1,
  unique (cycle_id, name)
);

create table pms.cycle_group_segment_values (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references pms.organizations(id) on delete cascade,
  cycle_id uuid not null references pms.appraisal_cycles(id) on delete cascade,
  group_id uuid not null references pms.cycle_groups(id) on delete cascade,
  value text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version int not null default 1,
  unique (group_id, value)
);

create table pms.cycle_group_library_assignments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references pms.organizations(id) on delete cascade,
  cycle_id uuid not null references pms.appraisal_cycles(id) on delete cascade,
  group_id uuid not null references pms.cycle_groups(id) on delete cascade,
  slot_key text not null,
  slot_label text,
  goal_library_id uuid references pms.goal_libraries(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version int not null default 1,
  unique (group_id, slot_key)
);

create table pms.cycle_target_types (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references pms.organizations(id) on delete cascade,
  cycle_id uuid not null references pms.appraisal_cycles(id) on delete cascade,
  target_type_key text not null,
  name text not null,
  is_numeric boolean not null default true,
  unit text,
  unit_position text check (unit_position in ('prefix','suffix')),
  min_value numeric,
  max_value numeric,
  lower_is_better boolean not null default false, -- real, used in scoring (spec §4.3.3)
  hidden boolean not null default false,
  display_order int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version int not null default 1,
  unique (cycle_id, target_type_key)
);

create table pms.cycle_rating_scale_levels (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references pms.organizations(id) on delete cascade,
  cycle_id uuid not null references pms.appraisal_cycles(id) on delete cascade,
  point numeric not null,
  label text not null,
  code text,
  range_from numeric,
  range_to numeric,
  display_order int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version int not null default 1,
  unique (cycle_id, point)
);

create table pms.cycle_auto_rating_bands (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references pms.organizations(id) on delete cascade,
  cycle_id uuid not null references pms.appraisal_cycles(id) on delete cascade,
  from_percent numeric not null,
  to_percent numeric not null,
  score numeric not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version int not null default 1,
  unique (cycle_id, from_percent)
);

create table pms.cycle_goal_rules (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references pms.organizations(id) on delete cascade,
  cycle_id uuid not null references pms.appraisal_cycles(id) on delete cascade,
  group_id uuid references pms.cycle_groups(id) on delete cascade, -- NULL = cycle-wide default
  min_kras int,
  max_kras int,
  min_kpis_per_kra int,
  max_kpis_per_kra int,
  min_kra_weight numeric,
  max_kra_weight numeric,
  min_kpi_weight numeric,
  weightage_ownership text,
  employee_can_add_goals boolean not null default false,
  max_employee_added_goals int,
  manager_can_add_goals boolean not null default false,
  approval_required boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version int not null default 1,
  unique nulls not distinct (cycle_id, group_id)
);

create table pms.cycle_competency_config (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references pms.organizations(id) on delete cascade,
  cycle_id uuid not null unique references pms.appraisal_cycles(id) on delete cascade,
  enabled boolean not null default false,
  max_per_employee int,
  competency_weight numeric,
  rated_by text,
  allow_self_rate boolean not null default false,
  employee_can_edit boolean not null default false,
  scope text not null default 'org' check (scope in ('org','group','group_role')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version int not null default 1
);

create table pms.cycle_competency_assignments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references pms.organizations(id) on delete cascade,
  cycle_id uuid not null references pms.appraisal_cycles(id) on delete cascade,
  group_id uuid references pms.cycle_groups(id) on delete cascade,   -- NULL = org-wide
  role_name text,                                                    -- NULL = whole group
  competency_id uuid references pms.competency_library(id),
  competency_name text not null, -- frozen name so history survives library edits
  kra_share numeric,
  competency_share numeric,
  display_order int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version int not null default 1
);
create index cca_cycle_idx on pms.cycle_competency_assignments(cycle_id);

create table pms.cycle_bell_curve_bands (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references pms.organizations(id) on delete cascade,
  cycle_id uuid not null references pms.appraisal_cycles(id) on delete cascade,
  rating_point numeric not null,
  target_percent numeric not null,
  tolerance_percent numeric not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version int not null default 1,
  unique (cycle_id, rating_point)
);

create table pms.cycle_participants (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references pms.organizations(id) on delete cascade,
  cycle_id uuid not null references pms.appraisal_cycles(id) on delete cascade,
  employee_id uuid not null references pms.employees(id) on delete cascade,
  status text not null default 'active' check (status in ('active','removed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version int not null default 1,
  unique (cycle_id, employee_id)
);
create index cp_employee_idx on pms.cycle_participants(employee_id);

create table pms.cycle_participant_assignments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references pms.organizations(id) on delete cascade,
  cycle_id uuid not null references pms.appraisal_cycles(id) on delete cascade,
  participant_id uuid not null unique references pms.cycle_participants(id) on delete cascade,
  employee_id uuid not null references pms.employees(id) on delete cascade, -- denormalized for RLS
  group_id uuid references pms.cycle_groups(id),
  goal_library_id uuid references pms.goal_libraries(id),
  prefill_dataset_id uuid references pms.prefill_datasets(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version int not null default 1
);

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
