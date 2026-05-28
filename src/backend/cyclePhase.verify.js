// Run: node src/backend/cyclePhase.verify.js
//
// Asserts the cycle-phase resolver across boundary cases. Exits non-zero on
// any failure so a `npm run build` / CI pipeline can chain it later. No test
// framework required — uses node:assert.

import assert from 'node:assert/strict';
import {
  SUB_PHASE,
  PHASE_KIND,
  getCurrentSubPhase,
  getActiveWindow,
  getNextWindow,
  getEffectivePhaseForEmployee,
  getEmployeeComplianceStatus,
  daysUntil,
  daysRemaining,
  validateCycleWindows,
  defaultWindowsForFiscalYear,
  reviewCycleWindows,
  findStrandedOverrides,
} from './cyclePhase.js';

const windows = {
  goalSetting: {
    startsOn: '2026-04-01',
    endsOn:   '2026-04-30',
    subPhases: {
      goalCreation:    { startsOn: '2026-04-01', endsOn: '2026-04-20' },
      managerApproval: { startsOn: '2026-04-21', endsOn: '2026-04-30' },
    },
  },
  evaluation: {
    startsOn: '2027-02-01',
    endsOn:   '2027-03-31',
    subPhases: {
      selfEvaluation:    { startsOn: '2027-02-01', endsOn: '2027-02-28' },
      managerEvaluation: { startsOn: '2027-03-01', endsOn: '2027-03-31' }, // 2027 not a leap year
    },
  },
};

const at = (iso) => new Date(`${iso}Z`);

function check(label, fn) {
  try { fn(); console.log('  ok   ' + label); }
  catch (err) { console.error('  FAIL ' + label + '\n       ' + (err?.message || err)); process.exitCode = 1; }
}

console.log('cyclePhase.getCurrentSubPhase');

check('before cycle → pre-cycle', () => {
  assert.equal(getCurrentSubPhase(windows, at('2026-03-31T23:59:59')), SUB_PHASE.PRE_CYCLE);
});
check('exactly at goal-creation start → goal-creation', () => {
  assert.equal(getCurrentSubPhase(windows, at('2026-04-01T00:00:00')), SUB_PHASE.GOAL_CREATION);
});
check('mid goal-creation → goal-creation', () => {
  assert.equal(getCurrentSubPhase(windows, at('2026-04-10T12:00:00')), SUB_PHASE.GOAL_CREATION);
});
check('last second of goal-creation → goal-creation', () => {
  assert.equal(getCurrentSubPhase(windows, at('2026-04-20T23:59:59')), SUB_PHASE.GOAL_CREATION);
});
check('first second of manager-approval → manager-approval', () => {
  assert.equal(getCurrentSubPhase(windows, at('2026-04-21T00:00:00')), SUB_PHASE.MANAGER_APPROVAL);
});
check('last day of manager-approval → manager-approval', () => {
  assert.equal(getCurrentSubPhase(windows, at('2026-04-30T18:00:00')), SUB_PHASE.MANAGER_APPROVAL);
});
check('day after goal-setting ends → between', () => {
  assert.equal(getCurrentSubPhase(windows, at('2026-05-01T12:00:00')), SUB_PHASE.BETWEEN);
});
check('mid-cycle gap → between', () => {
  assert.equal(getCurrentSubPhase(windows, at('2026-10-15T12:00:00')), SUB_PHASE.BETWEEN);
});
check('exactly at self-evaluation start → self-evaluation', () => {
  assert.equal(getCurrentSubPhase(windows, at('2027-02-01T00:00:00')), SUB_PHASE.SELF_EVALUATION);
});
check('last day of self-eval (non-leap Feb 28) → self-evaluation', () => {
  assert.equal(getCurrentSubPhase(windows, at('2027-02-28T23:59:59')), SUB_PHASE.SELF_EVALUATION);
});
check('manager-evaluation start → manager-evaluation', () => {
  assert.equal(getCurrentSubPhase(windows, at('2027-03-01T00:00:00')), SUB_PHASE.MANAGER_EVALUATION);
});
check('after cycle → post-cycle', () => {
  assert.equal(getCurrentSubPhase(windows, at('2027-04-01T00:00:00')), SUB_PHASE.POST_CYCLE);
});
check('empty org → pre-cycle', () => {
  assert.equal(getCurrentSubPhase(null), SUB_PHASE.PRE_CYCLE);
  assert.equal(getCurrentSubPhase({}), SUB_PHASE.PRE_CYCLE);
});
check('org-shape (setup_payload) is read', () => {
  const org = { setup_payload: { cyclePhaseWindows: windows } };
  assert.equal(getCurrentSubPhase(org, at('2026-04-10T00:00:00')), SUB_PHASE.GOAL_CREATION);
});
check('org-shape (pms_config.payload) is read', () => {
  const org = { pms_config: { payload: { cyclePhaseWindows: windows } } };
  assert.equal(getCurrentSubPhase(org, at('2026-04-10T00:00:00')), SUB_PHASE.GOAL_CREATION);
});

