import { ApiError, Handler, HandlerCtx } from '../_shared/kernel.ts';
import { optUuid, reqEnum, reqUuid } from '../_shared/validate.ts';
import { callerEmployeeId, callerEmployeeIdOrNull, isHodOf, isHrOrSuper, manages } from '../_shared/scope.ts';
import { optNumber, optString, reqArray, reqInt, reqObject, reqString } from '../_shared/validate.ts';
import { requireWindowOrHr } from '../_shared/phase.ts';
import { achievementPercent, Band, computeGoalScore, computeOverall, ratingFromBands, ScoredItem } from '../_shared/scoring.ts';

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

async function scoringContext(ctx: HandlerCtx, orgId: string, cycleId: string, employeeId: string) {
  const { data: bands } = await ctx.admin.from('cycle_auto_rating_bands')
    .select('from_percent, to_percent, score').eq('cycle_id', cycleId).eq('organization_id', orgId);
  const { data: targetTypes } = await ctx.admin.from('cycle_target_types')
    .select('target_type_key, is_numeric, lower_is_better').eq('cycle_id', cycleId).eq('organization_id', orgId);
  const { data: cfg } = await ctx.admin.from('cycle_competency_config').select('enabled, competency_weight').eq('cycle_id', cycleId).maybeSingle();
  const ratingLevel = await ratingLevelFor(ctx, cycleId, employeeId);
  const lowerByKey = new Map<string, { isNumeric: boolean; lower: boolean }>(
    (targetTypes ?? []).map((t) => [t.target_type_key, { isNumeric: t.is_numeric, lower: t.lower_is_better }]),
  );
  return { bands: (bands ?? []) as Band[], lowerByKey, cfg: cfg ?? { enabled: false, competency_weight: null }, ratingLevel };
}

