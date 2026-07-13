// Derive the app identity from backend whoami memberships. This is the ONLY place role/org/employee
// are computed; kept pure (no browser/env imports) so it is unit-testable and shared with client-check.
// Membership shape (from admin.whoami / workflow.whoami): { memberId, organizationId, roles: string[], employeeId }.
export function deriveIdentity(memberships) {
  const list = Array.isArray(memberships) ? memberships : [];
  const superM = list.find((m) => m && m.organizationId == null && Array.isArray(m.roles) && m.roles.includes('super_admin'));
  if (superM) return { role: 'super_admin', orgId: null, employeeId: null, memberships: list };
  const orgM = list.find((m) => m && m.organizationId != null);
  if (!orgM) return { role: null, orgId: null, employeeId: null, memberships: list };
  const roles = Array.isArray(orgM.roles) ? orgM.roles : [];
  // Only recognise org-scoped roles here; a stray 'super_admin' on an org-scoped row must NOT
  // grant the super-admin UI (super admin is org-null only, checked above). Unknown role → null.
  const role = roles.includes('hr_admin') ? 'hr_admin' : roles.includes('employee') ? 'employee' : null;
  return { role, orgId: orgM.organizationId, employeeId: orgM.employeeId ?? null, memberships: list };
}
