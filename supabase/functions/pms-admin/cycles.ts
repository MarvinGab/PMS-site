import { ApiError, Handler, HandlerCtx } from '../_shared/kernel.ts';
import {
  optBool, optEnum, optInt, optNumber, optString, optUuid,
  reqArray, reqEnum, reqInt, reqIsoDate, reqNumber, reqObject, reqString, reqUuid,
} from '../_shared/validate.ts';

const EDITABLE = ['draft', 'setup'];
const FRAMEWORKS = ['bsc', 'kra-kpi', 'kra', 'custom'];
const WINDOW_KEYS = [
  'goal_creation', 'manager_approval', 'self_evaluation', 'manager_evaluation',
  'hod_review', 'hr_calibration', 'publishing_prep', 'acknowledgement',
];
const SECTIONS = [
  'perspectives', 'groups', 'target_types', 'rating_scale_levels', 'auto_rating_bands',
  'goal_rules', 'competency_config', 'competency_assignments', 'bell_curve_bands',
];
const SNAPSHOT_BLOCKS = [
  'visibility', 'roster_schema', 'notifications', 'targets', 'rating_scale', 'auto_rating', 'features',
];
const ADMIN_BLOCKS = ['bell'];
const VISIBILITY_VALUES = ['immediate', 'after_publish', 'never'];

async function loadCycle(ctx: HandlerCtx, orgId: string, cycleId: string) {
  const { data: cycle, error } = await ctx.admin.from('appraisal_cycles')
    .select().eq('id', cycleId).eq('organization_id', orgId).maybeSingle();
  if (error) { console.error('loadCycle', error); throw new ApiError('DB_ERROR', 'Database error', 500); }
  if (!cycle) throw new ApiError('NOT_FOUND', 'Cycle not found', 404);
  return cycle;
}

function assertEditable(cycle: Record<string, unknown>) {
  if (!EDITABLE.includes(cycle.status as string)) {
    throw new ApiError('CYCLE_LOCKED', `Configuration is locked once a cycle is ${cycle.status}`, 409);
  }
}

// The cycle row's version is the concurrency token for section/window saves:
// two admins racing on the same cycle — the loser gets CONFLICT and reloads.
async function claimCycleToken(ctx: HandlerCtx, orgId: string, cycle: Record<string, unknown>, expectedVersion: number) {
  return await ctx.versionedUpdate('appraisal_cycles', orgId, cycle.id as string, expectedVersion, {
    period_label: cycle.period_label ?? null,
  });
}

async function replaceRows(
  ctx: HandlerCtx, table: string, orgId: string, cycleId: string, rows: Record<string, unknown>[],
): Promise<number> {
  const { error: delErr } = await ctx.admin.from(table).delete()
    .eq('cycle_id', cycleId).eq('organization_id', orgId);
  if (delErr) { console.error(`replace ${table} delete`, delErr); throw new ApiError('DB_ERROR', 'Database error', 500); }
  if (rows.length === 0) return 0;
  const { error: insErr } = await ctx.admin.from(table).insert(rows);
  if (insErr) {
    if (insErr.code === '23505') throw new ApiError('BAD_REQUEST', `rows contain duplicates not allowed in ${table}`, 400);
    console.error(`replace ${table} insert`, insErr);
    throw new ApiError('DB_ERROR', 'Database error', 500);
  }
  return rows.length;
}

// ---------- per-section row builders ----------

function perspectiveRows(orgId: string, cycleId: string, raw: unknown) {
  return reqArray(raw, 'rows', 50).map((r, i) => {
    const o = reqObject(r, `rows[${i}]`);
    return {
      organization_id: orgId, cycle_id: cycleId,
      name: reqString(o.name, `rows[${i}].name`, 120),
      weight: optNumber(o.weight, `rows[${i}].weight`),
      color: optString(o.color, `rows[${i}].color`, 40),
      display_order: reqInt(o.displayOrder ?? i, `rows[${i}].displayOrder`),
    };
  });
}

