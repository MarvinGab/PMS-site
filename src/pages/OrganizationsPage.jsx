import { useMemo, useState } from 'react';
import AdminShell from '../components/AdminShell';
import OrgDetailModal from './OrgDetailModal';
import DeleteOrgModal from './DeleteOrgModal';
import { useApp } from '../AppContext';
import { getOrganizationEmployeeCount, getOrganizationSetupMeta } from '../orgUtils';
import '../admin.css';

function OrgRow({ org, activeMenu, onMenuToggle, onOpen, onEdit, onDelete }) {
  const setup = getOrganizationSetupMeta(org);
  const employeeCount = getOrganizationEmployeeCount(org);
  const seatPct = org.seats ? Math.round((employeeCount / org.seats) * 100) : 0;
  const progressNote = setup.pct >= 100
    ? 'Ready for launch'
    : setup.pct >= 50
      ? 'Configuration underway'
      : setup.pct > 0
        ? 'Setup started'
        : 'No setup applied';

  return (
    <tr className="org-row-clickable" onClick={() => onOpen(org.key)}>
      <td>
        <div className="org-info">
          <div className="org-logo" style={{ background: org.logoBg }}>{org.logoText}</div>
          <div>
            <div className="org-name">{org.name}</div>
            <div className="org-meta">{org.domain}</div>
          </div>
        </div>
      </td>
      <td><span className={`badge ${org.industryBadgeClass}`}>{org.industry}</span></td>
      <td>
        <div className="org-metric-value">
          <span>{employeeCount}</span>
          <span className="org-metric-sep">/</span>
          <span className="org-metric-total">{org.seats}</span>
        </div>
        <div className="org-metric-sub">{seatPct}% seats occupied</div>
      </td>
      <td>
        <div className="org-progress-cell">
          <div className="mini-progress">
            <div className="mini-progress-fill" style={{ width: `${setup.pct}%`, background: setup.setupColor }} />
          </div>
          <div className="org-progress-copy">
            <span className="org-progress-label">{setup.pct}% complete</span>
            <span>{progressNote}</span>
          </div>
        </div>
      </td>
      <td>
        <div className="org-admin-cell" onClick={(event) => event.stopPropagation()}>
          <div className="org-owners">
            <div className="org-owner-name">{org.hrAdminName || 'Not assigned'}</div>
            <div className="org-owner-meta">{org.hrAdminEmail || 'No admin email yet'}</div>
          </div>
          <div className="org-action-wrap">
            <button className="org-menu-btn" onClick={(event) => onMenuToggle(event, org.key)} aria-label="Organization actions">⋯</button>
            {activeMenu === org.key ? (
              <div className="org-menu">
                <button className="org-menu-item" onClick={() => onEdit(org.key)}>Edit</button>
                <button className="org-menu-item danger" onClick={() => onDelete(org.key)}>Delete</button>
              </div>
            ) : null}
          </div>
        </div>
      </td>
    </tr>
  );
}

export default function OrganizationsPage() {
  const { orgs } = useApp();
  const [activeMenu, setActiveMenu] = useState(null);
  const [detailOrgKey, setDetailOrgKey] = useState(null);
  const [deleteOrgKey, setDeleteOrgKey] = useState(null);

  const summary = useMemo(() => {
    const totalEmployees = orgs.reduce((sum, org) => sum + getOrganizationEmployeeCount(org), 0);
    const totalSeats = orgs.reduce((sum, org) => sum + (org.seats || 0), 0);
    const configured = orgs.filter((org) => getOrganizationSetupMeta(org).pct >= 100).length;
    const inProgress = orgs.filter((org) => {
      const pct = getOrganizationSetupMeta(org).pct;
      return pct > 0 && pct < 100;
    }).length;
    return { totalEmployees, totalSeats, configured, inProgress };
  }, [orgs]);

  function handleMenuToggle(event, key) {
    event.stopPropagation();
    setActiveMenu((prev) => (prev === key ? null : key));
  }

  function handleEdit(key) {
    setActiveMenu(null);
    window.location.hash = `#edit-org?key=${key}`;
  }

  function handleDelete(key) {
    setActiveMenu(null);
    setDeleteOrgKey(key);
  }

  return (
    <AdminShell title="Organizations" page="organizations">
      <div className="workspace-shell" onClick={() => setActiveMenu(null)}>
        <div className="workspace-stat-grid">
          <div className="workspace-stat">
            <div className="workspace-stat-label">Organizations</div>
            <div className="workspace-stat-value">{orgs.length}</div>
            <div className="workspace-stat-copy">{summary.configured} configured, {summary.inProgress} in progress</div>
          </div>
          <div className="workspace-stat">
            <div className="workspace-stat-label">Configured</div>
            <div className="workspace-stat-value">{summary.configured}</div>
            <div className="workspace-stat-copy">Workspaces ready for launch</div>
          </div>
          <div className="workspace-stat">
            <div className="workspace-stat-label">In Progress</div>
            <div className="workspace-stat-value">{summary.inProgress}</div>
            <div className="workspace-stat-copy">Still being set up</div>
          </div>
          <div className="workspace-stat">
            <div className="workspace-stat-label">Employees</div>
            <div className="workspace-stat-value">{summary.totalEmployees}</div>
            <div className="workspace-stat-copy">{summary.totalEmployees} of {summary.totalSeats.toLocaleString()} seats</div>
          </div>
        </div>

        <div className="card directory-card">
          <div className="directory-head">
            <div className="directory-copy">
              <div className="directory-title">Organization Directory</div>
              <div className="directory-sub">Live workspaces, owners, and setup progress.</div>
            </div>
            <button className="btn btn-primary btn-sm" onClick={() => { window.location.hash = '#create-org'; }}>+ Add Org</button>
          </div>

          <table className="org-table">
            <colgroup>
              <col className="org-col-org" />
              <col className="org-col-industry" />
              <col className="org-col-employees" />
              <col className="org-col-progress" />
              <col className="org-col-admin" />
            </colgroup>
            <thead>
              <tr>
                <th>Organization</th>
                <th>Industry</th>
                <th>Employees</th>
                <th>Setup Progress</th>
                <th>Admin</th>
              </tr>
            </thead>
            <tbody>
              {orgs.length ? (
                orgs.map((org) => (
                  <OrgRow
                    key={org.key}
                    org={org}
                    activeMenu={activeMenu}
                    onMenuToggle={handleMenuToggle}
                    onOpen={setDetailOrgKey}
                    onEdit={handleEdit}
                    onDelete={handleDelete}
                  />
                ))
              ) : (
                <tr>
                  <td className="org-empty-state" colSpan={5}>
                    No organizations yet. Create one to start PMS setup.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {detailOrgKey ? <OrgDetailModal orgKey={detailOrgKey} onClose={() => setDetailOrgKey(null)} /> : null}
      {deleteOrgKey ? <DeleteOrgModal orgKey={deleteOrgKey} onClose={() => setDeleteOrgKey(null)} onDeleted={() => setDeleteOrgKey(null)} /> : null}
    </AdminShell>
  );
}
