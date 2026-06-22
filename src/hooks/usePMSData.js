// Single hook every appraisal page uses to load wizard config + employees +
// resolve current phase. Keeps page components focused on UI.

import { useEffect, useState } from 'react';
import { readWizardStateSync, hydrateWizardState, readWorkflowSync } from '../backend/stateStore';
import { readOrganizationsSync, hydrateOrganizations } from '../backend/stateStore';
import { getActiveSubPhases, getCurrentSubPhase, SUB_PHASE } from '../backend/cyclePhase';
import { hydrateRatings, subscribeToRatings } from '../backend/ratingsStore';

function readOrg(orgKey) {
  try {
    const orgs = readOrganizationsSync() || [];
    return orgs.find((o) => o.key === orgKey) || null;
  } catch {
    return null;
  }
}

// Map the legacy `currentPhase` flag (set by Stage Control) onto the
// calendar sub-phase enum, so pages can treat both sources uniformly.
function legacyPhaseToSubPhase(legacy) {
  switch (legacy) {
    case 'goal-setting': return SUB_PHASE.GOAL_CREATION;
    case 'self-evaluation': return SUB_PHASE.SELF_EVALUATION;
    case 'manager-rating':
    case 'manager-evaluation': return SUB_PHASE.MANAGER_EVALUATION;
    default: return null;
  }
}

// If the calendar is between phases (pre-cycle, between, post-cycle), prefer
// the legacy flag — HR may have advanced via Stage Control without setting
// calendar windows. Calendar wins only when it's INSIDE an actual sub-phase.
function resolveEffectiveSubPhase(org) {
  const calendarPhase = getCurrentSubPhase(org);
  const insideCalendar = (
    calendarPhase === SUB_PHASE.GOAL_CREATION ||
    calendarPhase === SUB_PHASE.MANAGER_APPROVAL ||
    calendarPhase === SUB_PHASE.SELF_EVALUATION ||
    calendarPhase === SUB_PHASE.MANAGER_EVALUATION
  );
  if (insideCalendar) return calendarPhase;
  const legacyMapped = legacyPhaseToSubPhase(org?.currentPhase);
  return legacyMapped || calendarPhase;
}

function resolveActiveSubPhases(org) {
  const active = getActiveSubPhases(org);
  const legacyMapped = legacyPhaseToSubPhase(org?.currentPhase);
  return Array.from(new Set([...(active || []), ...(legacyMapped ? [legacyMapped] : [])]));
}

export function usePMSData(orgKey) {
  const [state, setState] = useState(() => {
    const wizardState = readWizardStateSync(orgKey) || {};
    const config = wizardState?.config || wizardState || {};
    const org = readOrg(orgKey);
    const workflow = readWorkflowSync(orgKey) || { submissions: {} };
    return {
      ready: !!config && Object.keys(config).length > 0,
      config,
      org,
      workflow,
      employees: config?.employeeUploadData?.employees || [],
      subPhase: resolveEffectiveSubPhase(org),
      activeSubPhases: resolveActiveSubPhases(org),
    };
  });

  useEffect(() => {
    let cancelled = false;

    const refresh = () => {
      const wizardState = readWizardStateSync(orgKey) || {};
      const config = wizardState?.config || wizardState || {};
      const org = readOrg(orgKey);
      const workflow = readWorkflowSync(orgKey) || { submissions: {} };
      setState({
        ready: true,
        config,
        org,
        workflow,
        employees: config?.employeeUploadData?.employees || [],
        subPhase: resolveEffectiveSubPhase(org),
        activeSubPhases: resolveActiveSubPhases(org),
      });
    };

    (async () => {
      try {
        await Promise.all([hydrateOrganizations(), hydrateWizardState(orgKey), hydrateRatings(orgKey)]);
        if (cancelled) return;
        refresh();
      } catch {
        setState((prev) => ({ ...prev, ready: true }));
      }
    })();

    // React to wizard config / org / workflow / ratings changes from the same or other tabs/devices.
    const onStorage = (e) => {
      if (cancelled) return;
      const k = e?.key || '';
      if (!k) { refresh(); return; }
      if (
        k.startsWith('pms.wizard_state') ||
        k.startsWith('pms.goal_workflow') ||
        k.startsWith('pms.organizations') ||
        k.startsWith('zarohr_ratings_v1') ||
        k.includes('wizard_state') ||
        k.includes('goal_workflow') ||
        k.includes('organizations') ||
        k.includes('ratings')
      ) refresh();
    };
    const onRatingsChanged = () => {
      if (!cancelled) refresh();
    };
    const unsubscribeRatings = subscribeToRatings(orgKey, () => {
      if (!cancelled) refresh();
    });
    window.addEventListener('storage', onStorage);
    window.addEventListener('zarohr-ratings-changed', onRatingsChanged);

    return () => {
      cancelled = true;
      window.removeEventListener('storage', onStorage);
      window.removeEventListener('zarohr-ratings-changed', onRatingsChanged);
      unsubscribeRatings();
    };
  }, [orgKey]);

  return state;
}

export { SUB_PHASE };
