import { useEffect, useMemo, useState } from 'react';
import {
  SUB_PHASE,
  PHASE_KIND,
  PHASE_LABELS,
  getCurrentSubPhase,
  getActiveWindow,
  getNextWindow,
  daysUntil,
  daysRemaining,
  readCycleWindows,
} from '../backend/cyclePhase';

// Inclusive day-precision check used for independent sub-phase booleans.
// Sub-phases CAN overlap (e.g. goal-creation and manager-approval running
// side-by-side during a rejection cycle), so each boolean is computed
// directly off its own window rather than off the single `subPhase` label.
function isInWindow(win, now) {
  if (!win?.startsOn || !win?.endsOn) return false;
  const startStr = String(win.startsOn);
  const endStr = String(win.endsOn);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startStr) || !/^\d{4}-\d{2}-\d{2}$/.test(endStr)) return false;
  const [sy, sm, sd] = startStr.split('-').map(Number);
  const [ey, em, ed] = endStr.split('-').map(Number);
  const start = new Date(Date.UTC(sy, sm - 1, sd, 0, 0, 0, 0));
  const end = new Date(Date.UTC(ey, em - 1, ed, 23, 59, 59, 999));
  return now >= start && now <= end;
}

export function useCyclePhase(orgOrWindows) {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    let cancelled = false;
    const tick = () => { if (!cancelled) setNow(new Date()); };
    const interval = setInterval(tick, 60 * 1000);
    const onVisible = () => { if (document.visibilityState === 'visible') tick(); };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', tick);
    return () => {
      cancelled = true;
      clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', tick);
    };
  }, []);

  return useMemo(() => {
    const windows = orgOrWindows && (orgOrWindows.goalSetting || orgOrWindows.evaluation)
      ? orgOrWindows
      : readCycleWindows(orgOrWindows);
    const subPhase = getCurrentSubPhase(windows, now);
    const active = getActiveWindow(windows, now);
    const next = getNextWindow(windows, now);

    // Independent flags — both within Goal-setting OR within Evaluation can
    // be true simultaneously when their windows overlap.
    const goalSubs = windows?.goalSetting?.subPhases || {};
    const evalSubs = windows?.evaluation?.subPhases || {};
    const isInGoalCreation      = isInWindow(goalSubs.goalCreation, now);
    const isInManagerApproval   = isInWindow(goalSubs.managerApproval, now);
    const isInSelfEvaluation    = isInWindow(evalSubs.selfEvaluation, now);
    const isInManagerEvaluation = isInWindow(evalSubs.managerEvaluation, now);

    return {
      now,
      subPhase,
      label: PHASE_LABELS[subPhase],
      activeWindow: active,
      nextWindow: next,
      daysRemainingInPhase: active ? daysRemaining(active, now) : null,
      daysUntilNextPhase:   next   ? daysUntil(next, now) : null,
      isInGoalCreation,
      isInManagerApproval,
      isInSelfEvaluation,
      isInManagerEvaluation,
      isPreCycle:  subPhase === SUB_PHASE.PRE_CYCLE,
      isPostCycle: subPhase === SUB_PHASE.POST_CYCLE,
      isBetween:   subPhase === SUB_PHASE.BETWEEN,
      goalSettingLocked:  !isInGoalCreation && !isInManagerApproval,
      evaluationLocked:   !isInSelfEvaluation && !isInManagerEvaluation,
      hasWindows: !!windows,
      windows,
      PHASE_KIND,
      SUB_PHASE,
    };
  }, [orgOrWindows, now]);
}
