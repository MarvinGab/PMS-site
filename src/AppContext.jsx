import { createContext, useContext, useState, useEffect, useCallback } from 'react';

export const SESSION_KEY        = 'zarohr_auth_session';
export const APP_DATA_KEY       = 'zarohr_app_data_v1';
export const EMP_CREDENTIALS_KEY = 'zarohr_emp_credentials';
export const EMP_SESSION_KEY    = 'zarohr_emp_session';

export const SUPER_ADMIN_EMAIL = 'admin@zarohr.com';
export const SUPER_ADMIN_PASS  = 'admin123';

const DEFAULT_ORGS = [
  {
    key: 'acme',
    orgCode: 'ACME',
    name: 'Acme Technologies',
    domain: 'acme.zarohr.com',
    industry: 'IT / Software',
    industryBadgeClass: 'badge-blue',
    employees: 412,
    seats: 500,
    setupPct: 100,
    setupColor: '#16A34A',
    status: 'Active',
    statusBadgeClass: 'badge-green',
    actionLabel: 'Manage',
    logoText: 'A',
    logoBg: 'linear-gradient(135deg,#3B6FF0,#6366f1)',
    hrAdminName: 'Priya Sharma',
    hrAdminEmail: 'hr@acme.com',
    temporaryPassword: 'Acme@2024',
    selectedModules: ['Performance Management', 'Goal Management', '360 Feedback'],
    pmsCalendar: 'April–March',
    estimatedCompanySize: '201-500',
    legalEntityType: 'Private Limited',
    headquartersCountry: 'India',
    operatingCountries: ['India', 'United States'],
    workspaceSlug: 'acme',
    setupFormSnapshot: {},
  },
  {
    key: 'nova',
    orgCode: 'NOVA',
    name: 'Nova Pharma Ltd.',
    domain: 'nova.zarohr.com',
    industry: 'Healthcare',
    industryBadgeClass: 'badge-green',
    employees: 285,
    seats: 400,
    setupPct: 60,
    setupColor: '#D97706',
    status: 'Setup',
    statusBadgeClass: 'badge-amber',
    actionLabel: 'Continue',
    logoText: 'N',
    logoBg: 'linear-gradient(135deg,#16A34A,#059669)',
    hrAdminName: 'Rahul Mehta',
    hrAdminEmail: 'hr@nova.com',
    temporaryPassword: 'Nova@2024',
    selectedModules: ['Performance Management', 'Goal Management'],
    pmsCalendar: 'January–December',
    estimatedCompanySize: '201-500',
    legalEntityType: 'Public Limited',
    headquartersCountry: 'India',
    operatingCountries: ['India'],
    workspaceSlug: 'nova',
    setupFormSnapshot: {},
  },
  {
    key: 'zenith',
    orgCode: 'ZENITH',
    name: 'Zenith Capital',
    domain: 'zenith.zarohr.com',
    industry: 'BFSI',
    industryBadgeClass: 'badge-amber',
    employees: 150,
    seats: 300,
    setupPct: 20,
    setupColor: '#2563EB',
    status: 'Pending',
    statusBadgeClass: 'badge-blue',
    actionLabel: 'Continue',
    logoText: 'Z',
    logoBg: 'linear-gradient(135deg,#D97706,#f59e0b)',
    hrAdminName: 'Anita Patel',
    hrAdminEmail: 'hr@zenith.com',
    temporaryPassword: 'Zenith@2024',
    selectedModules: ['Performance Management'],
    pmsCalendar: 'April–March',
    estimatedCompanySize: '101-200',
    legalEntityType: 'Private Limited',
    headquartersCountry: 'India',
    operatingCountries: ['India'],
    workspaceSlug: 'zenith',
    setupFormSnapshot: {},
  },
];

const DEFAULT_PENDING_ACTIONS = [
  { orgKey: 'acme',   text: 'License overage - Acme' },
  { orgKey: 'zenith', text: 'HR invite pending - Zenith' },
  { orgKey: 'nova',   text: 'Failed import - Nova' },
  { orgKey: 'nova',   text: 'Approve module request' },
];

