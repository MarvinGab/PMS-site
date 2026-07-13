create table if not exists rating_publications (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  published_at timestamptz,
  published_by text,
  publish_reason text not null default '',
  unpublished_at timestamptz,
  unpublished_by text,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (organization_id)
);

create index if not exists idx_rating_publications_org_updated
  on rating_publications (organization_id, updated_at desc);

create table if not exists rating_acknowledgements (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  employee_code text not null,
  decision text not null default '',
  reason text not null default '',
  submitted_at timestamptz,
  submitted_by text,
  resolution jsonb,
  round integer not null default 1,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (organization_id, employee_code),
  constraint rating_acknowledgements_decision_check check (decision in ('', 'accepted', 'rejected'))
);

create index if not exists idx_rating_acknowledgements_org_decision
  on rating_acknowledgements (organization_id, decision, updated_at desc);
