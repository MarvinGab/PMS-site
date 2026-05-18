import { useState } from 'react';
import { useApp } from '../AppContext';
import { deleteOrganizationRecord } from '../backend/stateStore';
import { loginWithServerSession } from '../backend/serverAuth';
import '../admin.css';

export default function DeleteOrgModal({ orgKey, onClose, onDeleted }) {
  const { orgs, feedData, pendingActions, dashboardFlags, applyAppData, clearOrganizationState, userEmail } = useApp();
  const [pwd, setPwd]     = useState('');
  const [emailOverride, setEmailOverride] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const org = orgs.find(o => o.key === orgKey);
  const sessionEmail = String(userEmail || '').trim().toLowerCase();
  const needsEmailFallback = !sessionEmail;

  async function handleDelete() {
    setError('');
    const identifier = sessionEmail || String(emailOverride || '').trim().toLowerCase();
    if (!identifier) {
      setError('Enter your super-admin email to confirm.');
      return;
    }
    if (!pwd) {
      setError('Enter your password.');
      return;
    }

    setSubmitting(true);

    // Verify the typed password against the server (same source of truth as
    // login). Avoids comparing against a build-time client constant, which
    // breaks the moment VITE_SUPER_ADMIN_PASSWORD isn't baked into the
    // production bundle.
    const verify = await loginWithServerSession(identifier, pwd, '', false, '');
    if (!verify?.ok) {
      const errText = String(verify?.error || '');
      if (/not configured|failed to contact/i.test(errText)) {
        setError('Auth backend is unreachable. Try again in a moment.');
      } else {
        setError('Incorrect password.');
      }
      setSubmitting(false);
      return;
    }
    if (verify?.user?.role !== 'super-admin') {
      setError('Only the super-admin can delete an organization.');
      setSubmitting(false);
      return;
    }

    const removed = await deleteOrganizationRecord(orgKey);
    if (!removed.ok) {
      setSubmitting(false);
      setError(removed.error || 'Failed to delete organization from backend.');
      return;
    }

    const nextFeed    = feedData.filter(f => f.orgKey !== orgKey);
    const nextPending = pendingActions.filter(p => p.orgKey !== orgKey);
    const nextFlags   = { ...dashboardFlags };
    if (nextFlags.licenseOverageOrgKey === orgKey) nextFlags.licenseOverageOrgKey = null;
    const nextOrgs = orgs.filter(o => o.key !== orgKey);

    applyAppData({
      feedData: nextFeed,
      pendingActions: nextPending,
      dashboardFlags: nextFlags,
      orgs: nextOrgs,
    });
    await clearOrganizationState(orgKey);
    onDeleted && onDeleted();
    setSubmitting(false);
    onClose();
  }

  return (
    <div className="glass-overlay" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="glass-dialog">
        <div className="glass-title">Delete Organization?</div>
        <div className="glass-sub">
          Are you sure you want to delete <strong>{org?.name || 'this organization'}</strong>? This action cannot be undone.
        </div>
        {needsEmailFallback && (
          <div className="form-group" style={{ marginBottom: 12 }}>
            <label className="lbl">Super-admin email</label>
            <input
              type="email"
              placeholder="you@zarohr.com"
              value={emailOverride}
              onChange={e => { setEmailOverride(e.target.value); setError(''); }}
              autoComplete="username"
            />
          </div>
        )}
        <div className="form-group" style={{ marginBottom: 18 }}>
          <label className="lbl">Confirm with password</label>
          <input
            type="password"
            placeholder="Enter your password"
            value={pwd}
            onChange={e => { setPwd(e.target.value); setError(''); }}
            autoFocus
            autoComplete="current-password"
          />
          {error && (
            <div className="input-hint hint-err">{error}</div>
          )}
        </div>
        <div className="glass-actions">
          <button className="btn btn-secondary" onClick={onClose} disabled={submitting}>Cancel</button>
          <button className="btn btn-danger" onClick={handleDelete} disabled={submitting}>{submitting ? 'Verifying…' : 'Delete'}</button>
        </div>
      </div>
    </div>
  );
}
