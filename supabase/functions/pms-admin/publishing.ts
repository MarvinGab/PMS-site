import { ApiError, Handler, HandlerCtx } from '../_shared/kernel.ts';
import { optBool, optString, reqString, reqUuid } from '../_shared/validate.ts';
import { BellBand, computeBellCurve } from '../_shared/bellcurve.ts';

async function finalScores(ctx: HandlerCtx, orgId: string, cycleId: string): Promise<{ scores: number[]; missing: number }> {
  const { data: parts, error } = await ctx.admin.from('cycle_participants')
    .select('employee_id').eq('cycle_id', cycleId).eq('organization_id', orgId).eq('status', 'active');
  if (error) { console.error('finalScores parts', error); throw new ApiError('DB_ERROR', 'Database error', 500); }
  const ids = (parts ?? []).map((p) => p.employee_id);
  if (ids.length === 0) return { scores: [], missing: 0 };
  const { data: evals, error: eErr } = await ctx.admin.from('evaluations')
    .select('employee_id, overall_score, status').eq('cycle_id', cycleId).eq('organization_id', orgId).eq('stage', 'hr_final').in('employee_id', ids);
  if (eErr) { console.error('finalScores evals', eErr); throw new ApiError('DB_ERROR', 'Database error', 500); }
  const submitted = (evals ?? []).filter((e) => e.status === 'submitted');
  const scores = submitted.filter((e) => e.overall_score != null).map((e) => Number(e.overall_score));
  const missing = ids.length - submitted.length;
  return { scores, missing };
}

async function bellContext(ctx: HandlerCtx, orgId: string, cycleId: string) {
  const { data: pts, error: pErr } = await ctx.admin.from('cycle_rating_scale_levels').select('point').eq('cycle_id', cycleId).eq('organization_id', orgId);
  if (pErr) { console.error('bellContext points', pErr); throw new ApiError('DB_ERROR', 'Database error', 500); }
  const { data: bands, error: bErr } = await ctx.admin.from('cycle_bell_curve_bands').select('rating_point, target_percent, tolerance_percent').eq('cycle_id', cycleId).eq('organization_id', orgId);
  if (bErr) { console.error('bellContext bands', bErr); throw new ApiError('DB_ERROR', 'Database error', 500); }
  return { points: (pts ?? []).map((p) => Number(p.point)), bands: (bands ?? []) as BellBand[] };
}

async function livePublication(ctx: HandlerCtx, orgId: string, cycleId: string) {
  const { data, error } = await ctx.admin.from('cycle_publications')
    .select().eq('cycle_id', cycleId).eq('organization_id', orgId).is('revoked_at', null).order('published_at', { ascending: false }).limit(1);
  if (error) { console.error('livePublication', error); throw new ApiError('DB_ERROR', 'Database error', 500); }
  return (data ?? [])[0] ?? null;
}