function targetTypeRows(orgId: string, cycleId: string, raw: unknown) {
  return reqArray(raw, 'rows', 100).map((r, i) => {
    const o = reqObject(r, `rows[${i}]`);
    return {
      organization_id: orgId, cycle_id: cycleId,
      target_type_key: reqString(o.key, `rows[${i}].key`, 60),
      name: reqString(o.name, `rows[${i}].name`, 120),
      is_numeric: optBool(o.isNumeric, `rows[${i}].isNumeric`, true),
      unit: optString(o.unit, `rows[${i}].unit`, 30),
      unit_position: optEnum(o.unitPosition, `rows[${i}].unitPosition`, ['prefix', 'suffix']),
      min_value: optNumber(o.minValue, `rows[${i}].minValue`),
      max_value: optNumber(o.maxValue, `rows[${i}].maxValue`),
      lower_is_better: optBool(o.lowerIsBetter, `rows[${i}].lowerIsBetter`),
      hidden: optBool(o.hidden, `rows[${i}].hidden`),
      display_order: reqInt(o.displayOrder ?? i, `rows[${i}].displayOrder`),
    };
  });
}

function ratingScaleLevelRows(orgId: string, cycleId: string, raw: unknown) {
  return reqArray(raw, 'rows', 20).map((r, i) => {
    const o = reqObject(r, `rows[${i}]`);
    return {
      organization_id: orgId, cycle_id: cycleId,
      point: reqNumber(o.point, `rows[${i}].point`),
      label: reqString(o.label, `rows[${i}].label`, 120),
      code: optString(o.code, `rows[${i}].code`, 30),
      range_from: optNumber(o.rangeFrom, `rows[${i}].rangeFrom`),
      range_to: optNumber(o.rangeTo, `rows[${i}].rangeTo`),
      display_order: reqInt(o.displayOrder ?? i, `rows[${i}].displayOrder`),
    };
  });
}

function autoRatingBandRows(orgId: string, cycleId: string, raw: unknown) {
  return reqArray(raw, 'rows', 20).map((r, i) => {
    const o = reqObject(r, `rows[${i}]`);
    const fromPercent = reqNumber(o.fromPercent, `rows[${i}].fromPercent`);
    const toPercent = reqNumber(o.toPercent, `rows[${i}].toPercent`);
    if (toPercent < fromPercent) {
      throw new ApiError('BAD_REQUEST', `rows[${i}]: toPercent must be >= fromPercent`, 400);
    }
    return {
      organization_id: orgId, cycle_id: cycleId,
      from_percent: fromPercent, to_percent: toPercent,
      score: reqNumber(o.score, `rows[${i}].score`),
    };
  });
}

function bellBandRows(orgId: string, cycleId: string, raw: unknown) {
  return reqArray(raw, 'rows', 20).map((r, i) => {
    const o = reqObject(r, `rows[${i}]`);
    return {
      organization_id: orgId, cycle_id: cycleId,
      rating_point: reqNumber(o.ratingPoint, `rows[${i}].ratingPoint`),
      target_percent: reqNumber(o.targetPercent, `rows[${i}].targetPercent`),
      tolerance_percent: reqNumber(o.tolerancePercent ?? 0, `rows[${i}].tolerancePercent`),
    };
  });
}

async function cycleGroupMap(ctx: HandlerCtx, cycleId: string): Promise<Map<string, string>> {
  const { data, error } = await ctx.admin.from('cycle_groups').select('id, name').eq('cycle_id', cycleId);
  if (error) { console.error('cycleGroupMap', error); throw new ApiError('DB_ERROR', 'Database error', 500); }
  return new Map((data ?? []).map((g: { name: string; id: string }) => [g.name, g.id]));
}

