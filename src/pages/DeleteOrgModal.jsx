import { useState } from 'react';
import { useApp } from '../AppContext';
import { deleteOrganizationRecord } from '../backend/stateStore';
import '../admin.css';

export default function DeleteOrgModal({ orgKey, onClose, onDeleted }) {
  const { role, orgs, feedData, pendingActions, dashboardFlags, applyAppData, clearOrganizationState } = useApp();
  const [confirmText, setConfirmText] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const org = orgs.find(o => o.key === orgKey);
  const confirmTarget = String(org?.name || orgKey || '').trim();
  const confirmMatches = confirmText.trim().toLowerCase() === confirmTarget.toLowerCase() && confirmTarget !== '';

  async function handleDelete() {
    setError('');

    // Defense-in-depth: the modal is only routed to when the app-level whoami role is
    // super_admin, but re-check here so the destructive op can never run for a lesser role.
    if (role !== 'super_admin') {
      setError('Only a super admin can delete an organization.');
      return;
    }
    if (!confirmMatches) {
      setError(`Type "${confirmTarget}" to confirm.`);
      return;
    }

    setSubmitting(true);

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
        <div className="form-group" style={{ marginBottom: 18 }}>
          <label className="lbl">Type <strong>{confirmTarget}</strong> to confirm</label>
          <input
            type="text"
            placeholder={confirmTarget}
            value={confirmText}
            onChange={e => { setConfirmText(e.target.value); setError(''); }}
            autoFocus
            autoComplete="off"
          />
          {error && (
            <div className="input-hint hint-err">{error}</div>
          )}
        </div>
        <div className="glass-actions">
          <button className="btn btn-secondary" onClick={onClose} disabled={submitting}>Cancel</button>
          <button className="btn btn-danger" onClick={handleDelete} disabled={submitting || !confirmMatches}>{submitting ? 'Deleting…' : 'Delete'}</button>
        </div>
      </div>
    </div>
  );
}
