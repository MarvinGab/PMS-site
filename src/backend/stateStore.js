import { shouldUseSupabase, getBackendDiagnostics } from './config';
import { supabase } from './supabaseClient';

const APP_DATA_KEY = 'zarohr_app_data_v1';
const WIZARD_STATE_KEY = 'zarohr_pms_wizard_state_v1';
const GOAL_WORKFLOW_KEY = 'zarohr_goal_workflow_v1';
const MESSAGES_KEY = 'zarohr_messages_v1';
const SESSION_KEY = 'zarohr_auth_session';
const EMP_SESSION_KEY = 'zarohr_emp_session';
const EMP_CREDENTIALS_KEY = 'zarohr_emp_credentials';
const NORMALIZED_SYNC_KEY_PREFIX = 'zarohr_normalized_sync_v1';

const warnedKeys = new Set();
const ORGANIZATION_SELECT = `
  org_key,
  org_code,
  name,
  workspace_slug,
  domain,
  industry,
  hr_admin_name,
  hr_admin_email,
  pms_calendar,
  launched,
  current_phase,
  status,
  setup_pct,
  setup_payload,
  updated_at
`;

function warnOnce(scope, error) {
  const key = `${scope}:${error?.message || 'unknown'}`;
  if (warnedKeys.has(key)) return;
  warnedKeys.add(key);
  console.warn(`[backend:${scope}]`, error);
}

