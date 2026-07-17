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

  // Super-admin directory read: one summary row per organization (all orgs, active or
  // archived — the super-admin picks which to manage). Batched queries only: all orgs,
  // then all their cycles in one `.in(organization_id, ...)` call, then active participants
  // for the resolved "current cycle" ids in one more call — grouped in JS. No N+1 per org.
  'org.list': async (_payload, ctx) => {
    requireSuperAdmin(ctx);

    const { data: orgs, error: orgErr } = await ctx.admin.from('organizations')
      .select('id, key, name, created_at').order('name', { ascending: true });
    if (orgErr) { console.error('org.list orgs', orgErr); throw new ApiError('DB_ERROR', 'Database error', 500); }
    if (!orgs || orgs.length === 0) return { organizations: [] };

    const orgIds = orgs.map((o) => o.id as string);
    const { data: cycles, error: cycErr } = await ctx.admin.from('appraisal_cycles')
      .select('id, organization_id, status, created_at').in('organization_id', orgIds);
    if (cycErr) { console.error('org.list cycles', cycErr); throw new ApiError('DB_ERROR', 'Database error', 500); }

    const cyclesByOrg = new Map<string, { id: string; status: string; created_at: string }[]>();
    for (const c of cycles ?? []) {
      const orgId = c.organization_id as string;
      const list = cyclesByOrg.get(orgId) ?? [];
      list.push(c as { id: string; status: string; created_at: string });
      cyclesByOrg.set(orgId, list);
    }

    const LAUNCHED_STATUSES = ['active', 'review', 'published'];
    // "Current" cycle for the directory row: the most relevant live/working cycle.
    // Preference active > review > published > draft/setup (newest); archived cycles
    // never qualify (cycleCount also excludes them — mirrors the "one working cycle
    // per org" partial index).
    const CURRENT_PREF: Record<string, number> = { active: 0, review: 1, published: 2, draft: 3, setup: 4 };

    const summaries = orgs.map((org) => {
      const orgCycles = cyclesByOrg.get(org.id as string) ?? [];
      const nonArchived = orgCycles.filter((c) => c.status !== 'archived');
      const launched = orgCycles.some((c) => LAUNCHED_STATUSES.includes(c.status));
      const current = nonArchived.slice().sort((a, b) => {
        const byStatus = (CURRENT_PREF[a.status] ?? 9) - (CURRENT_PREF[b.status] ?? 9);
        if (byStatus !== 0) return byStatus;
        return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
      })[0] ?? null;
      return {
        id: org.id, key: org.key, name: org.name, createdAt: org.created_at,
        cycleCount: nonArchived.length,
        activeCycleStatus: current?.status ?? null,
        currentCycleId: current?.id ?? null,
        launched,
      };
    });

    const currentCycleIds = [...new Set(
      summaries.map((s) => s.currentCycleId).filter((id): id is string => !!id),
    )];
    const participantCountByCycle = new Map<string, number>();
    if (currentCycleIds.length > 0) {
      const { data: parts, error: partErr } = await ctx.admin.from('cycle_participants')
        .select('cycle_id').eq('status', 'active').in('cycle_id', currentCycleIds);
      if (partErr) { console.error('org.list participants', partErr); throw new ApiError('DB_ERROR', 'Database error', 500); }
      for (const p of parts ?? []) {
        const cycleId = p.cycle_id as string;
        participantCountByCycle.set(cycleId, (participantCountByCycle.get(cycleId) ?? 0) + 1);
      }
    }

    const organizations = summaries.map(({ currentCycleId, ...rest }) => ({
      ...rest,
      participantCount: currentCycleId ? (participantCountByCycle.get(currentCycleId) ?? 0) : 0,
    }));

    return { organizations };
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
