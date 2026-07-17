import { createContext, useContext, useState, useEffect, useCallback } from 'react';
import {
  readAppDataSync as readStoredAppData,
  hydrateAppData,
  persistAppData,
  hydrateOrganizations,
  syncOrganizationsCollection,
  clearOrganizationState,
  migrateOrganizationState,
} from './backend/stateStore';
import { supabase } from './backend/supabaseClient';
import { callPms, callWorkflow } from './backend/pmsClient';
import { deriveIdentity } from './backend/identity';

export const APP_DATA_KEY       = 'zarohr_app_data_v1';
export const EMP_CREDENTIALS_KEY = 'zarohr_emp_credentials';

const LEGACY_SEED_ORG_KEYS = ['acme', 'nova', 'zenith'];
const DEFAULT_ORGS = [];
const DEFAULT_PENDING_ACTIONS = [];
const DEFAULT_FEED_DATA = [];
const DEFAULT_DASHBOARD_FLAGS = { licenseOverageOrgKey: null, hasCriticalIssue: false };

// Defaults for the workflow.bootstrap-derived fields (Plan 5b shell rewire). Bootstrap is a
// best-effort scoped read on top of whoami/deriveIdentity: it 403s (NO_ORG_MEMBERSHIP) for a
// pure super-admin with no org membership, and can fail for other reasons (network, etc). Any
// failure just leaves these at their defaults — it must never crash the app or block authReady.
const DEFAULT_BOOTSTRAP = {
  orgKey: null,
  orgName: null,
  launched: false,
  employeeCode: null,
  employeeName: null,
  managerCode: null,
  designation: null,
  currentPhase: null,
  isManager: false,
  directReportsCount: 0,
  hodReportsCount: 0,
};

function withTimeout(promise, ms, label) {
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(`${label || 'Operation'} timed out`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timeoutId));
}

function isLegacySeededAppData(data) {
  const orgKeys = Array.isArray(data?.organizationsData)
    ? data.organizationsData.map((org) => org?.key).filter(Boolean)
    : [];

  if (orgKeys.length !== LEGACY_SEED_ORG_KEYS.length) return false;

  return LEGACY_SEED_ORG_KEYS.every((key) => orgKeys.includes(key));
}

function sanitizeInitialAppData(data) {
  if (!isLegacySeededAppData(data)) return data;
  return {
    ...data,
    organizationsData: [],
    pendingActionsData: [],
    feedData: [],
    dashboardFlags: { ...DEFAULT_DASHBOARD_FLAGS },
  };
}

export const AppContext = createContext(null);

// Read persisted app data synchronously for first render
function readAppDataSync() {
  return readStoredAppData();
}