function readLocalJson(key, fallback = null) {
  if (typeof window === 'undefined') return fallback;
  try {
    const raw = window.localStorage.getItem(key) ?? window.sessionStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function readAppDataLocal() {
  return readLocalJson(APP_DATA_KEY, null);
}

function writeOrganizationsToLocalCache(organizations) {
  const current = readAppDataLocal() || {};
  writeLocalJson(APP_DATA_KEY, {
    ...current,
    organizationsData: Array.isArray(organizations) ? organizations : [],
  });
}

function getDomainFromSlug(slug) {
  const normalized = String(slug || '').trim().toLowerCase();
  return normalized ? `${normalized}.zarohr.com` : '';
}

function buildOrganizationRow(org) {
  const workspaceSlug = String(org?.workspaceSlug || '').trim().toLowerCase();
  const domain = String(org?.domain || getDomainFromSlug(workspaceSlug)).trim().toLowerCase();
  return {
    org_key: String(org?.key || '').trim(),
    org_code: String(org?.orgCode || org?.key || '').trim() || null,
    name: String(org?.name || '').trim() || 'Organization',
    workspace_slug: workspaceSlug || null,
    domain: domain || null,
    industry: String(org?.industry || '').trim() || null,
    hr_admin_name: String(org?.hrAdminName || '').trim() || null,
    hr_admin_email: String(org?.hrAdminEmail || '').trim().toLowerCase() || null,
    pms_calendar: String(org?.pmsCalendar || '').trim() || null,
    launched: !!org?.launched,
    current_phase: String(org?.currentPhase || 'goal-setting').trim() || 'goal-setting',
    status: String(org?.status || '').trim() || null,
    setup_pct: Number(org?.setupPct) || 0,
    setup_payload: {
      orgData: org,
      setupFormSnapshot: org?.setupFormSnapshot && typeof org.setupFormSnapshot === 'object'
        ? org.setupFormSnapshot
        : {},
    },
    updated_at: new Date().toISOString(),
  };
}

function normalizeCode(value) {
  return String(value || '').trim();
}

function normalizeLower(value) {
  return String(value || '').trim().toLowerCase();
}

function getNormalizedSyncKey(orgKey = '') {
  return `${NORMALIZED_SYNC_KEY_PREFIX}:${orgKey || 'default'}`;
}

function readNormalizedSyncSignature(orgKey = '') {
  return readLocalJson(getNormalizedSyncKey(orgKey), null);
}

function writeNormalizedSyncSignature(orgKey = '', signature) {
  writeLocalJson(getNormalizedSyncKey(orgKey), signature);
}

function getPrefillSlots(group) {
  const values = Array.isArray(group?.segmentValues)
    ? group.segmentValues.map((value) => String(value || '').trim()).filter(Boolean)
    : [];
  if (values.length === 0) {
    return [{ slotKey: '__default__', label: group?.name || 'All Employees' }];
  }
  return values.map((value) => ({ slotKey: value, label: value }));
}

function getPrefillAssignments(group) {
  const expected = getPrefillSlots(group);
  const existing = Array.isArray(group?.prefillAssignments) ? group.prefillAssignments : [];
  const fallbackData = expected.length === 1 ? (Array.isArray(group?.prefillData) ? group.prefillData : []) : [];
  return expected.map((slot) => {
    const match = existing.find((assignment) => normalizeLower(assignment?.slotKey) === normalizeLower(slot.slotKey));
    return {
      slotKey: slot.slotKey,
      label: slot.label,
      data: Array.isArray(match?.data) ? match.data : fallbackData,
    };
  });
}

function buildGoalLibraryRows(organizationId, config) {
  const rows = [];

  if (config?.goalLibrariesAppliedSnapshot && Array.isArray(config.goalLibraries)) {
    config.goalLibraries.forEach((library, index) => {
      rows.push({
        organization_id: organizationId,
        group_id: null,
        name: String(library?.name || `Library ${index + 1}`).trim(),
        library_type: `goal-library:${String(library?.type || 'unknown').trim() || 'unknown'}`,
        payload: {
          source: 'goalLibraries',
          library,
        },
      });
    });
  }

  if (config?.goalLibraryAppliedSnapshot && config?.goalLibraryData) {
    if (config.goalLibraryData.byAttr) {
      Object.entries(config.goalLibraryData.data || {}).forEach(([groupKey, kras]) => {
        rows.push({
          organization_id: organizationId,
          group_id: String(groupKey || '').trim() || null,
          name: String(groupKey || 'All Employees').trim() || 'All Employees',
          library_type: 'goal-library-data',
          payload: {
            source: 'goalLibraryData',
            attrLabel: config.goalLibraryData.attrLabel || null,
            data: kras || [],
          },
        });
      });
    } else {
      rows.push({
        organization_id: organizationId,
        group_id: null,
        name: 'All Employees',
        library_type: 'goal-library-data',
        payload: {
          source: 'goalLibraryData',
          attrLabel: null,
          data: config.goalLibraryData.data || [],
        },
      });
    }
  }

  if (config?.prefillDataAppliedSnapshot && Array.isArray(config?.goalGroups)) {
    config.goalGroups.forEach((group) => {
      getPrefillAssignments(group)
        .filter((assignment) => Array.isArray(assignment.data) && assignment.data.length > 0)
        .forEach((assignment) => {
          rows.push({
            organization_id: organizationId,
            group_id: String(group?.id || group?.name || '').trim() || null,
            name: `${String(group?.name || 'Group').trim() || 'Group'} / ${String(assignment.label || assignment.slotKey || 'Prefill').trim()}`,
            library_type: 'prefill-data',
            payload: {
              source: 'prefillAssignments',
              group: {
                id: group?.id || null,
                name: group?.name || '',
                segmentAttr: group?.segmentAttr || null,
                segmentValues: Array.isArray(group?.segmentValues) ? group.segmentValues : [],
              },
              assignment,
            },
          });
        });
    });
  }

  return rows.filter((row) => row.name);
}

function buildEmployeeRows(organizationId, config) {
  const employees = Array.isArray(config?.employeeUploadData?.employees)
    ? config.employeeUploadData.employees
    : [];

  return employees
    .map((employee) => {
      const employeeCode = normalizeCode(employee['Employee Code']);
      if (!employeeCode) return null;
      return {
        organization_id: organizationId,
        employee_code: employeeCode,
        employee_name: String(employee['Employee Name'] || employee.name || '').trim() || employeeCode,
        email: String(employee['Email ID'] || employee.Email || employee.email || '').trim().toLowerCase() || null,
        password_hash: null,
        designation: String(employee.Designation || employee.Role || '').trim() || null,
        department: String(employee.Department || '').trim() || null,
        group_name: String(employee.assignedGoalGroupName || employee['Group Name'] || '').trim() || null,
        manager_code: normalizeCode(employee['Reporting Manager Code']) || null,
        manager_name: String(employee['Reporting Manager Name'] || '').trim() || null,
        manager_email: String(employee['Reporting Manager Email'] || '').trim().toLowerCase() || null,
        pms_stage: String(employee._pmsStage || 'goal-creation').trim() || 'goal-creation',
        is_in_pms: employee.isInPMS !== false,
        raw_payload: employee,
      };
    })
    .filter(Boolean);
}

function buildNormalizedWizardSignature(config) {
  return {
    frameworkId: config?.frameworkId || null,
    frameworkAppliedSnapshot: config?.frameworkAppliedSnapshot || null,
    goalLibraryAppliedSnapshot: config?.goalLibraryAppliedSnapshot || null,
    goalLibrariesAppliedSnapshot: config?.goalLibrariesAppliedSnapshot || null,
    prefillDataAppliedSnapshot: config?.prefillDataAppliedSnapshot || null,
    empSettingsAppliedSnapshot: config?.empSettingsAppliedSnapshot || null,
    goalGroupsAppliedSnapshot: config?.goalGroupsAppliedSnapshot || null,
    limitsAppliedSnapshot: config?.limitsAppliedSnapshot || null,
    goalLibraryData: config?.goalLibraryAppliedSnapshot ? config?.goalLibraryData || null : null,
    goalLibraries: config?.goalLibrariesAppliedSnapshot ? config?.goalLibraries || [] : [],
    goalGroups: (config?.prefillDataAppliedSnapshot || config?.goalGroupsAppliedSnapshot)
      ? config?.goalGroups || []
      : [],
    employeeUploadData: config?.employeeUploadData || null,
  };
}

async function resolveOrganizationIdentity(orgKey = '') {
  if (!shouldUseSupabase || !supabase || !orgKey) return null;
  try {
    const { data, error } = await supabase
      .from('organizations')
      .select('id, org_key')
      .eq('org_key', orgKey)
      .maybeSingle();
    if (error) throw error;
    return data?.id ? data : null;
  } catch (error) {
    warnOnce(`remote-read:organization-identity:${orgKey}`, error);
    return null;
  }
}

async function replaceGoalLibraries(organizationId, config) {
  if (!shouldUseSupabase || !supabase || !organizationId) return true;
  const rows = buildGoalLibraryRows(organizationId, config);
  try {
    const { error: deleteError } = await supabase
      .from('goal_libraries')
      .delete()
      .eq('organization_id', organizationId);
    if (deleteError) throw deleteError;
    if (rows.length === 0) return true;
    const { error: insertError } = await supabase
      .from('goal_libraries')
      .insert(rows);
    if (insertError) throw insertError;
    return true;
  } catch (error) {
    warnOnce(`remote-write:goal_libraries:${organizationId}`, error);
    return false;
  }
}

async function replaceEmployees(organizationId, config) {
  if (!shouldUseSupabase || !supabase || !organizationId) return true;
  const rows = buildEmployeeRows(organizationId, config);
  if (!config?.employeeUploadData) return true;
  try {
    const { error: deleteError } = await supabase
      .from('employees')
      .delete()
      .eq('organization_id', organizationId);
    if (deleteError) throw deleteError;
    if (rows.length === 0) return true;
    const chunkSize = 200;
    for (let index = 0; index < rows.length; index += chunkSize) {
      const chunk = rows.slice(index, index + chunkSize);
      const { error: insertError } = await supabase
        .from('employees')
        .insert(chunk);
      if (insertError) throw insertError;
    }
    return true;
  } catch (error) {
    warnOnce(`remote-write:employees:${organizationId}`, error);
    return false;
  }
}

async function upsertPmsConfig(organizationId, config) {
  if (!shouldUseSupabase || !supabase || !organizationId || !config?.frameworkId) return true;
  try {
    const { error } = await supabase
      .from('pms_configs')
      .upsert({
        organization_id: organizationId,
        framework_id: String(config.frameworkId).trim(),
        config,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'organization_id' });
    if (error) throw error;
    return true;
  } catch (error) {
    warnOnce(`remote-write:pms_configs:${organizationId}`, error);
    return false;
  }
}

async function syncNormalizedWizardState(orgKey, payload) {
  if (!shouldUseSupabase || !supabase || !orgKey || !payload?.config) return false;

  const identity = await resolveOrganizationIdentity(orgKey);
  if (!identity?.id) return false;

  const config = payload.config;
  const signature = buildNormalizedWizardSignature(config);
  const lastSignature = readNormalizedSyncSignature(orgKey);

  const configOk = await upsertPmsConfig(identity.id, config);

  if (JSON.stringify(lastSignature) === JSON.stringify(signature)) {
    return configOk;
  }

  const [librariesOk, employeesOk] = await Promise.all([
    replaceGoalLibraries(identity.id, config),
    replaceEmployees(identity.id, config),
  ]);

  if (librariesOk && employeesOk) {
    writeNormalizedSyncSignature(orgKey, signature);
  }

  return configOk && librariesOk && employeesOk;
}

function mapOrganizationRow(row) {
  const payload = row?.setup_payload && typeof row.setup_payload === 'object' ? row.setup_payload : {};
  const cachedOrg = payload.orgData && typeof payload.orgData === 'object' ? payload.orgData : {};
  const workspaceSlug = String(row?.workspace_slug || cachedOrg.workspaceSlug || '').trim().toLowerCase();
  const domain = String(row?.domain || cachedOrg.domain || getDomainFromSlug(workspaceSlug)).trim().toLowerCase();
  return {
    ...cachedOrg,
    key: String(row?.org_key || cachedOrg.key || '').trim(),
    orgCode: String(row?.org_code || cachedOrg.orgCode || row?.org_key || '').trim(),
    name: String(row?.name || cachedOrg.name || 'Organization').trim(),
    workspaceSlug,
    domain,
    industry: row?.industry ?? cachedOrg.industry ?? '',
    hrAdminName: row?.hr_admin_name ?? cachedOrg.hrAdminName ?? '',
    hrAdminEmail: row?.hr_admin_email ?? cachedOrg.hrAdminEmail ?? '',
    pmsCalendar: row?.pms_calendar ?? cachedOrg.pmsCalendar ?? '',
    launched: row?.launched ?? cachedOrg.launched ?? false,
    currentPhase: row?.current_phase ?? cachedOrg.currentPhase ?? 'goal-setting',
    status: row?.status ?? cachedOrg.status ?? '',
    setupPct: Number(row?.setup_pct ?? cachedOrg.setupPct ?? 0) || 0,
    setupFormSnapshot: cachedOrg.setupFormSnapshot || payload.setupFormSnapshot || {},
  };
}

function writeLocalJson(key, value, { session = false, emit = false } = {}) {
  if (typeof window === 'undefined') return;
  try {
    const raw = JSON.stringify(value);
    if (session) window.sessionStorage.setItem(key, raw);
    else window.localStorage.setItem(key, raw);
    if (emit) {
      window.dispatchEvent(new StorageEvent('storage', { key, newValue: raw }));
    }
  } catch (error) {
    warnOnce(`local-write:${key}`, error);
  }
}

function removeLocalKey(key, { session = false } = {}) {
  if (typeof window === 'undefined') return;
  try {
    if (session) window.sessionStorage.removeItem(key);
    else window.localStorage.removeItem(key);
  } catch (error) {
    warnOnce(`local-remove:${key}`, error);
  }
}

function stateRecordKey(recordKey, orgKey = '') {
  return {
    state_key: recordKey,
    org_key: orgKey || '',
  };
}

async function readRemoteState(recordKey, orgKey = '') {
  if (!shouldUseSupabase || !supabase) return null;
  try {
    const { data, error } = await supabase
      .from('app_state')
      .select('payload')
      .eq('state_key', recordKey)
      .eq('org_key', orgKey || '');
    if (error) throw error;
    const row = (data || []).find((item) => (item.org_key || '') === (orgKey || ''));
    return row?.payload ?? null;
  } catch (error) {
    warnOnce(`remote-read:${recordKey}`, error);
    return null;
  }
}

async function readRemoteStateScoped(recordKey, orgKey = '') {
  if (!shouldUseSupabase || !supabase) return null;
  try {
    const { data, error } = await supabase
      .from('app_state')
      .select('payload')
      .eq('state_key', recordKey)
      .eq('org_key', orgKey || '')
      .maybeSingle();
    if (error) throw error;
    return data?.payload ?? null;
  } catch (error) {
    warnOnce(`remote-read:${recordKey}:${orgKey || 'global'}`, error);
    return null;
  }
}

async function writeRemoteState(recordKey, orgKey = '', payload) {
  if (!shouldUseSupabase || !supabase) return false;
  try {
    const { error } = await supabase
      .from('app_state')
      .upsert({
        ...stateRecordKey(recordKey, orgKey),
        payload,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'state_key,org_key' });
    if (error) throw error;
    return true;
  } catch (error) {
    warnOnce(`remote-write:${recordKey}:${orgKey || 'global'}`, error);
    return false;
  }
}

async function upsertOrganizationsRemote(organizations) {
  if (!shouldUseSupabase || !supabase) return true;
  const rows = (Array.isArray(organizations) ? organizations : [])
    .map(buildOrganizationRow)
    .filter((row) => row.org_key);
  if (rows.length === 0) return true;
  try {
    const { error } = await supabase
      .from('organizations')
      .upsert(rows, { onConflict: 'org_key' });
    if (error) throw error;
    return true;
  } catch (error) {
    warnOnce('remote-write:organizations', error);
    return false;
  }
}

async function deleteOrganizationsRemote(orgKeys = []) {
  if (!shouldUseSupabase || !supabase) return true;
  const keys = (Array.isArray(orgKeys) ? orgKeys : []).map((key) => String(key || '').trim()).filter(Boolean);
  if (keys.length === 0) return true;
  try {
    const { error } = await supabase
      .from('organizations')
      .delete()
      .in('org_key', keys);
    if (error) throw error;
    return true;
  } catch (error) {
    warnOnce('remote-delete:organizations', error);
    return false;
  }
}

function stripOrganizationsFromPayload(payload) {
  if (!payload || typeof payload !== 'object') return payload;
  if (!shouldUseSupabase) return payload;
  const { organizationsData, ...rest } = payload;
  return rest;
}

export function getStorageKeys() {
  return {
    appData: APP_DATA_KEY,
    wizardState: WIZARD_STATE_KEY,
    workflow: GOAL_WORKFLOW_KEY,
    messages: MESSAGES_KEY,
    authSession: SESSION_KEY,
    employeeSession: EMP_SESSION_KEY,
    employeeCredentials: EMP_CREDENTIALS_KEY,
  };
}

export function readAppDataSync() {
  return readAppDataLocal();
}

export async function hydrateAppData() {
  const local = readAppDataSync();
  if (!shouldUseSupabase) return local;
  const remote = await readRemoteStateScoped('app_data');
  if (remote) {
    const merged = {
      ...(remote && typeof remote === 'object' ? remote : {}),
      organizationsData: Array.isArray(local?.organizationsData) ? local.organizationsData : [],
    };
    writeLocalJson(APP_DATA_KEY, merged);
    return merged;
  }
  return local;
}

export function persistAppData(payload) {
  writeLocalJson(APP_DATA_KEY, payload);
  void writeRemoteState('app_data', '', stripOrganizationsFromPayload(payload));
}

export function readOrganizationsSync() {
  const data = readAppDataSync();
  return Array.isArray(data?.organizationsData) ? data.organizationsData : [];
}

export async function hydrateOrganizations() {
  const local = readOrganizationsSync();
  if (!shouldUseSupabase || !supabase) return local;
  try {
    const { data, error } = await supabase
      .from('organizations')
      .select(ORGANIZATION_SELECT)
      .order('updated_at', { ascending: false });
    if (error) throw error;
    const organizations = Array.isArray(data) ? data.map(mapOrganizationRow).filter((org) => org.key) : [];
    writeOrganizationsToLocalCache(organizations);
    return organizations;
  } catch (error) {
    warnOnce('remote-read:organizations', error);
    return local;
  }
}

export async function saveOrganizationRecord(org) {
  const nextOrg = org && typeof org === 'object' ? org : null;
  if (!nextOrg?.key) return { ok: false, error: 'Organization key is required.' };
  const localOrgs = readOrganizationsSync();
  const nextOrgs = localOrgs.some((item) => item.key === nextOrg.key)
    ? localOrgs.map((item) => (item.key === nextOrg.key ? nextOrg : item))
    : [nextOrg, ...localOrgs];

  if (!shouldUseSupabase) {
    writeOrganizationsToLocalCache(nextOrgs);
    return { ok: true, org: nextOrg };
  }

  const ok = await upsertOrganizationsRemote([nextOrg]);
  if (!ok) return { ok: false, error: 'Failed to create organization in backend.' };
  writeOrganizationsToLocalCache(nextOrgs);
  return { ok: true, org: nextOrg };
}

export async function syncOrganizationsCollection(nextOrgs, prevOrgs = []) {
  const organizations = Array.isArray(nextOrgs) ? nextOrgs : [];
  writeOrganizationsToLocalCache(organizations);
  if (!shouldUseSupabase) return true;

  const prevKeys = new Set((Array.isArray(prevOrgs) ? prevOrgs : []).map((org) => String(org?.key || '').trim()).filter(Boolean));
  const nextKeys = new Set(organizations.map((org) => String(org?.key || '').trim()).filter(Boolean));
  const deletedKeys = [...prevKeys].filter((key) => !nextKeys.has(key));

  const [upserted, deleted] = await Promise.all([
    upsertOrganizationsRemote(organizations),
    deleteOrganizationsRemote(deletedKeys),
  ]);

  return upserted && deleted;
}

export async function deleteOrganizationRecord(orgKey = '') {
  const key = String(orgKey || '').trim();
  if (!key) return { ok: false, error: 'Organization key is required.' };

  const localOrgs = readOrganizationsSync();
  const nextOrgs = localOrgs.filter((org) => org.key !== key);

  if (!shouldUseSupabase) {
    writeOrganizationsToLocalCache(nextOrgs);
    return { ok: true };
  }

  const ok = await deleteOrganizationsRemote([key]);
  if (!ok) return { ok: false, error: 'Failed to delete organization from backend.' };
  writeOrganizationsToLocalCache(nextOrgs);
  return { ok: true };
}

export function clearOrganizationState(orgKey = '') {
  const scope = orgKey || 'default';
  removeLocalKey(`${WIZARD_STATE_KEY}:${scope}`);
  removeLocalKey(`${WIZARD_STATE_KEY}:${scope}`, { session: true });
  removeLocalKey(`${GOAL_WORKFLOW_KEY}:${scope}`);
  removeLocalKey(`${MESSAGES_KEY}:${scope}`);
  removeLocalKey(getNormalizedSyncKey(scope));

  const credentials = readEmployeeCredentialsSync();
  if (credentials && typeof credentials === 'object') {
    const nextCredentials = Object.fromEntries(
      Object.entries(credentials).filter(([, value]) => value?.orgKey !== orgKey)
    );
    if (Object.keys(nextCredentials).length !== Object.keys(credentials).length) {
      persistEmployeeCredentials(nextCredentials);
    }
  }
}

export function migrateOrganizationState(oldOrgKey = '', newOrgKey = '') {
  const fromKey = String(oldOrgKey || '').trim();
  const toKey = String(newOrgKey || '').trim();

  if (!fromKey || !toKey || fromKey === toKey) return;

  const stateKeys = [
    { localKey: WIZARD_STATE_KEY, recordKey: 'wizard_state', copySession: true },
    { localKey: GOAL_WORKFLOW_KEY, recordKey: 'workflow', copySession: false },
    { localKey: MESSAGES_KEY, recordKey: 'messages', copySession: false },
  ];

  stateKeys.forEach(({ localKey, recordKey, copySession }) => {
    const fromStorageKey = `${localKey}:${fromKey}`;
    const toStorageKey = `${localKey}:${toKey}`;
    const localPayload = readLocalJson(fromStorageKey, null);

    if (localPayload != null) {
      writeLocalJson(toStorageKey, localPayload, { emit: recordKey !== 'wizard_state' });
      if (copySession) writeLocalJson(toStorageKey, localPayload, { session: true });
      void writeRemoteState(recordKey, toKey, localPayload);
    }

    removeLocalKey(fromStorageKey);
    if (copySession) removeLocalKey(fromStorageKey, { session: true });
  });

  const credentials = readEmployeeCredentialsSync();
  if (credentials && typeof credentials === 'object') {
    let changed = false;
    const nextCredentials = Object.fromEntries(
      Object.entries(credentials).map(([credentialKey, value]) => {
        if (value?.orgKey !== fromKey) return [credentialKey, value];
        changed = true;
        return [credentialKey, { ...value, orgKey: toKey }];
      })
    );
    if (changed) persistEmployeeCredentials(nextCredentials);
  }

  const authSession = readAuthSessionSync();
  if (authSession?.orgKey === fromKey) {
    persistAuthSession({ ...authSession, orgKey: toKey });
  }

  const employeeSession = readEmployeeSessionSync();
  if (employeeSession?.orgKey === fromKey) {
    persistEmployeeSession({ ...employeeSession, orgKey: toKey });
  }

  const normalizedSignature = readNormalizedSyncSignature(fromKey);
  if (normalizedSignature) {
    writeNormalizedSyncSignature(toKey, normalizedSignature);
    removeLocalKey(getNormalizedSyncKey(fromKey));
  }
}

export function readWizardStateSync(orgKey = '') {
  return readLocalJson(`${WIZARD_STATE_KEY}:${orgKey || 'default'}`, null);
}

export async function hydrateWizardState(orgKey = '') {
  const local = readWizardStateSync(orgKey);
  if (!shouldUseSupabase) return local;
  const remote = await readRemoteStateScoped('wizard_state', orgKey);
  if (remote) {
    writeLocalJson(`${WIZARD_STATE_KEY}:${orgKey || 'default'}`, remote);
    writeLocalJson(`${WIZARD_STATE_KEY}:${orgKey || 'default'}`, remote, { session: true });
    return remote;
  }
  return local;
}

export function persistWizardState(orgKey, payload) {
  const key = `${WIZARD_STATE_KEY}:${orgKey || 'default'}`;
  writeLocalJson(key, payload);
  writeLocalJson(key, payload, { session: true });
  void writeRemoteState('wizard_state', orgKey, payload);
  void syncNormalizedWizardState(orgKey, payload);
}

export function readWorkflowSync(orgKey = '') {
  return readLocalJson(`${GOAL_WORKFLOW_KEY}:${orgKey || 'default'}`, { submissions: {}, notifications: [] });
}

export async function hydrateWorkflow(orgKey = '') {
  const local = readWorkflowSync(orgKey);
  if (!shouldUseSupabase) return local;
  const remote = await readRemoteStateScoped('workflow', orgKey);
  if (remote) {
    writeLocalJson(`${GOAL_WORKFLOW_KEY}:${orgKey || 'default'}`, remote, { emit: true });
    return remote;
  }
  return local;
}

export function persistWorkflow(orgKey, payload) {
  const key = `${GOAL_WORKFLOW_KEY}:${orgKey || 'default'}`;
  writeLocalJson(key, payload, { emit: true });
  void writeRemoteState('workflow', orgKey, payload);
}

export function readMessagesSync(orgKey = '') {
  return readLocalJson(`${MESSAGES_KEY}:${orgKey || 'default'}`, { conversations: {} });
}

export async function hydrateMessages(orgKey = '') {
  const local = readMessagesSync(orgKey);
  if (!shouldUseSupabase) return local;
  const remote = await readRemoteStateScoped('messages', orgKey);
  if (remote) {
    writeLocalJson(`${MESSAGES_KEY}:${orgKey || 'default'}`, remote, { emit: true });
    return remote;
  }
  return local;
}

export function persistMessages(orgKey, payload) {
  const key = `${MESSAGES_KEY}:${orgKey || 'default'}`;
  writeLocalJson(key, payload, { emit: true });
  void writeRemoteState('messages', orgKey, payload);
}

export function readEmployeeCredentialsSync() {
  return readLocalJson(EMP_CREDENTIALS_KEY, {});
}

export async function hydrateEmployeeCredentials() {
  const local = readEmployeeCredentialsSync();
  if (!shouldUseSupabase) return local;
  const remote = await readRemoteStateScoped('employee_credentials');
  if (remote && typeof remote === 'object') {
    writeLocalJson(EMP_CREDENTIALS_KEY, remote);
    return remote;
  }
  if (local && Object.keys(local).length > 0) {
    void writeRemoteState('employee_credentials', '', local);
  }
  return local;
}

export function persistEmployeeCredentials(payload) {
  const next = payload && typeof payload === 'object' ? payload : {};
  writeLocalJson(EMP_CREDENTIALS_KEY, next);
  void writeRemoteState('employee_credentials', '', next);
}

export function readAuthSessionSync() {
  return readLocalJson(SESSION_KEY, null);
}

export function persistAuthSession(payload) {
  writeLocalJson(SESSION_KEY, payload);
  writeLocalJson(SESSION_KEY, payload, { session: true });
}

export function clearAuthSession() {
  removeLocalKey(SESSION_KEY);
  removeLocalKey(SESSION_KEY, { session: true });
}

export function readEmployeeSessionSync() {
  return readLocalJson(EMP_SESSION_KEY, null);
}

export function persistEmployeeSession(payload) {
  writeLocalJson(EMP_SESSION_KEY, payload);
}

export function clearEmployeeSession() {
  removeLocalKey(EMP_SESSION_KEY);
}

export function getBackendStateDiagnostics() {
  return getBackendDiagnostics();
}
