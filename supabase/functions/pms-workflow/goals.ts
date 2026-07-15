import { ApiError, Handler, HandlerCtx } from '../_shared/kernel.ts';
import { optNumber, optString, optUuid, reqArray, reqEnum, reqInt, reqObject, reqString, reqUuid } from '../_shared/validate.ts';
import { callerEmployeeId, isHodOf, isHrOrSuper, manages } from '../_shared/scope.ts';
import { loadActiveCycle, pureWindowOpen, requireWindowOrHr } from '../_shared/phase.ts';
import { GoalNode, GoalRules, validateGoalTree } from './goalrules.ts';

// phase.ts's todayIso() is module-private — mirror it here (date-granular, UTC).
function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

async function readPlanBundle(ctx: HandlerCtx, orgId: string, cycleId: string, employeeId: string) {
  const { data: plan, error } = await ctx.admin.from('employee_goal_plans')
    .select().eq('cycle_id', cycleId).eq('employee_id', employeeId).eq('organization_id', orgId).maybeSingle();
  if (error) { console.error('readPlan', error); throw new ApiError('DB_ERROR', 'Database error', 500); }
  if (!plan) return { plan: null, items: [], competencies: [] };
  const { data: items } = await ctx.admin.from('employee_goal_items')
    .select().eq('plan_id', plan.id).order('display_order');
  const { data: comps } = await ctx.admin.from('employee_goal_plan_competencies')
    .select().eq('plan_id', plan.id).order('display_order');
  return { plan, items: items ?? [], competencies: comps ?? [] };
}

// May the caller read/act on this target employee's plan?
async function canAccessTarget(ctx: HandlerCtx, orgId: string, targetEmployeeId: string): Promise<boolean> {
  if (isHrOrSuper(ctx, orgId)) return true;
  if (callerEmployeeId(ctx, orgId) === targetEmployeeId) return true;
  if (await manages(ctx, orgId, targetEmployeeId)) return true;
  if (await isHodOf(ctx, orgId, targetEmployeeId)) return true;
  return false;
}

const EDITABLE_PLAN = ['draft', 'sent_back', 'reopened'];

// Resolve the merged goal rules (group-specific, falling back to the cycle default) for an employee.
export async function resolveGoalRules(ctx: HandlerCtx, orgId: string, cycleId: string, employeeId: string): Promise<GoalRules> {
  const { data: assign, error: aErr } = await ctx.admin.from('cycle_participant_assignments')
    .select('group_id').eq('organization_id', orgId).eq('cycle_id', cycleId).eq('employee_id', employeeId).maybeSingle();
  if (aErr) { console.error('resolveGoalRules assign', aErr); throw new ApiError('DB_ERROR', 'Database error', 500); }
  const groupId = assign?.group_id ?? null;
  const { data, error } = await ctx.admin.from('cycle_goal_rules').select().eq('organization_id', orgId).eq('cycle_id', cycleId);
  if (error) { console.error('resolveGoalRules rules', error); throw new ApiError('DB_ERROR', 'Database error', 500); }
  const rows = data ?? [];
  return (rows.find((r) => groupId && r.group_id === groupId) ?? rows.find((r) => r.group_id === null) ?? {
    min_kras: null, max_kras: null, min_kpis_per_kra: null, max_kpis_per_kra: null,
    min_kra_weight: null, max_kra_weight: null, min_kpi_weight: null,
  }) as GoalRules;
}

async function participantGroupId(ctx: HandlerCtx, orgId: string, cycleId: string, employeeId: string): Promise<string | null> {
  const { data, error } = await ctx.admin.from('cycle_participant_assignments')
    .select('group_id').eq('organization_id', orgId).eq('cycle_id', cycleId).eq('employee_id', employeeId).maybeSingle();
  if (error) { console.error('participantGroupId', error); throw new ApiError('DB_ERROR', 'Database error', 500); }
  return data?.group_id ?? null;
}

