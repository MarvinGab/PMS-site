import { ApiError, Handler, HandlerCtx } from '../_shared/kernel.ts';
import { optUuid, reqEnum, reqUuid } from '../_shared/validate.ts';
import { callerEmployeeId, callerEmployeeIdOrNull, isHodOf, isHrOrSuper, manages } from '../_shared/scope.ts';

export const STAGES = ['self', 'manager', 'hod', 'hr_final'];
export const STAGE_WINDOW: Record<string, string> = {
  self: 'self_evaluation', manager: 'manager_evaluation', hod: 'hod_review', hr_final: 'hr_calibration',
};

export async function loadEvaluableCycle(ctx: HandlerCtx, orgId: string, cycleId: string) {
  const { data: cycle, error } = await ctx.admin.from('appraisal_cycles')
    .select().eq('id', cycleId).eq('organization_id', orgId).maybeSingle();
  if (error) { console.error('loadEvaluableCycle', error); throw new ApiError('DB_ERROR', 'Database error', 500); }
  if (!cycle) throw new ApiError('NOT_FOUND', 'Cycle not found', 404);
  if (!['active', 'review'].includes(cycle.status)) {
    throw new ApiError('CYCLE_NOT_EVALUABLE', `The cycle is ${cycle.status}; evaluations are not open`, 409);
  }
  return cycle;
}

export async function assertStageAuth(ctx: HandlerCtx, orgId: string, employeeId: string, stage: string): Promise<void> {
  if (isHrOrSuper(ctx, orgId)) return;
  if (stage === 'self') {
    if (callerEmployeeId(ctx, orgId) === employeeId) return;
  } else if (stage === 'manager') {
    if (await manages(ctx, orgId, employeeId)) return;
  } else if (stage === 'hod') {
    if (await isHodOf(ctx, orgId, employeeId)) return;
  } else if (stage === 'hr_final') {
    // HR-only; already returned above for HR/super.
  }
  throw new ApiError('FORBIDDEN', `You cannot act on the ${stage} evaluation for this employee`, 403);
}

async function stageStatus(ctx: HandlerCtx, cycleId: string, employeeId: string, stage: string): Promise<string | null> {
  const { data } = await ctx.admin.from('evaluations')
    .select('status').eq('cycle_id', cycleId).eq('employee_id', employeeId).eq('stage', stage).maybeSingle();
  return data?.status ?? null;
}

export async function assertPrereqs(ctx: HandlerCtx, orgId: string, cycleId: string, employeeId: string, stage: string): Promise<void> {
  const { data: plan, error } = await ctx.admin.from('employee_goal_plans')
    .select('status').eq('cycle_id', cycleId).eq('employee_id', employeeId).eq('organization_id', orgId).maybeSingle();
  if (error) { console.error('assertPrereqs plan', error); throw new ApiError('DB_ERROR', 'Database error', 500); }
  if (!plan || plan.status !== 'approved') throw new ApiError('GOALS_NOT_APPROVED', 'The employee\'s goals must be approved first', 409);
  if (stage === 'manager' && (await stageStatus(ctx, cycleId, employeeId, 'self')) !== 'submitted') {
    throw new ApiError('SELF_NOT_SUBMITTED', 'The self evaluation must be submitted first', 409);
  }
  if ((stage === 'hod' || stage === 'hr_final') && (await stageStatus(ctx, cycleId, employeeId, 'manager')) !== 'submitted') {
    throw new ApiError('MANAGER_NOT_SUBMITTED', 'The manager evaluation must be submitted first', 409);
  }
}

async function readEvalBundle(ctx: HandlerCtx, orgId: string, cycleId: string, employeeId: string, stage: string) {
  const { data: evaluation, error } = await ctx.admin.from('evaluations')
    .select().eq('cycle_id', cycleId).eq('employee_id', employeeId).eq('stage', stage).eq('organization_id', orgId).maybeSingle();
  if (error) { console.error('readEval', error); throw new ApiError('DB_ERROR', 'Database error', 500); }
  if (!evaluation) return { evaluation: null, goalScores: [], competencyScores: [] };
  const { data: gs } = await ctx.admin.from('evaluation_goal_scores').select().eq('evaluation_id', evaluation.id);
  const { data: cs } = await ctx.admin.from('evaluation_competency_scores').select().eq('evaluation_id', evaluation.id);
  return { evaluation, goalScores: gs ?? [], competencyScores: cs ?? [] };
}

// Score-visibility for reading someone else's manager/hr_final stage (mirrors RLS stage_visible).
async function visibleToReader(ctx: HandlerCtx, orgId: string, cycleId: string, employeeId: string, stage: string): Promise<boolean> {
  if (isHrOrSuper(ctx, orgId)) return true;
  const me = callerEmployeeIdOrNull(ctx, orgId);
  const isOwn = me === employeeId;
  const isMgr = await manages(ctx, orgId, employeeId);
  const isHod = await isHodOf(ctx, orgId, employeeId);
  if (stage === 'self') return isOwn || isMgr || isHod;
  if (stage === 'hod') return isHod;
  if (stage === 'manager' || stage === 'hr_final') {
    if (isMgr || isHod) return true;
    if (!isOwn) return false;
    // own view of manager/final: gated by the snapshot visibility + publication
    const key = stage === 'manager' ? 'manager_rating_visible' : 'final_rating_visible';
    const { data: snap } = await ctx.admin.from('cycle_config_snapshots').select('snapshot').eq('cycle_id', cycleId).eq('organization_id', orgId).maybeSingle();
    const v = (snap?.snapshot?.visibility ?? {})[key] ?? 'after_publish';
    if (v === 'never') return false;
    if (v === 'immediate') return true;
    const { data: pub } = await ctx.admin.from('cycle_publications').select('id').eq('cycle_id', cycleId).eq('organization_id', orgId).is('revoked_at', null).limit(1);
    return (pub ?? []).length > 0;
  }
  return false;
}

