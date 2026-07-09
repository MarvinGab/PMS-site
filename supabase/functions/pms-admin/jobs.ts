import { ApiError, Handler } from '../_shared/kernel.ts';
import { reqString, reqUuid } from '../_shared/validate.ts';

export const jobsHandlers: Record<string, Handler> = {
  'jobs.enqueue-reminders': async (payload, ctx) => {
    const orgId = reqUuid(payload.orgId, 'orgId');
    ctx.requireOrgRole(orgId, ['hr_admin']);
    const cycleId = reqUuid(payload.cycleId, 'cycleId');
    const stage = reqString(payload.stage, 'stage', 100);
    const { data: cycle, error: cErr } = await ctx.admin.from('appraisal_cycles').select('id').eq('id', cycleId).eq('organization_id', orgId).maybeSingle();
    if (cErr) { console.error('enqueue-reminders cycle', cErr); throw new ApiError('DB_ERROR', 'Database error', 500); }
    if (!cycle) throw new ApiError('NOT_FOUND', 'Cycle not found', 404);
    const { data: job, error } = await ctx.admin.from('background_jobs')
      .insert({ organization_id: orgId, cycle_id: cycleId, job_type: 'reminder_batch', payload: { cycleId, stage }, created_by: ctx.userId, status: 'queued' })
      .select('id').single();
    if (error) { console.error('enqueue-reminders insert', error); throw new ApiError('DB_ERROR', 'Database error', 500); }
    await ctx.audit({ organizationId: orgId, cycleId, action: 'jobs.enqueue-reminders', entityType: 'background_job', entityId: job.id, note: `reminder_batch ${stage}` });
    return { jobId: job.id };
  },
};