async function goalRuleRows(ctx: HandlerCtx, orgId: string, cycleId: string, raw: unknown) {
  const byName = await cycleGroupMap(ctx, cycleId);
  return reqArray(raw, 'rows', 101).map((r, i) => {
    const o = reqObject(r, `rows[${i}]`);
    const groupName = optString(o.groupName, `rows[${i}].groupName`, 120);
    let groupId: string | null = null;
    if (groupName !== null) {
      groupId = byName.get(groupName) ?? null;
      if (!groupId) throw new ApiError('BAD_REQUEST', `rows[${i}].groupName "${groupName}" is not a group in this cycle`, 400);
    }
    return {
      organization_id: orgId, cycle_id: cycleId, group_id: groupId,
      min_kras: optInt(o.minKras, `rows[${i}].minKras`),
      max_kras: optInt(o.maxKras, `rows[${i}].maxKras`),
      min_kpis_per_kra: optInt(o.minKpisPerKra, `rows[${i}].minKpisPerKra`),
      max_kpis_per_kra: optInt(o.maxKpisPerKra, `rows[${i}].maxKpisPerKra`),
      min_kra_weight: optNumber(o.minKraWeight, `rows[${i}].minKraWeight`),
      max_kra_weight: optNumber(o.maxKraWeight, `rows[${i}].maxKraWeight`),
      min_kpi_weight: optNumber(o.minKpiWeight, `rows[${i}].minKpiWeight`),
      weightage_ownership: optString(o.weightageOwnership, `rows[${i}].weightageOwnership`, 60),
      employee_can_add_goals: optBool(o.employeeCanAddGoals, `rows[${i}].employeeCanAddGoals`),
      max_employee_added_goals: optInt(o.maxEmployeeAddedGoals, `rows[${i}].maxEmployeeAddedGoals`),
      manager_can_add_goals: optBool(o.managerCanAddGoals, `rows[${i}].managerCanAddGoals`),
      approval_required: optBool(o.approvalRequired, `rows[${i}].approvalRequired`, true),
    };
  });
}

async function competencyAssignmentRows(ctx: HandlerCtx, orgId: string, cycleId: string, raw: unknown) {
  const byName = await cycleGroupMap(ctx, cycleId);
  return reqArray(raw, 'rows', 500).map((r, i) => {
    const o = reqObject(r, `rows[${i}]`);
    const groupName = optString(o.groupName, `rows[${i}].groupName`, 120);
    let groupId: string | null = null;
    if (groupName !== null) {
      groupId = byName.get(groupName) ?? null;
      if (!groupId) throw new ApiError('BAD_REQUEST', `rows[${i}].groupName "${groupName}" is not a group in this cycle`, 400);
    }
    return {
      organization_id: orgId, cycle_id: cycleId, group_id: groupId,
      role_name: optString(o.roleName, `rows[${i}].roleName`, 120),
      competency_id: optUuid(o.competencyId, `rows[${i}].competencyId`),
      competency_name: reqString(o.competencyName, `rows[${i}].competencyName`, 200),
      kra_share: optNumber(o.kraShare, `rows[${i}].kraShare`),
      competency_share: optNumber(o.competencyShare, `rows[${i}].competencyShare`),
      display_order: reqInt(o.displayOrder ?? i, `rows[${i}].displayOrder`),
    };
  });
}

