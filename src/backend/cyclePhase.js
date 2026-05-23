// Cycle phase resolver — single source of truth for "what phase is the org in
// right now?". The calendar IS the truth: we compute the current sub-phase
// from the stored windows + the current time, instead of persisting a
// `current_phase` flag that can drift.
//
// Windows are stored on `pms_configs.payload.cyclePhaseWindows`:
//
//   {
//     goalSetting: {
//       startsOn: 'YYYY-MM-DD', endsOn: 'YYYY-MM-DD',
//       subPhases: {
//         goalCreation:    { startsOn, endsOn },
//         managerApproval: { startsOn, endsOn },
//       }
//     },
//     evaluation: {
//       startsOn, endsOn,
//       subPhases: {
//         selfEvaluation:    { startsOn, endsOn },
//         managerEvaluation: { startsOn, endsOn },
//       }
//     }
//   }
//
// All boundaries are inclusive on the start date and exclusive on the day
// AFTER `endsOn` — i.e. a window `2026-04-01 .. 2026-04-30` covers any
// instant from 00:00:00 on April 1 to 23:59:59.999 on April 30 (org-local
// noon UTC anchor; see `parseDate`).

export const SUB_PHASE = Object.freeze({
  PRE_CYCLE: 'pre-cycle',
  GOAL_CREATION: 'goal-creation',
  MANAGER_APPROVAL: 'manager-approval',
  BETWEEN: 'between',
  SELF_EVALUATION: 'self-evaluation',
  MANAGER_EVALUATION: 'manager-evaluation',
  POST_CYCLE: 'post-cycle',
});

export const PHASE_KIND = Object.freeze({
  GOAL_SETTING: 'goalSetting',
  EVALUATION: 'evaluation',
});

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Anchor every date at 12:00 UTC so a date like '2026-04-01' represents the
// whole calendar day regardless of the user's timezone — avoids the classic
// "phase flipped a day early in IST" off-by-one.
function parseDate(value) {
  if (!value) return null;
  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? value : null;
  }
  const str = String(value);
  if (!ISO_DATE_RE.test(str)) {
    const parsed = new Date(str);
    return Number.isFinite(parsed.getTime()) ? parsed : null;
  }
  const [y, m, d] = str.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d, 12, 0, 0, 0));
  return Number.isFinite(date.getTime()) ? date : null;
}

function endOfDay(value) {
  const d = parseDate(value);
  if (!d) return null;
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 23, 59, 59, 999));
}

function startOfDay(value) {
  const d = parseDate(value);
  if (!d) return null;
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0, 0));
}

export function readCycleWindows(org) {
  if (!org || typeof org !== 'object') return null;
  const direct = org.cyclePhaseWindows;
  if (direct && typeof direct === 'object') return direct;
  const setup = org.setup_payload || org.setupPayload || null;
  const fromSetup = setup && typeof setup === 'object' ? setup.cyclePhaseWindows : null;
  if (fromSetup && typeof fromSetup === 'object') return fromSetup;
  const pmsCfg = org.pms_config || org.pmsConfig || null;
  const payload = pmsCfg && typeof pmsCfg === 'object' ? (pmsCfg.payload || pmsCfg) : null;
  if (payload && typeof payload === 'object' && payload.cyclePhaseWindows) return payload.cyclePhaseWindows;
  return null;
}

function isInWindow(window, now) {
  if (!window) return false;
  const start = startOfDay(window.startsOn);
  const end = endOfDay(window.endsOn);
  if (!start || !end) return false;
  if (end < start) return false;
  return now >= start && now <= end;
}

function safeWindow(value) {
  if (!value || typeof value !== 'object') return null;
  const start = parseDate(value.startsOn);
  const end = parseDate(value.endsOn);
  if (!start || !end) return null;
  return value;
}

