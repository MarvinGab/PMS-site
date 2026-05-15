import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import AdminShell from '../components/AdminShell';
import OrgDetailModal from './OrgDetailModal';
import DeleteOrgModal from './DeleteOrgModal';
import { useApp } from '../AppContext';
import { logAuditEvent } from '../backend/auditLog';
import { getOrganizationEmployeeCount, getOrganizationSetupMeta, buildWorkspaceUrl } from '../orgUtils';
import '../admin.css';

function getWorkspaceUrl(org) {
  const slug = String(org?.workspaceSlug || '').trim();
  if (slug) return buildWorkspaceUrl(slug);
  return org?.domain || '';
}

function OrgRow({ org, activeMenu, onMenuToggle, onOpen, onEdit, onDelete, onReopenSetup, onCloseSetup }) {
  const setup = getOrganizationSetupMeta(org);
  const employeeCount = getOrganizationEmployeeCount(org);
  const progressNote = setup.pct >= 100
    ? 'Ready for launch'
    : setup.pct >= 50
      ? 'Configuration underway'
      : setup.pct > 0
        ? 'Setup started'
        : 'No setup applied';
  const buttonRef = useRef(null);
  const [menuPos, setMenuPos] = useState(null);
  const isOpen = activeMenu === org.key;

  useLayoutEffect(() => {
    if (!isOpen || !buttonRef.current) return;
    const rect = buttonRef.current.getBoundingClientRect();
    setMenuPos({ top: rect.bottom + 6, right: window.innerWidth - rect.right });
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    function reposition() {
      if (!buttonRef.current) return;
      const rect = buttonRef.current.getBoundingClientRect();
      setMenuPos({ top: rect.bottom + 6, right: window.innerWidth - rect.right });
    }
    window.addEventListener('scroll', reposition, true);
    window.addEventListener('resize', reposition);
    return () => {
      window.removeEventListener('scroll', reposition, true);
      window.removeEventListener('resize', reposition);
    };
  }, [isOpen]);

  return (
    <tr className="org-row-clickable" onClick={() => onOpen(org.key)}>
      <td>
        <div className="org-info">
          <div className="org-logo" style={{ background: org.logoBg }}>{org.logoText}</div>
          <div>
            <div className="org-name">{org.name}</div>
            <div className="org-meta">{getWorkspaceUrl(org)}</div>
          </div>
        </div>
      </td>
      <td><span className={`badge ${org.industryBadgeClass}`}>{org.industry}</span></td>
      <td>
        <div className="org-metric-value">
          <span>{employeeCount}</span>
        </div>
        <div className="org-metric-sub">{employeeCount === 1 ? 'employee' : 'employees'}</div>
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
            <button ref={buttonRef} className="org-menu-btn" onClick={(event) => onMenuToggle(event, org.key)} aria-label="Organization actions">⋯</button>
            {isOpen && menuPos ? createPortal(
              <div className="org-menu" style={{ position: 'fixed', top: menuPos.top, right: menuPos.right }} onClick={(event) => event.stopPropagation()}>
                <button className="org-menu-item" onClick={() => onEdit(org.key)}>Edit</button>
                {org.launched && !org.setupReopened && (
                  <button className="org-menu-item" onClick={() => onReopenSetup(org.key)}>Reopen setup</button>
                )}
                {org.setupReopened && (
                  <button className="org-menu-item" onClick={() => onCloseSetup(org.key)}>Close setup access</button>
                )}
                <button className="org-menu-item danger" onClick={() => onDelete(org.key)}>Delete</button>
              </div>,
              document.body
            ) : null}
          </div>
        </div>
      </td>
    </tr>
  );
}

export default function OrganizationsPage() {
  const { orgs, setOrgs, userName } = useApp();
  const [activeMenu, setActiveMenu] = useState(null);
  const [detailOrgKey, setDetailOrgKey] = useState(null);
  const [deleteOrgKey, setDeleteOrgKey] = useState(null);

  const summary = useMemo(() => {
    const totalEmployees = orgs.reduce((sum, org) => sum + getOrganizationEmployeeCount(org), 0);
    const configured = orgs.filter((org) => getOrganizationSetupMeta(org).pct >= 100).length;
    const inProgress = orgs.filter((org) => {
      const pct = getOrganizationSetupMeta(org).pct;
      return pct > 0 && pct < 100;
    }).length;
    return { totalEmployees, configured, inProgress };
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

  function handleReopenSetup(key) {
    const now = new Date().toISOString();
    const nextOrgs = orgs.map((org) => (
      org.key === key
        ? {
            ...org,
            setupReopened: true,
            setupReopenedAt: now,
            setupReopenedBy: userName || 'super-admin',
            setupStatus: 'in_progress',
            status: 'Setup Reopened',
            actionLabel: 'Close Setup',
            statusBadgeClass: 'badge-amber',
            setupColor: '#D97706',
          }
        : org
    ));
    setActiveMenu(null);
    setOrgs(nextOrgs);
    void logAuditEvent({
      orgKey: key,
      actorRole: 'super-admin',
      actorName: userName || 'Super Admin',
      actionType: 'setup-reopened',
      targetType: 'organization',
      targetCode: key,
    });
  }

  function handleCloseSetup(key) {
    const nextOrgs = orgs.map((org) => (
      org.key === key
        ? {
            ...org,
            launched: true,
            setupStatus: 'launched',
            setupReopened: false,
            setupReopenedAt: null,
            setupReopenedBy: null,
            setupPct: 100,
            status: 'Active',
            actionLabel: 'Manage',
            statusBadgeClass: 'badge-green',
            setupColor: '#16A34A',
          }
        : org
    ));
    setActiveMenu(null);
    setOrgs(nextOrgs);
    void logAuditEvent({
      orgKey: key,
      actorRole: 'super-admin',
      actorName: userName || 'Super Admin',
      actionType: 'setup-closed',
      targetType: 'organization',
      targetCode: key,
    });
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
            <div className="workspace-stat-copy">Across all workspaces</div>
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

          <div className="org-table-scroll">
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
                      onReopenSetup={handleReopenSetup}
                      onCloseSetup={handleCloseSetup}
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
      </div>

      {detailOrgKey ? <OrgDetailModal orgKey={detailOrgKey} onClose={() => setDetailOrgKey(null)} /> : null}
      {deleteOrgKey ? <DeleteOrgModal orgKey={deleteOrgKey} onClose={() => setDeleteOrgKey(null)} onDeleted={() => setDeleteOrgKey(null)} /> : null}
    </AdminShell>
  );
}
