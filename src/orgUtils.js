import { APP_DATA_KEY } from './AppContext';

export const PMS_WIZARD_STATE_KEY = 'zarohr_pms_wizard_state_v1';

export function getWizardStorageKey(orgKey = '') {
  return `${PMS_WIZARD_STATE_KEY}:${orgKey || 'default'}`;
}

export function readWizardState(orgKey) {
  if (!orgKey || typeof window === 'undefined') return null;
  try {
    const storageKey = getWizardStorageKey(orgKey);
    const raw = window.sessionStorage.getItem(storageKey) || window.localStorage.getItem(storageKey);
    return raw ? JSON.parse(raw) : null;
  } catch (_) {
    return null;
  }
}

function sanitizeText(value) {
  return String(value || '').trim().replace(/\s+/g, ' ');
}

function isPerspectiveRowEmpty(perspective) {
  const mode = perspective?.nameOption === 'custom'
    ? (perspective?.customName ?? perspective?.name ?? '')
    : (perspective?.nameOption || perspective?.name || '');
  return sanitizeText(mode) === '' && (perspective?.weight === '' || Number(perspective?.weight) === 0);
}

function isPerspectiveRowComplete(perspective) {
  const mode = perspective?.nameOption === 'custom'
    ? (perspective?.customName ?? perspective?.name ?? '')
    : (perspective?.nameOption || perspective?.name || '');
  return sanitizeText(mode) !== '' && perspective?.weight !== '' && !Number.isNaN(Number(perspective?.weight));
}

function getFrameworkSnapshot(config) {
  return JSON.stringify({ frameworkId: config?.frameworkId || null });
}

function getPerspectivesSnapshot(config) {
  return JSON.stringify(
    (config?.perspectives || [])
      .filter((perspective) => !isPerspectiveRowEmpty(perspective))
      .map((perspective) => {
        const mode = perspective?.nameOption === 'custom'
          ? (perspective?.customName ?? perspective?.name ?? '')
          : (perspective?.nameOption || perspective?.name || '');
        return {
          name: sanitizeText(mode),
          weight: String(perspective?.weight ?? '').trim(),
          color: perspective?.color || '',
        };
      })
  );
}

function areUnique(values = []) {
  return new Set(values.map((value) => String(value || '').toLowerCase())).size === values.length;
}

function isGoalSettingsValid(config) {
  if (!config?.goalCreationMode) return false;
  if (config.goalCreationMode === 'admin-library') {
    if (!config.goalLibraryScope) return false;
    if (config.goalLibraryScope === 'by-attribute') {
      const values = (config.goalSegmentValues || []).map((value) => sanitizeText(value?.name)).filter(Boolean);
      if (!values.length || !areUnique(values)) return false;
    }
    return !!config.goalKpiMode && !!config.goalEmployeeEdit;
  }
  if (config.goalLimitEnabled == null) return false;
  if (config.goalLimitEnabled === false) return true;
  if (!config.goalLimitScope) return false;
  if (config.goalLimitScope === 'common') {
    return Number(config.goalLimitMin) > 0 && Number(config.goalLimitMax) >= Number(config.goalLimitMin);
  }
  const values = (config.goalLimitValues || [])
    .map((value) => ({
      name: sanitizeText(value?.name),
      min: Number(value?.min),
      max: Number(value?.max),
    }))
    .filter((value) => value.name);
  return values.length > 0 && areUnique(values.map((value) => value.name)) && values.every((value) => value.min > 0 && value.max >= value.min);
}

function getGoalsSnapshot(config) {
  if (config?.goalCreationMode === 'admin-library') {
    return JSON.stringify({
      goalCreationMode: config.goalCreationMode || null,
      goalLibraryScope: config.goalLibraryScope || null,
      goalSegmentAttr: config.goalLibraryScope === 'by-attribute' ? (config.goalSegmentAttr || 'Department') : null,
      goalSegmentValues: config.goalLibraryScope === 'by-attribute'
        ? (config.goalSegmentValues || []).map((value) => sanitizeText(value?.name)).filter(Boolean)
        : [],
      goalKpiMode: config.goalKpiMode || null,
      goalEmployeeEdit: config.goalEmployeeEdit || null,
    });
  }
  return JSON.stringify({
    goalCreationMode: config?.goalCreationMode || null,
    goalLimitEnabled: config?.goalLimitEnabled === true,
    goalLimitScope: config?.goalLimitEnabled ? (config.goalLimitScope || null) : null,
    goalLimitAttr: config?.goalLimitEnabled && config.goalLimitScope === 'by-attribute' ? (config.goalLimitAttr || 'Department') : null,
    goalLimitMin: config?.goalLimitEnabled && config.goalLimitScope === 'common' ? Number(config.goalLimitMin) : null,
    goalLimitMax: config?.goalLimitEnabled && config.goalLimitScope === 'common' ? Number(config.goalLimitMax) : null,
    goalLimitValues: config?.goalLimitEnabled && config.goalLimitScope === 'by-attribute'
      ? (config.goalLimitValues || [])
          .map((value) => ({
            name: sanitizeText(value?.name),
            min: Number(value?.min),
            max: Number(value?.max),
          }))
          .filter((value) => value.name)
          .sort((left, right) => left.name.localeCompare(right.name))
      : [],
  });
}