async function saveGroups(ctx: HandlerCtx, orgId: string, cycleId: string, raw: unknown): Promise<number> {
  const groups = reqArray(raw, 'rows', 100).map((r, i) => {
    const o = reqObject(r, `rows[${i}]`);
    return {
      row: {
        organization_id: orgId, cycle_id: cycleId,
        name: reqString(o.name, `rows[${i}].name`, 120),
        segment_attr: optString(o.segmentAttr, `rows[${i}].segmentAttr`, 120),
        is_catch_all: optBool(o.isCatchAll, `rows[${i}].isCatchAll`),
        can_edit_own_goals: optBool(o.canEditOwnGoals, `rows[${i}].canEditOwnGoals`),
        prefill_type: optString(o.prefillType, `rows[${i}].prefillType`, 60),
        has_library: optBool(o.hasLibrary, `rows[${i}].hasLibrary`),
        target_level: optEnum(o.targetLevel, `rows[${i}].targetLevel`, ['kra', 'kpi', 'custom']),
        rating_level: optEnum(o.ratingLevel, `rows[${i}].ratingLevel`, ['kra', 'kpi']),
        kpi_rating_mode: optString(o.kpiRatingMode, `rows[${i}].kpiRatingMode`, 60),
        display_order: reqInt(o.displayOrder ?? i, `rows[${i}].displayOrder`),
      },
      segmentValues: reqArray(o.segmentValues ?? [], `rows[${i}].segmentValues`, 200)
        .map((v, j) => reqString(v, `rows[${i}].segmentValues[${j}]`, 200)),
      libraryAssignments: reqArray(o.libraryAssignments ?? [], `rows[${i}].libraryAssignments`, 20)
        .map((a, j) => {
          const ao = reqObject(a, `rows[${i}].libraryAssignments[${j}]`);
          return {
            slot_key: reqString(ao.slotKey, `rows[${i}].libraryAssignments[${j}].slotKey`, 60),
            slot_label: optString(ao.slotLabel, `rows[${i}].libraryAssignments[${j}].slotLabel`, 120),
            goal_library_id: optUuid(ao.goalLibraryId, `rows[${i}].libraryAssignments[${j}].goalLibraryId`),
          };
        }),
    };
  });
  // Deleting groups cascades segment values, library assignments AND per-group
  // goal rules — clients must save groups BEFORE goal_rules/competency_assignments.
  await replaceRows(ctx, 'cycle_groups', orgId, cycleId, []);
  let count = 0;
  for (const g of groups) {
    const { data: inserted, error } = await ctx.admin.from('cycle_groups').insert(g.row).select('id').single();
    if (error) {
      if (error.code === '23505') throw new ApiError('BAD_REQUEST', `duplicate group name "${g.row.name}"`, 400);
      console.error('saveGroups insert', error);
      throw new ApiError('DB_ERROR', 'Database error', 500);
    }
    count += 1;
    if (g.segmentValues.length) {
      const { error: svErr } = await ctx.admin.from('cycle_group_segment_values').insert(
        g.segmentValues.map((v) => ({ organization_id: orgId, cycle_id: cycleId, group_id: inserted.id, value: v })),
      );
      if (svErr) { console.error('saveGroups segment values', svErr); throw new ApiError('DB_ERROR', 'Database error', 500); }
    }
    if (g.libraryAssignments.length) {
      const { error: laErr } = await ctx.admin.from('cycle_group_library_assignments').insert(
        g.libraryAssignments.map((a) => ({ organization_id: orgId, cycle_id: cycleId, group_id: inserted.id, ...a })),
      );
      if (laErr) { console.error('saveGroups library assignments', laErr); throw new ApiError('DB_ERROR', 'Database error', 500); }
    }
  }
  return count;
}

async function saveCompetencyConfig(ctx: HandlerCtx, orgId: string, cycleId: string, raw: unknown): Promise<number> {
  const o = reqObject(raw, 'config');
  const row = {
    organization_id: orgId, cycle_id: cycleId,
    enabled: optBool(o.enabled, 'config.enabled'),
    max_per_employee: optInt(o.maxPerEmployee, 'config.maxPerEmployee'),
    competency_weight: optNumber(o.competencyWeight, 'config.competencyWeight'),
    rated_by: optString(o.ratedBy, 'config.ratedBy', 60),
    allow_self_rate: optBool(o.allowSelfRate, 'config.allowSelfRate'),
    employee_can_edit: optBool(o.employeeCanEdit, 'config.employeeCanEdit'),
    scope: reqEnum(o.scope ?? 'org', 'config.scope', ['org', 'group', 'group_role']),
  };
  const { error } = await ctx.admin.from('cycle_competency_config')
    .upsert(row, { onConflict: 'cycle_id' });
  if (error) { console.error('saveCompetencyConfig', error); throw new ApiError('DB_ERROR', 'Database error', 500); }
  return 1;
}

// ---------- handlers ----------

