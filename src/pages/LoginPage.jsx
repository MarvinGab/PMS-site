import { useState } from 'react';
import zaroLogo from '../../images/final zaro logo.png';
import '../admin.css';
import { useApp } from '../AppContext';
import {
  SUPER_ADMIN_EMAIL, SUPER_ADMIN_PASS,
} from '../AppContext';
import { resolveLoginUser, changeEmployeePassword } from '../backend/authService';
import { persistEmployeeSession } from '../backend/stateStore';

function RightPanel() {
  return (
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
  );
}

function ChangePasswordScreen({ pendingEmp, onComplete }) {
  const [currentPwd, setCurrentPwd]   = useState('');
  const [newPwd, setNewPwd]           = useState('');
  const [confirmPwd, setConfirmPwd]   = useState('');
  const [showNew, setShowNew]         = useState(false);
  const [showConf, setShowConf]       = useState(false);
  const [showCurr, setShowCurr]       = useState(false);
  const [error, setError]             = useState('');
  const [loading, setLoading]         = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    setLoading(true);

    if (newPwd !== confirmPwd) {
      setError('Passwords do not match.');
      setLoading(false);
      return;
    }

    const result = await changeEmployeePassword(pendingEmp.empCode, currentPwd, newPwd);
    if (!result.ok) {
      setError(result.error || 'Something went wrong. Please try again.');
      setLoading(false);
      return;
    }
    onComplete();
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
            <label className="lbl">Current (Temporary) Password</label>
            <div className="pwd-wrap" style={pwdWrap}>
              <input
                type={showCurr ? 'text' : 'password'}
                placeholder="Enter temporary password"
                value={currentPwd}
                onChange={e => setCurrentPwd(e.target.value)}
                autoComplete="current-password"
                required
                autoFocus
              />
              <button type="button" className="pwd-toggle" style={toggleBtn} onClick={() => setShowCurr(p => !p)} tabIndex={-1}>
                {showCurr ? '🙈' : '👁'}
              </button>
            </div>
          </div>

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

export default function LoginPage() {
  const { login } = useApp();
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword]     = useState('');
  const [showPwd, setShowPwd]       = useState(false);
  const [error, setError]           = useState('');
  const [loading, setLoading]       = useState(false);
  const [forcePwChange, setForcePwChange] = useState(false);
  const [pendingEmp, setPendingEmp]       = useState(null);

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    setLoading(true);

    const user = await resolveLoginUser(identifier, password, {
      email: SUPER_ADMIN_EMAIL,
      password: SUPER_ADMIN_PASS,
    });
    if (!user) {
      setError('Invalid credentials. Check your email / employee code and password.');
      setLoading(false);
      return;
    }

    if (user.role === 'employee') {
      if (user.isTemp) {
        setPendingEmp(user);
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
      login('employee', { userName: user.userName });
      window.location.hash = '#employee';
    } else if (user.role === 'hr-admin') {
      login('hr-admin', {
        orgKey: user.orgKey,
        userName: user.userName,
        isCoAdmin: !!user.isCoAdmin,
        isScopedHR: !!user.isScopedHR,
        hrTeamId: user.hrTeamId || null,
        empCode: user.empCode || null,
        allowedModules: user.allowedModules || null,
      });
      window.location.hash = '#hr-home';
    } else {
      login('super-admin', { userName: user.userName });
      window.location.hash = '#organizations';
    }
  }

  if (forcePwChange && pendingEmp) {
    return (
      <ChangePasswordScreen
        pendingEmp={pendingEmp}
        onComplete={() => {
          persistEmployeeSession({
            empCode: pendingEmp.empCode,
            name: pendingEmp.userName,
            designation: pendingEmp.designation,
            managerCode: pendingEmp.managerCode,
            orgKey: pendingEmp.orgKey || '',
          });
          login('employee', { userName: pendingEmp.userName });
          window.location.hash = '#employee';
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
          <h1 className="login-heading">Welcome back</h1>
          <p className="login-sub">Sign in to your workspace to continue.</p>
        </div>

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

      <RightPanel />
    </div>
  );
}
