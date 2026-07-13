import { useState, useEffect, Component, lazy, Suspense } from 'react';
import { AppProvider, useApp } from './AppContext';
import { readWizardStateSync, syncEmployeeCredentialsForOrg } from './backend/stateStore';
import { logAuditEvent } from './backend/auditLog';
import { SESSION_TIMEOUT_EVENT } from './backend/sessionTimeout';
import LoginPage from './pages/LoginPage';
import DashboardPage from './pages/DashboardPage';
import OrganizationsPage from './pages/OrganizationsPage';
import SuperAdminCommsPage from './pages/SuperAdminCommsPage';
import CreateOrgPage from './pages/CreateOrgPage';
import EmployeePage from './pages/EmployeePage';

const EMP_CREDENTIALS_KEY = 'zarohr_emp_credentials';

const PMSWizard = lazy(() => import('./PMSWizard'));
const HRCycleDashboard = lazy(() => import('./pages/HRCycleDashboard'));
const SelfEvalPage = lazy(() => import('./pages/SelfEvalPage'));
const ManagerEvalPage = lazy(() => import('./pages/ManagerEvalPage'));
const HRReviewPage = lazy(() => import('./pages/HRReviewPage'));

class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, info) {
    console.error('[ErrorBoundary] Caught render error:', error, info?.componentStack);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{
          minHeight: '100vh', display: 'flex', flexDirection: 'column',
          alignItems: 'center', justifyContent: 'center',
          background: '#F8FAFC', padding: '40px 20px', fontFamily: 'Inter, sans-serif',
        }}>
          <div style={{
            background: '#fff', border: '1px solid #E2E8F0', borderRadius: '12px',
            padding: '40px 48px', maxWidth: '480px', width: '100%', textAlign: 'center',
            boxShadow: '0 4px 24px rgba(0,0,0,0.06)',
          }}>
            <div style={{ fontSize: '40px', marginBottom: '16px' }}>⚠️</div>
            <h2 style={{ margin: '0 0 8px', fontSize: '20px', fontWeight: '700', color: '#0F172A' }}>
              Something went wrong
            </h2>
            <p style={{ margin: '0 0 24px', fontSize: '14px', color: '#64748B', lineHeight: '1.6' }}>
              An unexpected error occurred. Your data is safe — try reloading the page to continue.
            </p>
            {this.state.error?.message && (
              <div style={{
                background: '#FEF2F2', border: '1px solid #FCA5A5', borderRadius: '8px',
                padding: '10px 14px', marginBottom: '24px', textAlign: 'left',
                fontSize: '12px', color: '#991B1B', fontFamily: 'monospace', wordBreak: 'break-word',
              }}>
                {this.state.error.message}
              </div>
            )}
            <button
              onClick={() => { this.setState({ hasError: false, error: null }); window.location.hash = '#login'; }}
              style={{
                background: '#2563EB', color: '#fff', border: 'none', borderRadius: '8px',
                padding: '10px 24px', fontSize: '14px', fontWeight: '600', cursor: 'pointer',
                marginRight: '10px',
              }}
            >
              Go to Login
            </button>
            <button
              onClick={() => window.location.reload()}
              style={{
                background: '#F1F5F9', color: '#334155', border: '1px solid #E2E8F0', borderRadius: '8px',
                padding: '10px 24px', fontSize: '14px', fontWeight: '600', cursor: 'pointer',
              }}
            >
              Reload Page
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

