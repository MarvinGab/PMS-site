import { useEffect, useMemo, useState } from 'react';
import zaroLogo from '../../images/final zaro logo.png';

const EMP_SESSION_KEY = 'zarohr_emp_session';
const WIZARD_STATE_KEY = 'zarohr_pms_wizard_state_v1';
const APP_DATA_KEY = 'zarohr_app_data_v1';
const GOAL_WORKFLOW_KEY = 'zarohr_goal_workflow_v1';
const MESSAGES_KEY = 'zarohr_messages_v1';

const PHASES = [
  { id: 'goal-setting', label: 'Goal Setting', icon: '🎯' },
  { id: 'mid-year-review', label: 'Mid-Year Review', icon: '📊' },
  { id: 'self-evaluation', label: 'Self Evaluation', icon: '✍️' },
  { id: 'manager-rating', label: 'Manager Rating', icon: '👤' },
  { id: 'hr-review', label: 'HR Review', icon: '🔍' },
  { id: 'results-published', label: 'Results Published', icon: '🏆' },
];

const SCALE_DEFAULTS = {
  3: [{ n: 1, l: 'Below Expectations' }, { n: 2, l: 'Meets Expectations' }, { n: 3, l: 'Exceeds Expectations' }],
  4: [{ n: 1, l: 'Below Expectations' }, { n: 2, l: 'Meets Expectations' }, { n: 3, l: 'Exceeds Expectations' }, { n: 4, l: 'Outstanding' }],
  5: [{ n: 1, l: 'Needs Improvement' }, { n: 2, l: 'Below Expectations' }, { n: 3, l: 'Meets Expectations' }, { n: 4, l: 'Exceeds Expectations' }, { n: 5, l: 'Outstanding' }],
  10: Array.from({ length: 10 }, (_, i) => ({ n: i + 1, l: `Level ${i + 1}` })),
};

const SCALE_COLORS = ['#DC2626', '#F97316', '#FBBF24', '#84CC16', '#22C55E', '#10B981', '#14B8A6', '#3B82F6', '#8B5CF6', '#EC4899'];
const PERSPECTIVE_COLORS = ['#2563EB', '#16A34A', '#D97706', '#7C3AED', '#DC2626', '#0891B2'];

