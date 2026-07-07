import { ApiError, Handler, HandlerCtx } from '../_shared/kernel.ts';
import { optString, reqInt, reqString, reqUuid } from '../_shared/validate.ts';
import { callerEmployeeId, isHrOrSuper, manages } from '../_shared/scope.ts';
import { loadActiveCycle, requireWindowOrHr } from '../_shared/phase.ts';
import { GoalNode, validateGoalTree } from './goalrules.ts';

async function loadPlanById(ctx: HandlerCtx, orgId: string, cycleId: string, employeeId: string) {
  const { data: plan, error } = await ctx.admin.from('employee_goal_plans')
    .select().eq('cycle_id', cycleId).eq('employee_id', employeeId).eq('organization_id', orgId).maybeSingle();
  if (error) { console.error('loadPlan', error); throw new ApiError('DB_ERROR', 'Database error', 500); }
  if (!plan) throw new ApiError('NOT_FOUND', 'Goal plan not found', 404);
  return plan;
}

async function appendEvent(ctx: HandlerCtx, orgId: string, cycleId: string, planId: string, employeeId: string, eventType: string, note: string | null) {
  const { error } = await ctx.admin.from('goal_workflow_events').insert({
    organization_id: orgId, cycle_id: cycleId, plan_id: planId, employee_id: employeeId,
    event_type: eventType, actor_user_id: ctx.userId, note,
  });
  if (error) { console.error('appendEvent', error); throw new ApiError('DB_ERROR', 'Database error', 500); }
}

// The merged-rules loader + node shape are duplicated minimally here to keep goalflow self-contained.
async function mergedRules(ctx: HandlerCtx, cycleId: string, employeeId: string) {
  const { data: assign } = await ctx.admin.from('cycle_participant_assignments')
    .select('group_id').eq('cycle_id', cycleId).eq('employee_id', employeeId).maybeSingle();
  const groupId = assign?.group_id ?? null;
  const { data } = await ctx.admin.from('cycle_goal_rules').select().eq('cycle_id', cycleId);
  const rows = data ?? [];
  return (rows.find((r) => groupId && r.group_id === groupId) ?? rows.find((r) => r.group_id === null) ?? {
    min_kras: null, max_kras: null, min_kpis_per_kra: null, max_kpis_per_kra: null,
    min_kra_weight: null, max_kra_weight: null, min_kpi_weight: null,
  });
}

