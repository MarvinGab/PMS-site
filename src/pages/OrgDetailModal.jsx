import { useApp } from '../AppContext';
import { getOrganizationEmployeeCount, getOrganizationSetupMeta, buildWorkspaceUrl } from '../orgUtils';
import '../admin.css';

export default function OrgDetailModal({ orgKey, onClose }) {
  const { orgs } = useApp();
  const org = orgs.find(o => o.key === orgKey);

  if (!org) return null;

  const workspaceSlug = String(org.workspaceSlug || '').trim();
  const workspaceUrl = workspaceSlug
    ? buildWorkspaceUrl(workspaceSlug)
    : (org.domain || 'Not set');
  const setup = getOrganizationSetupMeta(org);
  const employeeCount = getOrganizationEmployeeCount(org);

  return (
    <div className="org-detail-overlay" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="org-detail-dialog">
        <div className="org-detail-head">
          <div>
            <h3 className="org-detail-title">{org.name}</h3>
          </div>
          <button type="button" className="org-detail-close" onClick={onClose}>✕</button>
        </div>

        <div className="org-detail-grid">
          {/* Organization Details */}
          <div className="org-detail-card">
            <div className="org-detail-card-title">Organization Details</div>
            <div className="org-detail-list">
              <div className="org-detail-row">
                <span>Workspace</span><span>{workspaceUrl}</span>
              </div>
              <div className="org-detail-row">
                <span>Organization Code</span><span>{org.orgCode || 'Not set'}</span>
              </div>
              <div className="org-detail-row">
                <span>Status</span><span>{setup.status}</span>
              </div>
              {org.setupReopened && (
                <div className="org-detail-row">
                  <span>Setup Access</span><span>Reopened{org.setupReopenedAt ? ` · ${new Date(org.setupReopenedAt).toLocaleDateString()}` : ''}</span>
                </div>
              )}
              <div className="org-detail-row">
                <span>Employees</span>
                <span>{employeeCount}</span>
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
            <div className="org-detail-progress-copy"><strong>{setup.pct}% complete</strong></div>
          </div>

          {/* HR Admin */}
          <div className="org-detail-card">
            <div className="org-detail-card-title">HR Admin</div>
            <div className="org-detail-list">
              <div className="org-credential">
                <div>
                  <strong>Name</strong>
                  <code>{org.hrAdminName || 'Not assigned'}</code>
                </div>
              </div>
              <div className="org-credential">
                <div>
                  <strong>Email</strong>
                  <code>{org.hrAdminEmail || 'Not assigned'}</code>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
