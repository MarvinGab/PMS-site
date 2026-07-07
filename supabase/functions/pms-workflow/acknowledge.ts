import { ApiError, Handler, HandlerCtx } from '../_shared/kernel.ts';
import { reqString, reqUuid } from '../_shared/validate.ts';
import { callerEmployeeId } from '../_shared/scope.ts';

async function ackGate(ctx: HandlerCtx, orgId: string, cycleId: string) {
  const { data: snap } = await ctx.admin.from('cycle_config_snapshots').select('snapshot').eq('cycle_id', cycleId).eq('organization_id', orgId).maybeSingle();
  const enabled = (snap?.snapshot?.features ?? {}).finalEmployeeAcceptanceEnabled === true;
  if (!enabled) throw new ApiError('ACK_NOT_ENABLED', 'Final acceptance is not enabled for this cycle', 409);
  const { data: pub } = await ctx.admin.from('cycle_publications').select('id').eq('cycle_id', cycleId).eq('organization_id', orgId).is('revoked_at', null).limit(1);
  if ((pub ?? []).length === 0) throw new ApiError('NOT_PUBLISHED', 'Results are not published', 409);
}

async function readAck(ctx: HandlerCtx, orgId: string, cycleId: string, employeeId: string) {
  const { data, error } = await ctx.admin.from('rating_acknowledgements')
    .select().eq('cycle_id', cycleId).eq('employee_id', employeeId).eq('organization_id', orgId).maybeSingle();
  if (error) { console.error('readAck', error); throw new ApiError('DB_ERROR', 'Database error', 500); }
  return data ?? null;
}

async function upsertAck(ctx: HandlerCtx, orgId: string, cycleId: string, employeeId: string, decision: string, reason: string | null) {
  const existing = await readAck(ctx, orgId, cycleId, employeeId);
  if (existing && existing.resolution_status && existing.resolution_status !== 'open') {
    throw new ApiError('ACK_RESOLVED', 'This acknowledgement has already been resolved and cannot be changed', 409);
  }
  const row = {
    organization_id: orgId, cycle_id: cycleId, employee_id: employeeId, decision, reason,
    resolution_status: decision === 'concern' ? 'open' : null, submitted_at: new Date().toISOString(),
  };
  const { data, error } = await ctx.admin.from('rating_acknowledgements')
    .upsert(row, { onConflict: 'cycle_id,employee_id' }).select().single();
  if (error) { console.error('upsertAck', error); throw new ApiError('DB_ERROR', 'Database error', 500); }
  return data;
}

export const ackHandlers: Record<string, Handler> = {
  'ack.get': async (payload, ctx) => {
    const orgId = reqUuid(payload.orgId, 'orgId');
    const cycleId = reqUuid(payload.cycleId, 'cycleId');
    const employeeId = callerEmployeeId(ctx, orgId);
    return { acknowledgement: await readAck(ctx, orgId, cycleId, employeeId) };
  },

  'ack.accept': async (payload, ctx) => {
    const orgId = reqUuid(payload.orgId, 'orgId');
    const cycleId = reqUuid(payload.cycleId, 'cycleId');
    const employeeId = callerEmployeeId(ctx, orgId);
    await ackGate(ctx, orgId, cycleId);
    const acknowledgement = await upsertAck(ctx, orgId, cycleId, employeeId, 'accepted', null);
    await ctx.audit({ organizationId: orgId, cycleId, action: 'ack.accept', entityType: 'rating_acknowledgement', entityId: acknowledgement.id, after: { decision: 'accepted' } });
    return { acknowledgement };
  },

  'ack.raise-concern': async (payload, ctx) => {
    const orgId = reqUuid(payload.orgId, 'orgId');
    const cycleId = reqUuid(payload.cycleId, 'cycleId');
    const reason = reqString(payload.reason, 'reason', 2000);
    const employeeId = callerEmployeeId(ctx, orgId);
    await ackGate(ctx, orgId, cycleId);
    const acknowledgement = await upsertAck(ctx, orgId, cycleId, employeeId, 'concern', reason);
    await ctx.audit({ organizationId: orgId, cycleId, action: 'ack.raise-concern', entityType: 'rating_acknowledgement', entityId: acknowledgement.id, after: { decision: 'concern' } });
    return { acknowledgement };
  },
};
