import { useState } from 'react';
import { useApp, SUPER_ADMIN_PASS } from '../AppContext';
import { deleteOrganizationRecord } from '../backend/stateStore';
import '../admin.css';

export default function DeleteOrgModal({ orgKey, onClose, onDeleted }) {
  const { orgs, feedData, pendingActions, dashboardFlags, applyAppData, clearOrganizationState } = useApp();
  const [pwd, setPwd]     = useState('');
  const [error, setError] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState('');

  const org = orgs.find(o => o.key === orgKey);

  async function handleDelete() {
    if (pwd !== SUPER_ADMIN_PASS) {
      setError(true);
      return;
    }
    setSubmitting(true);
    setSubmitError('');

    const removed = await deleteOrganizationRecord(orgKey);
    if (!removed.ok) {
      setSubmitting(false);
      setSubmitError(removed.error || 'Failed to delete organization from backend.');
      return;
    }

    // Clean up references
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
        <div className="form-group" style={{ marginBottom: 18 }}>
          <label className="lbl">Confirm with password</label>
          <input
            type="password"
            placeholder="Enter your password"
            value={pwd}
            onChange={e => { setPwd(e.target.value); setError(false); setSubmitError(''); }}
            autoFocus
            autoComplete="off"
          />
          {error && (
            <div className="input-hint hint-err">Incorrect password.</div>
          )}
          {submitError && (
            <div className="input-hint hint-err">{submitError}</div>
          )}
        </div>
        <div className="glass-actions">
          <button className="btn btn-secondary" onClick={onClose} disabled={submitting}>Cancel</button>
          <button className="btn btn-danger" onClick={handleDelete} disabled={submitting}>{submitting ? 'Deleting…' : 'Delete'}</button>
        </div>
      </div>
    </div>
  );
}