// Validate a windows blob. Returns { ok: boolean, errors: string[] }.
// Used by the PhaseSettingsEditor to block save when ranges are illegal.
export function validateCycleWindows(windows) {
  const errors = [];
  if (!windows || typeof windows !== 'object') {
    errors.push('Cycle windows are missing.');
    return { ok: false, errors };
  }
  const phases = [
    { key: PHASE_KIND.GOAL_SETTING, label: 'Goal-setting phase', subKeys: ['goalCreation', 'managerApproval'], subLabels: { goalCreation: 'Goal creation', managerApproval: 'Manager approval' } },
    { key: PHASE_KIND.EVALUATION, label: 'Evaluation phase', subKeys: ['selfEvaluation', 'managerEvaluation'], subLabels: { selfEvaluation: 'Self evaluation', managerEvaluation: 'Manager evaluation' } },
  ];

  for (const phase of phases) {
    const win = windows[phase.key];
    if (!win) { errors.push(`${phase.label}: dates are required.`); continue; }
    const start = parseDate(win.startsOn);
    const end = parseDate(win.endsOn);
    if (!start || !end) {
      errors.push(`${phase.label}: both start and end dates are required.`);
      continue;
    }
    if (end < start) {
      errors.push(`${phase.label}: end date must be on or after start date.`);
      continue;
    }
    const subs = win.subPhases || {};
    for (const subKey of phase.subKeys) {
      const sub = subs[subKey];
      const subLabel = phase.subLabels[subKey];
      if (!sub) { errors.push(`${phase.label} > ${subLabel}: dates are required.`); continue; }
      const subStart = parseDate(sub.startsOn);
      const subEnd = parseDate(sub.endsOn);
      if (!subStart || !subEnd) { errors.push(`${phase.label} > ${subLabel}: both start and end dates are required.`); continue; }
      if (subEnd < subStart) { errors.push(`${phase.label} > ${subLabel}: end must be on or after start.`); continue; }
      if (subStart < start || subEnd > end) {
        errors.push(`${phase.label} > ${subLabel}: must lie within the parent phase window.`);
      }
    }
    // Sub-phase OVERLAP is intentionally allowed — e.g. once an employee's
    // goal is rejected by the manager they re-enter goal-creation while
    // others are still being approved. Both surfaces light up concurrently
    // for the employees in their respective state.
  }

  // Goal-setting overlapping with Evaluation is allowed (degraded to a
  // warning in `reviewCycleWindows`). Some orgs run staggered evaluations
  // for late joiners while others are still wrapping up goal-setting.

  return { ok: errors.length === 0, errors };
}

// Pre-save sanity notices — non-blocking. Surface to the editor as a hint
// strip so HR can confirm the choice rather than be silently surprised.
export function reviewCycleWindows(windows, now) {
  const warnings = [];
  if (!windows) return { warnings };
  const t = asNow(now);
  const today = startOfDay(t.toISOString().slice(0, 10));

  const goalStart = parseDate(windows.goalSetting?.startsOn);
  const goalEnd   = parseDate(windows.goalSetting?.endsOn);
  const evalStart = parseDate(windows.evaluation?.startsOn);
  const evalEnd   = parseDate(windows.evaluation?.endsOn);

  if (goalStart && today && goalStart < today && goalEnd && goalEnd >= today) {
    warnings.push('Goal-setting window is already open.');
  }
  if (goalEnd && today && goalEnd < today) {
    warnings.push('Goal-setting window has already closed.');
  }
  if (evalStart && today && evalStart < today && evalEnd && evalEnd >= today) {
    warnings.push('Evaluation window is already open.');
  }
  if (evalEnd && today && evalEnd < today) {
    warnings.push('Evaluation window has already closed.');
  }
  if (goalEnd && evalStart && evalStart < goalEnd) {
    warnings.push('Evaluation begins while goal-setting is still open — phases will run in parallel.');
  }
  if (goalEnd && evalStart) {
    const gapDays = Math.round((evalStart.getTime() - goalEnd.getTime()) / (24 * 60 * 60 * 1000));
    if (gapDays > 365) warnings.push('Evaluation is more than a year after goal-setting ends — confirm the year.');
  }
  if (goalStart && goalEnd) {
    const dur = Math.round((goalEnd.getTime() - goalStart.getTime()) / (24 * 60 * 60 * 1000));
    if (dur <= 1) warnings.push('Goal-setting window spans one day or less.');
  }
  if (evalStart && evalEnd) {
    const dur = Math.round((evalEnd.getTime() - evalStart.getTime()) / (24 * 60 * 60 * 1000));
    if (dur <= 1) warnings.push('Evaluation window spans one day or less.');
  }
  return { warnings };
}

