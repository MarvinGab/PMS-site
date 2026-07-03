create table pms.employee_goal_plans (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references pms.organizations(id) on delete cascade,
  cycle_id uuid not null references pms.appraisal_cycles(id) on delete cascade,
  employee_id uuid not null references pms.employees(id) on delete cascade,
  status text not null default 'draft'
    check (status in ('draft','submitted','approved','sent_back','reopened')),
  submitted_at timestamptz,
  approved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version int not null default 1,
  unique (cycle_id, employee_id)
);
create index egp_employee_idx on pms.employee_goal_plans(cycle_id, employee_id);

create table pms.employee_goal_items (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references pms.organizations(id) on delete cascade,
  cycle_id uuid not null references pms.appraisal_cycles(id) on delete cascade,
  plan_id uuid not null references pms.employee_goal_plans(id) on delete cascade,
  employee_id uuid not null references pms.employees(id) on delete cascade, -- denormalized for RLS
  item_type text not null check (item_type in ('kra','kpi')),
  parent_item_id uuid references pms.employee_goal_items(id) on delete cascade,
  title text not null,
  description text,
  perspective text,
  weight numeric,
  target_type_key text,
  target_value text,
  source text not null default 'employee' check (source in ('library','prefill','employee','manager')),
  display_order int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version int not null default 1
);
create index egi_plan_idx on pms.employee_goal_items(plan_id);

create table pms.employee_goal_plan_competencies (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references pms.organizations(id) on delete cascade,
  cycle_id uuid not null references pms.appraisal_cycles(id) on delete cascade,
  plan_id uuid not null references pms.employee_goal_plans(id) on delete cascade,
  employee_id uuid not null references pms.employees(id) on delete cascade,
  competency_name text not null,
  display_order int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version int not null default 1,
  unique (plan_id, competency_name)
);

-- Append-only event log: no version column, no updates.
create table pms.goal_workflow_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references pms.organizations(id) on delete cascade,
  cycle_id uuid not null references pms.appraisal_cycles(id) on delete cascade,
  plan_id uuid not null references pms.employee_goal_plans(id) on delete cascade,
  employee_id uuid not null references pms.employees(id) on delete cascade,
  event_type text not null check (event_type in ('submitted','approved','sent_back','reopened','amended')),
  actor_user_id uuid references auth.users(id),
  actor_role text,
  note text,
  created_at timestamptz not null default now()
);
create index gwe_plan_idx on pms.goal_workflow_events(plan_id);

create table pms.evaluations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references pms.organizations(id) on delete cascade,
  cycle_id uuid not null references pms.appraisal_cycles(id) on delete cascade,
  employee_id uuid not null references pms.employees(id) on delete cascade,
  stage text not null check (stage in ('self','manager','hod','hr_final')),
  status text not null default 'draft' check (status in ('draft','submitted')),
  overall_score numeric,
  overall_comment text,
  submitted_at timestamptz,
  submitted_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version int not null default 1,
  unique (cycle_id, employee_id, stage)
);
create index eval_employee_idx on pms.evaluations(cycle_id, employee_id);

create table pms.evaluation_goal_scores (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references pms.organizations(id) on delete cascade,
  cycle_id uuid not null references pms.appraisal_cycles(id) on delete cascade,
  evaluation_id uuid not null references pms.evaluations(id) on delete cascade,
  goal_item_id uuid not null references pms.employee_goal_items(id) on delete cascade,
  achievement_value text,
  achievement_percent numeric,
  score numeric,
  comment text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version int not null default 1,
  unique (evaluation_id, goal_item_id)
);

create table pms.evaluation_competency_scores (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references pms.organizations(id) on delete cascade,
  cycle_id uuid not null references pms.appraisal_cycles(id) on delete cascade,
  evaluation_id uuid not null references pms.evaluations(id) on delete cascade,
  competency_name text not null,
  score numeric,
  comment text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version int not null default 1,
  unique (evaluation_id, competency_name)
);

-- Append-only: every calibration adjustment is its own row (before/after/actor).
create table pms.calibrations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references pms.organizations(id) on delete cascade,
  cycle_id uuid not null references pms.appraisal_cycles(id) on delete cascade,
  employee_id uuid not null references pms.employees(id) on delete cascade,
  stage text not null check (stage in ('hod','hr_final')),
  before_score numeric,
  after_score numeric,
  note text,
  actor_user_id uuid references auth.users(id),
  created_at timestamptz not null default now()
);
create index calib_employee_idx on pms.calibrations(cycle_id, employee_id);