export const publishingHandlers: Record<string, Handler> = {
  'publish.bell-check': async (payload, ctx) => {
    const orgId = reqUuid(payload.orgId, 'orgId');
    ctx.requireOrgRole(orgId, ['hr_admin']);
    const cycleId = reqUuid(payload.cycleId, 'cycleId');
    const { scores } = await finalScores(ctx, orgId, cycleId);
    const { points, bands } = await bellContext(ctx, orgId, cycleId);
    return computeBellCurve(scores, points, bands);
  },

  'publish.publish': async (payload, ctx) => {
    const orgId = reqUuid(payload.orgId, 'orgId');
    ctx.requireOrgRole(orgId, ['hr_admin']);
    const cycleId = reqUuid(payload.cycleId, 'cycleId');
    const force = optBool(payload.force, 'force');
    // A forced override must carry a real (non-blank) justification — it lands in the audit trail.
    const reason = force ? reqString(payload.reason, 'reason', 2000) : optString(payload.reason, 'reason', 2000);

    const { data: cycle, error: cErr } = await ctx.admin.from('appraisal_cycles').select('id, status, version').eq('id', cycleId).eq('organization_id', orgId).maybeSingle();
    if (cErr) { console.error('publish cycle', cErr); throw new ApiError('DB_ERROR', 'Database error', 500); }
    if (!cycle) throw new ApiError('NOT_FOUND', 'Cycle not found', 404);
    // Check for a live publication BEFORE the status guard: a just-published cycle has
    // status 'published' (not 'review'), so the status check would otherwise mask the
    // more specific ALREADY_PUBLISHED and make it unreachable.
    if (await livePublication(ctx, orgId, cycleId)) throw new ApiError('ALREADY_PUBLISHED', 'This cycle is already published', 409);
    if (cycle.status !== 'review') throw new ApiError('CYCLE_WRONG_STATUS', 'Only a cycle in review can be published', 409);

    const { scores, missing } = await finalScores(ctx, orgId, cycleId);
    if (missing > 0) throw new ApiError('FINALS_INCOMPLETE', `${missing} participant(s) have no submitted final evaluation`, 409);
    const { points, bands } = await bellContext(ctx, orgId, cycleId);
    const bell = computeBellCurve(scores, points, bands);
    if (!bell.withinTolerance && !(force && reason)) {
      throw new ApiError('BELL_CURVE_VIOLATION', 'The rating distribution is outside the bell-curve tolerance; publish with force + reason to override', 409);
    }

    const { data: publication, error: pErr } = await ctx.admin.from('cycle_publications')
      .insert({ organization_id: orgId, cycle_id: cycleId, published_by: ctx.userId, reason: force ? reason : null }).select().single();
    if (pErr) { console.error('publish insert', pErr); throw new ApiError('DB_ERROR', 'Database error', 500); }
    let freshCycle;
    try {
      freshCycle = await ctx.versionedUpdate('appraisal_cycles', orgId, cycleId, cycle.version, { status: 'published' });
    } catch (e) {
      // Status flip failed — delete the row we just inserted so it can't disclose finals for a
      // still-'review' cycle (3b visibility keys off a non-revoked cycle_publications row). Nothing depends on it yet.
      await ctx.admin.from('cycle_publications').delete().eq('id', publication.id).eq('organization_id', orgId);
      throw e;
    }
    // Queue the publish-notification fan-out (emails + in-app notifications) for the worker.
    const { error: jobErr } = await ctx.admin.from('background_jobs')
      .insert({ organization_id: orgId, cycle_id: cycleId, job_type: 'publish_notification', payload: { cycleId }, created_by: ctx.userId, status: 'queued' });
    if (jobErr) console.error('enqueue publish_notification', jobErr); // non-fatal: results are published regardless

    await ctx.audit({ organizationId: orgId, cycleId, action: 'publish.publish', entityType: 'cycle_publication', entityId: publication.id, note: force ? `forced: ${reason}` : 'within tolerance' });
    return { publication, cycle: freshCycle };
  },

  'publish.revoke': async (payload, ctx) => {
    const orgId = reqUuid(payload.orgId, 'orgId');
    ctx.requireOrgRole(orgId, ['hr_admin']);
    const cycleId = reqUuid(payload.cycleId, 'cycleId');
    const reason = reqString(payload.reason, 'reason', 2000);
    const pub = await livePublication(ctx, orgId, cycleId);
    if (!pub) throw new ApiError('NOT_PUBLISHED', 'This cycle has no active publication', 409);
    const updated = await ctx.versionedUpdate('cycle_publications', orgId, pub.id, pub.version, {
      revoked_at: new Date().toISOString(), revoked_by: ctx.userId, reason,
    });
    let freshCycle;
    try {
      const { data: cycle, error: cErr } = await ctx.admin.from('appraisal_cycles').select('version').eq('id', cycleId).eq('organization_id', orgId).single();
      if (cErr || !cycle) { console.error('revoke cycle', cErr); throw new ApiError('DB_ERROR', 'Database error', 500); }
      freshCycle = await ctx.versionedUpdate('appraisal_cycles', orgId, cycleId, cycle.version, { status: 'review' });
    } catch (e) {
      // Cycle flip failed — restore the publication we just revoked so the cycle isn't wedged
      // ('published' with no live publication → neither publishable nor revocable via the API).
      // Mirror publish.publish's rollback (best-effort; nothing keys off these until the flip lands).
      await ctx.admin.from('cycle_publications').update({ revoked_at: null, revoked_by: null }).eq('id', pub.id).eq('organization_id', orgId);
      throw e;
    }
    await ctx.audit({ organizationId: orgId, cycleId, action: 'publish.revoke', entityType: 'cycle_publication', entityId: pub.id, note: reason });
    return { cycle: freshCycle, publication: updated };
  },
};
