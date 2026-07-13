import { createClient } from 'npm:@supabase/supabase-js@2.48.1'

type SupabaseAdminClient = any

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

function json(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

function normalizeCode(value: unknown) {
  return String(value || '').trim().toUpperCase()
}

function normalizeStage(value: unknown) {
  const stage = String(value || '').trim().toLowerCase()
  return ['self', 'manager', 'hod', 'final'].includes(stage) ? stage : ''
}

const SUB_PHASE = {
  SELF_EVALUATION: 'self-evaluation',
  MANAGER_EVALUATION: 'manager-evaluation',
} as const

function readCycleWindows(org: Record<string, unknown> | null) {
  if (!org || typeof org !== 'object') return null
  const setup = org.setup_payload && typeof org.setup_payload === 'object'
    ? org.setup_payload as Record<string, unknown>
    : null
  const orgData = setup?.orgData && typeof setup.orgData === 'object'
    ? setup.orgData as Record<string, unknown>
    : null
  const windows = orgData?.cyclePhaseWindows
  return windows && typeof windows === 'object' ? windows as Record<string, unknown> : null
}

function parseDayStart(value: unknown) {
  const text = String(value || '').trim()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null
  const [year, month, day] = text.split('-').map(Number)
  const date = new Date(Date.UTC(year, month - 1, day, 0, 0, 0, 0))
  return Number.isFinite(date.getTime()) ? date : null
}

function parseDayEnd(value: unknown) {
  const text = String(value || '').trim()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null
  const [year, month, day] = text.split('-').map(Number)
  const date = new Date(Date.UTC(year, month - 1, day, 23, 59, 59, 999))
  return Number.isFinite(date.getTime()) ? date : null
}

function isWindowOpen(window: unknown, now = new Date()) {
  if (!window || typeof window !== 'object') return false
  const row = window as Record<string, unknown>
  const start = parseDayStart(row.startsOn)
  const end = parseDayEnd(row.endsOn)
  if (!start || !end || end < start) return false
  return now >= start && now <= end
}

function isSubPhaseOpen(org: Record<string, unknown> | null, subPhase: string) {
  const windows = readCycleWindows(org)
  if (windows) {
    const evaluation = windows.evaluation && typeof windows.evaluation === 'object'
      ? windows.evaluation as Record<string, unknown>
      : {}
    const subPhases = evaluation.subPhases && typeof evaluation.subPhases === 'object'
      ? evaluation.subPhases as Record<string, unknown>
      : {}
    if (subPhase === SUB_PHASE.SELF_EVALUATION) return isWindowOpen(subPhases.selfEvaluation)
    if (subPhase === SUB_PHASE.MANAGER_EVALUATION) return isWindowOpen(subPhases.managerEvaluation)
    return false
  }
  const currentPhase = String(org?.current_phase || '').trim()
  if (subPhase === SUB_PHASE.SELF_EVALUATION) return currentPhase === 'self-evaluation'
  if (subPhase === SUB_PHASE.MANAGER_EVALUATION) return currentPhase === 'manager-evaluation' || currentPhase === 'manager-rating'
  return false
}

function assertHrReviewOpen(org: Record<string, unknown> | null) {
  const currentPhase = String(org?.current_phase || '').trim()
  if (currentPhase === 'hr-review' || currentPhase === 'calibrated') return
  throw new Error('HR review is not open for this cycle.')
}

async function getSessionUser(client: SupabaseAdminClient, token: string) {
  const sessionToken = String(token || '').trim()
  if (!sessionToken) return null
  const { data, error } = await client
    .from('app_state')
    .select('payload')
    .eq('state_key', `server_session:${sessionToken}`)
    .eq('org_key', '')
    .maybeSingle()
  if (error) throw error
  const payload = data?.payload && typeof data.payload === 'object' ? data.payload as Record<string, unknown> : null
  if (!payload) return null
  const expiresAt = Date.parse(String(payload.expiresAt || ''))
  if (!Number.isFinite(expiresAt) || expiresAt < Date.now()) return null
  return payload
}

async function getOrg(client: SupabaseAdminClient, orgKey: string) {
  const { data, error } = await client
    .from('organizations')
    .select('id, org_key, current_phase, setup_payload')
    .eq('org_key', orgKey)
    .maybeSingle()
  if (error) throw error
  return data || null
}

async function getOrgFull(client: SupabaseAdminClient, orgKey: string) {
  const { data, error } = await client
    .from('organizations')
    .select('id, org_key, org_code, name, workspace_slug, domain, industry, hr_admin_name, hr_admin_email, launched, current_phase, status, setup_status, setup_reopened, setup_reopened_at, setup_reopened_by, setup_pct, setup_payload')
    .eq('org_key', orgKey)
    .maybeSingle()
  if (error) throw error
  return data || null
}

async function getEmployee(client: SupabaseAdminClient, organizationId: string, employeeCode: string) {
  const { data, error } = await client
    .from('employees')
    .select('employee_code, employee_name, manager_code, is_in_pms, raw_payload')
    .eq('organization_id', organizationId)
    .eq('employee_code', employeeCode)
    .maybeSingle()
  if (error) throw error
  return data || null
}

async function getWorkflowStatus(client: SupabaseAdminClient, orgKey: string, organizationId: string, employeeCode: string) {
  const { data: row, error } = await client
    .from('goal_workflows')
    .select('status')
    .eq('organization_id', organizationId)
    .eq('employee_code', employeeCode)
    .maybeSingle()
  if (error) throw error
  if (row?.status) return String(row.status || '')

  const { data: blob, error: blobError } = await client
    .from('app_state')
    .select('payload')
    .eq('state_key', 'workflow')
    .eq('org_key', orgKey)
    .maybeSingle()
  if (blobError) throw blobError
  const submissions = (blob?.payload as Record<string, unknown> | null)?.submissions as Record<string, Record<string, unknown>> | undefined
  const entry = submissions?.[employeeCode] || submissions?.[employeeCode.toUpperCase()] || submissions?.[employeeCode.toLowerCase()]
  return String(entry?.status || '')
}

async function getSubmittedStage(client: SupabaseAdminClient, orgKey: string, organizationId: string, employeeCode: string, stage: string) {
  const { data, error } = await client
    .from('employee_ratings')
    .select('submitted_at, payload')
    .eq('organization_id', organizationId)
    .eq('employee_code', employeeCode)
    .eq('stage', stage)
    .maybeSingle()
  if (error) throw error
  if (data?.submitted_at) return data

  const { data: blob, error: blobError } = await client
    .from('app_state')
    .select('payload')
    .eq('state_key', 'ratings')
    .eq('org_key', orgKey)
    .maybeSingle()
  if (blobError) throw blobError
  const ratings = (blob?.payload as Record<string, unknown> | null)?.ratings as Record<string, Record<string, Record<string, unknown>>> | undefined
  const stagePayload = ratings?.[employeeCode]?.[stage]
  return stagePayload?.submittedAt ? { submitted_at: stagePayload.submittedAt, payload: stagePayload } : null
}

function isHrActor(user: Record<string, unknown>) {
  const role = String(user.role || '')
  return role === 'hr-admin' || role === 'super-admin'
}

function assertOrgScope(user: Record<string, unknown>, orgKey: string) {
  if (String(user.role || '') === 'super-admin') return
  if (String(user.orgKey || '') !== orgKey) {
    throw new Error('You are not signed in to this organization.')
  }
}

function requireSuperAdmin(user: Record<string, unknown>) {
  if (String(user.role || '') !== 'super-admin') {
    throw new Error('Only Super Admin can manage organizations.')
  }
}

async function assertCanSubmitRating(
  client: SupabaseAdminClient,
  user: Record<string, unknown>,
  orgKey: string,
  organizationId: string,
  employee: Record<string, unknown>,
  stage: string,
) {
  const employeeCode = normalizeCode(employee.employee_code)
  const actorCode = normalizeCode(user.empCode)
  const actorIsHr = isHrActor(user)

  if (stage === 'self') {
    if (!actorIsHr && actorCode !== employeeCode) {
      throw new Error('Employees can only submit their own self-evaluation.')
    }
    if (!actorIsHr && !isSubPhaseOpen(await getOrg(client, orgKey), SUB_PHASE.SELF_EVALUATION)) {
      throw new Error('Self-evaluation is not open in the cycle calendar.')
    }
    const status = await getWorkflowStatus(client, orgKey, organizationId, employeeCode)
    if (!actorIsHr && status !== 'approved') {
      throw new Error('Self-evaluation opens after goals are approved.')
    }
    return
  }

  if (stage === 'manager') {
    const managerCode = normalizeCode(employee.manager_code)
    if (!actorIsHr && (!actorCode || actorCode !== managerCode)) {
      throw new Error('Only the reporting manager can submit this manager evaluation.')
    }
    if (!actorIsHr && !isSubPhaseOpen(await getOrg(client, orgKey), SUB_PHASE.MANAGER_EVALUATION)) {
      throw new Error('Manager evaluation is not open in the cycle calendar.')
    }
    const self = await getSubmittedStage(client, orgKey, organizationId, employeeCode, 'self')
    if (!self?.submitted_at) {
      throw new Error('Manager evaluation opens after self-evaluation is submitted.')
    }
    return
  }

  if (stage === 'hod') {
    const payload = employee.raw_payload && typeof employee.raw_payload === 'object'
      ? employee.raw_payload as Record<string, unknown>
      : {}
    const hodCode = normalizeCode(payload['HOD Code'] || payload.hodCode || payload.hod_code)
    if (!actorIsHr && (!actorCode || actorCode !== hodCode)) {
      throw new Error('Only the mapped HOD can submit this HOD calibration.')
    }
    assertHrReviewOpen(await getOrg(client, orgKey))
    const manager = await getSubmittedStage(client, orgKey, organizationId, employeeCode, 'manager')
    if (!manager?.submitted_at) {
      throw new Error('HOD calibration opens after manager evaluation is submitted.')
    }
    return
  }

  if (stage === 'final') {
    if (!actorIsHr) throw new Error('Only HR can submit final calibration.')
    assertHrReviewOpen(await getOrg(client, orgKey))
    const manager = await getSubmittedStage(client, orgKey, organizationId, employeeCode, 'manager')
    if (!manager?.submitted_at) {
      throw new Error('Final calibration opens after manager evaluation is submitted.')
    }
  }
}

function normalizeLower(value: unknown) {
  return String(value || '').trim().toLowerCase()
}

function getDomainFromSlug(slug: unknown) {
  const normalized = normalizeLower(slug)
  return normalized ? 'pms.zarohr.com' : ''
}

function buildOrganizationRow(org: Record<string, unknown>) {
  const workspaceSlug = normalizeLower(org.workspaceSlug)
  const domain = normalizeLower(org.domain) || getDomainFromSlug(workspaceSlug)
  const storedDomain = domain && domain !== 'pms.zarohr.com' ? domain : null
  const launched = Boolean(org.launched)
  const setupStatus = String(org.setupStatus || (launched ? 'launched' : 'in_progress')).trim() || 'in_progress'
  const setupFormSnapshot = org.setupFormSnapshot && typeof org.setupFormSnapshot === 'object'
    ? org.setupFormSnapshot as Record<string, unknown>
    : {}
  return {
    org_key: String(org.key || '').trim(),
    org_code: String(org.orgCode || org.key || '').trim() || null,
    name: String(org.name || '').trim() || 'Organization',
    workspace_slug: workspaceSlug || null,
    domain: storedDomain,
    industry: String(org.industry || '').trim() || null,
    hr_admin_name: String(org.hrAdminName || '').trim() || null,
    hr_admin_email: normalizeLower(org.hrAdminEmail) || null,
    launched,
    current_phase: String(org.currentPhase || 'goal-setting').trim() || 'goal-setting',
    status: String(org.status || '').trim() || null,
    setup_status: setupStatus,
    setup_reopened: Boolean(org.setupReopened),
    setup_reopened_at: org.setupReopenedAt || null,
    setup_reopened_by: org.setupReopenedBy || null,
    setup_pct: Number(org.setupPct) || 0,
    setup_payload: {
      orgData: org,
      setupFormSnapshot,
    },
    updated_at: new Date().toISOString(),
  }
}

function mapOrganizationRow(row: Record<string, unknown>) {
  const payload = row?.setup_payload && typeof row.setup_payload === 'object'
    ? row.setup_payload as Record<string, unknown>
    : {}
  const cachedOrg = payload.orgData && typeof payload.orgData === 'object'
    ? payload.orgData as Record<string, unknown>
    : {}
  const workspaceSlug = normalizeLower(row.workspace_slug || cachedOrg.workspaceSlug)
  return {
    ...cachedOrg,
    key: String(row.org_key || cachedOrg.key || '').trim(),
    orgCode: String(row.org_code || cachedOrg.orgCode || row.org_key || '').trim(),
    name: String(row.name || cachedOrg.name || 'Organization').trim(),
    workspaceSlug,
    domain: normalizeLower(row.domain || cachedOrg.domain || getDomainFromSlug(workspaceSlug)),
    industry: row.industry ?? cachedOrg.industry ?? '',
    hrAdminName: row.hr_admin_name ?? cachedOrg.hrAdminName ?? '',
    hrAdminEmail: row.hr_admin_email ?? cachedOrg.hrAdminEmail ?? '',
    launched: row.launched ?? cachedOrg.launched ?? false,
    currentPhase: row.current_phase ?? cachedOrg.currentPhase ?? 'goal-setting',
    status: row.status ?? cachedOrg.status ?? '',
    setupStatus: row.setup_status ?? cachedOrg.setupStatus ?? ((row.launched ?? cachedOrg.launched) ? 'launched' : 'in_progress'),
    setupReopened: row.setup_reopened ?? cachedOrg.setupReopened ?? false,
    setupReopenedAt: row.setup_reopened_at ?? cachedOrg.setupReopenedAt ?? null,
    setupReopenedBy: row.setup_reopened_by ?? cachedOrg.setupReopenedBy ?? null,
    setupPct: Number(row.setup_pct ?? cachedOrg.setupPct ?? 0) || 0,
    setupFormSnapshot: cachedOrg.setupFormSnapshot || payload.setupFormSnapshot || {},
  }
}

async function saveOrganization(client: SupabaseAdminClient, body: Record<string, unknown>, user: Record<string, unknown>) {
  const inputOrg = body.org && typeof body.org === 'object' ? body.org as Record<string, unknown> : null
  const orgKey = String(body.orgKey || inputOrg?.key || '').trim()
  if (!inputOrg || !orgKey) throw new Error('Organization payload is required.')
  const role = String(user.role || '')
  const existing = await getOrgFull(client, orgKey)

  if (role === 'super-admin') {
    const row = buildOrganizationRow({ ...inputOrg, key: orgKey })
    const { data, error } = await client
      .from('organizations')
      .upsert(row, { onConflict: 'org_key' })
      .select('id, org_key, org_code, name, workspace_slug, domain, industry, hr_admin_name, hr_admin_email, launched, current_phase, status, setup_status, setup_reopened, setup_reopened_at, setup_reopened_by, setup_pct, setup_payload')
      .maybeSingle()
    if (error) throw error
    await client.from('app_audit_logs').insert({
      org_key: orgKey,
      actor_role: role,
      actor_code: String(user.empCode || ''),
      actor_name: String(user.userName || 'Super Admin'),
      action_type: existing ? 'organization-updated' : 'organization-created',
      target_type: 'organization',
      target_code: orgKey,
      details: { orgKey, name: row.name, workspaceSlug: row.workspace_slug },
    })
    return { ok: true, org: data ? mapOrganizationRow(data) : { ...inputOrg, key: orgKey } }
  }

  assertOrgScope(user, orgKey)
  if (role !== 'hr-admin') throw new Error('This session cannot update organization settings.')
  if (!existing) throw new Error('Organization not found.')
  const existingPayload = existing.setup_payload && typeof existing.setup_payload === 'object'
    ? { ...existing.setup_payload as Record<string, unknown> }
    : {}
  const existingOrgData = existingPayload.orgData && typeof existingPayload.orgData === 'object'
    ? { ...existingPayload.orgData as Record<string, unknown> }
    : {}
  const nextOrgData = {
    ...existingOrgData,
    cyclePhaseWindows: inputOrg.cyclePhaseWindows ?? existingOrgData.cyclePhaseWindows ?? null,
    cyclePhaseWindowsLastEditedAt: inputOrg.cyclePhaseWindowsLastEditedAt || new Date().toISOString(),
    cyclePhaseWindowsLastEditedBy: inputOrg.cyclePhaseWindowsLastEditedBy || user.userName || 'HR admin',
  }
  existingPayload.orgData = nextOrgData
  const { data, error } = await client
    .from('organizations')
    .update({
      setup_payload: existingPayload,
      updated_at: new Date().toISOString(),
    })
    .eq('org_key', orgKey)
    .select('id, org_key, org_code, name, workspace_slug, domain, industry, hr_admin_name, hr_admin_email, launched, current_phase, status, setup_status, setup_reopened, setup_reopened_at, setup_reopened_by, setup_pct, setup_payload')
    .maybeSingle()
  if (error) throw error
  await client.from('app_audit_logs').insert({
    org_key: orgKey,
    actor_role: role,
    actor_code: String(user.empCode || ''),
    actor_name: String(user.userName || 'HR Admin'),
    action_type: 'organization-calendar-updated',
    target_type: 'organization',
    target_code: orgKey,
    details: {
      cyclePhaseWindowsLastEditedAt: nextOrgData.cyclePhaseWindowsLastEditedAt,
      cyclePhaseWindowsLastEditedBy: nextOrgData.cyclePhaseWindowsLastEditedBy,
    },
  })
  return { ok: true, org: data ? mapOrganizationRow(data) : { ...nextOrgData, key: orgKey } }
}

async function submitRating(client: SupabaseAdminClient, body: Record<string, unknown>, user: Record<string, unknown>) {
  const orgKey = String(body.orgKey || '').trim()
  const employeeCode = normalizeCode(body.empCode)
  const stage = normalizeStage(body.stage)
  const payload = body.payload && typeof body.payload === 'object' ? body.payload as Record<string, unknown> : {}
  const actor = String(body.actor || user.userName || user.empCode || user.role || '').trim()

  if (!orgKey || !employeeCode || !stage) throw new Error('Missing organization, employee, or stage.')
  assertOrgScope(user, orgKey)
  const org = await getOrg(client, orgKey)
  if (!org?.id) throw new Error('Organization not found.')
  const organizationId = String(org.id || '')
  const employee = await getEmployee(client, organizationId, employeeCode)
  if (!employee || employee.is_in_pms === false) throw new Error('Employee is not active in PMS.')
  await assertCanSubmitRating(client, user, orgKey, organizationId, employee, stage)

  const submittedAt = new Date().toISOString()
  const stamped = {
    ...payload,
    submittedAt,
    updatedAt: submittedAt,
    submittedBy: actor,
  }

  const { error } = await client
    .from('employee_ratings')
    .upsert({
      organization_id: organizationId,
      employee_code: employeeCode,
      stage,
      payload: stamped,
      submitted_at: submittedAt,
      submitted_by: actor,
      updated_at: submittedAt,
    }, { onConflict: 'organization_id,employee_code,stage' })
  if (error) throw error

  await client.from('app_audit_logs').insert({
    org_key: orgKey,
    actor_role: String(user.role || ''),
    actor_code: String(user.empCode || ''),
    actor_name: String(user.userName || actor || ''),
    action_type: `submit-${stage}`,
    target_type: 'employee',
    target_code: employeeCode,
    details: { stage, submittedAt, actor },
  })

  return { ok: true, stage: stamped }
}

async function clearRating(client: SupabaseAdminClient, body: Record<string, unknown>, user: Record<string, unknown>) {
  const orgKey = String(body.orgKey || '').trim()
  const employeeCode = normalizeCode(body.empCode)
  const stage = normalizeStage(body.stage)
  const actor = String(body.actor || user.userName || user.empCode || user.role || '').trim()

  if (!orgKey || !employeeCode || !stage) throw new Error('Missing organization, employee, or stage.')
  assertOrgScope(user, orgKey)
  if (!isHrActor(user)) throw new Error('Only HR can clear rating stages.')
  const org = await getOrg(client, orgKey)
  if (!org?.id) throw new Error('Organization not found.')
  const organizationId = String(org.id || '')
  const employee = await getEmployee(client, organizationId, employeeCode)
  if (!employee || employee.is_in_pms === false) throw new Error('Employee is not active in PMS.')

  const { data: existingRow, error: readError } = await client
    .from('employee_ratings')
    .select('payload')
    .eq('organization_id', organizationId)
    .eq('employee_code', employeeCode)
    .eq('stage', stage)
    .maybeSingle()
  if (readError) throw readError

  const clearedAt = new Date().toISOString()
  const existingPayload = existingRow?.payload && typeof existingRow.payload === 'object'
    ? existingRow.payload as Record<string, unknown>
    : {}
  const cleared = {
    ...existingPayload,
    submittedAt: null,
    submittedBy: null,
    calibratedScore: undefined,
    calibrationNote: '',
    calibratedBy: '',
    calibratedAt: null,
    updatedAt: clearedAt,
    clearedAt,
    clearedBy: actor,
  }

  const { error } = await client
    .from('employee_ratings')
    .upsert({
      organization_id: organizationId,
      employee_code: employeeCode,
      stage,
      payload: cleared,
      submitted_at: null,
      submitted_by: null,
      updated_at: clearedAt,
    }, { onConflict: 'organization_id,employee_code,stage' })
  if (error) throw error

  await client.from('app_audit_logs').insert({
    org_key: orgKey,
    actor_role: String(user.role || ''),
    actor_code: String(user.empCode || ''),
    actor_name: String(user.userName || actor || ''),
    action_type: `clear-${stage}`,
    target_type: 'employee',
    target_code: employeeCode,
    details: { stage, clearedAt, actor },
  })

  return { ok: true, stage: cleared }
}

async function readRatingsBlob(client: SupabaseAdminClient, orgKey: string) {
  const { data, error } = await client
    .from('app_state')
    .select('payload')
    .eq('state_key', 'ratings')
    .eq('org_key', orgKey)
    .maybeSingle()
  if (error) throw error
  return data?.payload && typeof data.payload === 'object'
    ? data.payload as Record<string, unknown>
    : { ratings: {}, auditLog: [], publishedAt: null }
}

async function writeRatingsBlob(client: SupabaseAdminClient, orgKey: string, payload: Record<string, unknown>) {
  const { error } = await client
    .from('app_state')
    .upsert({
      state_key: 'ratings',
      org_key: orgKey,
      payload,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'state_key,org_key' })
  if (error) throw error
  return payload
}

function stageRowsToRatings(rows: Record<string, unknown>[] = []) {
  const ratings: Record<string, Record<string, unknown>> = {}
  for (const row of rows) {
    const employeeCode = normalizeCode(row.employee_code)
    const stage = normalizeStage(row.stage)
    if (!employeeCode || !stage) continue
    const payload = row.payload && typeof row.payload === 'object'
      ? row.payload as Record<string, unknown>
      : {}
    ratings[employeeCode] = {
      ...(ratings[employeeCode] || {}),
      [stage]: {
        ...payload,
        submittedAt: payload.submittedAt || row.submitted_at || null,
        submittedBy: payload.submittedBy || row.submitted_by || '',
        updatedAt: payload.updatedAt || row.updated_at || row.submitted_at || null,
      },
    }
  }
  return ratings
}

function ackRowToPayload(row: Record<string, unknown> | null | undefined) {
  if (!row) return null
  return {
    decision: String(row.decision || ''),
    reason: String(row.reason || ''),
    submittedAt: row.submitted_at || '',
    submittedBy: row.submitted_by || '',
    resolution: row.resolution || undefined,
    round: Number(row.round) || 1,
    updatedAt: row.updated_at || row.submitted_at || '',
  }
}

function auditRowsToLegacy(rows: Record<string, unknown>[] = []) {
  return rows.map((row) => {
    const details = row.details && typeof row.details === 'object'
      ? row.details as Record<string, unknown>
      : {}
    return {
      ts: row.created_at || details.at || '',
      action: row.action_type || '',
      actor: row.actor_name || row.actor_code || '',
      empCode: row.target_type === 'employee' ? row.target_code || '' : details.empCode || '',
      before: details.before,
      after: details.after,
      reason: details.reason || details.message || '',
    }
  })
}

async function readRatingsRowsState(client: SupabaseAdminClient, orgKey: string, organizationId: string) {
  const [
    ratingsResult,
    publicationResult,
    acknowledgementsResult,
    auditResult,
  ] = await Promise.all([
    client
      .from('employee_ratings')
      .select('employee_code, stage, payload, submitted_at, submitted_by, updated_at')
      .eq('organization_id', organizationId),
    client
      .from('rating_publications')
      .select('published_at, published_by, publish_reason, unpublished_at, unpublished_by, updated_at')
      .eq('organization_id', organizationId)
      .maybeSingle(),
    client
      .from('rating_acknowledgements')
      .select('employee_code, decision, reason, submitted_at, submitted_by, resolution, round, updated_at')
      .eq('organization_id', organizationId),
    client
      .from('app_audit_logs')
      .select('created_at, action_type, actor_code, actor_name, target_type, target_code, details')
      .eq('org_key', orgKey)
      .order('created_at', { ascending: true })
      .limit(1000),
  ])
  if (ratingsResult.error) throw ratingsResult.error
  if (publicationResult.error) throw publicationResult.error
  if (acknowledgementsResult.error) throw acknowledgementsResult.error
  if (auditResult.error) throw auditResult.error

  const ratings = stageRowsToRatings(ratingsResult.data || [])
  for (const row of acknowledgementsResult.data || []) {
    const employeeCode = normalizeCode(row.employee_code)
    if (!employeeCode) continue
    ratings[employeeCode] = {
      ...(ratings[employeeCode] || {}),
      acceptance: ackRowToPayload(row),
    }
  }

  const publication = publicationResult.data || {}
  return {
    ratings,
    auditLog: auditRowsToLegacy(auditResult.data || []),
    publishedAt: publication.published_at || null,
    publishedBy: publication.published_by || '',
    publishReason: publication.publish_reason || '',
    unpublishedAt: publication.unpublished_at || null,
    unpublishedBy: publication.unpublished_by || '',
    updatedAt: publication.updated_at || null,
  }
}

function mergeRowsWithLegacy(rowsState: Record<string, unknown>, legacyState: Record<string, unknown>) {
  const legacyRatings = legacyState.ratings && typeof legacyState.ratings === 'object'
    ? legacyState.ratings as Record<string, Record<string, unknown>>
    : {}
  const rowRatings = rowsState.ratings && typeof rowsState.ratings === 'object'
    ? rowsState.ratings as Record<string, Record<string, unknown>>
    : {}
  const ratings: Record<string, Record<string, unknown>> = { ...legacyRatings }
  for (const [code, stages] of Object.entries(rowRatings)) {
    ratings[code] = { ...(ratings[code] || {}), ...(stages || {}) }
  }
  return {
    ...legacyState,
    ...rowsState,
    ratings,
    auditLog: Array.isArray(rowsState.auditLog) && (rowsState.auditLog as unknown[]).length
      ? rowsState.auditLog
      : (Array.isArray(legacyState.auditLog) ? legacyState.auditLog : []),
    publishedAt: rowsState.publishedAt || legacyState.publishedAt || null,
    publishedBy: rowsState.publishedBy || legacyState.publishedBy || '',
    publishReason: rowsState.publishReason || legacyState.publishReason || '',
    unpublishedAt: rowsState.unpublishedAt || legacyState.unpublishedAt || null,
    unpublishedBy: rowsState.unpublishedBy || legacyState.unpublishedBy || '',
  }
}

async function readRatingsState(client: SupabaseAdminClient, orgKey: string, organizationId: string) {
  const [rowsState, legacyState] = await Promise.all([
    readRatingsRowsState(client, orgKey, organizationId),
    readRatingsBlob(client, orgKey),
  ])
  return mergeRowsWithLegacy(rowsState, legacyState)
}

async function filterRatingsForUser(
  client: SupabaseAdminClient,
  organizationId: string,
  state: Record<string, unknown>,
  user: Record<string, unknown>,
) {
  if (isHrActor(user)) return state
  const actorCode = normalizeCode(user.empCode)
  if (!actorCode) return { ...state, ratings: {}, auditLog: [] }

  const { data, error } = await client
    .from('employees')
    .select('employee_code, manager_code, raw_payload')
    .eq('organization_id', organizationId)
    .eq('is_in_pms', true)
  if (error) throw error

  const allowed = new Set<string>([actorCode])
  for (const row of data || []) {
    const managerCode = normalizeCode(row.manager_code)
    const payload = row.raw_payload && typeof row.raw_payload === 'object'
      ? row.raw_payload as Record<string, unknown>
      : {}
    const hodCode = normalizeCode(payload['HOD Code'] || payload.hodCode || payload.hod_code)
    if (managerCode === actorCode || hodCode === actorCode) allowed.add(normalizeCode(row.employee_code))
  }

  const ratings = state.ratings && typeof state.ratings === 'object'
    ? state.ratings as Record<string, unknown>
    : {}
  const scopedRatings: Record<string, unknown> = {}
  for (const [code, stages] of Object.entries(ratings)) {
    if (allowed.has(normalizeCode(code))) scopedRatings[code] = stages
  }
  const auditLog = Array.isArray(state.auditLog)
    ? (state.auditLog as Record<string, unknown>[]).filter((row) => allowed.has(normalizeCode(row.empCode)))
    : []
  return { ...state, ratings: scopedRatings, auditLog }
}

async function readRatingsAction(client: SupabaseAdminClient, body: Record<string, unknown>, user: Record<string, unknown>) {
  const orgKey = String(body.orgKey || '').trim()
  if (!orgKey) throw new Error('Organization is required.')
  assertOrgScope(user, orgKey)
  const org = await getOrg(client, orgKey)
  if (!org?.id) throw new Error('Organization not found.')
  const ratings = await readRatingsState(client, orgKey, String(org.id))
  const scoped = await filterRatingsForUser(client, String(org.id), ratings, user)
  return { ok: true, ratings: scoped }
}

async function publishCycleAction(client: SupabaseAdminClient, body: Record<string, unknown>, user: Record<string, unknown>, revoke = false) {
  const orgKey = String(body.orgKey || '').trim()
  const reason = String(body.reason || '').trim()
  const actor = String(body.actor || user.userName || user.empCode || user.role || '').trim()
  if (!orgKey) throw new Error('Organization is required.')
  assertOrgScope(user, orgKey)
  if (!isHrActor(user)) throw new Error('Only HR can publish or revoke cycle results.')
  const org = await getOrg(client, orgKey)
  if (!org?.id) throw new Error('Organization not found.')
  if (!revoke) assertHrReviewOpen(org)

  const organizationId = String(org.id)
  const current = await readRatingsState(client, orgKey, organizationId)
  const publishedAt = Date.parse(String(current.publishedAt || '')) || 0
  const unpublishedAt = Date.parse(String(current.unpublishedAt || '')) || 0
  if (revoke && publishedAt <= unpublishedAt) {
    throw new Error('This cycle is not currently published.')
  }
  const auditLog = Array.isArray(current.auditLog) ? current.auditLog as Record<string, unknown>[] : []
  const ts = new Date().toISOString()
  const publicationRow = revoke
    ? {
        organization_id: organizationId,
        published_at: null,
        published_by: '',
        publish_reason: '',
        unpublished_at: ts,
        unpublished_by: actor,
        updated_at: ts,
      }
    : {
        organization_id: organizationId,
        published_at: ts,
        published_by: actor,
        publish_reason: reason,
        unpublished_at: null,
        unpublished_by: '',
        updated_at: ts,
      }
  const { error: publicationError } = await client
    .from('rating_publications')
    .upsert(publicationRow, { onConflict: 'organization_id' })
  if (publicationError) throw publicationError

  await client.from('app_audit_logs').insert({
    org_key: orgKey,
    actor_role: String(user.role || ''),
    actor_code: String(user.empCode || ''),
    actor_name: String(user.userName || actor || ''),
    action_type: revoke ? 'revoke-publish' : 'publish',
    target_type: 'cycle',
    target_code: orgKey,
    details: { reason, at: ts },
  })
  const next = await readRatingsState(client, orgKey, organizationId)
  next.auditLog = [...auditLog, { ts, action: revoke ? 'revoke-publish' : 'publish', actor, reason: revoke ? (reason || 'Testing revoke publish') : reason }]
  return { ok: true, ratings: next, publishedAt: next.publishedAt || null, unpublishedAt: next.unpublishedAt || null }
}

async function recordFinalAcceptanceAction(client: SupabaseAdminClient, body: Record<string, unknown>, user: Record<string, unknown>) {
  const orgKey = String(body.orgKey || '').trim()
  const employeeCode = normalizeCode(body.empCode)
  const normalizedDecision = String(body.decision || '') === 'rejected' ? 'rejected' : 'accepted'
  const reason = String(body.reason || '').trim()
  const actor = String(body.actor || user.userName || user.empCode || user.role || '').trim()
  if (!orgKey || !employeeCode) throw new Error('Missing organization or employee.')
  assertOrgScope(user, orgKey)
  const org = await getOrg(client, orgKey)
  if (!org?.id) throw new Error('Organization not found.')
  const employee = await getEmployee(client, String(org.id), employeeCode)
  if (!employee || employee.is_in_pms === false) throw new Error('Employee is not active in PMS.')
  if (!isHrActor(user) && normalizeCode(user.empCode) !== employeeCode) {
    throw new Error('Employees can only acknowledge their own final rating.')
  }

  const organizationId = String(org.id)
  const current = await readRatingsState(client, orgKey, organizationId)
  const publishedAt = Date.parse(String(current.publishedAt || '')) || 0
  const unpublishedAt = Date.parse(String(current.unpublishedAt || '')) || 0
  if (publishedAt <= unpublishedAt) throw new Error('Final ratings are not published yet.')

  const ts = new Date().toISOString()
  const acceptance = {
    decision: normalizedDecision,
    reason: normalizedDecision === 'rejected' ? reason : '',
    submittedAt: ts,
    submittedBy: actor || employeeCode,
    updatedAt: ts,
  }
  const { error: ackError } = await client
    .from('rating_acknowledgements')
    .upsert({
      organization_id: organizationId,
      employee_code: employeeCode,
      decision: normalizedDecision,
      reason: acceptance.reason,
      submitted_at: ts,
      submitted_by: actor || employeeCode,
      resolution: null,
      round: 1,
      updated_at: ts,
    }, { onConflict: 'organization_id,employee_code' })
  if (ackError) throw ackError
  await client.from('app_audit_logs').insert({
    org_key: orgKey,
    actor_role: String(user.role || ''),
    actor_code: String(user.empCode || ''),
    actor_name: String(user.userName || actor || ''),
    action_type: `final-${normalizedDecision}`,
    target_type: 'employee',
    target_code: employeeCode,
    details: { reason: acceptance.reason, at: ts },
  })
  const next = await readRatingsState(client, orgKey, organizationId)
  return { ok: true, acceptance, ratings: next }
}

async function resolveConcernAction(client: SupabaseAdminClient, body: Record<string, unknown>, user: Record<string, unknown>) {
  const orgKey = String(body.orgKey || '').trim()
  const employeeCode = normalizeCode(body.empCode)
  const type = String(body.type || '') === 'recalibrated' ? 'recalibrated' : 'explained'
  const message = String(body.message || '').trim()
  const actor = String(body.actor || user.userName || user.empCode || user.role || '').trim()
  if (!orgKey || !employeeCode) throw new Error('Missing organization or employee.')
  assertOrgScope(user, orgKey)
  if (!isHrActor(user)) throw new Error('Only HR can resolve employee concerns.')
  const org = await getOrg(client, orgKey)
  if (!org?.id) throw new Error('Organization not found.')
  assertHrReviewOpen(org)
  const employee = await getEmployee(client, String(org.id), employeeCode)
  if (!employee || employee.is_in_pms === false) throw new Error('Employee is not active in PMS.')

  const organizationId = String(org.id)
  const { data: ackRow, error: ackReadError } = await client
    .from('rating_acknowledgements')
    .select('employee_code, decision, reason, submitted_at, submitted_by, resolution, round, updated_at')
    .eq('organization_id', organizationId)
    .eq('employee_code', employeeCode)
    .maybeSingle()
  if (ackReadError) throw ackReadError
  const current = await readRatingsState(client, orgKey, organizationId)
  const stages = (current.ratings && typeof current.ratings === 'object'
    ? (current.ratings as Record<string, Record<string, unknown>>)[employeeCode]
    : {}) || {}
  const prev = ackRow ? ackRowToPayload(ackRow) as Record<string, unknown> : (
    stages.acceptance && typeof stages.acceptance === 'object'
      ? stages.acceptance as Record<string, unknown>
      : {}
  )
  if (prev.decision !== 'rejected') throw new Error('This employee has not raised an open concern.')

  const ts = new Date().toISOString()
  const resolution = { type, message, at: ts, by: actor || '' }
  const acceptance = type === 'recalibrated'
    ? {
        decision: '',
        reason: '',
        submittedAt: '',
        submittedBy: '',
        resolution,
        round: (Number(prev.round) || 1) + 1,
        updatedAt: ts,
      }
    : {
        ...prev,
        resolution,
        updatedAt: ts,
      }
  const { error: ackWriteError } = await client
    .from('rating_acknowledgements')
    .upsert({
      organization_id: organizationId,
      employee_code: employeeCode,
      decision: String(acceptance.decision || ''),
      reason: String(acceptance.reason || ''),
      submitted_at: acceptance.submittedAt || null,
      submitted_by: acceptance.submittedBy || '',
      resolution,
      round: Number(acceptance.round) || Number(prev.round) || 1,
      updated_at: ts,
    }, { onConflict: 'organization_id,employee_code' })
  if (ackWriteError) throw ackWriteError
  await client.from('app_audit_logs').insert({
    org_key: orgKey,
    actor_role: String(user.role || ''),
    actor_code: String(user.empCode || ''),
    actor_name: String(user.userName || actor || ''),
    action_type: `concern-${type}`,
    target_type: 'employee',
    target_code: employeeCode,
    details: { message, at: ts },
  })
  const next = await readRatingsState(client, orgKey, organizationId)
  return { ok: true, acceptance, ratings: next }
}

function workflowTimestamp(value: Record<string, unknown> | null | undefined) {
  if (!value || typeof value !== 'object') return 0
  const candidates = [
    value.updatedAt,
    value.managerDecisionAt,
    value.approvedAt,
    value.submittedAt,
    value.createdAt,
  ]
  return candidates.reduce<number>((latest, stamp) => {
    const parsed = Date.parse(String(stamp || ''))
    return Number.isFinite(parsed) ? Math.max(latest, parsed) : latest
  }, 0)
}

function mergeWorkflowPayload(remote: Record<string, unknown> | null, local: Record<string, unknown>) {
  const remoteObj = remote && typeof remote === 'object' ? remote : {}
  const localObj = local && typeof local === 'object' ? local : {}
  const remoteSubs = (remoteObj.submissions && typeof remoteObj.submissions === 'object')
    ? remoteObj.submissions as Record<string, Record<string, unknown>>
    : {}
  const localSubs: Record<string, Record<string, unknown>> = (localObj.submissions && typeof localObj.submissions === 'object')
    ? localObj.submissions as Record<string, Record<string, unknown>>
    : {}
  const submissions: Record<string, Record<string, unknown>> = { ...remoteSubs }
  Object.entries(localSubs).forEach(([key, submission]) => {
    const current = submissions[key]
    submissions[key] = workflowTimestamp(submission) >= workflowTimestamp(current) ? submission : current
  })

  const notifications = new Map<string, Record<string, unknown>>()
  const allNotifications = [
    ...((remoteObj.notifications && Array.isArray(remoteObj.notifications)) ? remoteObj.notifications as Record<string, unknown>[] : []),
    ...((localObj.notifications && Array.isArray(localObj.notifications)) ? localObj.notifications as Record<string, unknown>[] : []),
  ]
  allNotifications.forEach((notification) => {
    const id = String(notification?.id || '')
    if (!id) return
    const current = notifications.get(id)
    notifications.set(id, current ? { ...current, ...notification, read: Boolean(current.read || notification.read) } : notification)
  })

  return {
    ...remoteObj,
    ...localObj,
    submissions,
    notifications: Array.from(notifications.values()).sort(
      (left, right) => (Date.parse(String(right.createdAt || '')) || 0) - (Date.parse(String(left.createdAt || '')) || 0),
    ),
  }
}

function makeNotification(type: string, fields: Record<string, unknown>) {
  const clientCode = (value: unknown) => String(value || '').trim().toLowerCase()
  return {
    id: `notif_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    type,
    recipientCode: clientCode(fields.recipientCode),
    senderCode: clientCode(fields.senderCode),
    submissionCode: clientCode(fields.submissionCode),
    title: String(fields.title || ''),
    message: String(fields.message || ''),
    read: false,
    createdAt: new Date().toISOString(),
  }
}

function cleanGoalsForResubmit(goals: unknown) {
  return (Array.isArray(goals) ? goals : []).map((goal) => {
    if (!goal || typeof goal !== 'object') return goal
    const row = goal as Record<string, unknown>
    if (row.reviewStatus !== 'rejected') return row
    const { reviewStatus: _reviewStatus, reviewNote: _reviewNote, reviewedAt: _reviewedAt, ...rest } = row
    return rest
  })
}

async function readWorkflowBlob(client: SupabaseAdminClient, orgKey: string) {
  const { data, error } = await client
    .from('app_state')
    .select('payload')
    .eq('state_key', 'workflow')
    .eq('org_key', orgKey)
    .maybeSingle()
  if (error) throw error
  return data?.payload && typeof data.payload === 'object'
    ? data.payload as Record<string, unknown>
    : { submissions: {}, notifications: [] }
}

async function readWorkflowSubmission(
  client: SupabaseAdminClient,
  orgKey: string,
  organizationId: string,
  employeeCode: string,
): Promise<Record<string, unknown> | null> {
  const { data, error } = await client
    .from('goal_workflows')
    .select('payload, status, submitted_at, approved_at, manager_decision_at, manager_note, updated_at')
    .eq('organization_id', organizationId)
    .eq('employee_code', employeeCode)
    .maybeSingle()
  if (error) throw error
  if (data) {
    const payload = data.payload && typeof data.payload === 'object' ? data.payload as Record<string, unknown> : {}
    return {
      ...payload,
      status: String(data.status || payload.status || 'draft'),
      submittedAt: payload.submittedAt || data.submitted_at || null,
      approvedAt: payload.approvedAt || data.approved_at || null,
      managerDecisionAt: payload.managerDecisionAt || data.manager_decision_at || null,
      managerNote: payload.managerNote || data.manager_note || '',
      updatedAt: payload.updatedAt || data.updated_at || data.submitted_at || null,
    }
  }
  const blob = await readWorkflowBlob(client, orgKey)
  const submissions = blob.submissions && typeof blob.submissions === 'object'
    ? blob.submissions as Record<string, Record<string, unknown>>
    : {}
  const direct = submissions[employeeCode] || submissions[employeeCode.toLowerCase()] || submissions[employeeCode.toUpperCase()]
  if (direct && typeof direct === 'object') return direct
  const match = Object.entries(submissions).find(([key]) => normalizeCode(key) === employeeCode)
  return match?.[1] || null
}

async function writeWorkflowSubmission(
  client: SupabaseAdminClient,
  orgKey: string,
  organizationId: string,
  employeeCode: string,
  submission: Record<string, unknown>,
  notifications: Record<string, unknown>[] = [],
) {
  const updatedAt = String(submission.updatedAt || new Date().toISOString())
  const { error: rowError } = await client
    .from('goal_workflows')
    .upsert({
      organization_id: organizationId,
      employee_code: employeeCode,
      status: String(submission.status || 'draft'),
      submitted_at: submission.submittedAt || null,
      approved_at: submission.approvedAt || null,
      manager_decision_at: submission.managerDecisionAt || null,
      manager_note: String(submission.managerNote || ''),
      payload: submission,
      updated_at: updatedAt,
    }, { onConflict: 'organization_id,employee_code' })
  if (rowError) throw rowError

  const remote = await readWorkflowBlob(client, orgKey)
  const clientSubmissionKey = String(employeeCode || '').trim().toLowerCase()
  const next = mergeWorkflowPayload(remote, {
    submissions: { [clientSubmissionKey]: submission },
    notifications: [...notifications, ...((remote.notifications && Array.isArray(remote.notifications)) ? remote.notifications as Record<string, unknown>[] : [])],
  })
  const { error: blobError } = await client
    .from('app_state')
    .upsert({
      state_key: 'workflow',
      org_key: orgKey,
      payload: next,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'state_key,org_key' })
  if (blobError) throw blobError
  return next
}

async function assertGoalActor(
  user: Record<string, unknown>,
  employee: Record<string, unknown>,
  stage: 'employee' | 'manager' | 'hr',
) {
  if (isHrActor(user)) return
  const actorCode = normalizeCode(user.empCode)
  const employeeCode = normalizeCode(employee.employee_code)
  const managerCode = normalizeCode(employee.manager_code)
  if (stage === 'employee' && actorCode === employeeCode) return
  if (stage === 'manager' && actorCode && actorCode === managerCode) return
  throw new Error(stage === 'employee'
    ? 'Employees can only submit their own goals.'
    : 'Only the reporting manager can review these goals.')
}

async function submitGoals(client: SupabaseAdminClient, body: Record<string, unknown>, user: Record<string, unknown>) {
  const orgKey = String(body.orgKey || '').trim()
  const employeeCode = normalizeCode(body.empCode)
  const payload = body.payload && typeof body.payload === 'object' ? body.payload as Record<string, unknown> : {}
  if (!orgKey || !employeeCode) throw new Error('Missing organization or employee.')
  assertOrgScope(user, orgKey)
  const org = await getOrg(client, orgKey)
  if (!org?.id) throw new Error('Organization not found.')
  const organizationId = String(org.id || '')
  const employee = await getEmployee(client, organizationId, employeeCode)
  if (!employee || employee.is_in_pms === false) throw new Error('Employee is not active in PMS.')
  await assertGoalActor(user, employee, 'employee')

  const current = await readWorkflowSubmission(client, orgKey, organizationId, employeeCode)
  const submittedAt = new Date().toISOString()
  const managerCode = normalizeCode(employee.manager_code)
  const priorSubmitCount = Number(current?.submitCount || payload.submitCount || 0)
  const noManager = !managerCode
  const employeeName = String(employee.employee_name || payload.employeeName || employeeCode)
  const submission = {
    ...(current || {}),
    ...payload,
    employeeCode,
    employeeName,
    managerCode,
    goals: cleanGoalsForResubmit(payload.goals || current?.goals || []),
    status: noManager ? 'approved' : 'pending-manager',
    submittedAt,
    submitCount: priorSubmitCount + 1,
    approvedAt: noManager ? submittedAt : null,
    managerDecisionAt: noManager ? submittedAt : null,
    managerApprovedBy: noManager ? 'system' : '',
    managerNote: noManager ? 'No manager assigned. Goals marked approved automatically.' : '',
    updatedAt: submittedAt,
  }
  const notifications = noManager ? [] : [makeNotification(priorSubmitCount > 0 ? 'goal-resubmitted' : 'goal-submitted', {
    recipientCode: managerCode,
    senderCode: employeeCode,
    submissionCode: employeeCode,
    title: priorSubmitCount > 0 ? `${employeeName} resubmitted goals` : `${employeeName} submitted goals`,
    message: priorSubmitCount > 0
      ? `${employeeName} updated their plan after your earlier feedback and sent it back for approval.`
      : `${employeeName} sent a goal plan for your approval.`,
  })]
  const workflow = await writeWorkflowSubmission(client, orgKey, organizationId, employeeCode, submission, notifications)
  return { ok: true, submission, workflow }
}

async function reviewGoals(client: SupabaseAdminClient, body: Record<string, unknown>, user: Record<string, unknown>, reviewStatus: 'approved' | 'sent-back') {
  const orgKey = String(body.orgKey || '').trim()
  const employeeCode = normalizeCode(body.empCode || body.targetEmpCode)
  const reviewedGoals = Array.isArray(body.goals) ? body.goals : null
  const managerNote = String(body.managerNote || '').trim()
  if (!orgKey || !employeeCode) throw new Error('Missing organization or employee.')
  assertOrgScope(user, orgKey)
  const org = await getOrg(client, orgKey)
  if (!org?.id) throw new Error('Organization not found.')
  const organizationId = String(org.id || '')
  const employee = await getEmployee(client, organizationId, employeeCode)
  if (!employee || employee.is_in_pms === false) throw new Error('Employee is not active in PMS.')
  await assertGoalActor(user, employee, 'manager')
  const current = await readWorkflowSubmission(client, orgKey, organizationId, employeeCode)
  if (!current) throw new Error('Goal submission not found.')
  if (!isHrActor(user) && current.status !== 'pending-manager') {
    throw new Error('This goal plan is not awaiting manager approval.')
  }

  const decidedAt = new Date().toISOString()
  const goals = reviewedGoals || current.goals || []
  const employeeName = String(employee.employee_name || current.employeeName || employeeCode)
  const actor = String(user.userName || user.empCode || user.role || '').trim()
  const submission = {
    ...current,
    goals,
    status: reviewStatus,
    managerDecisionAt: decidedAt,
    approvedAt: reviewStatus === 'approved' ? decidedAt : current.approvedAt || null,
    managerApprovedBy: actor,
    managerNote,
    updatedAt: decidedAt,
  }
  const notifications = [makeNotification(reviewStatus === 'approved' ? 'goal-approved' : 'goal-rejected', {
    recipientCode: employeeCode,
    senderCode: normalizeCode(user.empCode),
    submissionCode: employeeCode,
    title: reviewStatus === 'approved' ? 'Goals approved' : 'Goals need updates',
    message: reviewStatus === 'approved'
      ? `${actor || 'Your manager'} approved your goal plan.${managerNote ? ` Note: ${managerNote}` : ''}`
      : `${actor || 'Your manager'} requested changes on your goal plan.${managerNote ? ` Note: ${managerNote}` : ''}`,
  })]
  const workflow = await writeWorkflowSubmission(client, orgKey, organizationId, employeeCode, submission, notifications)
  return { ok: true, submission, workflow }
}

async function reopenGoals(client: SupabaseAdminClient, body: Record<string, unknown>, user: Record<string, unknown>) {
  const orgKey = String(body.orgKey || '').trim()
  const employeeCode = normalizeCode(body.empCode || body.targetEmpCode)
  if (!orgKey || !employeeCode) throw new Error('Missing organization or employee.')
  assertOrgScope(user, orgKey)
  if (!isHrActor(user)) throw new Error('Only HR can reopen goal-setting.')
  const org = await getOrg(client, orgKey)
  if (!org?.id) throw new Error('Organization not found.')
  const organizationId = String(org.id || '')
  const employee = await getEmployee(client, organizationId, employeeCode)
  if (!employee || employee.is_in_pms === false) throw new Error('Employee is not active in PMS.')
  const current = await readWorkflowSubmission(client, orgKey, organizationId, employeeCode)
  if (!current) throw new Error('Goal submission not found.')
  const reopenedAt = new Date().toISOString()
  const submission = {
    ...current,
    status: 'draft',
    managerDecisionAt: null,
    managerNote: '',
    updatedAt: reopenedAt,
  }
  const notifications = [makeNotification('goal-reminder', {
    recipientCode: employeeCode,
    senderCode: normalizeCode(user.empCode),
    submissionCode: employeeCode,
    title: 'Goal-setting reopened',
    message: 'HR has reopened goal-setting for you. Please revisit and resubmit your plan.',
  })]
  const workflow = await writeWorkflowSubmission(client, orgKey, organizationId, employeeCode, submission, notifications)
  return { ok: true, submission, workflow }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return json({ ok: false, error: 'Method not allowed.' }, 405)

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL') || ''
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || ''
    if (!supabaseUrl || !serviceRoleKey) throw new Error('PMS actions backend is not configured.')
    const client = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } })

    const body = await req.json().catch(() => ({})) as Record<string, unknown>
    const token = String(body.serverSessionToken || '').trim()
    const user = await getSessionUser(client, token)
    if (!user) return json({ ok: false, error: 'Sign in again to continue.' }, 401)

    const action = String(body.action || '').trim()
    if (action === 'read-ratings') return json(await readRatingsAction(client, body, user))
    if (action === 'submit-rating') return json(await submitRating(client, body, user))
    if (action === 'clear-rating') return json(await clearRating(client, body, user))
    if (action === 'publish-cycle') return json(await publishCycleAction(client, body, user, false))
    if (action === 'revoke-publish') return json(await publishCycleAction(client, body, user, true))
    if (action === 'record-final-acceptance') return json(await recordFinalAcceptanceAction(client, body, user))
    if (action === 'resolve-concern') return json(await resolveConcernAction(client, body, user))
    if (action === 'save-organization') return json(await saveOrganization(client, body, user))
    if (action === 'submit-goals') return json(await submitGoals(client, body, user))
    if (action === 'approve-goals') return json(await reviewGoals(client, body, user, 'approved'))
    if (action === 'send-back-goals') return json(await reviewGoals(client, body, user, 'sent-back'))
    if (action === 'reopen-goals') return json(await reopenGoals(client, body, user))
    return json({ ok: false, error: 'Unknown action.' }, 400)
  } catch (error) {
    const message = error instanceof Error
      ? error.message
      : (error && typeof error === 'object' && 'message' in error)
        ? String((error as { message?: unknown }).message || 'Action failed.')
        : String(error || 'Action failed.')
    return json({ ok: false, error: message }, 400)
  }
})