function getGoalLibraryDataSnapshot(goalLibraryData) {
  if (!goalLibraryData) return null;
  const normalizeKpi = (kpi) => ({
    name: sanitizeText(kpi?.name),
    weight: String(kpi?.weight ?? '').trim(),
  });
  const normalizeKra = (kra) => ({
    name: sanitizeText(kra?.name),
    weight: String(kra?.weight ?? '').trim(),
    perspName: sanitizeText(kra?.perspName),
    kpis: (kra?.kpis || []).map(normalizeKpi),
  });
  if (!goalLibraryData.byAttr) {
    return JSON.stringify({ byAttr: false, attrLabel: null, data: (goalLibraryData.data || []).map(normalizeKra) });
  }
  return JSON.stringify({
    byAttr: true,
    attrLabel: goalLibraryData.attrLabel || null,
    data: Object.entries(goalLibraryData.data || {})
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([group, kras]) => [group, (kras || []).map(normalizeKra)]),
  });
}

function isGoalLibraryValid(config) {
  if (!config?.goalLibraryData) return false;
  const data = config.goalLibraryData;
  if (!data.byAttr) return Array.isArray(data.data) && data.data.length > 0;
  return Object.values(data.data || {}).some((group) => Array.isArray(group) && group.length > 0);
}

function isEmployeeSettingsValid(config) {
  return config?.managerLevels === 1 || config?.managerLevels === 2;
}

function getEmployeeSettingsSnapshot(config) {
  return JSON.stringify({
    managerLevels: config?.managerLevels,
    requireEmail: config?.requireEmail !== false,
  });
}

function getNavSteps(config) {
  const frameworkId = config?.frameworkId;
  const hasLibrary = config?.goalCreationMode === 'admin-library';
  if (frameworkId === 'bsc') {
    const steps = ['framework', 'perspectives', 'goals'];
    if (hasLibrary) steps.push('kra_library');
    steps.push('emp_settings', 'upload');
    return steps;
  }
  const steps = ['framework', 'goals'];
  if (hasLibrary) steps.push('kra_library');
  steps.push('limits', 'hierarchy', 'scale');
  if (frameworkId !== 'kra') steps.push('targets');
  steps.push('competencies', 'bellcurve', 'phases', 'emp_settings', 'upload');
  return steps;
}

function isStepComplete(stepId, config) {
  switch (stepId) {
    case 'framework':
      return !!config?.frameworkId && config.frameworkAppliedSnapshot === getFrameworkSnapshot(config);
    case 'perspectives': {
      const active = (config?.perspectives || []).filter((perspective) => !isPerspectiveRowEmpty(perspective));
      const total = active.reduce((sum, perspective) => sum + (Number(perspective.weight) || 0), 0);
      return active.length > 0 && total === 100 && active.every((perspective) => isPerspectiveRowComplete(perspective)) && config.perspectivesAppliedSnapshot === getPerspectivesSnapshot(config);
    }
    case 'goals':
      return isGoalSettingsValid(config) && config.goalsAppliedSnapshot === getGoalsSnapshot(config);
    case 'kra_library':
      return isGoalLibraryValid(config) && config.goalLibraryAppliedSnapshot === getGoalLibraryDataSnapshot(config.goalLibraryData);
    case 'emp_settings':
      return isEmployeeSettingsValid(config) && config.empSettingsAppliedSnapshot === getEmployeeSettingsSnapshot(config);
    case 'upload':
      return !!config?.employeeUploadData;
    case 'limits':
      return config?.minKRAs > 0 && config?.maxKRAs >= config?.minKRAs && !!config?.weightageOwnership;
    case 'hierarchy':
      return Array.isArray(config?.ratingLevels) && config.ratingLevels.length >= 1;
    case 'scale':
      return Number(config?.scalePoints) > 0;
    case 'targets':
    case 'competencies':
    case 'bellcurve':
    case 'phases':
      return true;
    default:
      return false;
  }
}

export function getStatusMetaFromPct(pct) {
  if (pct >= 100) return { status: 'Configured', statusBadgeClass: 'badge-green', setupColor: '#16A34A', actionLabel: 'Manage' };
  if (pct >= 50) return { status: 'In Progress', statusBadgeClass: 'badge-blue', setupColor: '#2563EB', actionLabel: 'Continue' };
  if (pct > 0) return { status: 'Setup Started', statusBadgeClass: 'badge-amber', setupColor: '#D97706', actionLabel: 'Continue' };
  return { status: 'Not Started', statusBadgeClass: 'badge-gray', setupColor: '#94A3B8', actionLabel: 'Start Setup' };
}

export function getOrganizationEmployeeCount(org) {
  const wizardState = readWizardState(org?.key);
  const uploadData = wizardState?.config?.employeeUploadData;
  if (!uploadData) return Number(org?.employees) || 0;
  if (Array.isArray(uploadData.employees)) return uploadData.employees.length;
  return Number(uploadData.count) || 0;
}

export function getOrganizationSetupMeta(org) {
  const wizardState = readWizardState(org?.key);
  if (!wizardState?.config) {
    const legacyPct = Number(org?.setupPct) || 0;
    return { pct: legacyPct, ...getStatusMetaFromPct(legacyPct), source: 'legacy' };
  }
  const steps = getNavSteps(wizardState.config);
  const completedCount = steps.filter((stepId) => isStepComplete(stepId, wizardState.config)).length;
  const floorCount = Math.max(0, Math.min(Number.isInteger(wizardState.step) ? wizardState.step : 0, Math.max(steps.length - 1, 0)));
  const progressCount = Math.max(completedCount, floorCount);
  const pct = steps.length ? Math.round((progressCount / steps.length) * 100) : 0;
  return { pct, ...getStatusMetaFromPct(pct), source: 'wizard' };
}

export function getOrgNameByKey(orgKey) {
  if (!orgKey || typeof window === 'undefined') return '';
  try {
    const raw = window.localStorage.getItem(APP_DATA_KEY);
    if (!raw) return '';
    const data = JSON.parse(raw);
    const org = Array.isArray(data.organizationsData) ? data.organizationsData.find((item) => item.key === orgKey) : null;
    return org?.name || '';
  } catch (_) {
    return '';
  }
}
