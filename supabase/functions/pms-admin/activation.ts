import { ApiError, Handler } from '../_shared/kernel.ts';
import { reqInt, reqUuid } from '../_shared/validate.ts';

const SQLSTATE_TO_APP: Record<string, { code: string; status: number; message: string }> = {
  no_data_found: { code: 'NOT_FOUND', status: 404, message: 'Cycle not found' },
  P0002: { code: 'NOT_FOUND', status: 404, message: 'Cycle not found' },
  object_not_in_prerequisite_state: { code: 'CYCLE_LOCKED', status: 409, message: 'Only a draft or setup cycle can be activated' },
  '55000': { code: 'CYCLE_LOCKED', status: 409, message: 'Only a draft or setup cycle can be activated' },
  serialization_failure: { code: 'CONFLICT', status: 409, message: 'someone else changed this — reload' },
  '40001': { code: 'CONFLICT', status: 409, message: 'someone else changed this — reload' },
  PT409: { code: 'CONFLICT', status: 409, message: 'someone else changed this — reload' },
  check_violation: { code: 'ACTIVATION_PREREQ', status: 422, message: 'Cycle is missing prerequisites (participants, phase windows, or rating scale)' },
  '23514': { code: 'ACTIVATION_PREREQ', status: 422, message: 'Cycle is missing prerequisites (participants, phase windows, or rating scale)' },
};

export const activationHandlers: Record<string, Handler> = {
  'cycle.activate': async (payload, ctx) => {
    const orgId = reqUuid(payload.orgId, 'orgId');
    ctx.requireOrgRole(orgId, ['hr_admin']);
    const cycleId = reqUuid(payload.cycleId, 'cycleId');
    const expectedVersion = reqInt(payload.expectedVersion, 'expectedVersion');
    const { data, error } = await ctx.admin.rpc('activate_cycle_tx', {
      p_org: orgId, p_cycle: cycleId, p_expected_version: expectedVersion, p_actor: ctx.userId,
    });
    if (error) {
      const mapped = SQLSTATE_TO_APP[error.code ?? ''];
      if (mapped) throw new ApiError(mapped.code, mapped.message, mapped.status);
      console.error('activate_cycle_tx', error);
      throw new ApiError('DB_ERROR', 'Database error', 500);
    }
    return { cycle: data };
  },
};
