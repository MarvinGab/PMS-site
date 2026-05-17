import { useEffect, useState } from 'react';
import zaroLogo from '../../images/final zaro logo.png';
import '../admin.css';
import { useApp } from '../AppContext';
import {
  SUPER_ADMIN_EMAIL, SUPER_ADMIN_PASS,
} from '../AppContext';
import { resolveLoginUser, changeEmployeePassword } from '../backend/authService';
import { hydrateOrganizations, persistEmployeeSession } from '../backend/stateStore';
import {
  loginWithServerSession,
  changePasswordOnServer,
  requestPasswordReset,
  confirmPasswordReset,
} from '../backend/serverAuth';
import { resolveTenantContext } from '../backend/tenantResolver';

const REMEMBER_KEY = 'zaro.login.remembered';

// Every login should drop a user straight onto the home tab (My Goals,
// or My Team Goals for managers without goals). Clearing the persisted
// active-section key on login resets the EmployeePage to its default
// landing instead of restoring whatever tab was open last sign-out.
function clearEmployeeActiveSection(orgKey, empCode) {
  try {
    localStorage.removeItem(`zarohr_emp_active_section:${orgKey || 'default'}:${empCode || 'anon'}`);
  } catch { /* ignore */ }
}

const ROTATING_WORDS = ['clear.', 'structured.', 'actionable.', 'on time.'];

function getLoginPrefillIdentifier() {
  if (typeof window === 'undefined') return '';
  try {
    const params = new URLSearchParams(window.location.search || '');
    return String(params.get('login') || params.get('email') || params.get('identifier') || '').trim();
  } catch {
    return '';
  }
}

