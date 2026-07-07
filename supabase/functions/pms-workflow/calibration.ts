import { ApiError, Handler, HandlerCtx } from '../_shared/kernel.ts';
import { optString, reqInt, reqNumber, reqUuid, reqEnum } from '../_shared/validate.ts';
import { isHodOf, isHrOrSuper } from '../_shared/scope.ts';

const CALIBRATABLE = ['hod', 'hr_final'];

async function loadReviewCycle(ctx: HandlerCtx, orgId: string, cycleId: string) {
  const { data: cycle, error } = await ctx.admin.from('appraisal_cycles')
    .select('id, status').eq('id', cycleId).eq('organization_id', orgId).maybeSingle();
  if (error) { console.error('loadReviewCycle', error); throw new ApiError('DB_ERROR', 'Database error', 500); }
  if (!cycle) throw new ApiError('NOT_FOUND', 'Cycle not found', 404);
  if (cycle.status !== 'review') throw new ApiError('CYCLE_WRONG_STATUS', 'Calibration is only open while the cycle is in review', 409);
  return cycle;
}

// Guard a calibrated score against the cycle's rating scale (closes a 3b deferral: an
// unbounded afterScore would store garbage and skew the bell curve). No scale defined → no bound.
async function assertScoreInScale(ctx: HandlerCtx, orgId: string, cycleId: string, afterScore: number) {
  const { data: pts, error } = await ctx.admin.from('cycle_rating_scale_levels')
    .select('point').eq('cycle_id', cycleId).eq('organization_id', orgId);
  if (error) { console.error('assertScoreInScale', error); throw new ApiError('DB_ERROR', 'Database error', 500); }
  const points = (pts ?? []).map((p) => Number(p.point));
  if (points.length === 0) return;
  const lo = Math.min(...points);
  const hi = Math.max(...points);
  if (afterScore < lo || afterScore > hi) {
    throw new ApiError('BAD_REQUEST', `afterScore must be within the rating scale (${lo}–${hi})`, 400);
  }
}

export const calibrationHandlers: Record<string, Handler> = {
  'calibration.adjust': async (payload, ctx) => {
    const orgId = reqUuid(payload.orgId, 'orgId');
    const cycleId = reqUuid(payload.cycleId, 'cycleId');
    const employeeId = reqUuid(payload.employeeId, 'employeeId');
    const stage = reqEnum(payload.stage, 'stage', CALIBRATABLE);
    const evalVersion = reqInt(payload.evalVersion, 'evalVersion');
    const afterScore = reqNumber(payload.afterScore, 'afterScore');
    const note = optString(payload.note, 'note', 2000);

    // Auth BEFORE cycle load. HR/super may calibrate any stage; a HOD only the hod stage of a mapped employee.
    if (!isHrOrSuper(ctx, orgId)) {
      if (!(stage === 'hod' && await isHodOf(ctx, orgId, employeeId))) {
        throw new ApiError('FORBIDDEN', 'You cannot calibrate this evaluation', 403);
      }
    }
    await loadReviewCycle(ctx, orgId, cycleId);
    await assertScoreInScale(ctx, orgId, cycleId, afterScore);

    const { data: evaluation, error: eErr } = await ctx.admin.from('evaluations')
      .select().eq('cycle_id', cycleId).eq('employee_id', employeeId).eq('stage', stage).eq('organization_id', orgId).maybeSingle();
    if (eErr) { console.error('calibration eval', eErr); throw new ApiError('DB_ERROR', 'Database error', 500); }
    if (!evaluation) throw new ApiError('NOT_FOUND', 'Evaluation not found', 404);
    if (evaluation.status !== 'submitted') throw new ApiError('EVAL_NOT_SUBMITTED', 'Only a submitted evaluation can be calibrated', 409);

    // Append-only before/after record.
    const { data: calibration, error: cErr } = await ctx.admin.from('calibrations').insert({
      organization_id: orgId, cycle_id: cycleId, employee_id: employeeId, stage,
      before_score: evaluation.overall_score, after_score: afterScore, note, actor_user_id: ctx.userId,
    }).select().single();
    if (cErr) { console.error('calibration insert', cErr); throw new ApiError('DB_ERROR', 'Database error', 500); }

    const fresh = await ctx.versionedUpdate('evaluations', orgId, evaluation.id, evalVersion, { overall_score: afterScore });
    await ctx.audit({
      organizationId: orgId, cycleId, action: 'calibration.adjust', entityType: 'evaluation', entityId: evaluation.id,
      before: { overall_score: evaluation.overall_score }, after: { overall_score: afterScore }, note: `${stage} calibrated`,
    });
    return { evaluation: fresh, calibration };
  },
};