const DEFAULT_FEED_DATA = [
  { orgKey:'zenith', bg:'#EEF3FE', ic:'🏢', text:'<strong>Zenith Capital</strong> organization was created and HR Admin invite sent.', time:'2 hours ago' },
  { orgKey:'nova',   bg:'#FEF2F2', ic:'⚠️', text:'<strong>Failed import</strong> detected for Nova Pharma — 23 rows with validation errors.', time:'4 hours ago' },
  { orgKey:'acme',   bg:'#F0FDF4', ic:'✅', text:'<strong>Acme Technologies</strong> completed full PMS setup. First review cycle is active.', time:'Yesterday, 3:42 PM' },
  { orgKey:'acme',   bg:'#FFFBEB', ic:'💳', text:'License for <strong>Acme Technologies</strong> auto-renewed. 500 seats confirmed.', time:'Yesterday, 11:20 AM' },
];

const DEFAULT_DASHBOARD_FLAGS = { licenseOverageOrgKey: 'acme', hasCriticalIssue: false };

export const AppContext = createContext(null);

// Read auth session synchronously so first render already knows who's logged in
function readSessionSync() {
  try {
    const raw = localStorage.getItem(SESSION_KEY) || sessionStorage.getItem(SESSION_KEY);
    if (raw) {
      const s = JSON.parse(raw);
      if (s.isLoggedIn && s.role) return s;
    }
  } catch (_) {}
  return null;
}

// Read persisted app data synchronously for first render
function readAppDataSync() {
  try {
    const raw = localStorage.getItem(APP_DATA_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (_) {
    return null;
  }
}

export function AppProvider({ children }) {
  // Read session and app data ONCE to avoid inconsistent state from repeated localStorage reads
  const initialSession = readSessionSync();
  const initialAppData = readAppDataSync();

  const [role, setRole]       = useState(initialSession?.role || null);
  const [orgKey, setOrgKey]   = useState(initialSession?.orgKey || null);
  const [userName, setUserName] = useState(initialSession?.userName || '');
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

  // No longer need the useEffect for initial data load — kept only as a no-op to avoid breaking hooks order
  useEffect(() => {
    // intentionally empty — data is now loaded synchronously above
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function loadAppData() {
    try {
      const raw = localStorage.getItem(APP_DATA_KEY);
      if (!raw) return;
      const data = JSON.parse(raw);
      if (data.dashboardFlags) setDashboardFlags({ ...DEFAULT_DASHBOARD_FLAGS, ...data.dashboardFlags });
      if (Array.isArray(data.pendingActionsData)) setPendingActions(data.pendingActionsData);
      if (Array.isArray(data.feedData)) setFeedData(data.feedData);
      if (Array.isArray(data.organizationsData)) setOrgs(data.organizationsData);
    } catch (_) {}
  }

  const saveAppData = useCallback((overrides = {}) => {
    try {
      // Read current saved state first so a partial update never wipes unrelated fields
      let base = {};
      try {
        const raw = localStorage.getItem(APP_DATA_KEY);
        if (raw) base = JSON.parse(raw);
      } catch (_) {}
      localStorage.setItem(APP_DATA_KEY, JSON.stringify({
        dashboardFlags:     overrides.dashboardFlags  ?? base.dashboardFlags     ?? dashboardFlags,
        pendingActionsData: overrides.pendingActions  ?? base.pendingActionsData ?? pendingActions,
        feedData:           overrides.feedData        ?? base.feedData           ?? feedData,
        organizationsData:  overrides.orgs            ?? base.organizationsData  ?? orgs,
      }));
    } catch (_) {}
  }, [dashboardFlags, pendingActions, feedData, orgs]);

  function login(loginRole, data = {}) {
    setRole(loginRole);
    setOrgKey(data.orgKey || null);
    setUserName(data.userName || '');
    try {
      const payload = JSON.stringify({ isLoggedIn: true, role: loginRole, orgKey: data.orgKey || null, userName: data.userName || '' });
      localStorage.setItem(SESSION_KEY, payload);
      sessionStorage.setItem(SESSION_KEY, payload);
    } catch (_) {}
  }

  function logout() {
    setRole(null);
    setOrgKey(null);
    setUserName('');
    try {
      localStorage.removeItem(SESSION_KEY);
      sessionStorage.removeItem(SESSION_KEY);
    } catch (_) {}
  }

  function updateOrgs(nextOrgs) {
    setOrgs(nextOrgs);
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

  const value = {
    role, orgKey, userName, authReady,
    orgs, setOrgs: updateOrgs,
    pendingActions, setPendingActions: updatePendingActions,
    feedData, setFeedData: updateFeed,
    dashboardFlags, setDashboardFlags: updateDashboardFlags,
    login, logout, saveAppData, loadAppData,
  };

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp() {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp must be used within AppProvider');
  return ctx;
}
