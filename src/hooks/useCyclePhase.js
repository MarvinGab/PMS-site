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

// React hook that surfaces the current cycle sub-phase for a given org. The
// `now` value re-ticks once per minute (and on tab focus) so a phase rollover
// at midnight is reflected without a hard reload.
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
    return {
      now,
      subPhase,
      label: PHASE_LABELS[subPhase],
      activeWindow: active,
      nextWindow: next,
      daysRemainingInPhase: active ? daysRemaining(active, now) : null,
      daysUntilNextPhase:   next   ? daysUntil(next, now) : null,
      isInGoalCreation:      subPhase === SUB_PHASE.GOAL_CREATION,
      isInManagerApproval:   subPhase === SUB_PHASE.MANAGER_APPROVAL,
      isInSelfEvaluation:    subPhase === SUB_PHASE.SELF_EVALUATION,
      isInManagerEvaluation: subPhase === SUB_PHASE.MANAGER_EVALUATION,
      isPreCycle:  subPhase === SUB_PHASE.PRE_CYCLE,
      isPostCycle: subPhase === SUB_PHASE.POST_CYCLE,
      isBetween:   subPhase === SUB_PHASE.BETWEEN,
      goalSettingLocked:  subPhase !== SUB_PHASE.GOAL_CREATION && subPhase !== SUB_PHASE.MANAGER_APPROVAL,
      evaluationLocked:   subPhase !== SUB_PHASE.SELF_EVALUATION && subPhase !== SUB_PHASE.MANAGER_EVALUATION,
      hasWindows: !!windows,
      windows,
      PHASE_KIND,
      SUB_PHASE,
    };
  }, [orgOrWindows, now]);
}
