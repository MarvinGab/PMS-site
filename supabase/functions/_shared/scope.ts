import { ApiError, HandlerCtx } from './kernel.ts';

export function isHrOrSuper(ctx: HandlerCtx, orgId: string): boolean {
  return ctx.memberships.some((m) =>
    (m.organizationId === orgId && m.roles.includes('hr_admin')) ||
    (m.organizationId === null && m.roles.includes('super_admin')));
}

export function callerEmployeeId(ctx: HandlerCtx, orgId: string): string {
  const m = ctx.memberships.find((x) => x.organizationId === orgId);
  if (!m || !m.employeeId) throw new ApiError('NO_EMPLOYEE', 'This account has no employee record in this organization', 403);
  return m.employeeId;
}

// Optional employee id (null instead of throwing) — for callers who may be HR-only.
export function callerEmployeeIdOrNull(ctx: HandlerCtx, orgId: string): string | null {
  return ctx.memberships.find((x) => x.organizationId === orgId)?.employeeId ?? null;
}

async function hasRelation(
  ctx: HandlerCtx, orgId: string, targetEmployeeId: string, relTypes: string[],
): Promise<boolean> {
  const me = callerEmployeeIdOrNull(ctx, orgId);
  if (!me) return false;
  const { data, error } = await ctx.admin.from('reporting_relationships')
    .select('id').eq('organization_id', orgId).eq('employee_id', targetEmployeeId)
    .eq('related_employee_id', me).in('relation_type', relTypes).limit(1);
  if (error) { console.error('hasRelation', error); throw new ApiError('DB_ERROR', 'Database error', 500); }
  return (data ?? []).length > 0;
}

export function manages(ctx: HandlerCtx, orgId: string, targetEmployeeId: string): Promise<boolean> {
  return hasRelation(ctx, orgId, targetEmployeeId, ['manager', 'l2']);
}

export function isHodOf(ctx: HandlerCtx, orgId: string, targetEmployeeId: string): Promise<boolean> {
  return hasRelation(ctx, orgId, targetEmployeeId, ['hod']);
}
