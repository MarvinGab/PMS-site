create table if not exists employee_ratings (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  employee_code text not null,
  stage text not null,
  payload jsonb not null default '{}'::jsonb,
  submitted_at timestamptz,
  submitted_by text,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (organization_id, employee_code, stage),
  constraint employee_ratings_stage_check check (stage in ('self', 'manager', 'final'))
);

create index if not exists idx_employee_ratings_org_stage
  on employee_ratings (organization_id, stage, submitted_at desc);

create index if not exists idx_employee_ratings_org_employee
  on employee_ratings (organization_id, employee_code, updated_at desc);