function normalizeWorkspaceInput(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^pms\.zarohr\.com\//, '')
    .replace(/^www\./, '')
    .replace(/[#?].*$/, '')
    .replace(/\/+$/, '')
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function getWorkspaceSlugFromTenant(tenant) {
  return normalizeWorkspaceInput(tenant?.workspaceSlug || '');
}

function getScopedRouteUrl(tenant, hash) {
  if (typeof window === 'undefined') return `#${hash}`;
  const slug = getWorkspaceSlugFromTenant(tenant);
  if (!slug) return `#${hash}`;
  const current = window.location;
  return `${current.origin}/${slug}#${hash}`;
}

function getPlatformRouteUrl(hash) {
  if (typeof window === 'undefined') return `#${hash}`;
  return `${window.location.origin}/#${hash}`;
}

function RightPanel() {
  const [wordIdx, setWordIdx] = useState(0);
  useEffect(() => {
    const id = setInterval(
      () => setWordIdx((i) => (i + 1) % ROTATING_WORDS.length),
      2400,
    );
    return () => clearInterval(id);
  }, []);

  return (
    <div className="login-right">
      <div className="login-right-blob b1"></div>
      <div className="login-right-blob b2"></div>
      <div className="login-right-blob b3"></div>
      <div className="login-right-blob b4"></div>
      <div className="login-right-grid"></div>

      <div className="login-chip c1">
        <span className="login-chip-dot"></span>
        Goals submitted
      </div>
      <div className="login-chip c2">Cycle on track ↗</div>
      <div className="login-chip c3">
        <span className="login-chip-dot"></span>
        Reviews approved
      </div>
      <div className="login-chip c4">8 managers active today</div>

      <div className="login-right-content anim-fadein">
        <h2 className="login-right-title">
          Performance management,<br />
          finally{' '}
          <span className="login-rotator">
            <span key={wordIdx} className="login-rotator-word">
              {ROTATING_WORDS[wordIdx]}
            </span>
          </span>
        </h2>
        <p className="login-right-sub">
          Run performance cycles with clarity, structure, and confidence.
        </p>
      </div>
    </div>
  );
}

function ChangePasswordScreen({ pendingEmp, onComplete }) {
  const [newPwd, setNewPwd]           = useState('');
  const [confirmPwd, setConfirmPwd]   = useState('');
  const [showNew, setShowNew]         = useState(false);
  const [showConf, setShowConf]       = useState(false);
  const [error, setError]             = useState('');
  const [loading, setLoading]         = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    setLoading(true);

    if (String(newPwd || '').length < 6) {
      setError('New password must be at least 6 characters.');
      setLoading(false);
      return;
    }
    if (newPwd !== confirmPwd) {
      setError('Passwords do not match.');
      setLoading(false);
      return;
    }

    const lookup = pendingEmp.empCode || pendingEmp.credentialKey || pendingEmp.email || pendingEmp.userName;
    let result = await changePasswordOnServer({
      identifier: lookup,
      organizationKey: pendingEmp.orgKey || '',
      credentialKey: pendingEmp.credentialKey || pendingEmp.empCode || '',
      currentPassword: pendingEmp.tempPassword || '',
      newPassword: newPwd,
    });
    if (!result?.ok && /not configured|failed to contact/i.test(String(result?.error || ''))) {
      result = await changeEmployeePassword(lookup, pendingEmp.tempPassword || '', newPwd);
    }
    if (!result.ok) {
      setError(result.error || 'Something went wrong. Please try again.');
      setLoading(false);
      return;
    }
    onComplete(result);
  }

  const pwdWrap = { position: 'relative' };
  const toggleBtn = { position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', fontSize: 16, color: 'var(--ink-3)', padding: 0 };

  return (
    <div id="page-login">
      <div className="login-left">
        <div className="login-brand anim-fadeup">
          <div className="logo-wrap">
            <img src={zaroLogo} alt="Zaro HR logo" className="login-logo-icon" />
          </div>
        </div>

        <div className="anim-fadeup delay-1">
          <h1 className="login-heading">Set your password</h1>
          <p className="login-sub">
            You're logged in with a temporary password. Create a permanent one to continue.
          </p>
        </div>

        <form className="login-form anim-fadeup delay-3" onSubmit={handleSubmit}>
          <div className="form-group">
            <label className="lbl">New Password</label>
            <div className="pwd-wrap" style={pwdWrap}>
              <input
                type={showNew ? 'text' : 'password'}
                placeholder="Min. 6 characters"
                value={newPwd}
                onChange={e => setNewPwd(e.target.value)}
                autoComplete="new-password"
                required
                autoFocus
              />
              <button type="button" className="pwd-toggle" style={toggleBtn} onClick={() => setShowNew(p => !p)} tabIndex={-1}>
                {showNew ? '🙈' : '👁'}
              </button>
            </div>
          </div>

          <div className="form-group">
            <label className="lbl">Confirm New Password</label>
            <div className="pwd-wrap" style={pwdWrap}>
              <input
                type={showConf ? 'text' : 'password'}
                placeholder="Repeat new password"
                value={confirmPwd}
                onChange={e => setConfirmPwd(e.target.value)}
                autoComplete="new-password"
                required
              />
              <button type="button" className="pwd-toggle" style={toggleBtn} onClick={() => setShowConf(p => !p)} tabIndex={-1}>
                {showConf ? '🙈' : '👁'}
              </button>
            </div>
          </div>

          {error && <div className="login-error">{error}</div>}

          <button
            type="submit"
            className="btn btn-primary btn-xl w-full mt-8"
            disabled={loading}
          >
            {loading ? 'Saving…' : 'Set Password & Continue →'}
          </button>
        </form>

        <p className="login-help anim-fadeup delay-4">
          Need help? Contact your HR Admin.
        </p>
      </div>

      <RightPanel />
    </div>
  );
}

function ForgotPasswordPanel({ initialIdentifier = '', tenant, onBack, onSuccess }) {
  const [step, setStep] = useState('request'); // 'request' | 'confirm'
  const [identifier, setIdentifier] = useState(initialIdentifier);
  const [code, setCode] = useState('');
  const [newPwd, setNewPwd] = useState('');
  const [confirmPwd, setConfirmPwd] = useState('');
  const [showPwd, setShowPwd] = useState(false);
  const [busy, setBusy] = useState(false);
  const [info, setInfo] = useState('');
  const [error, setError] = useState('');

  function formatCodeDisplay(raw) {
    const digits = String(raw || '').replace(/[^0-9]/g, '').slice(0, 6);
    return digits.length > 3 ? `${digits.slice(0, 3)}-${digits.slice(3)}` : digits;
  }

  if (!tenant?.orgKey) {
    return (
      <div className="login-inline-panel anim-fadeup delay-3">
        <div className="login-workspace-badge">Reset password</div>
        <h1 className="login-heading login-heading-sm">Use your company login link</h1>
        <p className="login-sub">
          Password reset works only inside a workspace login URL. Open the sign-in link from your welcome email and try again from there.
        </p>
        <button type="button" className="btn btn-primary btn-xl w-full mt-8" onClick={onBack}>
          Back to sign in
        </button>
      </div>
    );
  }

  async function handleRequest(e) {
    e.preventDefault();
    setError('');
    setInfo('');
    if (!identifier.trim()) {
      setError('Enter your email or employee ID.');
      return;
    }
    setBusy(true);
    const result = await requestPasswordReset(identifier, tenant.orgKey);
    setBusy(false);
    if (!result?.ok) {
      const rawError = String(result?.error || '');
      if (rawError.includes('Reset email cannot be sent')) {
        setError('Password reset email is not available for this workspace right now. Contact your HR Admin to reset your password manually.');
      } else {
        setError(result?.error || 'Could not send reset code. Try again.');
      }
      return;
    }
    setInfo(`A 6-digit code was sent${result.maskedEmail ? ` to ${result.maskedEmail}` : ''}. It expires in 15 minutes.`);
    setStep('confirm');
  }

  async function handleConfirm(e) {
    e.preventDefault();
    setError('');
    const digits = code.replace(/[^0-9]/g, '');
    if (digits.length !== 6) {
      setError('Enter the 6-digit code.');
      return;
    }
    if (newPwd.length < 6) {
      setError('Password must be at least 6 characters.');
      return;
    }
    if (newPwd !== confirmPwd) {
      setError('Passwords do not match.');
      return;
    }
    setBusy(true);
    const result = await confirmPasswordReset(identifier, tenant.orgKey, digits, newPwd);
    setBusy(false);
    if (!result?.ok) {
      setError(result?.error || 'Could not reset password.');
      return;
    }
    onSuccess?.(identifier);
  }

  return (
    <div className="login-inline-panel anim-fadeup delay-3">
      {step === 'request' && (
        <form className="login-form" onSubmit={handleRequest}>
          <div className="login-workspace-badge">Reset password · {tenant.orgName || 'workspace'}</div>
          <h1 className="login-heading login-heading-sm">Forgot your password?</h1>
          <p className="login-sub">
            Enter your email or employee code. We’ll find your login email inside this workspace and send a 6-digit verification code there.
          </p>
          <div className="form-group">
            <label className="lbl">Email or Employee Code</label>
            <input
              type="text"
              value={identifier}
              onChange={(e) => setIdentifier(e.target.value)}
              placeholder="you@company.com or employee code"
              autoFocus
              required
            />
          </div>
          {error && <div className="login-error">{error}</div>}
          <button type="submit" className="btn btn-primary btn-xl w-full mt-8" disabled={busy}>
            {busy ? 'Sending…' : 'Send code'}
          </button>
          <button type="button" className="login-inline-back" onClick={onBack}>
            ← Back to sign in
          </button>
        </form>
      )}

      {step === 'confirm' && (
        <form className="login-form" onSubmit={handleConfirm}>
          <div className="login-workspace-badge">Reset password</div>
          <h1 className="login-heading login-heading-sm">Enter your code</h1>
          {info && <div className="login-success">{info}</div>}
          <div className="form-group">
            <label className="lbl">6-digit Code</label>
            <input
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              className="login-otp-input"
              value={formatCodeDisplay(code)}
              onChange={(e) => setCode(e.target.value.replace(/[^0-9]/g, '').slice(0, 6))}
              placeholder="000-000"
              maxLength={7}
              autoFocus
              required
            />
          </div>
          <div className="form-group">
            <label className="lbl">New Password</label>
            <div className="pwd-wrap">
              <input
                type={showPwd ? 'text' : 'password'}
                value={newPwd}
                onChange={(e) => setNewPwd(e.target.value)}
                placeholder="Min. 6 characters"
                autoComplete="new-password"
                required
              />
              <button type="button" className="pwd-toggle" onClick={() => setShowPwd((p) => !p)} tabIndex={-1}>
                {showPwd ? '🙈' : '👁'}
              </button>
            </div>
          </div>
          <div className="form-group">
            <label className="lbl">Confirm New Password</label>
            <input
              type={showPwd ? 'text' : 'password'}
              value={confirmPwd}
              onChange={(e) => setConfirmPwd(e.target.value)}
              placeholder="Repeat new password"
              autoComplete="new-password"
              required
            />
          </div>
          {error && <div className="login-error">{error}</div>}
          <button type="submit" className="btn btn-primary btn-xl w-full mt-8" disabled={busy}>
            {busy ? 'Updating…' : 'Update password'}
          </button>
          <button
            type="button"
            className="login-inline-back"
            onClick={() => { setStep('request'); setError(''); setInfo(''); setCode(''); }}
          >
            ← Start over
          </button>
        </form>
      )}
    </div>
  );
}

export default function LoginPage() {
  const { login, orgs } = useApp();
  const [identifier, setIdentifier] = useState(() => {
    const prefill = getLoginPrefillIdentifier();
    if (prefill) return prefill;
    try { return localStorage.getItem(REMEMBER_KEY) || ''; } catch { return ''; }
  });
  const [password, setPassword]     = useState('');
  const [showPwd, setShowPwd]       = useState(false);
  const [remember, setRemember]     = useState(() => {
    try { return !!localStorage.getItem(REMEMBER_KEY); } catch { return false; }
  });
  const [error, setError]           = useState('');
  const [loading, setLoading]       = useState(false);
  const [forcePwChange, setForcePwChange] = useState(false);
  const [pendingEmp, setPendingEmp]       = useState(null);
  const [pendingUserKind, setPendingUserKind] = useState(null); // 'employee' | 'hr-admin'
  const [forgotOpen, setForgotOpen] = useState(false);
  const [resetBanner, setResetBanner] = useState('');
  const [tenant, setTenant] = useState(null);
  const [workspaceInput, setWorkspaceInput] = useState('');
  const [step, setStep] = useState('credentials'); // 'credentials' | 'workspace'

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const ctx = await resolveTenantContext();
        if (!cancelled) setTenant(ctx);
      } catch { /* ignore */ }
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    const prefill = getLoginPrefillIdentifier();
    if (prefill) setIdentifier(prefill);
  }, []);

  async function resolveWorkspaceForLogin() {
    const token = normalizeWorkspaceInput(workspaceInput);
    if (!token) return null;

    const loadedOrgs = Array.isArray(orgs) && orgs.length > 0
      ? orgs
      : (await hydrateOrganizations()) || [];
    const matchedOrg = loadedOrgs.find((org) => {
      const slug = normalizeWorkspaceInput(org.workspaceSlug || '');
      const code = normalizeWorkspaceInput(org.orgCode || '');
      const key = normalizeWorkspaceInput(org.key || '');
      return token === slug || token === code || token === key;
    });
    if (matchedOrg?.key) {
      return {
        orgKey: matchedOrg.key,
        orgName: matchedOrg.name || '',
        workspaceSlug: normalizeWorkspaceInput(matchedOrg.workspaceSlug || matchedOrg.orgCode || matchedOrg.key || token),
        matchedBy: 'workspace_input',
      };
    }

    const ctx = await resolveTenantContext({
      hostname: typeof window !== 'undefined' ? window.location.hostname : '',
      pathname: `/${token}`,
    });
    return ctx?.orgKey ? ctx : null;
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    setLoading(true);

    let loginTenant = tenant;
    let workspaceToken = '';

    // If the user has typed a workspace (either because they're already on
    // the workspace step, or they prefilled it), resolve it to an org now so
    // we can pass an explicit orgKey to the server.
    if (workspaceInput.trim()) {
      workspaceToken = normalizeWorkspaceInput(workspaceInput);
      const resolved = await resolveWorkspaceForLogin();
      if (resolved?.orgKey) {
        loginTenant = resolved;
        setTenant(resolved);
      } else {
        loginTenant = { workspaceSlug: workspaceToken };
      }
    }

    const serverAuthResult = await loginWithServerSession(
      identifier,
      password,
      loginTenant?.orgKey || '',
      remember,
      workspaceToken || loginTenant?.workspaceSlug || '',
    );

    // Helper: did the server tell us this account needs a workspace? We don't
    // pre-detect super-admin attempts client-side anymore (that depended on
    // VITE_SUPER_ADMIN_EMAIL matching the server's APP_AUTH_SUPER_ADMIN_EMAIL,
    // which is a fragile coupling) — instead we just submit and let the
    // server be the source of truth on who needs a workspace.
    function serverSaysNeedsWorkspace(result) {
      if (!result || result.ok !== false) return false;
      if (String(result.code || '') === 'org-user-needs-workspace-url') return true;
      return /sign in from your workspace url/i.test(String(result.error || ''));
    }

    let user = null;
    if (serverAuthResult?.ok && serverAuthResult?.user) {
      user = {
        ...serverAuthResult.user,
        serverSessionToken: serverAuthResult.serverSessionToken || null,
      };
    } else if (serverAuthResult?.ok === false) {
      const errText = String(serverAuthResult.error || '');
      const backendUnavailable = /not configured|failed to contact/i.test(errText);
      if (!backendUnavailable) {
        // Server reachable. If it asked for a workspace and we haven't
        // collected one yet, advance to the workspace step instead of
        // bouncing the user with an error.
        if (serverSaysNeedsWorkspace(serverAuthResult) && step === 'credentials' && !workspaceInput.trim()) {
          setStep('workspace');
          setLoading(false);
          return;
        }
        setError(errText || 'Invalid credentials.');
        setLoading(false);
        return;
      }
      // Backend unreachable — fall through to the local resolver.
      user = await resolveLoginUser(identifier, password, {
        email: SUPER_ADMIN_EMAIL,
        password: SUPER_ADMIN_PASS,
      }, loginTenant?.orgKey || '');
    } else {
      user = await resolveLoginUser(identifier, password, {
        email: SUPER_ADMIN_EMAIL,
        password: SUPER_ADMIN_PASS,
      }, loginTenant?.orgKey || '');
    }
    if (!user) {
      setError('Invalid credentials. Check your email / employee code and password.');
      setLoading(false);
      return;
    }
    if (user.__scopeError === 'org-user-needs-workspace-url') {
      // Same escalation behavior for the local fallback path — show the
      // workspace prompt instead of dead-ending with an error message.
      if (step === 'credentials' && !workspaceInput.trim()) {
        setStep('workspace');
        setLoading(false);
        return;
      }
      setError('Enter your company workspace to continue.');
      setLoading(false);
      return;
    }

    // Defensive isTemp detection only applies when the server itself didn't
    // identify a credential record. Once a permanent password exists, the
    // server already signaled isTemp:false — overriding that here would
    // force a needless password reset every login and silently clobber the
    // admin's password via the change-password flow.
    if (!user.isTemp && !user.credentialKey && user.role === 'hr-admin' && user.orgKey) {
      const matchedOrg = (orgs || []).find((o) => o.key === user.orgKey);
      const orgTempPwd = String(matchedOrg?.temporaryPassword || '');
      if (orgTempPwd && orgTempPwd === password) {
        user = { ...user, isTemp: true, credentialKey: String(matchedOrg?.hrAdminEmail || '').toLowerCase() };
      }
    }

    try {
      if (remember) localStorage.setItem(REMEMBER_KEY, identifier.trim());
      else localStorage.removeItem(REMEMBER_KEY);
    } catch { /* ignore storage errors */ }

    if (user.role === 'employee') {
      if (user.isTemp) {
        setPendingEmp({ ...user, tempPassword: password, workspaceSlug: loginTenant?.workspaceSlug || '' });
        setPendingUserKind('employee');
        setForcePwChange(true);
        setLoading(false);
        return;
      }
      persistEmployeeSession({
        empCode: user.empCode,
        name: user.userName,
        designation: user.designation,
        managerCode: user.managerCode,
        orgKey: user.orgKey || '',
      });
      clearEmployeeActiveSection(user.orgKey, user.empCode);
      login('employee', { userName: user.userName });
      const targetTenant = loginTenant?.orgKey ? loginTenant : { ...loginTenant, workspaceSlug: loginTenant?.workspaceSlug || user.workspaceSlug };
      const routeUrl = getScopedRouteUrl(targetTenant, 'employee');
      if (routeUrl.startsWith('#')) window.location.hash = '#employee';
      else window.location.assign(routeUrl);
    } else if (user.role === 'hr-admin') {
      if (user.isTemp) {
        setPendingEmp({ ...user, tempPassword: password, workspaceSlug: loginTenant?.workspaceSlug || '' });
        setPendingUserKind('hr-admin');
        setForcePwChange(true);
        setLoading(false);
        return;
      }
      login('hr-admin', {
        orgKey: user.orgKey,
        userName: user.userName,
        isCoAdmin: !!user.isCoAdmin,
        isScopedHR: !!user.isScopedHR,
        hrTeamId: user.hrTeamId || null,
        empCode: user.empCode || null,
        allowedModules: user.allowedModules || null,
        serverSessionToken: user.serverSessionToken || null,
      });
      const targetTenant = loginTenant?.orgKey ? loginTenant : { ...loginTenant, workspaceSlug: loginTenant?.workspaceSlug || user.workspaceSlug };
      const routeUrl = getScopedRouteUrl(targetTenant, 'hr-home');
      if (routeUrl.startsWith('#')) window.location.hash = '#hr-home';
      else window.location.assign(routeUrl);
    } else {
      login('super-admin', { userName: user.userName, serverSessionToken: user.serverSessionToken || null });
      window.location.assign(getPlatformRouteUrl('organizations'));
    }
  }

  async function openForgotPassword() {
    setError('');
    if (tenant?.orgKey) {
      setForgotOpen(true);
      return;
    }
    if (!workspaceInput.trim()) {
      if (step === 'credentials') {
        setStep('workspace');
        return;
      }
      setError('Enter your company workspace before resetting your password.');
      return;
    }
    setLoading(true);
    const resolved = await resolveWorkspaceForLogin();
    setLoading(false);
    if (!resolved?.orgKey) {
      setError('Workspace not found. Check the company slug or code from your HR invite.');
      return;
    }
    setTenant(resolved);
    setForgotOpen(true);
  }

  if (forcePwChange && pendingEmp) {
    return (
      <ChangePasswordScreen
        pendingEmp={pendingEmp}
        onComplete={(passwordChangeResult) => {
          const serverSessionToken = passwordChangeResult?.serverSessionToken || pendingEmp.serverSessionToken || null;
          if (pendingUserKind === 'hr-admin') {
            login('hr-admin', {
              orgKey: pendingEmp.orgKey,
              userName: pendingEmp.userName,
              isCoAdmin: !!pendingEmp.isCoAdmin,
              isScopedHR: !!pendingEmp.isScopedHR,
              hrTeamId: pendingEmp.hrTeamId || null,
              empCode: pendingEmp.empCode || null,
              allowedModules: pendingEmp.allowedModules || null,
              serverSessionToken,
            });
            const routeUrl = getScopedRouteUrl(pendingEmp, 'hr-home');
            if (routeUrl.startsWith('#')) window.location.hash = '#hr-home';
            else window.location.assign(routeUrl);
            return;
          }
          persistEmployeeSession({
            empCode: pendingEmp.empCode,
            name: pendingEmp.userName,
            designation: pendingEmp.designation,
            managerCode: pendingEmp.managerCode,
            orgKey: pendingEmp.orgKey || '',
          });
          clearEmployeeActiveSection(pendingEmp.orgKey, pendingEmp.empCode);
          login('employee', { userName: pendingEmp.userName, serverSessionToken });
          const routeUrl = getScopedRouteUrl(pendingEmp, 'employee');
          if (routeUrl.startsWith('#')) window.location.hash = '#employee';
          else window.location.assign(routeUrl);
        }}
      />
    );
  }

  return (
    <div id="page-login">
      {/* LEFT PANEL */}
      <div className="login-left">
        <div className="login-brand anim-fadeup">
          <div className="logo-wrap">
            <img src={zaroLogo} alt="Zaro HR logo" className="login-logo-icon" />
          </div>
        </div>

        <div className="anim-fadeup delay-1">
          {tenant?.orgName && (
            <div className="login-workspace-badge">{tenant.orgName} workspace</div>
          )}
          <h1 className="login-heading">
            {step === 'workspace' ? 'One more step' : 'Welcome back'}
          </h1>
          <p className="login-sub">
            {step === 'workspace'
              ? 'Enter your company workspace to finish signing in.'
              : tenant?.orgName
                ? `Sign in to ${tenant.orgName} to continue.`
                : 'Sign in to continue.'}
          </p>
        </div>

        {!forgotOpen && step === 'credentials' ? (
        <form className="login-form anim-fadeup delay-3" onSubmit={handleSubmit}>
          <div className="form-group">
            <label className="lbl">Email or Employee Code</label>
            <input
              type="text"
              placeholder="you@company.com or employee code"
              value={identifier}
              onChange={e => setIdentifier(e.target.value)}
              autoComplete="off"
              required
              autoFocus
            />
          </div>

          <div className="form-group">
            <label className="lbl">Password</label>
            <div className="pwd-wrap">
              <input
                type={showPwd ? 'text' : 'password'}
                placeholder="Enter password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                autoComplete="off"
                required
              />
              <button
                type="button"
                className="pwd-toggle"
                onClick={() => setShowPwd(p => !p)}
                tabIndex={-1}
              >
                {showPwd ? '🙈' : '👁'}
              </button>
            </div>
          </div>

          <div className="flex justify-between items-center login-meta-row">
            <label className="flex items-center gap-8" style={{ cursor: 'pointer', fontSize: '12.5px', color: 'var(--ink-3)' }}>
              <input
                type="checkbox"
                checked={remember}
                onChange={(e) => setRemember(e.target.checked)}
                style={{ width: 'auto' }}
              />
              {' '}Remember me
            </label>
            <button
              type="button"
              className="login-forgot login-forgot-btn"
              onClick={openForgotPassword}
            >
              Forgot password?
            </button>
          </div>

          {resetBanner && <div className="login-success">{resetBanner}</div>}
          {error && <div className="login-error">{error}</div>}

          <button
            type="submit"
            className="btn btn-primary btn-xl w-full mt-8"
            disabled={loading}
          >
            {loading ? 'Signing in…' : 'Sign In'}
          </button>
        </form>
        ) : !forgotOpen && step === 'workspace' ? (
        <form className="login-form anim-fadeup delay-3" onSubmit={handleSubmit}>
          <div className="form-group">
            <label className="lbl">Workspace</label>
            <input
              type="text"
              placeholder="company-slug or company code"
              value={workspaceInput}
              onChange={e => {
                setWorkspaceInput(e.target.value);
                if (error) setError('');
              }}
              autoComplete="organization"
              autoFocus
              required
            />
            <div style={{ marginTop: 6, fontSize: 12, color: 'var(--ink-3)', lineHeight: 1.45 }}>
              Find this in your HR welcome email — it's the company slug or code for your workspace.
            </div>
          </div>

          {error && <div className="login-error">{error}</div>}

          <button
            type="submit"
            className="btn btn-primary btn-xl w-full mt-8"
            disabled={loading}
          >
            {loading ? 'Signing in…' : 'Sign In'}
          </button>

          <button
            type="button"
            className="login-inline-back"
            onClick={() => { setStep('credentials'); setError(''); }}
          >
            ← Back
          </button>

          <div className="flex justify-end items-center login-meta-row" style={{ marginTop: 8 }}>
            <button
              type="button"
              className="login-forgot login-forgot-btn"
              onClick={openForgotPassword}
            >
              Forgot password?
            </button>
          </div>
        </form>
        ) : (
          <ForgotPasswordPanel
            initialIdentifier={identifier}
            tenant={tenant}
            onBack={() => {
              setForgotOpen(false);
              setError('');
            }}
            onSuccess={(usedIdentifier) => {
              setForgotOpen(false);
              setStep('credentials');
              setIdentifier(usedIdentifier || identifier);
              setPassword('');
              setResetBanner('Password updated. Sign in with your new password.');
              setError('');
            }}
          />
        )}

        <p className="login-help anim-fadeup delay-4">
          Need access? Contact your HR Admin.
        </p>
      </div>

      <RightPanel />
    </div>
  );
}
