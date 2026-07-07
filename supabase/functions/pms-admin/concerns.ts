import { ApiError, Handler } from '../_shared/kernel.ts';
import { reqEnum, reqString, reqUuid } from '../_shared/validate.ts';

export const concernHandlers: Record<string, Handler> = {
  'concern.resolve': async (payload, ctx) => {
    const orgId = reqUuid(payload.orgId, 'orgId');
    ctx.requireOrgRole(orgId, ['hr_admin']);
    const cycleId = reqUuid(payload.cycleId, 'cycleId');
    const employeeId = reqUuid(payload.employeeId, 'employeeId');
    const resolution = reqEnum(payload.resolution, 'resolution', ['explained', 'recalibrated']);
    const note = reqString(payload.note, 'note', 2000);

    const { data: ack, error } = await ctx.admin.from('rating_acknowledgements')
      .select().eq('cycle_id', cycleId).eq('employee_id', employeeId).eq('organization_id', orgId).maybeSingle();
    if (error) { console.error('concern read', error); throw new ApiError('DB_ERROR', 'Database error', 500); }
    if (!ack) throw new ApiError('NOT_FOUND', 'No acknowledgement for this employee', 404);
    if (ack.decision !== 'concern' || ack.resolution_status !== 'open') {
      throw new ApiError('NOT_OPEN', 'Only an open concern can be resolved', 409);
    }
    const updated = await ctx.versionedUpdate('rating_acknowledgements', orgId, ack.id, ack.version, {
      resolution_status: resolution, resolution_note: note, resolved_by: ctx.userId, resolved_at: new Date().toISOString(),
    });
    await ctx.audit({ organizationId: orgId, cycleId, action: 'concern.resolve', entityType: 'rating_acknowledgement', entityId: ack.id, before: { resolution_status: 'open' }, after: { resolution_status: resolution }, note });
    return { acknowledgement: updated };
  },
};
