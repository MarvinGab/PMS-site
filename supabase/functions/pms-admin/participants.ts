import { ApiError, Handler, HandlerCtx } from '../_shared/kernel.ts';
import { optString, reqArray, reqInt, reqString, reqUuid } from '../_shared/validate.ts';

const EDITABLE = ['draft', 'setup'];

async function loadEditableCycle(ctx: HandlerCtx, orgId: string, cycleId: string) {
  const { data: cycle, error } = await ctx.admin.from('appraisal_cycles')
    .select().eq('id', cycleId).eq('organization_id', orgId).maybeSingle();
  if (error) { console.error('loadCycle', error); throw new ApiError('DB_ERROR', 'Database error', 500); }
  if (!cycle) throw new ApiError('NOT_FOUND', 'Cycle not found', 404);
  if (!EDITABLE.includes(cycle.status)) {
    throw new ApiError('CYCLE_LOCKED', `Participants can't be changed once a cycle is ${cycle.status}`, 409);
  }
  return cycle;
}

export const participantHandlers: Record<string, Handler> = {
  'cycle.add-participants': async (payload, ctx) => {
    const orgId = reqUuid(payload.orgId, 'orgId');
    ctx.requireOrgRole(orgId, ['hr_admin']);
    const cycleId = reqUuid(payload.cycleId, 'cycleId');
    await loadEditableCycle(ctx, orgId, cycleId);
    const rawCodes = reqArray(payload.employeeCodes, 'employeeCodes', 5000)
      .map((c, i) => reqString(c, `employeeCodes[${i}]`, 60));
    const codes = [...new Set(rawCodes)];
    const { data: emps, error } = await ctx.admin.from('employees')
      .select('id, employee_code, group_name').eq('organization_id', orgId).in('employee_code', codes);
    if (error) { console.error('add-participants emps', error); throw new ApiError('DB_ERROR', 'Database error', 500); }
    const byCode = new Map((emps ?? []).map((e) => [e.employee_code, e]));
    const unknown = codes.filter((c) => !byCode.has(c));
    if (unknown.length) throw new ApiError('BAD_REQUEST', `unknown employee code(s): ${unknown.slice(0, 10).join(', ')}`, 400);
    const { data: existing } = await ctx.admin.from('cycle_participants')
      .select('id, employee_id, status, version').eq('cycle_id', cycleId);
    const existingByEmp = new Map((existing ?? []).map((p) => [p.employee_id, p]));
    const skipped: string[] = [];
    const toInsert: Record<string, unknown>[] = [];
    let reactivated = 0;
    for (const code of codes) {
      const e = byCode.get(code)!;
      if (e.group_name === 'NONE') { skipped.push(`${code} (roster-only)`); continue; }
      const ex = existingByEmp.get(e.id);
      if (ex) {
        if (ex.status === 'active') { skipped.push(`${code} (already added)`); continue; }
        const { error: reErr } = await ctx.admin.from('cycle_participants')
          .update({ status: 'active' }).eq('id', ex.id);
        if (reErr) { console.error('add-participants reactivate', reErr); throw new ApiError('DB_ERROR', 'Database error', 500); }
        reactivated += 1;
        continue;
      }
      toInsert.push({ organization_id: orgId, cycle_id: cycleId, employee_id: e.id });
    }
    let added = 0;
    if (toInsert.length) {
      const { error: insErr, count } = await ctx.admin.from('cycle_participants')
        .insert(toInsert, { count: 'exact' });
      if (insErr) { console.error('add-participants insert', insErr); throw new ApiError('DB_ERROR', 'Database error', 500); }
      added = count ?? toInsert.length;
    }
    await ctx.audit({
      organizationId: orgId, cycleId, action: 'cycle.add-participants',
      entityType: 'cycle_participants', note: `added ${added}, reactivated ${reactivated}, skipped ${skipped.length}`,
    });
    return { added, reactivated, skipped };
  },

  'cycle.remove-participant': async (payload, ctx) => {
    const orgId = reqUuid(payload.orgId, 'orgId');
    ctx.requireOrgRole(orgId, ['hr_admin']);
    const cycleId = reqUuid(payload.cycleId, 'cycleId');
    await loadEditableCycle(ctx, orgId, cycleId);
    const participantId = reqUuid(payload.participantId, 'participantId');
    const expectedVersion = reqInt(payload.expectedVersion, 'expectedVersion');
    const participant = await ctx.versionedUpdate('cycle_participants', orgId, participantId, expectedVersion, { status: 'removed' });
    await ctx.audit({
      organizationId: orgId, cycleId, action: 'cycle.remove-participant',
      entityType: 'cycle_participant', entityId: participantId, after: { status: 'removed' },
    });
    return { participant };
  },

  'cycle.assign-participant': async (payload, ctx) => {
    const orgId = reqUuid(payload.orgId, 'orgId');
    ctx.requireOrgRole(orgId, ['hr_admin']);
    const cycleId = reqUuid(payload.cycleId, 'cycleId');
    await loadEditableCycle(ctx, orgId, cycleId);
    const participantId = reqUuid(payload.participantId, 'participantId');
    const groupName = optString(payload.groupName, 'groupName', 120);
    const goalLibraryName = optString(payload.goalLibraryName, 'goalLibraryName', 200);
    const prefillDatasetName = optString(payload.prefillDatasetName, 'prefillDatasetName', 200);

    const { data: participant, error: pErr } = await ctx.admin.from('cycle_participants')
      .select('id, employee_id').eq('id', participantId).eq('cycle_id', cycleId).eq('organization_id', orgId).maybeSingle();
    if (pErr) { console.error('assign read participant', pErr); throw new ApiError('DB_ERROR', 'Database error', 500); }
    if (!participant) throw new ApiError('NOT_FOUND', 'Participant not found', 404);

    let groupId: string | null = null;
    if (groupName) {
      const { data: g, error: gErr } = await ctx.admin.from('cycle_groups')
        .select('id').eq('cycle_id', cycleId).eq('name', groupName).maybeSingle();
      if (gErr) { console.error('assign group lookup', gErr); throw new ApiError('DB_ERROR', 'Database error', 500); }
      if (!g) throw new ApiError('BAD_REQUEST', `group "${groupName}" is not a group in this cycle`, 400);
      groupId = g.id;
    }
    let goalLibraryId: string | null = null;
    if (goalLibraryName) {
      const { data: l, error: lErr } = await ctx.admin.from('goal_libraries')
        .select('id').eq('organization_id', orgId).eq('name', goalLibraryName).maybeSingle();
      if (lErr) { console.error('assign library lookup', lErr); throw new ApiError('DB_ERROR', 'Database error', 500); }
      if (!l) throw new ApiError('BAD_REQUEST', `goal library "${goalLibraryName}" not found`, 400);
      goalLibraryId = l.id;
    }
    let prefillDatasetId: string | null = null;
    if (prefillDatasetName) {
      const { data: d, error: dErr } = await ctx.admin.from('prefill_datasets')
        .select('id').eq('organization_id', orgId).eq('name', prefillDatasetName).maybeSingle();
      if (dErr) { console.error('assign prefill lookup', dErr); throw new ApiError('DB_ERROR', 'Database error', 500); }
      if (!d) throw new ApiError('BAD_REQUEST', `prefill dataset "${prefillDatasetName}" not found`, 400);
      prefillDatasetId = d.id;
    }
    const { data: existingAssign, error: exErr } = await ctx.admin.from('cycle_participant_assignments')
      .select('group_id, goal_library_id, prefill_dataset_id').eq('participant_id', participantId).maybeSingle();
    if (exErr) { console.error('assign existing read', exErr); throw new ApiError('DB_ERROR', 'Database error', 500); }
    const finalGroupId = groupName !== null ? groupId : (existingAssign?.group_id ?? null);
    const finalLibraryId = goalLibraryName !== null ? goalLibraryId : (existingAssign?.goal_library_id ?? null);
    const finalPrefillId = prefillDatasetName !== null ? prefillDatasetId : (existingAssign?.prefill_dataset_id ?? null);
    const { data: assignment, error } = await ctx.admin.from('cycle_participant_assignments')
      .upsert({
        organization_id: orgId, cycle_id: cycleId, participant_id: participantId,
        employee_id: participant.employee_id, group_id: finalGroupId,
        goal_library_id: finalLibraryId, prefill_dataset_id: finalPrefillId,
      }, { onConflict: 'participant_id' }).select().single();
    if (error) { console.error('assign upsert', error); throw new ApiError('DB_ERROR', 'Database error', 500); }
    await ctx.audit({
      organizationId: orgId, cycleId, action: 'cycle.assign-participant',
      entityType: 'cycle_participant_assignment', entityId: assignment.id,
      after: { group_id: finalGroupId, goal_library_id: finalLibraryId, prefill_dataset_id: finalPrefillId },
    });
    return { assignment };
  },

  'cycle.list-participants': async (payload, ctx) => {
    const orgId = reqUuid(payload.orgId, 'orgId');
    ctx.requireOrgRole(orgId, ['hr_admin']);
    const cycleId = reqUuid(payload.cycleId, 'cycleId');
    const { data, error } = await ctx.admin.from('cycle_participants')
      .select('id, employee_id, status, version, employees(employee_code, full_name, email, group_name)')
      .eq('cycle_id', cycleId).eq('organization_id', orgId);
    if (error) { console.error('list-participants', error); throw new ApiError('DB_ERROR', 'Database error', 500); }
    return { participants: data ?? [] };
  },
};
