import { useEffect, useState } from 'react';
import zaroLogo from '../../images/final zaro logo.png';
import '../admin.css';
import { supabase } from '../backend/supabaseClient';

export default function SetPasswordPage() {
  const [mode, setMode] = useState('loading'); // 'set' (have a session) | 'request' (no session) | 'done'
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [doneMessage, setDoneMessage] = useState('');

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setMode((m) => (m === 'loading' ? (data.session ? 'set' : 'request') : m)));
    const { data: sub } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === 'PASSWORD_RECOVERY' || session) setMode('set');
    });
    return () => sub?.subscription?.unsubscribe?.();
  }, []);

  async function submitSet(e) {
    e.preventDefault();
    setError('');
    if (password.length < 8) { setError('Use at least 8 characters.'); return; }
    if (password !== confirm) { setError('Passwords do not match.'); return; }
    setBusy(true);
    try {
      const { error: err } = await supabase.auth.updateUser({ password });
      if (err) { setError(err.message || 'Could not set password.'); return; }
      setDoneMessage('Password set. Redirecting to sign in…');
      setMode('done');
      window.location.hash = '#login';
    } catch {
      setError('Could not set password. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  async function submitRequest(e) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const redirectTo = `${window.location.origin}${window.location.pathname}#set-password`;
      const { error: err } = await supabase.auth.resetPasswordForEmail(String(email).trim().toLowerCase(), { redirectTo });
      if (err) { setError(err.message || 'Could not send reset email.'); return; }
      setDoneMessage('Check your email for the reset link.');
      setMode('done');
    } catch {
      setError('Could not send reset email. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div id="page-login">
      <div className="login-left">
        <div className="login-brand">
          <div className="logo-wrap">
            <img src={zaroLogo} alt="Zaro HR logo" className="login-logo-icon" />
          </div>
        </div>

        {mode === 'loading' && (
          <p className="login-sub">Loading…</p>
        )}

        {mode === 'done' && (
          <>
            <h1 className="login-heading login-heading-sm">All set</h1>
            <p className="login-sub">{doneMessage} <a className="login-forgot" href="#login">Return to sign in</a></p>
          </>
        )}

        {mode === 'set' && (
          <>
            <h1 className="login-heading login-heading-sm">Set your password</h1>
            <p className="login-sub">Choose a password to finish signing in.</p>
            <form className="login-form" onSubmit={submitSet}>
              <div className="form-group">
                <label className="lbl">New password</label>
                <div className="pwd-wrap">
                  <input
                    type="password"
                    placeholder="At least 8 characters"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    autoComplete="new-password"
                    required
                    autoFocus
                  />
                </div>
              </div>

              <div className="form-group">
                <label className="lbl">Confirm password</label>
                <div className="pwd-wrap">
                  <input
                    type="password"
                    placeholder="Re-enter password"
                    value={confirm}
                    onChange={(e) => setConfirm(e.target.value)}
                    autoComplete="new-password"
                    required
                  />
                </div>
              </div>

              {error && <div className="login-error">{error}</div>}

              <button type="submit" className="btn btn-primary btn-xl w-full mt-8" disabled={busy}>
                {busy ? 'Setting…' : 'Set password'}
              </button>
            </form>
          </>
        )}

        {mode === 'request' && (
          <>
            <h1 className="login-heading login-heading-sm">Reset your password</h1>
            <p className="login-sub">Enter your email and we&apos;ll send you a reset link.</p>
            <form className="login-form" onSubmit={submitRequest}>
              <div className="form-group">
                <label className="lbl">Email</label>
                <input
                  type="email"
                  placeholder="you@company.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  autoComplete="username"
                  required
                  autoFocus
                />
              </div>

              {error && <div className="login-error">{error}</div>}

              <button type="submit" className="btn btn-primary btn-xl w-full mt-8" disabled={busy}>
                {busy ? 'Sending…' : 'Email me a reset link'}
              </button>
            </form>
            <p className="login-help">
              <a href="#login">Back to sign in</a>
            </p>
          </>
        )}
      </div>
    </div>
  );
}