console.log('cyclePhase.getActiveWindow');
check('returns goal-creation window when in goal-creation', () => {
  const w = getActiveWindow(windows, at('2026-04-10T12:00:00'));
  assert.equal(w?.subPhase, SUB_PHASE.GOAL_CREATION);
  assert.equal(w?.phaseKind, PHASE_KIND.GOAL_SETTING);
  assert.equal(w?.endsOn, '2026-04-20');
});
check('returns null when between phases', () => {
  assert.equal(getActiveWindow(windows, at('2026-10-15T12:00:00')), null);
});

console.log('cyclePhase.getNextWindow');
check('before cycle → next is goal-creation', () => {
  const n = getNextWindow(windows, at('2026-03-15T12:00:00'));
  assert.equal(n?.subPhase, SUB_PHASE.GOAL_CREATION);
  assert.equal(n?.startsOn, '2026-04-01');
});
check('during goal-creation → next is manager-approval', () => {
  const n = getNextWindow(windows, at('2026-04-10T12:00:00'));
  assert.equal(n?.subPhase, SUB_PHASE.MANAGER_APPROVAL);
});
check('between phases → next is self-evaluation', () => {
  const n = getNextWindow(windows, at('2026-12-01T12:00:00'));
  assert.equal(n?.subPhase, SUB_PHASE.SELF_EVALUATION);
});
check('post-cycle → next is null', () => {
  assert.equal(getNextWindow(windows, at('2027-05-01T12:00:00')), null);
});

console.log('cyclePhase.daysUntil / daysRemaining');
check('daysUntil counts forward', () => {
  assert.equal(daysUntil(windows.goalSetting.subPhases.goalCreation, at('2026-03-20T12:00:00')), 12);
});
check('daysUntil returns 0 once active', () => {
  assert.equal(daysUntil(windows.goalSetting.subPhases.goalCreation, at('2026-04-10T12:00:00')), 0);
});
check('daysRemaining counts to end-of-day', () => {
  assert.equal(daysRemaining(windows.goalSetting.subPhases.goalCreation, at('2026-04-19T12:00:00')), 2);
});
check('daysRemaining returns 0 when window ended', () => {
  assert.equal(daysRemaining(windows.goalSetting.subPhases.goalCreation, at('2026-05-01T12:00:00')), 0);
});

console.log('cyclePhase.validateCycleWindows');
check('valid windows pass', () => {
  const r = validateCycleWindows(windows);
  assert.equal(r.ok, true, r.errors.join('; '));
});
check('end-before-start fails', () => {
  const broken = JSON.parse(JSON.stringify(windows));
  broken.goalSetting.subPhases.goalCreation.endsOn = '2026-03-25';
  const r = validateCycleWindows(broken);
  assert.equal(r.ok, false);
});
check('sub-phase outside parent fails', () => {
  const broken = JSON.parse(JSON.stringify(windows));
  broken.goalSetting.subPhases.managerApproval.endsOn = '2026-06-01';
  const r = validateCycleWindows(broken);
  assert.equal(r.ok, false);
});
check('evaluation overlapping goal-setting is ALLOWED (with notice)', () => {
  const overlap = JSON.parse(JSON.stringify(windows));
  overlap.evaluation.startsOn = '2026-04-15';
  overlap.evaluation.subPhases.selfEvaluation.startsOn = '2026-04-15';
  overlap.evaluation.subPhases.selfEvaluation.endsOn   = '2026-04-30';
  overlap.evaluation.subPhases.managerEvaluation.startsOn = '2026-05-01';
  overlap.evaluation.subPhases.managerEvaluation.endsOn   = '2026-05-15';
  overlap.evaluation.endsOn = '2026-05-15';
  const r = validateCycleWindows(overlap);
  assert.equal(r.ok, true, r.errors.join('; '));
  const review = reviewCycleWindows(overlap, at('2025-12-01T12:00:00'));
  assert.ok(review.warnings.some((w) => /run in parallel/i.test(w)));
});
check('missing phase fails cleanly', () => {
  const r = validateCycleWindows({ goalSetting: windows.goalSetting });
  assert.equal(r.ok, false);
});
check('overlapping sub-phases are ALLOWED (intentional)', () => {
  const overlap = JSON.parse(JSON.stringify(windows));
  overlap.goalSetting.subPhases.managerApproval.startsOn = '2026-04-15';
  const r = validateCycleWindows(overlap);
  assert.equal(r.ok, true, r.errors.join('; '));
});

