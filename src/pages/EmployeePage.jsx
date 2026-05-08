import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import zaroLogo from '../../images/final zaro logo.png';
import { resolveBrandPalette, buildHeroGradient, resolveHero, buildHeroBackground, fillAccent, cardAccentStyle, cardStripeWidth, normalizeCardsMode } from '../brandPalettes';
import {
  readEmployeeSessionSync,
  readAppDataSync,
  readWizardStateSync,
  readWorkflowSync,
  hydrateWorkflow,
  persistWorkflow,
  readMessagesSync,
  hydrateMessages,
  persistMessages,
  hydrateWizardState,
  hydrateAppData,
} from '../backend/stateStore';

const EMP_SESSION_KEY = 'zarohr_emp_session';
const WIZARD_STATE_KEY = 'zarohr_pms_wizard_state_v1';
const APP_DATA_KEY = 'zarohr_app_data_v1';
const GOAL_WORKFLOW_KEY = 'zarohr_goal_workflow_v1';
const MESSAGES_KEY = 'zarohr_messages_v1';
const REMINDER_COOLDOWN_MS = 4 * 60 * 60 * 1000;

// Feature flag. Rating + competency flows are parked until the rating math / rollup is wired.
// Flip to `true` to re-enable the self-evaluation phase, rating widgets, and scale-colour UI.
// Every rating-specific code path checks this flag, so the surfaces can come back without a
// code-archaeology exercise.
const RATING_ENABLED = false;

const ALL_PHASES = [
  { id: 'goal-setting', label: 'Goal Setting', icon: '🎯' },
  { id: 'mid-year-review', label: 'Mid-Year Review', icon: '📊' },
  { id: 'self-evaluation', label: 'Self Evaluation', icon: '✍️', ratingOnly: true },
  { id: 'manager-rating', label: 'Manager Rating', icon: '👤', ratingOnly: true },
  { id: 'hr-review', label: 'HR Review', icon: '🔍', ratingOnly: true },
  { id: 'results-published', label: 'Results Published', icon: '🏆', ratingOnly: true },
];
const PHASES = RATING_ENABLED ? ALL_PHASES : ALL_PHASES.filter((p) => !p.ratingOnly);

const SCALE_DEFAULTS = {
  3: [{ n: 1, l: 'Below Expectations' }, { n: 2, l: 'Meets Expectations' }, { n: 3, l: 'Exceeds Expectations' }],
  4: [{ n: 1, l: 'Below Expectations' }, { n: 2, l: 'Meets Expectations' }, { n: 3, l: 'Exceeds Expectations' }, { n: 4, l: 'Outstanding' }],
  5: [{ n: 1, l: 'Needs Improvement' }, { n: 2, l: 'Below Expectations' }, { n: 3, l: 'Meets Expectations' }, { n: 4, l: 'Exceeds Expectations' }, { n: 5, l: 'Outstanding' }],
  10: Array.from({ length: 10 }, (_, i) => ({ n: i + 1, l: `Level ${i + 1}` })),
};

const SCALE_COLORS = ['#DC2626', '#F97316', '#FBBF24', '#84CC16', '#22C55E', '#10B981', '#14B8A6', '#3B82F6', '#8B5CF6', '#EC4899'];
// Perspective colours — intentionally EXCLUDE red / orange / green families. Those hues are
// reserved for status semantics (rejected / pending / approved) elsewhere in the app, so
// using them for decorative perspective stripes makes a blue-coded goal look "approved" or
// an amber-coded goal look "pending review" at a glance.
const PERSPECTIVE_COLORS = ['#3B82F6', '#38BDF8', '#6366F1', '#818CF8', '#A78BFA', '#22D3EE'];
// Any perspective record that has one of these hexes stored was set from the old defaults;
// we swap it at read-time for a safe colour so existing orgs get cleaned up automatically.
const SEMANTIC_RESERVED_HEXES = new Set([
  // reds
  '#DC2626', '#B91C1C', '#991B1B', '#EF4444', '#F87171', '#FCA5A5',
  // oranges / ambers
  '#D97706', '#C2410C', '#EA580C', '#F59E0B', '#FB923C', '#FDBA74', '#EAB308',
  // greens
  '#16A34A', '#15803D', '#22C55E', '#4ADE80', '#86EFAC', '#10B981',
]);
function safePerspectiveColor(stored, index) {
  const fallback = PERSPECTIVE_COLORS[index % PERSPECTIVE_COLORS.length];
  if (!stored) return fallback;
  const upper = String(stored).toUpperCase();
  return SEMANTIC_RESERVED_HEXES.has(upper) ? fallback : stored;
}

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
    return readEmployeeSessionSync();
  } catch {
    return null;
  }
}

function loadCurrentPhase(orgKey) {
  try {
    const data = readAppDataSync();
    if (!data) return 'goal-setting';
    const org = (data.organizationsData || []).find((item) => item.key === orgKey);
    const stored = org?.currentPhase || 'goal-setting';
    // With rating disabled, rating-only phases collapse back to goal-setting so the employee
    // page never tries to render rating surfaces even if the admin flipped the phase earlier.
    if (!RATING_ENABLED && stored !== 'goal-setting' && stored !== 'mid-year-review') return 'goal-setting';
    return stored;
  } catch {
    return 'goal-setting';
  }
}

function loadOrgBrand(orgKey) {
  try {
    const data = readAppDataSync();
    if (!data) return {};
    const org = (data.organizationsData || []).find((item) => item.key === orgKey);
    return {
      brandLogo: org?.brandLogo || null,
      brandName: org?.brandName || org?.name || '',
      brandPalette: org?.brandPalette || null,
      brandHero: org?.brandHero || null,
      brandCards: org?.brandCards || 'default',
      brandFill: org?.brandFill || 'gradient',
    };
  } catch {
    return {};
  }
}

function loadConfig() {
  try {
    const session = readEmployeeSessionSync();
    const preferredOrgKey = session?.orgKey || '';
    if (preferredOrgKey) {
      const parsed = readWizardStateSync(preferredOrgKey);
      if (parsed?.config) return parsed.config;
    }
  } catch {
    return null;
  }
  return null;
}

function loadWorkflow(orgKey) {
  if (!orgKey) return { submissions: {}, notifications: [] };
  return readWorkflowSync(orgKey);
}

function saveWorkflow(orgKey, workflow) {
  if (!orgKey) return;
  persistWorkflow(orgKey, workflow);
}

function getMessagesStorageKey(orgKey = '') {
  return `${MESSAGES_KEY}:${orgKey || 'default'}`;
}

function convKey(codeA, codeB) {
  return [normalizeCode(codeA), normalizeCode(codeB)].sort().join('::');
}

function loadMessages(orgKey) {
  if (!orgKey) return { conversations: {} };
  return readMessagesSync(orgKey);
}