function getRoute() {
  return window.location.hash.replace(/^#/, '').split('?')[0] || '';
}

function BootScreen() {
  return (
    <div style={{
      minHeight: '100vh',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      background: 'linear-gradient(180deg, #F8FAFC 0%, #EEF2FF 100%)',
      padding: '32px',
      fontFamily: "'Geist','Inter','Segoe UI',Arial,sans-serif",
    }}>
      <div style={{
        width: '100%',
        maxWidth: '420px',
        background: 'rgba(255,255,255,0.92)',
        border: '1px solid #E2E8F0',
        borderRadius: '18px',
        padding: '28px 28px 24px',
        boxShadow: '0 20px 60px rgba(15, 23, 42, 0.08)',
        textAlign: 'center',
      }}>
        <div style={{ fontSize: 28, fontWeight: 800, color: '#0F172A', letterSpacing: '-0.03em', marginBottom: 10 }}>
          Zaro <span style={{ color: '#FFBF00' }}>HR</span>
        </div>
        <div style={{ fontSize: 14, color: '#64748B', marginBottom: 18 }}>
          Loading your workspace…
        </div>
        <div style={{
          height: 8,
          borderRadius: 999,
          background: '#E5E7EB',
          overflow: 'hidden',
        }}>
          <div style={{
            width: '48%',
            height: '100%',
            borderRadius: 999,
            background: 'linear-gradient(90deg, #2563EB 0%, #4F46E5 100%)',
          }} />
        </div>
      </div>
    </div>
  );
}

function SessionTimeoutModal({ onCancel, onSignIn }) {
  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.key === 'Escape') onCancel?.();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onCancel]);

  return (
    <div
      role="presentation"
      onMouseDown={onCancel}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 10000,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '24px',
        background: 'rgba(15, 23, 42, 0.38)',
        backdropFilter: 'blur(9px)',
        WebkitBackdropFilter: 'blur(9px)',
        fontFamily: "'Geist','Inter','Segoe UI',Arial,sans-serif",
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="session-timeout-title"
        aria-describedby="session-timeout-message"
        onMouseDown={(event) => event.stopPropagation()}
        style={{
          width: '100%',
          maxWidth: '430px',
          background: '#FFFFFF',
          border: '1px solid rgba(226, 232, 240, 0.95)',
          borderRadius: '18px',
          boxShadow: '0 28px 80px rgba(15, 23, 42, 0.28)',
          padding: '26px',
          color: '#0F172A',
        }}
      >
        <div style={{
          width: 46,
          height: 46,
          borderRadius: '14px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          marginBottom: '18px',
          background: 'linear-gradient(135deg, #EEF2FF 0%, #E0F2FE 100%)',
          border: '1px solid #DBEAFE',
          color: '#2563EB',
          fontSize: 24,
          fontWeight: 800,
        }}>
          !
        </div>
        <h2
          id="session-timeout-title"
          style={{
            margin: '0 0 8px',
            fontSize: '22px',
            lineHeight: 1.2,
            fontWeight: 800,
            letterSpacing: 0,
          }}
        >
          Session timed out
        </h2>
        <p
          id="session-timeout-message"
          style={{
            margin: '0 0 24px',
            fontSize: '15px',
            lineHeight: 1.55,
            color: '#64748B',
          }}
        >
          Please log in again to continue.
        </p>
        <div style={{
          display: 'flex',
          justifyContent: 'flex-end',
          gap: '10px',
          flexWrap: 'wrap',
        }}>
          <button
            type="button"
            onClick={onCancel}
            style={{
              minWidth: '96px',
              border: '1px solid #CBD5E1',
              borderRadius: '10px',
              background: '#FFFFFF',
              color: '#334155',
              padding: '10px 16px',
              fontSize: '14px',
              fontWeight: 700,
              cursor: 'pointer',
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onSignIn}
            style={{
              minWidth: '104px',
              border: '1px solid #2563EB',
              borderRadius: '10px',
              background: '#2563EB',
              color: '#FFFFFF',
              padding: '10px 16px',
              fontSize: '14px',
              fontWeight: 800,
              cursor: 'pointer',
              boxShadow: '0 10px 24px rgba(37, 99, 235, 0.28)',
            }}
          >
            Sign in
          </button>
        </div>
      </div>
    </div>
  );
}