export const goalFlowHandlers: Record<string, Handler> = {
  'goal.submit': async (payload, ctx) => {
    const orgId = reqUuid(payload.orgId, 'orgId');
    const cycleId = reqUuid(payload.cycleId, 'cycleId');
    const planVersion = reqInt(payload.planVersion, 'planVersion');
    await loadActiveCycle(ctx, orgId, cycleId);
    const employeeId = callerEmployeeId(ctx, orgId);
    await requireWindowOrHr(ctx, orgId, cycleId, 'goal_creation');
    const plan = await loadPlanById(ctx, orgId, cycleId, employeeId);
    if (!['draft', 'sent_back', 'reopened'].includes(plan.status)) {
      throw new ApiError('PLAN_LOCKED', `A ${plan.status} plan cannot be submitted`, 409);
    }
    // Re-validate the saved tree at submit time.
    const { data: items } = await ctx.admin.from('employee_goal_items').select('id, item_type, parent_item_id, weight').eq('plan_id', plan.id);
    if (!items || items.length === 0) throw new ApiError('GOAL_RULES', 'Add at least one goal before submitting', 422);
    const nodes: GoalNode[] = items.map((it) => ({
      key: it.id, itemType: it.item_type, parentKey: it.parent_item_id, weight: it.weight,
    }));
    validateGoalTree(nodes, await mergedRules(ctx, cycleId, employeeId) as any);
    const fresh = await ctx.versionedUpdate('employee_goal_plans', orgId, plan.id, planVersion, {
      status: 'submitted', submitted_at: new Date().toISOString(),
    });
    await appendEvent(ctx, orgId, cycleId, plan.id, employeeId, 'submitted', null);
    await ctx.audit({ organizationId: orgId, cycleId, action: 'goal.submit', entityType: 'employee_goal_plan', entityId: plan.id, before: { status: plan.status }, after: { status: 'submitted' } });
    return { plan: fresh };
  },

  'goal.approve': async (payload, ctx) => {
    const orgId = reqUuid(payload.orgId, 'orgId');
    const cycleId = reqUuid(payload.cycleId, 'cycleId');
    const employeeId = reqUuid(payload.employeeId, 'employeeId');
    const planVersion = reqInt(payload.planVersion, 'planVersion');
    await loadActiveCycle(ctx, orgId, cycleId);
    if (!isHrOrSuper(ctx, orgId) && !(await manages(ctx, orgId, employeeId))) {
      throw new ApiError('FORBIDDEN', 'Only the manager can approve this plan', 403);
    }
    await requireWindowOrHr(ctx, orgId, cycleId, 'manager_approval');
    const plan = await loadPlanById(ctx, orgId, cycleId, employeeId);
    if (plan.status !== 'submitted') throw new ApiError('PLAN_STATE', `Only a submitted plan can be approved (this is ${plan.status})`, 409);
    const fresh = await ctx.versionedUpdate('employee_goal_plans', orgId, plan.id, planVersion, {
      status: 'approved', approved_at: new Date().toISOString(),
    });
    await appendEvent(ctx, orgId, cycleId, plan.id, employeeId, 'approved', null);
    await ctx.audit({ organizationId: orgId, cycleId, action: 'goal.approve', entityType: 'employee_goal_plan', entityId: plan.id, before: { status: 'submitted' }, after: { status: 'approved' } });
    return { plan: fresh };
  },

  'goal.send-back': async (payload, ctx) => {
    const orgId = reqUuid(payload.orgId, 'orgId');
    const cycleId = reqUuid(payload.cycleId, 'cycleId');
    const employeeId = reqUuid(payload.employeeId, 'employeeId');
    const planVersion = reqInt(payload.planVersion, 'planVersion');
    const note = reqString(payload.note, 'note', 2000);
    await loadActiveCycle(ctx, orgId, cycleId);
    if (!isHrOrSuper(ctx, orgId) && !(await manages(ctx, orgId, employeeId))) {
      throw new ApiError('FORBIDDEN', 'Only the manager can send back this plan', 403);
    }
    await requireWindowOrHr(ctx, orgId, cycleId, 'manager_approval');
    const plan = await loadPlanById(ctx, orgId, cycleId, employeeId);
    if (plan.status !== 'submitted') throw new ApiError('PLAN_STATE', `Only a submitted plan can be sent back (this is ${plan.status})`, 409);
    const fresh = await ctx.versionedUpdate('employee_goal_plans', orgId, plan.id, planVersion, { status: 'sent_back' });
    await appendEvent(ctx, orgId, cycleId, plan.id, employeeId, 'sent_back', note);
    await ctx.audit({ organizationId: orgId, cycleId, action: 'goal.send-back', entityType: 'employee_goal_plan', entityId: plan.id, before: { status: 'submitted' }, after: { status: 'sent_back' }, note });
    return { plan: fresh };
  },

  'goal.reopen': async (payload, ctx) => {
    const orgId = reqUuid(payload.orgId, 'orgId');
    const cycleId = reqUuid(payload.cycleId, 'cycleId');
    const employeeId = reqUuid(payload.employeeId, 'employeeId');
    const planVersion = reqInt(payload.planVersion, 'planVersion');
    const note = optString(payload.note, 'note', 2000);
    await loadActiveCycle(ctx, orgId, cycleId);
    if (!isHrOrSuper(ctx, orgId)) throw new ApiError('FORBIDDEN', 'Only HR can reopen an approved plan', 403);
    const plan = await loadPlanById(ctx, orgId, cycleId, employeeId);
    if (plan.status !== 'approved') throw new ApiError('PLAN_STATE', `Only an approved plan can be reopened (this is ${plan.status})`, 409);
    const fresh = await ctx.versionedUpdate('employee_goal_plans', orgId, plan.id, planVersion, { status: 'reopened' });
    await appendEvent(ctx, orgId, cycleId, plan.id, employeeId, 'reopened', note);
    await ctx.audit({ organizationId: orgId, cycleId, action: 'goal.reopen', entityType: 'employee_goal_plan', entityId: plan.id, before: { status: 'approved' }, after: { status: 'reopened' }, note: note ?? undefined });
    return { plan: fresh };
  },
};