export function AppProvider({ children }) {
  // Read app data ONCE to avoid inconsistent state from repeated localStorage reads.
  // Identity (role/org/employee) is NOT read synchronously anymore — it comes from
  // the Supabase session + backend whoami (see the auth effect below).
  const rawInitialAppData = readAppDataSync();
  const initialAppData = sanitizeInitialAppData(rawInitialAppData);

  const [authReady, setAuthReady] = useState(false);
  const [userId, setUserId] = useState(null);
  const [userEmail, setUserEmail] = useState('');
  const [role, setRole] = useState(null);
  const [orgId, setOrgId] = useState(null);
  const [employeeId, setEmployeeId] = useState(null);
  const [memberships, setMemberships] = useState([]);
  const [bootstrap, setBootstrap] = useState(DEFAULT_BOOTSTRAP);

  const applyIdentity = useCallback((session) => {
    setUserId(session?.user?.id || null);
    setUserEmail(session?.user?.email || '');
  }, []);

  // Best-effort scoped read (workflow.bootstrap). Never throws out of this fn: a pure
  // super-admin with no org membership 403s (NO_ORG_MEMBERSHIP) and that — like any other
  // failure — just resets the fields to their defaults instead of surfacing an error.
  const refreshBootstrap = useCallback(async () => {
    try {
      const result = await callWorkflow('workflow.bootstrap', {});
      setBootstrap({
        orgKey: result?.org?.key ?? null,
        orgName: result?.org?.name ?? null,
        launched: result?.org?.launched ?? false,
        employeeCode: result?.employee?.code ?? null,
        employeeName: result?.employee?.name ?? null,
        managerCode: result?.employee?.managerCode ?? null,
        designation: result?.employee?.designation ?? null,
        currentPhase: result?.currentPhase ?? null,
        isManager: result?.isManager ?? false,
        directReportsCount: result?.directReportsCount ?? 0,
        hodReportsCount: result?.hodReportsCount ?? 0,
      });
    } catch {
      setBootstrap(DEFAULT_BOOTSTRAP);
    }
  }, []);

  const refreshIdentity = useCallback(async () => {
    try {
      const who = await callPms('admin.whoami', {});
      const id = deriveIdentity(who.memberships);
      setRole(id.role); setOrgId(id.orgId); setEmployeeId(id.employeeId); setMemberships(id.memberships);
    } catch {
      setRole(null); setOrgId(null); setEmployeeId(null); setMemberships([]);
    }
    // Bootstrap is independent of whether whoami succeeded — it has its own auth check and
    // its own graceful failure path — so it's always attempted, never allowed to block this fn.
    await refreshBootstrap();
  }, [refreshBootstrap]);

  useEffect(() => {
    if (!supabase) { setAuthReady(true); return; }
    let active = true;

    // Belt-and-braces: the boot screen is gated on authReady, so GUARANTEE it flips — no
    // supabase-auth hiccup (a stuck Web Lock, a hung token refresh, a corrupt stored token)
    // may ever leave the app stranded on "Loading your workspace…".
    const readyFallback = setTimeout(() => { if (active) setAuthReady(true); }, 6000);
    const markReady = () => { if (active) { clearTimeout(readyFallback); setAuthReady(true); } };

    const resetIdentity = () => {
      setRole(null); setOrgId(null); setEmployeeId(null); setMemberships([]); setBootstrap(DEFAULT_BOOTSTRAP);
    };

    withTimeout(supabase.auth.getSession(), 8000, 'Supabase session')
      .then(async ({ data }) => {
        if (!active) return;
        applyIdentity(data.session);
        if (data.session) {
          await withTimeout(refreshIdentity(), 12000, 'Identity bootstrap');
        } else {
          setBootstrap(DEFAULT_BOOTSTRAP);
        }
      })
      .catch((error) => {
        console.warn('[auth] initial session bootstrap failed', error);
        if (active) { applyIdentity(null); resetIdentity(); }
      })
      .finally(markReady);

    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      // IMPORTANT: keep this callback SYNCHRONOUS. supabase-js holds its auth lock while the
      // callback runs; refreshIdentity()/refreshBootstrap() call getSession() internally, which
      // would then wait on that very lock → deadlock (the app hangs on the boot screen). Defer
      // the async work to a macrotask so the lock is released before it runs.
      applyIdentity(session);
      setTimeout(async () => {
        if (!active) return;
        try {
          if (session) await withTimeout(refreshIdentity(), 12000, 'Identity refresh');
          else resetIdentity();
        } catch (error) {
          console.warn('[auth] identity refresh failed', error);
          if (active) resetIdentity();
        } finally {
          markReady();
        }
      }, 0);
    });
    return () => { active = false; clearTimeout(readyFallback); sub?.subscription?.unsubscribe?.(); };
  }, [applyIdentity, refreshIdentity]);

  const signOut = useCallback(async () => {
    try { await supabase?.auth.signOut(); } finally {
      setRole(null); setOrgId(null); setEmployeeId(null); setMemberships([]); setUserId(null); setUserEmail('');
      setBootstrap(DEFAULT_BOOTSTRAP);
    }
  }, []);

  const [orgs, setOrgs] = useState(() => {
    return Array.isArray(initialAppData?.organizationsData) ? initialAppData.organizationsData : DEFAULT_ORGS.map(o => ({ ...o }));
  });
  const [pendingActions, setPendingActions] = useState(() => {
    return Array.isArray(initialAppData?.pendingActionsData) ? initialAppData.pendingActionsData : DEFAULT_PENDING_ACTIONS.map(a => ({ ...a }));
  });
  const [feedData, setFeedData] = useState(() => {
    return Array.isArray(initialAppData?.feedData) ? initialAppData.feedData : DEFAULT_FEED_DATA.map(f => ({ ...f }));
  });
  const [dashboardFlags, setDashboardFlags] = useState(() => {
    return initialAppData?.dashboardFlags ? { ...DEFAULT_DASHBOARD_FLAGS, ...initialAppData.dashboardFlags } : { ...DEFAULT_DASHBOARD_FLAGS };
  });

  // Seed localStorage with default data on first ever load so resolveUser (which reads
  // localStorage directly) can find HR admin credentials without needing a prior save.
  useEffect(() => {
    if (!initialAppData) {
      persistAppData({
        dashboardFlags: DEFAULT_DASHBOARD_FLAGS,
        pendingActionsData: DEFAULT_PENDING_ACTIONS,
        feedData: DEFAULT_FEED_DATA,
        organizationsData: DEFAULT_ORGS,
      });
    } else if (isLegacySeededAppData(rawInitialAppData)) {
      persistAppData(initialAppData);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    let cancelled = false;
    hydrateAppData().then((data) => {
      const sanitizedData = sanitizeInitialAppData(data);
      if (cancelled || !data) return;
      if (isLegacySeededAppData(data)) persistAppData(sanitizedData);
      if (sanitizedData.dashboardFlags) setDashboardFlags({ ...DEFAULT_DASHBOARD_FLAGS, ...sanitizedData.dashboardFlags });
      if (Array.isArray(sanitizedData.pendingActionsData)) setPendingActions(sanitizedData.pendingActionsData);
      if (Array.isArray(sanitizedData.feedData)) setFeedData(sanitizedData.feedData);
    });
    return () => {
      cancelled = true;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    let cancelled = false;
    hydrateOrganizations().then((organizations) => {
      if (cancelled) return;
      if (Array.isArray(organizations)) setOrgs(organizations);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  function loadAppData() {
    hydrateAppData().then((data) => {
      const sanitizedData = sanitizeInitialAppData(data);
      if (!data) return;
      if (isLegacySeededAppData(data)) persistAppData(sanitizedData);
      if (sanitizedData.dashboardFlags) setDashboardFlags({ ...DEFAULT_DASHBOARD_FLAGS, ...sanitizedData.dashboardFlags });
      if (Array.isArray(sanitizedData.pendingActionsData)) setPendingActions(sanitizedData.pendingActionsData);
      if (Array.isArray(sanitizedData.feedData)) setFeedData(sanitizedData.feedData);
    });
    hydrateOrganizations().then((organizations) => {
      if (Array.isArray(organizations)) setOrgs(organizations);
    });
  }

  const saveAppData = useCallback((overrides = {}) => {
    const base = readStoredAppData() || {};
    persistAppData({
      dashboardFlags: overrides.dashboardFlags ?? base.dashboardFlags ?? dashboardFlags,
      pendingActionsData: overrides.pendingActions ?? base.pendingActionsData ?? pendingActions,
      feedData: overrides.feedData ?? base.feedData ?? feedData,
      organizationsData: overrides.orgs ?? base.organizationsData ?? orgs,
    });
  }, [dashboardFlags, pendingActions, feedData, orgs]);

  function updateOrgs(nextOrgs) {
    setOrgs(nextOrgs);
    void syncOrganizationsCollection(nextOrgs, orgs);
    saveAppData({ orgs: nextOrgs });
  }

  function updateFeed(nextFeed) {
    setFeedData(nextFeed);
    saveAppData({ feedData: nextFeed });
  }

  function updatePendingActions(next) {
    setPendingActions(next);
    saveAppData({ pendingActions: next });
  }

  function updateDashboardFlags(next) {
    setDashboardFlags(next);
    saveAppData({ dashboardFlags: next });
  }

  function applyAppData(updater) {
    const next = typeof updater === 'function'
      ? updater({
          orgs,
          pendingActions,
          feedData,
          dashboardFlags,
        })
      : updater;
    if (!next) return;

    if (Object.prototype.hasOwnProperty.call(next, 'orgs')) setOrgs(next.orgs);
    if (Object.prototype.hasOwnProperty.call(next, 'pendingActions')) setPendingActions(next.pendingActions);
    if (Object.prototype.hasOwnProperty.call(next, 'feedData')) setFeedData(next.feedData);
    if (Object.prototype.hasOwnProperty.call(next, 'dashboardFlags')) setDashboardFlags(next.dashboardFlags);

    if (Object.prototype.hasOwnProperty.call(next, 'orgs')) {
      void syncOrganizationsCollection(next.orgs, orgs);
    }
    saveAppData(next);
  }

  const value = {
    userId, role, orgId, employeeId, memberships, userEmail, authReady,
    signOut, refreshIdentity,
    // TODO(5b-5e): un-migrated screens still call `logout()` from context —
    // alias it to the new Supabase signOut until each screen is cut over.
    logout: signOut,
    // workflow.bootstrap-derived fields (Plan 5b shell rewire, Task 2). Best-effort: null/
    // false/0 until loaded, and left at those defaults if bootstrap fails for any reason
    // (including a pure super-admin's NO_ORG_MEMBERSHIP 403). See refreshBootstrap above.
    orgKey: bootstrap.orgKey,
    orgName: bootstrap.orgName,
    launched: bootstrap.launched,
    employeeCode: bootstrap.employeeCode,
    employeeName: bootstrap.employeeName,
    managerCode: bootstrap.managerCode,
    designation: bootstrap.designation,
    currentPhase: bootstrap.currentPhase,
    isManager: bootstrap.isManager,
    directReportsCount: bootstrap.directReportsCount,
    hodReportsCount: bootstrap.hodReportsCount,
    refreshBootstrap,
    orgs, setOrgs: updateOrgs,
    pendingActions, setPendingActions: updatePendingActions,
    feedData, setFeedData: updateFeed,
    dashboardFlags, setDashboardFlags: updateDashboardFlags,
    applyAppData,
    clearOrganizationState,
    migrateOrganizationState,
    saveAppData, loadAppData,
  };

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp() {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp must be used within AppProvider');
  return ctx;
}
