import { ApiError, Handler } from '../_shared/kernel.ts';
import { reqUuid } from '../_shared/validate.ts';

// Find an existing GoTrue user by email, else create one. Random password +
// email_confirm so GoTrue sends nothing; our own email_jobs carry the invite.
async function findOrCreateUser(admin: any, email: string): Promise<string> {
  // listUsers is paginated; for the TEST scale a single large page is fine.
  const { data: list, error: listErr } = await admin.auth.admin.listUsers({ perPage: 1000 });
  if (listErr) { console.error('listUsers', listErr); throw new ApiError('DB_ERROR', 'Auth lookup failed', 500); }
  const found = list.users.find((u: { email?: string }) => u.email?.toLowerCase() === email.toLowerCase());
  if (found) return found.id;
  const pw = `Inv!${crypto.randomUUID()}`;
  const { data, error } = await admin.auth.admin.createUser({ email, password: pw, email_confirm: true });
  if (error) { console.error('createUser', error); throw new ApiError('DB_ERROR', 'Could not create the invited user', 500); }
  return data.user.id;
}

async function recoveryLink(admin: any, email: string): Promise<string> {
  const { data, error } = await admin.auth.admin.generateLink({ type: 'recovery', email });
  if (error) { console.error('generateLink', error); return ''; }
  return data?.properties?.action_link ?? '';
}

export const inviteHandlers: Record<string, Handler> = {
  'cycle.invite-participants': async (payload, ctx) => {
    const orgId = reqUuid(payload.orgId, 'orgId');
    ctx.requireOrgRole(orgId, ['hr_admin']);
    const cycleId = reqUuid(payload.cycleId, 'cycleId');
    // Active participants whose employee is non-NONE and not yet linked to a user.
    const { data: parts, error } = await ctx.admin.from('cycle_participants')
      .select('employee_id, employees(id, email, group_name, user_id)')
      .eq('cycle_id', cycleId).eq('organization_id', orgId).eq('status', 'active');
    if (error) { console.error('invite participants read', error); throw new ApiError('DB_ERROR', 'Database error', 500); }
    let invited = 0, alreadyLinked = 0;
    const skipped: string[] = [];
    for (const p of parts ?? []) {
      const e = p.employees as unknown as { id: string; email: string | null; group_name: string | null; user_id: string | null };
      if (!e) continue;
      if (e.group_name === 'NONE') { skipped.push('roster-only'); continue; }
      if (e.user_id) { alreadyLinked += 1; continue; }
      if (!e.email) { skipped.push('no email'); continue; }
      const userId = await findOrCreateUser(ctx.admin, e.email);
      const link = await recoveryLink(ctx.admin, e.email);
      const { error: rpcErr } = await ctx.admin.rpc('link_invited_member_tx', {
        p_org: orgId, p_user: userId, p_employee: e.id, p_email: e.email, p_link: link, p_actor: ctx.userId,
      });
      if (rpcErr) { console.error('link_invited_member_tx', rpcErr); throw new ApiError('DB_ERROR', 'Database error', 500); }
      invited += 1;
    }
    await ctx.audit({
      organizationId: orgId, cycleId, action: 'cycle.invite-participants',
      entityType: 'cycle', entityId: cycleId, note: `invited ${invited}, already ${alreadyLinked}, skipped ${skipped.length}`,
    });
    return { invited, alreadyLinked, skipped };
  },
};
