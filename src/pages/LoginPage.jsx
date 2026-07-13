import { useEffect, useState } from 'react';
import zaroLogo from '../../images/final zaro logo.png';
import '../admin.css';
import { useApp } from '../AppContext';
import { supabase } from '../backend/supabaseClient';

const REMEMBER_KEY = 'zaro.login.remembered';

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

function mapAuthError(err) {
  const m = String(err?.message || '').toLowerCase();
  if (m.includes('invalid login')) return 'Incorrect email or password.';
  if (m.includes('email not confirmed')) return 'Please confirm your email, or set your password from your invite link.';
  return err?.message || 'Sign-in failed.';
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

export default function LoginPage() {
  const { authReady, role } = useApp();
  const [identifier, setIdentifier] = useState(() => {
    const prefill = getLoginPrefillIdentifier();
    if (prefill) return prefill;
    try { return localStorage.getItem(REMEMBER_KEY) || ''; } catch { return ''; }
  });
  const [password, setPassword] = useState('');
  const [showPwd, setShowPwd] = useState(false);
  const [remember, setRemember] = useState(() => {
    try { return !!localStorage.getItem(REMEMBER_KEY); } catch { return false; }
  });
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    const prefill = getLoginPrefillIdentifier();
    if (prefill) setIdentifier(prefill);
  }, []);

  // If a session already exists (e.g. this tab still has #login in the URL
  // from before signing in elsewhere), get off the login route so the
  // router's role-based screen can take over.
  useEffect(() => {
    if (authReady && role && typeof window !== 'undefined' && window.location.hash === '#login') {
      window.location.hash = '';
    }
  }, [authReady, role]);

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    setSubmitting(true);
    const email = String(identifier || '').trim().toLowerCase();
    try {
      const { error: authErr } = await supabase.auth.signInWithPassword({ email, password });
      if (authErr) { setError(mapAuthError(authErr)); return; }
      try {
        if (remember) localStorage.setItem(REMEMBER_KEY, email);
        else localStorage.removeItem(REMEMBER_KEY);
      } catch { /* ignore storage errors */ }
      // AppContext's onAuthStateChange picks up the session, calls whoami, sets role → App routes.
    } catch {
      setError('Sign-in failed. Please try again.');
    } finally {
      setSubmitting(false);
    }
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
          <p className="login-sub">Sign in to continue.</p>
        </div>

        <form className="login-form anim-fadeup delay-3" onSubmit={handleSubmit}>
          <div className="form-group">
            <label className="lbl">Email</label>
            <input
              type="text"
              placeholder="you@company.com"
              value={identifier}
              onChange={e => setIdentifier(e.target.value)}
              autoComplete="username"
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
                autoComplete="current-password"
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
            <a className="login-forgot" href="#set-password">First time here, or forgot your password?</a>
          </div>

          {error && <div className="login-error">{error}</div>}

          <button
            type="submit"
            className="btn btn-primary btn-xl w-full mt-8"
            disabled={submitting}
          >
            {submitting ? 'Signing in…' : 'Sign In'}
          </button>
        </form>

        <p className="login-help anim-fadeup delay-4">
          Need access? Contact your HR Admin.
        </p>
      </div>

      <RightPanel />
    </div>
  );
}