export const evalHandlers: Record<string, Handler> = {
  'eval.get': async (payload, ctx) => {
    const orgId = reqUuid(payload.orgId, 'orgId');
    const cycleId = reqUuid(payload.cycleId, 'cycleId');
    const employeeId = reqUuid(payload.employeeId, 'employeeId');
    const stage = reqEnum(payload.stage, 'stage', STAGES);
    if (!(await visibleToReader(ctx, orgId, cycleId, employeeId, stage))) {
      throw new ApiError('FORBIDDEN', 'You cannot view this evaluation', 403);
    }
    return await readEvalBundle(ctx, orgId, cycleId, employeeId, stage);
  },

  'eval.ensure': async (payload, ctx) => {
    const orgId = reqUuid(payload.orgId, 'orgId');
    const cycleId = reqUuid(payload.cycleId, 'cycleId');
    const stage = reqEnum(payload.stage, 'stage', STAGES);
    const employeeId = optUuid(payload.employeeId, 'employeeId') ?? callerEmployeeId(ctx, orgId);
    await assertStageAuth(ctx, orgId, employeeId, stage);
    await loadEvaluableCycle(ctx, orgId, cycleId);
    await assertPrereqs(ctx, orgId, cycleId, employeeId, stage);

    const existing = await readEvalBundle(ctx, orgId, cycleId, employeeId, stage);
    if (existing.evaluation) return { ...existing, seeded: 0 };

    const { data: evaluation, error } = await ctx.admin.from('evaluations')
      .insert({ organization_id: orgId, cycle_id: cycleId, employee_id: employeeId, stage, status: 'draft' })
      .select().single();
    if (error) {
      if (error.code === '23505') { const again = await readEvalBundle(ctx, orgId, cycleId, employeeId, stage); return { ...again, seeded: 0 }; }
      console.error('eval.ensure insert', error); throw new ApiError('DB_ERROR', 'Database error', 500);
    }
    let seeded = 0;
    try {
      seeded = await seedScores(ctx, orgId, cycleId, employeeId, evaluation.id);
    } catch (err) {
      await ctx.admin.from('evaluations').delete().eq('id', evaluation.id).eq('organization_id', orgId);
      throw err;
    }
    await ctx.audit({ organizationId: orgId, cycleId, action: 'eval.ensure', entityType: 'evaluation', entityId: evaluation.id, note: `${stage}: seeded ${seeded}` });
    const bundle = await readEvalBundle(ctx, orgId, cycleId, employeeId, stage);
    return { ...bundle, seeded };
  },
};

// Seed a goal-score row per scored item (per rating_level) + a competency-score row per plan competency.
async function seedScores(ctx: HandlerCtx, orgId: string, cycleId: string, employeeId: string, evaluationId: string): Promise<number> {
  const { data: plan, error: pErr } = await ctx.admin.from('employee_goal_plans')
    .select('id').eq('cycle_id', cycleId).eq('employee_id', employeeId).eq('organization_id', orgId).maybeSingle();
  if (pErr) { console.error('seedScores plan', pErr); throw new ApiError('DB_ERROR', 'Database error', 500); }
  if (!plan) return 0;
  const ratingLevel = await ratingLevelFor(ctx, cycleId, employeeId);
  const { data: items, error: iErr } = await ctx.admin.from('employee_goal_items')
    .select('id, item_type').eq('plan_id', plan.id);
  if (iErr) { console.error('seedScores items', iErr); throw new ApiError('DB_ERROR', 'Database error', 500); }
  const scored = (items ?? []).filter((i) => i.item_type === ratingLevel);
  let seeded = 0;
  if (scored.length) {
    const { error } = await ctx.admin.from('evaluation_goal_scores').insert(
      scored.map((it) => ({ organization_id: orgId, cycle_id: cycleId, evaluation_id: evaluationId, goal_item_id: it.id })),
    );
    if (error) { console.error('seedScores goal', error); throw new ApiError('DB_ERROR', 'Database error', 500); }
    seeded += scored.length;
  }
  const { data: cfg } = await ctx.admin.from('cycle_competency_config').select('enabled').eq('cycle_id', cycleId).maybeSingle();
  if (cfg?.enabled) {
    const { data: comps } = await ctx.admin.from('employee_goal_plan_competencies').select('competency_name').eq('plan_id', plan.id);
    if ((comps ?? []).length) {
      const { error } = await ctx.admin.from('evaluation_competency_scores').insert(
        (comps ?? []).map((c) => ({ organization_id: orgId, cycle_id: cycleId, evaluation_id: evaluationId, competency_name: c.competency_name })),
      );
      if (error) { console.error('seedScores comp', error); throw new ApiError('DB_ERROR', 'Database error', 500); }
      seeded += (comps ?? []).length;
    }
  }
  return seeded;
}

export async function ratingLevelFor(ctx: HandlerCtx, cycleId: string, employeeId: string): Promise<'kra' | 'kpi'> {
  const { data: assign } = await ctx.admin.from('cycle_participant_assignments').select('group_id').eq('cycle_id', cycleId).eq('employee_id', employeeId).maybeSingle();
  if (!assign?.group_id) return 'kpi';
  const { data: group } = await ctx.admin.from('cycle_groups').select('rating_level').eq('id', assign.group_id).maybeSingle();
  return (group?.rating_level === 'kra' ? 'kra' : 'kpi');
}
