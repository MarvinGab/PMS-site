import { createContext, useContext, useState, useEffect, useCallback } from 'react';
import {
  readAppDataSync as readStoredAppData,
  hydrateAppData,
  persistAppData,
  hydrateOrganizations,
  syncOrganizationsCollection,
  clearOrganizationState,
  migrateOrganizationState,
  readAuthSessionSync,
  persistAuthSession,
  clearAuthSession,
} from './backend/stateStore';
import { revokeServerSession } from './backend/serverAuth';

export const SESSION_KEY        = 'zarohr_auth_session';
export const APP_DATA_KEY       = 'zarohr_app_data_v1';
export const EMP_CREDENTIALS_KEY = 'zarohr_emp_credentials';
export const EMP_SESSION_KEY    = 'zarohr_emp_session';

export const SUPER_ADMIN_EMAIL = 'admin@zarohr.com';
export const SUPER_ADMIN_PASS  = 'admin123';

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

// Read auth session synchronously so first render already knows who's logged in
function readSessionSync() {
  try {
    const s = readAuthSessionSync();
    if (s?.isLoggedIn && s.role) return s;
  } catch (_) {}
  return null;
}

// Read persisted app data synchronously for first render
function readAppDataSync() {
  return readStoredAppData();
}

export function AppProvider({ children }) {
  // Read session and app data ONCE to avoid inconsistent state from repeated localStorage reads
  const initialSession = readSessionSync();
  const rawInitialAppData = readAppDataSync();
  const initialAppData = sanitizeInitialAppData(rawInitialAppData);

  const [role, setRole]       = useState(initialSession?.role || null);
  const [orgKey, setOrgKey]   = useState(initialSession?.orgKey || null);
  const [userName, setUserName] = useState(initialSession?.userName || '');
  const [isCoAdmin, setIsCoAdmin] = useState(!!initialSession?.isCoAdmin);
  const [isScopedHR, setIsScopedHR] = useState(!!initialSession?.isScopedHR);
  const [hrTeamId, setHrTeamId] = useState(initialSession?.hrTeamId || null);
  const [empCode, setEmpCode] = useState(initialSession?.empCode || null);
  const [allowedModules, setAllowedModules] = useState(initialSession?.allowedModules || null);
  const [serverSessionToken, setServerSessionToken] = useState(initialSession?.serverSessionToken || null);
  const [authReady, setAuthReady] = useState(true);  // always ready since we read sync

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

  function login(loginRole, data = {}) {
    setRole(loginRole);
    setOrgKey(data.orgKey || null);
    setUserName(data.userName || '');
    setIsCoAdmin(!!data.isCoAdmin);
    setIsScopedHR(!!data.isScopedHR);
    setHrTeamId(data.hrTeamId || null);
    setEmpCode(data.empCode || null);
    setAllowedModules(data.allowedModules || null);
    setServerSessionToken(data.serverSessionToken || null);
    persistAuthSession({
      isLoggedIn: true,
      role: loginRole,
      orgKey: data.orgKey || null,
      userName: data.userName || '',
      isCoAdmin: !!data.isCoAdmin,
      isScopedHR: !!data.isScopedHR,
      hrTeamId: data.hrTeamId || null,
      empCode: data.empCode || null,
      allowedModules: data.allowedModules || null,
      serverSessionToken: data.serverSessionToken || null,
    });
  }

  function logout() {
    if (serverSessionToken) void revokeServerSession(serverSessionToken);
    setRole(null);
    setOrgKey(null);
    setUserName('');
    setIsCoAdmin(false);
    setIsScopedHR(false);
    setHrTeamId(null);
    setEmpCode(null);
    setAllowedModules(null);
    setServerSessionToken(null);
    clearAuthSession();
  }

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
    role, orgKey, userName, authReady, serverSessionToken,
    isCoAdmin, isScopedHR, hrTeamId, empCode, allowedModules,
    orgs, setOrgs: updateOrgs,
    pendingActions, setPendingActions: updatePendingActions,
    feedData, setFeedData: updateFeed,
    dashboardFlags, setDashboardFlags: updateDashboardFlags,
    applyAppData,
    clearOrganizationState,
    migrateOrganizationState,
    login, logout, saveAppData, loadAppData,
  };

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp() {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp must be used within AppProvider');
  return ctx;
}
