create unique index if not exists idx_employees_org_email_unique_active
  on employees (organization_id, lower(email))
  where email is not null
    and trim(email) <> ''
    and lower(email) not like 'dummy%@%'
    and is_in_pms = true;