export const goalHandlers: Record<string, Handler> = {
  'goal.get-plan': async (payload, ctx) => {
    const orgId = reqUuid(payload.orgId, 'orgId');
    const cycleId = reqUuid(payload.cycleId, 'cycleId');
    const targetId = optUuid(payload.employeeId, 'employeeId') ?? callerEmployeeId(ctx, orgId);
    if (!(await canAccessTarget(ctx, orgId, targetId))) {
      throw new ApiError('FORBIDDEN', 'You cannot view this employee\'s goals', 403);
    }
    return await readPlanBundle(ctx, orgId, cycleId, targetId);
  },

  'goal.ensure-plan': async (payload, ctx) => {
    const orgId = reqUuid(payload.orgId, 'orgId');
    const cycleId = reqUuid(payload.cycleId, 'cycleId');
    await loadActiveCycle(ctx, orgId, cycleId);
    const employeeId = callerEmployeeId(ctx, orgId);

    const { data: participant, error: pErr } = await ctx.admin.from('cycle_participants')
      .select('id, status').eq('cycle_id', cycleId).eq('employee_id', employeeId).eq('organization_id', orgId).maybeSingle();
    if (pErr) { console.error('ensure participant', pErr); throw new ApiError('DB_ERROR', 'Database error', 500); }
    if (!participant || participant.status !== 'active') {
      throw new ApiError('NOT_A_PARTICIPANT', 'You are not an active participant in this cycle', 403);
    }

    const existing = await readPlanBundle(ctx, orgId, cycleId, employeeId);
    if (existing.plan) return { ...existing, seeded: 0 };

    // Create the draft plan.
    const { data: plan, error: planErr } = await ctx.admin.from('employee_goal_plans')
      .insert({ organization_id: orgId, cycle_id: cycleId, employee_id: employeeId, status: 'draft' })
      .select().single();
    if (planErr) {
      if (planErr.code === '23505') { // race: created concurrently
        const again = await readPlanBundle(ctx, orgId, cycleId, employeeId);
        return { ...again, seeded: 0 };
      }
      console.error('ensure plan insert', planErr);
      throw new ApiError('DB_ERROR', 'Database error', 500);
    }

    let seeded: number;
    try {
      seeded = await seedItems(ctx, orgId, cycleId, plan.id, employeeId);
    } catch (err) {
      // Seeding failed mid-way — remove the empty plan so a retry re-seeds cleanly.
      await ctx.admin.from('employee_goal_plans').delete().eq('id', plan.id).eq('organization_id', orgId);
      throw err;
    }
    await ctx.audit({
      organizationId: orgId, cycleId, action: 'goal.ensure-plan',
      entityType: 'employee_goal_plan', entityId: plan.id, note: `seeded ${seeded} item(s)`,
    });
    const bundle = await readPlanBundle(ctx, orgId, cycleId, employeeId);
    return { ...bundle, seeded };
  },

  'goal.save-items': async (payload, ctx) => {
    const orgId = reqUuid(payload.orgId, 'orgId');
    const cycleId = reqUuid(payload.cycleId, 'cycleId');
    const planVersion = reqInt(payload.planVersion, 'planVersion');
    const employeeId = callerEmployeeId(ctx, orgId);
    await loadActiveCycle(ctx, orgId, cycleId);
    await requireWindowOrHr(ctx, orgId, cycleId, 'goal_creation');

    const { data: plan, error: pErr } = await ctx.admin.from('employee_goal_plans')
      .select().eq('cycle_id', cycleId).eq('employee_id', employeeId).eq('organization_id', orgId).maybeSingle();
    if (pErr) { console.error('save-items plan', pErr); throw new ApiError('DB_ERROR', 'Database error', 500); }
    if (!plan) throw new ApiError('NOT_FOUND', 'No goal plan — call ensure-plan first', 404);
    if (!EDITABLE_PLAN.includes(plan.status)) throw new ApiError('PLAN_LOCKED', `Goals can't be edited once the plan is ${plan.status}`, 409);

    // The group must permit self-editing (unless HR is acting).
    const groupId = await participantGroupId(ctx, orgId, cycleId, employeeId);
    if (!isHrOrSuper(ctx, orgId) && groupId) {
      const { data: group, error: gErr } = await ctx.admin.from('cycle_groups').select('can_edit_own_goals').eq('id', groupId).eq('organization_id', orgId).maybeSingle();
      if (gErr) { console.error('save-items group', gErr); throw new ApiError('DB_ERROR', 'Database error', 500); }
      if (group && group.can_edit_own_goals === false) throw new ApiError('EDIT_NOT_ALLOWED', 'Your group does not allow editing goals', 403);
    }

    // Parse + validate the incoming tree (payload keys are caller-local).
    const rawItems = reqArray(payload.items, 'items', 200).map((r, i) => {
      const o = reqObject(r, `items[${i}]`);
      return {
        key: reqString(o.key, `items[${i}].key`, 120),
        itemType: reqEnum(o.itemType, `items[${i}].itemType`, ['kra', 'kpi']),
        parentKey: optString(o.parentKey, `items[${i}].parentKey`, 120),
        title: reqString(o.title, `items[${i}].title`, 300),
        description: optString(o.description, `items[${i}].description`, 2000),
        perspective: optString(o.perspective, `items[${i}].perspective`, 120),
        weight: optNumber(o.weight, `items[${i}].weight`),
        target_type_key: optString(o.targetTypeKey, `items[${i}].targetTypeKey`, 60),
        target_value: optString(o.targetValue, `items[${i}].targetValue`, 200),
        display_order: reqInt(o.displayOrder ?? i, `items[${i}].displayOrder`),
      };
    });
    const keys = rawItems.map((r) => r.key);
    if (new Set(keys).size !== keys.length) throw new ApiError('BAD_REQUEST', 'items contain duplicate keys', 400);
    const rules = await resolveGoalRules(ctx, orgId, cycleId, employeeId);
    validateGoalTree(rawItems as GoalNode[], rules);

    // Claim the version token first (so a stale editor is rejected before we rewrite rows).
    const freshPlan = await ctx.versionedUpdate('employee_goal_plans', orgId, plan.id, planVersion, { status: plan.status });

    // Full replace: delete then two-pass insert (KRAs first to resolve KPI parentKey).
    await ctx.admin.from('employee_goal_items').delete().eq('plan_id', plan.id).eq('organization_id', orgId);
    const keyToId = new Map<string, string>();
    for (const it of rawItems.filter((r) => r.itemType === 'kra')) {
      const { data: row, error } = await ctx.admin.from('employee_goal_items').insert({
        organization_id: orgId, cycle_id: cycleId, plan_id: plan.id, employee_id: employeeId,
        item_type: 'kra', title: it.title, description: it.description, perspective: it.perspective,
        weight: it.weight, target_type_key: it.target_type_key, target_value: it.target_value,
        source: 'employee', display_order: it.display_order,
      }).select('id').single();
      if (error) { console.error('save kra', error); throw new ApiError('DB_ERROR', 'Database error', 500); }
      keyToId.set(it.key, row.id);
    }
    for (const it of rawItems.filter((r) => r.itemType === 'kpi')) {
      const parentId = it.parentKey ? keyToId.get(it.parentKey) ?? null : null;
      const { error } = await ctx.admin.from('employee_goal_items').insert({
        organization_id: orgId, cycle_id: cycleId, plan_id: plan.id, employee_id: employeeId,
        item_type: 'kpi', parent_item_id: parentId, title: it.title, description: it.description,
        perspective: it.perspective, weight: it.weight, target_type_key: it.target_type_key,
        target_value: it.target_value, source: 'employee', display_order: it.display_order,
      });
      if (error) { console.error('save kpi', error); throw new ApiError('DB_ERROR', 'Database error', 500); }
    }
    await ctx.audit({
      organizationId: orgId, cycleId, action: 'goal.save-items',
      entityType: 'employee_goal_plan', entityId: plan.id, note: `${rawItems.length} item(s)`,
    });
    const { data: items } = await ctx.admin.from('employee_goal_items').select().eq('plan_id', plan.id).order('display_order');
    return { plan: freshPlan, items: items ?? [] };
  },

  // One scoped read for the employee goals screen: active cycle + config + library +
  // prefill + window + the plan bundle. Scoped to the caller unless HR/super passes employeeId.
  'goal.context': async (payload, ctx) => {
    const orgId = reqUuid(payload.orgId, 'orgId');
    const requested = optUuid(payload.employeeId, 'employeeId');
    const employeeId = requested && (await isHrOrSuper(ctx, orgId)) ? requested : callerEmployeeId(ctx, orgId);

    // Active/working cycle for the org (one active cycle per org).
    const { data: cycle, error: cErr } = await ctx.admin.from('appraisal_cycles')
      .select('id, name, status').eq('organization_id', orgId).eq('status', 'active').maybeSingle();
    if (cErr) { console.error('goal.context cycle', cErr); throw new ApiError('DB_ERROR', 'Database error', 500); }
    if (!cycle) return { cycle: null, participant: false, config: null, library: { items: [] }, prefill: { items: [] }, window: { goalOpen: false }, plan: null, items: [], competencies: [] };
    const cycleId = cycle.id;

    const { data: part, error: pErr } = await ctx.admin.from('cycle_participants')
      .select('id').eq('cycle_id', cycleId).eq('employee_id', employeeId).eq('organization_id', orgId).maybeSingle();
    if (pErr) { console.error('goal.context participant', pErr); throw new ApiError('DB_ERROR', 'Database error', 500); }
    const cycleOut = { id: cycle.id, name: cycle.name, status: cycle.status };
    if (!part) return { cycle: cycleOut, participant: false, config: null, library: { items: [] }, prefill: { items: [] }, window: { goalOpen: false }, plan: null, items: [], competencies: [] };

    const { data: assign } = await ctx.admin.from('cycle_participant_assignments')
      .select('group_id, goal_library_id, prefill_dataset_id').eq('cycle_id', cycleId).eq('employee_id', employeeId).eq('organization_id', orgId).maybeSingle();

    // NOTE (discovery, Plan 5b Task 1): cycle_groups has no goal_creation_mode/goal_kpi_mode
    // columns. Real columns: has_library (bool), prefill_type (text), target_level
    // ('kra'|'kpi'|'custom'), kpi_rating_mode (text), can_edit_own_goals (bool).
    let group: { can_edit_own_goals: boolean | null; kpi_rating_mode: string | null; has_library: boolean | null; prefill_type: string | null; target_level: string | null } | null = null;
    if (assign?.group_id) {
      const { data: g } = await ctx.admin.from('cycle_groups')
        .select('can_edit_own_goals, kpi_rating_mode, has_library, prefill_type, target_level').eq('id', assign.group_id).eq('organization_id', orgId).maybeSingle();
      group = g;
    }

    const { data: snapRow } = await ctx.admin.from('cycle_config_snapshots').select('snapshot').eq('cycle_id', cycleId).eq('organization_id', orgId).maybeSingle();
    const snap = (snapRow?.snapshot ?? {}) as Record<string, any>;
    const { data: targetTypes } = await ctx.admin.from('cycle_target_types').select().eq('cycle_id', cycleId).eq('organization_id', orgId).order('display_order');
    const { data: ratingScale } = await ctx.admin.from('cycle_rating_scale_levels').select().eq('cycle_id', cycleId).eq('organization_id', orgId).order('point');
    const { data: goalRules } = await ctx.admin.from('cycle_goal_rules').select().eq('cycle_id', cycleId).eq('organization_id', orgId);

    // Library items (add-from-library) — only if the assigned library is active.
    let library: { id?: string; items: unknown[] } = { items: [] };
    if (assign?.goal_library_id) {
      const { data: lib } = await ctx.admin.from('goal_libraries').select('id, status').eq('id', assign.goal_library_id).eq('organization_id', orgId).maybeSingle();
      if (lib?.status === 'active') {
        const { data: libItems } = await ctx.admin.from('goal_library_items').select().eq('goal_library_id', assign.goal_library_id).order('display_order');
        library = { id: lib.id, items: libItems ?? [] };
      }
    }

    // Prefill rows for this employee (by employee_code).
    let prefill: { items: unknown[] } = { items: [] };
    if (assign?.prefill_dataset_id) {
      const { data: ds } = await ctx.admin.from('prefill_datasets').select('id, status').eq('id', assign.prefill_dataset_id).eq('organization_id', orgId).maybeSingle();
      if (ds?.status === 'active') {
        const { data: emp } = await ctx.admin.from('employees').select('employee_code').eq('id', employeeId).eq('organization_id', orgId).maybeSingle();
        if (emp?.employee_code) {
          const { data: pf } = await ctx.admin.from('prefill_dataset_items').select().eq('prefill_dataset_id', assign.prefill_dataset_id).eq('employee_code', emp.employee_code).order('display_order');
          prefill = { items: pf ?? [] };
        }
      }
    }

    const { data: windows } = await ctx.admin.from('cycle_phase_windows').select('window_key, starts_on, ends_on').eq('cycle_id', cycleId).eq('organization_id', orgId);
    const goalOpen = pureWindowOpen((windows ?? []) as { window_key: string; starts_on: string; ends_on: string }[], 'goal_creation', todayIso()) || (await isHrOrSuper(ctx, orgId));

    const bundle = await readPlanBundle(ctx, orgId, cycleId, employeeId);

    return {
      cycle: cycleOut,
      participant: true,
      config: {
        // has_library declares an admin-curated library group; prefill_type ('kra-only' |
        // 'kra-kpi') declares admin-driven prefilled goals. Both are orthogonal per-group
        // flags in the new schema (unlike the old blob model's single prefillType field).
        goalCreationMode: group?.has_library ? 'admin-library' : 'employee-self',
        goalKpiMode: (group?.prefill_type === 'kra-only' || group?.prefill_type === 'kras-only')
          ? 'kra-only'
          : (snap?.targets?.goalKpiMode ?? 'kra-kpi'),
        kpiRatingMode: group?.kpi_rating_mode === 'free-text' ? 'free-text' : 'rated',
        targetLevelMode: (group?.target_level ? group.target_level.toUpperCase() : null) ?? snap?.targets?.targetLevelMode ?? 'KPI',
        targetTypes: targetTypes ?? [],
        ratingScale: ratingScale ?? [],
        canEditOwnGoals: group?.can_edit_own_goals ?? false,
        goalRules: goalRules ?? [],
      },
      library,
      prefill,
      window: { goalOpen },
      ...bundle,
    };
  },

  // Manager-scoped LIST read for the goal-approval screen: the caller's direct reports
  // (reporting_relationships, relation_type manager/l2 — same set manages() checks)
  // intersected with the active cycle's active participants, each left-joined to their
  // employee_goal_plans row (status/version/submitted_at) and a KRA count.
  'goal.review-queue': async (payload, ctx) => {
    const orgId = reqUuid(payload.orgId, 'orgId');
    const managerEmployeeId = callerEmployeeId(ctx, orgId);

    const { data: cycle, error: cErr } = await ctx.admin.from('appraisal_cycles')
      .select('id, name, status').eq('organization_id', orgId).eq('status', 'active').maybeSingle();
    if (cErr) { console.error('goal.review-queue cycle', cErr); throw new ApiError('DB_ERROR', 'Database error', 500); }
    if (!cycle) return { cycle: null, window: { approvalOpen: false }, reports: [] };
    const cycleId = cycle.id;
    const cycleOut = { id: cycle.id, name: cycle.name, status: cycle.status };

    const { data: windows, error: wErr } = await ctx.admin.from('cycle_phase_windows')
      .select('window_key, starts_on, ends_on').eq('cycle_id', cycleId).eq('organization_id', orgId);
    if (wErr) { console.error('goal.review-queue windows', wErr); throw new ApiError('DB_ERROR', 'Database error', 500); }
    const approvalOpen = pureWindowOpen((windows ?? []) as { window_key: string; starts_on: string; ends_on: string }[], 'manager_approval', todayIso()) || (await isHrOrSuper(ctx, orgId));

    // Direct reports: reporting_relationships rows where related_employee_id (the "related
    // to") is the caller and relation_type is manager/l2 — mirrors _shared/scope.ts manages().
    const { data: rels, error: rErr } = await ctx.admin.from('reporting_relationships')
      .select('employee_id').eq('organization_id', orgId).eq('related_employee_id', managerEmployeeId).in('relation_type', ['manager', 'l2']);
    if (rErr) { console.error('goal.review-queue relations', rErr); throw new ApiError('DB_ERROR', 'Database error', 500); }
    const reportIds = [...new Set((rels ?? []).map((r) => r.employee_id as string))];
    if (reportIds.length === 0) return { cycle: cycleOut, window: { approvalOpen }, reports: [] };

    // Intersect with this cycle's active participants.
    const { data: parts, error: pErr } = await ctx.admin.from('cycle_participants')
      .select('employee_id').eq('organization_id', orgId).eq('cycle_id', cycleId).eq('status', 'active').in('employee_id', reportIds);
    if (pErr) { console.error('goal.review-queue participants', pErr); throw new ApiError('DB_ERROR', 'Database error', 500); }
    const participantIds = (parts ?? []).map((p) => p.employee_id as string);
    if (participantIds.length === 0) return { cycle: cycleOut, window: { approvalOpen }, reports: [] };

    const { data: emps, error: eErr } = await ctx.admin.from('employees')
      .select('id, full_name, employee_code').eq('organization_id', orgId).in('id', participantIds);
    if (eErr) { console.error('goal.review-queue employees', eErr); throw new ApiError('DB_ERROR', 'Database error', 500); }

    const { data: plans, error: plErr } = await ctx.admin.from('employee_goal_plans')
      .select('id, employee_id, status, version, submitted_at').eq('organization_id', orgId).eq('cycle_id', cycleId).in('employee_id', participantIds);
    if (plErr) { console.error('goal.review-queue plans', plErr); throw new ApiError('DB_ERROR', 'Database error', 500); }
    const planByEmp = new Map((plans ?? []).map((p) => [p.employee_id as string, p]));

    const planIds = (plans ?? []).map((p) => p.id as string);
    const kraCountByPlan = new Map<string, number>();
    if (planIds.length > 0) {
      const { data: items, error: iErr } = await ctx.admin.from('employee_goal_items')
        .select('plan_id').eq('organization_id', orgId).eq('item_type', 'kra').in('plan_id', planIds);
      if (iErr) { console.error('goal.review-queue items', iErr); throw new ApiError('DB_ERROR', 'Database error', 500); }
      for (const it of items ?? []) kraCountByPlan.set(it.plan_id, (kraCountByPlan.get(it.plan_id) ?? 0) + 1);
    }

    const reports = (emps ?? []).map((e) => {
      const plan = planByEmp.get(e.id as string) ?? null;
      return {
        employeeId: e.id as string,
        employeeName: e.full_name as string,
        employeeCode: e.employee_code as string,
        planId: plan?.id ?? null,
        planStatus: plan?.status ?? null,
        planVersion: plan?.version ?? null,
        submittedAt: plan?.submitted_at ?? null,
        kraCount: plan ? (kraCountByPlan.get(plan.id) ?? 0) : 0,
      };
    }).sort((a, b) => a.employeeName.localeCompare(b.employeeName));

    return { cycle: cycleOut, window: { approvalOpen }, reports };
  },
};