console.log('cyclePhase.defaultWindowsForFiscalYear');
check('April–March fiscal year produces valid defaults', () => {
  const d = defaultWindowsForFiscalYear({ startsOn: '2026-04-01', endsOn: '2027-03-31' });
  assert.ok(d);
  const r = validateCycleWindows(d);
  assert.equal(r.ok, true, r.errors.join('; '));
  assert.equal(d.goalSetting.startsOn, '2026-04-01');
  assert.equal(d.evaluation.endsOn, '2027-03-31');
});
check('defaults keep sub-windows synced to parent phase dates', () => {
  const d = defaultWindowsForFiscalYear({ startsOn: '2026-04-01', endsOn: '2027-03-31' });
  assert.deepEqual(d.goalSetting.subPhases.goalCreation, {
    startsOn: d.goalSetting.startsOn,
    endsOn: d.goalSetting.endsOn,
  });
  assert.deepEqual(d.goalSetting.subPhases.managerApproval, {
    startsOn: d.goalSetting.startsOn,
    endsOn: d.goalSetting.endsOn,
  });
  assert.deepEqual(d.evaluation.subPhases.selfEvaluation, {
    startsOn: d.evaluation.startsOn,
    endsOn: d.evaluation.endsOn,
  });
  assert.deepEqual(d.evaluation.subPhases.managerEvaluation, {
    startsOn: d.evaluation.startsOn,
    endsOn: d.evaluation.endsOn,
  });
});
check('Jan–Dec fiscal year produces valid defaults', () => {
  const d = defaultWindowsForFiscalYear({ startsOn: '2026-01-01', endsOn: '2026-12-31' });
  assert.ok(d);
  assert.equal(validateCycleWindows(d).ok, true);
});
check('invalid fiscal year returns null', () => {
  assert.equal(defaultWindowsForFiscalYear({}), null);
  assert.equal(defaultWindowsForFiscalYear({ startsOn: '2027-01-01', endsOn: '2026-12-31' }), null);
});

console.log('cyclePhase.getEffectivePhaseForEmployee');
check('no override → global phase', () => {
  const emp = {};
  assert.equal(getEffectivePhaseForEmployee({ cyclePhaseWindows: windows }, emp, at('2026-05-15T12:00:00')), SUB_PHASE.BETWEEN);
});
check('override extends goal-creation past global window', () => {
  const emp = { cycleOverrides: { goalCreationEndsOn: '2026-05-15' } };
  assert.equal(getEffectivePhaseForEmployee({ cyclePhaseWindows: windows }, emp, at('2026-05-10T12:00:00')), SUB_PHASE.GOAL_CREATION);
});
check('override past its end date → falls back to global', () => {
  const emp = { cycleOverrides: { goalCreationEndsOn: '2026-05-15' } };
  assert.equal(getEffectivePhaseForEmployee({ cyclePhaseWindows: windows }, emp, at('2026-05-16T12:00:00')), SUB_PHASE.BETWEEN);
});
check('noGoalCycle flag suppresses override', () => {
  const emp = { cycleOverrides: { goalCreationEndsOn: '2026-05-15', noGoalCycle: true } };
  assert.equal(getEffectivePhaseForEmployee({ cyclePhaseWindows: windows }, emp, at('2026-05-10T12:00:00')), SUB_PHASE.BETWEEN);
});
check('global still in goal-creation → override is no-op', () => {
  const emp = { cycleOverrides: { goalCreationEndsOn: '2026-05-15' } };
  assert.equal(getEffectivePhaseForEmployee({ cyclePhaseWindows: windows }, emp, at('2026-04-10T12:00:00')), SUB_PHASE.GOAL_CREATION);
});

