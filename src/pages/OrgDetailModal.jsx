import { useApp } from '../AppContext';
import { getOrganizationEmployeeCount, getOrganizationSetupMeta } from '../orgUtils';
import '../admin.css';

export default function OrgDetailModal({ orgKey, onClose }) {
  const { orgs } = useApp();
  const org = orgs.find(o => o.key === orgKey);

  if (!org) return null;

  const setup = getOrganizationSetupMeta(org);
  const employeeCount = getOrganizationEmployeeCount(org);
  const seatPct = org.seats ? ((employeeCount || 0) / org.seats * 100).toFixed(1) + '%' : '0%';
  const modulesText = 'Performance Management';

  return (
    <div className="org-detail-overlay" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="org-detail-dialog">
        <div className="org-detail-head">
          <div>
            <h3 className="org-detail-title">{org.name}</h3>
            <p className="org-detail-sub">
              {org.domain} · {org.orgCode || 'N/A'} · {org.industry || 'Other'}
            </p>
          </div>
          <button type="button" className="org-detail-close" onClick={onClose}>✕</button>
        </div>

        <div className="org-detail-grid">
          {/* Organization Details */}
          <div className="org-detail-card">
            <div className="org-detail-card-title">Organization Details</div>
            <div className="org-detail-list">
              <div className="org-detail-row">
                <span>Workspace</span><span>{org.domain || 'Not set'}</span>
              </div>
              <div className="org-detail-row">
                <span>Organization Code</span><span>{org.orgCode || 'Not set'}</span>
              </div>
              <div className="org-detail-row">
                <span>Industry</span><span>{org.industry || 'Other'}</span>
              </div>
              <div className="org-detail-row">
                <span>Status</span><span>{setup.status}</span>
              </div>
              {org.setupReopened && (
                <div className="org-detail-row">
                  <span>Setup Access</span><span>Reopened</span>
                </div>
              )}
              <div className="org-detail-row">
                <span>Employees</span>
                <span>{employeeCount} of {org.seats || 0} seats</span>
              </div>
            </div>
          </div>

          {/* Setup Progress */}
          <div className="org-detail-card">
            <div className="org-detail-card-title">Setup Progress</div>
            <div className="org-detail-progress">
              <div
                className="org-detail-progress-fill"
                style={{ width: `${setup.pct}%`, background: setup.setupColor }}
              />
            </div>
            <div className="org-detail-progress-copy"><strong>{setup.pct}% complete</strong> · {setup.status}</div>
          </div>

          {/* HR Admin Credentials */}
          <div className="org-detail-card">
            <div className="org-detail-card-title">HR Admin Credentials</div>
            <div className="org-detail-list">
              <div className="org-credential">
                <div>
                  <strong>HR Admin Name</strong>
                  <code>{org.hrAdminName || 'Not assigned'}</code>
                </div>
              </div>
              <div className="org-credential">
                <div>
                  <strong>HR Admin ID</strong>
                  <code>{org.hrAdminEmail || 'Not assigned'}</code>
                </div>
              </div>
              <div className="org-credential">
                <div>
                  <strong>Admin Access</strong>
                  <code>Use Communications or Reset Password actions</code>
                </div>
              </div>
            </div>
          </div>

          {/* Snapshot */}
          <div className="org-detail-card">
            <div className="org-detail-card-title">Snapshot</div>
            <div className="org-detail-list">
              <div className="org-detail-row">
                <span>Next Action</span><span>{setup.actionLabel}</span>
              </div>
              <div className="org-detail-row">
                <span>Seat Utilization</span><span>{seatPct}</span>
              </div>
              <div className="org-detail-row">
                <span>Enabled Modules</span>
                <span style={{ textAlign: 'right', fontSize: 12 }}>{modulesText}</span>
              </div>
              <div className="org-detail-row">
                <span>Progress Source</span><span>{setup.source === 'wizard' ? 'Saved PMS configuration' : 'Stored org metadata'}</span>
              </div>
              {org.setupReopenedAt && (
                <div className="org-detail-row">
                  <span>Reopened At</span><span>{new Date(org.setupReopenedAt).toLocaleString()}</span>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