create table pms.cycle_publications (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references pms.organizations(id) on delete cascade,
  cycle_id uuid not null references pms.appraisal_cycles(id) on delete cascade,
  published_at timestamptz not null default now(),
  published_by uuid references auth.users(id),
  revoked_at timestamptz,
  revoked_by uuid references auth.users(id),
  reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version int not null default 1
);
create index cpub_cycle_idx on pms.cycle_publications(cycle_id);

create table pms.rating_acknowledgements (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references pms.organizations(id) on delete cascade,
  cycle_id uuid not null references pms.appraisal_cycles(id) on delete cascade,
  employee_id uuid not null references pms.employees(id) on delete cascade,
  decision text not null check (decision in ('accepted','concern')),
  reason text,
  submitted_at timestamptz not null default now(),
  resolution_status text check (resolution_status in ('open','explained','recalibrated')),
  resolution_note text,
  resolved_by uuid references auth.users(id),
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version int not null default 1,
  unique (cycle_id, employee_id)
);

-- No version column: append + owner marks read_at (the one allowed client write).
create table pms.notifications (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references pms.organizations(id) on delete cascade,
  cycle_id uuid references pms.appraisal_cycles(id) on delete set null,
  recipient_member_id uuid not null references pms.org_members(id) on delete cascade,
  type text not null,
  title text not null,
  body text,
  read_at timestamptz,
  created_at timestamptz not null default now()
);
create index notif_recipient_idx on pms.notifications(recipient_member_id, created_at desc);

create table pms.email_jobs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references pms.organizations(id) on delete cascade,
  cycle_id uuid references pms.appraisal_cycles(id) on delete set null,
  template_key text not null,
  recipient_email citext not null,
  recipient_member_id uuid references pms.org_members(id) on delete set null,
  subject text,
  payload jsonb not null default '{}',
  status text not null default 'queued'
    check (status in ('queued','sending','sent','failed','cancelled')),
  scheduled_at timestamptz not null default now(),
  sent_at timestamptz,
  last_error text,
  attempts int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version int not null default 1
);
create index ejobs_status_idx on pms.email_jobs(status, scheduled_at);

create table pms.email_delivery_attempts (
  id uuid primary key default gen_random_uuid(),
  email_job_id uuid not null references pms.email_jobs(id) on delete cascade,
  status text not null,
  provider text,
  provider_response text,
  attempted_at timestamptz not null default now()
);
create index eda_job_idx on pms.email_delivery_attempts(email_job_id);

create table pms.background_jobs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references pms.organizations(id) on delete cascade,
  cycle_id uuid references pms.appraisal_cycles(id) on delete set null,
  job_type text not null,
  status text not null default 'queued'
    check (status in ('queued','running','done','failed','cancelled')),
  progress int not null default 0,
  total int,
  payload jsonb not null default '{}',
  result jsonb,
  error text,
  retry_count int not null default 0,
  max_retries int not null default 3,
  scheduled_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version int not null default 1
);
create index bjobs_status_idx on pms.background_jobs(status, scheduled_at);

create table pms.import_runs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references pms.organizations(id) on delete cascade,
  cycle_id uuid references pms.appraisal_cycles(id) on delete set null,
  kind text not null default 'roster',
  status text not null default 'validating'
    check (status in ('validating','preview_ready','committing','committed','failed','discarded')),
  file_name text,
  total_rows int,
  valid_rows int,
  error_rows int,
  created_by uuid references auth.users(id),
  committed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version int not null default 1
);

create table pms.import_run_errors (
  id uuid primary key default gen_random_uuid(),
  import_run_id uuid not null references pms.import_runs(id) on delete cascade,
  row_number int,
  column_name text,
  error text not null,
  row_data jsonb,
  created_at timestamptz not null default now()
);
create index ire_run_idx on pms.import_run_errors(import_run_id);

-- Append-only audit trail.
create table pms.audit_logs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references pms.organizations(id) on delete cascade,
  cycle_id uuid references pms.appraisal_cycles(id) on delete set null,
  actor_user_id uuid references auth.users(id),
  actor_role text,
  action text not null,
  entity_type text,
  entity_id uuid,
  before jsonb,
  after jsonb,
  note text,
  created_at timestamptz not null default now()
);
create index audit_org_idx on pms.audit_logs(organization_id, created_at desc);

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
