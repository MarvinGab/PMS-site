import { useEffect, useMemo, useState } from 'react';
import zaroLogo from '../../images/final zaro logo.png';

const EMP_SESSION_KEY = 'zarohr_emp_session';
const WIZARD_STATE_KEY = 'zarohr_pms_wizard_state_v1';
const APP_DATA_KEY = 'zarohr_app_data_v1';
const GOAL_WORKFLOW_KEY = 'zarohr_goal_workflow_v1';

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

function buildInitialGoals(config, employee) {
  if (config?.goalCreationMode === 'admin-library') {
    return getAssignedKRAs(config, employee).map((kra) => createKra({ ...kra, kpis: (kra.kpis || []).map((kpi) => ({ ...kpi, source: 'library' })) }));
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

  const employee = useMemo(() => session && config ? getEmployeeRecord(config, session.empCode) : null, [session, config]);
  const managerCode = String(employee?.['Reporting Manager Code'] || session?.managerCode || '').trim();
  const managerName = useMemo(() => config && managerCode ? getManagerName(config, managerCode) : null, [config, managerCode]);
  const employeeCodeKey = normalizeCode(session?.empCode);
  const perspectives = useMemo(() => (config?.perspectives || []).filter((item) => item?.name && Number(item?.weight) > 0), [config]);
  const accessMode = useMemo(() => getGoalAccessMode(config), [config]);
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
            goals: buildInitialGoals(config, employee),
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        },
      };
    });
  }, [session, config, employee, employeeCodeKey, currentPhase, managerCode]);

  useEffect(() => {
    if (!session) {
      window.location.hash = '#login';
    }
  }, [session]);

  if (!session) {
    return null;
  }

  const employeeName = session.name || employee?.['Employee Name'] || `Employee ${session.empCode}`;
  const employeeDesignation = session.designation || employee?.Designation || employee?.[config?.goalSegmentAttr] || '';
  const mySubmission = workflow?.submissions?.[employeeCodeKey] || null;
  const myGoals = mySubmission?.goals || [];
  const goalMetrics = getGoalPlanMetrics(myGoals, config, accessMode);
  const myStatusMeta = getSubmissionStatusMeta(mySubmission);
  const limits = getGoalLimits(config, employee);
  const myValidation = getGoalPlanValidation(myGoals, config, accessMode, limits, perspectives);
  const notifications = (workflow?.notifications || []).filter((notification) => notification.recipientCode === employeeCodeKey)
    .sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime());
  const employees = config?.employeeUploadData?.employees || [];
  const directReports = employees.filter((item) => normalizeCode(item['Reporting Manager Code']) === employeeCodeKey);
  const pendingApprovals = Object.values(workflow?.submissions || {}).filter(
    (submission) => normalizeCode(submission.managerCode) === employeeCodeKey && submission.status === 'pending-manager'
  );
  const perspectiveGroups = groupGoalsByPerspective(myGoals, perspectives);
  const canEditGoalPlan = currentPhase === 'goal-setting' && mySubmission && !['pending-manager', 'approved'].includes(mySubmission.status);
  const canAddKra = canEditGoalPlan && (config?.goalCreationMode === 'employee-self' || accessMode === 'edit-freely');
  const canEditKraFields = canAddKra;
  const canAddKpi = canEditGoalPlan && (config?.goalCreationMode === 'employee-self' || accessMode === 'edit-freely' || accessMode === 'add-kpis');
  const canEditExistingKpi = canEditGoalPlan && (config?.goalCreationMode === 'employee-self' || accessMode === 'edit-freely' || (accessMode === 'add-kpis' && config?.goalKpiMode === 'kra-only'));
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
        goals: buildInitialGoals(config, employee),
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

  function setRating(goalName, kpiName, value) {
    const key = kpiName ? `${goalName}::${kpiName}` : goalName;
    setSelfRatings((prev) => ({ ...prev, [key]: value }));
  }

  function getRating(goalName, kpiName) {
    const key = kpiName ? `${goalName}::${kpiName}` : goalName;
    return selfRatings[key] || 0;
  }

  const nav = currentPhase === 'goal-setting'
    ? [
        { id: 'goals', label: 'My Goals' },
        ...(directReports.length > 0 ? [{ id: 'team', label: `My Team (${directReports.length})` }] : []),
        ...(directReports.length > 0 ? [{ id: 'approvals', label: `Approvals (${pendingApprovals.length})` }] : []),
        { id: 'notifications', label: `Notifications (${notifications.length})` },
        { id: 'profile', label: 'My Profile' },
      ]
    : [
        { id: 'goals', label: 'My Goals' },
        ...(currentPhase === 'self-evaluation' ? [{ id: 'scale', label: 'Rating Scale' }] : []),
        { id: 'notifications', label: `Notifications (${notifications.length})` },
        { id: 'profile', label: 'My Profile' },
      ];

  function renderGoalSetting() {
    if (!mySubmission) {
      return <EmptyState title="Preparing your goal plan" subtitle="Your assigned library and permissions are loading." />;
    }

    return (
      <div>
        <div style={{ marginBottom: 18, padding: '14px 18px', background: myStatusMeta.bg, border: `1.5px solid ${myStatusMeta.border}`, borderRadius: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
            <div>
              <div style={{ fontSize: 13.5, fontWeight: 700, color: myStatusMeta.color, marginBottom: 4 }}>{myStatusMeta.label}</div>
              <div style={{ fontSize: 12.5, color: '#475569', lineHeight: 1.5 }}>
                {mySubmission.status === 'pending-manager' && `Submitted on ${formatDateTime(mySubmission.submittedAt)}. ${managerName ? `${managerName} can now approve or send back changes.` : 'Waiting for approval.'}`}
                {mySubmission.status === 'approved' && `Approved${mySubmission.managerApprovedBy ? ` by ${getManagerName(config, mySubmission.managerApprovedBy) || mySubmission.managerApprovedBy}` : ''} on ${formatDateTime(mySubmission.managerDecisionAt || mySubmission.approvedAt)}.`}
                {mySubmission.status === 'sent-back' && `Your manager requested changes${mySubmission.managerDecisionAt ? ` on ${formatDateTime(mySubmission.managerDecisionAt)}` : ''}. Update the plan and resubmit.`}
                {mySubmission.status === 'draft' && (
                  config?.goalCreationMode === 'admin-library'
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
                  Goal limit: {limits.min || 0} - {limits.max || '∞'}
                </div>
              ) : null}
              <div style={{ padding: '6px 10px', borderRadius: 999, background: '#FFFFFF', border: '1px solid #E2E8F0', fontSize: 12, color: '#475569', fontWeight: 600 }}>
                Access: {config?.goalCreationMode === 'admin-library'
                  ? accessMode === 'locked' ? 'View and submit'
                    : accessMode === 'add-kpis' ? (config?.goalKpiMode === 'kra-only' ? 'Add KPIs' : 'Suggest extra KPIs')
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
            You have {pendingApprovals.length} goal approval {pendingApprovals.length === 1 ? 'request' : 'requests'} waiting in the `Approvals` tab.
          </div>
        ) : null}

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

        {myGoals.length === 0 && !canAddKra ? (
          <EmptyState title="No goals assigned yet" subtitle="Your goal library has not been assigned for this cycle." />
        ) : (
          <div>
            {perspectiveGroups.map((group) => {
              const groupWeight = group.goals.reduce((sum, goal) => sum + (Number(goal.weight) || 0), 0);
              return (
                <div key={group.perspective} style={{ marginBottom: 18, borderRadius: 16, overflow: 'hidden', border: `1px solid ${group.color}30`, background: '#fff', boxShadow: '0 12px 28px rgba(15,23,42,.04)' }}>
                  <div style={{ background: `linear-gradient(135deg, ${group.color}18 0%, ${group.color}08 100%)`, borderBottom: `1px solid ${group.color}24`, padding: '16px 18px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
                      <div>
                        <div style={{ fontSize: 11, fontWeight: 800, color: group.color, letterSpacing: '.08em', textTransform: 'uppercase', marginBottom: 4 }}>Perspective</div>
                        <div style={{ fontSize: 18, fontWeight: 800, color: '#0F172A' }}>{group.perspective}</div>
                      </div>
                      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                        <div style={{ padding: '6px 10px', borderRadius: 999, background: '#FFFFFF', border: `1px solid ${group.color}24`, color: group.color, fontSize: 12, fontWeight: 700 }}>
                          {group.goals.length} KRAs
                        </div>
                        <div style={{ padding: '6px 10px', borderRadius: 999, background: '#FFFFFF', border: `1px solid ${group.color}24`, color: group.color, fontSize: 12, fontWeight: 700 }}>
                          {groupWeight.toFixed(1)}%
                        </div>
                      </div>
                    </div>
                  </div>

                  <div style={{ padding: '14px' }}>
                    {group.goals.map((goal, goalIndex) => {
                      const showPerspectiveField = perspectives.length > 0 && canEditKraFields;
                      return (
                        <div key={goal.id} style={{ background: '#fff', border: '1.5px solid #E9EDF2', borderRadius: 14, marginBottom: 14, overflow: 'hidden' }}>
                          <div style={{ padding: '14px 18px', display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'flex-start', flexWrap: 'wrap' }}>
                            <div style={{ flex: 1, minWidth: 240 }}>
                              {showPerspectiveField ? (
                                <select
                                  value={goal.perspName}
                                  onChange={(event) => updateGoal(goal.id, 'perspName', event.target.value)}
                                  style={{ width: '100%', marginBottom: 10, padding: '10px 12px', borderRadius: 10, border: '1.5px solid #D9E2EC', fontFamily: 'inherit', fontSize: 13, background: '#fff' }}
                                >
                                  <option value="">Select perspective</option>
                                  {perspectives.map((perspective) => (
                                    <option key={perspective.name} value={perspective.name}>{perspective.name}</option>
                                  ))}
                                </select>
                              ) : null}

                              {canEditKraFields ? (
                                <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) 120px', gap: 10 }}>
                                  <input
                                    value={goal.name}
                                    onChange={(event) => updateGoal(goal.id, 'name', event.target.value)}
                                    placeholder={`Goal ${goalIndex + 1}`}
                                    style={{ padding: '11px 12px', borderRadius: 10, border: '1.5px solid #D9E2EC', fontFamily: 'inherit', fontSize: 13.5 }}
                                  />
                                  <input
                                    value={goal.weight}
                                    onChange={(event) => updateGoal(goal.id, 'weight', event.target.value)}
                                    placeholder="Weight %"
                                    type="number"
                                    min="0"
                                    step="0.1"
                                    style={{ padding: '11px 12px', borderRadius: 10, border: '1.5px solid #D9E2EC', fontFamily: 'inherit', fontSize: 13.5 }}
                                  />
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
                            {canAddKra ? (
                              <button
                                type="button"
                                onClick={() => removeGoal(goal.id)}
                                style={{ padding: '8px 12px', borderRadius: 10, border: '1px solid #FECACA', background: '#FFF1F2', color: '#DC2626', cursor: 'pointer', fontFamily: 'inherit', fontSize: 12.5, fontWeight: 700 }}
                              >
                                Remove goal
                              </button>
                            ) : null}
                          </div>

                          <div style={{ padding: '0 14px 14px' }}>
                            {(goal.kpis || []).map((kpi) => {
                              const isEmployeeAdded = kpi.source !== 'library';
                              const kpiEditable = canEditExistingKpi || (canAddKpi && isEmployeeAdded);
                              const isSuggestionMode = config?.goalCreationMode === 'admin-library' && config?.goalKpiMode === 'kra-kpi' && accessMode === 'add-kpis';
                              return (
                                <div key={kpi.id} style={{ padding: '12px', borderRadius: 12, background: '#F8FAFC', border: '1px solid #E9EDF2', marginTop: 10, display: 'flex', gap: 12, alignItems: 'flex-start', flexWrap: 'wrap' }}>
                                  <div style={{ flex: 1, minWidth: 220 }}>
                                    {kpiEditable ? (
                                      <div style={{ display: 'grid', gridTemplateColumns: isSuggestionMode ? 'minmax(0,1fr) minmax(0,1fr)' : 'minmax(0,1fr) 110px minmax(0,1fr)', gap: 10 }}>
                                        <input
                                          value={kpi.name}
                                          onChange={(event) => updateKpi(goal.id, kpi.id, 'name', event.target.value)}
                                          placeholder="KPI name"
                                          style={{ padding: '10px 12px', borderRadius: 10, border: '1.5px solid #D9E2EC', fontFamily: 'inherit', fontSize: 13, background: '#fff' }}
                                        />
                                        {!isSuggestionMode ? (
                                          <input
                                            value={kpi.weight}
                                            onChange={(event) => updateKpi(goal.id, kpi.id, 'weight', event.target.value)}
                                            placeholder="Weight %"
                                            type="number"
                                            min="0"
                                            step="0.1"
                                            style={{ padding: '10px 12px', borderRadius: 10, border: '1.5px solid #D9E2EC', fontFamily: 'inherit', fontSize: 13, background: '#fff' }}
                                          />
                                        ) : null}
                                        <input
                                          value={kpi.target || ''}
                                          onChange={(event) => updateKpi(goal.id, kpi.id, 'target', event.target.value)}
                                          placeholder="Target / success metric"
                                          style={{ padding: '10px 12px', borderRadius: 10, border: '1.5px solid #D9E2EC', fontFamily: 'inherit', fontSize: 13, background: '#fff' }}
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
                                  {kpiEditable ? (
                                    <button
                                      type="button"
                                      onClick={() => removeKpi(goal.id, kpi.id)}
                                      style={{ padding: '8px 10px', borderRadius: 10, border: '1px solid #E2E8F0', background: '#fff', color: '#64748B', cursor: 'pointer', fontFamily: 'inherit', fontSize: 12 }}
                                    >
                                      Remove
                                    </button>
                                  ) : null}
                                </div>
                              );
                            })}

                            {canAddKpi ? (
                              <div style={{ marginTop: 12 }}>
                                <button
                                  type="button"
                                  onClick={() => addKpi(goal.id)}
                                  style={{ padding: '8px 12px', borderRadius: 10, border: `1px dashed ${group.color}66`, background: `${group.color}08`, color: group.color, cursor: 'pointer', fontFamily: 'inherit', fontSize: 12.5, fontWeight: 700 }}
                                >
                                  + {config?.goalKpiMode === 'kra-kpi' && accessMode === 'add-kpis' ? 'Suggest extra KPI' : 'Add KPI'}
                                </button>
                              </div>
                            ) : null}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}

            {canAddKra ? (
              <div style={{ marginTop: 8 }}>
                <button
                  type="button"
                  onClick={addGoal}
                  style={{ padding: '10px 16px', borderRadius: 10, border: '1px dashed #93C5FD', background: '#F8FBFF', color: '#2563EB', cursor: 'pointer', fontFamily: 'inherit', fontSize: 13, fontWeight: 700 }}
                >
                  + Add Goal
                </button>
              </div>
            ) : null}

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