function num(v: string | null): number | null {
  if (v == null || v.trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
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

  'eval.save-scores': async (payload, ctx) => {
    const orgId = reqUuid(payload.orgId, 'orgId');
    const cycleId = reqUuid(payload.cycleId, 'cycleId');
    const employeeId = reqUuid(payload.employeeId, 'employeeId');
    const stage = reqEnum(payload.stage, 'stage', STAGES);
    const evalVersion = reqInt(payload.evalVersion, 'evalVersion');
    await assertStageAuth(ctx, orgId, employeeId, stage);
    await loadEvaluableCycle(ctx, orgId, cycleId);
    await assertPrereqs(ctx, orgId, cycleId, employeeId, stage);
    await requireWindowOrHr(ctx, orgId, cycleId, STAGE_WINDOW[stage]);

    const { data: evaluation, error: eErr } = await ctx.admin.from('evaluations')
      .select().eq('cycle_id', cycleId).eq('employee_id', employeeId).eq('stage', stage).eq('organization_id', orgId).maybeSingle();
    if (eErr) { console.error('save-scores eval', eErr); throw new ApiError('DB_ERROR', 'Database error', 500); }
    if (!evaluation) throw new ApiError('NOT_FOUND', 'No evaluation — call eval.ensure first', 404);
    if (evaluation.status !== 'draft') throw new ApiError('EVAL_LOCKED', `A ${evaluation.status} evaluation cannot be edited`, 409);

    const octx = await scoringContext(ctx, orgId, cycleId, employeeId);

    // Resolve the goal items for target lookups (only the plan's items).
    const { data: plan } = await ctx.admin.from('employee_goal_plans').select('id').eq('cycle_id', cycleId).eq('employee_id', employeeId).eq('organization_id', orgId).maybeSingle();
    if (!plan) { console.error('save-scores plan missing after assertPrereqs'); throw new ApiError('DB_ERROR', 'Database error', 500); }
    const { data: goalItems } = await ctx.admin.from('employee_goal_items')
      .select('id, item_type, parent_item_id, weight, target_type_key, target_value').eq('plan_id', plan.id);
    const itemById = new Map((goalItems ?? []).map((g) => [g.id, g]));

    // Apply each submitted goal score.
    const goalRows = reqArray(payload.goalScores ?? [], 'goalScores', 500);
    for (let i = 0; i < goalRows.length; i++) {
      const o = reqObject(goalRows[i], `goalScores[${i}]`);
      const goalItemId = reqUuid(o.goalItemId, `goalScores[${i}].goalItemId`);
      const item = itemById.get(goalItemId);
      if (!item) throw new ApiError('BAD_REQUEST', `goalScores[${i}] references an item not in this plan`, 400);
      const achievementValue = optString(o.achievementValue, `goalScores[${i}].achievementValue`, 200);
      const manualScore = optNumber(o.score, `goalScores[${i}].score`);
      const comment = optString(o.comment, `goalScores[${i}].comment`, 2000);
      const tt = item.target_type_key ? octx.lowerByKey.get(item.target_type_key) : undefined;
      const pct = (tt?.isNumeric ?? false)
        ? achievementPercent(num(achievementValue), num(item.target_value), tt?.lower ?? false)
        : null;
      const auto = ratingFromBands(pct, octx.bands);
      const score = manualScore ?? auto;
      const { error } = await ctx.admin.from('evaluation_goal_scores').upsert({
        organization_id: orgId, cycle_id: cycleId, evaluation_id: evaluation.id, goal_item_id: goalItemId,
        achievement_value: achievementValue, achievement_percent: pct, score, comment,
      }, { onConflict: 'evaluation_id,goal_item_id' });
      if (error) { console.error('save goal score', error); throw new ApiError('DB_ERROR', 'Database error', 500); }
    }

    // Apply competency scores (if any provided).
    const compRows = reqArray(payload.competencyScores ?? [], 'competencyScores', 200);
    for (let i = 0; i < compRows.length; i++) {
      const o = reqObject(compRows[i], `competencyScores[${i}]`);
      const competencyName = reqString(o.competencyName, `competencyScores[${i}].competencyName`, 200);
      const { error } = await ctx.admin.from('evaluation_competency_scores').upsert({
        organization_id: orgId, cycle_id: cycleId, evaluation_id: evaluation.id, competency_name: competencyName,
        score: optNumber(o.score, `competencyScores[${i}].score`), comment: optString(o.comment, `competencyScores[${i}].comment`, 2000),
      }, { onConflict: 'evaluation_id,competency_name' });
      if (error) { console.error('save comp score', error); throw new ApiError('DB_ERROR', 'Database error', 500); }
    }

    // Recompute overall from the persisted score rows.
    const overall = await recomputeOverall(ctx, orgId, evaluation.id, goalItems ?? [], octx);
    const patch: Record<string, unknown> = { overall_score: overall };
    if (payload.overallComment !== undefined) {
      patch.overall_comment = optString(payload.overallComment, 'overallComment', 4000);
    }
    await ctx.versionedUpdate('evaluations', orgId, evaluation.id, evalVersion, patch);
    await ctx.audit({ organizationId: orgId, cycleId, action: 'eval.save-scores', entityType: 'evaluation', entityId: evaluation.id, note: `${stage} overall=${overall}` });
    const bundle = await readEvalBundle(ctx, orgId, cycleId, employeeId, stage);
    return bundle;
  },

  'eval.submit': async (payload, ctx) => {
    const orgId = reqUuid(payload.orgId, 'orgId');
    const cycleId = reqUuid(payload.cycleId, 'cycleId');
    const employeeId = reqUuid(payload.employeeId, 'employeeId');
    const stage = reqEnum(payload.stage, 'stage', STAGES);
    const evalVersion = reqInt(payload.evalVersion, 'evalVersion');
    await assertStageAuth(ctx, orgId, employeeId, stage);
    await loadEvaluableCycle(ctx, orgId, cycleId);
    await assertPrereqs(ctx, orgId, cycleId, employeeId, stage);
    await requireWindowOrHr(ctx, orgId, cycleId, STAGE_WINDOW[stage]);

    const { data: evaluation, error: eErr } = await ctx.admin.from('evaluations')
      .select().eq('cycle_id', cycleId).eq('employee_id', employeeId).eq('stage', stage).eq('organization_id', orgId).maybeSingle();
    if (eErr) { console.error('submit eval', eErr); throw new ApiError('DB_ERROR', 'Database error', 500); }
    if (!evaluation) throw new ApiError('NOT_FOUND', 'No evaluation to submit', 404);
    if (evaluation.status !== 'draft') throw new ApiError('EVAL_LOCKED', `A ${evaluation.status} evaluation cannot be submitted again`, 409);

    const { data: scores } = await ctx.admin.from('evaluation_goal_scores').select('score').eq('evaluation_id', evaluation.id);
    if (!(scores ?? []).some((s) => s.score != null)) throw new ApiError('NOTHING_SCORED', 'Score at least one goal before submitting', 422);

    // Freeze the overall one more time.
    const octx = await scoringContext(ctx, orgId, cycleId, employeeId);
    const { data: plan } = await ctx.admin.from('employee_goal_plans').select('id').eq('cycle_id', cycleId).eq('employee_id', employeeId).eq('organization_id', orgId).maybeSingle();
    if (!plan) { console.error('eval.submit plan missing after assertPrereqs'); throw new ApiError('DB_ERROR', 'Database error', 500); }
    const { data: goalItems } = await ctx.admin.from('employee_goal_items').select('id, item_type, parent_item_id, weight').eq('plan_id', plan.id);
    const overall = await recomputeOverall(ctx, orgId, evaluation.id, goalItems ?? [], octx);

    const fresh = await ctx.versionedUpdate('evaluations', orgId, evaluation.id, evalVersion, {
      status: 'submitted', submitted_at: new Date().toISOString(), submitted_by: ctx.userId, overall_score: overall,
    });
    await ctx.audit({ organizationId: orgId, cycleId, action: 'eval.submit', entityType: 'evaluation', entityId: evaluation.id, before: { status: 'draft' }, after: { status: 'submitted', overall_score: overall } });
    return { evaluation: fresh };
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

async function recomputeOverall(
  ctx: HandlerCtx, orgId: string, evaluationId: string,
  goalItems: { id: string; item_type: string; parent_item_id: string | null; weight: number | null }[],
  octx: { cfg: { enabled: boolean; competency_weight: number | null }; ratingLevel: 'kra' | 'kpi' },
): Promise<number | null> {
  const { data: gs } = await ctx.admin.from('evaluation_goal_scores').select('goal_item_id, score').eq('evaluation_id', evaluationId);
  const scoreByItem = new Map((gs ?? []).map((r) => [r.goal_item_id, r.score]));
  const scored: ScoredItem[] = goalItems.map((it) => ({
    itemId: it.id, itemType: it.item_type as 'kra' | 'kpi', parentId: it.parent_item_id, weight: it.weight,
    score: scoreByItem.has(it.id) ? (scoreByItem.get(it.id) as number | null) : null,
  }));
  const goalScore = computeGoalScore(scored, octx.ratingLevel);
  let competencyScore: number | null = null;
  if (octx.cfg.enabled) {
    const { data: cs } = await ctx.admin.from('evaluation_competency_scores').select('score').eq('evaluation_id', evaluationId);
    const vals = (cs ?? []).map((r) => r.score).filter((s): s is number => s != null);
    competencyScore = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
  }
  return computeOverall(goalScore, competencyScore, octx.cfg.enabled, octx.cfg.competency_weight);
}

export async function ratingLevelFor(ctx: HandlerCtx, cycleId: string, employeeId: string): Promise<'kra' | 'kpi'> {
  const { data: assign } = await ctx.admin.from('cycle_participant_assignments').select('group_id').eq('cycle_id', cycleId).eq('employee_id', employeeId).maybeSingle();
  if (!assign?.group_id) return 'kpi';
  const { data: group } = await ctx.admin.from('cycle_groups').select('rating_level').eq('id', assign.group_id).maybeSingle();
  return (group?.rating_level === 'kra' ? 'kra' : 'kpi');
}