export const cycleHandlers: Record<string, Handler> = {
  'cycle.create-draft': async (payload, ctx) => {
    const orgId = reqUuid(payload.orgId, 'orgId');
    const name = reqString(payload.name, 'name', 200);
    const periodLabel = optString(payload.periodLabel, 'periodLabel', 100);
    const frameworkId = reqEnum(payload.frameworkId, 'frameworkId', FRAMEWORKS);
    const membership = ctx.requireOrgRole(orgId, ['hr_admin']);
    const { data: cycle, error } = await ctx.admin.rpc('create_cycle_draft_tx', {
      p_org: orgId, p_name: name, p_period_label: periodLabel,
      p_framework: frameworkId, p_actor: ctx.userId,
      p_actor_role: membership.roles.join(','),
    });
    if (error) {
      if (error.code === '23505') {
        throw new ApiError('WORKING_CYCLE_EXISTS', 'This organization already has a working cycle', 409);
      }
      console.error('cycle.create-draft', error);
      throw new ApiError('DB_ERROR', 'Database error', 500);
    }
    return { cycle };
  },

  'cycle.save-section': async (payload, ctx) => {
    const orgId = reqUuid(payload.orgId, 'orgId');
    ctx.requireOrgRole(orgId, ['hr_admin']);
    const cycleId = reqUuid(payload.cycleId, 'cycleId');
    const cycleVersion = reqInt(payload.cycleVersion, 'cycleVersion');
    const section = reqEnum(payload.section, 'section', SECTIONS);
    const cycle = await loadCycle(ctx, orgId, cycleId);
    assertEditable(cycle);
    const fresh = await claimCycleToken(ctx, orgId, cycle, cycleVersion);
    let count = 0;
    switch (section) {
      case 'perspectives':
        count = await replaceRows(ctx, 'cycle_perspectives', orgId, cycleId, perspectiveRows(orgId, cycleId, payload.rows));
        break;
      case 'groups':
        count = await saveGroups(ctx, orgId, cycleId, payload.rows);
        break;
      case 'target_types':
        count = await replaceRows(ctx, 'cycle_target_types', orgId, cycleId, targetTypeRows(orgId, cycleId, payload.rows));
        break;
      case 'rating_scale_levels':
        count = await replaceRows(ctx, 'cycle_rating_scale_levels', orgId, cycleId, ratingScaleLevelRows(orgId, cycleId, payload.rows));
        break;
      case 'auto_rating_bands':
        count = await replaceRows(ctx, 'cycle_auto_rating_bands', orgId, cycleId, autoRatingBandRows(orgId, cycleId, payload.rows));
        break;
      case 'goal_rules':
        count = await replaceRows(ctx, 'cycle_goal_rules', orgId, cycleId, await goalRuleRows(ctx, orgId, cycleId, payload.rows));
        break;
      case 'competency_config':
        count = await saveCompetencyConfig(ctx, orgId, cycleId, payload.config);
        break;
      case 'competency_assignments':
        count = await replaceRows(ctx, 'cycle_competency_assignments', orgId, cycleId, await competencyAssignmentRows(ctx, orgId, cycleId, payload.rows));
        break;
      case 'bell_curve_bands':
        count = await replaceRows(ctx, 'cycle_bell_curve_bands', orgId, cycleId, bellBandRows(orgId, cycleId, payload.rows));
        break;
    }
    await ctx.audit({
      organizationId: orgId, cycleId, action: 'cycle.section.save',
      entityType: 'cycle_section', note: `${section}: ${count} row(s)`,
    });
    return { cycle: fresh, rows: count };
  },

  'cycle.set-windows': async (payload, ctx) => {
    const orgId = reqUuid(payload.orgId, 'orgId');
    ctx.requireOrgRole(orgId, ['hr_admin']);
    const cycleId = reqUuid(payload.cycleId, 'cycleId');
    const cycleVersion = reqInt(payload.cycleVersion, 'cycleVersion');
    const windows = reqArray(payload.windows, 'windows', 8).map((w, i) => {
      const o = reqObject(w, `windows[${i}]`);
      const startsOn = reqIsoDate(o.startsOn, `windows[${i}].startsOn`);
      const endsOn = reqIsoDate(o.endsOn, `windows[${i}].endsOn`);
      if (endsOn < startsOn) throw new ApiError('BAD_REQUEST', `windows[${i}]: endsOn must be >= startsOn`, 400);
      return {
        organization_id: orgId, cycle_id: cycleId,
        window_key: reqEnum(o.key, `windows[${i}].key`, WINDOW_KEYS),
        starts_on: startsOn, ends_on: endsOn,
      };
    });
    const keys = windows.map((w) => w.window_key);
    if (new Set(keys).size !== keys.length) throw new ApiError('BAD_REQUEST', 'windows contains duplicate keys', 400);
    const cycle = await loadCycle(ctx, orgId, cycleId);
    // The calendar governs LIVE cycles: windows stay editable in every status
    // except archived (spec: super-admin/HR edit, last-write-wins, audited).
    if (cycle.status === 'archived') {
      throw new ApiError('CYCLE_LOCKED', 'Archived cycles are read-only', 409);
    }
    const fresh = await claimCycleToken(ctx, orgId, cycle, cycleVersion);
    const count = await replaceRows(ctx, 'cycle_phase_windows', orgId, cycleId, windows);
    await ctx.audit({
      organizationId: orgId, cycleId, action: 'cycle.windows.set',
      entityType: 'cycle_phase_windows', note: `${count} window(s)`,
    });
    return { cycle: fresh, rows: count };
  },

  'cycle.set-snapshot-block': async (payload, ctx) => {
    const orgId = reqUuid(payload.orgId, 'orgId');
    ctx.requireOrgRole(orgId, ['hr_admin']);
    const cycleId = reqUuid(payload.cycleId, 'cycleId');
    const snapshotVersion = reqInt(payload.snapshotVersion, 'snapshotVersion');
    const block = reqEnum(payload.block, 'block', SNAPSHOT_BLOCKS);
    const data = reqObject(payload.data, 'data');
    if (block === 'visibility') {
      reqEnum(data.manager_rating_visible, 'data.manager_rating_visible', VISIBILITY_VALUES);
      reqEnum(data.final_rating_visible, 'data.final_rating_visible', VISIBILITY_VALUES);
    }
    const cycle = await loadCycle(ctx, orgId, cycleId);
    assertEditable(cycle);
    const { data: snap, error } = await ctx.admin.from('cycle_config_snapshots')
      .select().eq('cycle_id', cycleId).eq('organization_id', orgId).maybeSingle();
    if (error) { console.error('set-snapshot read', error); throw new ApiError('DB_ERROR', 'Database error', 500); }
    if (!snap) throw new ApiError('NOT_FOUND', 'Snapshot row not found', 404);
    const merged = { ...(snap.snapshot ?? {}), [block]: data };
    const updated = await ctx.versionedUpdate('cycle_config_snapshots', orgId, snap.id, snapshotVersion, { snapshot: merged });
    await ctx.audit({
      organizationId: orgId, cycleId, action: 'cycle.snapshot.set',
      entityType: 'cycle_config_snapshot', entityId: snap.id,
      before: { [block]: (snap.snapshot ?? {})[block] ?? null }, after: { [block]: data },
    });
    return { snapshot: updated };
  },

  'cycle.set-admin-config': async (payload, ctx) => {
    const orgId = reqUuid(payload.orgId, 'orgId');
    ctx.requireOrgRole(orgId, ['hr_admin']);
    const cycleId = reqUuid(payload.cycleId, 'cycleId');
    const adminConfigVersion = reqInt(payload.adminConfigVersion, 'adminConfigVersion');
    const block = reqEnum(payload.block, 'block', ADMIN_BLOCKS);
    const data = reqObject(payload.data, 'data');
    const cycle = await loadCycle(ctx, orgId, cycleId);
    assertEditable(cycle);
    const { data: cfg, error } = await ctx.admin.from('cycle_admin_config')
      .select().eq('cycle_id', cycleId).eq('organization_id', orgId).maybeSingle();
    if (error) { console.error('set-admin-config read', error); throw new ApiError('DB_ERROR', 'Database error', 500); }
    if (!cfg) throw new ApiError('NOT_FOUND', 'Admin config row not found', 404);
    const merged = { ...(cfg.payload ?? {}), [block]: data };
    const updated = await ctx.versionedUpdate('cycle_admin_config', orgId, cfg.id, adminConfigVersion, { payload: merged });
    await ctx.audit({
      organizationId: orgId, cycleId, action: 'cycle.admin_config.set',
      entityType: 'cycle_admin_config', entityId: cfg.id,
      before: { [block]: (cfg.payload ?? {})[block] ?? null }, after: { [block]: data },
    });
    return { adminConfig: updated };
  },
};