function saveMessages(orgKey, data) {
  if (!orgKey) return;
  persistMessages(orgKey, data);
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

function getManagerName(config, managerCode, storedName = '') {
  if (!managerCode) return null;
  const employees = config?.employeeUploadData?.employees || [];
  const manager = employees.find((employee) => String(employee['Employee Code'] || '').trim() === String(managerCode).trim());
  if (manager) return String(manager['Employee Name'] || '').trim() || storedName || managerCode;
  return storedName || managerCode;
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
  const kpiRatingMode = group.kpiRatingMode === 'free-text' ? 'free-text' : 'rated';

  if (!prefill) {
    // No pre-fill: employee creates from scratch (Open Canvas / Guided Scratch)
    return { goalCreationMode: 'employee-self', goalEmployeeEdit: 'edit-freely', goalKpiMode: group.libraryType || 'kra-kpi', kpiRatingMode };
  }
  if (!canEdit) {
    // Pre-filled, no editing allowed
    // kras-only → employee can add KPIs to the locked KRA structure
    // kra-kpi  → everything locked, just view and submit
    return {
      goalCreationMode: 'admin-library',
      goalEmployeeEdit: prefill === 'kra-kpi' ? 'locked' : 'add-kpis',
      goalKpiMode: prefill,
      kpiRatingMode,
    };
  }
  // Pre-filled + can edit (Prefill+Customize / Prefill+Guided)
  return { goalCreationMode: 'admin-library', goalEmployeeEdit: 'edit-freely', goalKpiMode: prefill, kpiRatingMode };
}

function buildInitialGoals(config, employee, group, libraries) {
  // New multi-group model: pre-fill from group.prefillData / group.prefillAssignments
  // The wizard stores pre-fill data directly on the group object, NOT in goalLibraries.
  if (group?.prefillType) {
    // Step 1: try segmented prefillAssignments (one slot per dept/value)
    let perspectives = null;
    const assignments = group.prefillAssignments || [];
    if (assignments.length > 0 && group.segmentAttr) {
      const attrVal = String(employee?.[group.segmentAttr] || '').trim().toLowerCase();
      const match = assignments.find((a) => String(a.slotKey || '').trim().toLowerCase() === attrVal);
      if (match?.data?.length > 0) perspectives = match.data;
    }
    // Step 2: fall back to the flat prefillData array (non-segmented single-slot group)
    if (!perspectives && Array.isArray(group.prefillData) && group.prefillData.length > 0) {
      perspectives = group.prefillData;
    }

    if (perspectives && perspectives.length > 0) {
      // The wizard stores pre-fill data in two possible formats:
      //  A) Perspectives format (StepPrefillData / bulk import):
      //       [{id, name, kras:[{id, name, suggestedWeight, kpis:[...]}]}]
      //  B) Flat KRAs format (GroupDataUploadPanel / per-group upload):
      //       [{id, name, weight, perspName, kpis:[...]}]
      // Detect by checking whether the first item has a `kras` array.
      const isPerspFormat = Array.isArray(perspectives[0]?.kras);

      if (isPerspFormat) {
        return perspectives.flatMap((persp) =>
          (persp.kras || []).map((kra) =>
            createKra({
              ...kra,
              perspName: kra.perspName || persp.name || '',
              weight: String(kra.suggestedWeight ?? kra.weight ?? '').trim(),
              kpis: group.prefillType === 'kra-kpi'
                ? (kra.kpis || []).map((kpi) => createKpi({
                    ...kpi,
                    weight: String(kpi.suggestedWeight ?? kpi.weight ?? '').trim(),
                  }, 'library'))
                : [],
            })
          )
        );
      } else {
        // Flat KRAs — each item is already a KRA with optional perspName
        return perspectives.map((kra) =>
          createKra({
            ...kra,
            weight: String(kra.suggestedWeight ?? kra.weight ?? '').trim(),
            kpis: group.prefillType === 'kra-kpi'
              ? (kra.kpis || []).map((kpi) => createKpi({
                  ...kpi,
                  weight: String(kpi.suggestedWeight ?? kpi.weight ?? '').trim(),
                }, 'library'))
              : [],
          })
        );
      }
    }

    // Step 3: legacy fallback — goalLibraries reference (rarely used, kept for compatibility)
    if (libraries) {
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

function getGoalLimits(config, employee, group) {
  // 1. Per-group limits set in the group editor (goalLimitsEnabled / goalMin / goalMax)
  if (group?.goalLimitsEnabled) {
    return { min: Number(group.goalMin) || 0, max: Number(group.goalMax) || 0 };
  }
  // 2. BSC global limitsRules keyed by groupId
  if (config?.limitsEnabled && group?.id) {
    const rule = (config.limitsRules || []).find((r) => r.groupId === group.id);
    if (rule && (rule.minKRAs || rule.maxKRAs)) {
      return { min: Number(rule.minKRAs) || 0, max: Number(rule.maxKRAs) || 0 };
    }
  }
  // 3. Legacy model
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

function formatRelativeTime(value) {
  if (!value) return '';
  const then = new Date(value).getTime();
  if (!Number.isFinite(then)) return '';
  const diff = Math.max(0, Date.now() - then);
  const min = Math.floor(diff / 60000);
  if (min < 1) return 'Just now';
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d ago`;
  const wk = Math.floor(day / 7);
  if (wk < 5) return `${wk}w ago`;
  return new Date(value).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' });
}

function isSameDay(a, b) {
  const da = new Date(a); const db = new Date(b);
  return da.getFullYear() === db.getFullYear() && da.getMonth() === db.getMonth() && da.getDate() === db.getDate();
}

function formatDayLabel(ts) {
  const d = new Date(ts);
  const now = new Date();
  if (isSameDay(ts, now.getTime())) return 'Today';
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  if (isSameDay(ts, yesterday.getTime())) return 'Yesterday';
  return d.toLocaleDateString([], {
    day: 'numeric', month: 'short',
    year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric',
  });
}

function formatTimeShort(ts) {
  try {
    return new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  } catch {
    return '';
  }
}

function groupNotificationsByTime(items) {
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfYesterday = startOfToday - 24 * 60 * 60 * 1000;
  const startOfWeek = startOfToday - 6 * 24 * 60 * 60 * 1000;
  const buckets = { today: [], yesterday: [], week: [], earlier: [] };
  items.forEach((n) => {
    const t = new Date(n.createdAt).getTime();
    if (!Number.isFinite(t)) { buckets.earlier.push(n); return; }
    if (t >= startOfToday) buckets.today.push(n);
    else if (t >= startOfYesterday) buckets.yesterday.push(n);
    else if (t >= startOfWeek) buckets.week.push(n);
    else buckets.earlier.push(n);
  });
  return [
    buckets.today.length ? { id: 'today', label: 'Today', items: buckets.today } : null,
    buckets.yesterday.length ? { id: 'yesterday', label: 'Yesterday', items: buckets.yesterday } : null,
    buckets.week.length ? { id: 'week', label: 'This Week', items: buckets.week } : null,
    buckets.earlier.length ? { id: 'earlier', label: 'Earlier', items: buckets.earlier } : null,
  ].filter(Boolean);
}

const NOTIFICATION_META = {
  'goal-submitted': {
    color: '#D97706', bg: '#FEF3C7', border: '#FDE68A',
    cta: 'Review goals →',
    icon: (
      <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 2 11 13"/><path d="M22 2 15 22l-4-9-9-4z"/></svg>
    ),
  },
  'goal-approved': {
    color: '#16A34A', bg: '#DCFCE7', border: '#BBF7D0',
    cta: 'View your plan →',
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
    ),
  },
  'goal-rejected': {
    color: '#DC2626', bg: '#FEE2E2', border: '#FECACA',
    cta: 'Update your plan →',
    icon: (
      <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 8v4"/><path d="M12 16h.01"/></svg>
    ),
  },
  'goal-reminder': {
    color: '#2563EB', bg: '#DBEAFE', border: '#BFDBFE',
    cta: 'Open goals →',
    icon: (
      <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/></svg>
    ),
  },
};

const FALLBACK_NOTIFICATION_META = {
  color: '#475569', bg: '#F1F5F9', border: '#E2E8F0', cta: 'Open',
  icon: (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 8v4"/><path d="M12 16h.01"/></svg>
  ),
};

function getPerspectiveColor(kra, perspectives) {
  if (!kra?.perspName) return '#2563EB';
  const index = perspectives.findIndex((perspective) => perspective.name === kra.perspName);
  if (index < 0) return '#2563EB';
  return safePerspectiveColor(perspectives[index].color, index);
}

const TARGET_TYPES = [
  { id: 'text',       icon: 'Aa', label: 'Free text',   example: 'anything' },
  { id: 'number',     icon: '#',  label: 'Number',      example: 'e.g. 5000' },
  { id: 'currency',   icon: '₹',  label: 'Currency',    example: 'e.g. 5 Cr' },
  { id: 'percentage', icon: '%',  label: 'Percentage',  example: 'e.g. 95' },
  { id: 'duration',   icon: '⧗',  label: 'Duration',    example: 'e.g. < 24 hrs' },
  { id: 'date',       icon: '📅', label: 'Date',        example: 'pick a date' },
  { id: 'rating',     icon: '★',  label: 'Rating',      example: 'e.g. 4.5 / 5' },
  { id: 'milestone',  icon: '✓',  label: 'Milestone',   example: 'e.g. Phase 2 live' },
];

function TargetField({ value, onValueChange, type, onTypeChange }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState(null);
  const wrapRef = useRef(null);
  const btnRef = useRef(null);
  const popRef = useRef(null);
  const current = TARGET_TYPES.find((t) => t.id === type) || TARGET_TYPES[0];

  const POP_W = 220;
  const POP_H = 320;

  // Position the floating popover near the button. Uses fixed positioning so it escapes
  // the modal body's overflow:auto (which was clipping it and chaining wheel scroll up).
  useEffect(() => {
    if (!open) return;
    const place = () => {
      const btn = btnRef.current;
      if (!btn) return;
      const r = btn.getBoundingClientRect();
      const margin = 8;
      const spaceBelow = window.innerHeight - r.bottom;
      const openUp = spaceBelow < POP_H + margin && r.top > spaceBelow;
      const top = openUp ? Math.max(margin, r.top - 6 - POP_H) : r.bottom + 6;
      let left = r.left;
      if (left + POP_W > window.innerWidth - margin) left = window.innerWidth - POP_W - margin;
      if (left < margin) left = margin;
      setPos({ top, left });
    };
    place();
    // Capture-phase scroll listener catches scrolls on any ancestor (including modal body).
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    return () => {
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDocDown = (e) => {
      const inWrap = wrapRef.current && wrapRef.current.contains(e.target);
      const inPop = popRef.current && popRef.current.contains(e.target);
      if (!inWrap && !inPop) setOpen(false);
    };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDocDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const showPrefix = type === 'currency';
  const showSuffix = type === 'percentage';
  const inputType = type === 'date' ? 'date' : 'text';

  return (
    <div ref={wrapRef} style={{ position: 'relative', display: 'flex', alignItems: 'stretch', border: '1.5px solid #D9E2EC', borderRadius: 9, background: '#fff' }}>
      <button
        ref={btnRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        title={`Target type: ${current.label}`}
        aria-label={`Target type: ${current.label}. Click to change.`}
        style={{ width: 30, display: 'flex', alignItems: 'center', justifyContent: 'center', background: open ? '#EFF6FF' : '#F8FAFC', border: 'none', borderRight: '1px solid #E2E8F0', borderRadius: '7.5px 0 0 7.5px', cursor: 'pointer', fontSize: 13, fontWeight: 700, color: open ? '#1D4ED8' : '#475569', fontFamily: 'inherit' }}
      >
        {current.icon}
      </button>
      {showPrefix && (
        <span style={{ padding: '0 2px 0 8px', display: 'flex', alignItems: 'center', color: '#64748B', fontSize: 13, fontWeight: 600 }}>₹</span>
      )}
      <input
        type={inputType}
        value={value}
        onChange={(e) => onValueChange(e.target.value)}
        placeholder={current.example}
        style={{ flex: 1, minWidth: 0, width: '100%', padding: '9px 10px', border: 'none', outline: 'none', fontFamily: 'inherit', fontSize: 13, background: 'transparent' }}
      />
      {showSuffix && (
        <span style={{ padding: '0 8px 0 2px', display: 'flex', alignItems: 'center', color: '#64748B', fontSize: 13, fontWeight: 600 }}>%</span>
      )}
      {open && pos && typeof document !== 'undefined' && createPortal(
        <div
          ref={popRef}
          style={{
            position: 'fixed', top: pos.top, left: pos.left, width: POP_W, maxHeight: POP_H,
            background: '#fff', borderRadius: 12,
            boxShadow: '0 16px 44px rgba(15,23,42,0.22), 0 1px 3px rgba(15,23,42,0.08)',
            border: '1px solid #E2E8F0', padding: 6, zIndex: 1100,
            overflowY: 'auto', overscrollBehavior: 'contain',
          }}
          onWheel={(e) => e.stopPropagation()}
        >
          {TARGET_TYPES.map((t) => {
            const active = t.id === type;
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => { onTypeChange(t.id); setOpen(false); }}
                style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 10, padding: '7px 8px', borderRadius: 8, border: 'none', background: active ? '#EFF6FF' : 'transparent', cursor: 'pointer', fontFamily: 'inherit', textAlign: 'left' }}
                onMouseEnter={(e) => { if (!active) e.currentTarget.style.background = '#F8FAFC'; }}
                onMouseLeave={(e) => { if (!active) e.currentTarget.style.background = 'transparent'; }}
              >
                <span style={{ width: 24, height: 24, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 7, background: active ? '#DBEAFE' : '#F1F5F9', fontSize: 12.5, fontWeight: 700, color: active ? '#1D4ED8' : '#475569', flexShrink: 0 }}>{t.icon}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 12.5, fontWeight: 600, color: '#0F172A', lineHeight: 1.2 }}>{t.label}</div>
                  <div style={{ fontSize: 10.5, color: '#94A3B8', marginTop: 1 }}>{t.example}</div>
                </div>
              </button>
            );
          })}
        </div>,
        document.body
      )}
    </div>
  );
}

// Tone convention:
//   red    = pending / awaiting (blocks the other side)
//   orange = sent-back (needs work but not blocking)
//   green  = approved
//   blue   = draft / informational
function getSubmissionStatusMeta(record) {
  switch (record?.status) {
    case 'pending-manager':
      return { label: 'Awaiting manager approval', color: '#DC2626', bg: '#FEF2F2', border: '#FECACA' };
    case 'approved':
      return { label: 'Approved', color: '#16A34A', bg: '#F0FDF4', border: '#BBF7D0' };
    case 'sent-back':
      return { label: 'Changes requested', color: '#D97706', bg: '#FFF7ED', border: '#FED7AA' };
    default:
      return { label: 'Draft in progress', color: '#2563EB', bg: '#EFF6FF', border: '#BFDBFE' };
  }
}

// Returns the per-goal review status. Goals that have explicit reviewStatus use that. Legacy
// submissions (no per-goal marks) fall back to the submission-level status applied to every goal.
function getGoalReviewStatus(goal, submission) {
  if (goal?.reviewStatus === 'approved' || goal?.reviewStatus === 'rejected') return goal.reviewStatus;
  if (submission?.status === 'approved') return 'approved';
  if (submission?.status === 'sent-back') return 'rejected';
  return 'pending';
}

function getGoalStatusMeta(status) {
  if (status === 'approved') return { label: 'Approved', color: '#16A34A', bg: '#F0FDF4', border: '#BBF7D0' };
  if (status === 'rejected') return { label: 'Changes requested', color: '#D97706', bg: '#FFF7ED', border: '#FED7AA' };
  if (status === 'pending') return { label: 'Awaiting review', color: '#DC2626', bg: '#FEF2F2', border: '#FECACA' };
  return null;
}

function getGoalPlanMetrics(goals, config, accessMode) {
  const activeGoals = (goals || []).filter((goal) => sanitizeText(goal.name) || (goal.kpis || []).some((kpi) => sanitizeText(kpi.name)));
  const validGoalWeight = activeGoals.reduce((sum, goal) => {
    const weight = Number(goal.weight);
    return Number.isFinite(weight) && weight > 0 ? sum + weight : sum;
  }, 0);

  const freeTextKpis = config?.kpiRatingMode === 'free-text';
  const shouldTrackKpis = !freeTextKpis && (config?.goalCreationMode === 'employee-self' || config?.goalKpiMode === 'kra-kpi');

  // KPI coverage shows the live KPI weight total so the header responds while editing.
  // Mismatches are still tracked separately so validation can flag goals whose KPI
  // weights do not equal their KRA weight.
  let validKpiWeight = 0;
  let kpiMismatch = false;
  activeGoals.forEach((goal) => {
    const goalWeight = Number(goal.weight);
    const kpis = goal.kpis || [];
    const kpiSum = kpis.reduce((inner, kpi) => {
      const w = Number(kpi.weight);
      return Number.isFinite(w) && w > 0 ? inner + w : inner;
    }, 0);
    validKpiWeight += kpiSum;
    if (!shouldTrackKpis) return;
    if (!Number.isFinite(goalWeight) || goalWeight <= 0) return;
    if (kpis.length === 0) return; // already counted as missing in validation
    if (Math.abs(kpiSum - goalWeight) > 0.01) {
      kpiMismatch = true; // bar should not say 100%
    }
  });

  // Do NOT cap at 100 — if the employee has allocated > 100%, the UI must show the actual number
  // and flag it red, not silently report "100% complete".
  const goalPct = Math.max(0, Math.round(validGoalWeight));
  const kpiPct = shouldTrackKpis ? Math.max(0, Math.round(validKpiWeight)) : 100;
  const goalOver = goalPct > 100;
  const kpiOver = kpiPct > 100;
  const displayGoalPct = Math.min(100, goalPct);
  const displayKpiPct = Math.min(100, kpiPct);
  const overall = shouldTrackKpis ? Math.round((displayGoalPct + displayKpiPct) / 2) : displayGoalPct;

  return {
    goalPct,         // raw, may exceed 100
    kpiPct,          // raw, may exceed 100
    overall,         // clamped for progress bar width
    shouldTrackKpis,
    kpiMismatch,
    goalOver,
    kpiOver,
    invalid: goalOver || kpiOver || kpiMismatch || goalPct < 100 - 0.01,
  };
}

function groupGoalsByPerspective(goals, perspectives) {
  const lookup = new Map((perspectives || []).map((perspective, index) => [
    perspective.name,
    { color: safePerspectiveColor(perspective.color, index), order: index },
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

function getEmployeeGoalGroup(config, employee) {
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
}

function getKpiRowIssues(goal, { requireWeights = true } = {}) {
  const issues = [];
  (goal?.kpis || []).forEach((kpi, index) => {
    const fallbackLabel = `KPI ${index + 1}`;
    const kpiName = sanitizeText(kpi.name);
    const kpiWeight = Number(kpi.weight);
    if (!kpiName) {
      issues.push({ kind: 'error', text: `${fallbackLabel} is missing a name` });
    }
    if (requireWeights && (!Number.isFinite(kpiWeight) || kpiWeight <= 0)) {
      issues.push({ kind: 'error', text: `${kpiName || fallbackLabel} needs a weight greater than 0` });
    }
  });
  return issues;
}

// Per-goal issue list. Used by BOTH the inline red badges on goal cards AND the submit-level
// validation below — single source of truth so card state can never disagree with submit state.
// Locked goals (already approved during a sent-back round) skip per-field checks; their weights
// still count toward the plan-wide 100% total.
function getGoalIssues(goal, { config, accessMode, perspectives, isEditableStructure, mustCreateKpis, isLocked }) {
  const issues = [];

  const goalName = sanitizeText(goal.name);
  const goalWeight = Number(goal.weight);
  const kpis = goal.kpis || [];
  const shouldValidateKpiWeights = config?.kpiRatingMode !== 'free-text';
  const kpiRowIssues = getKpiRowIssues(goal, { requireWeights: shouldValidateKpiWeights });

  // Structural checks on a locked (already-approved) goal still surface as a card-level
  // error so a broken prior-round approval shows up on its own card instead of only as a
  // plan-wide message. Field-level user-fix prompts are suppressed since the employee
  // can't edit the goal.
  if (isLocked) {
    issues.push(...kpiRowIssues);
    if (shouldValidateKpiWeights && kpis.length > 0 && Number.isFinite(goalWeight) && goalWeight > 0) {
      const kpiWeightTotal = kpis.reduce((sum, kpi) => {
        const w = Number(kpi.weight);
        return Number.isFinite(w) && w > 0 ? sum + w : sum;
      }, 0);
      if (Math.abs(kpiWeightTotal - goalWeight) > 0.01) {
        issues.push({ kind: 'error', text: `KPI weights ${kpiWeightTotal}% ≠ goal weight ${goalWeight}%` });
      }
    }
    return issues;
  }

  if (!goalName) issues.push({ kind: 'error', text: 'Missing goal name' });

  if ((isEditableStructure || config?.goalCreationMode === 'employee-self') &&
      (!Number.isFinite(goalWeight) || goalWeight <= 0)) {
    issues.push({ kind: 'error', text: 'Set a weight greater than 0' });
  }

  if ((perspectives?.length || 0) > 0 &&
      (isEditableStructure || config?.goalCreationMode === 'employee-self') &&
      !sanitizeText(goal.perspName)) {
    issues.push({ kind: 'error', text: 'Select a perspective' });
  }

  if (mustCreateKpis && kpis.length === 0) {
    issues.push({ kind: 'error', text: 'Add at least one KPI' });
  }

  // KPI-level checks — run in ALL modes. The sum-vs-goal-weight check was previously
  // gated behind add-kpis mode; that gap let library-driven plans submit with mismatched
  // KPI weights. It now runs universally.
  issues.push(...kpiRowIssues);
  let kpiWeightTotal = 0;
  if (shouldValidateKpiWeights) {
    kpis.forEach((kpi) => {
      const kpiWeight = Number(kpi.weight);
      if (Number.isFinite(kpiWeight) && kpiWeight > 0) kpiWeightTotal += kpiWeight;
    });
  }
  if (shouldValidateKpiWeights && kpis.length > 0 && Number.isFinite(goalWeight) && goalWeight > 0 &&
      Math.abs(kpiWeightTotal - goalWeight) > 0.01) {
    issues.push({ kind: 'error', text: `KPI weights ${kpiWeightTotal}% ≠ goal weight ${goalWeight}%` });
  }

  return issues;
}

// Universal structural-integrity check — no config dependency. Used by manager-side guards
// (per-goal Approve button + reviewSubmission auto-reject) so a broken goal can never be
// approved regardless of which user's config is loaded at the time.
function isGoalStructurallyValid(goal, config = null) {
  if (!goal) return false;
  if (!sanitizeText(goal.name)) return false;
  const w = Number(goal.weight);
  if (!Number.isFinite(w) || w <= 0) return false;
  const kpis = goal.kpis || [];
  const requiresKpis = config?.goalKpiMode === 'kra-kpi' || (!config?.goalKpiMode && config?.goalCreationMode === 'employee-self');
  if (requiresKpis && kpis.length === 0) return false;
  const shouldValidateKpiWeights = requiresKpis && config?.kpiRatingMode !== 'free-text';
  let kpiSum = 0;
  for (const kpi of kpis) {
    if (!sanitizeText(kpi.name)) return false;
    if (shouldValidateKpiWeights) {
      const kw = Number(kpi.weight);
      if (!Number.isFinite(kw) || kw <= 0) return false;
      kpiSum += kw;
    }
  }
  // KPI weights must sum to the goal weight — otherwise the evaluation math is miscalibrated.
  if (shouldValidateKpiWeights && Math.abs(kpiSum - w) > 0.01) return false;
  return true;
}

function getGoalPlanValidation(goals, config, accessMode, limits, perspectives) {
  const errors = [];
  const allGoals = goals || [];
  const isEditableStructure = config?.goalCreationMode === 'employee-self' || accessMode === 'edit-freely';
  const mustCreateKpis = (config?.goalCreationMode === 'employee-self' || accessMode === 'edit-freely') && config?.goalKpiMode !== 'kra-only';

  if (allGoals.length === 0) {
    errors.push('Add at least one goal before submitting.');
  }

  if (limits && allGoals.length) {
    if (limits.min > 0 && allGoals.length < limits.min) {
      errors.push(`You need at least ${limits.min} goals for this setup.`);
    }
    if (limits.max > 0 && allGoals.length > limits.max) {
      errors.push(`You can submit at most ${limits.max} goals for this setup.`);
    }
  }

  // Per-goal checks — share exactly the same rules as the card-level issue badges.
  allGoals.forEach((goal, index) => {
    const isLocked = goal.reviewStatus === 'approved';
    const issues = getGoalIssues(goal, { config, accessMode, perspectives, isEditableStructure, mustCreateKpis, isLocked });
    const goalLabel = sanitizeText(goal.name) || `Goal ${index + 1}`;
    issues.filter((i) => i.kind === 'error').forEach((issue) => {
      errors.push(`${goalLabel}: ${issue.text}`);
    });
  });

  // Plan-wide total weight must be 100%. Counts locked + editable goals alike so resubmits
  // that keep already-approved goals still sum correctly.
  if ((isEditableStructure || config?.goalCreationMode === 'employee-self') && allGoals.length > 0) {
    const total = allGoals.reduce((sum, g) => {
      const w = Number(g.weight);
      return Number.isFinite(w) ? sum + w : sum;
    }, 0);
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

const LIBRARY_CARD_COLORS = ['#F97316','#3B82F6','#22C55E','#14B8A6','#8B5CF6','#EC4899','#EAB308','#06B6D4','#DC2626','#0EA5E9'];

function GoalLibraryPanel({ kras, libraryType, libraryName, canAdd, onAdd, addedIds = new Set(), draggedGoalId = null, canReturnGoal, onReturnGoal }) {
  const [selectedId, setSelectedId] = useState(null);
  const [hoveredId, setHoveredId] = useState(null);
  const [returnDropActive, setReturnDropActive] = useState(false);

  // Only show KRAs not yet in the plan (match by tracked libraryKraId or by name)
  const visibleKras = kras.filter((k) => {
    const kid = k.id || k.name;
    const kname = sanitizeText(k.name);
    return !addedIds.has(kid) && !addedIds.has(kname);
  });

  const hasAnyKpis = visibleKras.some((k) => (k.kpis || []).length > 0);

  const handleReturnDragOver = (e) => {
    if (!canAdd || !e.dataTransfer.types.includes('application/goal-id')) return;
    const goalId = draggedGoalId || e.dataTransfer.getData('application/goal-id');
    if (goalId && canReturnGoal?.(goalId)) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      setReturnDropActive(true);
    }
  };

  const handleReturnDrop = (e) => {
    setReturnDropActive(false);
    if (!canAdd || !e.dataTransfer.types.includes('application/goal-id')) return;
    const goalId = draggedGoalId || e.dataTransfer.getData('application/goal-id');
    if (!goalId || !canReturnGoal?.(goalId)) return;
    e.preventDefault();
    onReturnGoal?.(goalId);
  };

  const libraryDropProps = {
    onDragOver: handleReturnDragOver,
    onDragLeave: (e) => {
      if (!e.currentTarget.contains(e.relatedTarget)) setReturnDropActive(false);
    },
    onDrop: handleReturnDrop,
  };

  if (visibleKras.length === 0 && kras.length > 0) {
    return (
      <div
        {...libraryDropProps}
        style={{ marginBottom: 16, background: returnDropActive ? '#EEF2FF' : 'linear-gradient(135deg,#F0FDF4 0%,#FFFFFF 100%)', border: `1.5px ${returnDropActive ? 'dashed' : 'solid'} ${returnDropActive ? '#6366F1' : '#BBF7D0'}`, borderRadius: 14, padding: '14px 18px', fontSize: 13, color: returnDropActive ? '#4338CA' : '#15803D', textAlign: 'center', fontWeight: 600 }}
      >
        {returnDropActive ? 'Drop here to return this KRA to the library.' : '✓ All library KRAs have been added to your plan.'}
      </div>
    );
  }

  return (
    <div
      {...libraryDropProps}
      style={{ marginBottom: 22, background: returnDropActive ? '#EEF2FF' : 'linear-gradient(135deg,#EEF2FF 0%,#F5F8FF 60%,#FFFFFF 100%)', border: `1.5px ${returnDropActive ? 'dashed' : 'solid'} ${returnDropActive ? '#6366F1' : '#C7D2FE'}`, borderRadius: 16, padding: '16px 18px', transition: 'border-color .15s, background .15s' }}
    >
      {/* Header */}
	      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 14, flexWrap: 'wrap' }}>
	        <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0, flexWrap: 'wrap' }}>
	          <div style={{ fontSize: 15, fontWeight: 800, color: '#0F172A', whiteSpace: 'nowrap' }}>Goal Library</div>
	          <div style={{ width: 1, height: 16, background: '#C7D2FE' }} />
	          {returnDropActive ? (
	            <span style={{ fontSize: 12, fontWeight: 800, color: '#4338CA', background: '#E0E7FF', border: '1px solid #C7D2FE', padding: '3px 10px', borderRadius: 999 }}>
	              Drop to return KRA
	            </span>
	          ) : canAdd ? (
	            <span style={{ fontSize: 12.5, fontWeight: 700, color: '#4F46E5', whiteSpace: 'nowrap' }}>
	              Drag to plan · Double-click add · Click preview
	            </span>
	          ) : (
	            <span style={{ fontSize: 12, color: '#4F46E5', fontWeight: 700 }}>{visibleKras.length} KRA{visibleKras.length !== 1 ? 's' : ''} available</span>
	          )}
	        </div>
	        <span style={{ fontSize: 10.5, fontWeight: 700, color: '#4338CA', background: '#E0E7FF', padding: '3px 10px', borderRadius: 999, border: '1px solid #C7D2FE', whiteSpace: 'nowrap', flexShrink: 0 }}>
	          {libraryType === 'kra-kpi' && hasAnyKpis ? 'KRA + KPI' : 'KRA only'}
	        </span>
      </div>

      {/* Card grid */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(200px,1fr))', gap: 12 }}>
        {visibleKras.map((kra, index) => {
          const cardId = kra.id || kra.name;
          const isSelected = selectedId === cardId;
          const kpiList = kra.kpis || [];
          const color = LIBRARY_CARD_COLORS[index % LIBRARY_CARD_COLORS.length];
          const initial = (kra.name || '?').trim().charAt(0).toUpperCase();

          return (
            <div
              key={cardId}
              draggable={canAdd}
              onDragStart={(e) => {
                e.dataTransfer.setData('application/kra', JSON.stringify(kra));
                e.dataTransfer.effectAllowed = 'copy';
              }}
              onMouseEnter={() => setHoveredId(cardId)}
              onMouseLeave={() => setHoveredId(null)}
              onClick={() => setSelectedId(isSelected ? null : cardId)}
              onDoubleClick={() => { if (canAdd) { onAdd(kra); setSelectedId(null); } }}
              title={canAdd ? 'Drag or double-click to add to plan' : undefined}
              style={{
                background: '#fff',
                border: `1.5px solid ${isSelected ? '#A5B4FC' : hoveredId === cardId ? `${color}55` : '#E2E8F0'}`,
                borderRadius: 12,
                padding: '14px',
                cursor: canAdd ? 'grab' : 'default',
                boxShadow: isSelected ? '0 4px 16px rgba(79,70,229,.14)' : hoveredId === cardId ? `0 8px 20px rgba(15,23,42,.10)` : '0 1px 4px rgba(15,23,42,.05)',
                transform: hoveredId === cardId && !isSelected ? 'translateY(-3px)' : 'none',
                userSelect: 'none',
                display: 'flex',
                flexDirection: 'column',
                gap: 8,
                transition: 'box-shadow .15s, border-color .15s, transform .15s',
              }}
            >
              {/* Icon + Name */}
              <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
                <div style={{ width: 36, height: 36, borderRadius: 10, background: `${color}18`, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                  <span style={{ fontSize: 17, fontWeight: 800, color }}>{initial}</span>
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: '#0F172A', lineHeight: 1.35 }}>{kra.name}</div>
                  {kra.desc && (
                    <div style={{ fontSize: 11.5, color: '#64748B', lineHeight: 1.4, marginTop: 2 }}>
                      {kra.desc.length > 72 ? `${kra.desc.slice(0, 72)}…` : kra.desc}
                    </div>
                  )}
                </div>
              </div>

              {/* KPI list — shown on click */}
              {isSelected && kpiList.length > 0 && (
                <div style={{ background: '#F8FAFC', borderRadius: 8, padding: '8px 10px' }}>
                  <div style={{ fontSize: 10, fontWeight: 700, color: '#94A3B8', textTransform: 'uppercase', letterSpacing: '.07em', marginBottom: 6 }}>KPIs</div>
                  {kpiList.map((kpi, i) => (
                    <div key={kpi.id || i} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11.5, color: '#374151', marginBottom: 3 }}>
                      <span>{kpi.name}</span>
                      {kpi.weight && <span style={{ color, fontWeight: 600, flexShrink: 0, marginLeft: 8 }}>{kpi.weight}%</span>}
                    </div>
                  ))}
                </div>
              )}
              {isSelected && kpiList.length === 0 && (
                <div style={{ fontSize: 11, color: '#94A3B8', fontStyle: 'italic' }}>No KPIs configured for this KRA</div>
              )}

              {/* Footer: weight chip + perspective chip */}
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', marginTop: 'auto' }}>
                {kra.weight && (
                  <span style={{ fontSize: 10.5, fontWeight: 700, color, background: `${color}14`, padding: '2px 8px', borderRadius: 999 }}>
                    {kra.weight}%
                  </span>
                )}
                {kpiList.length > 0 && !isSelected && (
                  <span style={{ fontSize: 10.5, color: '#64748B' }}>{kpiList.length} KPI{kpiList.length !== 1 ? 's' : ''}</span>
                )}
                {kra.perspName && kra.perspName !== 'All KRAs' && (
                  <span style={{ fontSize: 10.5, fontWeight: 700, color, background: `${color}14`, padding: '2px 8px', borderRadius: 999, border: `1px solid ${color}22` }}>
                    {kra.perspName}
                  </span>
                )}
              </div>

              {/* Add button — only in expanded/selected state */}
              {isSelected && canAdd && (
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); onAdd(kra); setSelectedId(null); }}
                  style={{ padding: '7px', borderRadius: 8, border: 'none', background: color, color: '#fff', cursor: 'pointer', fontFamily: 'inherit', fontSize: 12, fontWeight: 700 }}
                >
                  ＋ Add to plan
                </button>
              )}
            </div>
          );
        })}
	          </div>
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

function ReviewConfirmModal({ state, onRevert, onAdvance, onProceed }) {
  const { action, employeeName, approvedPickCount, rejectedPickCount, pendingTotal, lockedCount, planNote, stage, loading } = state;

  // Derive title, summary lines, and proceed-button styling per action.
  let title, lead, confirmQuestion, lines, proceedLabel, proceedBg, proceedShadow;
  if (action === 'approve-all') {
    title = `Approve all goals of ${employeeName}?`;
    confirmQuestion = `Are you sure you want to approve all pending goals of ${employeeName}?`;
    lead = `You're approving all ${pendingTotal} pending goal${pendingTotal === 1 ? '' : 's'}.`;
    lines = [];
    if (lockedCount > 0) lines.push(`${lockedCount} already-approved goal${lockedCount === 1 ? '' : 's'} stay unchanged.`);
    proceedLabel = 'Proceed — Approve all';
    proceedBg = '#16A34A';
    proceedShadow = '0 4px 14px rgba(22,163,74,.32)';
  } else if (action === 'reject-all') {
    title = `Send back all goals of ${employeeName}?`;
    confirmQuestion = `Are you sure you want to send back all pending goals of ${employeeName}?`;
    lead = `You're sending back all ${pendingTotal} pending goal${pendingTotal === 1 ? '' : 's'} for changes.`;
    lines = [`${employeeName} will need to update and resubmit.`];
    if (lockedCount > 0) lines.push(`${lockedCount} already-approved goal${lockedCount === 1 ? '' : 's'} stay unchanged.`);
    proceedLabel = 'Proceed — Send back all';
    proceedBg = '#DC2626';
    proceedShadow = '0 4px 14px rgba(220,38,38,.32)';
  } else { // commit
    const autoApproved = Math.max(0, pendingTotal - approvedPickCount - rejectedPickCount);
    title = `Submit decision for ${employeeName}?`;
    confirmQuestion = `Are you sure you want to submit your review decision for ${employeeName}?`;
    lead = `You're committing your review on ${pendingTotal} pending goal${pendingTotal === 1 ? '' : 's'}.`;
    lines = [];
    if (approvedPickCount > 0) lines.push(`✓ ${approvedPickCount} marked approve`);
    if (rejectedPickCount > 0) lines.push(`↩ ${rejectedPickCount} marked send-back`);
    if (autoApproved > 0) lines.push(`• ${autoApproved} unmarked goal${autoApproved === 1 ? '' : 's'} will be auto-approved`);
    if (lockedCount > 0) lines.push(`${lockedCount} already-approved goal${lockedCount === 1 ? '' : 's'} stay unchanged.`);
    proceedLabel = 'Proceed — Submit decision';
    proceedBg = '#2563EB';
    proceedShadow = '0 4px 14px rgba(37,99,235,.32)';
  }

  const isConfirmStage = stage === 'confirm';

  return (
    <div
      onClick={(e) => { if (e.target === e.currentTarget) onRevert(); }}
      style={{
        position: 'fixed', inset: 0, zIndex: 10000,
        background: 'rgba(15,23,42,0.42)',
        backdropFilter: 'blur(4px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 16, fontFamily: "'Geist','Inter','Segoe UI',Arial,sans-serif",
        animation: 'rcmFade 160ms ease',
      }}
    >
      <style>{`
        @keyframes rcmFade { from { opacity: 0 } to { opacity: 1 } }
        @keyframes rcmRise { from { opacity: 0; transform: translateY(8px) scale(.98) } to { opacity: 1; transform: translateY(0) scale(1) } }
        @keyframes rcmStageSwap { from { opacity: 0; transform: translateY(4px) } to { opacity: 1; transform: translateY(0) } }
        @keyframes rcmSpin { to { transform: rotate(360deg) } }
      `}</style>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="rcm-title"
        style={{
          width: '100%', maxWidth: 460,
          background: '#fff', borderRadius: 14,
          boxShadow: '0 30px 60px rgba(15,23,42,.28)',
          padding: '22px 24px 20px',
          animation: 'rcmRise 200ms cubic-bezier(.22,1,.36,1)',
        }}
      >
        {/* Step pips — tiny progress indicator showing stage 1 vs stage 2 */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 14 }}>
          <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#2563EB' }} />
          <span style={{ width: 6, height: 6, borderRadius: '50%', background: isConfirmStage ? '#E2E8F0' : '#2563EB' }} />
          <span style={{ fontSize: 11, fontWeight: 700, color: '#94A3B8', textTransform: 'uppercase', letterSpacing: '.08em', marginLeft: 4 }}>
            Step {isConfirmStage ? '1' : '2'} of 2
          </span>
        </div>

        <div id="rcm-title" style={{ fontSize: 16, fontWeight: 800, color: '#0F172A', marginBottom: 8 }}>{title}</div>

        {isConfirmStage ? (
          <div style={{ animation: 'rcmStageSwap 180ms ease' }}>
            <div style={{ fontSize: 13.5, color: '#475569', lineHeight: 1.55, marginBottom: 20 }}>
              {confirmQuestion}
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, flexWrap: 'wrap' }}>
              <button
                type="button"
                onClick={onRevert}
                style={{
                  padding: '10px 18px', borderRadius: 9,
                  border: '1.5px solid #E2E8F0', background: '#fff',
                  color: '#475569', fontFamily: 'inherit', fontSize: 13.5, fontWeight: 700,
                  cursor: 'pointer',
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={onAdvance}
                autoFocus
                style={{
                  padding: '10px 18px', borderRadius: 9, border: 'none',
                  background: proceedBg, color: '#fff',
                  fontFamily: 'inherit', fontSize: 13.5, fontWeight: 700,
                  cursor: 'pointer', boxShadow: proceedShadow,
                }}
              >
                Yes, I'm sure
              </button>
            </div>
          </div>
        ) : (
          <div style={{ animation: 'rcmStageSwap 180ms ease' }}>
            <div style={{ fontSize: 13.5, color: '#475569', lineHeight: 1.5, marginBottom: lines.length > 0 ? 12 : 16 }}>{lead}</div>
            {lines.length > 0 && (
              <ul style={{ margin: '0 0 16px', padding: '12px 14px', background: '#F8FAFC', border: '1px solid #E2E8F0', borderRadius: 10, listStyle: 'none', fontSize: 13, color: '#334155', lineHeight: 1.7 }}>
                {lines.map((l, i) => <li key={i}>{l}</li>)}
              </ul>
            )}
            {planNote && (
              <div style={{ marginBottom: 16, padding: '10px 12px', background: '#FFF7ED', border: '1px solid #FED7AA', borderRadius: 10, fontSize: 12.5, color: '#7C2D12' }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: '#92400E', textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 3 }}>Overall note</div>
                {planNote}
              </div>
            )}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, flexWrap: 'wrap' }}>
              <button
                type="button"
                onClick={onRevert}
                disabled={loading}
                style={{
                  padding: '10px 18px', borderRadius: 9,
                  border: '1.5px solid #E2E8F0', background: '#fff',
                  color: '#475569', fontFamily: 'inherit', fontSize: 13.5, fontWeight: 700,
                  cursor: loading ? 'not-allowed' : 'pointer', opacity: loading ? 0.55 : 1,
                }}
              >
                Revert
              </button>
              <button
                type="button"
                onClick={onProceed}
                disabled={loading}
                style={{
                  padding: '10px 18px', borderRadius: 9, border: 'none',
                  background: proceedBg, color: '#fff',
                  fontFamily: 'inherit', fontSize: 13.5, fontWeight: 700,
                  cursor: loading ? 'not-allowed' : 'pointer', opacity: loading ? 0.85 : 1,
                  boxShadow: proceedShadow, display: 'inline-flex', alignItems: 'center', gap: 8,
                }}
              >
                {loading && (
                  <span style={{
                    width: 14, height: 14, borderRadius: '50%',
                    border: '2px solid rgba(255,255,255,0.4)', borderTopColor: '#fff',
                    animation: 'rcmSpin 700ms linear infinite', display: 'inline-block',
                  }} />
                )}
                {loading ? 'Processing…' : proceedLabel}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function BackToAdminButton({ onClick }) {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      aria-label="Back to admin"
      style={{
        position: 'fixed', left: 16, bottom: 16, zIndex: 9999,
        width: 36, height: 36, borderRadius: '50%',
        background: '#7C3AED', border: 'none', cursor: 'pointer',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        color: '#fff', boxShadow: '0 4px 14px rgba(124,58,237,.38)',
        transition: 'transform 160ms ease, box-shadow 160ms ease',
        transform: hover ? 'translateY(-1px)' : 'none',
        fontFamily: "'Geist','Inter','Segoe UI',Arial,sans-serif",
      }}
    >
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M19 12H5" />
        <path d="m12 19-7-7 7-7" />
      </svg>
      {hover && (
        <span
          role="tooltip"
          style={{
            position: 'absolute', left: 'calc(100% + 10px)', top: '50%', transform: 'translateY(-50%)',
            background: '#0F172A', color: '#fff', fontSize: 12, fontWeight: 600,
            padding: '6px 10px', borderRadius: 6, whiteSpace: 'nowrap', pointerEvents: 'none',
            boxShadow: '0 4px 10px rgba(15,23,42,.2)',
          }}
        >
          Back to admin
        </span>
      )}
    </button>
  );
}

export default function EmployeePage() {
  const session = useMemo(loadSession, []);
  const [config, setConfig] = useState(() => loadConfig());
  const [appData, setAppData] = useState(() => readAppDataSync());
  const currentPhase = useMemo(() => {
    const org = (appData?.organizationsData || []).find((item) => item.key === (session?.orgKey || ''));
    const stored = org?.currentPhase || 'goal-setting';
    if (!RATING_ENABLED && stored !== 'goal-setting' && stored !== 'mid-year-review') return 'goal-setting';
    return stored;
  }, [appData, session]);
  const orgBrand = useMemo(() => {
    const org = (appData?.organizationsData || []).find((item) => item.key === (session?.orgKey || ''));
    return {
      brandLogo: org?.brandLogo || null,
      brandName: org?.brandName || org?.name || '',
      brandPalette: org?.brandPalette || null,
      brandHero: org?.brandHero || null,
      brandCards: org?.brandCards || 'default',
      brandFill: org?.brandFill || 'gradient',
    };
  }, [appData, session]);
  const brandPalette = useMemo(() => resolveBrandPalette(orgBrand.brandPalette), [orgBrand.brandPalette]);
  const heroResolved = useMemo(() => resolveHero(orgBrand.brandHero, brandPalette), [orgBrand.brandHero, brandPalette]);
  const heroBackgroundStyle = useMemo(() => buildHeroBackground(heroResolved), [heroResolved]);
  const cardsMode = normalizeCardsMode(orgBrand.brandCards);
  const fillMode = orgBrand.brandFill || 'gradient';
  const useGradient = fillMode !== 'solid';
  const accentFill = useMemo(() => fillAccent(brandPalette, { gradient: useGradient }), [brandPalette, useGradient]);
  // Kept for API stability — some callers still read `brandHero` as a string. Not used now.
  const brandHero = useMemo(() => buildHeroGradient(brandPalette), [brandPalette]);
  // Expose the primary colour as a CSS variable so inline styles can opt in via
  // `var(--brand-primary)` without threading the palette through every prop.
  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty('--brand-primary', brandPalette.primary);
    root.style.setProperty('--brand-primary-dark', brandPalette.primaryDark);
    return () => {
      root.style.removeProperty('--brand-primary');
      root.style.removeProperty('--brand-primary-dark');
    };
  }, [brandPalette.primary, brandPalette.primaryDark]);
  const [workflow, setWorkflow] = useState(() => loadWorkflow(session?.orgKey || ''));
  // Persist the active tab so refresh stays on the same tab.
  const activeSectionKey = `zarohr_emp_active_section:${session?.orgKey || 'default'}:${session?.empCode || 'anon'}`;
  const [activeSection, setActiveSectionInner] = useState(() => {
    try {
      const stored = localStorage.getItem(activeSectionKey);
      if (stored) return stored === 'dashboard' ? 'goals' : stored;
    } catch (_) {}
    // First visit: external managers (no PMS employee record) land on Team; everyone else on Goals.
    const emp = session && config ? getEmployeeRecord(config, session.empCode) : null;
    return emp ? 'goals' : 'team';
  });
  const setActiveSection = (next) => {
    setActiveSectionInner(next);
    try { localStorage.setItem(activeSectionKey, next); } catch { /* ignore */ }
  };
  const [selfRatings, setSelfRatings] = useState({});
  const [selfEvalSubmitted, setSelfEvalSubmitted] = useState(false);
  const [goalSubmitError, setGoalSubmitError] = useState('');
  const [managerNotes, setManagerNotes] = useState({});
  // Transient per-goal review picks, keyed by employeeCode → { [goalId]: { status, note } }.
  // Only the "pending" (not yet approved) goals appear here; committed on reviewSubmission.
  const [goalReviewPicks, setGoalReviewPicks] = useState({});
  const [dragGoalId, setDragGoalId] = useState(null);
  const [dragOverGoalId, setDragOverGoalId] = useState(null);
  const [libDropActive, setLibDropActive] = useState(false);
  const [editingGoalId, setEditingGoalId] = useState(null);
  const [confirmDeleteGoal, setConfirmDeleteGoal] = useState(false);
  const [hoveredGoalId, setHoveredGoalId] = useState(null);
  // When jumping to My Team from a notification or CTA, remember which report's review panel to
  // expand + scroll + flash once.
  const [focusApprovalCode, setFocusApprovalCode] = useState(null);
  const [expandedReviewCode, setExpandedReviewCode] = useState(null);
  const [teamFilter, setTeamFilter] = useState('all');
  const [teamSearch, setTeamSearch] = useState('');
  // Confirmation-modal state for Approve all / Reject all / Submit decision. null = closed.
  // Two-stage flow: stage='confirm' shows a plain "are you sure?" question; only after
  // the manager acknowledges does stage flip to 'review' which exposes the full summary
  // and Revert/Proceed buttons. This matches the 3-step guard-rail spec.
  // Shape: { action, employeeCode, employeeName, approvedPickCount, rejectedPickCount, pendingTotal, lockedCount, planNote, stage, loading }
  const [reviewConfirm, setReviewConfirm] = useState(null);
  const [rewritingGoalId, setRewritingGoalId] = useState(null);
  const [rewriteSuggestions, setRewriteSuggestions] = useState([]);
  const [messagesData, setMessagesData] = useState(() => loadMessages(session?.orgKey || ''));
  const [activeConversation, setActiveConversation] = useState(null);
  // Per-conversation drafts. Switching threads or closing the panel must NOT wipe what you typed.
  const [messageDrafts, setMessageDrafts] = useState({});
  const activeDraftKey = activeConversation ? normalizeCode(activeConversation) : '';
  const messageInput = activeDraftKey ? (messageDrafts[activeDraftKey] || '') : '';
  const setMessageInput = (value) => {
    if (!activeDraftKey) return;
    setMessageDrafts((prev) => {
      const next = { ...prev };
      if (value) next[activeDraftKey] = value;
      else delete next[activeDraftKey];
      return next;
    });
  };

  useEffect(() => {
    if (!session?.orgKey) return;
    let cancelled = false;
    hydrateAppData().then((data) => {
      if (!cancelled && data) setAppData(data);
    });
    hydrateWizardState(session.orgKey).then((state) => {
      if (!cancelled && state?.config) setConfig(state.config);
    });
    hydrateWorkflow(session.orgKey).then((wf) => {
      if (!cancelled && wf) setWorkflow(wf);
    });
    hydrateMessages(session.orgKey).then((data) => {
      if (!cancelled && data) setMessagesData(data);
    });
    return () => {
      cancelled = true;
    };
  }, [session?.orgKey]);
  const [notifDropdownOpen, setNotifDropdownOpen] = useState(false);
  const notifDropdownRef = useRef(null);
  useEffect(() => {
    if (!notifDropdownOpen) return undefined;
    function onDoc(e) { if (notifDropdownRef.current && !notifDropdownRef.current.contains(e.target)) setNotifDropdownOpen(false); }
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [notifDropdownOpen]);

  const employee = useMemo(() => session && config ? getEmployeeRecord(config, session.empCode) : null, [session, config]);
  const managerCode = String(employee?.['Reporting Manager Code'] || session?.managerCode || '').trim();
  const managerName = useMemo(() => config && managerCode ? getManagerName(config, managerCode, String(employee?.['Reporting Manager Name'] || '').trim()) : null, [config, managerCode, employee]);
  const employeeCodeKey = normalizeCode(session?.empCode);
  const perspectives = useMemo(() => (config?.perspectives || []).filter((item) => item?.name && Number(item?.weight) > 0), [config]);

  // Find which configured group this employee belongs to (new multi-group model)
  const employeeGroup = useMemo(() => getEmployeeGoalGroup(config, employee), [config, employee]);

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
    // Provision a submission record for every logged-in employee, regardless of phase, so the
    // dashboard always has something to render (goals + status + library, when applicable).
    if (!session || !config || !employeeCodeKey) return;
    setWorkflow((prev) => {
      const current = prev?.submissions?.[employeeCodeKey];
      if (current) {
        // If submission exists but has no goals yet, try to backfill from pre-fill config.
        // This handles employees whose submission was created before pre-fill data was uploaded.
        const hasNoGoals = !current.goals || current.goals.length === 0;
        const backfilled = hasNoGoals
          ? buildInitialGoals(config, employee, employeeGroup, config?.goalLibraries)
          : null;

        const patched = {
          ...current,
          employeeCode: session.empCode,
          employeeName: session.name || employee?.['Employee Name'] || current.employeeName,
          managerCode,
          ...(backfilled && backfilled.length > 0 ? { goals: backfilled } : {}),
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

  // Live workflow sync: when the employee submits (or manager approves) in another tab,
  // reload so this tab (e.g. the manager) sees the updated submissions + notifications.
  useEffect(() => {
    if (!session?.orgKey) return;
    const wfKey = getWorkflowStorageKey(session.orgKey);
    function onWorkflowStorage(e) {
      if (e.key === wfKey) {
        setWorkflow(loadWorkflow(session.orgKey));
      }
    }
    window.addEventListener('storage', onWorkflowStorage);
    return () => window.removeEventListener('storage', onWorkflowStorage);
  }, [session?.orgKey]);

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

  // Close the goal-edit modal on Esc. Also reset the delete-confirm state whenever the
  // modal opens on a different goal (or closes), so the confirm strip never leaks between goals.
  useEffect(() => {
    setConfirmDeleteGoal(false);
    if (!editingGoalId) return;
    const onKey = (e) => {
      if (e.key === 'Escape') { setEditingGoalId(null); setRewritingGoalId(null); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [editingGoalId]);

  if (!session) {
    return null;
  }

  const employeeName = session.name || session.userName || employee?.['Employee Name'] || `Employee ${session.empCode}`;
  const rawDesignation = session.designation || employee?.Designation || employee?.[config?.goalSegmentAttr] || '';
  // For managers who aren't uploaded in PMS, the Test Credentials module tags them as "Manager (not in PMS)"
  // for HR's own clarity — but we should never surface that phrasing in the logged-in user's own UI.
  const employeeDesignation = !employee ? 'Manager' : rawDesignation;
  // "External manager" = logged-in user is referenced as someone's manager but isn't themselves uploaded.
  // They have no PMS goal plan of their own — the dashboard should skip all goal UI for them.
  const isExternalManager = !employee;
  const mySubmission = workflow?.submissions?.[employeeCodeKey] || null;
  const myGoals = mySubmission?.goals || [];
  const goalMetrics = getGoalPlanMetrics(myGoals, effectiveConfig, accessMode);
  const myStatusMeta = getSubmissionStatusMeta(mySubmission);
  const limits = getGoalLimits(config, employee, employeeGroup);
  const myValidation = getGoalPlanValidation(myGoals, effectiveConfig, accessMode, limits, perspectives);
  // Per-goal issue map for inline red badges on cards. Shares getGoalIssues() with submit-level
  // validation so card state and submit state are always consistent.
  const goalIssuesById = useMemo(() => {
    const map = {};
    const isEditableStructure = effectiveConfig?.goalCreationMode === 'employee-self' || accessMode === 'edit-freely';
    const mustCreateKpis = effectiveConfig?.goalCreationMode === 'employee-self' || effectiveConfig?.goalKpiMode === 'kra-only' || accessMode === 'edit-freely';
    (myGoals || []).forEach((goal, index) => {
      const isLocked = goal.reviewStatus === 'approved';
      map[goal.id || `goal_${index}`] = getGoalIssues(goal, {
        config: effectiveConfig,
        accessMode,
        perspectives,
        isEditableStructure,
        mustCreateKpis,
        isLocked,
      });
    });
    return map;
  }, [myGoals, effectiveConfig, accessMode, perspectives]);
  const totalGoalsWithIssues = Object.values(goalIssuesById).filter((arr) => arr.some((i) => i.kind === 'error')).length;
  const notifications = (workflow?.notifications || []).filter((notification) => notification.recipientCode === employeeCodeKey)
    .sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime());
  const unreadNotificationCount = notifications.filter((n) => !n.read).length;

  // Mark everything read when the user opens the Notifications tab.
  useEffect(() => {
    if (activeSection !== 'notifications') return;
    const unreadIds = notifications.filter((n) => !n.read).map((n) => n.id);
    if (unreadIds.length > 0) markNotificationsRead(unreadIds);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSection]);
  const employees = config?.employeeUploadData?.employees || [];
  const directReports = employees.filter((item) => normalizeCode(item['Reporting Manager Code']) === employeeCodeKey);
  const pendingApprovals = Object.values(workflow?.submissions || {}).filter(
    (submission) => normalizeCode(submission.managerCode) === employeeCodeKey && submission.status === 'pending-manager'
  );
  const messageContacts = [];
  if (managerCode) {
    const storedMgrName = String(employee?.['Reporting Manager Name'] || '').trim();
    messageContacts.push({
      code: normalizeCode(managerCode),
      name: getManagerName(config, managerCode, storedMgrName) || managerCode,
      role: 'Manager',
    });
  }
  directReports.forEach((dr) => {
    const code = normalizeCode(String(dr['Employee Code'] || '').trim());
    if (code) {
      messageContacts.push({ code, name: String(dr['Employee Name'] || code).trim(), role: 'Direct report' });
    }
  });
  const perspectiveGroups = groupGoalsByPerspective(myGoals, perspectives);
  const canEditGoalPlan = currentPhase === 'goal-setting' && mySubmission && !['pending-manager', 'approved'].includes(mySubmission.status);
  const canAddKra = canEditGoalPlan && (effectiveConfig?.goalCreationMode === 'employee-self' || accessMode === 'edit-freely');
  const canEditKraFields = canAddKra;
  const canAddKpi = canEditGoalPlan && (effectiveConfig?.goalCreationMode === 'employee-self' || accessMode === 'edit-freely' || accessMode === 'add-kpis');
  const canEditExistingKpi = canEditGoalPlan && (effectiveConfig?.goalCreationMode === 'employee-self' || accessMode === 'edit-freely' || (accessMode === 'add-kpis' && effectiveConfig?.goalKpiMode === 'kra-only'));
  const hasKpis = myGoals.some((goal) => (goal.kpis || []).length > 0);
  const rateAtGoalLevel = effectiveConfig?.kpiRatingMode === 'free-text' || !hasKpis;

  const totalRatable = rateAtGoalLevel
    ? myGoals.length
    : myGoals.reduce((sum, goal) => sum + (goal.kpis || []).length, 0);
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

  function markNotificationsRead(ids) {
    if (!ids || ids.length === 0) return;
    const idSet = new Set(ids);
    setWorkflow((prev) => ({
      submissions: prev?.submissions || {},
      notifications: (prev?.notifications || []).map((n) => (idSet.has(n.id) ? { ...n, read: true } : n)),
    }));
  }

  // Click a notification → navigate to the relevant tab (and mark it read).
  function handleNotificationClick(n) {
    markNotificationsRead([n.id]);
    if (n.type === 'goal-submitted') {
      const code = normalizeCode(n.submissionCode);
      setFocusApprovalCode(code);
      setExpandedReviewCode(code);
      setTeamFilter('pending');
      setActiveSection('team');
    } else if (n.type === 'goal-approved' || n.type === 'goal-rejected' || n.type === 'goal-reminder') {
      setActiveSection('dashboard');
    }
  }

  // Opens the inline review panel for a team member.
  function openApproval(reportCode) {
    const code = normalizeCode(reportCode);
    setFocusApprovalCode(code);
    setExpandedReviewCode((prev) => (prev === code ? null : code));
    setActiveSection('team');
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

  function addGoalAndEdit() {
    const newKra = buildEmptyKra(perspectives);
    updateMySubmission((record) => {
      record.goals = [...(record.goals || []), newKra];
      return record;
    });
    setEditingGoalId(newKra.id);
  }

  function addGoalToPerspective(perspName) {
    const newKra = createKra({ name: '', weight: '', perspName: perspName || '', kpis: [] });
    updateMySubmission((record) => {
      record.goals = [...(record.goals || []), newKra];
      return record;
    });
    setEditingGoalId(newKra.id);
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
      // Reset previously-rejected goals back to pending review. Approved ones stay locked.
      const resetGoals = (record.goals || []).map((goal) => {
        if (goal.reviewStatus === 'rejected') {
          const { reviewStatus: _s, reviewNote: _n, reviewedAt: _t, ...rest } = goal;
          return rest;
        }
        return goal;
      });
      return {
        ...record,
        goals: resetGoals,
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

  // mode: 'approve-all' | 'reject-all' | 'commit'
  //  - 'approve-all': every not-yet-approved goal becomes approved.
  //  - 'reject-all' : every not-yet-approved goal becomes rejected (plan note used as blanket note).
  //  - 'commit'     : applies per-goal picks; unmarked pending goals default to approved.
  // Goals already carrying reviewStatus === 'approved' from a prior round stay approved (locked).
  function reviewSubmission(employeeCode, mode = 'commit') {
    const planNote = sanitizeText(managerNotes[employeeCode] || '');
    const picks = goalReviewPicks[employeeCode] || {};
    const targetKey = normalizeCode(employeeCode);
    const current = workflow?.submissions?.[targetKey];
    if (!current) return;
    const targetEmployee = employees.find((row) => normalizeCode(row['Employee Code']) === targetKey);
    const targetGroup = getEmployeeGoalGroup(config, targetEmployee);
    const targetOverrides = resolveGroupAccess(targetGroup);
    const targetEffectiveConfig = targetOverrides ? { ...config, ...targetOverrides } : config;

    const decidedAt = new Date().toISOString();
    const updatedGoals = (current.goals || []).map((goal) => {
      // Already approved in a prior round — locked, unchanged.
      if (goal.reviewStatus === 'approved') return goal;
      let status = 'approved';
      let note = '';
      if (mode === 'reject-all') {
        status = 'rejected';
        note = planNote;
      } else if (mode === 'approve-all') {
        status = 'approved';
      } else {
        const pick = picks[goal.id];
        if (pick?.status === 'reject') {
          status = 'rejected';
          note = sanitizeText(pick.note || '');
        } else {
          status = 'approved';
        }
      }
      // Defensive guard: a structurally broken goal can never be approved. Force send-back
      // with an explanatory note so the employee knows what to fix.
      if (status === 'approved' && !isGoalStructurallyValid(goal, targetEffectiveConfig)) {
        status = 'rejected';
        note = note || 'Missing required fields — please fix and resubmit.';
      }
      return {
        ...goal,
        reviewStatus: status,
        reviewNote: status === 'rejected' ? note : '',
        reviewedAt: decidedAt,
      };
    });

    const anyRejected = updatedGoals.some((g) => g.reviewStatus === 'rejected');
    const submissionStatus = anyRejected ? 'sent-back' : 'approved';
    const rejectedCount = updatedGoals.filter((g) => g.reviewStatus === 'rejected').length;
    const approvedCount = updatedGoals.length - rejectedCount;

    setWorkflow((prev) => ({
      ...prev,
      submissions: {
        ...(prev?.submissions || {}),
        [targetKey]: {
          ...(prev?.submissions?.[targetKey] || current),
          goals: updatedGoals,
          status: submissionStatus,
          managerDecisionAt: decidedAt,
          approvedAt: submissionStatus === 'approved' ? decidedAt : (prev?.submissions?.[targetKey]?.approvedAt || current.approvedAt),
          managerApprovedBy: session.empCode,
          managerNote: planNote,
        },
      },
    }));
    setManagerNotes((prevNotes) => ({ ...prevNotes, [employeeCode]: '' }));
    setGoalReviewPicks((prevPicks) => { const next = { ...prevPicks }; delete next[employeeCode]; return next; });

    let notifType, notifTitle, notifMessage;
    if (rejectedCount === 0) {
      notifType = 'goal-approved';
      notifTitle = 'Goals approved';
      notifMessage = `${employeeName} approved your goal plan.${planNote ? ` Note: ${planNote}` : ''}`;
    } else if (approvedCount === 0) {
      notifType = 'goal-rejected';
      notifTitle = 'Goals need updates';
      notifMessage = `${employeeName} requested changes on all goals.${planNote ? ` Note: ${planNote}` : ''}`;
    } else {
      notifType = 'goal-rejected';
      notifTitle = 'Goals reviewed';
      notifMessage = `${employeeName} approved ${approvedCount} goal${approvedCount === 1 ? '' : 's'} and sent back ${rejectedCount} for updates.`;
    }
    addNotification(createNotification({
      type: notifType,
      recipientCode: employeeCode,
      senderCode: session.empCode,
      submissionCode: employeeCode,
      title: notifTitle,
      message: notifMessage,
    }));
  }

  function getReminderState(reportCode) {
    const targetCode = normalizeCode(reportCode);
    const myCode = normalizeCode(session.empCode);
    const latestReminderTime = (workflow?.notifications || []).reduce((latest, notification) => {
      if (notification.type !== 'goal-reminder') return latest;
      if (notification.recipientCode !== targetCode || notification.senderCode !== myCode) return latest;
      const sentAt = new Date(notification.createdAt).getTime();
      return Number.isFinite(sentAt) ? Math.max(latest, sentAt) : latest;
    }, 0);

    const remainingMs = latestReminderTime + REMINDER_COOLDOWN_MS - Date.now();
    if (remainingMs <= 0) return { blocked: false, label: '' };

    const remainingMinutes = Math.ceil(remainingMs / 60000);
    const hours = Math.floor(remainingMinutes / 60);
    const minutes = remainingMinutes % 60;
    const label = hours > 0
      ? `${hours}h${minutes > 0 ? ` ${minutes}m` : ''}`
      : `${minutes}m`;
    return { blocked: true, label };
  }

  function sendReminder(report) {
    const reminderState = getReminderState(report['Employee Code']);
    if (reminderState.blocked) return;
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

  // Count unread messages only from conversations visible in the current inbox.
  const unreadMsgCount = messageContacts.reduce((sum, contact) => {
    const conv = messagesData.conversations?.[convKey(session.empCode, contact.code)];
    return sum + (conv?.messages || []).filter((m) => m.from !== employeeCodeKey && !m.read).length;
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
        const newKra = createKra({ ...kra, id: uid('kra'), kpis: libKpis.map((kpi) => createKpi(kpi, 'library')) });
        // Stamp origin so the library can hide this card once added
        newKra.libraryKraId = kra.id || kra.name;
        record.goals = [...(record.goals || []), newKra];
        return record;
      });
    }

    const libraryReturnKeys = new Set(libraryKras.flatMap((kra) => [
      kra.id || kra.name,
      sanitizeText(kra.name),
    ]).filter(Boolean));

    function canReturnGoalToLibrary(goalId) {
      if (!canEditGoalPlan) return false;
      const goal = myGoals.find((item) => item.id === goalId);
      if (!goal) return false;
      return libraryReturnKeys.has(goal.libraryKraId) || libraryReturnKeys.has(sanitizeText(goal.name));
    }

    function returnGoalToLibrary(goalId) {
      if (!canReturnGoalToLibrary(goalId)) return;
      removeGoal(goalId);
      setDragGoalId(null);
      setDragOverGoalId(null);
    }

    // Which library KRAs are already in the plan — by explicit stamp or by name match (covers pre-filled goals)
    const addedLibraryIds = new Set([
      ...myGoals.map((g) => g.libraryKraId).filter(Boolean),
      ...myGoals.map((g) => sanitizeText(g.name)).filter(Boolean),
    ]);

    return (
      <div>
        {/* Critical alerts only — no "Draft in progress" tile when status is draft */}
        {mySubmission.status !== 'draft' && (() => {
          const reviewed = (mySubmission.goals || []).filter((g) => g.reviewStatus === 'approved' || g.reviewStatus === 'rejected');
          const approvedCount = reviewed.filter((g) => g.reviewStatus === 'approved').length;
          const rejectedCount = reviewed.filter((g) => g.reviewStatus === 'rejected').length;
          const hasBreakdown = reviewed.length > 0;
          // During 'pending-manager', any approved goals are carried over from a prior round —
          // label them "locked" (neutral) so the chip doesn't imply the new submission has been approved.
          const priorApprovedPending = mySubmission.status === 'pending-manager' && approvedCount > 0;
          return (
            <div style={{ marginBottom: 16, padding: '14px 18px', background: myStatusMeta.bg, border: `1.5px solid ${myStatusMeta.border}`, borderRadius: 12 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6, flexWrap: 'wrap' }}>
                <div style={{ fontSize: 14, fontWeight: 700, color: myStatusMeta.color }}>{myStatusMeta.label}</div>
                {hasBreakdown && (
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    {approvedCount > 0 && (
                      priorApprovedPending ? (
                        <span style={{ fontSize: 11.5, fontWeight: 700, color: '#475569', background: '#F1F5F9', border: '1px solid #CBD5E1', padding: '2px 9px', borderRadius: 999 }}>
                          {approvedCount} locked
                        </span>
                      ) : (
                        <span style={{ fontSize: 11.5, fontWeight: 700, color: '#15803D', background: '#F0FDF4', border: '1px solid #BBF7D0', padding: '2px 9px', borderRadius: 999 }}>
                          {approvedCount} approved
                        </span>
                      )
                    )}
                    {rejectedCount > 0 && (
                      <span style={{ fontSize: 11.5, fontWeight: 700, color: '#92400E', background: '#FFF7ED', border: '1px solid #FED7AA', padding: '2px 9px', borderRadius: 999 }}>
                        {rejectedCount} sent back
                      </span>
                    )}
                  </div>
                )}
              </div>
              <div style={{ fontSize: 13, color: '#475569', lineHeight: 1.55 }}>
                {mySubmission.status === 'pending-manager' && `Submitted on ${formatDateTime(mySubmission.submittedAt)}. ${managerName ? `${managerName} can now approve or send back changes.` : 'Waiting for approval.'}`}
                {mySubmission.status === 'approved' && `Approved${mySubmission.managerApprovedBy ? ` by ${getManagerName(config, mySubmission.managerApprovedBy) || mySubmission.managerApprovedBy}` : ''} on ${formatDateTime(mySubmission.managerDecisionAt || mySubmission.approvedAt)}.`}
                {mySubmission.status === 'sent-back' && (
                  hasBreakdown && approvedCount > 0
                    ? `Your manager approved ${approvedCount} goal${approvedCount === 1 ? '' : 's'} and sent ${rejectedCount} back for updates${mySubmission.managerDecisionAt ? ` on ${formatDateTime(mySubmission.managerDecisionAt)}` : ''}. Fix the flagged goals and resubmit.`
                    : `Your manager requested changes${mySubmission.managerDecisionAt ? ` on ${formatDateTime(mySubmission.managerDecisionAt)}` : ''}. Update the plan and resubmit.`
                )}
              </div>
              {mySubmission.managerNote ? (
                <div style={{ marginTop: 10, fontSize: 13, color: '#7C2D12', background: '#FFF7ED', border: '1px solid #FED7AA', borderRadius: 8, padding: '10px 12px' }}>
                  Overall note: {mySubmission.managerNote}
                </div>
              ) : null}
            </div>
          );
        })()}

        {goalSubmitError ? (
          <div style={{ marginBottom: 16, fontSize: 13.5, color: '#B91C1C', background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: 10, padding: '12px 14px' }}>
            {goalSubmitError}
          </div>
        ) : null}

        {/* Over-allocation pills — per-goal issues surface on their own cards, so we only
            keep the plan-wide over-allocation callouts that can't be attributed to a single goal. */}
        {(goalMetrics.goalOver || goalMetrics.kpiOver) && (
          <div style={{ marginBottom: 16, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            {goalMetrics.goalOver && (
              <div style={{ padding: '5px 11px', borderRadius: 999, background: '#FEF2F2', color: '#991B1B', border: '1px solid #FECACA', fontSize: 12.5, fontWeight: 700 }}>
                Goal weights {goalMetrics.goalPct}% — over by {goalMetrics.goalPct - 100}%
              </div>
            )}
            {goalMetrics.shouldTrackKpis && goalMetrics.kpiOver && (
              <div style={{ padding: '5px 11px', borderRadius: 999, background: '#FEF2F2', color: '#991B1B', border: '1px solid #FECACA', fontSize: 12.5, fontWeight: 700 }}>
                KPI coverage {goalMetrics.kpiPct}% — over by {goalMetrics.kpiPct - 100}%
              </div>
            )}
          </div>
        )}

        {/* 2. Goal Library (middle) — only for employees whose group has a library assigned */}
        {empGroupLib !== null && libraryKras.length > 0 && (
          <GoalLibraryPanel
            kras={libraryKras}
            addedIds={addedLibraryIds}
            libraryType={groupLibType}
            libraryName={empGroupLib?.library?.name || 'Assigned Goal Library'}
            canAdd={canEditGoalPlan}
            onAdd={addFromLibrary}
            draggedGoalId={dragGoalId}
            canReturnGoal={canReturnGoalToLibrary}
            onReturnGoal={returnGoalToLibrary}
          />
        )}

        {/* 3. My Goals (bottom) */}
        {myGoals.length === 0 && !canAddKra ? (
          <EmptyState title="No goals assigned yet" subtitle="Your goal library has not been assigned for this cycle." />
        ) : (
          <div
            onDragOver={(e) => {
              if (e.dataTransfer.types.includes('application/kra')) {
                e.preventDefault();
                e.dataTransfer.dropEffect = 'copy';
                setLibDropActive(true);
              }
            }}
            onDragLeave={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget)) setLibDropActive(false);
            }}
            onDrop={(e) => {
              setLibDropActive(false);
              if (!e.dataTransfer.types.includes('application/kra')) return;
              e.preventDefault();
              try {
                const kra = JSON.parse(e.dataTransfer.getData('application/kra'));
                if (kra) addFromLibrary(kra);
              } catch (_) {}
            }}
            style={{
              borderRadius: 14,
              border: libDropActive ? '2px dashed #6366F1' : '2px solid transparent',
              background: libDropActive ? '#EEF2FF' : 'transparent',
              padding: libDropActive ? '8px' : '0',
              transition: 'border-color .15s, background .15s, padding .15s',
            }}
          >
            {/* Header row + Create-Goal button moved to the top-level tab row. */}

            {/* Empty state when no goals but can add */}
            {myGoals.length === 0 && canAddKra && (
              <div style={{ padding: '36px', textAlign: 'center', border: '2px dashed #E2E8F0', borderRadius: 14, marginBottom: 16, color: '#94A3B8', fontSize: 14 }}>
                Click "+ Create Goal" to add your first KRA{empGroupLib !== null && libraryKras.length > 0 ? ', or drag a card from the Goal Library above' : ''}.
              </div>
            )}

            {/* Flat 2-col card grid */}
            {myGoals.length > 0 && (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 16, marginBottom: 16 }}>
                {myGoals.map((goal, goalIndex) => {
                  const color = getPerspectiveColor(goal, perspectives);
                  const initial = (goal.name || '?').trim().charAt(0).toUpperCase();
                  const isDragging = dragGoalId === goal.id;
                  const isDragOver = dragOverGoalId === goal.id && dragGoalId !== goal.id;

                  // Compact card — show KPIs inline + status pill
                  const issues = goalIssuesById[goal.id || `goal_${goalIndex}`] || [];
                  const hasError = issues.some((i) => i.kind === 'error');
                  const hasWarn = !hasError && issues.some((i) => i.kind === 'warn');
                  const primaryIssue = hasError ? issues.find((i) => i.kind === 'error') : issues[0];
                  const goalKpis = goal.kpis || [];
                  const kpiSum = goalKpis.reduce((acc, kpi) => acc + (Number(kpi.weight) > 0 ? Number(kpi.weight) : 0), 0);
                  const goalWeightNum = Number(goal.weight) || 0;
                  const allKpisComplete = goalKpis.every((kpi) => sanitizeText(kpi.name) && Number(kpi.weight) > 0);
                  const kpiBalanced = goalKpis.length > 0 && allKpisComplete && goalWeightNum > 0 && Math.abs(kpiSum - goalWeightNum) <= 0.01;

                  // Per-goal review state — only meaningful once the submission has left 'draft'.
                  const submissionStatus = mySubmission?.status;
                  const showReviewState = submissionStatus && submissionStatus !== 'draft';
                  const reviewStatus = showReviewState ? getGoalReviewStatus(goal, mySubmission) : null;
                  const priorApprovedDuringPending = reviewStatus === 'approved' && mySubmission?.status === 'pending-manager';
                  const reviewMeta = reviewStatus
                    ? (priorApprovedDuringPending
                        ? { label: 'Locked', color: '#64748B', bg: '#F1F5F9', border: '#CBD5E1' }
                        : getGoalStatusMeta(reviewStatus))
                    : null;
                  const displayReviewMeta = submissionStatus === 'pending-manager' ? null : reviewMeta;
                  const isApprovedLocked = reviewStatus === 'approved';
                  const isRejected = reviewStatus === 'rejected';
                  const canDrag = canEditGoalPlan && !editingGoalId && !isApprovedLocked;
                  const canOpenGoalModal = canEditGoalPlan || showReviewState;
                  // Border colouring priority: drag target > review status > validation state > hover > default.
                  const borderColor = isDragOver ? '#2563EB'
                    : isApprovedLocked ? (priorApprovedDuringPending ? '#CBD5E1' : '#BBF7D0')
                    : isRejected ? '#FECACA'
                    : hasError ? '#FCA5A5'
                    : hasWarn ? '#FCD34D'
                    : hoveredGoalId === goal.id ? color + '55'
                    : '#E2E8F0';
                  const borderLeftColor = isApprovedLocked ? (priorApprovedDuringPending ? '#64748B' : '#16A34A')
                    : isRejected ? '#DC2626'
                    : hasError ? '#DC2626'
                    : hasWarn ? '#D97706'
                    : color;
                  // Card accent modes — Neutral/Tinted/Colourful. Only applied in the "default"
                  // visual state (not approved-locked, rejected, error) so validation colours stay
                  // loud and unambiguous.
                  const stateIsNeutralVisually = !isApprovedLocked && !isRejected && !hasError && !hasWarn;
                  const accentOverlay = stateIsNeutralVisually ? cardAccentStyle(cardsMode, color) : {};
                  const stripeWidth = cardStripeWidth(cardsMode);
                  const baseCardBg = isApprovedLocked
                      ? (priorApprovedDuringPending ? '#fff' : 'linear-gradient(135deg,#F0FDF4 0%,#ffffff 55%)')
                    : isRejected ? 'linear-gradient(135deg,#FEF2F2 0%,#ffffff 55%)'
                    : '#fff';
                  const cardBg = accentOverlay.background || baseCardBg;
                  const cardBorderColor = accentOverlay.borderColor || borderColor;
                  return (
                    <div
	                      key={goal.id}
	                      draggable={canDrag}
	                      onDragStart={(e) => {
	                        if (!canDrag) return;
	                        setDragGoalId(goal.id);
	                        e.dataTransfer.setData('application/goal-id', goal.id);
	                        e.dataTransfer.effectAllowed = canReturnGoalToLibrary(goal.id) ? 'move' : 'copyMove';
	                      }}
                      onDragOver={(e) => { e.preventDefault(); setDragOverGoalId(goal.id); }}
                      onDragEnd={() => { setDragGoalId(null); setDragOverGoalId(null); }}
                      onDrop={() => {
                        if (dragGoalId && dragGoalId !== goal.id) reorderGoals(dragGoalId, goal.id);
                        setDragGoalId(null);
                        setDragOverGoalId(null);
                      }}
                      onMouseEnter={() => setHoveredGoalId(goal.id)}
                      onMouseLeave={() => setHoveredGoalId(null)}
                      onClick={() => { if (canOpenGoalModal && !dragGoalId) setEditingGoalId(goal.id); }}
                      style={{
                        background: cardBg,
                        border: `1.5px solid ${cardBorderColor}`,
                        borderRadius: 14,
                        position: 'relative',
                        overflow: 'hidden',
                        padding: '16px 18px',
                        cursor: canOpenGoalModal ? 'pointer' : 'default',
                        transform: hoveredGoalId === goal.id && !isDragging && !dragGoalId ? 'translateY(-2px)' : 'none',
                        boxShadow: isRejected
                          ? '0 6px 18px rgba(220,38,38,0.10)'
                          : hasError
                            ? '0 6px 18px rgba(220,38,38,0.10)'
                            : hoveredGoalId === goal.id && !isDragging && !dragGoalId ? '0 10px 28px rgba(15,23,42,.10)' : '0 1px 4px rgba(15,23,42,.05)',
                        opacity: isDragging ? 0.45 : 1,
                        transition: 'transform .18s ease, box-shadow .18s ease, border-color .18s ease, opacity .18s ease',
                      }}
                    >
                      {stripeWidth > 0 && (
                        <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: stripeWidth, background: borderLeftColor, pointerEvents: 'none' }} />
                      )}
                      {/* Header: avatar + title + status pill */}
                      <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start', marginBottom: 12, minHeight: 72 }}>
                        <div style={{ width: 40, height: 40, borderRadius: 11, background: `${color}18`, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                          <span style={{ fontSize: 17, fontWeight: 800, color }}>{initial}</span>
                        </div>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: 15, fontWeight: 700, color: '#0F172A', lineHeight: 1.35, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                            {goal.name || <span style={{ color: '#94A3B8', fontStyle: 'italic' }}>Untitled goal</span>}
                          </div>
                          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 5, marginTop: 5 }}>
                            {goal.perspName && goal.perspName !== 'All KRAs' && (
                              <span style={{ maxWidth: '100%', fontSize: 11, fontWeight: 700, color, background: `${color}14`, padding: '2px 8px', borderRadius: 999, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{goal.perspName}</span>
                            )}
                            <span style={{ fontSize: 11.5, color: '#64748B' }}>{goalKpis.length} KPI{goalKpis.length !== 1 ? 's' : ''}</span>
                          </div>
                        </div>
                        {/* Goal weight pill */}
                        <div style={{ flexShrink: 0, padding: '5px 11px', borderRadius: 999, fontSize: 12, fontWeight: 800, color: goalWeightNum > 0 ? color : '#94A3B8', background: goalWeightNum > 0 ? `${color}10` : '#F1F5F9', border: `1px solid ${goalWeightNum > 0 ? `${color}33` : '#E2E8F0'}` }}>
                          {goalWeightNum > 0 ? `${goal.weight}%` : 'No weight'}
                        </div>
                      </div>

                      {/* KPI list (inline, always visible) */}
                      {goalKpis.length > 0 && (
                        <div style={{
                          display: 'flex',
                          flexDirection: 'column',
                          gap: 6,
                          marginBottom: 12,
                          maxHeight: 104,
                          overflowY: goalKpis.length > 2 ? 'auto' : 'visible',
                          paddingRight: goalKpis.length > 2 ? 3 : 0,
                        }}>
                          {goalKpis.map((kpi) => {
                            const kw = Number(kpi.weight) || 0;
                            const isUnnamed = !sanitizeText(kpi.name);
                            return (
                              <div key={kpi.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', borderRadius: 8, background: '#F8FAFC', border: '1px solid #F1F5F9' }}>
                                <span style={{ width: 5, height: 5, borderRadius: '50%', background: color, flexShrink: 0 }} />
                                <span style={{ fontSize: 12.5, color: isUnnamed ? '#94A3B8' : '#1E293B', fontWeight: 500, fontStyle: isUnnamed ? 'italic' : 'normal', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                  {isUnnamed ? 'Unnamed KPI' : kpi.name}
                                </span>
                                <span style={{ fontSize: 11, fontWeight: 700, color: kw > 0 ? '#475569' : '#94A3B8', flexShrink: 0 }}>{kw > 0 ? `${kw}%` : '—'}</span>
                              </div>
                            );
                          })}
                        </div>
                      )}

                      {/* Manager's rejection comment, if any */}
                      {isRejected && goal.reviewNote && (
                        <div style={{ marginBottom: 10, padding: '10px 12px', background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: 9, display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#DC2626" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, marginTop: 1 }}><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
                          <div style={{ fontSize: 12.5, color: '#991B1B', lineHeight: 1.45 }}>
                            <span style={{ fontWeight: 700 }}>Manager:</span> {goal.reviewNote}
                          </div>
                        </div>
                      )}

                      {/* Status row */}
                      <div style={{ display: 'flex', gap: 6, alignItems: 'center', minWidth: 0 }}>
                        {displayReviewMeta && (
                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11, fontWeight: 700, color: displayReviewMeta.color, background: displayReviewMeta.bg, border: `1px solid ${displayReviewMeta.border}`, padding: '3px 9px', borderRadius: 999 }}>
                            <span style={{ width: 6, height: 6, borderRadius: '50%', background: displayReviewMeta.color }} />
                            {displayReviewMeta.label}
                          </span>
                        )}
                        {(hasError || hasWarn) && primaryIssue && (
                          <span title={issues.map((i) => i.text).join(' · ')} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, minWidth: 0, maxWidth: '100%', fontSize: 11, fontWeight: 700, color: hasError ? '#991B1B' : '#92400E', background: hasError ? '#FEF2F2' : '#FFFBEB', border: `1px solid ${hasError ? '#FECACA' : '#FDE68A'}`, padding: '3px 9px', borderRadius: 999 }}>
                            <span style={{ width: 6, height: 6, borderRadius: '50%', background: hasError ? '#DC2626' : '#D97706', flexShrink: 0 }} />
                            <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{primaryIssue.text}</span>
                          </span>
                        )}
                        {!displayReviewMeta && !showReviewState && !hasError && !hasWarn && goalKpis.length > 0 && kpiBalanced && (
                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11, fontWeight: 700, color: '#15803D', background: '#F0FDF4', border: '1px solid #BBF7D0', padding: '3px 9px', borderRadius: 999 }}>
                            <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#16A34A' }} />
                            Balanced
                          </span>
                        )}
                        {canEditGoalPlan && !hasError && !hasWarn && (
                          <span style={{ fontSize: 11.5, color: '#94A3B8', marginLeft: 'auto' }}>
                            {isApprovedLocked ? 'click to view' : isRejected ? 'click to update' : 'click to edit'}
                          </span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            {/* ── Goal Edit Modal ─────────────────────────────────────── */}
            {editingGoalId && (() => {
              const goal = myGoals.find((g) => g.id === editingGoalId);
              if (!goal) return null;
              const goalIndex = myGoals.findIndex((g) => g.id === editingGoalId);
              const color = getPerspectiveColor(goal, perspectives);
              const isRewriting = rewritingGoalId === goal.id;
              const goalReviewStatus = getGoalReviewStatus(goal, mySubmission);
              const goalIsLocked = goalReviewStatus === 'approved' && mySubmission?.status !== 'draft';
              const goalIsRejected = goalReviewStatus === 'rejected' && mySubmission?.status !== 'draft';
              const goalCanEdit = canEditGoalPlan && !goalIsLocked;
              const canEditKraFieldsNow = canEditKraFields && !goalIsLocked;
              const canEditExistingKpiNow = canEditExistingKpi && !goalIsLocked;
              const canAddKpiNow = canAddKpi && !goalIsLocked;
              const showPerspectiveField = perspectives.length > 0 && canEditKraFieldsNow && config?.frameworkId !== 'kra-kpi';
              const modalIssues = goalIssuesById[goal.id || `goal_${goalIndex}`] || [];
              const closeModal = () => { setEditingGoalId(null); setRewritingGoalId(null); };
              return (
                <div
                  role="dialog"
                  aria-modal="true"
                  onClick={closeModal}
                  style={{
                    position: 'fixed', inset: 0, zIndex: 1000,
                    background: 'rgba(15,23,42,0.55)',
                    backdropFilter: 'blur(6px)', WebkitBackdropFilter: 'blur(6px)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    padding: 20,
                    animation: 'goalModalFadeIn 180ms ease-out',
                  }}
                >
                  <style>{`
                    @keyframes goalModalFadeIn { from { opacity: 0 } to { opacity: 1 } }
                    @keyframes goalModalSlideIn { from { opacity: 0; transform: translateY(16px) scale(0.97) } to { opacity: 1; transform: translateY(0) scale(1) } }
                  `}</style>
                  <div
                    onClick={(e) => e.stopPropagation()}
                    style={{
                      width: 'min(720px, 100%)', maxHeight: '88vh',
                      background: '#fff', borderRadius: 20,
                      boxShadow: '0 30px 80px rgba(15,23,42,0.35), 0 4px 14px rgba(15,23,42,0.10)',
                      display: 'flex', flexDirection: 'column', overflow: 'hidden',
                      animation: 'goalModalSlideIn 220ms cubic-bezier(0.22,1,0.36,1)',
                    }}
                  >
                    {/* Header */}
                    <div style={{ padding: '20px 24px 18px', borderBottom: `1px solid ${color}22`, display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, background: `linear-gradient(135deg, ${color}14, transparent 75%)` }}>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 10.5, fontWeight: 800, color, textTransform: 'uppercase', letterSpacing: '.1em', marginBottom: 4 }}>
	                          {goalCanEdit ? (goalIsRejected ? `Editing Goal ${goalIndex + 1} · Changes requested` : `Editing Goal ${goalIndex + 1}`) : `Goal ${goalIndex + 1}`}
                        </div>
                        <div style={{ fontSize: 17, fontWeight: 800, color: '#0F172A', lineHeight: 1.3, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                          {goal.name || <span style={{ color: '#94A3B8', fontStyle: 'italic', fontWeight: 600 }}>Untitled goal</span>}
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={closeModal}
                        aria-label="Close"
                        style={{ width: 34, height: 34, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 10, border: '1px solid #E2E8F0', background: '#fff', color: '#64748B', cursor: 'pointer', fontSize: 15, fontWeight: 700, flexShrink: 0 }}
                      >
                        ✕
                      </button>
                    </div>

                    {/* Body (scrollable) */}
                    <div style={{ padding: '20px 24px', overflowY: 'auto', flex: 1, background: '#FCFDFF' }}>
                      {goalIsRejected && (
                        <div style={{ marginBottom: 14, padding: '12px 14px', background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: 10, display: 'flex', gap: 10, alignItems: 'flex-start' }}>
                          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#DC2626" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, marginTop: 1 }}><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
                          <div style={{ fontSize: 13, color: '#991B1B', lineHeight: 1.5 }}>
                            <div style={{ fontWeight: 700, marginBottom: goal.reviewNote ? 4 : 0 }}>Your manager requested changes on this goal.</div>
                            {goal.reviewNote && <div style={{ color: '#7F1D1D' }}>{goal.reviewNote}</div>}
                          </div>
                        </div>
                      )}
                      {modalIssues.length > 0 && (
                        <div style={{ marginBottom: 14, display: 'flex', flexDirection: 'column', gap: 6 }}>
                          {modalIssues.map((issue, index) => (
                            <div key={`${issue.text}-${index}`} style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '6px 10px', borderRadius: 999, background: issue.kind === 'error' ? '#FEF2F2' : '#FFFBEB', border: `1px solid ${issue.kind === 'error' ? '#FECACA' : '#FDE68A'}`, color: issue.kind === 'error' ? '#991B1B' : '#92400E', fontSize: 12, fontWeight: 700, width: 'fit-content', maxWidth: '100%' }}>
                              <span style={{ width: 6, height: 6, borderRadius: '50%', background: issue.kind === 'error' ? '#DC2626' : '#D97706', flexShrink: 0 }} />
                              <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{issue.text}</span>
                            </div>
                          ))}
                        </div>
                      )}
                      {showPerspectiveField && (
                        <div style={{ marginBottom: 14 }}>
                          <div style={{ fontSize: 11, fontWeight: 700, color: '#64748B', textTransform: 'uppercase', letterSpacing: '.07em', marginBottom: 6 }}>Perspective</div>
                          <select
                            value={goal.perspName}
                            onChange={(e) => updateGoal(goal.id, 'perspName', e.target.value)}
                            style={{ width: '100%', padding: '10px 12px', borderRadius: 10, border: '1.5px solid #D9E2EC', fontFamily: 'inherit', fontSize: 13.5, background: '#fff' }}
                          >
                            <option value="">Select perspective</option>
                            {perspectives.map((p) => (
                              <option key={p.name} value={p.name}>{p.name}</option>
                            ))}
                          </select>
                        </div>
                      )}

                      {canEditKraFieldsNow ? (
                        <div style={{ marginBottom: 14 }}>
                          <div style={{ fontSize: 11, fontWeight: 700, color: '#64748B', textTransform: 'uppercase', letterSpacing: '.07em', marginBottom: 6 }}>Goal</div>
                          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) auto', gap: 10 }}>
                            <div style={{ position: 'relative' }}>
                              <input
                                value={goal.name}
                                onChange={(e) => updateGoal(goal.id, 'name', e.target.value)}
                                placeholder={`Goal ${goalIndex + 1} name`}
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
                              >✨</button>
                            </div>
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
                                <button type="button" onClick={() => updateGoal(goal.id, 'weight', String(Math.min(100, (Number(goal.weight) || 0) + 5)))} style={{ padding: '3px 8px', borderRadius: 6, border: '1px solid #E2E8F0', background: '#F8FAFC', color: '#374151', cursor: 'pointer', fontFamily: 'inherit', fontSize: 12, lineHeight: 1 }}>+</button>
                                <button type="button" onClick={() => updateGoal(goal.id, 'weight', String(Math.max(0, (Number(goal.weight) || 0) - 5)))} style={{ padding: '3px 8px', borderRadius: 6, border: '1px solid #E2E8F0', background: '#F8FAFC', color: '#374151', cursor: 'pointer', fontFamily: 'inherit', fontSize: 12, lineHeight: 1 }}>−</button>
                              </div>
                            </div>
                          </div>

                          {isRewriting && (
                            <div style={{ marginTop: 10, background: '#F5F3FF', border: '1px solid #DDD6FE', borderRadius: 10, padding: '10px 12px' }}>
                              <div style={{ fontSize: 11.5, fontWeight: 700, color: '#6D28D9', marginBottom: 8 }}>✨ Click a suggestion to apply:</div>
                              {rewriteSuggestions.length > 0 ? (
                                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                                  {rewriteSuggestions.map((suggestion, i) => (
                                    <button key={i} type="button" onClick={() => { updateGoal(goal.id, 'name', suggestion); setRewritingGoalId(null); }} style={{ textAlign: 'left', padding: '8px 12px', borderRadius: 8, border: '1px solid #DDD6FE', background: '#fff', color: '#374151', cursor: 'pointer', fontFamily: 'inherit', fontSize: 13 }}>
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
                        <div style={{ marginBottom: 14, padding: '12px 14px', borderRadius: 12, background: '#F8FAFC', border: '1px solid #E9EDF2' }}>
                          {goal.perspName && goal.perspName !== 'All KRAs' && <div style={{ fontSize: 10.5, fontWeight: 700, color, textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 4 }}>{goal.perspName}</div>}
                          <div style={{ fontSize: 15, fontWeight: 800, color: '#0D1117' }}>{goal.name}</div>
                          <span style={{ fontSize: 12, fontWeight: 700, color, background: `${color}14`, padding: '4px 10px', borderRadius: 999, display: 'inline-block', marginTop: 6 }}>Weight: {goal.weight || 0}%</span>
                        </div>
                      )}

                      {/* KPIs */}
                      <div style={{ marginTop: 4 }}>
                        {(goal.kpis || []).length > 0 && (
                          <div style={{ fontSize: 11, fontWeight: 700, color: '#64748B', textTransform: 'uppercase', letterSpacing: '.07em', marginBottom: 8 }}>KPIs</div>
                        )}
                        {(goal.kpis || []).map((kpi) => {
                          const isEmployeeAdded = kpi.source !== 'library';
                          const kpiEditable = canEditExistingKpiNow || (canAddKpiNow && isEmployeeAdded);
                          const isSuggestionMode = effectiveConfig?.goalCreationMode === 'admin-library' && effectiveConfig?.goalKpiMode === 'kra-kpi' && accessMode === 'add-kpis';
                          return (
                            <div key={kpi.id} style={{ padding: '12px', borderRadius: 12, background: '#fff', border: '1px solid #E9EDF2', marginBottom: 8, display: 'flex', gap: 12, alignItems: 'flex-start', flexWrap: 'wrap' }}>
                              <div style={{ flex: 1, minWidth: 220 }}>
                                {kpiEditable ? (
                                  <div>
                                    <div style={{ display: 'grid', gridTemplateColumns: isSuggestionMode ? 'minmax(0,1fr)' : 'minmax(0,1fr) auto', gap: 8, alignItems: 'start' }}>
                                      <textarea
                                        value={kpi.name}
                                        onChange={(e) => updateKpi(goal.id, kpi.id, 'name', e.target.value)}
                                        placeholder="KPI name"
                                        rows={2}
                                        style={{
                                          padding: '9px 12px',
                                          borderRadius: 9,
                                          border: '1.5px solid #D9E2EC',
                                          fontFamily: 'inherit',
                                          fontSize: 13,
                                          background: '#fff',
                                          lineHeight: 1.35,
                                          resize: 'none',
                                          minHeight: 42,
                                          maxHeight: 78,
                                          overflowY: 'auto',
                                        }}
                                      />
                                      {!isSuggestionMode && effectiveConfig?.kpiRatingMode !== 'free-text' && (
                                        <div style={{ display: 'flex', gap: 3, alignItems: 'flex-start' }}>
                                          <input value={kpi.weight} onChange={(e) => updateKpi(goal.id, kpi.id, 'weight', e.target.value)} placeholder="Wt %" type="number" min="0" step="1" style={{ width: 60, padding: '9px 6px', borderRadius: 9, border: '1.5px solid #D9E2EC', fontFamily: 'inherit', fontSize: 13 }} />
                                          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                                            <button type="button" onClick={() => updateKpi(goal.id, kpi.id, 'weight', String(Math.min(100, (Number(kpi.weight) || 0) + 5)))} style={{ padding: '2px 6px', borderRadius: 5, border: '1px solid #E2E8F0', background: '#F8FAFC', color: '#374151', cursor: 'pointer', fontFamily: 'inherit', fontSize: 11, lineHeight: 1 }}>+</button>
                                            <button type="button" onClick={() => updateKpi(goal.id, kpi.id, 'weight', String(Math.max(0, (Number(kpi.weight) || 0) - 5)))} style={{ padding: '2px 6px', borderRadius: 5, border: '1px solid #E2E8F0', background: '#F8FAFC', color: '#374151', cursor: 'pointer', fontFamily: 'inherit', fontSize: 11, lineHeight: 1 }}>−</button>
                                          </div>
                                        </div>
                                      )}
                                    </div>
                                    <div style={{ marginTop: 8 }}>
                                      <TargetField
                                        value={kpi.target || ''}
                                        onValueChange={(v) => updateKpi(goal.id, kpi.id, 'target', v)}
                                        type={kpi.targetType || 'text'}
                                        onTypeChange={(t) => updateKpi(goal.id, kpi.id, 'targetType', t)}
                                      />
                                    </div>
                                  </div>
                                ) : (
                                  <div>
                                    <div style={{ fontSize: 14, color: '#1E293B', fontWeight: 600 }}>
                                      {kpi.name}
                                      {isEmployeeAdded ? <span style={{ marginLeft: 8, fontSize: 12, fontWeight: 700, color: '#2563EB', background: '#EFF6FF', padding: '2px 9px', borderRadius: 999 }}>Suggested</span> : null}
                                    </div>
                                    <div style={{ fontSize: 12.5, color: '#94A3B8', marginTop: 4 }}>
                                      {effectiveConfig?.kpiRatingMode !== 'free-text' && kpi.weight ? `Weight: ${kpi.weight}%` : 'Additional KPI'}
                                      {kpi.target ? ` · Target: ${kpi.target}` : ''}
                                    </div>
                                  </div>
                                )}
                              </div>
                              {kpiEditable && (
                                <button type="button" onClick={() => removeKpi(goal.id, kpi.id)} style={{ padding: '7px 9px', borderRadius: 8, border: '1px solid #E2E8F0', background: '#fff', color: '#94A3B8', cursor: 'pointer', fontFamily: 'inherit', fontSize: 12 }}>✕</button>
                              )}
                            </div>
                          );
                        })}
                        {canAddKpiNow && (
                          <button
                            type="button"
                            onClick={() => addKpi(goal.id)}
                            style={{ padding: '10px 14px', borderRadius: 10, border: `1px dashed ${color}66`, background: `${color}08`, color, cursor: 'pointer', fontFamily: 'inherit', fontSize: 13.5, fontWeight: 700 }}
                          >
                            + {effectiveConfig?.goalKpiMode === 'kra-kpi' && accessMode === 'add-kpis' ? 'Suggest extra KPI' : 'Add KPI'}
                          </button>
                        )}
                      </div>
                    </div>

                    {/* Footer */}
                    <div style={{ padding: '14px 24px', borderTop: '1px solid #E2E8F0', display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: confirmDeleteGoal ? '#FEF2F2' : '#F8FAFC', gap: 12, transition: 'background 180ms ease' }}>
                      {confirmDeleteGoal ? (
                        <>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: '#991B1B', fontWeight: 600, minWidth: 0 }}>
                            <span style={{ width: 20, height: 20, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: '50%', background: '#DC2626', color: '#fff', fontSize: 12, fontWeight: 800, flexShrink: 0 }}>!</span>
                            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>Delete this goal and all its KPIs?</span>
                          </div>
                          <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
                            <button
                              type="button"
                              onClick={() => setConfirmDeleteGoal(false)}
                              style={{ padding: '9px 16px', borderRadius: 10, border: '1px solid #CBD5E1', background: '#fff', color: '#475569', cursor: 'pointer', fontFamily: 'inherit', fontSize: 13, fontWeight: 700 }}
                            >
                              Cancel
                            </button>
                            <button
                              type="button"
                              onClick={() => { removeGoal(goal.id); closeModal(); }}
                              style={{ padding: '9px 18px', borderRadius: 10, border: 'none', background: '#DC2626', color: '#fff', cursor: 'pointer', fontFamily: 'inherit', fontSize: 13, fontWeight: 700, boxShadow: '0 4px 12px rgba(220,38,38,0.35)' }}
                            >
                              Yes, delete
                            </button>
                          </div>
                        </>
                      ) : (
                        <>
	                          <div>
	                            {goalCanEdit && canAddKra && (!goalIsLocked || !isGoalStructurallyValid(goal)) && (
                              <button
                                type="button"
                                onClick={() => setConfirmDeleteGoal(true)}
                                title={goalIsLocked ? 'This goal is missing required fields — delete to clean up the plan.' : 'Delete goal'}
                                style={{ padding: '10px 18px', borderRadius: 10, border: '1px solid #FECACA', background: '#fff', color: '#DC2626', cursor: 'pointer', fontFamily: 'inherit', fontSize: 13.5, fontWeight: 700 }}
                              >
                                {goalIsLocked ? 'Delete broken goal' : 'Delete goal'}
                              </button>
                            )}
                          </div>
	                          <div style={{ display: 'flex', gap: 8, marginLeft: 'auto' }}>
	                            <button
	                              type="button"
	                              onClick={closeModal}
                              style={{ padding: '10px 18px', borderRadius: 10, border: '1px solid #CBD5E1', background: '#fff', color: '#475569', cursor: 'pointer', fontFamily: 'inherit', fontSize: 13.5, fontWeight: 700 }}
	                            >
	                              Close
	                            </button>
	                            {goalCanEdit && (
	                              <button
	                                type="button"
	                                onClick={closeModal}
	                                style={{ padding: '10px 22px', borderRadius: 10, border: 'none', background: color, color: '#fff', cursor: 'pointer', fontFamily: 'inherit', fontSize: 13.5, fontWeight: 700, boxShadow: `0 4px 12px ${color}3D` }}
	                              >
	                                ✓ Done
	                              </button>
	                            )}
	                          </div>
                        </>
                      )}
                    </div>
                  </div>
                </div>
              );
            })()}

            {libDropActive && (
              <div style={{ margin: '0 0 16px', padding: '16px', borderRadius: 12, border: '2px dashed #A5B4FC', background: '#EEF2FF', textAlign: 'center', fontSize: 14, fontWeight: 700, color: '#4338CA' }}>
                Drop to add KRA to your plan
              </div>
            )}


            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, marginTop: 10, flexWrap: 'wrap', alignItems: 'center' }}>
              <div style={{ fontSize: 13.5, color: '#64748B' }}>
                {!canEditGoalPlan && mySubmission.status === 'approved'
                  ? 'This goal plan is approved and locked for the current phase.'
                  : !canEditGoalPlan && mySubmission.status === 'pending-manager'
                    ? 'Your manager now has this plan in the approval queue.'
                    : myValidation.canSubmit
                      ? 'All checks passed — ready to submit.'
                      : ''}
              </div>
              <button
                type="button"
                onClick={submitGoals}
                disabled={!canEditGoalPlan || !myValidation.canSubmit}
                style={{
                  padding: '11px 28px',
                  background: canEditGoalPlan && myValidation.canSubmit ? '#16A34A' : '#CBD5E1',
                  color: '#fff',
                  border: 'none',
                  borderRadius: 9,
                  fontSize: 15,
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
    const contacts = messageContacts;

    if (contacts.length === 0) {
      return <EmptyState title="No contacts" subtitle="You have no manager or direct reports to message." />;
    }

    const ck = activeConversation ? convKey(session.empCode, activeConversation) : null;
    const conversation = ck ? (messagesData.conversations[ck] || { messages: [] }) : null;
    const contactInfo = contacts.find((c) => c.code === normalizeCode(activeConversation || ''));

    const avatarGradient = (seed) => {
      const palette = [
        ['#2563EB', '#4F46E5'], ['#DB2777', '#E11D48'], ['#0891B2', '#0284C7'],
        ['#16A34A', '#059669'], ['#D97706', '#EA580C'], ['#7C3AED', '#A855F7'],
      ];
      const s = String(seed || '').toLowerCase();
      let hash = 0; for (let i = 0; i < s.length; i++) hash = (hash * 31 + s.charCodeAt(i)) | 0;
      const [a, b] = palette[Math.abs(hash) % palette.length];
      return `linear-gradient(135deg, ${a}, ${b})`;
    };
    const initials = (name) => {
      const parts = String(name || '').trim().split(/\s+/);
      return ((parts[0]?.[0] || '') + (parts[1]?.[0] || '')).toUpperCase() || String(name || '?')[0].toUpperCase();
    };

    // Spring easing approximates iMessage's pop; keep durations short so it never feels slow.
    const animCss = `
      @keyframes msgFadeIn { from { opacity: 0; transform: translateY(6px) scale(.96) } to { opacity: 1; transform: translateY(0) scale(1) } }
      @keyframes msgPanelIn { 0% { opacity: 0; transform: translateX(14px) scale(.985); } 60% { opacity: 1; } 100% { opacity: 1; transform: translateX(0) scale(1); } }
      @keyframes msgEmptyIn { from { opacity: 0; transform: scale(.98) } to { opacity: 1; transform: scale(1) } }
      .msg-row { animation: msgFadeIn 220ms cubic-bezier(.34,1.56,.64,1) both; }
      .msg-list-row { transition: transform 160ms cubic-bezier(.2,.8,.2,1), box-shadow 160ms ease, border-color 160ms ease, background 160ms ease; }
      .msg-list-row:hover { transform: translateY(-1px); box-shadow: 0 10px 24px rgba(15,23,42,.08); border-color: #D6E4FF !important; }
      .msg-list-row:active { transform: translateY(0) scale(.995); }
      .msg-send-btn { transition: transform 140ms cubic-bezier(.34,1.56,.64,1), box-shadow 140ms ease, background 180ms ease; }
      .msg-send-btn:not(:disabled):hover { transform: scale(1.06); }
      .msg-send-btn:not(:disabled):active { transform: scale(.94); }
      .msg-close-btn { transition: background 140ms ease, color 140ms ease, transform 140ms cubic-bezier(.34,1.56,.64,1); }
      .msg-close-btn:hover { background: #F1F5F9; color: #0F172A; transform: rotate(90deg); }
      .msg-panel-wrap { animation: msgPanelIn 300ms cubic-bezier(.2,.9,.2,1) both; }
      .msg-empty-wrap { animation: msgEmptyIn 220ms ease-out both; }
    `;

		    const renderContactList = (width = '360px') => (
		      <div style={{ display: 'grid', gap: 9, width, alignContent: 'start' }}>
	        {contacts.map((contact) => {
	          const ck2 = convKey(session.empCode, contact.code);
	          const conv = messagesData.conversations[ck2];
	          const lastMsg = conv?.messages?.[conv.messages.length - 1] || null;
	          const unread = (conv?.messages || []).filter((m) => m.from !== employeeCodeKey && !m.read).length;
	          const isActive = normalizeCode(activeConversation || '') === normalizeCode(contact.code);
	          return (
	            <button
	              key={contact.code}
	              type="button"
	              className="msg-list-row"
	              onClick={(e) => { e.stopPropagation(); setActiveConversation(contact.code); markConversationRead(contact.code); }}
	              style={{
	                width: '100%', textAlign: 'left',
	                padding: '9px 12px',
	                background: isActive ? '#FFFFFF' : unread > 0 ? 'linear-gradient(135deg,#EFF6FF 0%, #ffffff 72%)' : 'rgba(255,255,255,0.92)',
	                border: `1.5px solid ${isActive ? '#93C5FD' : unread > 0 ? '#BFDBFE' : '#E9EEF5'}`,
	                borderRadius: 16,
	                boxShadow: isActive ? '0 10px 28px rgba(37,99,235,.14)' : unread > 0 ? '0 8px 22px rgba(37,99,235,.10)' : '0 3px 12px rgba(15,23,42,.04)',
	                cursor: 'pointer', fontFamily: 'inherit',
	                display: 'flex', alignItems: 'center', gap: 11,
	              }}
	            >
	              <div style={{ position: 'relative', flexShrink: 0 }}>
	                <div style={{ width: 34, height: 34, borderRadius: '50%', background: avatarGradient(contact.code || contact.name), display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontSize: 12.5, fontWeight: 800, boxShadow: '0 2px 8px rgba(15,23,42,.12)' }}>
	                  {initials(contact.name)}
	                </div>
	                {unread > 0 && (
	                  <span style={{ position: 'absolute', top: -2, right: -2, minWidth: 16, height: 16, padding: '0 4px', borderRadius: 999, background: '#2563EB', color: '#fff', fontSize: 10, fontWeight: 800, display: 'flex', alignItems: 'center', justifyContent: 'center', border: '2px solid #fff', boxSizing: 'content-box' }}>
	                    {unread > 9 ? '9+' : unread}
	                  </span>
	                )}
	              </div>
	              <div style={{ flex: 1, minWidth: 0 }}>
	                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8, marginBottom: 1 }}>
	                  <div style={{ display: 'flex', alignItems: 'center', gap: 7, minWidth: 0 }}>
	                    <span style={{ fontSize: 13.5, fontWeight: unread > 0 ? 800 : 700, color: '#0F172A', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
	                      {contact.name}
	                    </span>
	                    <span style={{ fontSize: 10, fontWeight: 700, color: '#94A3B8', background: '#F1F5F9', padding: '1px 7px', borderRadius: 999, flexShrink: 0 }}>
	                      {contact.role}
	                    </span>
	                  </div>
	                  {lastMsg && (
	                    <span style={{ fontSize: 11, color: unread > 0 ? '#2563EB' : '#94A3B8', whiteSpace: 'nowrap', fontWeight: unread > 0 ? 800 : 500 }} title={formatDateTime(lastMsg.ts)}>
	                      {formatRelativeTime(lastMsg.ts)}
	                    </span>
	                  )}
	                </div>
	                {lastMsg ? (
	                  <div style={{ fontSize: 12.5, color: unread > 0 ? '#334155' : '#94A3B8', fontWeight: unread > 0 ? 600 : 400, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
	                    {lastMsg.from === employeeCodeKey && <span style={{ color: '#94A3B8' }}>You: </span>}
	                    {lastMsg.content}
	                  </div>
	                ) : (
	                  <div style={{ fontSize: 12.5, color: '#CBD5E1', fontStyle: 'italic' }}>Tap to start a conversation</div>
	                )}
	              </div>
	            </button>
	          );
	        })}
	      </div>
	    );

    // Unified layout: inbox list on the left is always in the same slot; right slot shows either
    // an empty-state placeholder or the chat panel. Keeps the page from jumping when a thread opens.
    const msgs = conversation?.messages || [];
    const GAP_MS = 5 * 60 * 1000;
    const PANEL_HEIGHT = 'min(540px, calc(100vh - 250px))';

    const totalUnread = contacts.reduce((sum, c) => {
      const conv = messagesData.conversations[convKey(session.empCode, c.code)];
      return sum + (conv?.messages || []).filter((m) => m.from !== employeeCodeKey && !m.read).length;
    }, 0);

    const closeThread = () => setActiveConversation(null);

    const chatPanel = activeConversation && conversation ? (
      <div
        key={`panel-${normalizeCode(activeConversation)}`}
        className="msg-panel-wrap"
        style={{
          background: 'rgba(255,255,255,0.86)',
          border: '1px solid rgba(226,232,240,0.9)',
          borderRadius: 18,
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
          width: '100%',
          height: PANEL_HEIGHT,
          minHeight: 380,
          boxShadow: '0 16px 38px rgba(15,23,42,.08)',
        }}
      >
        <div style={{ padding: '10px 14px', borderBottom: '1px solid #F1F5F9', display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0, background: '#fff', position: 'relative', zIndex: 1 }}>
          <div style={{ width: 34, height: 34, borderRadius: '50%', background: avatarGradient(contactInfo?.code || contactInfo?.name), display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontSize: 12.5, fontWeight: 800, flexShrink: 0, boxShadow: '0 2px 8px rgba(15,23,42,.12)' }}>
            {initials(contactInfo?.name)}
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 14.5, fontWeight: 700, color: '#0F172A', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{contactInfo?.name}</div>
            <div style={{ fontSize: 11.5, color: '#94A3B8', fontWeight: 500 }}>{contactInfo?.role}</div>
          </div>
          <button
            type="button"
            className="msg-close-btn"
            onClick={closeThread}
            aria-label="Close conversation"
            style={{ width: 32, height: 32, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 10, border: 'none', background: 'transparent', color: '#94A3B8', cursor: 'pointer', flexShrink: 0 }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
          </button>
        </div>

        <div style={{
          flex: 1,
          overflowY: 'auto',
          padding: '16px 18px 10px',
          background: 'linear-gradient(180deg,#FAFBFF 0%,#F6F8FD 100%)',
          display: 'flex',
          flexDirection: 'column',
        }}>
          {msgs.length === 0 && (
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 10, color: '#94A3B8', fontSize: 13 }}>
              <div style={{ width: 52, height: 52, borderRadius: '50%', background: avatarGradient(contactInfo?.code || contactInfo?.name), display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontSize: 19, fontWeight: 800, boxShadow: '0 4px 14px rgba(15,23,42,.12)' }}>
                {initials(contactInfo?.name)}
              </div>
              <div style={{ fontSize: 14.5, fontWeight: 700, color: '#334155' }}>Say hi to {contactInfo?.name?.split(' ')[0] || 'them'}</div>
              <div style={{ fontSize: 12.5 }}>Your first message starts the thread.</div>
            </div>
          )}

          {msgs.map((msg, i) => {
            const isMe = msg.from === employeeCodeKey;
            const prev = msgs[i - 1];
            const next = msgs[i + 1];
            const sameSenderAsPrev = prev && prev.from === msg.from && (msg.ts - prev.ts < GAP_MS);
            const sameSenderAsNext = next && next.from === msg.from && (next.ts - msg.ts < GAP_MS);
            const showDaySeparator = !prev || !isSameDay(prev.ts, msg.ts);
            const isLastInGroup = !sameSenderAsNext;
            const isFirstInGroup = !sameSenderAsPrev;

            let radius;
            if (isMe) {
              radius = `${isFirstInGroup ? 18 : 8}px 18px ${isLastInGroup ? 4 : 8}px 18px`;
            } else {
              radius = `18px ${isFirstInGroup ? 18 : 8}px 18px ${isLastInGroup ? 4 : 8}px`;
            }

            return (
              <div key={msg.id}>
                {showDaySeparator && (
                  <div style={{ display: 'flex', justifyContent: 'center', margin: i === 0 ? '0 0 14px' : '14px 0' }}>
                    <span style={{ fontSize: 11, fontWeight: 700, color: '#94A3B8', background: '#fff', border: '1px solid #E9EDF2', padding: '4px 12px', borderRadius: 999, letterSpacing: '.02em' }}>
                      {formatDayLabel(msg.ts)}
                    </span>
                  </div>
                )}
                <div
                  className="msg-row"
                  style={{
                    display: 'flex',
                    flexDirection: 'row',
                    justifyContent: isMe ? 'flex-end' : 'flex-start',
                    marginTop: sameSenderAsPrev ? 2 : 8,
                    alignItems: 'flex-end',
                    gap: 8,
                  }}>
                  {!isMe && (
                    <div style={{ width: 28, height: 28, flexShrink: 0, visibility: isLastInGroup ? 'visible' : 'hidden' }}>
                      <div style={{ width: 28, height: 28, borderRadius: '50%', background: avatarGradient(contactInfo?.code || contactInfo?.name), display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontSize: 11, fontWeight: 800 }}>
                        {initials(contactInfo?.name)}
                      </div>
                    </div>
                  )}
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: isMe ? 'flex-end' : 'flex-start', maxWidth: '72%' }}>
                    <div style={{
                      padding: '9px 14px',
                      borderRadius: radius,
                      background: isMe ? accentFill : '#fff',
                      color: isMe ? '#fff' : '#0F172A',
                      fontSize: 14,
                      lineHeight: 1.5,
                      boxShadow: isMe ? `0 2px 8px ${brandPalette.primary}38` : '0 1px 2px rgba(15,23,42,.05), 0 0 0 1px #EAEEF3',
                      wordBreak: 'break-word',
                      whiteSpace: 'pre-wrap',
                    }}>
                      {msg.content}
                    </div>
                    {isLastInGroup && (
                      <div style={{ fontSize: 10.5, color: '#94A3B8', marginTop: 3, padding: isMe ? '0 4px 0 0' : '0 0 0 4px', fontWeight: 500 }}>
                        {formatTimeShort(msg.ts)}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        <div style={{ padding: '10px 12px 12px', borderTop: '1px solid #F1F5F9', background: '#fff', flexShrink: 0 }}>
          <div style={{
            display: 'flex',
            alignItems: 'flex-end',
            gap: 8,
            background: '#F1F5F9',
            borderRadius: 22,
            padding: '6px 6px 6px 16px',
            transition: 'box-shadow 180ms ease, background 180ms ease',
          }}
            onFocus={(e) => { e.currentTarget.style.background = '#fff'; e.currentTarget.style.boxShadow = '0 0 0 2px #DBEAFE inset, 0 1px 3px rgba(15,23,42,.06)'; }}
            onBlur={(e) => { e.currentTarget.style.background = '#F1F5F9'; e.currentTarget.style.boxShadow = 'none'; }}
          >
            <textarea
              value={messageInput}
              onChange={(e) => setMessageInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  if (messageInput.trim()) {
                    sendMessage(activeConversation, messageInput);
                    setMessageInput('');
                  }
                }
              }}
              rows={1}
              placeholder="Message…"
              style={{
                flex: 1, minWidth: 0,
                padding: '8px 0', border: 'none', outline: 'none',
                fontFamily: 'inherit', fontSize: 14, resize: 'none',
                background: 'transparent', color: '#0F172A',
                lineHeight: 1.5, maxHeight: 110,
              }}
            />
            <button
              type="button"
              className="msg-send-btn"
              onClick={() => { if (messageInput.trim()) { sendMessage(activeConversation, messageInput); setMessageInput(''); } }}
              disabled={!messageInput.trim()}
              aria-label="Send"
              style={{
                width: 36, height: 36, flexShrink: 0,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                borderRadius: '50%', border: 'none',
                background: messageInput.trim() ? accentFill : '#CBD5E1',
                color: '#fff',
                cursor: messageInput.trim() ? 'pointer' : 'not-allowed',
                boxShadow: messageInput.trim() ? `0 4px 12px ${brandPalette.primary}59` : 'none',
              }}
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 2 11 13"/><path d="M22 2 15 22l-4-9-9-4z"/></svg>
            </button>
          </div>
        </div>
      </div>
    ) : (
      <div
        key="panel-empty"
        className="msg-empty-wrap"
        style={{
          background: 'rgba(255,255,255,0.55)',
          border: '1px dashed #D9E2EC',
          borderRadius: 18,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          width: '100%',
          height: PANEL_HEIGHT,
          minHeight: 380,
          color: '#94A3B8',
          textAlign: 'center',
          padding: '20px',
          gap: 10,
        }}
      >
        <div style={{ width: 52, height: 52, borderRadius: '50%', background: 'linear-gradient(135deg,#E0E7FF,#DBEAFE)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#4F46E5' }}>
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
        </div>
        <div style={{ fontSize: 14.5, fontWeight: 700, color: '#334155' }}>Select a conversation</div>
        <div style={{ fontSize: 12.5, maxWidth: 280 }}>Pick someone on the left to start messaging. Drafts are saved per conversation.</div>
      </div>
    );

    return (
      <div
        onClick={(e) => {
          if (!activeConversation || e.target !== e.currentTarget) return;
          closeThread();
        }}
        style={{ minHeight: activeConversation ? PANEL_HEIGHT : undefined }}
      >
        <style>{animCss}</style>

        {/* Header matches Team Goals one-for-one so switching tabs doesn't visibly shift anything below. */}
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center', flexWrap: 'wrap', marginBottom: 12 }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <div style={{ fontSize: 18, fontWeight: 800, color: '#0F172A' }}>Messages</div>
              {totalUnread > 0 && (
                <span style={{ fontSize: 11, fontWeight: 800, color: '#fff', background: accentFill, padding: '3px 10px', borderRadius: 999, boxShadow: `0 2px 8px ${brandPalette.primary}59` }}>
                  {totalUnread} new
                </span>
              )}
            </div>
            <div style={{ fontSize: 12.5, color: '#64748B', marginTop: 3 }}>{contacts.length} {contacts.length === 1 ? 'contact' : 'contacts'}</div>
          </div>
        </div>

        <div
          onClick={(e) => {
            if (!activeConversation || e.target !== e.currentTarget) return;
            closeThread();
          }}
          style={{ display: 'grid', gridTemplateColumns: '360px minmax(440px, 720px)', gap: 14, alignItems: 'start', justifyContent: 'start' }}
        >
          {renderContactList('360px')}
          {chatPanel}
        </div>
      </div>
    );
  }

  function renderTeam() {
    if (directReports.length === 0) {
      return <EmptyState title="No direct reports found" subtitle="Employees reporting to you will appear here for reminders and approvals." />;
    }

    // Classify each report so we can filter + count.
    const classify = (submission) => {
      if (submission?.status === 'pending-manager') return 'pending';
      if (submission?.status === 'approved') return 'approved';
      if (submission?.status === 'sent-back') return 'sent-back';
      return 'not-submitted';
    };
    const rows = directReports.map((report) => {
      const reportCode = String(report['Employee Code'] || '').trim();
      const submission = workflow?.submissions?.[normalizeCode(reportCode)] || null;
      return { report, reportCode, submission, bucket: classify(submission) };
    });
    const counts = rows.reduce((acc, r) => { acc[r.bucket] = (acc[r.bucket] || 0) + 1; return acc; }, {});
    counts.all = rows.length;
    const FILTER_TABS = [
      { id: 'all', label: 'All', color: '#475569', bg: '#F8FAFC', activeBg: '#0F172A', activeColor: '#fff' },
      { id: 'pending', label: 'Pending', color: '#D97706', bg: '#FFF7ED', activeBg: '#D97706', activeColor: '#fff' },
      { id: 'approved', label: 'Approved', color: '#16A34A', bg: '#F0FDF4', activeBg: '#16A34A', activeColor: '#fff' },
      { id: 'sent-back', label: 'Sent back', color: '#DC2626', bg: '#FEF2F2', activeBg: '#DC2626', activeColor: '#fff' },
      { id: 'not-submitted', label: 'Not submitted', color: '#475569', bg: '#F8FAFC', activeBg: '#475569', activeColor: '#fff' },
    ];
    const bucketOrder = { pending: 0, 'sent-back': 1, 'not-submitted': 2, approved: 3 };
    const query = sanitizeText(teamSearch).toLowerCase();
    const visible = rows
      .filter((r) => teamFilter === 'all' || r.bucket === teamFilter)
      .filter((r) => {
        if (!query) return true;
        const statusLabel = getSubmissionStatusMeta(r.submission).label;
        return [
          r.report['Employee Name'],
          r.reportCode,
          r.report.Designation,
          statusLabel,
        ].some((value) => String(value || '').toLowerCase().includes(query));
      })
      .sort((a, b) => (bucketOrder[a.bucket] ?? 9) - (bucketOrder[b.bucket] ?? 9));

    return (
      <div>
        <style>{`
          @keyframes approvalFlash{0%{box-shadow:0 0 0 0 rgba(37,99,235,0)}30%{box-shadow:0 0 0 6px rgba(37,99,235,0.28)}100%{box-shadow:0 0 0 0 rgba(37,99,235,0)}}
          .appr-action { transition: background 150ms ease, color 150ms ease, border-color 150ms ease, transform 120ms ease; }
          .appr-action:hover:not(:disabled) { transform: translateY(-1px); }
          .appr-commit:disabled { opacity: 0.5; cursor: not-allowed !important; }
        `}</style>

        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center', flexWrap: 'wrap', marginBottom: 12 }}>
          <div>
	      <div style={{ fontSize: 18, fontWeight: 800, color: '#0F172A' }}>My Team Goals</div>
            <div style={{ fontSize: 12.5, color: '#64748B', marginTop: 3 }}>{visible.length} of {rows.length} team members</div>
          </div>
          <div style={{ position: 'relative', width: 'min(320px, 100%)' }}>
            <input
              value={teamSearch}
              onChange={(e) => setTeamSearch(e.target.value)}
              placeholder="Search team"
              style={{ width: '100%', boxSizing: 'border-box', padding: '10px 12px 10px 34px', borderRadius: 10, border: '1.5px solid #D9E2EC', background: '#fff', color: '#0F172A', fontFamily: 'inherit', fontSize: 13.5, outline: 'none' }}
            />
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#94A3B8" strokeWidth="2.3" strokeLinecap="round" strokeLinejoin="round" style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none' }}>
              <circle cx="11" cy="11" r="8" />
              <path d="m21 21-4.35-4.35" />
            </svg>
          </div>
        </div>

        {/* Filter row */}
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 14 }}>
          {FILTER_TABS.map((t) => {
            const n = counts[t.id] || 0;
            const active = teamFilter === t.id;
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => setTeamFilter(t.id)}
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 7,
                  padding: '6px 12px', borderRadius: 999, cursor: 'pointer', fontFamily: 'inherit',
                  fontSize: 12.5, fontWeight: 700,
                  border: `1.5px solid ${active ? t.activeBg : '#E2E8F0'}`,
                  background: active ? t.activeBg : '#fff',
                  color: active ? t.activeColor : t.color,
                }}
              >
                {t.label}
                <span style={{
                  background: active ? 'rgba(255,255,255,.22)' : t.bg,
                  color: active ? '#fff' : t.color,
                  padding: '1px 8px', borderRadius: 999, fontSize: 11, fontWeight: 800,
                }}>{n}</span>
              </button>
            );
          })}
        </div>

        {visible.length === 0 && (
          <div style={{ padding: '22px 20px', textAlign: 'center', color: '#94A3B8', fontSize: 13, border: '1px dashed #D9E2EC', borderRadius: 12 }}>
            No team members found.
          </div>
        )}

        {visible.map(({ report, reportCode, submission, bucket }) => {
          const reportGoals = submission?.goals || [];
          const reportGroup = getEmployeeGoalGroup(config, report);
          const reportOverrides = resolveGroupAccess(reportGroup);
          const reportEffectiveConfig = reportOverrides ? { ...config, ...reportOverrides } : config;
          const metrics = getGoalPlanMetrics(reportGoals, reportEffectiveConfig, getGoalAccessMode(reportEffectiveConfig));
          const statusMeta = getSubmissionStatusMeta(submission);
          const normalizedCode = normalizeCode(reportCode);
          const reminderState = getReminderState(reportCode);
          const canReview = bucket === 'pending' || bucket === 'approved' || bucket === 'sent-back';
          const expanded = canReview && expandedReviewCode === normalizedCode;
          const isFocused = focusApprovalCode === normalizedCode;
          return (
	            <div
	              key={reportCode}
	              ref={(el) => {
                if (el && isFocused) {
                  el.scrollIntoView({ behavior: 'smooth', block: 'start' });
	                  setTimeout(() => setFocusApprovalCode(null), 1200);
	                }
	              }}
	              onClick={() => { if (canReview) openApproval(reportCode); }}
	              style={{ background: '#fff', border: `1.5px solid ${isFocused ? '#93C5FD' : '#E9EDF2'}`, borderRadius: 12, padding: expanded ? '12px 14px 0' : '12px 14px', marginBottom: 10, animation: isFocused ? 'approvalFlash 1200ms ease' : 'none', cursor: canReview ? 'pointer' : 'default' }}
	            >
	              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center', flexWrap: 'wrap', marginBottom: 10 }}>
	                <div style={{ minWidth: 0 }}>
	                  <div style={{ fontSize: 15, fontWeight: 800, color: '#0F172A' }}>{report['Employee Name'] || reportCode}</div>
	                  <div style={{ fontSize: 12.5, color: '#64748B', marginTop: 4 }}>
	                    {reportCode}
	                    {report.Designation ? ` · ${report.Designation}` : ''}
	                    {submission?.submittedAt ? ` · submitted ${formatDateTime(submission.submittedAt)}` : ' · not submitted yet'}
	                  </div>
	                </div>
	                <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
	                  <div style={{ padding: '5px 10px', borderRadius: 999, background: statusMeta.bg, border: `1px solid ${statusMeta.border}`, color: statusMeta.color, fontSize: 12, fontWeight: 800 }}>
	                    {statusMeta.label}
	                  </div>
	                  {bucket === 'not-submitted' && (
	                    <button
	                      type="button"
	                      onClick={(e) => { e.stopPropagation(); sendReminder(report); }}
	                      disabled={reminderState.blocked}
	                      title={reminderState.blocked ? `Reminder available in ${reminderState.label}` : 'Send reminder'}
	                      style={{ padding: '5px 10px', borderRadius: 999, border: '1px solid #BFDBFE', background: reminderState.blocked ? '#F8FAFC' : '#EFF6FF', color: reminderState.blocked ? '#94A3B8' : '#2563EB', cursor: reminderState.blocked ? 'not-allowed' : 'pointer', fontFamily: 'inherit', fontSize: 12, fontWeight: 800 }}
	                    >
	                      {reminderState.blocked ? 'Reminder sent' : 'Send reminder'}
	                    </button>
	                  )}
	                  {bucket === 'sent-back' && (
	                    <button
	                      type="button"
	                      onClick={(e) => { e.stopPropagation(); sendReminder(report); }}
	                      disabled={reminderState.blocked}
	                      title={reminderState.blocked ? `Reminder available in ${reminderState.label}` : 'Send reminder'}
	                      style={{ padding: '5px 10px', borderRadius: 999, border: '1px solid #FECACA', background: reminderState.blocked ? '#F8FAFC' : '#FEF2F2', color: reminderState.blocked ? '#94A3B8' : '#DC2626', cursor: reminderState.blocked ? 'not-allowed' : 'pointer', fontFamily: 'inherit', fontSize: 12, fontWeight: 800 }}
	                    >
	                      {reminderState.blocked ? 'Reminder sent' : 'Send reminder'}
	                    </button>
	                  )}
	                </div>
	              </div>
	              <div style={{ display: 'grid', gridTemplateColumns: '76px minmax(180px,1fr) auto', gap: 12, alignItems: 'center' }}>
	                <div>
	                  <div style={{ fontSize: 20, fontWeight: 800, color: metrics.overall === 100 ? '#16A34A' : '#2563EB', lineHeight: 1 }}>{metrics.overall}%</div>
	                  <div style={{ fontSize: 11.5, color: '#64748B', marginTop: 3 }}>complete</div>
	                </div>
	                <div>
	                  <div style={{ height: 7, background: '#E2E8F0', borderRadius: 999, overflow: 'hidden' }}>
	                    <div style={{ height: '100%', width: `${metrics.overall}%`, background: metrics.overall === 100 ? 'linear-gradient(90deg,#16A34A,#22C55E)' : 'linear-gradient(90deg,#2563EB,#4F46E5)', borderRadius: 999 }} />
	                  </div>
	                </div>
	                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
	                  <div style={{ fontSize: 12, color: '#64748B' }}>Goals {metrics.goalPct}%</div>
	                  {metrics.shouldTrackKpis && (
	                    <div style={{ fontSize: 12, color: '#64748B' }}>KPI {metrics.kpiPct}%</div>
	                  )}
	                  <div style={{ fontSize: 12, color: '#64748B' }}>{reportGoals.length} goals</div>
	                </div>
	              </div>

	              {expanded && submission && (
	                <div onClick={(e) => e.stopPropagation()} style={{ marginTop: 12, marginLeft: -14, marginRight: -14, borderTop: '1px solid #E2E8F0', background: '#FAFBFC', padding: '14px 14px 16px', borderBottomLeftRadius: 12, borderBottomRightRadius: 12 }}>
	                  {renderReviewPanel(submission, bucket)}
	                </div>
	              )}
            </div>
          );
        })}
      </div>
    );
  }

  // Inline review panel — the approval surface that used to live in renderApprovals,
  // now embedded inside each team-member card.
  function renderReviewPanel(submission, bucket) {
    const reviewEmployee = employees.find((row) => normalizeCode(row['Employee Code']) === normalizeCode(submission.employeeCode));
    const reviewGroup = getEmployeeGoalGroup(config, reviewEmployee);
    const reviewOverrides = resolveGroupAccess(reviewGroup);
    const reviewEffectiveConfig = reviewOverrides ? { ...config, ...reviewOverrides } : config;
    const reviewTracksKpiWeights = reviewEffectiveConfig?.kpiRatingMode !== 'free-text';
    const readOnly = bucket !== 'pending';
    const setPick = (empCode, goalId, status) => {
      setGoalReviewPicks((prev) => {
        const perEmployee = { ...(prev[empCode] || {}) };
        if (perEmployee[goalId]?.status === status) {
          delete perEmployee[goalId];
        } else {
          perEmployee[goalId] = { status, note: status === 'reject' ? (perEmployee[goalId]?.note || '') : '' };
        }
        return { ...prev, [empCode]: perEmployee };
      });
    };
    const setPickNote = (empCode, goalId, note) => {
      setGoalReviewPicks((prev) => {
        const perEmployee = { ...(prev[empCode] || {}) };
        perEmployee[goalId] = { status: 'reject', ...(perEmployee[goalId] || {}), note };
        return { ...prev, [empCode]: perEmployee };
      });
    };

    const picks = goalReviewPicks[submission.employeeCode] || {};
    const pendingGoals = (submission.goals || []).filter((g) => g.reviewStatus !== 'approved');
    const lockedGoals = (submission.goals || []).filter((g) => g.reviewStatus === 'approved');
    const rejectedPickCount = Object.values(picks).filter((p) => p.status === 'reject').length;
    const approvedPickCount = pendingGoals.filter((g) => picks[g.id]?.status === 'approve').length;
    // Pending goals that are structurally broken — they can never be approved. "Approve all"
    // hides when any exist; reviewSubmission() force-rejects them as a belt-and-braces guard.
    const brokenPendingCount = pendingGoals.filter((g) => !isGoalStructurallyValid(g, reviewEffectiveConfig)).length;

    return (
      <div>
        {!readOnly && (
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 12 }}>
            {rejectedPickCount > 0 && (
              <div style={{ padding: '5px 11px', borderRadius: 999, background: '#FEF2F2', border: '1px solid #FECACA', fontSize: 12, fontWeight: 700, color: '#DC2626' }}>
                {rejectedPickCount} marked reject
              </div>
            )}
            {approvedPickCount > 0 && (
              <div style={{ padding: '5px 11px', borderRadius: 999, background: '#F0FDF4', border: '1px solid #BBF7D0', fontSize: 12, fontWeight: 700, color: '#16A34A' }}>
                {approvedPickCount} marked approve
              </div>
            )}
            <div style={{ padding: '6px 12px', borderRadius: 999, background: '#FEF2F2', border: '1px solid #FECACA', fontSize: 12.5, fontWeight: 700, color: '#DC2626' }}>
              {pendingGoals.length} pending review
            </div>
            {lockedGoals.length > 0 && (
              <div style={{ padding: '6px 12px', borderRadius: 999, background: '#F0FDF4', border: '1px solid #BBF7D0', fontSize: 12.5, fontWeight: 700, color: '#16A34A' }}>
                {lockedGoals.length} already approved
              </div>
            )}
          </div>
        )}

        {(submission.goals || []).map((goal) => {
          const color = getPerspectiveColor(goal, perspectives);
          const locked = goal.reviewStatus === 'approved';
          const broken = !isGoalStructurallyValid(goal, reviewEffectiveConfig);
          const pick = picks[goal.id];
          const markedApprove = !readOnly && !locked && pick?.status === 'approve';
          const markedReject = !readOnly && !locked && pick?.status === 'reject';
          const stateColor = locked || markedApprove ? '#16A34A' : markedReject ? '#DC2626' : '#E2E8F0';
          const stateBg = locked ? '#F0FDF4' : markedApprove ? '#F0FDF4' : markedReject ? '#FEF2F2' : '#fff';
          return (
            <div key={goal.id} style={{
              border: `1.5px solid ${stateColor}`,
              borderRadius: 12, padding: '14px 16px', marginBottom: 12,
              background: stateBg,
              transition: 'border-color 180ms ease, background 180ms ease',
            }}>
              <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', marginBottom: 10 }}>
                <div style={{ minWidth: 0, flex: 1 }}>
                  {goal.perspName && goal.perspName !== 'All KRAs' && (
                    <div style={{ fontSize: 11, fontWeight: 700, color, textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 4 }}>{goal.perspName}</div>
                  )}
                  <div style={{ fontSize: 14.5, fontWeight: 700, color: '#0D1117' }}>{goal.name || <span style={{ color: '#94A3B8', fontStyle: 'italic' }}>Untitled goal</span>}</div>
                </div>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexShrink: 0 }}>
                  <div style={{ fontSize: 12, fontWeight: 700, color, background: `${color}14`, padding: '4px 10px', borderRadius: 999 }}>
                    {goal.weight || 0}%
                  </div>
                  {locked ? (
                    <div style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '5px 10px', borderRadius: 999, background: '#DCFCE7', border: '1px solid #86EFAC', color: '#15803D', fontSize: 11.5, fontWeight: 700 }}>
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
                      Approved
                    </div>
                  ) : readOnly ? null : (
                    <>
                      {broken && (
                        <span title="Goal is missing required fields and cannot be approved" style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '5px 9px', borderRadius: 999, background: '#FEF2F2', border: '1px solid #FECACA', color: '#991B1B', fontSize: 11, fontWeight: 800 }}>
                          <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#DC2626' }} />
                          Broken — can't approve
                        </span>
                      )}
                      <button
                        type="button"
                        className="appr-action"
                        onClick={() => !broken && setPick(submission.employeeCode, goal.id, 'approve')}
                        disabled={broken}
                        title={broken ? 'Missing required fields — ask employee to fix and resubmit' : (markedApprove ? 'Click again to clear' : 'Mark approve')}
                        style={{
                          display: 'inline-flex', alignItems: 'center', gap: 4,
                          padding: '6px 11px', borderRadius: 9,
                          border: `1.5px solid ${markedApprove ? '#16A34A' : '#E2E8F0'}`,
                          background: markedApprove ? '#16A34A' : '#fff',
                          color: markedApprove ? '#fff' : '#64748B',
                          cursor: broken ? 'not-allowed' : 'pointer',
                          opacity: broken ? 0.45 : 1,
                          fontFamily: 'inherit', fontSize: 12, fontWeight: 700,
                        }}>
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
                        Approve
                      </button>
                      <button
                        type="button"
                        className="appr-action"
                        onClick={() => setPick(submission.employeeCode, goal.id, 'reject')}
                        title={markedReject ? 'Click again to clear' : 'Mark reject'}
                        style={{
                          display: 'inline-flex', alignItems: 'center', gap: 4,
                          padding: '6px 11px', borderRadius: 9,
                          border: `1.5px solid ${markedReject ? '#DC2626' : '#E2E8F0'}`,
                          background: markedReject ? '#DC2626' : '#fff',
                          color: markedReject ? '#fff' : '#64748B',
                          cursor: 'pointer', fontFamily: 'inherit', fontSize: 12, fontWeight: 700,
                        }}>
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                        Reject
                      </button>
                    </>
                  )}
                </div>
              </div>

              {(goal.kpis || []).length > 0 ? (
                <div style={{ display: 'grid', gap: 6 }}>
                  {(goal.kpis || []).map((kpi) => (
                    <div key={kpi.id} style={{ padding: '9px 12px', background: '#fff', borderRadius: 8, border: '1px solid #E9EDF2', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
                      <div style={{ fontSize: 13.5, color: '#1E293B', fontWeight: 600, minWidth: 0, flex: 1 }}>
                        {kpi.name || <span style={{ color: '#94A3B8', fontStyle: 'italic' }}>Unnamed KPI</span>}
                        {kpi.source !== 'library' && kpi.source !== undefined && (
                          <span style={{ marginLeft: 8, fontSize: 10.5, fontWeight: 700, color: '#2563EB', background: '#EFF6FF', padding: '2px 8px', borderRadius: 999 }}>Employee added</span>
                        )}
                      </div>
                      <div style={{ fontSize: 11.5, color: '#64748B', flexShrink: 0 }}>
                        {reviewTracksKpiWeights ? (kpi.weight ? `${kpi.weight}%` : '—') : 'Reference KPI'}
                        {kpi.target ? ` · ${kpi.target}` : ''}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div style={{ fontSize: 12.5, color: '#94A3B8', fontStyle: 'italic' }}>No KPIs added.</div>
              )}

              {markedReject && (
                <div style={{ marginTop: 10 }}>
                  <textarea
                    value={pick?.note || ''}
                    onChange={(e) => setPickNote(submission.employeeCode, goal.id, e.target.value)}
                    rows={2}
                    placeholder="Tell them what to change (optional)…"
                    style={{ width: '100%', padding: '10px 12px', borderRadius: 9, border: '1.5px solid #FECACA', fontFamily: 'inherit', fontSize: 13, resize: 'vertical', background: '#fff', color: '#0F172A', boxSizing: 'border-box' }}
                  />
                </div>
              )}
            </div>
          );
        })}

        {!readOnly && (
          <>
            <div style={{ marginTop: 14 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: '#64748B', textTransform: 'uppercase', letterSpacing: '.07em', marginBottom: 6 }}>Overall note (optional)</div>
              <textarea
                value={managerNotes[submission.employeeCode] || ''}
                onChange={(event) => setManagerNotes((prev) => ({ ...prev, [submission.employeeCode]: event.target.value }))}
                rows={2}
                placeholder="A comment about the plan as a whole"
                style={{ width: '100%', padding: '11px 13px', borderRadius: 10, border: '1.5px solid #D9E2EC', fontFamily: 'inherit', fontSize: 13.5, resize: 'vertical', boxSizing: 'border-box' }}
              />
            </div>

            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, marginTop: 16, flexWrap: 'wrap' }}>
              {/* Reject all — hidden when any goal has been marked approve (would contradict). */}
              {approvedPickCount === 0 ? (
                <button
                  type="button"
                  className="appr-action"
                  onClick={() => setReviewConfirm({
                    action: 'reject-all',
                    employeeCode: submission.employeeCode,
                    employeeName: submission.employeeName,
                    approvedPickCount, rejectedPickCount,
                    pendingTotal: pendingGoals.length,
                    lockedCount: lockedGoals.length,
                    planNote: sanitizeText(managerNotes[submission.employeeCode] || ''),
                    stage: 'confirm',
                    loading: false,
                  })}
                  style={{ padding: '10px 16px', borderRadius: 10, border: '1px solid #FECACA', background: '#fff', color: '#DC2626', cursor: 'pointer', fontFamily: 'inherit', fontSize: 13.5, fontWeight: 700 }}
                >
                  Reject all
                </button>
              ) : <span />}
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                <button
                  type="button"
                  className="appr-action appr-commit"
                  onClick={() => setReviewConfirm({
                    action: 'commit',
                    employeeCode: submission.employeeCode,
                    employeeName: submission.employeeName,
                    approvedPickCount, rejectedPickCount,
                    pendingTotal: pendingGoals.length,
                    lockedCount: lockedGoals.length,
                    planNote: sanitizeText(managerNotes[submission.employeeCode] || ''),
                    stage: 'confirm',
                    loading: false,
                  })}
                  disabled={rejectedPickCount === 0}
                  title={rejectedPickCount === 0 ? 'Mark at least one goal as Reject — unmarked goals will be auto-approved.' : ''}
                  style={{ padding: '10px 18px', borderRadius: 10, border: '1px solid #BFDBFE', background: rejectedPickCount === 0 ? '#EFF6FF' : '#2563EB', color: rejectedPickCount === 0 ? '#93C5FD' : '#fff', cursor: rejectedPickCount === 0 ? 'not-allowed' : 'pointer', fontFamily: 'inherit', fontSize: 13.5, fontWeight: 700, boxShadow: rejectedPickCount === 0 ? 'none' : '0 4px 12px rgba(37,99,235,.3)' }}
                >
                  Submit decision{rejectedPickCount > 0 ? ` · ${rejectedPickCount} send back` : ''}
                </button>
                {/* Approve all — hidden when (a) any goal is marked reject (would contradict)
                    or (b) any pending goal is structurally broken (can't be approved anyway). */}
                {rejectedPickCount === 0 && brokenPendingCount === 0 && (
                  <button
                    type="button"
                    className="appr-action"
                    onClick={() => setReviewConfirm({
                      action: 'approve-all',
                      employeeCode: submission.employeeCode,
                      employeeName: submission.employeeName,
                      approvedPickCount, rejectedPickCount, brokenPendingCount,
                      pendingTotal: pendingGoals.length,
                      lockedCount: lockedGoals.length,
                      planNote: sanitizeText(managerNotes[submission.employeeCode] || ''),
                      stage: 'confirm',
                      loading: false,
                    })}
                    style={{ padding: '10px 18px', borderRadius: 10, border: 'none', background: '#16A34A', color: '#fff', cursor: 'pointer', fontFamily: 'inherit', fontSize: 13.5, fontWeight: 700, boxShadow: '0 4px 12px rgba(22,163,74,.32)' }}
                  >
                    Approve all
                  </button>
                )}
              </div>
            </div>
          </>
        )}

        {readOnly && submission.managerNote && (
          <div style={{ marginTop: 14, fontSize: 13, color: '#7C2D12', background: '#FFF7ED', border: '1px solid #FED7AA', borderRadius: 8, padding: '10px 12px' }}>
            Manager note: {submission.managerNote}
          </div>
        )}
      </div>
    );
  }

  function renderNotifications() {
    if (notifications.length === 0) {
      return <EmptyState title="No notifications yet" subtitle="Reminders, approvals, and manager actions will appear here." />;
    }

    const unreadCount = notifications.filter((n) => !n.read).length;
    const groups = groupNotificationsByTime(notifications);
    const markAll = () => {
      const ids = notifications.filter((n) => !n.read).map((n) => n.id);
      if (ids.length) markNotificationsRead(ids);
    };

    return (
      <div>
        <style>{`
          .ntf-card { transition: transform 150ms ease, box-shadow 150ms ease, background 200ms ease; }
          .ntf-card:hover { transform: translateY(-1px); box-shadow: 0 10px 24px rgba(15,23,42,.07); }
          .ntf-card:hover .ntf-chev { opacity: 1; transform: translateX(0); }
          .ntf-chev { transition: opacity 200ms ease, transform 200ms ease; opacity: 0; transform: translateX(-4px); }
          .ntf-markall:hover { background: #F8FAFC !important; color: #1E293B !important; border-color: #CBD5E1 !important; }
        `}</style>

        {/* Page header */}
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, marginBottom: 22, flexWrap: 'wrap' }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <div style={{ fontSize: 21, fontWeight: 800, color: '#0F172A', letterSpacing: '-0.01em' }}>Notifications</div>
              {unreadCount > 0 && (
                <span style={{
                  fontSize: 11, fontWeight: 800, color: '#fff',
                  background: accentFill,
                  padding: '3px 10px', borderRadius: 999,
                  boxShadow: `0 2px 8px ${brandPalette.primary}59`,
                }}>
                  {unreadCount} new
                </span>
              )}
            </div>
            <div style={{ fontSize: 13, color: '#64748B', marginTop: 4 }}>
              {unreadCount > 0
                ? `You have ${unreadCount} unread notification${unreadCount > 1 ? 's' : ''}.`
                : 'All caught up — nice work.'}
            </div>
          </div>
          {unreadCount > 0 && (
            <button type="button" onClick={markAll} className="ntf-markall"
              style={{
                padding: '8px 14px', border: '1px solid #E2E8F0', background: '#fff', borderRadius: 10,
                color: '#475569', cursor: 'pointer', fontFamily: 'inherit', fontSize: 12.5, fontWeight: 700,
                display: 'inline-flex', alignItems: 'center', gap: 6, transition: 'all 180ms ease',
              }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
              Mark all read
            </button>
          )}
        </div>

        {/* Grouped lists */}
        {groups.map((group, gi) => (
          <div key={group.id} style={{ marginBottom: gi === groups.length - 1 ? 0 : 24 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10, paddingLeft: 2 }}>
              <span style={{ fontSize: 10.5, fontWeight: 800, color: '#94A3B8', textTransform: 'uppercase', letterSpacing: '.09em' }}>{group.label}</span>
              <span style={{ flex: 1, height: 1, background: 'linear-gradient(90deg,#E2E8F0,transparent)' }} />
              <span style={{ fontSize: 11, color: '#CBD5E1', fontWeight: 600 }}>{group.items.length}</span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {group.items.map((notification) => {
                const meta = NOTIFICATION_META[notification.type] || FALLBACK_NOTIFICATION_META;
                const unread = !notification.read;
                return (
                  <div
                    key={notification.id}
                    className="ntf-card"
                    onClick={() => handleNotificationClick(notification)}
                    style={{
                      background: unread
                        ? `linear-gradient(90deg, ${meta.bg}55 0%, #ffffff 40%)`
                        : '#fff',
                      border: `1px solid ${unread ? meta.border : '#EAEEF3'}`,
                      borderLeft: `3px solid ${unread ? meta.color : meta.color + '66'}`,
                      borderRadius: 12,
                      padding: '14px 16px',
                      cursor: 'pointer',
                      display: 'flex',
                      gap: 14,
                      alignItems: 'flex-start',
                      opacity: unread ? 1 : 0.9,
                    }}>
                    {/* Icon avatar */}
                    <div style={{
                      width: 40, height: 40, borderRadius: 11, flexShrink: 0,
                      background: meta.bg, color: meta.color,
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      border: `1px solid ${meta.border}`,
                      boxShadow: unread ? `0 2px 10px ${meta.color}22` : 'none',
                    }}>
                      {meta.icon}
                    </div>

                    {/* Content */}
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', alignItems: 'baseline' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                          <span style={{ fontSize: 14, fontWeight: unread ? 700 : 600, color: unread ? '#0F172A' : '#334155', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {notification.title}
                          </span>
                          {unread && <span style={{ width: 7, height: 7, borderRadius: '50%', background: meta.color, flexShrink: 0 }} />}
                        </div>
                        <div title={formatDateTime(notification.createdAt)} style={{ fontSize: 11.5, color: '#94A3B8', whiteSpace: 'nowrap', fontWeight: 600 }}>
                          {formatRelativeTime(notification.createdAt)}
                        </div>
                      </div>
                      <div style={{ fontSize: 13, color: '#64748B', marginTop: 4, lineHeight: 1.5 }}>
                        {notification.message}
                      </div>
                      {meta.cta && (
                        <div style={{ display: 'inline-flex', alignItems: 'center', gap: 4, marginTop: 8, fontSize: 11.5, fontWeight: 700, color: meta.color, letterSpacing: '.01em' }}>
                          {meta.cta}
                        </div>
                      )}
                    </div>

                    {/* Chevron (appears on hover via CSS) */}
                    <div className="ntf-chev" style={{ alignSelf: 'center', color: '#94A3B8', flexShrink: 0 }}>
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
                    </div>
                  </div>
                );
              })}
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

        {/* Rating scale legend — was on its own tab, now lives where it's used. */}
        <div style={{ marginBottom: 16, padding: '10px 14px', background: '#fff', borderRadius: 10, border: '1.5px solid #E9EDF2' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 11, fontWeight: 700, color: '#94A3B8', textTransform: 'uppercase', letterSpacing: '.06em', flexShrink: 0 }}>
              {config?.scalePoints || 5}-point scale
            </span>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', flex: 1 }}>
              {currentScale.map((step, index) => (
                <div key={step.n} title={step.l} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '3px 8px 3px 4px', borderRadius: 999, background: `${SCALE_COLORS[index]}10`, border: `1px solid ${SCALE_COLORS[index]}33` }}>
                  <span style={{ width: 18, height: 18, borderRadius: '50%', background: SCALE_COLORS[index], color: '#fff', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 10.5, fontWeight: 800 }}>{step.n}</span>
                  <span style={{ fontSize: 11.5, fontWeight: 600, color: '#334155' }}>{step.l}</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        {myGoals.map((goal) => {
          const color = getPerspectiveColor(goal, perspectives);
          const goalHasKpis = (goal.kpis || []).length > 0;
          const goalRatedAtKraLevel = effectiveConfig?.kpiRatingMode === 'free-text' || !goalHasKpis;
          return (
            <div key={goal.id} style={{ background: '#fff', border: '1.5px solid #E9EDF2', borderRadius: 12, marginBottom: 14, overflow: 'hidden' }}>
              <div style={{ padding: '13px 18px', borderLeft: `4px solid ${color}`, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                <div style={{ flex: 1, minWidth: 180 }}>
                  {goal.perspName && goal.perspName !== 'All KRAs' ? <div style={{ fontSize: 10.5, fontWeight: 700, color, textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 3 }}>{goal.perspName}</div> : null}
                  <div style={{ fontSize: 14, fontWeight: 700, color: '#0D1117' }}>{goal.name}</div>
                </div>
                <span style={{ fontSize: 12, fontWeight: 700, color, background: `${color}14`, padding: '3px 10px', borderRadius: 6 }}>Weight: {goal.weight}%</span>
                {goalRatedAtKraLevel ? (
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
                    <div style={{ fontSize: 11, color: '#9CA3AF', marginTop: 2 }}>
                      {effectiveConfig?.kpiRatingMode === 'free-text'
                        ? 'Reference KPI'
                        : `Weight: ${kpi.weight}%`}
                    </div>
                  </div>
                  {!goalRatedAtKraLevel ? (
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
                  ) : (
                    <div style={{ fontSize: 11.5, color: '#94A3B8', fontWeight: 600 }}>
                      Context only
                    </div>
                  )}
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
    const initials = employeeName.split(' ').map((w) => w[0]).filter(Boolean).slice(0, 2).join('').toUpperCase();
    return (
      <div>
        {/* Hero card */}
        <div style={{ background: 'linear-gradient(135deg,#7C3AED 0%,#EC4899 100%)', borderRadius: 16, padding: '36px 28px', marginBottom: 20, color: '#fff', textAlign: 'center' }}>
          <div style={{ width: 78, height: 78, borderRadius: '50%', background: 'rgba(255,255,255,0.22)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 30, fontWeight: 800, margin: '0 auto 14px', border: '3px solid rgba(255,255,255,0.4)' }}>
            {initials}
          </div>
          <div style={{ fontSize: 22, fontWeight: 800, marginBottom: 5 }}>{employeeName}</div>
          <div style={{ fontSize: 15, opacity: 0.88, marginBottom: 18 }}>{employeeDesignation || 'Employee'}</div>
          <button style={{ padding: '9px 22px', borderRadius: 20, border: '1.5px solid rgba(255,255,255,0.6)', background: 'transparent', color: '#fff', cursor: 'pointer', fontFamily: 'inherit', fontSize: 13.5, fontWeight: 600 }}>
            Edit Profile
          </button>
        </div>

        {/* Contact Information */}
        <div style={{ background: '#fff', border: '1px solid #E2E8F0', borderRadius: 14, padding: '22px 24px', marginBottom: 14 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: '#94A3B8', textTransform: 'uppercase', letterSpacing: '.07em', marginBottom: 16 }}>Contact Information</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 18 }}>
            {[
              { label: 'Employee Code', value: session.empCode },
              { label: 'Email', value: employee?.['Email ID'] || employee?.email || '—' },
              { label: 'Phone', value: employee?.Phone || employee?.['Phone Number'] || '—' },
              { label: 'Location', value: employee?.Location || employee?.City || '—' },
            ].map(({ label, value }) => (
              <div key={label}>
                <div style={{ fontSize: 12, fontWeight: 600, color: '#94A3B8', textTransform: 'uppercase', letterSpacing: '.05em', marginBottom: 5 }}>{label}</div>
                <div style={{ fontSize: 14.5, fontWeight: 500, color: '#0D1117' }}>{value}</div>
              </div>
            ))}
          </div>
        </div>

        {/* Professional Details */}
        <div style={{ background: '#fff', border: '1px solid #E2E8F0', borderRadius: 14, padding: '22px 24px', marginBottom: 14 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: '#94A3B8', textTransform: 'uppercase', letterSpacing: '.07em', marginBottom: 16 }}>Professional Details</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 18 }}>
            {[
              { label: 'Designation / Role', value: employeeDesignation || '—' },
              { label: 'Department', value: employee?.Department || '—' },
              { label: employeeGroup?.segmentAttr || 'Role', value: (employeeGroup?.segmentAttr ? (employee?.[employeeGroup.segmentAttr] || '—') : (employeeDesignation || '—')) },
              { label: 'Reporting Manager', value: managerName || '—' },
              { label: 'Framework', value: config?.frameworkId?.toUpperCase() || '—' },
            ].map(({ label, value }) => (
              <div key={label}>
                <div style={{ fontSize: 12, fontWeight: 600, color: '#94A3B8', textTransform: 'uppercase', letterSpacing: '.05em', marginBottom: 5 }}>{label}</div>
                <div style={{ fontSize: 14.5, fontWeight: 500, color: '#0D1117' }}>{value}</div>
              </div>
            ))}
          </div>
        </div>

        {/* Cycle Status */}
        <div style={{ background: '#fff', border: '1px solid #E2E8F0', borderRadius: 14, padding: '22px 24px' }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: '#94A3B8', textTransform: 'uppercase', letterSpacing: '.07em', marginBottom: 16 }}>Current Cycle Status</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {PHASES.map((phase, index) => {
              const isDone = index < phaseIndex;
              const isActive = index === phaseIndex;
              return (
                <div key={phase.id} style={{
                  padding: '8px 16px', borderRadius: 20, fontSize: 13, fontWeight: 600,
                  background: isActive ? '#EFF6FF' : isDone ? '#F0FDF4' : '#F8FAFC',
                  color: isActive ? '#2563EB' : isDone ? '#16A34A' : '#94A3B8',
                  border: `1px solid ${isActive ? '#BFDBFE' : isDone ? '#BBF7D0' : '#E2E8F0'}`,
                }}>
                  {isDone ? '✓ ' : isActive ? '▶ ' : ''}{phase.label}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    );
  }

  // ── Hero ─────────────────────────────────────────────────────────────────────
  // Always rendered at the top of the page. Left zone is constant (greeting + role line).
  // Right zone swaps its content based on which tab is active.
  function renderHero(section) {
    const progressTone = goalMetrics.invalid ? '#FCA5A5' : '#FFFFFF';
    const progressFill = goalMetrics.invalid
      ? 'linear-gradient(90deg,#F87171,#FCA5A5)'
      : accentFill;

    const teamSubmitted = Object.values(workflow?.submissions || {}).filter((s) => normalizeCode(s.managerCode) === employeeCodeKey && s.status === 'pending-manager').length;
    const teamApproved = Object.values(workflow?.submissions || {}).filter((s) => normalizeCode(s.managerCode) === employeeCodeKey && s.status === 'approved').length;
    const teamTotal = directReports.length;
    const teamDone = teamSubmitted + teamApproved;
    const teamPct = teamTotal > 0 ? Math.round((teamDone / teamTotal) * 100) : 0;

    // Latest message for Messages-tab hero
    let latestMsg = null;
    try {
      const conversations = messagesData?.conversations || {};
      for (const k of Object.keys(conversations)) {
        for (const m of (conversations[k]?.messages || [])) {
          if (m.from === employeeCodeKey) continue;
          if (!latestMsg || new Date(m.sentAt || m.createdAt || 0) > new Date(latestMsg.sentAt || latestMsg.createdAt || 0)) {
            const otherCode = k.replace(employeeCodeKey, '').replace('::', '');
            const contact = messageContacts.find((c) => normalizeCode(c.code) === normalizeCode(otherCode));
            latestMsg = { ...m, from: m.from, senderName: contact?.name || m.from };
          }
        }
      }
    } catch (_) { /* noop */ }

    // Fixed minHeight stops the hero from resizing as the right-panel content changes between tabs.
    // Keep this as plain hero content, not a glass/card surface, so brand hero choices read cleanly.
    const panelBoxStyle = {
      flex: '1.8 1 360px', minWidth: 0,
      minHeight: 86,
      padding: '4px 0',
      color: '#fff',
    };

    let rightPanel = null;
    if (section === 'goals' && !isExternalManager) {
      if (currentPhase === 'self-evaluation') {
        const pct = selfEvalPct;
        const tone = '#FFFFFF';
        const fill = accentFill;
        rightPanel = (
          <div style={panelBoxStyle}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 14, alignItems: 'center', marginBottom: 14 }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 15, fontWeight: 800, color: '#fff' }}>Self-rating progress</div>
                <div style={{ fontSize: 12.5, color: 'rgba(255,255,255,0.72)', marginTop: 4 }}>{totalRated} of {totalRatable} rated</div>
              </div>
              <div style={{ fontSize: 28, fontWeight: 800, lineHeight: 1, color: tone, textShadow: '0 2px 14px rgba(15,23,42,0.22)' }}>{pct}%</div>
            </div>
            <div style={{ height: 9, background: 'rgba(255,255,255,0.24)', borderRadius: 999, overflow: 'hidden', boxShadow: 'inset 0 1px 3px rgba(15,23,42,0.22)' }}>
              <div style={{ height: '100%', width: `${pct}%`, background: fill, borderRadius: 999, transition: 'width .25s ease', boxShadow: `0 0 18px ${tone}` }} />
            </div>
          </div>
        );
      } else {
        rightPanel = (
          <div style={panelBoxStyle}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 14, alignItems: 'center', marginBottom: 14 }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 15, fontWeight: 800, color: '#fff' }}>Goal plan completion</div>
                <div style={{ fontSize: 12.5, color: 'rgba(255,255,255,0.72)', marginTop: 4 }}>
                  Goal weights <span style={{ color: goalMetrics.goalOver ? '#FCA5A5' : 'rgba(255,255,255,0.92)', fontWeight: goalMetrics.goalOver ? 800 : 600 }}>{goalMetrics.goalPct}%</span>
                  {goalMetrics.shouldTrackKpis ? <> · KPI <span style={{ color: goalMetrics.kpiOver ? '#FCA5A5' : 'rgba(255,255,255,0.92)', fontWeight: goalMetrics.kpiOver ? 800 : 600 }}>{goalMetrics.kpiPct}%</span></> : ''}
                </div>
              </div>
              <div style={{ fontSize: 28, fontWeight: 800, lineHeight: 1, color: progressTone, textShadow: '0 2px 14px rgba(15,23,42,0.22)' }}>
                {goalMetrics.goalOver ? `${goalMetrics.goalPct}%` : `${goalMetrics.overall}%`}
              </div>
            </div>
            <div style={{ height: 9, background: 'rgba(255,255,255,0.24)', borderRadius: 999, overflow: 'hidden', boxShadow: 'inset 0 1px 3px rgba(15,23,42,0.22)' }}>
              <div style={{ height: '100%', width: `${Math.min(100, goalMetrics.overall)}%`, background: progressFill, borderRadius: 999, transition: 'width .25s ease', boxShadow: `0 0 18px ${progressTone}` }} />
            </div>
          </div>
        );
      }
    } else if (section === 'team' && directReports.length > 0) {
      rightPanel = (
        <div style={panelBoxStyle}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 14, alignItems: 'center', marginBottom: 14 }}>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 15, fontWeight: 800, color: '#fff' }}>Team submission status</div>
              <div style={{ fontSize: 12.5, color: 'rgba(255,255,255,0.78)', marginTop: 4 }}>
                <span style={{ color: '#FCA5A5', fontWeight: 700 }}>{teamSubmitted}</span> pending review · <span style={{ color: '#86EFAC', fontWeight: 700 }}>{teamApproved}</span> approved · <span style={{ fontWeight: 700 }}>{Math.max(0, teamTotal - teamDone)}</span> awaiting submit
              </div>
            </div>
            <div style={{ fontSize: 28, fontWeight: 800, lineHeight: 1, color: '#FFFFFF', textShadow: '0 2px 14px rgba(15,23,42,0.22)' }}>{teamPct}%</div>
          </div>
          <div style={{ height: 9, background: 'rgba(255,255,255,0.24)', borderRadius: 999, overflow: 'hidden', boxShadow: 'inset 0 1px 3px rgba(15,23,42,0.22)' }}>
            <div style={{ height: '100%', width: `${teamPct}%`, background: accentFill, borderRadius: 999, transition: 'width .25s ease' }} />
          </div>
        </div>
      );
    } else if (section === 'messages') {
      rightPanel = (
        <div style={panelBoxStyle}>
          <div style={{ fontSize: 15, fontWeight: 800, color: '#fff', marginBottom: 10 }}>Latest message</div>
          {latestMsg ? (
            <div>
              <div style={{ fontSize: 13, fontWeight: 700, color: '#fff' }}>{latestMsg.senderName}</div>
              <div style={{ fontSize: 12.5, color: 'rgba(255,255,255,0.82)', marginTop: 4, overflow: 'hidden', textOverflow: 'ellipsis', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}>
                {latestMsg.text || latestMsg.body || '—'}
              </div>
              {latestMsg.sentAt && <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.66)', marginTop: 6 }}>{formatDateTime(latestMsg.sentAt)}</div>}
            </div>
          ) : (
            <div style={{ fontSize: 13, color: 'rgba(255,255,255,0.78)' }}>No messages yet.</div>
          )}
        </div>
      );
    } else if (section === 'profile') {
      const phaseLabel = PHASES[phaseIndex]?.label || currentPhase;
      rightPanel = (
        <div style={panelBoxStyle}>
          <div style={{ fontSize: 15, fontWeight: 800, color: '#fff', marginBottom: 12 }}>At a glance</div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {employeeDesignation && (
              <span style={{ padding: '6px 12px', borderRadius: 999, background: 'rgba(255,255,255,0.18)', border: '1px solid rgba(255,255,255,0.32)', fontSize: 12, fontWeight: 700 }}>{employeeDesignation}</span>
            )}
            {managerName && (
              <span style={{ padding: '6px 12px', borderRadius: 999, background: 'rgba(255,255,255,0.18)', border: '1px solid rgba(255,255,255,0.32)', fontSize: 12, fontWeight: 700 }}>Reports to: {managerName}</span>
            )}
            {phaseLabel && (
              <span style={{ padding: '6px 12px', borderRadius: 999, background: 'rgba(255,255,255,0.18)', border: '1px solid rgba(255,255,255,0.32)', fontSize: 12, fontWeight: 700 }}>Cycle: {phaseLabel}</span>
            )}
          </div>
        </div>
      );
    }

    // On the Messages tab, clicking the hero collapses the open thread (like iMessage peek-close).
    const heroClosesThread = section === 'messages' && !!activeConversation;
    const isImageHero = heroResolved?.mode === 'image';
    return (
      <div
        onClick={heroClosesThread ? () => setActiveConversation(null) : undefined}
        title={heroClosesThread ? 'Click to close the open conversation' : undefined}
        style={{
        position: 'relative',
        isolation: 'isolate',
        overflow: 'hidden',
        ...heroBackgroundStyle,
        borderRadius: 8, padding: '28px 30px', marginBottom: 18, color: '#fff',
        border: '1px solid rgba(255,255,255,0.28)',
        boxShadow: '0 18px 48px rgba(15,23,42,.18)',
        display: 'flex', flexWrap: 'wrap', gap: 22, alignItems: 'center',
        cursor: heroClosesThread ? 'pointer' : 'default',
      }}>
        {!isImageHero && (
          <div style={{
            position: 'absolute',
            inset: 0,
            background: 'linear-gradient(180deg,rgba(255,255,255,0.18),rgba(255,255,255,0.04) 44%,rgba(15,23,42,0.05))',
            pointerEvents: 'none',
            zIndex: -1,
          }} />
        )}
        <div style={{ flex: '1 1 240px', minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ fontSize: 24, fontWeight: 800, whiteSpace: 'nowrap', textShadow: '0 2px 12px rgba(15,23,42,0.18)' }}>Hi, {employeeName.split(' ')[0]}</span>
            <span style={{ fontSize: 20 }}>👋</span>
          </div>
          <div style={{ fontSize: 15, marginTop: 10, color: 'rgba(255,255,255,0.92)' }}>
            {isExternalManager
              ? `You manage ${directReports.length} team member${directReports.length !== 1 ? 's' : ''} on this cycle.`
              : (myGoals.length > 0
                ? `You have ${myGoals.length} active goal${myGoals.length !== 1 ? 's' : ''} this cycle.`
                : 'Start setting your goals for this cycle.')}
            {!isExternalManager && totalGoalsWithIssues > 0 && <span style={{ marginLeft: 8, fontWeight: 700, background: 'rgba(220,38,38,0.92)', padding: '2px 9px', borderRadius: 999, fontSize: 11.5 }}>{totalGoalsWithIssues} need attention</span>}
          </div>
          {!isExternalManager && (
            <div style={{ fontSize: 13, color: 'rgba(255,255,255,0.76)', display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 12 }}>
              {employeeDesignation && <span>{employeeDesignation}</span>}
              {managerName && <span>· Reports to: {managerName}</span>}
            </div>
          )}
        </div>

        {rightPanel}
      </div>
    );
  }

  // ── Top-level tabs (replace the old sidebar nav) ─────────────────────────────
  const tabs = [];
  if (!isExternalManager) {
    tabs.push({
      id: 'goals',
      label: currentPhase === 'self-evaluation' ? 'Self-Eval' : 'My Goals',
      count: currentPhase === 'self-evaluation' ? totalRatable : myGoals.length,
    });
  }
	  if (directReports.length > 0) {
	    tabs.push({
	      id: 'team',
	      label: 'My Team Goals',
	      count: directReports.length,
	    });
  }
  tabs.push({
    id: 'messages',
    label: 'Messages',
    badge: unreadMsgCount > 0 ? { text: unreadMsgCount, tone: 'info' } : null,
  });

  // Primary CTA per tab — rendered on the right side of the tab row.
  const reminderPool = directReports.filter((r) => {
    const sub = workflow?.submissions?.[normalizeCode(r['Employee Code'])];
    const canRemind = !sub || sub.status === 'draft' || sub.status === 'sent-back';
    return canRemind && !getReminderState(r['Employee Code']).blocked;
  });
  const tabCTA = (() => {
    if (activeSection === 'goals' && canAddKra) {
      return { label: '+ Create Goal', onClick: addGoalAndEdit, primary: true };
    }
    if (activeSection === 'team' && reminderPool.length > 0) {
      return { label: `Send reminder to all (${reminderPool.length})`, onClick: () => reminderPool.forEach((r) => sendReminder(r)), primary: true };
    }
    return null;
  })();

  const impersonatedFromAdmin = !!session?._impersonatedFromAdmin;
  const dualRoleFromHR = !!session?._dualRoleFromHR;
  function backToAdmin() {
    try { localStorage.removeItem(EMP_SESSION_KEY); } catch (_) {}
    window.location.hash = '#hr-home';
  }

  // Confirmation-modal handlers. 3-step guard-rail:
  //   1. Manager clicks Reject all / Approve all / Submit decision.
  //   2. Modal opens in stage='confirm' with a plain "are you sure?" question.
  //   3. Manager acknowledges → stage flips to 'review' with summary + Revert/Proceed.
  // Revert closes the modal. Proceed awaits the real commit before closing (sync today,
  // async-ready for when this goes to the cloud).
  function revertReviewConfirm() {
    if (reviewConfirm?.loading) return;
    setReviewConfirm(null);
  }
  function advanceReviewConfirm() {
    if (!reviewConfirm || reviewConfirm.loading) return;
    setReviewConfirm((s) => (s ? { ...s, stage: 'review' } : s));
  }
  async function proceedReviewConfirm() {
    if (!reviewConfirm || reviewConfirm.loading) return;
    setReviewConfirm((s) => (s ? { ...s, loading: true } : s));
    try {
      await Promise.resolve(reviewSubmission(reviewConfirm.employeeCode, reviewConfirm.action));
    } catch (_) { /* commit failures fall through; modal still closes */ }
    setReviewConfirm(null);
  }
  // ESC closes the modal (acts as Revert) when not mid-commit.
  useEffect(() => {
    if (!reviewConfirm) return undefined;
    function onKey(e) { if (e.key === 'Escape') revertReviewConfirm(); }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reviewConfirm]);

  return (
    <div style={{ height: '100vh', overflow: 'hidden', display: 'flex', flexDirection: 'column', background: '#F0F4F8', fontFamily: "'Geist','Inter','Segoe UI',Arial,sans-serif", fontSize: 15, color: '#0D1117' }}>

      {(impersonatedFromAdmin || dualRoleFromHR) && <BackToAdminButton onClick={backToAdmin} />}
      {(impersonatedFromAdmin || dualRoleFromHR) && (
        <div style={{
          margin: '14px 24px 0',
          border: '1px solid #C7D2FE',
          background: '#EEF2FF',
          color: '#312E81',
          borderRadius: 12,
          padding: '12px 16px',
          fontSize: 13,
          lineHeight: 1.5,
          flexShrink: 0,
        }}>
          {impersonatedFromAdmin
            ? 'Admin proxy mode is active. Any edits or submissions on this page will be saved against this employee record.'
            : 'HR dual-role mode is active. Changes here behave exactly like the employee experience for this record.'}
        </div>
      )}

      {reviewConfirm && createPortal(
        <ReviewConfirmModal
          state={reviewConfirm}
          onRevert={revertReviewConfirm}
          onAdvance={advanceReviewConfirm}
          onProceed={proceedReviewConfirm}
        />,
        document.body
      )}

      {/* ── Top bar ── */}
      <div style={{ height: 64, background: '#fff', borderBottom: '1px solid #E2E8F0', display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 28px', flexShrink: 0, zIndex: 100 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          {orgBrand.brandLogo ? (
            <img src={orgBrand.brandLogo} alt={orgBrand.brandName || 'Brand logo'} style={{ height: 40, maxWidth: 180, width: 'auto', borderRadius: 9, objectFit: 'contain', display: 'block' }} />
          ) : (
            <>
              <img src={zaroLogo} alt="Zaro HR" style={{ width: 34, height: 34, borderRadius: 9, objectFit: 'cover' }} />
              <span style={{ fontSize: 18, fontWeight: 800, color: '#0F172A' }}>
                Performance <span style={{ color: '#2563EB' }}>Hub</span>
              </span>
            </>
          )}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          <button
            type="button"
            onClick={() => setActiveSection('profile')}
            title="My profile"
            aria-label="Open my profile"
            aria-current={activeSection === 'profile' ? 'page' : undefined}
            style={{
              display: 'flex', alignItems: 'center', gap: 12,
              background: activeSection === 'profile' ? '#EFF6FF' : 'transparent',
              border: activeSection === 'profile' ? '1.5px solid #BFDBFE' : '1.5px solid transparent',
              borderRadius: 12, padding: '4px 8px 4px 12px', cursor: 'pointer', fontFamily: 'inherit',
              transition: 'background 160ms ease, border-color 160ms ease',
            }}
            onMouseEnter={(e) => { if (activeSection !== 'profile') e.currentTarget.style.background = '#F8FAFC'; }}
            onMouseLeave={(e) => { if (activeSection !== 'profile') e.currentTarget.style.background = 'transparent'; }}
          >
            <div style={{ textAlign: 'right' }}>
              <div style={{ fontSize: 14, fontWeight: 700, color: '#0F172A' }}>{employeeName}</div>
              <div style={{ fontSize: 12.5, color: '#64748B' }}>{employeeDesignation || session.empCode}</div>
            </div>
            <div style={{
              width: 40, height: 40, borderRadius: '50%',
              background: 'linear-gradient(135deg,#2563EB,#7C3AED)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              color: '#fff', fontSize: 15, fontWeight: 800, flexShrink: 0,
              boxShadow: activeSection === 'profile' ? '0 0 0 3px #fff, 0 0 0 5px #2563EB' : 'none',
              transition: 'box-shadow 160ms ease',
            }}>
              {employeeName.charAt(0).toUpperCase()}
            </div>
          </button>

          {/* Notifications bell + dropdown */}
          <div ref={notifDropdownRef} style={{ position: 'relative' }}>
            <button
              type="button"
              onClick={() => setNotifDropdownOpen((v) => !v)}
              aria-label="Notifications"
              style={{
                position: 'relative', width: 40, height: 40, borderRadius: 10,
                border: '1.5px solid #E2E8F0', background: notifDropdownOpen ? '#EFF6FF' : '#fff',
                color: notifDropdownOpen ? '#2563EB' : '#475569', cursor: 'pointer',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontFamily: 'inherit', transition: 'all 160ms ease',
              }}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/>
                <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>
              </svg>
              {unreadNotificationCount > 0 && (
                <span style={{
                  position: 'absolute', top: -4, right: -4, minWidth: 18, height: 18,
                  padding: '0 5px', borderRadius: 999, background: '#DC2626', color: '#fff',
                  fontSize: 10.5, fontWeight: 800, display: 'flex', alignItems: 'center', justifyContent: 'center',
                  border: '2px solid #fff', lineHeight: 1,
                }}>
                  {unreadNotificationCount > 99 ? '99+' : unreadNotificationCount}
                </span>
              )}
            </button>

            {notifDropdownOpen && (
              <div style={{
                position: 'absolute', top: 'calc(100% + 10px)', right: 0,
                width: 360, maxHeight: '70vh', overflowY: 'auto',
                background: '#fff', border: '1px solid #E2E8F0', borderRadius: 12,
                boxShadow: '0 12px 40px rgba(15,23,42,.14)', zIndex: 200,
              }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, padding: '14px 16px', borderBottom: '1px solid #F1F5F9', position: 'sticky', top: 0, background: '#fff', zIndex: 1 }}>
                  <div style={{ fontSize: 14, fontWeight: 700, color: '#0F172A' }}>Notifications</div>
                  {notifications.some((n) => !n.read) && (
                    <button
                      type="button"
                      onClick={() => {
                        const ids = notifications.filter((n) => !n.read).map((n) => n.id);
                        if (ids.length) markNotificationsRead(ids);
                      }}
                      style={{ padding: '4px 10px', border: '1px solid #E2E8F0', background: '#fff', borderRadius: 999, color: '#475569', cursor: 'pointer', fontFamily: 'inherit', fontSize: 11.5, fontWeight: 700 }}
                    >
                      Mark all read
                    </button>
                  )}
                </div>
                {notifications.length === 0 ? (
                  <div style={{ padding: '28px 20px', textAlign: 'center', color: '#94A3B8', fontSize: 13 }}>
                    No notifications yet.
                  </div>
                ) : (
                  <div>
                    {notifications.map((n, i) => {
                      const unread = !n.read;
                      const meta = n.type === 'goal-submitted' ? { color: '#DC2626', bg: '#FEF2F2' }
                        : n.type === 'goal-approved' ? { color: '#16A34A', bg: '#F0FDF4' }
                        : n.type === 'goal-rejected' ? { color: '#D97706', bg: '#FFF7ED' }
                        : { color: '#2563EB', bg: '#EFF6FF' };
                      return (
                        <div
                          key={n.id}
                          onClick={() => { handleNotificationClick(n); setNotifDropdownOpen(false); }}
                          style={{
                            padding: '12px 16px', cursor: 'pointer',
                            borderTop: i === 0 ? 'none' : '1px solid #F1F5F9',
                            display: 'flex', alignItems: 'flex-start', gap: 10,
                            background: unread ? '#F8FAFF' : '#fff',
                            transition: 'background 120ms ease',
                          }}
                          onMouseEnter={(e) => { e.currentTarget.style.background = '#F1F5F9'; }}
                          onMouseLeave={(e) => { e.currentTarget.style.background = unread ? '#F8FAFF' : '#fff'; }}
                        >
                          <span style={{ width: 8, height: 8, borderRadius: '50%', background: unread ? meta.color : 'transparent', flexShrink: 0, marginTop: 6 }} />
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ fontSize: 13, fontWeight: unread ? 700 : 500, color: '#0F172A', lineHeight: 1.35 }}>{n.title}</div>
                            <div style={{ fontSize: 12, color: '#64748B', marginTop: 3, lineHeight: 1.4 }}>{n.message}</div>
                            <div style={{ fontSize: 10.5, color: '#94A3B8', marginTop: 4 }}>{formatDateTime(n.createdAt)}</div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
          </div>

          <button onClick={logout} style={{ padding: '7px 15px', border: '1.5px solid #E2E8F0', borderRadius: 8, fontSize: 13, cursor: 'pointer', background: '#fff', color: '#6B7280', fontFamily: 'inherit' }}>
            Sign out
          </button>
        </div>
      </div>

      {/* ── Body ── */}
      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
        {/* ── Main content (full width — sidebar replaced by inline tab row) ── */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '28px 32px 72px' }}>

          {renderHero(activeSection)}

          {/* ── Tab row + contextual CTA ── */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 18, flexWrap: 'wrap' }}>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', overflowX: 'auto' }}>
              {tabs.map((t) => {
                const active = activeSection === t.id;
                return (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => setActiveSection(t.id)}
                    aria-current={active ? 'page' : undefined}
                    style={{
                      display: 'inline-flex', alignItems: 'center', gap: 8,
                      padding: '9px 16px', borderRadius: 999,
                      border: `1.5px solid ${active ? brandPalette.primary : '#E2E8F0'}`,
                      background: active ? brandPalette.primary : '#fff',
                      color: active ? '#fff' : '#475569',
                      cursor: 'pointer', fontFamily: 'inherit', fontSize: 13.5, fontWeight: 700,
                      transition: 'all 160ms ease', whiteSpace: 'nowrap',
                    }}
                  >
                    <span>{t.label}</span>
                    {typeof t.count === 'number' && (
                      <span style={{
                        padding: '1px 8px', borderRadius: 999, fontSize: 11.5, fontWeight: 800,
                        background: active ? 'rgba(255,255,255,.22)' : '#F1F5F9',
                        color: active ? '#fff' : '#475569',
                      }}>{t.count}</span>
                    )}
                    {t.badge && (
                      <span style={{
                        padding: '1px 8px', borderRadius: 999, fontSize: 11.5, fontWeight: 800,
                        background: t.badge.tone === 'alert' ? '#DC2626' : '#2563EB',
                        color: '#fff',
                      }}>{t.badge.text}</span>
                    )}
                  </button>
                );
              })}
            </div>

            {tabCTA && (
              <button
                type="button"
                onClick={tabCTA.onClick}
                style={{
                  padding: '10px 18px', borderRadius: 9, border: 'none',
                  background: tabCTA.primary ? brandPalette.primary : '#fff',
                  color: tabCTA.primary ? '#fff' : '#475569',
                  cursor: 'pointer', fontFamily: 'inherit', fontSize: 14, fontWeight: 700,
                  boxShadow: tabCTA.primary ? `0 4px 12px ${brandPalette.primary}38` : 'none',
                  whiteSpace: 'nowrap',
                }}
              >
                {tabCTA.label}
              </button>
            )}
          </div>

          {/* ── Section content ── */}
          {activeSection === 'goals' && (
            currentPhase === 'goal-setting' ? renderGoalSetting()
              : currentPhase === 'self-evaluation' ? renderSelfEvaluation()
              : <EmptyState title={`${PHASES[phaseIndex]?.label || 'Current phase'} in progress`} subtitle="This page will unlock the relevant workflow for the active appraisal phase." />
          )}
          {activeSection === 'team' && renderTeam()}
          {activeSection === 'messages' && renderMessages()}
          {activeSection === 'profile' && renderProfile()}
        </div>
      </div>
    </div>
  );
}
