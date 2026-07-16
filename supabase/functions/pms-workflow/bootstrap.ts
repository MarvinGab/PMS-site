import { ApiError, Handler, HandlerCtx } from '../_shared/kernel.ts';
import { pureWindowOpen } from '../_shared/phase.ts';

// phase.ts's todayIso() is module-private — mirror it here (date-granular, UTC).
function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

type Window = { window_key: string; starts_on: string; ends_on: string };
type Phase = 'goal-setting' | 'self-evaluation' | 'manager-rating' | 'hr-review';

// Discovery (Plan 5b Task 1, live acme-test project): appraisal_cycles.status is one of
// draft/setup/active/review/published/archived (schema check constraint); at most one
// non-archived ("working") cycle exists per org (one_working_cycle_per_org unique index).
// cycle_phase_windows.window_key is one of goal_creation/manager_approval/self_evaluation/
// manager_evaluation/hod_review/hr_calibration/publishing_prep/acknowledgement.
const CYCLE_STATUS_PRIORITY: Record<string, number> = { active: 0, review: 1, published: 2, setup: 3, draft: 4 };
const LAUNCHED_STATUSES = new Set(['active', 'review', 'published']);

// Map the org's open phase windows (highest-precedence phase first, in case more than
// one window is open at once) to the 4 frontend phase ids; when none are open, fall back
// to the cycle's status (review -> hr-review, active -> goal-setting); otherwise null.
function deriveCurrentPhase(windows: Window[], cycleStatus: string, today: string): Phase | null {
  if (pureWindowOpen(windows, 'hr_calibration', today) || pureWindowOpen(windows, 'hod_review', today)) return 'hr-review';
  if (pureWindowOpen(windows, 'manager_evaluation', today)) return 'manager-rating';
  if (pureWindowOpen(windows, 'self_evaluation', today)) return 'self-evaluation';
  if (pureWindowOpen(windows, 'goal_creation', today) || pureWindowOpen(windows, 'manager_approval', today)) return 'goal-setting';
  if (cycleStatus === 'review') return 'hr-review';
  if (cycleStatus === 'active') return 'goal-setting';
  return null;
}

// One scoped read for the shell: the caller's org, employee record (if any), the org's
// current cycle + derived phase, and their manager/hod-of-reports counts. Ungated — any
// authenticated member (mirrors workflow.whoami) — always returns the CALLER's own data.
export const bootstrapHandlers: Record<string, Handler> = {
  'workflow.bootstrap': async (_payload: Record<string, unknown>, ctx: HandlerCtx) => {
    const membership = ctx.memberships.find((m) => m.organizationId !== null);
    if (!membership || !membership.organizationId) {
      throw new ApiError('NO_ORG_MEMBERSHIP', 'This account has no organization membership', 403);
    }
    const orgId = membership.organizationId;

    const { data: org, error: orgErr } = await ctx.admin.from('organizations')
      .select('id, key, name').eq('id', orgId).maybeSingle();
    if (orgErr) { console.error('bootstrap org', orgErr); throw new ApiError('DB_ERROR', 'Database error', 500); }
    if (!org) throw new ApiError('NOT_FOUND', 'Organization not found', 404);

    // Deterministic "current cycle" read: all non-archived cycles for the org (order+limit,
    // not an ambiguous .maybeSingle() — the unique index means there's at most one, but we
    // rank explicitly rather than assume). launched is derived from the same result set.
    const { data: cycleRows, error: cErr } = await ctx.admin.from('appraisal_cycles')
      .select('id, name, status, created_at')
      .eq('organization_id', orgId).neq('status', 'archived')
      .order('created_at', { ascending: false });
    if (cErr) { console.error('bootstrap cycles', cErr); throw new ApiError('DB_ERROR', 'Database error', 500); }
    const rows = cycleRows ?? [];
    const cycleRow = [...rows].sort(
      (a, b) => (CYCLE_STATUS_PRIORITY[a.status] ?? 99) - (CYCLE_STATUS_PRIORITY[b.status] ?? 99),
    )[0] ?? null;
    const launched = rows.some((c) => LAUNCHED_STATUSES.has(c.status as string));

    let currentPhase: Phase | null = null;
    if (cycleRow) {
      const { data: windows, error: wErr } = await ctx.admin.from('cycle_phase_windows')
        .select('window_key, starts_on, ends_on').eq('cycle_id', cycleRow.id).eq('organization_id', orgId);
      if (wErr) { console.error('bootstrap windows', wErr); throw new ApiError('DB_ERROR', 'Database error', 500); }
      currentPhase = deriveCurrentPhase((windows ?? []) as Window[], cycleRow.status as string, todayIso());
    }

    const employeeId = membership.employeeId;
    let employee: { id: string; code: string; name: string; designation: string | null; managerCode: string | null } | null = null;
    let isManager = false;
    let directReportsCount = 0;
    let hodReportsCount = 0;

    if (employeeId) {
      const { data: empRow, error: eErr } = await ctx.admin.from('employees')
        .select('id, employee_code, full_name, designation')
        .eq('id', employeeId).eq('organization_id', orgId).maybeSingle();
      if (eErr) { console.error('bootstrap employee', eErr); throw new ApiError('DB_ERROR', 'Database error', 500); }

      if (empRow) {
        // The caller's own manager: reporting_relationships row keyed by relation_type
        // 'manager' is unique per employee (unique (organization_id, employee_id, relation_type)).
        const { data: mgrRel, error: mErr } = await ctx.admin.from('reporting_relationships')
          .select('related_employee_id').eq('organization_id', orgId)
          .eq('employee_id', employeeId).eq('relation_type', 'manager').maybeSingle();
        if (mErr) { console.error('bootstrap manager rel', mErr); throw new ApiError('DB_ERROR', 'Database error', 500); }
        let managerCode: string | null = null;
        if (mgrRel?.related_employee_id) {
          const { data: mgrEmp, error: mgrErr } = await ctx.admin.from('employees')
            .select('employee_code').eq('id', mgrRel.related_employee_id).eq('organization_id', orgId).maybeSingle();
          if (mgrErr) { console.error('bootstrap manager emp', mgrErr); throw new ApiError('DB_ERROR', 'Database error', 500); }
          managerCode = (mgrEmp?.employee_code as string | undefined) ?? null;
        }
        employee = {
          id: empRow.id as string,
          code: empRow.employee_code as string,
          name: empRow.full_name as string,
          designation: (empRow.designation as string | null) ?? null,
          managerCode,
        };
      }

      // Reports: everyone whose reporting_relationships row points related_employee_id at
      // me (mirrors _shared/scope.ts manages()/isHodOf() — same table, reverse direction).
      const { data: rels, error: rErr } = await ctx.admin.from('reporting_relationships')
        .select('relation_type').eq('organization_id', orgId)
        .eq('related_employee_id', employeeId).in('relation_type', ['manager', 'l2', 'hod']);
      if (rErr) { console.error('bootstrap relations', rErr); throw new ApiError('DB_ERROR', 'Database error', 500); }
      for (const r of rels ?? []) {
        if (r.relation_type === 'manager' || r.relation_type === 'l2') directReportsCount += 1;
        else if (r.relation_type === 'hod') hodReportsCount += 1;
      }
      isManager = directReportsCount > 0;
    }

    return {
      org: { id: org.id, key: org.key, name: org.name, launched },
      employee,
      cycle: cycleRow ? { id: cycleRow.id, name: cycleRow.name, status: cycleRow.status } : null,
      currentPhase,
      isManager,
      directReportsCount,
      hodReportsCount,
    };
  },
};
