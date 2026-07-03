-- One auth user maps to at most one roster row per org, so pms.self_employee_id()
-- and kernel employeeId resolution are deterministic.
create unique index employees_org_user_uidx
  on pms.employees(organization_id, user_id)
  where user_id is not null;
