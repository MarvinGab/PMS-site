import { shouldUseSupabase, getBackendDiagnostics } from './config';
import { supabase } from './supabaseClient';
import { hashPasswordValue } from './passwordCrypto';

const APP_DATA_KEY = 'zarohr_app_data_v1';
const WIZARD_STATE_KEY = 'zarohr_pms_wizard_state_v1';
const GOAL_WORKFLOW_KEY = 'zarohr_goal_workflow_v1';
const MESSAGES_KEY = 'zarohr_messages_v1';
const SESSION_KEY = 'zarohr_auth_session';
const EMP_SESSION_KEY = 'zarohr_emp_session';
const EMP_CREDENTIALS_KEY = 'zarohr_emp_credentials';
const NORMALIZED_SYNC_KEY_PREFIX = 'zarohr_normalized_sync_v2';
const ORG_BRAND_CACHE_KEY = 'zarohr_org_brand_cache_v1';

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
  setup_status,
  setup_reopened,
  setup_reopened_at,
  setup_reopened_by,
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
  writeOrgBrandCacheFromOrganizations(organizations);
}

function extractOrgBrand(org = {}) {
  return {
    key: String(org?.key || '').trim(),
    name: org?.name || '',
    brandLogo: org?.brandLogo || null,
    brandEmailLogo: org?.brandEmailLogo || null,
    brandName: org?.brandName || org?.name || '',
    brandPalette: org?.brandPalette || null,
    brandHero: org?.brandHero || null,
    brandCards: org?.brandCards || 'default',
    brandFill: org?.brandFill || 'gradient',
    updatedAt: org?.updatedAt || org?.updated_at || new Date().toISOString(),
  };
}

function writeOrgBrandCacheFromOrganizations(organizations) {
  if (!Array.isArray(organizations)) return;
  const current = readLocalJson(ORG_BRAND_CACHE_KEY, {}) || {};
  const next = { ...current };
  organizations.forEach((org) => {
    const brand = extractOrgBrand(org);
    if (brand.key) next[brand.key] = brand;
  });
  writeLocalJson(ORG_BRAND_CACHE_KEY, next);
}