// Find per-employee overrides that no longer line up with the new global
// windows (e.g. an extension was granted to 2026-05-15, but HR just moved
// the evaluation start earlier than that). HR sees a toast offering to
// clear them in bulk.
export function findStrandedOverrides(employees, windows, now) {
  const stranded = [];
  if (!Array.isArray(employees) || !windows) return stranded;
  const t = asNow(now);
  const evalStart = startOfDay(windows.evaluation?.startsOn);
  for (const emp of employees) {
    const ov = emp?.cycleOverrides || emp?.cycle_overrides;
    if (!ov || ov.noGoalCycle) continue;
    const extEnd = endOfDay(ov.goalCreationEndsOn);
    if (!extEnd) continue;
    if (evalStart && extEnd >= evalStart) {
      stranded.push({
        empCode: String(emp['Employee Code'] || emp.empCode || '').trim(),
        name: String(emp['Employee Name'] || emp.name || '').trim(),
        goalCreationEndsOn: ov.goalCreationEndsOn,
        reason: 'extension-extends-into-evaluation',
      });
      continue;
    }
    if (extEnd < t) {
      stranded.push({
        empCode: String(emp['Employee Code'] || emp.empCode || '').trim(),
        name: String(emp['Employee Name'] || emp.name || '').trim(),
        goalCreationEndsOn: ov.goalCreationEndsOn,
        reason: 'extension-expired',
      });
    }
  }
  return stranded;
}

// Resolve the absolute fiscal-year date range from the org's pmsCalendar
// choice. April-March / January-December map to the upcoming year using the
// current date; Custom uses the explicit dates. Used by both CreateOrgPage
// (Super Admin wizard) and HRCycleDashboard so the Cycle Calendar editor
// surfaces the same axis on both sides.
export function resolveOrgFiscalRange(org) {
  if (!org || typeof org !== 'object') return { startsOn: '', endsOn: '' };
  const choice = String(org.pmsCalendar || '').trim();
  const customStart = String(org.customPmsStartDate || '').trim();
  const customEnd   = String(org.customPmsEndDate   || '').trim();
  if (choice === 'Custom' || (customStart && customEnd)) {
    return { startsOn: customStart, endsOn: customEnd };
  }
  const now = new Date();
  const y = now.getUTCFullYear();
  if (/^April[-–]March$/i.test(choice)) {
    return { startsOn: `${y}-04-01`, endsOn: `${y + 1}-03-31` };
  }
  if (/^January[-–]December$/i.test(choice) || /^Jan[-–]Dec$/i.test(choice)) {
    return { startsOn: `${y}-01-01`, endsOn: `${y}-12-31` };
  }
  return { startsOn: customStart, endsOn: customEnd };
}

// Build sensible defaults from a fiscal-year date range. Goal-setting takes
// the first 30 days and evaluation takes the last 60 days. By default, each
// sub-window inherits its parent phase dates; admins can split the inner
// windows manually only when they have a concrete reason to do so.
export function defaultWindowsForFiscalYear({ startsOn, endsOn } = {}) {
  const start = parseDate(startsOn);
  const end = parseDate(endsOn);
  if (!start || !end || end <= start) return null;
  const totalMs = end.getTime() - start.getTime();
  const day = 24 * 60 * 60 * 1000;
  const totalDays = Math.max(1, Math.round(totalMs / day));
  const cap = (n, max) => Math.max(1, Math.min(n, max));
  const goalSpan = cap(30, Math.floor(totalDays / 2));
  const evalSpan = cap(60, Math.floor(totalDays / 2));

  const addDays = (date, days) => new Date(date.getTime() + days * day);
  const iso = (date) => date.toISOString().slice(0, 10);

  const gsStart = start;
  const gsEnd = addDays(start, goalSpan - 1);

  const evStart = addDays(end, -(evalSpan - 1));
  const evEnd = end;

  return {
    goalSetting: {
      startsOn: iso(gsStart),
      endsOn: iso(gsEnd),
      subPhases: {
        goalCreation:    { startsOn: iso(gsStart), endsOn: iso(gsEnd) },
        managerApproval: { startsOn: iso(gsStart), endsOn: iso(gsEnd) },
      },
    },
    evaluation: {
      startsOn: iso(evStart),
      endsOn: iso(evEnd),
      subPhases: {
        selfEvaluation:    { startsOn: iso(evStart), endsOn: iso(evEnd) },
        managerEvaluation: { startsOn: iso(evStart), endsOn: iso(evEnd) },
      },
    },
  };
}

function asNow(now) {
  if (!now) return new Date();
  if (now instanceof Date) return now;
  return parseDate(now) || new Date(now);
}

