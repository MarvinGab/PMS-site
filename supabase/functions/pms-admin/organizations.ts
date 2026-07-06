import { ApiError, Handler, HandlerCtx } from '../_shared/kernel.ts';
import { reqInt, reqObject, reqString, reqUuid } from '../_shared/validate.ts';

export function requireSuperAdmin(ctx: HandlerCtx): void {
  const ok = ctx.memberships.some((m) => m.organizationId === null && m.roles.includes('super_admin'));
  if (!ok) throw new ApiError('FORBIDDEN', 'Super admin only', 403);
}

export const organizationHandlers: Record<string, Handler> = {
  'org.create': async (payload, ctx) => {
    requireSuperAdmin(ctx);
    const key = reqString(payload.key, 'key', 60).toLowerCase();
    const name = reqString(payload.name, 'name', 200);
    // Atomic org + branding + audit via RPC (kernel contract for multi-table writes).
    const { data: org, error } = await ctx.admin.rpc('create_organization_tx', {
      p_key: key, p_name: name, p_actor: ctx.userId,
    });
    if (error) {
      if (error.code === '23505') {
        throw new ApiError('ORG_KEY_TAKEN', 'An organization with this key already exists', 409);
      }
      console.error('org.create', error);
      throw new ApiError('DB_ERROR', 'Database error', 500);
    }
    return { organization: org };
  },

  'org.update': async (payload, ctx) => {
    const orgId = reqUuid(payload.orgId, 'orgId');
    ctx.requireOrgRole(orgId, ['hr_admin']);
    const expectedVersion = reqInt(payload.expectedVersion, 'expectedVersion');
    const name = reqString(payload.name, 'name', 200);
    const { data: before, error: readErr } = await ctx.admin.from('organizations')
      .select().eq('id', orgId).maybeSingle();
    if (readErr) { console.error('org.update read', readErr); throw new ApiError('DB_ERROR', 'Database error', 500); }
    if (!before) throw new ApiError('NOT_FOUND', 'Organization not found', 404);
    // organizations has no organization_id column, so versionedUpdate (org-scoped)
    // doesn't apply; same contract implemented directly.
    const { data: updated, error } = await ctx.admin.from('organizations')
      .update({ name }).eq('id', orgId).eq('version', expectedVersion).select().maybeSingle();
    if (error) { console.error('org.update', error); throw new ApiError('DB_ERROR', 'Database error', 500); }
    if (!updated) throw new ApiError('CONFLICT', 'someone else changed this — reload', 409);
    await ctx.audit({
      organizationId: orgId, action: 'org.update',
      entityType: 'organization', entityId: orgId, before, after: updated,
    });
    return { organization: updated };
  },

  'org.set-branding': async (payload, ctx) => {
    const orgId = reqUuid(payload.orgId, 'orgId');
    ctx.requireOrgRole(orgId, ['hr_admin']);
    const expectedVersion = reqInt(payload.expectedVersion, 'expectedVersion');
    const brandingPayload = reqObject(payload.payload, 'payload');
    const { data: beforeBranding } = await ctx.admin.from('organization_branding')
      .select().eq('organization_id', orgId).maybeSingle();
    // organization_branding's PK is organization_id (no id column) — direct
    // version-checked update, same conflict contract as versionedUpdate.
    const { data: updated, error } = await ctx.admin.from('organization_branding')
      .update({ payload: brandingPayload })
      .eq('organization_id', orgId).eq('version', expectedVersion)
      .select().maybeSingle();
    if (error) { console.error('org.set-branding', error); throw new ApiError('DB_ERROR', 'Database error', 500); }
    if (!updated) {
      const { data: row } = await ctx.admin.from('organization_branding')
        .select('organization_id').eq('organization_id', orgId).maybeSingle();
      if (!row) throw new ApiError('NOT_FOUND', 'Branding row not found', 404);
      throw new ApiError('CONFLICT', 'someone else changed this — reload', 409);
    }
    await ctx.audit({
      organizationId: orgId, action: 'org.set-branding',
      entityType: 'organization_branding', entityId: orgId,
      before: beforeBranding ?? null, after: updated,
    });
    return { branding: updated };
  },
};