// Seed goal items from the participant's assigned library (KRA/KPI tree) + prefill dataset.
// Archived libraries/datasets contribute nothing (2b-deferred rule).
async function seedItems(
  ctx: HandlerCtx, orgId: string, cycleId: string, planId: string, employeeId: string,
): Promise<number> {
  const { data: assign, error: aErr } = await ctx.admin.from('cycle_participant_assignments')
    .select('goal_library_id, prefill_dataset_id').eq('cycle_id', cycleId).eq('employee_id', employeeId).eq('organization_id', orgId).maybeSingle();
  if (aErr) { console.error('seed assign', aErr); throw new ApiError('DB_ERROR', 'Database error', 500); }
  if (!assign) return 0;

  let seeded = 0;

  // 1) Library KRA/KPI tree (only if the library is active).
  if (assign.goal_library_id) {
    const { data: lib, error: libErr } = await ctx.admin.from('goal_libraries')
      .select('id, status').eq('id', assign.goal_library_id).eq('organization_id', orgId).maybeSingle();
    if (libErr) { console.error('seed lib', libErr); throw new ApiError('DB_ERROR', 'Database error', 500); }
    if (lib && lib.status === 'active') {
      const { data: libItems } = await ctx.admin.from('goal_library_items')
        .select().eq('goal_library_id', assign.goal_library_id).order('display_order');
      const kraMap = new Map<string, string>(); // library kra id -> new goal item id
      for (const it of (libItems ?? []).filter((x) => x.item_type === 'kra')) {
        const { data: row, error } = await ctx.admin.from('employee_goal_items').insert({
          organization_id: orgId, cycle_id: cycleId, plan_id: planId, employee_id: employeeId,
          item_type: 'kra', title: it.title, description: it.description, perspective: it.perspective,
          weight: it.weight, target_type_key: it.target_type_key, target_value: it.target_value,
          source: 'library', display_order: it.display_order,
        }).select('id').single();
        if (error) { console.error('seed kra', error); throw new ApiError('DB_ERROR', 'Database error', 500); }
        kraMap.set(it.id, row.id); seeded += 1;
      }
      for (const it of (libItems ?? []).filter((x) => x.item_type === 'kpi')) {
        const parentId = it.parent_item_id ? kraMap.get(it.parent_item_id) ?? null : null;
        const { error } = await ctx.admin.from('employee_goal_items').insert({
          organization_id: orgId, cycle_id: cycleId, plan_id: planId, employee_id: employeeId,
          item_type: 'kpi', parent_item_id: parentId, title: it.title, description: it.description,
          perspective: it.perspective, weight: it.weight, target_type_key: it.target_type_key,
          target_value: it.target_value, source: 'library', display_order: it.display_order,
        });
        if (error) { console.error('seed kpi', error); throw new ApiError('DB_ERROR', 'Database error', 500); }
        seeded += 1;
      }
    }
  }

  // 2) Prefill rows for this employee's code (only if the dataset is active).
  if (assign.prefill_dataset_id) {
    const { data: ds, error: dsErr } = await ctx.admin.from('prefill_datasets')
      .select('id, status').eq('id', assign.prefill_dataset_id).eq('organization_id', orgId).maybeSingle();
    if (dsErr) { console.error('seed ds', dsErr); throw new ApiError('DB_ERROR', 'Database error', 500); }
    const { data: emp, error: empErr } = await ctx.admin.from('employees').select('employee_code').eq('id', employeeId).single();
    if (empErr) { console.error('seed emp', empErr); throw new ApiError('DB_ERROR', 'Database error', 500); }
    if (ds && ds.status === 'active' && emp) {
      const { data: pf, error: pfErr } = await ctx.admin.from('prefill_dataset_items')
        .select().eq('prefill_dataset_id', assign.prefill_dataset_id).eq('employee_code', emp.employee_code).order('display_order');
      if (pfErr) { console.error('seed pf', pfErr); throw new ApiError('DB_ERROR', 'Database error', 500); }
      for (const it of pf ?? []) {
        // Prefill rows are flat KRA(+optional KPI title) — seed the KRA; if kpi_title present, seed a child KPI.
        const { data: kraRow, error } = await ctx.admin.from('employee_goal_items').insert({
          organization_id: orgId, cycle_id: cycleId, plan_id: planId, employee_id: employeeId,
          item_type: 'kra', title: it.kra_title, perspective: it.perspective, weight: it.weight,
          target_type_key: it.target_type_key, target_value: it.target_value,
          source: 'prefill', display_order: 100 + it.display_order,
        }).select('id').single();
        if (error) { console.error('seed prefill kra', error); throw new ApiError('DB_ERROR', 'Database error', 500); }
        seeded += 1;
        if (it.kpi_title) {
          const { error: kErr } = await ctx.admin.from('employee_goal_items').insert({
            organization_id: orgId, cycle_id: cycleId, plan_id: planId, employee_id: employeeId,
            item_type: 'kpi', parent_item_id: kraRow.id, title: it.kpi_title, perspective: it.perspective,
            target_type_key: it.target_type_key, target_value: it.target_value,
            source: 'prefill', display_order: 100 + it.display_order,
          });
          if (kErr) { console.error('seed prefill kpi', kErr); throw new ApiError('DB_ERROR', 'Database error', 500); }
          seeded += 1;
        }
      }
    }
  }

  return seeded;
}