// Resolve the current sub-phase from the stored windows + current time.
export function getCurrentSubPhase(orgOrWindows, now) {
  const windows = orgOrWindows && (orgOrWindows.goalSetting || orgOrWindows.evaluation)
    ? orgOrWindows
    : readCycleWindows(orgOrWindows);
  if (!windows) return SUB_PHASE.PRE_CYCLE;

  const t = asNow(now);
  const goal = windows[PHASE_KIND.GOAL_SETTING] || {};
  const evalPhase = windows[PHASE_KIND.EVALUATION] || {};
  const goalSubs = goal.subPhases || {};
  const evalSubs = evalPhase.subPhases || {};

  if (isInWindow(goalSubs.goalCreation, t)) return SUB_PHASE.GOAL_CREATION;
  if (isInWindow(goalSubs.managerApproval, t)) return SUB_PHASE.MANAGER_APPROVAL;
  if (isInWindow(evalSubs.selfEvaluation, t)) return SUB_PHASE.SELF_EVALUATION;
  if (isInWindow(evalSubs.managerEvaluation, t)) return SUB_PHASE.MANAGER_EVALUATION;

  // Not inside any sub-phase. Figure out where we are relative to the cycle.
  const goalStart = startOfDay(goal.startsOn);
  const evalEnd = endOfDay(evalPhase.endsOn);
  if (goalStart && t < goalStart) return SUB_PHASE.PRE_CYCLE;
  if (evalEnd && t > evalEnd) return SUB_PHASE.POST_CYCLE;
  return SUB_PHASE.BETWEEN;
}

// Return the window the org is currently inside (or null).
export function getActiveWindow(orgOrWindows, now) {
  const windows = orgOrWindows && (orgOrWindows.goalSetting || orgOrWindows.evaluation)
    ? orgOrWindows
    : readCycleWindows(orgOrWindows);
  if (!windows) return null;
  const subPhase = getCurrentSubPhase(windows, now);
  const map = {
    [SUB_PHASE.GOAL_CREATION]:       { phaseKind: PHASE_KIND.GOAL_SETTING, win: windows.goalSetting?.subPhases?.goalCreation },
    [SUB_PHASE.MANAGER_APPROVAL]:    { phaseKind: PHASE_KIND.GOAL_SETTING, win: windows.goalSetting?.subPhases?.managerApproval },
    [SUB_PHASE.SELF_EVALUATION]:     { phaseKind: PHASE_KIND.EVALUATION,   win: windows.evaluation?.subPhases?.selfEvaluation },
    [SUB_PHASE.MANAGER_EVALUATION]:  { phaseKind: PHASE_KIND.EVALUATION,   win: windows.evaluation?.subPhases?.managerEvaluation },
  };
  const hit = map[subPhase];
  if (!hit?.win) return null;
  return { ...hit.win, subPhase, phaseKind: hit.phaseKind };
}

// Return the next upcoming sub-phase window from `now` (or null if cycle is over).
export function getNextWindow(orgOrWindows, now) {
  const windows = orgOrWindows && (orgOrWindows.goalSetting || orgOrWindows.evaluation)
    ? orgOrWindows
    : readCycleWindows(orgOrWindows);
  if (!windows) return null;
  const t = asNow(now);
  const candidates = [
    { subPhase: SUB_PHASE.GOAL_CREATION,       phaseKind: PHASE_KIND.GOAL_SETTING, win: windows.goalSetting?.subPhases?.goalCreation },
    { subPhase: SUB_PHASE.MANAGER_APPROVAL,    phaseKind: PHASE_KIND.GOAL_SETTING, win: windows.goalSetting?.subPhases?.managerApproval },
    { subPhase: SUB_PHASE.SELF_EVALUATION,     phaseKind: PHASE_KIND.EVALUATION,   win: windows.evaluation?.subPhases?.selfEvaluation },
    { subPhase: SUB_PHASE.MANAGER_EVALUATION,  phaseKind: PHASE_KIND.EVALUATION,   win: windows.evaluation?.subPhases?.managerEvaluation },
  ];
  for (const c of candidates) {
    if (!c.win) continue;
    const start = startOfDay(c.win.startsOn);
    if (start && start > t) {
      return { ...c.win, subPhase: c.subPhase, phaseKind: c.phaseKind };
    }
  }
  return null;
}

export function daysUntil(win, now) {
  if (!win) return null;
  const start = startOfDay(win.startsOn);
  if (!start) return null;
  const t = asNow(now);
  const ms = start.getTime() - t.getTime();
  if (ms <= 0) return 0;
  return Math.ceil(ms / (24 * 60 * 60 * 1000));
}

export function daysRemaining(win, now) {
  if (!win) return null;
  const end = endOfDay(win.endsOn);
  if (!end) return null;
  const t = asNow(now);
  const ms = end.getTime() - t.getTime();
  if (ms <= 0) return 0;
  return Math.ceil(ms / (24 * 60 * 60 * 1000));
}

// ── Per-employee overrides (Darwinbox-style) ────────────────────────────────
//
// HR can extend goal-creation for a specific employee past the global window.
// We store the override as a date string on `employee.cycleOverrides`:
//
//   employee.cycleOverrides = {
//     goalCreationEndsOn: 'YYYY-MM-DD',   // grace tail for this employee
//     noGoalCycle: true,                  // HR explicitly closed them out
//     extendedAt: '<ISO timestamp>',      // audit
//     extendedBy: '<userName>',
//   }

