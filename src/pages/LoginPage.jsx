import { useState } from 'react';
import zaroLogo from '../../images/final zaro logo.png';
import '../admin.css';
import { useApp } from '../AppContext';
import {
  SUPER_ADMIN_EMAIL, SUPER_ADMIN_PASS,
  APP_DATA_KEY, EMP_CREDENTIALS_KEY, EMP_SESSION_KEY,
} from '../AppContext';

function resolveUser(email, password) {
  const e = email.trim().toLowerCase();

  // 1. Super admin
  if (e === SUPER_ADMIN_EMAIL && password === SUPER_ADMIN_PASS) {
    return { role: 'super-admin', userName: 'Super Admin' };
  }

  // 2. HR Admin — check org data
  try {
    const raw  = localStorage.getItem(APP_DATA_KEY);
    const data = raw ? JSON.parse(raw) : null;
    const orgs = data?.organizationsData || [];
    const org  = orgs.find(
      o => String(o.hrAdminEmail || '').trim().toLowerCase() === e &&
           String(o.temporaryPassword || '') === password
    );
    if (org) return { role: 'hr-admin', userName: org.hrAdminName || 'HR Admin', orgKey: org.key };
  } catch (_) {}

  // 3. Employee credentials
  try {
    const raw   = localStorage.getItem(EMP_CREDENTIALS_KEY);
    const creds = raw ? JSON.parse(raw) : null;
    const code  = email.trim();
    const match = creds?.[code];
    if (match && match.password === password) {
      return { role: 'employee', empCode: code, userName: match.name, designation: match.designation, managerCode: match.managerCode, orgKey: match.orgKey || '' };
    }
  } catch (_) {}

  return null;
}

export default function LoginPage() {
  const { login } = useApp();
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword]     = useState('');
  const [showPwd, setShowPwd]       = useState(false);
  const [error, setError]           = useState('');
  const [loading, setLoading]       = useState(false);

  function handleSubmit(e) {
    e.preventDefault();
    setError('');
    setLoading(true);

    setTimeout(() => {
      const user = resolveUser(identifier, password);
      if (!user) {
        setError('Invalid credentials. Check your email / employee code and password.');
        setLoading(false);
        return;
      }

      if (user.role === 'employee') {
        try {
          localStorage.setItem(EMP_SESSION_KEY, JSON.stringify({
            empCode: user.empCode, name: user.userName,
            designation: user.designation, managerCode: user.managerCode,
            orgKey: user.orgKey || '',
          }));
        } catch (_) {}
        login('employee', { userName: user.userName });
        window.location.hash = '#employee';
      } else if (user.role === 'hr-admin') {
        login('hr-admin', { orgKey: user.orgKey, userName: user.userName });
        window.location.hash = '#hr-home';
      } else {
        login('super-admin', { userName: user.userName });
        window.location.hash = '#organizations';
      }
    }, 350);
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
          <h1 className="login-heading">Welcome back</h1>
          <p className="login-sub">Sign in to your workspace to continue.</p>
        </div>

        <form className="login-form anim-fadeup delay-3" onSubmit={handleSubmit}>
          <div className="form-group">
            <label className="lbl">Email Address</label>
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
              <input type="checkbox" defaultChecked style={{ width: 'auto' }} /> Remember me
            </label>
            <a href="#" className="login-forgot">Forgot password?</a>
          </div>

          {error && <div className="login-error">{error}</div>}

          <button
            type="submit"
            className="btn btn-primary btn-xl w-full mt-8"
            disabled={loading}
          >
            {loading ? 'Signing in…' : 'Sign In →'}
          </button>

          <div className="login-divider">or</div>

          <button type="button" className="btn btn-secondary w-full" style={{ gap: 8 }}>
            <span>🔑</span> Sign in with SSO
          </button>
        </form>

        <p className="login-help anim-fadeup delay-4">
          Need access? Contact your HR Admin or{' '}
          <a href="#">request an invite</a>.
        </p>
      </div>

      {/* RIGHT PANEL */}
      <div className="login-right">
        <div className="login-right-grid"></div>
        <div className="login-right-glow"></div>
        <div className="login-right-content anim-fadein">
          <h2 className="login-right-title">
            Performance<br />management, <em>finally clear.</em>
          </h2>
          <p className="login-right-sub">
            Run performance cycles with clarity, structure, and confidence.
          </p>
        </div>
      </div>
    </div>
  );
}
