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
import { callPms } from './backend/pmsClient';
import { deriveIdentity } from './backend/identity';

export const SESSION_KEY        = 'zarohr_auth_session';
export const APP_DATA_KEY       = 'zarohr_app_data_v1';
export const EMP_CREDENTIALS_KEY = 'zarohr_emp_credentials';

const LEGACY_SEED_ORG_KEYS = ['acme', 'nova', 'zenith'];
const DEFAULT_ORGS = [];
const DEFAULT_PENDING_ACTIONS = [];
const DEFAULT_FEED_DATA = [];
const DEFAULT_DASHBOARD_FLAGS = { licenseOverageOrgKey: null, hasCriticalIssue: false };

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

  const applyIdentity = useCallback((session) => {
    setUserId(session?.user?.id || null);
    setUserEmail(session?.user?.email || '');
  }, []);

  const refreshIdentity = useCallback(async () => {
    try {
      const who = await callPms('admin.whoami', {});
      const id = deriveIdentity(who.memberships);
      setRole(id.role); setOrgId(id.orgId); setEmployeeId(id.employeeId); setMemberships(id.memberships);
    } catch {
      setRole(null); setOrgId(null); setEmployeeId(null); setMemberships([]);
    }
  }, []);

  useEffect(() => {
    if (!supabase) { setAuthReady(true); return; }
    let active = true;
    supabase.auth.getSession().then(async ({ data }) => {
      if (!active) return;
      applyIdentity(data.session);
      if (data.session) await refreshIdentity();
      setAuthReady(true);
    });
    const { data: sub } = supabase.auth.onAuthStateChange(async (_event, session) => {
      applyIdentity(session);
      if (session) await refreshIdentity(); else { setRole(null); setOrgId(null); setEmployeeId(null); setMemberships([]); }
    });
    return () => { active = false; sub?.subscription?.unsubscribe?.(); };
  }, [applyIdentity, refreshIdentity]);

  const signOut = useCallback(async () => {
    try { await supabase?.auth.signOut(); } finally {
      setRole(null); setOrgId(null); setEmployeeId(null); setMemberships([]); setUserId(null); setUserEmail('');
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