function getDomainFromSlug(slug) {
  const normalized = String(slug || '').trim().toLowerCase();
  return normalized ? 'pms.zarohr.com' : '';
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
    setup_status: String(org?.setupStatus || (org?.launched ? 'launched' : 'in_progress')).trim() || 'in_progress',
    setup_reopened: !!org?.setupReopened,
    setup_reopened_at: org?.setupReopenedAt || null,
    setup_reopened_by: org?.setupReopenedBy || null,
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

function getAssignmentSlots(group) {
  const values = Array.isArray(group?.segmentValues)
    ? group.segmentValues.map((value) => String(value || '').trim()).filter(Boolean)
    : [];
  if (values.length === 0) {
    return [{ slotKey: '__default__', label: group?.name || 'All Employees' }];
  }
  return values.map((value) => ({ slotKey: value, label: value }));
}

function getPrefillAssignments(group) {
  const expected = getAssignmentSlots(group);
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

function getLibraryAssignments(group) {
  const expected = getAssignmentSlots(group);
  const existing = Array.isArray(group?.libraryAssignments) ? group.libraryAssignments : [];
  const fallbackLibraryId = expected.length === 1 ? group?.libraryId ?? null : null;
  return expected.map((slot) => {
    const match = existing.find((assignment) => normalizeLower(assignment?.slotKey) === normalizeLower(slot.slotKey));
    return {
      slotKey: slot.slotKey,
      label: slot.label,
      libraryId: match?.libraryId ?? fallbackLibraryId ?? null,
    };
  });
}

function makeLibraryKey(seed, fallback) {
  const value = String(seed || '').trim();
  if (value) return value;
  return String(fallback || '').trim();
}

function buildGoalLibraryRows(organizationId, config) {
  const rows = [];

  if (config?.goalLibrariesAppliedSnapshot && Array.isArray(config.goalLibraries)) {
    config.goalLibraries.forEach((library, index) => {
      rows.push({
        organization_id: organizationId,
        library_key: makeLibraryKey(library?.id, `goal-library-${index + 1}`),
        name: String(library?.name || `Library ${index + 1}`).trim(),
        library_type: String(library?.type || 'unknown').trim() || 'unknown',
        scope_type: 'reusable-library',
        status: 'active',
        version: 1,
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
          library_key: makeLibraryKey(`legacy-goal-library:${groupKey}`, `legacy-goal-library-${rows.length + 1}`),
          name: String(groupKey || 'All Employees').trim() || 'All Employees',
          library_type: 'legacy-goal-library',
          scope_type: 'segment-library',
          status: 'active',
          version: 1,
          payload: {
            source: 'goalLibraryData',
            attrLabel: config.goalLibraryData.attrLabel || null,
            groupKey: String(groupKey || '').trim() || null,
            data: kras || [],
          },
        });
      });
    } else {
      rows.push({
        organization_id: organizationId,
        library_key: 'legacy-goal-library:all-employees',
        name: 'All Employees',
        library_type: 'legacy-goal-library',
        scope_type: 'common-library',
        status: 'active',
        version: 1,
        payload: {
          source: 'goalLibraryData',
          attrLabel: null,
          data: config.goalLibraryData.data || [],
        },
      });
    }
  }

  return rows.filter((row) => row.name);
}

function buildGoalLibraryAssignmentRows(organizationId, config) {
  const groups = Array.isArray(config?.goalGroups) ? config.goalGroups : [];
  return groups
    .filter((group) => !!group?.hasLibrary)
    .flatMap((group) => getLibraryAssignments(group)
      .filter((assignment) => !!assignment.libraryId)
      .map((assignment) => ({
        organization_id: organizationId,
        group_id: String(group?.id || '').trim() || null,
        group_name: String(group?.name || 'Group').trim() || 'Group',
        segment_attr: String(group?.segmentAttr || '').trim() || null,
        slot_key: String(assignment.slotKey || '').trim() || '__default__',
        slot_label: String(assignment.label || assignment.slotKey || group?.name || 'All Employees').trim() || 'All Employees',
        source_library_key: makeLibraryKey(assignment.libraryId, `assignment:${group?.id || group?.name || 'group'}:${assignment.slotKey || 'default'}`),
        payload: {
          group: {
            id: group?.id || null,
            name: group?.name || '',
            segmentAttr: group?.segmentAttr || null,
            segmentValues: Array.isArray(group?.segmentValues) ? group.segmentValues : [],
          },
          assignment,
          libraryType: String(group?.libraryType || '').trim() || null,
        },
      })));
}

function buildPrefillDatasetRows(organizationId, config) {
  const groups = Array.isArray(config?.goalGroups) ? config.goalGroups : [];
  return groups
    .filter((group) => !!group?.prefillType)
    .flatMap((group) => {
      const libraryAssignments = getLibraryAssignments(group);
      return getPrefillAssignments(group)
        .filter((assignment) => Array.isArray(assignment.data) && assignment.data.length > 0)
        .map((assignment) => {
          const linkedLibrary = libraryAssignments.find((item) => normalizeLower(item.slotKey) === normalizeLower(assignment.slotKey));
          const sourceLibraryKey = linkedLibrary?.libraryId ? makeLibraryKey(linkedLibrary.libraryId, null) : null;
          return {
            organization_id: organizationId,
            group_id: String(group?.id || '').trim() || null,
            group_name: String(group?.name || 'Group').trim() || 'Group',
            segment_attr: String(group?.segmentAttr || '').trim() || null,
            slot_key: String(assignment.slotKey || '').trim() || '__default__',
            slot_label: String(assignment.label || assignment.slotKey || group?.name || 'All Employees').trim() || 'All Employees',
            prefill_type: String(group?.prefillType || 'kra-only').trim() || 'kra-only',
            source_type: sourceLibraryKey ? 'library' : 'custom',
            source_library_key: sourceLibraryKey,
            status: 'active',
            payload: {
              source: 'prefillAssignments',
              group: {
                id: group?.id || null,
                name: group?.name || '',
                segmentAttr: group?.segmentAttr || null,
                segmentValues: Array.isArray(group?.segmentValues) ? group.segmentValues : [],
              },
              assignment,
              kpiRatingMode: String(group?.kpiRatingMode || 'rated').trim() || 'rated',
            },
          };
        });
    });
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

function resolveEmployeeEmail(employee = {}) {
  return String(
    employee['Email ID']
      || employee.Email
      || employee.email
      || employee['Work Email']
      || employee['Official Email']
      || ''
  ).trim().toLowerCase();
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
    if (rows.length === 0) return [];
    const { data, error: insertError } = await supabase
      .from('goal_libraries')
      .insert(rows)
      .select('id, library_key');
    if (insertError) throw insertError;
    return Array.isArray(data) ? data : [];
  } catch (error) {
    warnOnce(`remote-write:goal_libraries:${organizationId}`, error);
    return null;
  }
}

function attachResolvedLibraryIds(rows, libraryRows) {
  const libraryIdByKey = new Map(
    (Array.isArray(libraryRows) ? libraryRows : [])
      .map((row) => [String(row?.library_key || '').trim(), row?.id || null])
      .filter(([key, id]) => key && id)
  );

  return (Array.isArray(rows) ? rows : []).map((row) => {
    const key = String(row?.source_library_key || '').trim();
    return {
      ...row,
      source_library_id: key ? (libraryIdByKey.get(key) || null) : null,
    };
  });
}

async function replaceGoalLibraryAssignments(organizationId, config, libraryRows) {
  if (!shouldUseSupabase || !supabase || !organizationId) return true;
  const rows = attachResolvedLibraryIds(buildGoalLibraryAssignmentRows(organizationId, config), libraryRows);
  try {
    const { error: deleteError } = await supabase
      .from('goal_library_assignments')
      .delete()
      .eq('organization_id', organizationId);
    if (deleteError) throw deleteError;
    if (rows.length === 0) return true;
    const { error: insertError } = await supabase
      .from('goal_library_assignments')
      .insert(rows);
    if (insertError) throw insertError;
    return true;
  } catch (error) {
    warnOnce(`remote-write:goal_library_assignments:${organizationId}`, error);
    return false;
  }
}

async function replacePrefillDatasets(organizationId, config, libraryRows) {
  if (!shouldUseSupabase || !supabase || !organizationId) return true;
  const rows = attachResolvedLibraryIds(buildPrefillDatasetRows(organizationId, config), libraryRows);
  try {
    const { error: deleteError } = await supabase
      .from('prefill_datasets')
      .delete()
      .eq('organization_id', organizationId);
    if (deleteError) throw deleteError;
    if (rows.length === 0) return true;
    const { error: insertError } = await supabase
      .from('prefill_datasets')
      .insert(rows);
    if (insertError) throw insertError;
    return true;
  } catch (error) {
    warnOnce(`remote-write:prefill_datasets:${organizationId}`, error);
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

  const libraryRows = await replaceGoalLibraries(identity.id, config);
  const librariesOk = libraryRows !== null;
  const [assignmentsOk, prefillOk, employeesOk] = await Promise.all([
    replaceGoalLibraryAssignments(identity.id, config, libraryRows || []),
    replacePrefillDatasets(identity.id, config, libraryRows || []),
    replaceEmployees(identity.id, config),
  ]);

  if (librariesOk && assignmentsOk && prefillOk && employeesOk) {
    writeNormalizedSyncSignature(orgKey, signature);
  }

  return configOk && librariesOk && assignmentsOk && prefillOk && employeesOk;
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
    setupStatus: row?.setup_status ?? cachedOrg.setupStatus ?? ((row?.launched ?? cachedOrg.launched) ? 'launched' : 'in_progress'),
    setupReopened: row?.setup_reopened ?? cachedOrg.setupReopened ?? false,
    setupReopenedAt: row?.setup_reopened_at ?? cachedOrg.setupReopenedAt ?? null,
    setupReopenedBy: row?.setup_reopened_by ?? cachedOrg.setupReopenedBy ?? null,
    setupPct: Number(row?.setup_pct ?? cachedOrg.setupPct ?? 0) || 0,
    setupFormSnapshot: cachedOrg.setupFormSnapshot || payload.setupFormSnapshot || {},
  };
}

function writeLocalJson(key, value, { session = false, emit = false } = {}) {
  if (typeof window === 'undefined') return;
  try {
    const raw = JSON.stringify(value);
    const store = session ? window.sessionStorage : window.localStorage;
    // Dedupe: if the serialised value is byte-identical to what's already
    // in storage, skip both the write AND the synthetic storage event.
    // Without this guard, every emit-enabled write triggers a same-tab
    // listener that calls setState with a fresh object reference, which
    // re-renders, which re-saves, which re-emits — an infinite cycle that
    // burns a frame on every iteration and can starve user interactions
    // (e.g. add/delete/drag actions appear to do nothing or stutter).
    if (store.getItem(key) === raw) return;
    store.setItem(key, raw);
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

// Subscribe to remote changes on an `app_state` row (state_key + org_key).
// Fires `onChange()` whenever the row is inserted/updated/deleted by ANY
// session — including writes from other devices. The consumer is expected
// to re-hydrate from the database inside `onChange` (e.g. by calling
// hydrateWorkflow/hydrateMessages/etc.) so the UI reflects the new state.
//
// Returns an unsubscribe function. Callers must invoke it on unmount.
export function subscribeToScopedState(recordKey, orgKey, onChange) {
  if (!shouldUseSupabase || !supabase || typeof onChange !== 'function') {
    return () => {};
  }
  const orgFilter = orgKey || '';
  const channelName = `app_state:${recordKey}:${orgFilter || 'global'}:${Math.random().toString(36).slice(2, 8)}`;
  const channel = supabase
    .channel(channelName)
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'app_state', filter: `state_key=eq.${recordKey}` },
      (payload) => {
        // postgres_changes filter only narrows by state_key — narrow to the
        // requested org_key in the handler. Fall back to `old` for deletes.
        const row = (payload?.new && Object.keys(payload.new || {}).length > 0) ? payload.new : payload?.old;
        if (!row) return;
        if ((row.state_key || '') !== recordKey) return;
        if ((row.org_key || '') !== orgFilter) return;
        try { onChange(); } catch (error) { warnOnce(`realtime-handler:${recordKey}:${orgFilter || 'global'}`, error); }
      },
    )
    .subscribe();
  return () => {
    try { supabase.removeChannel(channel); } catch { /* ignore teardown errors */ }
  };
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

async function deleteOrgScopedStateRemote(orgKeys = []) {
  if (!shouldUseSupabase || !supabase) return true;
  const keys = (Array.isArray(orgKeys) ? orgKeys : []).map((key) => String(key || '').trim()).filter(Boolean);
  if (keys.length === 0) return true;
  try {
    const { error } = await supabase
      .from('app_state')
      .delete()
      .in('org_key', keys);
    if (error) throw error;
    return true;
  } catch (error) {
    warnOnce('remote-delete:app_state', error);
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
  if (Array.isArray(payload?.organizationsData)) writeOrgBrandCacheFromOrganizations(payload.organizationsData);
  void writeRemoteState('app_data', '', stripOrganizationsFromPayload(payload));
}

export function readOrganizationsSync() {
  const data = readAppDataSync();
  return Array.isArray(data?.organizationsData) ? data.organizationsData : [];
}

export function readOrgBrandCacheSync(orgKey) {
  const key = String(orgKey || '').trim();
  if (!key) return null;
  const cache = readLocalJson(ORG_BRAND_CACHE_KEY, {}) || {};
  return cache[key] || null;
}

export function persistOrgBrandCache(org) {
  const brand = extractOrgBrand(org);
  if (!brand.key) return;
  const current = readLocalJson(ORG_BRAND_CACHE_KEY, {}) || {};
  writeLocalJson(ORG_BRAND_CACHE_KEY, { ...current, [brand.key]: brand });
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

  const stateOk = await deleteOrgScopedStateRemote([key]);
  if (!stateOk) return { ok: false, error: 'Failed to delete organization state from backend.' };

  const ok = await deleteOrganizationsRemote([key]);
  if (!ok) return { ok: false, error: 'Failed to delete organization from backend.' };
  writeOrganizationsToLocalCache(nextOrgs);
  return { ok: true };
}

export async function clearOrganizationState(orgKey = '') {
  const scope = orgKey || 'default';
  removeLocalKey(`${WIZARD_STATE_KEY}:${scope}`);
  removeLocalKey(`${WIZARD_STATE_KEY}:${scope}`, { session: true });
  removeLocalKey(`${GOAL_WORKFLOW_KEY}:${scope}`);
  removeLocalKey(`${MESSAGES_KEY}:${scope}`);
  removeLocalKey(getNormalizedSyncKey(scope));

  // Hydrate before mutating: the local cache may be stale relative to the
  // remote credentials blob (e.g. someone else changed their password since
  // this tab loaded). Reading remote first prevents that change from being
  // clobbered when we persist this filtered set back.
  const credentials = await hydrateEmployeeCredentials();
  if (credentials && typeof credentials === 'object') {
    const nextCredentials = Object.fromEntries(
      Object.entries(credentials).filter(([, value]) => value?.orgKey !== orgKey)
    );
    if (Object.keys(nextCredentials).length !== Object.keys(credentials).length) {
      persistEmployeeCredentials(nextCredentials);
    }
  }
}

export async function migrateOrganizationState(oldOrgKey = '', newOrgKey = '') {
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

  // Hydrate before mutating so the blob we re-persist reflects any
  // server-side credential changes that happened since this tab loaded.
  const credentials = await hydrateEmployeeCredentials();
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
  // Broadcast the change so subscribers (e.g. an open employee dashboard)
  // can react in real time — without `emit: true`, only other tabs would
  // see the storage event, and same-tab views would stay stale until reload.
  writeLocalJson(key, payload, { emit: true });
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

function generateEmployeeOtp() {
  // 6-digit numeric one-time password, cryptographically random. Each
  // employee receives a unique value so a leaked invite can't unlock the
  // whole org. Recipients change it on first login via the isTemp flow.
  if (typeof globalThis !== 'undefined' && globalThis.crypto?.getRandomValues) {
    const arr = new Uint32Array(1);
    globalThis.crypto.getRandomValues(arr);
    return String(arr[0] % 1000000).padStart(6, '0');
  }
  return String(Math.floor(Math.random() * 1000000)).padStart(6, '0');
}

export async function syncEmployeeCredentialsForOrg({ orgKey = '', tempPassword = '', employees = [] } = {}) {
  const normalizedOrgKey = String(orgKey || '').trim();
  if (!normalizedOrgKey) return readEmployeeCredentialsSync();

  const roster = Array.isArray(employees) ? employees : [];
  const uploadedCodes = new Set(
    roster
      .map((employee) => normalizeCode(employee?.['Employee Code']))
      .filter(Boolean)
  );

  // Hydrate from remote so we don't overwrite credential changes (e.g. a
  // freshly-set permanent password) that happened since this tab cached
  // the blob locally.
  const existing = { ...(await hydrateEmployeeCredentials() || {}) };
  let changed = false;

  Object.entries(existing).forEach(([credentialKey, credential]) => {
    if (credential?.orgKey !== normalizedOrgKey) return;
    if (!credential?.isTemp) return;
    if (uploadedCodes.has(normalizeCode(credentialKey))) return;
    delete existing[credentialKey];
    changed = true;
  });

  for (const employee of roster) {
    const code = normalizeCode(employee?.['Employee Code']);
    if (!code) continue;

    const email = resolveEmployeeEmail(employee);
    const current = existing[code];
    let nextValue;
    if (current) {
      nextValue = {
        ...current,
        name: String(employee['Employee Name'] || current.name || '').trim(),
        email: email || current.email || '',
        empCode: code,
        designation: String(employee.Designation || employee.Role || current.designation || '').trim(),
        managerCode: normalizeCode(employee['Reporting Manager Code'] || current.managerCode || ''),
        orgKey: normalizedOrgKey,
      };
    } else {
      const otp = generateEmployeeOtp();
      nextValue = {
        passwordHash: await hashPasswordValue(otp),
        // Plaintext kept temporarily so the imminent invite email can include
        // it. Cleared after a successful send by `clearPendingEmployeeOtps`.
        pendingTempPassword: otp,
        name: String(employee['Employee Name'] || '').trim(),
        email,
        empCode: code,
        designation: String(employee.Designation || employee.Role || '').trim(),
        managerCode: normalizeCode(employee['Reporting Manager Code'] || ''),
        orgKey: normalizedOrgKey,
        isTemp: true,
      };
    }

    if (JSON.stringify(current || null) !== JSON.stringify(nextValue)) {
      existing[code] = nextValue;
      changed = true;
    }
  }

  if (changed) persistEmployeeCredentials(existing);
  return existing;
}

// Rotate each listed employee's OTP and persist the new hash. Returns a map
// of code → plaintext so the caller can stuff it into the outgoing email.
// Use this on every send so a resend always supersedes the prior OTP.
export async function rotateEmployeeOtpsForSend({ orgKey = '', employees = [] } = {}) {
  const normalizedOrgKey = String(orgKey || '').trim();
  if (!normalizedOrgKey) return new Map();
  const list = Array.isArray(employees) ? employees : [];
  if (list.length === 0) return new Map();

  // Hydrate so we rotate OTPs on top of fresh remote state — otherwise
  // an employee who set a permanent password since this tab loaded could
  // get reverted to a new OTP and forced back into the temp-password flow.
  const existing = { ...(await hydrateEmployeeCredentials() || {}) };
  const plaintextByCode = new Map();
  let changed = false;

  for (const employee of list) {
    const code = normalizeCode(employee?.['Employee Code']);
    if (!code) continue;
    const current = existing[code];
    if (current && !current.isTemp) continue; // user already changed password — don't clobber
    const otp = generateEmployeeOtp();
    const passwordHash = await hashPasswordValue(otp);
    existing[code] = {
      ...(current || {}),
      passwordHash,
      pendingTempPassword: otp,
      empCode: code,
      orgKey: normalizedOrgKey,
      isTemp: true,
    };
    plaintextByCode.set(code, otp);
    changed = true;
  }

  if (changed) persistEmployeeCredentials(existing);
  return plaintextByCode;
}

// After a successful send, scrub the plaintext field so it doesn't sit in
// storage. The passwordHash remains and is what the auth flow checks.
export async function clearPendingEmployeeOtps({ orgKey = '', codes = [] } = {}) {
  const normalizedOrgKey = String(orgKey || '').trim();
  if (!normalizedOrgKey || !codes?.length) return;
  // Hydrate first so the persisted blob doesn't roll back any concurrent
  // server-side credential update.
  const existing = { ...(await hydrateEmployeeCredentials() || {}) };
  let changed = false;
  codes.forEach((rawCode) => {
    const code = normalizeCode(rawCode);
    const cred = existing[code];
    if (cred && cred.pendingTempPassword) {
      const { pendingTempPassword: _drop, ...rest } = cred;
      existing[code] = rest;
      changed = true;
    }
  });
  if (changed) persistEmployeeCredentials(existing);
}

export async function hydrateEmployeeCredentials() {
  const local = readEmployeeCredentialsSync();
  if (!shouldUseSupabase) return local;
  const remote = await readRemoteStateScoped('employee_credentials');
  if (remote && typeof remote === 'object') {
    writeLocalJson(EMP_CREDENTIALS_KEY, remote);
    return remote;
  }
  // Remote read returned null/falsy — could be a transient error, an RLS
  // denial, or a genuinely empty row. Never push the local cache up here:
  // doing so would overwrite a freshly-changed password (written server-side
  // via the edge function) with a stale snapshot from this browser.
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
