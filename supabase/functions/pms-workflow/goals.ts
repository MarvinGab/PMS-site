import { ApiError, Handler, HandlerCtx } from '../_shared/kernel.ts';
import { optUuid, reqUuid } from '../_shared/validate.ts';
import { callerEmployeeId, isHodOf, isHrOrSuper, manages } from '../_shared/scope.ts';
import { loadActiveCycle } from '../_shared/phase.ts';

async function readPlanBundle(ctx: HandlerCtx, orgId: string, cycleId: string, employeeId: string) {
  const { data: plan, error } = await ctx.admin.from('employee_goal_plans')
    .select().eq('cycle_id', cycleId).eq('employee_id', employeeId).eq('organization_id', orgId).maybeSingle();
  if (error) { console.error('readPlan', error); throw new ApiError('DB_ERROR', 'Database error', 500); }
  if (!plan) return { plan: null, items: [], competencies: [] };
  const { data: items } = await ctx.admin.from('employee_goal_items')
    .select().eq('plan_id', plan.id).order('display_order');
  const { data: comps } = await ctx.admin.from('employee_goal_plan_competencies')
    .select().eq('plan_id', plan.id).order('display_order');
  return { plan, items: items ?? [], competencies: comps ?? [] };
}

// May the caller read/act on this target employee's plan?
async function canAccessTarget(ctx: HandlerCtx, orgId: string, targetEmployeeId: string): Promise<boolean> {
  if (isHrOrSuper(ctx, orgId)) return true;
  if (callerEmployeeId(ctx, orgId) === targetEmployeeId) return true;
  if (await manages(ctx, orgId, targetEmployeeId)) return true;
  if (await isHodOf(ctx, orgId, targetEmployeeId)) return true;
  return false;
}

export const goalHandlers: Record<string, Handler> = {
  'goal.get-plan': async (payload, ctx) => {
    const orgId = reqUuid(payload.orgId, 'orgId');
    const cycleId = reqUuid(payload.cycleId, 'cycleId');
    const targetId = optUuid(payload.employeeId, 'employeeId') ?? callerEmployeeId(ctx, orgId);
    if (!(await canAccessTarget(ctx, orgId, targetId))) {
      throw new ApiError('FORBIDDEN', 'You cannot view this employee\'s goals', 403);
    }
    return await readPlanBundle(ctx, orgId, cycleId, targetId);
  },

  'goal.ensure-plan': async (payload, ctx) => {
    const orgId = reqUuid(payload.orgId, 'orgId');
    const cycleId = reqUuid(payload.cycleId, 'cycleId');
    await loadActiveCycle(ctx, orgId, cycleId);
    const employeeId = callerEmployeeId(ctx, orgId);

    const { data: participant, error: pErr } = await ctx.admin.from('cycle_participants')
      .select('id, status').eq('cycle_id', cycleId).eq('employee_id', employeeId).eq('organization_id', orgId).maybeSingle();
    if (pErr) { console.error('ensure participant', pErr); throw new ApiError('DB_ERROR', 'Database error', 500); }
    if (!participant || participant.status !== 'active') {
      throw new ApiError('NOT_A_PARTICIPANT', 'You are not an active participant in this cycle', 403);
    }

    const existing = await readPlanBundle(ctx, orgId, cycleId, employeeId);
    if (existing.plan) return { ...existing, seeded: 0 };

    // Create the draft plan.
    const { data: plan, error: planErr } = await ctx.admin.from('employee_goal_plans')
      .insert({ organization_id: orgId, cycle_id: cycleId, employee_id: employeeId, status: 'draft' })
      .select().single();
    if (planErr) {
      if (planErr.code === '23505') { // race: created concurrently
        const again = await readPlanBundle(ctx, orgId, cycleId, employeeId);
        return { ...again, seeded: 0 };
      }
      console.error('ensure plan insert', planErr);
      throw new ApiError('DB_ERROR', 'Database error', 500);
    }

    const seeded = await seedItems(ctx, orgId, cycleId, plan.id, employeeId);
    await ctx.audit({
      organizationId: orgId, cycleId, action: 'goal.ensure-plan',
      entityType: 'employee_goal_plan', entityId: plan.id, note: `seeded ${seeded} item(s)`,
    });
    const bundle = await readPlanBundle(ctx, orgId, cycleId, employeeId);
    return { ...bundle, seeded };
  },
};