function uid(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeCode(value) {
  return String(value || '').trim().toLowerCase();
}

function sanitizeText(value) {
  return String(value || '').trim().replace(/\s+/g, ' ');
}

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function getWorkflowStorageKey(orgKey = '') {
  return `${GOAL_WORKFLOW_KEY}:${orgKey || 'default'}`;
}

function loadSession() {
  try {
    const raw = localStorage.getItem(EMP_SESSION_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function loadCurrentPhase(orgKey) {
  try {
    const raw = localStorage.getItem(APP_DATA_KEY);
    if (!raw) return 'goal-setting';
    const data = JSON.parse(raw);
    const org = (data.organizationsData || []).find((item) => item.key === orgKey);
    return org?.currentPhase || 'goal-setting';
  } catch {
    return 'goal-setting';
  }
}

function loadConfig() {
  try {
    const sessionRaw = localStorage.getItem(EMP_SESSION_KEY);
    const session = sessionRaw ? JSON.parse(sessionRaw) : null;
    const preferredOrgKey = session?.orgKey || '';
    if (preferredOrgKey) {
      const raw = localStorage.getItem(`${WIZARD_STATE_KEY}:${preferredOrgKey}`) || sessionStorage.getItem(`${WIZARD_STATE_KEY}:${preferredOrgKey}`);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed?.config) return parsed.config;
      }
    }
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (!key || !key.startsWith(WIZARD_STATE_KEY)) continue;
      const raw = localStorage.getItem(key);
      if (!raw) continue;
      const parsed = JSON.parse(raw);
      if (parsed?.config) return parsed.config;
    }
  } catch {
    return null;
  }
  return null;
}

function loadWorkflow(orgKey) {
  if (!orgKey) return { submissions: {}, notifications: [] };
  try {
    const raw = localStorage.getItem(getWorkflowStorageKey(orgKey));
    const parsed = raw ? JSON.parse(raw) : null;
    if (!parsed?.submissions) return { submissions: {}, notifications: [] };
    return {
      submissions: parsed.submissions || {},
      notifications: Array.isArray(parsed.notifications) ? parsed.notifications : [],
    };
  } catch {
    return { submissions: {}, notifications: [] };
  }
}

function saveWorkflow(orgKey, workflow) {
  if (!orgKey) return;
  try {
    localStorage.setItem(getWorkflowStorageKey(orgKey), JSON.stringify(workflow));
  } catch (_) {}
}

function getMessagesStorageKey(orgKey = '') {
  return `${MESSAGES_KEY}:${orgKey || 'default'}`;
}

function convKey(codeA, codeB) {
  return [normalizeCode(codeA), normalizeCode(codeB)].sort().join('::');
}

function loadMessages(orgKey) {
  if (!orgKey) return { conversations: {} };
  try {
    const raw = localStorage.getItem(getMessagesStorageKey(orgKey));
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed?.conversations ? parsed : { conversations: {} };
  } catch {
    return { conversations: {} };
  }
}

function saveMessages(orgKey, data) {
  if (!orgKey) return;
  try {
    localStorage.setItem(getMessagesStorageKey(orgKey), JSON.stringify(data));
    // Dispatch storage event for same-page live updates across tabs
    window.dispatchEvent(new StorageEvent('storage', {
      key: getMessagesStorageKey(orgKey),
      newValue: JSON.stringify(data),
    }));
  } catch (_) {}
}

function createNotification({
  type,
  recipientCode,
  senderCode = '',
  title,
  message,
  submissionCode = '',
}) {
  return {
    id: uid('notif'),
    type,
    recipientCode: normalizeCode(recipientCode),
    senderCode: normalizeCode(senderCode),
    submissionCode: normalizeCode(submissionCode),
    title,
    message,
    createdAt: new Date().toISOString(),
    read: false,
  };
}

function getEmployeeRecord(config, empCode) {
  const employees = config?.employeeUploadData?.employees || [];
  return employees.find((employee) => String(employee['Employee Code'] || '').trim() === String(empCode).trim()) || null;
}

function getManagerName(config, managerCode) {
  if (!managerCode) return null;
  const employees = config?.employeeUploadData?.employees || [];
  const manager = employees.find((employee) => String(employee['Employee Code'] || '').trim() === String(managerCode).trim());
  return manager ? String(manager['Employee Name'] || '').trim() : managerCode;
}

function getAssignedKRAs(config, employee) {
  const library = config?.goalLibraryData;
  if (!library) return [];
  if (!library.byAttr) return library.data || [];
  const attrLabel = library.attrLabel || config?.goalSegmentAttr || 'Department';
  const attrValue = String(employee?.[attrLabel] || employee?.assignedGoalLibraryKey || '').trim();
  if (!attrValue) return [];
  return library.data?.[attrValue] || [];
}

function createKpi(base = {}, source = 'employee') {
  return {
    id: base.id || uid('kpi'),
    name: sanitizeText(base.name || ''),
    weight: String(base.weight ?? '').trim(),
    target: sanitizeText(base.target || ''),
    source,
  };
}

function createKra(base = {}) {
  return {
    id: base.id || uid('kra'),
    name: sanitizeText(base.name || ''),
    weight: String(base.weight ?? '').trim(),
    perspName: sanitizeText(base.perspName || ''),
    kpis: (base.kpis || []).map((kpi) => createKpi(kpi, kpi.source || 'library')),
  };
}

// Resolve the effective access config from the new multi-group model.
// Returns an object with goalCreationMode, goalEmployeeEdit, goalKpiMode
// that can be spread over the raw config before passing to helpers.
function resolveGroupAccess(group) {
  if (!group) return null;
  const prefill = group.prefillType || null; // null | 'kras-only' | 'kra-kpi'
  const canEdit = group.canEditOwn !== false;

  if (!prefill) {
    // No pre-fill: employee creates from scratch (Open Canvas / Guided Scratch)
    return { goalCreationMode: 'employee-self', goalEmployeeEdit: 'edit-freely', goalKpiMode: group.libraryType || 'kra-kpi' };
  }
  if (!canEdit) {
    // Pre-filled, no editing allowed
    // kras-only → employee can add KPIs to the locked KRA structure
    // kra-kpi  → everything locked, just view and submit
    return {
      goalCreationMode: 'admin-library',
      goalEmployeeEdit: prefill === 'kra-kpi' ? 'locked' : 'add-kpis',
      goalKpiMode: prefill,
    };
  }
  // Pre-filled + can edit (Prefill+Customize / Prefill+Guided)
  return { goalCreationMode: 'admin-library', goalEmployeeEdit: 'edit-freely', goalKpiMode: prefill };
}

function buildInitialGoals(config, employee, group, libraries) {
  // New multi-group model: pre-fill from library when prefillType is set
  if (group?.prefillType && libraries) {
    // Use the routing attribute value as the slot key for library matching.
    // Group was already resolved upstream (by Group Name or attribute), so we just
    // need the right library slot within that group.
    const attrVal = group.segmentAttr ? String(employee?.[group.segmentAttr] || '').trim() : '';
    const libId = (group.libraryAssignments || []).find(
      (a) => String(a.slotKey || '').trim().toLowerCase() === attrVal.toLowerCase()
    )?.libraryId || group.libraryId;
    const lib = (libraries || []).find((l) => l.id === libId);
    if (lib) {
      return extractKrasFromLibrary(lib).map((kra) =>
        createKra({
          ...kra,
          kpis: group.prefillType === 'kra-kpi'
            ? (kra.kpis || []).map((kpi) => createKpi(kpi, 'library'))
            : [],
        })
      );
    }
    return [];
  }
  // Legacy model
  if (config?.goalCreationMode === 'admin-library') {
    return getAssignedKRAs(config, employee).map((kra) =>
      createKra({ ...kra, kpis: (kra.kpis || []).map((kpi) => ({ ...kpi, source: 'library' })) })
    );
  }
  return [];
}

function getGoalAccessMode(config) {
  if (config?.goalCreationMode === 'admin-library') {
    return config.goalEmployeeEdit || 'locked';
  }
  return 'edit-freely';
}

function getGoalLimits(config, employee) {
  if (!config?.goalLimitEnabled) return null;
  if (config.goalLimitScope === 'common') {
    return { min: Number(config.goalLimitMin) || 0, max: Number(config.goalLimitMax) || 0 };
  }
  if (config.goalLimitScope === 'by-attribute') {
    const attrLabel = config.goalLimitAttr || 'Department';
    const attrValue = String(employee?.[attrLabel] || '').trim();
    const match = (config.goalLimitValues || []).find((item) => sanitizeText(item.name).toLowerCase() === attrValue.toLowerCase());
    if (match) {
      return { min: Number(match.min) || 0, max: Number(match.max) || 0 };
    }
  }
  return null;
}

function formatDateTime(value) {
  if (!value) return '';
  try {
    return new Date(value).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
  } catch {
    return value;
  }
}

function getPerspectiveColor(kra, perspectives) {
  if (!kra?.perspName) return '#2563EB';
  const index = perspectives.findIndex((perspective) => perspective.name === kra.perspName);
  return index >= 0 ? (perspectives[index].color || PERSPECTIVE_COLORS[index % PERSPECTIVE_COLORS.length]) : '#2563EB';
}

function getSubmissionStatusMeta(record) {
  switch (record?.status) {
    case 'pending-manager':
      return { label: 'Awaiting manager approval', color: '#D97706', bg: '#FFF7ED', border: '#FED7AA' };
    case 'approved':
      return { label: 'Approved', color: '#16A34A', bg: '#F0FDF4', border: '#BBF7D0' };
    case 'sent-back':
      return { label: 'Changes requested', color: '#DC2626', bg: '#FEF2F2', border: '#FECACA' };
    default:
      return { label: 'Draft in progress', color: '#2563EB', bg: '#EFF6FF', border: '#BFDBFE' };
  }
}

function getGoalPlanMetrics(goals, config, accessMode) {
  const activeGoals = (goals || []).filter((goal) => sanitizeText(goal.name) || (goal.kpis || []).some((kpi) => sanitizeText(kpi.name)));
  const validGoalWeight = activeGoals.reduce((sum, goal) => {
    const weight = Number(goal.weight);
    return Number.isFinite(weight) && weight > 0 ? sum + weight : sum;
  }, 0);

  const shouldTrackKpis = config?.goalCreationMode === 'employee-self' || config?.goalKpiMode === 'kra-only' || config?.goalKpiMode === 'kra-kpi';
  const validKpiWeight = activeGoals.reduce((sum, goal) => {
    const goalWeight = Number(goal.weight);
    const kpiSum = (goal.kpis || []).reduce((inner, kpi) => {
      const weight = Number(kpi.weight);
      return Number.isFinite(weight) && weight > 0 ? inner + weight : inner;
    }, 0);
    if (Number.isFinite(goalWeight) && goalWeight > 0) {
      return sum + Math.min(goalWeight, kpiSum);
    }
    return sum + kpiSum;
  }, 0);

  const goalPct = Math.max(0, Math.min(100, Math.round(validGoalWeight)));
  const kpiPct = shouldTrackKpis ? Math.max(0, Math.min(100, Math.round(validKpiWeight))) : 100;
  const overall = shouldTrackKpis ? Math.round((goalPct + kpiPct) / 2) : goalPct;

  return {
    goalPct,
    kpiPct,
    overall,
    shouldTrackKpis,
  };
}

function groupGoalsByPerspective(goals, perspectives) {
  const lookup = new Map((perspectives || []).map((perspective, index) => [
    perspective.name,
    { color: perspective.color || PERSPECTIVE_COLORS[index % PERSPECTIVE_COLORS.length], order: index },
  ]));

  const groups = new Map();
  (goals || []).forEach((goal) => {
    const key = sanitizeText(goal.perspName) || 'Unassigned';
    if (!groups.has(key)) {
      const meta = lookup.get(key) || { color: '#64748B', order: Number.MAX_SAFE_INTEGER };
      groups.set(key, { perspective: key, color: meta.color, order: meta.order, goals: [] });
    }
    groups.get(key).goals.push(goal);
  });

  return Array.from(groups.values()).sort((left, right) => left.order - right.order || left.perspective.localeCompare(right.perspective));
}

function getGoalPlanValidation(goals, config, accessMode, limits, perspectives) {
  const errors = [];
  const activeGoals = (goals || []).filter((goal) => sanitizeText(goal.name) || (goal.kpis || []).some((kpi) => sanitizeText(kpi.name)));
  const isEditableStructure = config?.goalCreationMode === 'employee-self' || accessMode === 'edit-freely';
  const mustCreateKpis = config?.goalCreationMode === 'employee-self' || config?.goalKpiMode === 'kra-only' || accessMode === 'edit-freely';

  if (!activeGoals.length) {
    errors.push('Add at least one goal before submitting.');
  }

  if (limits && activeGoals.length) {
    if (limits.min > 0 && activeGoals.length < limits.min) {
      errors.push(`You need at least ${limits.min} goals for this setup.`);
    }
    if (limits.max > 0 && activeGoals.length > limits.max) {
      errors.push(`You can submit at most ${limits.max} goals for this setup.`);
    }
  }

  const kraWeights = [];
  activeGoals.forEach((goal, index) => {
    const goalName = sanitizeText(goal.name);
    const goalWeight = Number(goal.weight);
    const kpis = goal.kpis || [];
    const editableKpis = kpis.filter((kpi) => config?.goalCreationMode === 'employee-self' || accessMode === 'edit-freely' || config?.goalKpiMode === 'kra-only' || kpi.source !== 'library');

    if (!goalName) {
      errors.push(`Goal ${index + 1} needs a name.`);
    }

    if ((isEditableStructure || config?.goalCreationMode === 'employee-self') && (!Number.isFinite(goalWeight) || goalWeight <= 0)) {
      errors.push(`Goal "${goalName || `#${index + 1}`}" needs a valid positive weight.`);
    }

    if (perspectives.length > 0 && (isEditableStructure || config?.goalCreationMode === 'employee-self') && !sanitizeText(goal.perspName)) {
      errors.push(`Goal "${goalName || `#${index + 1}`}" needs a perspective.`);
    }

    if (mustCreateKpis && kpis.length === 0) {
      errors.push(`Add at least one KPI under "${goalName || `Goal ${index + 1}`}".`);
    }

    if (config?.goalKpiMode === 'kra-kpi' && accessMode === 'add-kpis') {
      editableKpis.forEach((kpi) => {
        if (!sanitizeText(kpi.name)) errors.push(`Suggested KPI under "${goalName || `Goal ${index + 1}`}" needs a name.`);
      });
    } else {
      let kpiWeightTotal = 0;
      kpis.forEach((kpi) => {
        const kpiName = sanitizeText(kpi.name);
        const kpiWeight = Number(kpi.weight);
        if (!kpiName) errors.push(`A KPI under "${goalName || `Goal ${index + 1}`}" is missing a name.`);
        if (!Number.isFinite(kpiWeight) || kpiWeight <= 0) {
          errors.push(`KPI "${kpiName || 'Untitled KPI'}" under "${goalName || `Goal ${index + 1}`}" needs a valid positive weight.`);
        } else {
          kpiWeightTotal += kpiWeight;
        }
      });
      if (kpis.length > 0 && Number.isFinite(goalWeight) && Math.abs(kpiWeightTotal - goalWeight) > 0.01) {
        errors.push(`KPI weights under "${goalName || `Goal ${index + 1}`}" must sum to ${goalWeight}%.`);
      }
    }

    if (Number.isFinite(goalWeight)) kraWeights.push(goalWeight);
  });

  if ((isEditableStructure || config?.goalCreationMode === 'employee-self') && kraWeights.length > 0) {
    const total = kraWeights.reduce((sum, value) => sum + value, 0);
    if (Math.abs(total - 100) > 0.01) {
      errors.push(`Goal weights must sum to 100%. Current total is ${total.toFixed(1)}%.`);
    }
  }

  return {
    errors,
    canSubmit: errors.length === 0,
  };
}

function buildEmptyKra(perspectives) {
  return createKra({
    name: '',
    weight: '',
    perspName: perspectives[0]?.name || '',
    kpis: [],
  });
}

function buildEmptyKpi(source = 'employee') {
  return createKpi({ name: '', weight: '', target: '' }, source);
}

// Find the configured goal group + library assigned to this employee (new multi-group model)
function getEmployeeGroupAndLibrary(config, employee) {
  const groups = config?.goalGroups;
  const libraries = config?.goalLibraries;
  if (!groups || !libraries || !employee) return null;

  // Helper: given a resolved group, find the correct library via slotKey matching.
  function resolveLibrary(group) {
    if (!group.hasLibrary) return null;
    const attrVal = group.segmentAttr ? String(employee[group.segmentAttr] || '').trim() : '';
    const libId = (group.libraryAssignments || []).find(
      (a) => String(a.slotKey || '').trim().toLowerCase() === attrVal.toLowerCase()
    )?.libraryId || group.libraryId;
    if (!libId) return null;
    return libraries.find((l) => l.id === libId) || null;
  }

  // Prefer explicit Group Name (written into employee record during upload).
  const groupNameVal = String(employee['Group Name'] || '').trim();
  if (groupNameVal) {
    const namedGroup = groups.find(
      (g) => String(g.name || '').trim().toLowerCase() === groupNameVal.toLowerCase()
    );
    if (namedGroup) {
      const library = resolveLibrary(namedGroup);
      if (library) return { group: namedGroup, library };
    }
  }

  // Fall back to attribute-based matching.
  for (const group of groups) {
    if (!group.hasLibrary) continue;
    const attrVal = String(employee[group.segmentAttr] || '').trim();
    if (!attrVal) continue;
    const inGroup = (group.segmentValues || []).some(
      (v) => v.trim().toLowerCase() === attrVal.toLowerCase()
    );
    if (!inGroup) continue;
    const library = resolveLibrary(group);
    if (library) return { group, library };
  }
  return null;
}

// Flatten a library's perspectives into a flat KRA list for display
function extractKrasFromLibrary(library) {
  return (library?.perspectives || []).flatMap((persp) =>
    (persp.kras || []).map((kra) => ({
      ...kra,
      perspName: kra.perspName || persp.name,
      weight: kra.suggestedWeight || kra.weight || '',
      kpis: (kra.kpis || []).map((kpi) => ({
        id: kpi.id || uid('kpi'),
        name: kpi.name || '',
        weight: kpi.suggestedWeight || kpi.weight || '',
        target: kpi.target || '',
        source: 'library',
      })),
    }))
  );
}

const REWRITE_VERBS = {
  improve: ['Enhance', 'Strengthen', 'Elevate'],
  increase: ['Maximize', 'Scale', 'Accelerate'],
  develop: ['Build', 'Cultivate', 'Champion'],
  manage: ['Lead', 'Oversee', 'Drive'],
  create: ['Develop', 'Design', 'Launch'],
  ensure: ['Guarantee', 'Maintain', 'Strengthen'],
  reduce: ['Minimize', 'Optimize', 'Streamline'],
  support: ['Enable', 'Empower', 'Champion'],
  build: ['Develop', 'Establish', 'Architect'],
  drive: ['Lead', 'Accelerate', 'Advance'],
};

function generateRewriteSuggestions(text) {
  const clean = (text || '').trim();
  if (!clean || clean.length < 4) return [];
  const words = clean.split(' ');
  const firstWord = words[0].toLowerCase();
  const rest = words.slice(1).join(' ');
  const suggestions = new Set();
  const verbMap = REWRITE_VERBS[firstWord];
  if (verbMap && rest) verbMap.slice(0, 2).forEach((v) => suggestions.add(`${v} ${rest}`));
  const lower = clean.toLowerCase();
  const outcomeWord =
    lower.includes('revenue') || lower.includes('sales') || lower.includes('growth')
      ? 'Deliver'
      : lower.includes('team') || lower.includes('employee') || lower.includes('culture')
      ? 'Champion'
      : 'Achieve';
  if (!lower.startsWith('achieve') && !lower.startsWith('deliver') && !lower.startsWith('champion')) {
    suggestions.add(`${outcomeWord} ${clean.charAt(0).toLowerCase() + clean.slice(1)}`);
  }
  if (suggestions.size < 3 && !clean.includes('%')) {
    suggestions.add(`${clean} with measurable outcomes`);
  }
  return Array.from(suggestions).slice(0, 3);
}

function GoalLibraryPanel({ kras, libraryType, libraryName, canAdd, onAdd }) {
  const [expanded, setExpanded] = useState(false);
  const shown = expanded ? kras : kras.slice(0, 5);

  return (
    <div style={{
      marginBottom: 22,
      background: 'linear-gradient(135deg,#EEF4FF 0%,#F5F3FF 100%)',
      border: '1.5px solid #C7D2FE',
      borderRadius: 16,
      padding: '18px 20px',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 14, flexWrap: 'wrap' }}>
        <div>
          <div style={{ fontSize: 10.5, fontWeight: 800, color: '#4F46E5', letterSpacing: '.08em', textTransform: 'uppercase', marginBottom: 3 }}>
            📚 Goal Library
          </div>
          <div style={{ fontSize: 15.5, fontWeight: 700, color: '#1E1B4B' }}>{libraryName}</div>
          <div style={{ fontSize: 12, color: '#6B7280', marginTop: 2 }}>
            {kras.length} KRA{kras.length !== 1 ? 's' : ''} available
            {libraryType === 'kra-kpi' ? ' · includes KPIs' : ' · KRA only'}
          </div>
        </div>
        <span style={{ fontSize: 11.5, fontWeight: 700, color: '#4338CA', background: '#EEF2FF', padding: '4px 12px', borderRadius: 999, border: '1px solid #C7D2FE' }}>
          {libraryType === 'kra-kpi' ? '📊 KRA + KPI' : '📌 KRA only'}
        </span>
      </div>

      <div style={{ display: 'flex', gap: 10, overflowX: 'auto', paddingBottom: 6 }}>
        {shown.map((kra) => (
          <div
            key={kra.id || kra.name}
            style={{
              flex: '0 0 210px',
              background: '#fff',
              border: '1.5px solid #DDE4FF',
              borderRadius: 12,
              padding: '12px 14px',
              display: 'flex',
              flexDirection: 'column',
              gap: 5,
              boxShadow: '0 2px 8px rgba(79,70,229,.06)',
            }}
          >
            {kra.perspName && (
              <div style={{ fontSize: 10, fontWeight: 700, color: '#4F46E5', textTransform: 'uppercase', letterSpacing: '.06em' }}>
                {kra.perspName}
              </div>
            )}
            <div style={{ fontSize: 13, fontWeight: 700, color: '#0F172A', lineHeight: 1.4, flex: 1 }}>
              {kra.name}
            </div>
            {kra.desc && (
              <div style={{ fontSize: 11.5, color: '#64748B', lineHeight: 1.4 }}>
                {kra.desc.length > 60 ? `${kra.desc.slice(0, 60)}…` : kra.desc}
              </div>
            )}
            <div style={{ display: 'flex', gap: 5, alignItems: 'center', marginTop: 2 }}>
              {kra.weight ? (
                <span style={{ fontSize: 11, fontWeight: 600, color: '#4F46E5', background: '#EEF2FF', padding: '2px 7px', borderRadius: 999 }}>
                  {kra.weight}%
                </span>
              ) : null}
              {libraryType === 'kra-kpi' && (kra.kpis || []).length > 0 && (
                <span style={{ fontSize: 11, color: '#64748B' }}>
                  {kra.kpis.length} KPI{kra.kpis.length !== 1 ? 's' : ''}
                </span>
              )}
            </div>
            {canAdd && (
              <button
                type="button"
                onClick={() => onAdd(kra)}
                style={{
                  marginTop: 6,
                  padding: '6px',
                  borderRadius: 8,
                  border: '1px solid #C7D2FE',
                  background: '#EEF2FF',
                  color: '#4338CA',
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                  fontSize: 12,
                  fontWeight: 700,
                }}
              >
                + Add to plan
              </button>
            )}
          </div>
        ))}
      </div>

      {kras.length > 5 && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          style={{ marginTop: 12, padding: '5px 14px', borderRadius: 999, border: '1px solid #C7D2FE', background: 'transparent', color: '#4F46E5', cursor: 'pointer', fontFamily: 'inherit', fontSize: 12, fontWeight: 600 }}
        >
          {expanded ? '↑ Show fewer' : `↓ Show all ${kras.length}`}
        </button>
      )}
    </div>
  );
}

function EmptyState({ title, subtitle }) {
  return (
    <div style={{ textAlign: 'center', padding: '60px 20px', color: '#9CA3AF' }}>
      <div style={{ fontSize: 42, marginBottom: 12 }}>📋</div>
      <div style={{ fontSize: 16, fontWeight: 700, color: '#374151', marginBottom: 6 }}>{title}</div>
      <div style={{ fontSize: 13.5 }}>{subtitle}</div>
    </div>
  );
}

export default function EmployeePage() {
  const session = useMemo(loadSession, []);
  const config = useMemo(loadConfig, []);
  const currentPhase = useMemo(() => loadCurrentPhase(session?.orgKey || ''), [session]);
  const [workflow, setWorkflow] = useState(() => loadWorkflow(session?.orgKey || ''));
  const [activeSection, setActiveSection] = useState('goals');
  const [selfRatings, setSelfRatings] = useState({});
  const [selfEvalSubmitted, setSelfEvalSubmitted] = useState(false);
  const [goalSubmitError, setGoalSubmitError] = useState('');
  const [managerNotes, setManagerNotes] = useState({});
  const [dragGoalId, setDragGoalId] = useState(null);
  const [dragOverGoalId, setDragOverGoalId] = useState(null);
  const [rewritingGoalId, setRewritingGoalId] = useState(null);
  const [rewriteSuggestions, setRewriteSuggestions] = useState([]);
  const [messagesData, setMessagesData] = useState(() => loadMessages(session?.orgKey || ''));
  const [activeConversation, setActiveConversation] = useState(null);
  const [messageInput, setMessageInput] = useState('');

  const employee = useMemo(() => session && config ? getEmployeeRecord(config, session.empCode) : null, [session, config]);
  const managerCode = String(employee?.['Reporting Manager Code'] || session?.managerCode || '').trim();
  const managerName = useMemo(() => config && managerCode ? getManagerName(config, managerCode) : null, [config, managerCode]);
  const employeeCodeKey = normalizeCode(session?.empCode);
  const perspectives = useMemo(() => (config?.perspectives || []).filter((item) => item?.name && Number(item?.weight) > 0), [config]);

  // Find which configured group this employee belongs to (new multi-group model)
  const employeeGroup = useMemo(() => {
    const groups = config?.goalGroups;
    if (!groups || !employee) return null;
    const explicitGroupName = String(employee?.assignedGoalGroupName || employee?.['Group Name'] || '').trim();
    if (explicitGroupName) {
      const namedGroup = groups.find((group) => String(group?.name || '').trim().toLowerCase() === explicitGroupName.toLowerCase());
      if (namedGroup) return namedGroup;
    }
    for (const group of groups) {
      const attrVal = String(employee[group.segmentAttr] || '').trim();
      if (!attrVal) continue;
      if ((group.segmentValues || []).some((value) => String(value?.name || value || '').trim().toLowerCase() === attrVal.toLowerCase())) {
        return group;
      }
    }
    return null;
  }, [config, employee]);

  // Derive effective goalCreationMode / goalEmployeeEdit / goalKpiMode from the group model,
  // falling back to whatever the wizard stored directly in config.
  const effectiveConfig = useMemo(() => {
    const overrides = resolveGroupAccess(employeeGroup);
    return overrides ? { ...config, ...overrides } : config;
  }, [employeeGroup, config]);

  const accessMode = useMemo(() => getGoalAccessMode(effectiveConfig), [effectiveConfig]);
  const currentScale = useMemo(() => SCALE_DEFAULTS[config?.scalePoints] || SCALE_DEFAULTS[5], [config]);
  const phaseIndex = PHASES.findIndex((phase) => phase.id === currentPhase);

  useEffect(() => {
    if (session?.orgKey) {
      setWorkflow(loadWorkflow(session.orgKey));
    }
  }, [session?.orgKey]);

  useEffect(() => {
    if (session?.orgKey) {
      saveWorkflow(session.orgKey, workflow);
    }
  }, [session?.orgKey, workflow]);

  useEffect(() => {
    if (!session || !config || !employeeCodeKey || currentPhase !== 'goal-setting') return;
    setWorkflow((prev) => {
      const current = prev?.submissions?.[employeeCodeKey];
      if (current) {
        const patched = {
          ...current,
          employeeCode: session.empCode,
          employeeName: session.name || employee?.['Employee Name'] || current.employeeName,
          managerCode,
        };
        if (JSON.stringify(patched) === JSON.stringify(current)) return prev;
        return {
          ...prev,
          submissions: {
            ...(prev?.submissions || {}),
            [employeeCodeKey]: patched,
          },
        };
      }

      return {
        ...prev,
        submissions: {
          ...(prev?.submissions || {}),
          [employeeCodeKey]: {
            employeeCode: session.empCode,
            employeeName: session.name || employee?.['Employee Name'] || session.empCode,
            managerCode,
            status: 'draft',
            goals: buildInitialGoals(config, employee, employeeGroup, config?.goalLibraries),
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        },
      };
    });
  }, [session, config, employee, employeeCodeKey, currentPhase, managerCode, employeeGroup]);

  useEffect(() => {
    if (!session) {
      window.location.hash = '#login';
    }
  }, [session]);

  // Live messaging: reload messages from storage when another tab writes
  useEffect(() => {
    if (!session?.orgKey) return;
    const key = getMessagesStorageKey(session.orgKey);
    function onStorage(e) {
      if (e.key === key) {
        setMessagesData(loadMessages(session.orgKey));
      }
    }
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [session?.orgKey]);

  if (!session) {
    return null;
  }

  const employeeName = session.name || employee?.['Employee Name'] || `Employee ${session.empCode}`;
  const employeeDesignation = session.designation || employee?.Designation || employee?.[config?.goalSegmentAttr] || '';
  const mySubmission = workflow?.submissions?.[employeeCodeKey] || null;
  const myGoals = mySubmission?.goals || [];
  const goalMetrics = getGoalPlanMetrics(myGoals, effectiveConfig, accessMode);
  const myStatusMeta = getSubmissionStatusMeta(mySubmission);
  const limits = getGoalLimits(config, employee);
  const myValidation = getGoalPlanValidation(myGoals, effectiveConfig, accessMode, limits, perspectives);
  const notifications = (workflow?.notifications || []).filter((notification) => notification.recipientCode === employeeCodeKey)
    .sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime());
  const employees = config?.employeeUploadData?.employees || [];
  const directReports = employees.filter((item) => normalizeCode(item['Reporting Manager Code']) === employeeCodeKey);
  const pendingApprovals = Object.values(workflow?.submissions || {}).filter(
    (submission) => normalizeCode(submission.managerCode) === employeeCodeKey && submission.status === 'pending-manager'
  );
  const perspectiveGroups = groupGoalsByPerspective(myGoals, perspectives);
  const canEditGoalPlan = currentPhase === 'goal-setting' && mySubmission && !['pending-manager', 'approved'].includes(mySubmission.status);
  const canAddKra = canEditGoalPlan && (effectiveConfig?.goalCreationMode === 'employee-self' || accessMode === 'edit-freely');
  const canEditKraFields = canAddKra;
  const canAddKpi = canEditGoalPlan && (effectiveConfig?.goalCreationMode === 'employee-self' || accessMode === 'edit-freely' || accessMode === 'add-kpis');
  const canEditExistingKpi = canEditGoalPlan && (effectiveConfig?.goalCreationMode === 'employee-self' || accessMode === 'edit-freely' || (accessMode === 'add-kpis' && effectiveConfig?.goalKpiMode === 'kra-only'));
  const hasKpis = myGoals.some((goal) => (goal.kpis || []).length > 0);

  const totalRatable = hasKpis
    ? myGoals.reduce((sum, goal) => sum + (goal.kpis || []).length, 0)
    : myGoals.length;
  const totalRated = Object.keys(selfRatings).filter((key) => selfRatings[key] > 0).length;
  const selfEvalPct = totalRatable > 0 ? Math.round((totalRated / totalRatable) * 100) : 0;

  function logout() {
    try {
      localStorage.removeItem(EMP_SESSION_KEY);
    } catch (_) {}
    window.location.hash = '#login';
  }

  function updateMySubmission(mutator) {
    setWorkflow((prev) => {
      const base = prev?.submissions?.[employeeCodeKey] || {
        employeeCode: session.empCode,
        employeeName,
        managerCode,
        status: 'draft',
        goals: buildInitialGoals(config, employee, employeeGroup, config?.goalLibraries),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      const nextRecord = mutator(deepClone(base));
      return {
        ...prev,
        submissions: {
          ...(prev?.submissions || {}),
          [employeeCodeKey]: {
            ...nextRecord,
            updatedAt: new Date().toISOString(),
          },
        },
      };
    });
  }

  function addNotification(notification) {
    setWorkflow((prev) => ({
      submissions: prev?.submissions || {},
      notifications: [notification, ...(prev?.notifications || [])],
    }));
  }

  function updateGoal(goalId, field, value) {
    updateMySubmission((record) => {
      record.goals = (record.goals || []).map((goal) => (
        goal.id === goalId ? { ...goal, [field]: field === 'weight' ? String(value) : value } : goal
      ));
      return record;
    });
  }

  function addGoal() {
    updateMySubmission((record) => {
      record.goals = [...(record.goals || []), buildEmptyKra(perspectives)];
      return record;
    });
  }

  function removeGoal(goalId) {
    updateMySubmission((record) => {
      record.goals = (record.goals || []).filter((goal) => goal.id !== goalId);
      return record;
    });
  }

  function addKpi(goalId) {
    const source = config?.goalCreationMode === 'admin-library' && config?.goalKpiMode === 'kra-kpi' && accessMode === 'add-kpis'
      ? 'employee'
      : 'employee';
    updateMySubmission((record) => {
      record.goals = (record.goals || []).map((goal) => (
        goal.id === goalId
          ? { ...goal, kpis: [...(goal.kpis || []), buildEmptyKpi(source)] }
          : goal
      ));
      return record;
    });
  }

  function updateKpi(goalId, kpiId, field, value) {
    updateMySubmission((record) => {
      record.goals = (record.goals || []).map((goal) => (
        goal.id === goalId
          ? {
              ...goal,
              kpis: (goal.kpis || []).map((kpi) => (
                kpi.id === kpiId ? { ...kpi, [field]: field === 'weight' ? String(value) : value } : kpi
              )),
            }
          : goal
      ));
      return record;
    });
  }

  function removeKpi(goalId, kpiId) {
    updateMySubmission((record) => {
      record.goals = (record.goals || []).map((goal) => (
        goal.id === goalId
          ? { ...goal, kpis: (goal.kpis || []).filter((kpi) => kpi.id !== kpiId) }
          : goal
      ));
      return record;
    });
  }

  function reorderGoals(fromId, toId) {
    updateMySubmission((record) => {
      const goals = [...(record.goals || [])];
      const fromIdx = goals.findIndex((g) => g.id === fromId);
      const toIdx = goals.findIndex((g) => g.id === toId);
      if (fromIdx === -1 || toIdx === -1) return record;
      const [moved] = goals.splice(fromIdx, 1);
      goals.splice(toIdx, 0, moved);
      record.goals = goals;
      return record;
    });
  }

  function submitGoals() {
    if (!myValidation.canSubmit) {
      setGoalSubmitError(myValidation.errors[0] || 'Complete your goals before submitting.');
      return;
    }

    setGoalSubmitError('');
    const submittedAt = new Date().toISOString();
    updateMySubmission((record) => {
      const noManager = !record.managerCode;
      return {
        ...record,
        status: noManager ? 'approved' : 'pending-manager',
        submittedAt,
        approvedAt: noManager ? submittedAt : record.approvedAt,
        managerDecisionAt: noManager ? submittedAt : null,
        managerNote: noManager ? 'No manager assigned. Goals marked approved automatically.' : '',
      };
    });
    if (managerCode) {
      addNotification(createNotification({
        type: 'goal-submitted',
        recipientCode: managerCode,
        senderCode: session.empCode,
        submissionCode: session.empCode,
        title: `${employeeName} submitted goals`,
        message: `${employeeName} sent a goal plan for your approval.`,
      }));
    }
  }

  function reviewSubmission(employeeCode, decision) {
    const note = sanitizeText(managerNotes[employeeCode] || '');
    setWorkflow((prev) => {
      const targetKey = normalizeCode(employeeCode);
      const current = prev?.submissions?.[targetKey];
      if (!current) return prev;
      return {
        ...prev,
        submissions: {
          ...(prev?.submissions || {}),
          [targetKey]: {
            ...current,
            status: decision === 'approve' ? 'approved' : 'sent-back',
            managerDecisionAt: new Date().toISOString(),
            approvedAt: decision === 'approve' ? new Date().toISOString() : current.approvedAt,
            managerApprovedBy: session.empCode,
            managerNote: note,
          },
        },
      };
    });
    setManagerNotes((prev) => ({ ...prev, [employeeCode]: '' }));
    addNotification(createNotification({
      type: decision === 'approve' ? 'goal-approved' : 'goal-rejected',
      recipientCode: employeeCode,
      senderCode: session.empCode,
      submissionCode: employeeCode,
      title: decision === 'approve' ? 'Goals approved' : 'Goals need updates',
      message: decision === 'approve'
        ? `${employeeName} approved your goal plan.`
        : `${employeeName} requested changes to your goal plan.${note ? ` Note: ${note}` : ''}`,
    }));
  }

  function sendReminder(report) {
    const reportName = String(report['Employee Name'] || report['Employee Code'] || 'Employee').trim();
    addNotification(createNotification({
      type: 'goal-reminder',
      recipientCode: report['Employee Code'],
      senderCode: session.empCode,
      submissionCode: report['Employee Code'],
      title: 'Goal-setting reminder',
      message: `${employeeName} asked you to complete your goal-setting submission.`,
    }));
  }

  function sendMessage(toCode, content) {
    const text = (content || '').trim();
    if (!text || !toCode) return;
    const ck = convKey(session.empCode, toCode);
    const msg = {
      id: uid('msg'),
      from: normalizeCode(session.empCode),
      content: text,
      ts: new Date().toISOString(),
      read: false,
    };
    setMessagesData((prev) => {
      const conv = prev.conversations[ck] || { participants: [normalizeCode(session.empCode), normalizeCode(toCode)], messages: [] };
      const next = {
        ...prev,
        conversations: {
          ...prev.conversations,
          [ck]: { ...conv, messages: [...conv.messages, msg] },
        },
      };
      saveMessages(session.orgKey, next);
      return next;
    });
  }

  function markConversationRead(toCode) {
    const ck = convKey(session.empCode, toCode);
    setMessagesData((prev) => {
      const conv = prev.conversations[ck];
      if (!conv) return prev;
      const myCode = normalizeCode(session.empCode);
      const updated = { ...conv, messages: conv.messages.map((m) => m.from !== myCode ? { ...m, read: true } : m) };
      const next = { ...prev, conversations: { ...prev.conversations, [ck]: updated } };
      saveMessages(session.orgKey, next);
      return next;
    });
  }

  function setRating(goalName, kpiName, value) {
    const key = kpiName ? `${goalName}::${kpiName}` : goalName;
    setSelfRatings((prev) => ({ ...prev, [key]: value }));
  }

  function getRating(goalName, kpiName) {
    const key = kpiName ? `${goalName}::${kpiName}` : goalName;
    return selfRatings[key] || 0;
  }

  // Count unread messages for this user
  const unreadMsgCount = Object.values(messagesData.conversations || {}).reduce((sum, conv) => {
    return sum + (conv.messages || []).filter((m) => m.from !== employeeCodeKey && !m.read).length;
  }, 0);

  const nav = currentPhase === 'goal-setting'
    ? [
        { id: 'goals', label: 'My Goals' },
        ...(directReports.length > 0 ? [{ id: 'team', label: `My Team (${directReports.length})` }] : []),
        ...(directReports.length > 0 ? [{ id: 'approvals', label: `Approvals (${pendingApprovals.length})` }] : []),
        { id: 'messages', label: unreadMsgCount > 0 ? `Messages (${unreadMsgCount})` : 'Messages' },
        { id: 'notifications', label: `Notifications (${notifications.length})` },
        { id: 'profile', label: 'My Profile' },
      ]
    : [
        { id: 'goals', label: 'My Goals' },
        ...(currentPhase === 'self-evaluation' ? [{ id: 'scale', label: 'Rating Scale' }] : []),
        { id: 'messages', label: unreadMsgCount > 0 ? `Messages (${unreadMsgCount})` : 'Messages' },
        { id: 'notifications', label: `Notifications (${notifications.length})` },
        { id: 'profile', label: 'My Profile' },
      ];

  function renderGoalSetting() {
    if (!mySubmission) {
      return <EmptyState title="Preparing your goal plan" subtitle="Your assigned library and permissions are loading." />;
    }

    // Determine goal library — try new multi-group model first, then legacy
    const empGroupLib = getEmployeeGroupAndLibrary(config, employee);
    const libraryKras = empGroupLib
      ? extractKrasFromLibrary(empGroupLib.library)
      : getAssignedKRAs(config, employee).map((kra) => ({
          ...kra,
          perspName: kra.perspName || '',
          kpis: (kra.kpis || []).map((kpi) => ({ ...kpi, source: 'library' })),
        }));
    const groupLibType = empGroupLib?.group?.libraryType || 'kra-kpi';

    function addFromLibrary(kra) {
      const libKpis = groupLibType === 'kra-only' ? [] : (kra.kpis || []);
      updateMySubmission((record) => {
        record.goals = [
          ...(record.goals || []),
          createKra({ ...kra, id: uid('kra'), kpis: libKpis.map((kpi) => createKpi(kpi, 'library')) }),
        ];
        return record;
      });
    }

    return (
      <div>
        {/* Goal Library Panel — top center */}
        {libraryKras.length > 0 && (
          <GoalLibraryPanel
            kras={libraryKras}
            libraryType={groupLibType}
            libraryName={empGroupLib?.library?.name || 'Assigned Goal Library'}
            canAdd={canEditGoalPlan}
            onAdd={addFromLibrary}
          />
        )}

        {/* Status Banner */}
        <div style={{ marginBottom: 18, padding: '14px 18px', background: myStatusMeta.bg, border: `1.5px solid ${myStatusMeta.border}`, borderRadius: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
            <div>
              <div style={{ fontSize: 13.5, fontWeight: 700, color: myStatusMeta.color, marginBottom: 4 }}>{myStatusMeta.label}</div>
              <div style={{ fontSize: 12.5, color: '#475569', lineHeight: 1.5 }}>
                {mySubmission.status === 'pending-manager' && `Submitted on ${formatDateTime(mySubmission.submittedAt)}. ${managerName ? `${managerName} can now approve or send back changes.` : 'Waiting for approval.'}`}
                {mySubmission.status === 'approved' && `Approved${mySubmission.managerApprovedBy ? ` by ${getManagerName(config, mySubmission.managerApprovedBy) || mySubmission.managerApprovedBy}` : ''} on ${formatDateTime(mySubmission.managerDecisionAt || mySubmission.approvedAt)}.`}
                {mySubmission.status === 'sent-back' && `Your manager requested changes${mySubmission.managerDecisionAt ? ` on ${formatDateTime(mySubmission.managerDecisionAt)}` : ''}. Update the plan and resubmit.`}
                {mySubmission.status === 'draft' && (
                  effectiveConfig?.goalCreationMode === 'admin-library'
                    ? accessMode === 'locked'
                      ? 'Review the assigned goals and submit them for manager approval.'
                      : accessMode === 'add-kpis'
                        ? 'Complete the KPI details allowed for you, then submit the plan to your manager.'
                        : 'Customize the goal plan as needed, then submit it for manager approval.'
                    : 'Create your goals for the cycle and submit them for manager approval.'
                )}
              </div>
              {mySubmission.managerNote ? (
                <div style={{ marginTop: 8, fontSize: 12.5, color: '#7C2D12', background: '#FFF7ED', border: '1px solid #FED7AA', borderRadius: 8, padding: '8px 10px' }}>
                  Manager note: {mySubmission.managerNote}
                </div>
              ) : null}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              {limits ? (
                <div style={{ padding: '6px 10px', borderRadius: 999, background: '#FFFFFF', border: '1px solid #E2E8F0', fontSize: 12, color: '#475569', fontWeight: 600 }}>
                  Goal limit: {limits.min || 0} – {limits.max || '∞'}
                </div>
              ) : null}
              <div style={{ padding: '6px 10px', borderRadius: 999, background: '#FFFFFF', border: '1px solid #E2E8F0', fontSize: 12, color: '#475569', fontWeight: 600 }}>
                Access: {effectiveConfig?.goalCreationMode === 'admin-library'
                  ? accessMode === 'locked' ? 'View and submit'
                    : accessMode === 'add-kpis' ? (effectiveConfig?.goalKpiMode === 'kra-only' ? 'Add KPIs' : 'Suggest extra KPIs')
                    : 'Edit and add freely'
                  : 'Create goals freely'}
              </div>
            </div>
          </div>
        </div>

        {goalSubmitError ? (
          <div style={{ marginBottom: 16, fontSize: 12.5, color: '#B91C1C', background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: 10, padding: '10px 12px' }}>
            {goalSubmitError}
          </div>
        ) : null}

        {pendingApprovals.length > 0 && activeSection === 'goals' ? (
          <div style={{ marginBottom: 16, padding: '12px 16px', background: '#FFFBEB', border: '1px solid #FDE68A', borderRadius: 10, fontSize: 12.5, color: '#92400E' }}>
            You have {pendingApprovals.length} goal approval {pendingApprovals.length === 1 ? 'request' : 'requests'} waiting in the Approvals tab.
          </div>
        ) : null}

        {/* Progress */}
        <div style={{ marginBottom: 18, padding: '16px 18px', background: '#fff', borderRadius: 12, border: '1.5px solid #E9EDF2' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', alignItems: 'center', marginBottom: 10 }}>
            <div>
              <div style={{ fontSize: 13, fontWeight: 700, color: '#0F172A' }}>Goal plan completion</div>
              <div style={{ fontSize: 12.5, color: '#64748B' }}>
                Goal weights: {goalMetrics.goalPct}% / 100
                {goalMetrics.shouldTrackKpis ? ` · KPI coverage: ${goalMetrics.kpiPct}% / 100` : ''}
              </div>
            </div>
            <div style={{ fontSize: 24, fontWeight: 800, color: goalMetrics.overall === 100 ? '#16A34A' : '#2563EB' }}>{goalMetrics.overall}%</div>
          </div>
          <div style={{ height: 10, background: '#E2E8F0', borderRadius: 999, overflow: 'hidden', marginBottom: 10 }}>
            <div style={{ height: '100%', width: `${goalMetrics.overall}%`, background: goalMetrics.overall === 100 ? 'linear-gradient(90deg,#16A34A,#22C55E)' : 'linear-gradient(90deg,#2563EB,#4F46E5)', borderRadius: 999, transition: 'width .25s ease' }} />
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <div style={{ padding: '5px 10px', borderRadius: 999, background: '#EFF6FF', color: '#2563EB', fontSize: 12, fontWeight: 700 }}>Goal weights {goalMetrics.goalPct}%</div>
            {goalMetrics.shouldTrackKpis ? <div style={{ padding: '5px 10px', borderRadius: 999, background: '#F5F3FF', color: '#7C3AED', fontSize: 12, fontWeight: 700 }}>KPI coverage {goalMetrics.kpiPct}%</div> : null}
          </div>
        </div>

        {/* Goal Cards */}
        {myGoals.length === 0 && !canAddKra ? (
          <EmptyState title="No goals assigned yet" subtitle="Your goal library has not been assigned for this cycle." />
        ) : (
          <div>
            {perspectiveGroups.map((group) => {
              const groupWeight = group.goals.reduce((sum, goal) => sum + (Number(goal.weight) || 0), 0);
              return (
                <div key={group.perspective} style={{ marginBottom: 18, borderRadius: 16, overflow: 'hidden', border: `1px solid ${group.color}30`, background: '#fff', boxShadow: '0 12px 28px rgba(15,23,42,.04)' }}>
                  <div style={{ background: `linear-gradient(135deg, ${group.color}18 0%, ${group.color}08 100%)`, borderBottom: `1px solid ${group.color}24`, padding: '14px 18px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
                      <div>
                        <div style={{ fontSize: 10.5, fontWeight: 800, color: group.color, letterSpacing: '.08em', textTransform: 'uppercase', marginBottom: 3 }}>Perspective</div>
                        <div style={{ fontSize: 17, fontWeight: 800, color: '#0F172A' }}>{group.perspective}</div>
                      </div>
                      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                        <div style={{ padding: '5px 10px', borderRadius: 999, background: '#FFFFFF', border: `1px solid ${group.color}24`, color: group.color, fontSize: 12, fontWeight: 700 }}>
                          {group.goals.length} KRA{group.goals.length !== 1 ? 's' : ''}
                        </div>
                        <div style={{ padding: '5px 10px', borderRadius: 999, background: '#FFFFFF', border: `1px solid ${group.color}24`, color: group.color, fontSize: 12, fontWeight: 700 }}>
                          {groupWeight.toFixed(1)}% weight
                        </div>
                      </div>
                    </div>
                  </div>

                  <div style={{ padding: '14px' }}>
                    {group.goals.map((goal, goalIndex) => {
                      const isDragging = dragGoalId === goal.id;
                      const isDragOver = dragOverGoalId === goal.id && dragGoalId !== goal.id;
                      const isRewriting = rewritingGoalId === goal.id;
                      const showPerspectiveField = perspectives.length > 0 && canEditKraFields;

                      return (
                        <div
                          key={goal.id}
                          draggable={canEditGoalPlan}
                          onDragStart={() => setDragGoalId(goal.id)}
                          onDragOver={(e) => { e.preventDefault(); setDragOverGoalId(goal.id); }}
                          onDragEnd={() => { setDragGoalId(null); setDragOverGoalId(null); }}
                          onDrop={() => {
                            if (dragGoalId && dragGoalId !== goal.id) reorderGoals(dragGoalId, goal.id);
                            setDragGoalId(null);
                            setDragOverGoalId(null);
                          }}
                          style={{
                            background: isDragOver ? '#F0F9FF' : '#fff',
                            border: isDragOver ? '1.5px dashed #2563EB' : isDragging ? '1.5px dashed #94A3B8' : '1.5px solid #E9EDF2',
                            borderRadius: 14,
                            marginBottom: 14,
                            overflow: 'hidden',
                            opacity: isDragging ? 0.45 : 1,
                            transition: 'border-color .15s, opacity .15s',
                          }}
                        >
                          <div style={{ padding: '14px 18px', display: 'flex', gap: 10, alignItems: 'flex-start' }}>
                            {/* Drag handle */}
                            {canEditGoalPlan && (
                              <div
                                title="Drag to reorder"
                                style={{ cursor: 'grab', color: '#CBD5E1', fontSize: 15, paddingTop: 10, flexShrink: 0, userSelect: 'none' }}
                              >
                                ⠿
                              </div>
                            )}

                            <div style={{ flex: 1, minWidth: 0 }}>
                              {showPerspectiveField && (
                                <select
                                  value={goal.perspName}
                                  onChange={(e) => updateGoal(goal.id, 'perspName', e.target.value)}
                                  style={{ width: '100%', marginBottom: 10, padding: '9px 12px', borderRadius: 10, border: '1.5px solid #D9E2EC', fontFamily: 'inherit', fontSize: 13, background: '#fff' }}
                                >
                                  <option value="">Select perspective</option>
                                  {perspectives.map((p) => (
                                    <option key={p.name} value={p.name}>{p.name}</option>
                                  ))}
                                </select>
                              )}

                              {canEditKraFields ? (
                                <div>
                                  <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) auto', gap: 10 }}>
                                    {/* Goal name with ✨ rewrite button */}
                                    <div style={{ position: 'relative' }}>
                                      <input
                                        value={goal.name}
                                        onChange={(e) => updateGoal(goal.id, 'name', e.target.value)}
                                        placeholder={`Goal ${goalIndex + 1}`}
                                        style={{ width: '100%', padding: '11px 44px 11px 12px', borderRadius: 10, border: '1.5px solid #D9E2EC', fontFamily: 'inherit', fontSize: 13.5, boxSizing: 'border-box' }}
                                      />
                                      <button
                                        type="button"
                                        title="Get rewrite suggestions"
                                        onClick={() => {
                                          const s = generateRewriteSuggestions(goal.name);
                                          setRewriteSuggestions(s);
                                          setRewritingGoalId(isRewriting ? null : goal.id);
                                        }}
                                        style={{
                                          position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)',
                                          padding: '3px 6px', borderRadius: 6,
                                          border: `1px solid ${isRewriting ? '#C7D2FE' : '#E2E8F0'}`,
                                          background: isRewriting ? '#EEF2FF' : '#F8FAFC',
                                          color: isRewriting ? '#4F46E5' : '#94A3B8',
                                          cursor: 'pointer', fontFamily: 'inherit', fontSize: 11, fontWeight: 700,
                                        }}
                                      >
                                        ✨
                                      </button>
                                    </div>

                                    {/* Weight input with +/- buttons */}
                                    <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                                      <input
                                        value={goal.weight}
                                        onChange={(e) => updateGoal(goal.id, 'weight', e.target.value)}
                                        placeholder="Wt %"
                                        type="number"
                                        min="0"
                                        step="1"
                                        style={{ width: 72, padding: '11px 8px', borderRadius: 10, border: '1.5px solid #D9E2EC', fontFamily: 'inherit', fontSize: 13.5 }}
                                      />
                                      <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                                        <button
                                          type="button"
                                          onClick={() => updateGoal(goal.id, 'weight', String(Math.min(100, (Number(goal.weight) || 0) + 5)))}
                                          style={{ padding: '3px 8px', borderRadius: 6, border: '1px solid #E2E8F0', background: '#F8FAFC', color: '#374151', cursor: 'pointer', fontFamily: 'inherit', fontSize: 12, lineHeight: 1 }}
                                        >+</button>
                                        <button
                                          type="button"
                                          onClick={() => updateGoal(goal.id, 'weight', String(Math.max(0, (Number(goal.weight) || 0) - 5)))}
                                          style={{ padding: '3px 8px', borderRadius: 6, border: '1px solid #E2E8F0', background: '#F8FAFC', color: '#374151', cursor: 'pointer', fontFamily: 'inherit', fontSize: 12, lineHeight: 1 }}
                                        >−</button>
                                      </div>
                                    </div>
                                  </div>

                                  {/* Rewrite suggestions */}
                                  {isRewriting && (
                                    <div style={{ marginTop: 8, background: '#F5F3FF', border: '1px solid #DDD6FE', borderRadius: 10, padding: '10px 12px' }}>
                                      <div style={{ fontSize: 11.5, fontWeight: 700, color: '#6D28D9', marginBottom: 8 }}>✨ Click a suggestion to apply:</div>
                                      {rewriteSuggestions.length > 0 ? (
                                        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                                          {rewriteSuggestions.map((suggestion, i) => (
                                            <button
                                              key={i}
                                              type="button"
                                              onClick={() => {
                                                updateGoal(goal.id, 'name', suggestion);
                                                setRewritingGoalId(null);
                                              }}
                                              style={{
                                                textAlign: 'left', padding: '8px 12px', borderRadius: 8,
                                                border: '1px solid #DDD6FE', background: '#fff',
                                                color: '#374151', cursor: 'pointer', fontFamily: 'inherit', fontSize: 13,
                                              }}
                                            >
                                              {suggestion}
                                            </button>
                                          ))}
                                        </div>
                                      ) : (
                                        <div style={{ fontSize: 12, color: '#7C3AED' }}>Type a goal name to get suggestions.</div>
                                      )}
                                    </div>
                                  )}
                                </div>
                              ) : (
                                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
                                  <div>
                                    <div style={{ fontSize: 10.5, fontWeight: 700, color: group.color, textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 5 }}>{goal.perspName || group.perspective}</div>
                                    <div style={{ fontSize: 15, fontWeight: 800, color: '#0D1117' }}>{goal.name}</div>
                                  </div>
                                  <span style={{ fontSize: 12, fontWeight: 700, color: group.color, background: `${group.color}14`, padding: '5px 11px', borderRadius: 999 }}>Weight: {goal.weight || 0}%</span>
                                </div>
                              )}
                            </div>

                            {canAddKra && (
                              <button
                                type="button"
                                onClick={() => removeGoal(goal.id)}
                                style={{ padding: '7px 10px', borderRadius: 10, border: '1px solid #FECACA', background: '#FFF1F2', color: '#DC2626', cursor: 'pointer', fontFamily: 'inherit', fontSize: 13, fontWeight: 700, flexShrink: 0 }}
                              >
                                ✕
                              </button>
                            )}
                          </div>

                          {/* KPIs */}
                          <div style={{ padding: '0 14px 14px' }}>
                            {(goal.kpis || []).map((kpi) => {
                              const isEmployeeAdded = kpi.source !== 'library';
                              const kpiEditable = canEditExistingKpi || (canAddKpi && isEmployeeAdded);
                              const isSuggestionMode = effectiveConfig?.goalCreationMode === 'admin-library' && effectiveConfig?.goalKpiMode === 'kra-kpi' && accessMode === 'add-kpis';
                              return (
                                <div key={kpi.id} style={{ padding: '12px', borderRadius: 12, background: '#F8FAFC', border: '1px solid #E9EDF2', marginTop: 10, display: 'flex', gap: 12, alignItems: 'flex-start', flexWrap: 'wrap' }}>
                                  <div style={{ flex: 1, minWidth: 220 }}>
                                    {kpiEditable ? (
                                      <div style={{ display: 'grid', gridTemplateColumns: isSuggestionMode ? 'minmax(0,1fr) minmax(0,1fr)' : 'minmax(0,1fr) auto minmax(0,1fr)', gap: 8 }}>
                                        <input
                                          value={kpi.name}
                                          onChange={(e) => updateKpi(goal.id, kpi.id, 'name', e.target.value)}
                                          placeholder="KPI name"
                                          style={{ padding: '9px 12px', borderRadius: 9, border: '1.5px solid #D9E2EC', fontFamily: 'inherit', fontSize: 13, background: '#fff' }}
                                        />
                                        {!isSuggestionMode && (
                                          <div style={{ display: 'flex', gap: 3, alignItems: 'center' }}>
                                            <input
                                              value={kpi.weight}
                                              onChange={(e) => updateKpi(goal.id, kpi.id, 'weight', e.target.value)}
                                              placeholder="Wt %"
                                              type="number"
                                              min="0"
                                              step="1"
                                              style={{ width: 60, padding: '9px 6px', borderRadius: 9, border: '1.5px solid #D9E2EC', fontFamily: 'inherit', fontSize: 13 }}
                                            />
                                            <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                                              <button type="button" onClick={() => updateKpi(goal.id, kpi.id, 'weight', String(Math.min(100, (Number(kpi.weight) || 0) + 5)))} style={{ padding: '2px 6px', borderRadius: 5, border: '1px solid #E2E8F0', background: '#F8FAFC', color: '#374151', cursor: 'pointer', fontFamily: 'inherit', fontSize: 11, lineHeight: 1 }}>+</button>
                                              <button type="button" onClick={() => updateKpi(goal.id, kpi.id, 'weight', String(Math.max(0, (Number(kpi.weight) || 0) - 5)))} style={{ padding: '2px 6px', borderRadius: 5, border: '1px solid #E2E8F0', background: '#F8FAFC', color: '#374151', cursor: 'pointer', fontFamily: 'inherit', fontSize: 11, lineHeight: 1 }}>−</button>
                                            </div>
                                          </div>
                                        )}
                                        <input
                                          value={kpi.target || ''}
                                          onChange={(e) => updateKpi(goal.id, kpi.id, 'target', e.target.value)}
                                          placeholder="Target / success metric"
                                          style={{ padding: '9px 12px', borderRadius: 9, border: '1.5px solid #D9E2EC', fontFamily: 'inherit', fontSize: 13, background: '#fff' }}
                                        />
                                      </div>
                                    ) : (
                                      <div>
                                        <div style={{ fontSize: 13.5, color: '#1E293B', fontWeight: 600 }}>
                                          {kpi.name}
                                          {isEmployeeAdded ? <span style={{ marginLeft: 8, fontSize: 11, fontWeight: 700, color: '#2563EB', background: '#EFF6FF', padding: '2px 8px', borderRadius: 999 }}>Suggested</span> : null}
                                        </div>
                                        <div style={{ fontSize: 11.5, color: '#94A3B8', marginTop: 4 }}>
                                          {kpi.weight ? `Weight: ${kpi.weight}%` : 'Additional KPI'}
                                          {kpi.target ? ` · Target: ${kpi.target}` : ''}
                                        </div>
                                      </div>
                                    )}
                                  </div>
                                  {kpiEditable && (
                                    <button
                                      type="button"
                                      onClick={() => removeKpi(goal.id, kpi.id)}
                                      style={{ padding: '7px 9px', borderRadius: 8, border: '1px solid #E2E8F0', background: '#fff', color: '#94A3B8', cursor: 'pointer', fontFamily: 'inherit', fontSize: 12 }}
                                    >
                                      ✕
                                    </button>
                                  )}
                                </div>
                              );
                            })}

                            {canAddKpi && (
                              <button
                                type="button"
                                onClick={() => addKpi(goal.id)}
                                style={{ marginTop: 10, padding: '7px 12px', borderRadius: 10, border: `1px dashed ${group.color}66`, background: `${group.color}08`, color: group.color, cursor: 'pointer', fontFamily: 'inherit', fontSize: 12.5, fontWeight: 700 }}
                              >
                                + {effectiveConfig?.goalKpiMode === 'kra-kpi' && accessMode === 'add-kpis' ? 'Suggest extra KPI' : 'Add KPI'}
                              </button>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}

            {canAddKra && (
              <button
                type="button"
                onClick={addGoal}
                style={{ marginTop: 8, padding: '10px 16px', borderRadius: 10, border: '1px dashed #93C5FD', background: '#F8FBFF', color: '#2563EB', cursor: 'pointer', fontFamily: 'inherit', fontSize: 13, fontWeight: 700 }}
              >
                + Add Goal
              </button>
            )}

            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, marginTop: 18, flexWrap: 'wrap', alignItems: 'center' }}>
              <div style={{ fontSize: 12.5, color: '#64748B' }}>
                {myValidation.errors.length > 0
                  ? myValidation.errors[0]
                  : mySubmission.status === 'approved'
                    ? 'This goal plan is approved and locked for the current phase.'
                    : mySubmission.status === 'pending-manager'
                      ? 'Your manager now has this plan in the approval queue.'
                      : 'When ready, submit this plan for manager approval.'}
              </div>
              <button
                type="button"
                onClick={submitGoals}
                disabled={!canEditGoalPlan || !myValidation.canSubmit}
                style={{
                  padding: '10px 26px',
                  background: canEditGoalPlan && myValidation.canSubmit ? '#16A34A' : '#CBD5E1',
                  color: '#fff',
                  border: 'none',
                  borderRadius: 9,
                  fontSize: 14,
                  fontWeight: 700,
                  cursor: canEditGoalPlan && myValidation.canSubmit ? 'pointer' : 'not-allowed',
                  fontFamily: 'inherit',
                }}
              >
                {mySubmission.status === 'sent-back' ? 'Resubmit Goals' : 'Submit Goals for Approval'}
              </button>
            </div>
          </div>
        )}
      </div>
    );
  }

  function renderMessages() {
    // Build a list of contacts this user can message: manager + direct reports
    const contacts = [];
    if (managerCode) {
      const mgr = getEmployeeRecord(config, managerCode);
      contacts.push({
        code: normalizeCode(managerCode),
        name: mgr?.['Employee Name'] || managerCode,
        role: 'Manager',
      });
    }
    directReports.forEach((dr) => {
      const code = normalizeCode(String(dr['Employee Code'] || '').trim());
      if (code) {
        contacts.push({ code, name: String(dr['Employee Name'] || code).trim(), role: 'Direct report' });
      }
    });

    if (contacts.length === 0) {
      return <EmptyState title="No contacts" subtitle="You have no manager or direct reports to message." />;
    }

    const ck = activeConversation ? convKey(session.empCode, activeConversation) : null;
    const conversation = ck ? (messagesData.conversations[ck] || { messages: [] }) : null;
    const contactInfo = contacts.find((c) => c.code === normalizeCode(activeConversation || ''));

    if (activeConversation && conversation) {
      // Conversation thread view
      return (
        <div>
          <button
            type="button"
            onClick={() => { setActiveConversation(null); setMessageInput(''); }}
            style={{ marginBottom: 14, padding: '6px 14px', borderRadius: 8, border: '1px solid #E2E8F0', background: '#fff', color: '#374151', cursor: 'pointer', fontFamily: 'inherit', fontSize: 12.5, fontWeight: 600 }}
          >
            ← Back to inbox
          </button>

          <div style={{ background: '#fff', border: '1.5px solid #E9EDF2', borderRadius: 14, overflow: 'hidden' }}>
            {/* Thread header */}
            <div style={{ padding: '14px 18px', borderBottom: '1px solid #F1F5F9', display: 'flex', alignItems: 'center', gap: 12 }}>
              <div style={{ width: 36, height: 36, borderRadius: '50%', background: 'linear-gradient(135deg,#2563EB,#4F46E5)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontSize: 14, fontWeight: 800, flexShrink: 0 }}>
                {(contactInfo?.name || '?')[0].toUpperCase()}
              </div>
              <div>
                <div style={{ fontSize: 14.5, fontWeight: 700, color: '#0F172A' }}>{contactInfo?.name}</div>
                <div style={{ fontSize: 12, color: '#64748B' }}>{contactInfo?.role}</div>
              </div>
            </div>

            {/* Messages */}
            <div style={{ padding: '16px 18px', minHeight: 200, maxHeight: 400, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 10 }}>
              {conversation.messages.length === 0 && (
                <div style={{ textAlign: 'center', color: '#94A3B8', fontSize: 13, paddingTop: 40 }}>No messages yet. Start the conversation below.</div>
              )}
              {conversation.messages.map((msg) => {
                const isMe = msg.from === employeeCodeKey;
                return (
                  <div key={msg.id} style={{ display: 'flex', flexDirection: 'column', alignItems: isMe ? 'flex-end' : 'flex-start' }}>
                    <div style={{
                      maxWidth: '72%',
                      padding: '10px 14px',
                      borderRadius: isMe ? '14px 14px 4px 14px' : '14px 14px 14px 4px',
                      background: isMe ? 'linear-gradient(135deg,#2563EB,#4F46E5)' : '#F1F5F9',
                      color: isMe ? '#fff' : '#0F172A',
                      fontSize: 13.5,
                      lineHeight: 1.5,
                    }}>
                      {msg.content}
                    </div>
                    <div style={{ fontSize: 11, color: '#94A3B8', marginTop: 3 }}>{formatDateTime(msg.ts)}</div>
                  </div>
                );
              })}
            </div>

            {/* Message input */}
            <div style={{ padding: '12px 18px', borderTop: '1px solid #F1F5F9', display: 'flex', gap: 10, alignItems: 'flex-end' }}>
              <textarea
                value={messageInput}
                onChange={(e) => setMessageInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    sendMessage(activeConversation, messageInput);
                    setMessageInput('');
                  }
                }}
                rows={2}
                placeholder="Type a message… (Enter to send, Shift+Enter for new line)"
                style={{ flex: 1, padding: '10px 12px', borderRadius: 10, border: '1.5px solid #D9E2EC', fontFamily: 'inherit', fontSize: 13, resize: 'none' }}
              />
              <button
                type="button"
                onClick={() => { sendMessage(activeConversation, messageInput); setMessageInput(''); }}
                disabled={!messageInput.trim()}
                style={{ padding: '10px 16px', borderRadius: 10, border: 'none', background: messageInput.trim() ? '#2563EB' : '#CBD5E1', color: '#fff', cursor: messageInput.trim() ? 'pointer' : 'not-allowed', fontFamily: 'inherit', fontSize: 13, fontWeight: 700, flexShrink: 0 }}
              >
                Send
              </button>
            </div>
          </div>
        </div>
      );
    }

    // Inbox list
    return (
      <div>
        <div style={{ marginBottom: 16, padding: '12px 16px', background: '#EFF6FF', border: '1px solid #BFDBFE', borderRadius: 10, fontSize: 12.5, color: '#1D4ED8' }}>
          Messages are live — they sync instantly across browser tabs. Press Enter to send.
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {contacts.map((contact) => {
            const ck2 = convKey(session.empCode, contact.code);
            const conv = messagesData.conversations[ck2];
            const lastMsg = conv?.messages?.[conv.messages.length - 1] || null;
            const unread = (conv?.messages || []).filter((m) => m.from !== employeeCodeKey && !m.read).length;
            return (
              <button
                key={contact.code}
                type="button"
                onClick={() => { setActiveConversation(contact.code); markConversationRead(contact.code); }}
                style={{ width: '100%', textAlign: 'left', padding: '14px 18px', background: '#fff', border: `1.5px solid ${unread > 0 ? '#BFDBFE' : '#E9EDF2'}`, borderRadius: 14, cursor: 'pointer', fontFamily: 'inherit', display: 'flex', alignItems: 'center', gap: 14 }}
              >
                <div style={{ width: 42, height: 42, borderRadius: '50%', background: 'linear-gradient(135deg,#2563EB,#4F46E5)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontSize: 16, fontWeight: 800, flexShrink: 0 }}>
                  {contact.name[0].toUpperCase()}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, marginBottom: 3 }}>
                    <div style={{ fontSize: 14, fontWeight: 700, color: '#0F172A' }}>{contact.name}</div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      {unread > 0 && (
                        <span style={{ fontSize: 11, fontWeight: 700, color: '#fff', background: '#2563EB', padding: '2px 7px', borderRadius: 999 }}>{unread}</span>
                      )}
                      {lastMsg && <span style={{ fontSize: 11.5, color: '#94A3B8', whiteSpace: 'nowrap' }}>{formatDateTime(lastMsg.ts)}</span>}
                    </div>
                  </div>
                  <div style={{ fontSize: 12, color: '#94A3B8' }}>{contact.role}</div>
                  {lastMsg && (
                    <div style={{ fontSize: 12.5, color: unread > 0 ? '#0F172A' : '#64748B', fontWeight: unread > 0 ? 600 : 400, marginTop: 3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {lastMsg.from === employeeCodeKey ? 'You: ' : ''}{lastMsg.content}
                    </div>
                  )}
                  {!lastMsg && <div style={{ fontSize: 12.5, color: '#94A3B8', marginTop: 3 }}>No messages yet — start a conversation</div>}
                </div>
              </button>
            );
          })}
        </div>
      </div>
    );
  }

  function renderApprovals() {
    if (pendingApprovals.length === 0) {
      return <EmptyState title="No approval requests" subtitle="When your direct reports submit their goals, they will appear here." />;
    }

    return (
      <div>
        {pendingApprovals.map((submission) => (
          <div key={submission.employeeCode} style={{ background: '#fff', border: '1.5px solid #E9EDF2', borderRadius: 12, marginBottom: 14, overflow: 'hidden' }}>
            <div style={{ padding: '16px 18px', borderBottom: '1px solid #F1F5F9', display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
              <div>
                <div style={{ fontSize: 14.5, fontWeight: 700, color: '#0D1117' }}>{submission.employeeName}</div>
                <div style={{ fontSize: 12.5, color: '#64748B', marginTop: 4 }}>
                  {submission.employeeCode} · Submitted {formatDateTime(submission.submittedAt)} · {submission.goals?.length || 0} goals
                </div>
              </div>
              <div style={{ padding: '6px 10px', borderRadius: 999, background: '#FFF7ED', border: '1px solid #FED7AA', fontSize: 12, fontWeight: 700, color: '#D97706' }}>
                Goal approval pending
              </div>
            </div>
            <div style={{ padding: '16px 18px' }}>
              {(submission.goals || []).map((goal) => {
                const color = getPerspectiveColor(goal, perspectives);
                return (
                  <div key={goal.id} style={{ border: '1px solid #F1F5F9', borderRadius: 10, padding: '12px 14px', marginBottom: 10 }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap', marginBottom: 8 }}>
                      <div>
                        {goal.perspName ? (
                          <div style={{ fontSize: 10.5, fontWeight: 700, color, textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 4 }}>{goal.perspName}</div>
                        ) : null}
                        <div style={{ fontSize: 13.5, fontWeight: 700, color: '#0D1117' }}>{goal.name}</div>
                      </div>
                      <div style={{ fontSize: 12, fontWeight: 700, color, background: `${color}14`, padding: '4px 10px', borderRadius: 999 }}>Weight: {goal.weight || 0}%</div>
                    </div>
                    {(goal.kpis || []).length > 0 ? (
                      <div style={{ display: 'grid', gap: 8 }}>
                        {(goal.kpis || []).map((kpi) => (
                          <div key={kpi.id} style={{ padding: '10px 12px', background: '#F8FAFC', borderRadius: 8, border: '1px solid #E9EDF2' }}>
                            <div style={{ fontSize: 13, fontWeight: 600, color: '#1E293B' }}>
                              {kpi.name}
                              {kpi.source !== 'library' ? <span style={{ marginLeft: 8, fontSize: 11, fontWeight: 700, color: '#2563EB', background: '#EFF6FF', padding: '2px 8px', borderRadius: 999 }}>Employee added</span> : null}
                            </div>
                            <div style={{ fontSize: 11.5, color: '#64748B', marginTop: 4 }}>
                              {kpi.weight ? `Weight: ${kpi.weight}%` : 'No fixed weight'}
                              {kpi.target ? ` · Target: ${kpi.target}` : ''}
                            </div>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div style={{ fontSize: 12.5, color: '#94A3B8' }}>No KPIs added.</div>
                    )}
                  </div>
                );
              })}

              <textarea
                value={managerNotes[submission.employeeCode] || ''}
                onChange={(event) => setManagerNotes((prev) => ({ ...prev, [submission.employeeCode]: event.target.value }))}
                rows={3}
                placeholder="Optional manager note"
                style={{ width: '100%', padding: '12px 14px', borderRadius: 10, border: '1.5px solid #D9E2EC', fontFamily: 'inherit', fontSize: 13, resize: 'vertical', marginTop: 6 }}
              />

              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 12 }}>
                <button
                  type="button"
                  onClick={() => reviewSubmission(submission.employeeCode, 'send-back')}
                  style={{ padding: '9px 14px', borderRadius: 9, border: '1px solid #FECACA', background: '#FEF2F2', color: '#DC2626', cursor: 'pointer', fontFamily: 'inherit', fontSize: 12.5, fontWeight: 700 }}
                >
                  Reject Goals
                </button>
                <button
                  type="button"
                  onClick={() => reviewSubmission(submission.employeeCode, 'approve')}
                  style={{ padding: '9px 16px', borderRadius: 9, border: 'none', background: '#16A34A', color: '#fff', cursor: 'pointer', fontFamily: 'inherit', fontSize: 12.5, fontWeight: 700 }}
                >
                  Approve Goals
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>
    );
  }

  function renderTeam() {
    if (directReports.length === 0) {
      return <EmptyState title="No direct reports found" subtitle="Employees reporting to you will appear here for reminders and approvals." />;
    }

    return (
      <div>
        <div style={{ marginBottom: 16, padding: '14px 18px', background: '#F8FBFF', border: '1.5px solid #D6E6FF', borderRadius: 12 }}>
          <div style={{ fontSize: 13.5, fontWeight: 700, color: '#2563EB', marginBottom: 4 }}>Team goal-setting monitor</div>
          <div style={{ fontSize: 12.5, color: '#475569' }}>Send reminders to your team and track who has submitted goals for approval.</div>
        </div>
        {directReports.map((report) => {
          const reportCode = String(report['Employee Code'] || '').trim();
          const submission = workflow?.submissions?.[normalizeCode(reportCode)] || null;
          const reportGoals = submission?.goals || [];
          const metrics = getGoalPlanMetrics(reportGoals, config, getGoalAccessMode(config));
          const statusMeta = getSubmissionStatusMeta(submission);
          return (
            <div key={reportCode} style={{ background: '#fff', border: '1.5px solid #E9EDF2', borderRadius: 14, padding: '16px 18px', marginBottom: 12 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, alignItems: 'center', flexWrap: 'wrap', marginBottom: 12 }}>
                <div>
                  <div style={{ fontSize: 15, fontWeight: 700, color: '#0F172A' }}>{report['Employee Name'] || reportCode}</div>
                  <div style={{ fontSize: 12.5, color: '#64748B', marginTop: 4 }}>
                    {reportCode}
                    {report.Designation ? ` · ${report.Designation}` : ''}
                    {submission?.submittedAt ? ` · submitted ${formatDateTime(submission.submittedAt)}` : ' · not submitted yet'}
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  <div style={{ padding: '6px 10px', borderRadius: 999, background: statusMeta.bg, border: `1px solid ${statusMeta.border}`, color: statusMeta.color, fontSize: 12, fontWeight: 700 }}>
                    {statusMeta.label}
                  </div>
                  <button
                    type="button"
                    onClick={() => sendReminder(report)}
                    style={{ padding: '8px 12px', borderRadius: 10, border: '1px solid #BFDBFE', background: '#EFF6FF', color: '#2563EB', cursor: 'pointer', fontFamily: 'inherit', fontSize: 12.5, fontWeight: 700 }}
                  >
                    Send reminder
                  </button>
                </div>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '180px 1fr', gap: 14, alignItems: 'center' }}>
                <div>
                  <div style={{ fontSize: 12, fontWeight: 700, color: '#475569', marginBottom: 4 }}>Goal plan completion</div>
                  <div style={{ fontSize: 22, fontWeight: 800, color: metrics.overall === 100 ? '#16A34A' : '#2563EB' }}>{metrics.overall}%</div>
                </div>
                <div>
                  <div style={{ height: 8, background: '#E2E8F0', borderRadius: 999, overflow: 'hidden', marginBottom: 8 }}>
                    <div style={{ height: '100%', width: `${metrics.overall}%`, background: metrics.overall === 100 ? 'linear-gradient(90deg,#16A34A,#22C55E)' : 'linear-gradient(90deg,#2563EB,#4F46E5)', borderRadius: 999 }} />
                  </div>
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    <div style={{ fontSize: 12, color: '#64748B' }}>Goal weights {metrics.goalPct}%</div>
                    <div style={{ fontSize: 12, color: '#64748B' }}>KPI coverage {metrics.kpiPct}%</div>
                    <div style={{ fontSize: 12, color: '#64748B' }}>{reportGoals.length} goals</div>
                  </div>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    );
  }

  function renderNotifications() {
    if (notifications.length === 0) {
      return <EmptyState title="No notifications yet" subtitle="Reminders, approvals, and manager actions will appear here." />;
    }

    return (
      <div>
        {notifications.map((notification) => (
          <div key={notification.id} style={{ background: '#fff', border: '1.5px solid #E9EDF2', borderRadius: 14, padding: '15px 18px', marginBottom: 12 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
              <div>
                <div style={{ fontSize: 14, fontWeight: 700, color: '#0F172A' }}>{notification.title}</div>
                <div style={{ fontSize: 12.5, color: '#64748B', marginTop: 5, lineHeight: 1.5 }}>{notification.message}</div>
              </div>
              <div style={{ fontSize: 12, color: '#94A3B8', whiteSpace: 'nowrap' }}>{formatDateTime(notification.createdAt)}</div>
            </div>
          </div>
        ))}
      </div>
    );
  }

  function renderSelfEvaluation() {
    if (selfEvalSubmitted) {
      return (
        <div style={{ textAlign: 'center', padding: '60px 20px' }}>
          <div style={{ fontSize: 48, marginBottom: 12 }}>✅</div>
          <div style={{ fontSize: 18, fontWeight: 700, color: '#0D1117', marginBottom: 6 }}>Self-Evaluation Submitted</div>
          <div style={{ fontSize: 13.5, color: '#6B7280' }}>Your ratings have been recorded. Your manager will review them shortly.</div>
        </div>
      );
    }

    if (myGoals.length === 0) {
      return <EmptyState title="No goals available" subtitle="There are no approved goals to evaluate for this phase." />;
    }

    return (
      <div>
        {totalRatable > 0 ? (
          <div style={{ marginBottom: 20, padding: '14px 18px', background: '#fff', borderRadius: 10, border: '1.5px solid #E9EDF2' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12.5, marginBottom: 8 }}>
              <span style={{ color: '#6B7280' }}>Self-rating progress</span>
              <span style={{ fontWeight: 700, color: selfEvalPct === 100 ? '#16A34A' : '#2563EB' }}>{totalRated} / {totalRatable} rated</span>
            </div>
            <div style={{ height: 6, background: '#F1F5F9', borderRadius: 4 }}>
              <div style={{ height: '100%', width: `${selfEvalPct}%`, background: selfEvalPct === 100 ? '#16A34A' : 'linear-gradient(90deg,#2563EB,#6366F1)', borderRadius: 4, transition: 'width .3s' }} />
            </div>
          </div>
        ) : null}

        {myGoals.map((goal) => {
          const color = getPerspectiveColor(goal, perspectives);
          const goalHasKpis = (goal.kpis || []).length > 0;
          return (
            <div key={goal.id} style={{ background: '#fff', border: '1.5px solid #E9EDF2', borderRadius: 12, marginBottom: 14, overflow: 'hidden' }}>
              <div style={{ padding: '13px 18px', borderLeft: `4px solid ${color}`, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                <div style={{ flex: 1, minWidth: 180 }}>
                  {goal.perspName ? <div style={{ fontSize: 10.5, fontWeight: 700, color, textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 3 }}>{goal.perspName}</div> : null}
                  <div style={{ fontSize: 14, fontWeight: 700, color: '#0D1117' }}>{goal.name}</div>
                </div>
                <span style={{ fontSize: 12, fontWeight: 700, color, background: `${color}14`, padding: '3px 10px', borderRadius: 6 }}>Weight: {goal.weight}%</span>
                {!goalHasKpis ? (
                  <div style={{ display: 'flex', gap: 5 }}>
                    {currentScale.map((step) => (
                      <button
                        key={step.n}
                        onClick={() => setRating(goal.name, null, step.n)}
                        style={{
                          width: 32,
                          height: 32,
                          borderRadius: '50%',
                          border: `2px solid ${getRating(goal.name, null) === step.n ? SCALE_COLORS[step.n - 1] : '#E2E8F0'}`,
                          background: getRating(goal.name, null) === step.n ? SCALE_COLORS[step.n - 1] : '#fff',
                          color: getRating(goal.name, null) === step.n ? '#fff' : '#9CA3AF',
                          fontSize: 12,
                          fontWeight: 700,
                          cursor: 'pointer',
                          fontFamily: 'inherit',
                        }}
                      >
                        {step.n}
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>

              {(goal.kpis || []).map((kpi) => (
                <div key={kpi.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '11px 18px 11px 26px', borderTop: '1px solid #F1F5F9', flexWrap: 'wrap' }}>
                  <div style={{ flex: 1, minWidth: 180 }}>
                    <div style={{ fontSize: 13, color: '#1E293B' }}>{kpi.name}</div>
                    <div style={{ fontSize: 11, color: '#9CA3AF', marginTop: 2 }}>Weight: {kpi.weight}%</div>
                  </div>
                  <div style={{ display: 'flex', gap: 5, alignItems: 'center' }}>
                    {currentScale.map((step) => (
                      <button
                        key={step.n}
                        onClick={() => setRating(goal.name, kpi.name, step.n)}
                        title={`${step.n} — ${step.l}`}
                        style={{
                          width: 30,
                          height: 30,
                          borderRadius: '50%',
                          border: `2px solid ${getRating(goal.name, kpi.name) === step.n ? SCALE_COLORS[step.n - 1] : '#E2E8F0'}`,
                          background: getRating(goal.name, kpi.name) === step.n ? SCALE_COLORS[step.n - 1] : '#fff',
                          color: getRating(goal.name, kpi.name) === step.n ? '#fff' : '#9CA3AF',
                          fontSize: 11,
                          fontWeight: 700,
                          cursor: 'pointer',
                          fontFamily: 'inherit',
                        }}
                      >
                        {step.n}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          );
        })}

        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 8 }}>
          <button
            type="button"
            onClick={() => setSelfEvalSubmitted(true)}
            disabled={selfEvalPct < 100}
            style={{ padding: '10px 28px', background: selfEvalPct === 100 ? '#16A34A' : '#CBD5E1', color: '#fff', border: 'none', borderRadius: 9, fontSize: 14, fontWeight: 700, cursor: selfEvalPct === 100 ? 'pointer' : 'not-allowed', fontFamily: 'inherit' }}
          >
            {selfEvalPct === 100 ? '✓ Submit Self-Evaluation' : `Rate all goals to submit (${selfEvalPct}%)`}
          </button>
        </div>
      </div>
    );
  }

  function renderProfile() {
    return (
      <div>
        <div style={{ background: '#fff', border: '1.5px solid #E9EDF2', borderRadius: 12, padding: '24px', marginBottom: 14 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: '#374151', textTransform: 'uppercase', letterSpacing: '.05em', marginBottom: 16 }}>Employee Details</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
            {[
              { label: 'Employee Code', value: session.empCode },
              { label: 'Full Name', value: employeeName },
              { label: 'Designation', value: employeeDesignation || '—' },
              { label: 'Reporting Manager', value: managerName || '—' },
              { label: 'Email', value: employee?.['Email ID'] || employee?.email || '—' },
              { label: 'Framework', value: config?.frameworkId?.toUpperCase() || '—' },
            ].map(({ label, value }) => (
              <div key={label} style={{ padding: '12px 16px', background: '#F8FAFC', borderRadius: 8, border: '1px solid #E9EDF2' }}>
                <div style={{ fontSize: 11, fontWeight: 600, color: '#9CA3AF', textTransform: 'uppercase', letterSpacing: '.05em', marginBottom: 4 }}>{label}</div>
                <div style={{ fontSize: 13.5, fontWeight: 500, color: '#0D1117' }}>{value}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  const goalHeadlineText = currentPhase === 'goal-setting'
    ? mySubmission?.status === 'approved'
      ? 'goals approved'
      : mySubmission?.status === 'pending-manager'
        ? 'awaiting approval'
        : `${myGoals.length} goals in plan`
    : `${selfEvalPct}%`;

  const goalSubText = currentPhase === 'goal-setting'
    ? mySubmission?.status === 'approved'
      ? 'manager approved'
      : mySubmission?.status === 'pending-manager'
        ? 'sent to manager'
        : 'goal plan status'
    : 'self-rating complete';

  return (
    <div style={{ minHeight: '100vh', background: '#F8FAFC', fontFamily: "'Geist','Inter','Segoe UI',Arial,sans-serif", fontSize: 14, color: '#0D1117' }}>
      <div style={{ background: '#fff', borderBottom: '1.5px solid #E9EDF2', padding: '0 28px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', height: 56, position: 'sticky', top: 0, zIndex: 100 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <img src={zaroLogo} alt="Zaro HR" style={{ width: 30, height: 30, borderRadius: 8, objectFit: 'cover' }} />
          <div style={{ fontSize: 14, fontWeight: 700, color: '#0D1117' }}>
            Zaro <span style={{ color: '#FFBF00' }}>HR</span>
          </div>
          <div style={{ width: 1, height: 18, background: '#E2E8F0', margin: '0 6px' }} />
          <div style={{ fontSize: 13, color: '#6B7280' }}>Performance Management</div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          {currentPhase === 'goal-setting' && pendingApprovals.length > 0 ? (
            <div style={{ padding: '6px 10px', background: '#FFF7ED', border: '1px solid #FED7AA', borderRadius: 999, fontSize: 12, fontWeight: 700, color: '#D97706' }}>
              {pendingApprovals.length} approvals waiting
            </div>
          ) : null}
          {notifications.length > 0 ? (
            <div style={{ padding: '6px 10px', background: '#EEF2FF', border: '1px solid #C7D2FE', borderRadius: 999, fontSize: 12, fontWeight: 700, color: '#4F46E5' }}>
              {notifications.length} notifications
            </div>
          ) : null}
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: '#0D1117' }}>{employeeName}</div>
            <div style={{ fontSize: 11.5, color: '#9CA3AF' }}>{session.empCode}{employeeDesignation ? ` · ${employeeDesignation}` : ''}</div>
          </div>
          <button onClick={logout} style={{ padding: '6px 13px', border: '1.5px solid #E2E8F0', borderRadius: 7, fontSize: 12, cursor: 'pointer', background: '#fff', color: '#6B7280', fontFamily: 'inherit' }}>
            Sign out
          </button>
        </div>
      </div>

      <div style={{ maxWidth: 980, margin: '0 auto', padding: '28px 20px 60px' }}>
        <div style={{ background: 'linear-gradient(135deg,#2563EB 0%,#4F46E5 100%)', borderRadius: 14, padding: '22px 28px', marginBottom: 24, color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
          <div>
            <div style={{ fontSize: 20, fontWeight: 700, marginBottom: 4 }}>Welcome, {employeeName.split(' ')[0]} 👋</div>
            <div style={{ fontSize: 13, opacity: 0.88 }}>
              {employeeDesignation ? <span style={{ background: 'rgba(255,255,255,.18)', padding: '2px 10px', borderRadius: 20, marginRight: 8, fontWeight: 600 }}>{employeeDesignation}</span> : null}
              {managerName ? <span>Reports to: <strong>{managerName}</strong></span> : null}
            </div>
          </div>
          <div style={{ textAlign: 'center' }}>
            <div style={{ fontSize: 28, fontWeight: 800 }}>{goalHeadlineText}</div>
            <div style={{ fontSize: 11.5, opacity: 0.82 }}>{goalSubText}</div>
          </div>
        </div>

        <div style={{ display: 'flex', gap: 0, background: '#fff', border: '1.5px solid #E9EDF2', borderRadius: 12, padding: '12px 16px', marginBottom: 22, overflowX: 'auto' }}>
          {PHASES.map((phase, index) => {
            const isDone = index < phaseIndex;
            const isActive = index === phaseIndex;
            return (
              <div key={phase.id} style={{ display: 'flex', alignItems: 'center', flex: '0 0 auto' }}>
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3, padding: '0 10px' }}>
                  <div style={{
                    width: 30,
                    height: 30,
                    borderRadius: '50%',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: 14,
                    background: isDone ? '#16A34A' : isActive ? '#2563EB' : '#F1F5F9',
                    border: isActive ? '2.5px solid #BFDBFE' : isDone ? '2.5px solid #BBF7D0' : '2px solid #E2E8F0',
                  }}>
                    {isDone ? <span style={{ color: '#fff', fontSize: 13, fontWeight: 700 }}>✓</span> : <span style={{ fontSize: 13 }}>{phase.icon}</span>}
                  </div>
                  <div style={{ fontSize: 11, fontWeight: isActive ? 700 : 400, color: isActive ? '#2563EB' : isDone ? '#16A34A' : '#9CA3AF', whiteSpace: 'nowrap' }}>
                    {phase.label}
                  </div>
                </div>
                {index < PHASES.length - 1 ? (
                  <div style={{ width: 24, height: 2, background: isDone ? '#16A34A' : '#E2E8F0', flexShrink: 0 }} />
                ) : null}
              </div>
            );
          })}
        </div>

        <div style={{ display: 'flex', gap: 4, marginBottom: 22, borderBottom: '1.5px solid #E9EDF2' }}>
          {nav.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setActiveSection(item.id)}
              style={{
                padding: '8px 18px',
                fontSize: 13.5,
                fontWeight: 600,
                cursor: 'pointer',
                fontFamily: 'inherit',
                border: 'none',
                borderBottom: activeSection === item.id ? '2.5px solid #2563EB' : '2.5px solid transparent',
                background: 'transparent',
                color: activeSection === item.id ? '#2563EB' : '#6B7280',
                marginBottom: -1.5,
              }}
            >
              {item.label}
            </button>
          ))}
        </div>

        {activeSection === 'goals' && (
          currentPhase === 'goal-setting' ? renderGoalSetting() :
          currentPhase === 'self-evaluation' ? renderSelfEvaluation() :
          <EmptyState title={`${PHASES[phaseIndex]?.label || 'Current phase'} in progress`} subtitle="This page will unlock the relevant workflow for the active appraisal phase." />
        )}

        {activeSection === 'team' ? renderTeam() : null}
        {activeSection === 'approvals' ? renderApprovals() : null}
        {activeSection === 'messages' ? renderMessages() : null}
        {activeSection === 'notifications' ? renderNotifications() : null}

        {activeSection === 'scale' && currentPhase === 'self-evaluation' ? (
          <div style={{ background: '#fff', border: '1.5px solid #E9EDF2', borderRadius: 12, padding: '20px 24px' }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: '#374151', textTransform: 'uppercase', letterSpacing: '.05em', marginBottom: 16 }}>
              {config?.scalePoints || 5}-Point Rating Scale
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {currentScale.map((step, index) => (
                <div key={step.n} style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '12px 16px', borderRadius: 10, background: `${SCALE_COLORS[index]}0C`, border: `1.5px solid ${SCALE_COLORS[index]}33` }}>
                  <div style={{ width: 38, height: 38, borderRadius: '50%', background: SCALE_COLORS[index], color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 16, fontWeight: 800, flexShrink: 0 }}>{step.n}</div>
                  <div style={{ fontSize: 14, fontWeight: 600, color: '#0D1117' }}>{step.l}</div>
                </div>
              ))}
            </div>
          </div>
        ) : null}

        {activeSection === 'profile' ? renderProfile() : null}
      </div>
    </div>
  );
}