function Router() {
  const { role, orgKey, orgs, authReady, setOrgs, userName, logout } = useApp();
  const [route, setRoute] = useState(getRoute);
  const [sessionModalOpen, setSessionModalOpen] = useState(false);

  useEffect(() => {
    const h = () => setRoute(getRoute());
    window.addEventListener('hashchange', h);
    return () => window.removeEventListener('hashchange', h);
  }, []);

  useEffect(() => {
    const show = () => setSessionModalOpen(true);
    window.addEventListener(SESSION_TIMEOUT_EVENT, show);
    return () => window.removeEventListener(SESSION_TIMEOUT_EVENT, show);
  }, []);

  useEffect(() => {
    // The employee route owns its own session (EMP_SESSION_KEY) independent of the app-level role,
    // so don't bounce refreshes on #employee to login based on the app-level role being empty.
    if (authReady && !role && route !== 'login' && route !== 'employee') {
      window.location.hash = '#login';
      setRoute('login');
    }
  }, [authReady, role, route]);

  const withSessionModal = (page) => (
    <>
      {page}
      {sessionModalOpen && (
        <SessionTimeoutModal
          onCancel={() => setSessionModalOpen(false)}
          onSignIn={() => {
            setSessionModalOpen(false);
            logout?.();
            window.location.hash = '#login';
            setRoute('login');
          }}
        />
      )}
    </>
  );

  if (!authReady) {
    return withSessionModal(<BootScreen />);
  }

  // Public routes (no auth needed)
  if (route === 'login') return withSessionModal(<LoginPage />);
  if (route === 'employee') return withSessionModal(<EmployeePage />);
  if (route === 'self-eval') return withSessionModal(<Suspense fallback={<BootScreen />}><SelfEvalPage /></Suspense>);
  if (route === 'manager-eval') return withSessionModal(<Suspense fallback={<BootScreen />}><ManagerEvalPage /></Suspense>);

  // Not logged in → redirect to login
  if (!role) {
    return withSessionModal(<LoginPage />);
  }

  // HR admin
  if (role === 'hr-admin') {
    if (route === 'hr-review') {
      return withSessionModal(<Suspense fallback={<BootScreen />}><HRReviewPage /></Suspense>);
    }
    const org = orgs.find((o) => o.key === orgKey);
    const orgName = org?.name || 'Assigned Organization';
    if (org?.launched) {
      return withSessionModal(<HRCycleDashboard />);
    }

    function handleLaunched() {
      const updated = orgs.map((o) =>
        o.key === orgKey
          ? {
              ...o,
              launched: true,
              setupStatus: 'launched',
              setupReopened: false,
              setupReopenedAt: null,
              setupReopenedBy: null,
              setupPct: 100,
              status: 'Active',
              statusBadgeClass: 'badge-green',
              actionLabel: 'Manage',
              setupColor: '#16A34A',
            }
          : o
      );
      setOrgs(updated);
      void logAuditEvent({
        orgKey: orgKey || '',
        actorRole: 'hr-admin',
        actorName: userName || 'HR Admin',
        actionType: 'setup-launched',
        targetType: 'organization',
        targetCode: orgKey || '',
      });

      const org = orgs.find((o) => o.key === orgKey);
      const tempPass = org?.temporaryPassword;
      if (tempPass) {
        const wizardState = readWizardStateSync(orgKey);
        const employees = wizardState?.config?.employeeUploadData?.employees || [];
        if (employees.length > 0) {
          void syncEmployeeCredentialsForOrg({
            orgKey: orgKey || '',
            tempPassword: tempPass,
            employees,
          });
        }
      }
    }

    return withSessionModal(<PMSWizard orgKeyOverride={orgKey || ''} orgNameOverride={orgName} onLaunched={handleLaunched} />);
  }

  // Employee route (logged in as employee)
  if (role === 'employee') return withSessionModal(<EmployeePage />);

  // Super admin routes
  if (route === 'create-org' || route === 'edit-org') return withSessionModal(<CreateOrgPage />);
  if (route === 'organizations') return withSessionModal(<OrganizationsPage />);
  if (route === 'super-comms') return withSessionModal(<SuperAdminCommsPage />);

  // Keep #dashboard as compatibility, but use the organizations-first admin surface
  if (route === 'dashboard') return withSessionModal(<OrganizationsPage />);

  // Default for super admin
  return withSessionModal(<OrganizationsPage />);
}

export default function App() {
  return (
    <ErrorBoundary>
      <AppProvider>
        <ErrorBoundary>
          <Suspense fallback={<BootScreen />}>
            <Router />
          </Suspense>
        </ErrorBoundary>
      </AppProvider>
    </ErrorBoundary>
  );
}