// Seed goal items from the participant's assigned library (KRA/KPI tree) + prefill dataset.
// Archived libraries/datasets contribute nothing (2b-deferred rule).
async function seedItems(
  ctx: HandlerCtx, orgId: string, cycleId: string, planId: string, employeeId: string,
): Promise<number> {
  const { data: assign } = await ctx.admin.from('cycle_participant_assignments')
    .select('goal_library_id, prefill_dataset_id').eq('cycle_id', cycleId).eq('employee_id', employeeId).maybeSingle();
  if (!assign) return 0;

  let seeded = 0;

  // 1) Library KRA/KPI tree (only if the library is active).
  if (assign.goal_library_id) {
    const { data: lib } = await ctx.admin.from('goal_libraries')
      .select('id, status').eq('id', assign.goal_library_id).maybeSingle();
    if (lib && lib.status === 'active') {
      const { data: libItems } = await ctx.admin.from('goal_library_items')
        .select().eq('goal_library_id', assign.goal_library_id).order('display_order');
      const kraMap = new Map<string, string>(); // library kra id -> new goal item id
      for (const it of (libItems ?? []).filter((x) => x.item_type === 'kra')) {
        const { data: row, error } = await ctx.admin.from('employee_goal_items').insert({
          organization_id: orgId, cycle_id: cycleId, plan_id: planId, employee_id: employeeId,
          item_type: 'kra', title: it.title, description: it.description, perspective: it.perspective,
          weight: it.weight, target_type_key: it.target_type_key, target_value: it.target_value,
          source: 'library', display_order: it.display_order,
        }).select('id').single();
        if (error) { console.error('seed kra', error); throw new ApiError('DB_ERROR', 'Database error', 500); }
        kraMap.set(it.id, row.id); seeded += 1;
      }
      for (const it of (libItems ?? []).filter((x) => x.item_type === 'kpi')) {
        const parentId = it.parent_item_id ? kraMap.get(it.parent_item_id) ?? null : null;
        const { error } = await ctx.admin.from('employee_goal_items').insert({
          organization_id: orgId, cycle_id: cycleId, plan_id: planId, employee_id: employeeId,
          item_type: 'kpi', parent_item_id: parentId, title: it.title, description: it.description,
          perspective: it.perspective, weight: it.weight, target_type_key: it.target_type_key,
          target_value: it.target_value, source: 'library', display_order: it.display_order,
        });
        if (error) { console.error('seed kpi', error); throw new ApiError('DB_ERROR', 'Database error', 500); }
        seeded += 1;
      }
    }
  }

  // 2) Prefill rows for this employee's code (only if the dataset is active).
  if (assign.prefill_dataset_id) {
    const { data: ds } = await ctx.admin.from('prefill_datasets')
      .select('id, status').eq('id', assign.prefill_dataset_id).maybeSingle();
    const { data: emp } = await ctx.admin.from('employees').select('employee_code').eq('id', employeeId).single();
    if (ds && ds.status === 'active' && emp) {
      const { data: pf } = await ctx.admin.from('prefill_dataset_items')
        .select().eq('prefill_dataset_id', assign.prefill_dataset_id).eq('employee_code', emp.employee_code).order('display_order');
      for (const it of pf ?? []) {
        // Prefill rows are flat KRA(+optional KPI title) — seed the KRA; if kpi_title present, seed a child KPI.
        const { data: kraRow, error } = await ctx.admin.from('employee_goal_items').insert({
          organization_id: orgId, cycle_id: cycleId, plan_id: planId, employee_id: employeeId,
          item_type: 'kra', title: it.kra_title, perspective: it.perspective, weight: it.weight,
          target_type_key: it.target_type_key, target_value: it.target_value,
          source: 'prefill', display_order: 100 + it.display_order,
        }).select('id').single();
        if (error) { console.error('seed prefill kra', error); throw new ApiError('DB_ERROR', 'Database error', 500); }
        seeded += 1;
        if (it.kpi_title) {
          const { error: kErr } = await ctx.admin.from('employee_goal_items').insert({
            organization_id: orgId, cycle_id: cycleId, plan_id: planId, employee_id: employeeId,
            item_type: 'kpi', parent_item_id: kraRow.id, title: it.kpi_title, perspective: it.perspective,
            target_type_key: it.target_type_key, target_value: it.target_value,
            source: 'prefill', display_order: 100 + it.display_order,
          });
          if (kErr) { console.error('seed prefill kpi', kErr); throw new ApiError('DB_ERROR', 'Database error', 500); }
          seeded += 1;
        }
      }
    }
  }

  return seeded;
}