function readEmployeeOverride(employee) {
  if (!employee || typeof employee !== 'object') return null;
  const o = employee.cycleOverrides || employee.cycle_overrides;
  return o && typeof o === 'object' ? o : null;
}

// Returns the effective sub-phase for THIS employee — layers any HR-granted
// extension on top of the global org calendar.
export function getEffectivePhaseForEmployee(org, employee, now) {
  const t = asNow(now);
  const globalPhase = getCurrentSubPhase(org, t);
  const override = readEmployeeOverride(employee);
  if (!override) return globalPhase;

  // Once they've been marked no-goal for the cycle, no override re-opens them.
  if (override.noGoalCycle) return globalPhase;

  const extEnd = endOfDay(override.goalCreationEndsOn);
  if (!extEnd) return globalPhase;

  // Only meaningful if global phase has moved past goal-creation. If we're
  // still globally in goal-creation, the override is redundant.
  if (globalPhase === SUB_PHASE.GOAL_CREATION) return globalPhase;
  if (t <= extEnd) return SUB_PHASE.GOAL_CREATION;
  return globalPhase;
}

// Bucket an employee into a compliance status for the goal-creation phase.
// `submission` is the goal_workflows submission row for this employee (from
// `readWorkflowSync(orgKey).submissions[empCode]`), or null.
export function getEmployeeComplianceStatus({ org, employee, submission, now }) {
  const t = asNow(now);
  const override = readEmployeeOverride(employee);
  const status = String(submission?.status || '').trim().toLowerCase();
  const windows = readCycleWindows(org);

  if (status === 'approved' || status === 'manager_approved' || status === 'completed') {
    return 'approved';
  }
  if (status === 'pending-manager' || status === 'pending') {
    return 'pending-manager';
  }
  if (override?.noGoalCycle) {
    return 'no-goal-cycle';
  }
  // No calendar configured for the org → can't say overdue. Treat as
  // "calendar missing" so the UI shows a clean empty state rather than
  // marking every employee as overdue.
  if (!windows) return 'no-calendar';

  const effective = getEffectivePhaseForEmployee(org, employee, t);
  const inGoalCreation = effective === SUB_PHASE.GOAL_CREATION;

  // Still in goal-creation (globally or via per-employee extension)?
  if (inGoalCreation) {
    if (override?.goalCreationEndsOn) {
      // They have an extension granted. Are they actively drafting?
      if (status === 'draft') return 'extended-drafting';
      return 'extended-not-started';
    }
    if (status === 'draft') return 'drafting';
    return 'not-started';
  }

  // Goal-creation window has closed for them, and nothing's submitted.
  return 'overdue';
}

export const COMPLIANCE_LABELS = Object.freeze({
  'approved':              { label: 'Goals approved',           color: '#16A34A' },
  'pending-manager':       { label: 'Pending manager review',   color: '#F59E0B' },
  'drafting':              { label: 'In draft',                 color: '#2563EB' },
  'not-started':           { label: 'Not started',              color: '#64748B' },
  'extended-drafting':     { label: 'Drafting (extended)',      color: '#0891B2' },
  'extended-not-started':  { label: 'Extended (not started)',   color: '#94A3B8' },
  'overdue':               { label: 'Overdue — window closed',  color: '#DC2626' },
  'no-goal-cycle':         { label: 'No goals this cycle',      color: '#475569' },
  'no-calendar':           { label: 'Calendar not configured',  color: '#94A3B8' },
});

// Statuses where the goal-creation window has effectively closed for the
// employee — used by the UI to decide whether to show the Extend / Apply
// default goals actions (we only show them after the deadline).
export const DEADLINE_PASSED_STATUSES = Object.freeze([
  'overdue',
  'extended-drafting',
  'extended-not-started',
]);

export const PHASE_LABELS = Object.freeze({
  [SUB_PHASE.PRE_CYCLE]:          'Cycle has not started',
  [SUB_PHASE.GOAL_CREATION]:      'Goal creation',
  [SUB_PHASE.MANAGER_APPROVAL]:   'Manager approval',
  [SUB_PHASE.BETWEEN]:            'Between phases',
  [SUB_PHASE.SELF_EVALUATION]:    'Self evaluation',
  [SUB_PHASE.MANAGER_EVALUATION]: 'Manager evaluation',
  [SUB_PHASE.POST_CYCLE]:         'Cycle closed',
});