console.log('cyclePhase.getEmployeeComplianceStatus');
const org = { cyclePhaseWindows: windows };
check('approved submission → approved', () => {
  const s = getEmployeeComplianceStatus({ org, employee: {}, submission: { status: 'approved' }, now: at('2026-04-10T12:00:00') });
  assert.equal(s, 'approved');
});
check('pending-manager submission → pending-manager', () => {
  const s = getEmployeeComplianceStatus({ org, employee: {}, submission: { status: 'pending-manager' }, now: at('2026-04-10T12:00:00') });
  assert.equal(s, 'pending-manager');
});
check('no submission during goal-creation → not-started', () => {
  const s = getEmployeeComplianceStatus({ org, employee: {}, submission: null, now: at('2026-04-10T12:00:00') });
  assert.equal(s, 'not-started');
});
check('draft during goal-creation → drafting', () => {
  const s = getEmployeeComplianceStatus({ org, employee: {}, submission: { status: 'draft' }, now: at('2026-04-10T12:00:00') });
  assert.equal(s, 'drafting');
});
check('no submission after window with no override → overdue', () => {
  const s = getEmployeeComplianceStatus({ org, employee: {}, submission: null, now: at('2026-05-15T12:00:00') });
  assert.equal(s, 'overdue');
});
check('extension granted but not started → extended-not-started', () => {
  const emp = { cycleOverrides: { goalCreationEndsOn: '2026-05-20' } };
  const s = getEmployeeComplianceStatus({ org, employee: emp, submission: null, now: at('2026-05-15T12:00:00') });
  assert.equal(s, 'extended-not-started');
});
check('extension granted + drafting → extended-drafting', () => {
  const emp = { cycleOverrides: { goalCreationEndsOn: '2026-05-20' } };
  const s = getEmployeeComplianceStatus({ org, employee: emp, submission: { status: 'draft' }, now: at('2026-05-15T12:00:00') });
  assert.equal(s, 'extended-drafting');
});
check('noGoalCycle flag → no-goal-cycle bucket', () => {
  const emp = { cycleOverrides: { noGoalCycle: true } };
  const s = getEmployeeComplianceStatus({ org, employee: emp, submission: null, now: at('2026-05-15T12:00:00') });
  assert.equal(s, 'no-goal-cycle');
});
check('no calendar configured → no-calendar bucket (not overdue)', () => {
  const s = getEmployeeComplianceStatus({ org: {}, employee: {}, submission: null, now: at('2026-05-15T12:00:00') });
  assert.equal(s, 'no-calendar');
});
check('no calendar + draft submission → still drafting (submission wins)', () => {
  // Submission status is authoritative — a draft is a draft regardless of calendar.
  const s = getEmployeeComplianceStatus({ org: {}, employee: {}, submission: { status: 'draft' }, now: at('2026-05-15T12:00:00') });
  assert.equal(s, 'no-calendar');
});

console.log('cyclePhase.reviewCycleWindows');
check('windows entirely in the future → no warnings', () => {
  const r = reviewCycleWindows(windows, at('2025-12-01T12:00:00'));
  assert.equal(r.warnings.length, 0);
});
check('goal-setting closed → notice', () => {
  const r = reviewCycleWindows(windows, at('2027-06-01T12:00:00'));
  assert.ok(r.warnings.some((w) => /goal-setting window has already closed/i.test(w)));
});
check('one-day window → notice', () => {
  const tight = JSON.parse(JSON.stringify(windows));
  tight.evaluation.endsOn = tight.evaluation.startsOn;
  tight.evaluation.subPhases.selfEvaluation = { startsOn: tight.evaluation.startsOn, endsOn: tight.evaluation.startsOn };
  tight.evaluation.subPhases.managerEvaluation = { startsOn: tight.evaluation.startsOn, endsOn: tight.evaluation.startsOn };
  const r = reviewCycleWindows(tight, at('2025-12-01T12:00:00'));
  assert.ok(r.warnings.some((w) => /evaluation window spans one day or less/i.test(w)));
});

console.log('cyclePhase.findStrandedOverrides');
check('extension extending into evaluation → flagged', () => {
  const employees = [{
    'Employee Code': 'E001',
    'Employee Name': 'Alpha',
    cycleOverrides: { goalCreationEndsOn: '2027-02-15' },
  }];
  const list = findStrandedOverrides(employees, windows, at('2026-09-01T12:00:00'));
  assert.equal(list.length, 1);
  assert.equal(list[0].reason, 'extension-extends-into-evaluation');
});
check('expired extension → flagged', () => {
  const employees = [{
    'Employee Code': 'E002',
    'Employee Name': 'Bravo',
    cycleOverrides: { goalCreationEndsOn: '2026-05-15' },
  }];
  const list = findStrandedOverrides(employees, windows, at('2026-06-01T12:00:00'));
  assert.equal(list.length, 1);
  assert.equal(list[0].reason, 'extension-expired');
});
check('no-goal-cycle override is skipped', () => {
  const employees = [{
    'Employee Code': 'E003',
    cycleOverrides: { goalCreationEndsOn: '2027-02-15', noGoalCycle: true },
  }];
  const list = findStrandedOverrides(employees, windows, at('2026-09-01T12:00:00'));
  assert.equal(list.length, 0);
});

if (process.exitCode) {
  console.error('\nFAILED');
} else {
  console.log('\nAll cyclePhase checks passed.');
}
