import { useState } from 'react';
import { useApp, SUPER_ADMIN_PASS } from '../AppContext';
import '../admin.css';

export default function DeleteOrgModal({ orgKey, onClose, onDeleted }) {
  const { orgs, setOrgs, feedData, setFeedData, pendingActions, setPendingActions, dashboardFlags, setDashboardFlags } = useApp();
  const [pwd, setPwd]     = useState('');
  const [error, setError] = useState(false);

  const org = orgs.find(o => o.key === orgKey);

  function handleDelete() {
    if (pwd !== SUPER_ADMIN_PASS) {
      setError(true);
      return;
    }
    // Clean up references
    const nextFeed    = feedData.filter(f => f.orgKey !== orgKey);
    const nextPending = pendingActions.filter(p => p.orgKey !== orgKey);
    const nextFlags   = { ...dashboardFlags };
    if (nextFlags.licenseOverageOrgKey === orgKey) nextFlags.licenseOverageOrgKey = null;

    setFeedData(nextFeed);
    setPendingActions(nextPending);
    setDashboardFlags(nextFlags);
    setOrgs(orgs.filter(o => o.key !== orgKey));
    onDeleted && onDeleted();
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
            onChange={e => { setPwd(e.target.value); setError(false); }}
            autoFocus
            autoComplete="off"
          />
          {error && (
            <div className="input-hint hint-err">Incorrect password.</div>
          )}
        </div>
        <div className="glass-actions">
          <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn btn-danger" onClick={handleDelete}>Delete</button>
        </div>
      </div>
    </div>
  );
}
