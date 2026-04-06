import { useState } from 'react';
import AdminShell from '../components/AdminShell';
import OrgDetailModal from './OrgDetailModal';
import DeleteOrgModal from './DeleteOrgModal';
import { useApp } from '../AppContext';
import '../admin.css';

export default function DashboardPage() {
  const { orgs, pendingActions, feedData, dashboardFlags, setDashboardFlags } = useApp();

  const [activeMenu, setActiveMenu]     = useState(null);
  const [detailOrgKey, setDetailOrgKey] = useState(null);
  const [deleteOrgKey, setDeleteOrgKey] = useState(null);
  const [alertDismissed, setAlertDismissed] = useState(false);

  const totalEmployees = orgs.reduce((s, o) => s + (o.employees || 0), 0);
  const totalSeats     = orgs.reduce((s, o) => s + (o.seats || 0), 0);
  const seatUsagePct   = totalSeats ? ((totalEmployees / totalSeats) * 100).toFixed(1) : '0';

  const showAlert = !alertDismissed && dashboardFlags?.licenseOverageOrgKey;
  const alertOrg  = showAlert ? orgs.find(o => o.key === dashboardFlags.licenseOverageOrgKey) : null;

  function handleMenuToggle(e, key) {
    e.stopPropagation();
    setActiveMenu(prev => prev === key ? null : key);
  }

  function handleRowDblClick(key) {
    setActiveMenu(null);
    setDetailOrgKey(key);
  }

  function handleEdit(key) {
    setActiveMenu(null);
    window.location.hash = '#edit-org?key=' + key;
  }

  function handleDelete(key) {
    setActiveMenu(null);
    setDeleteOrgKey(key);
  }

  function dismissAlert() {
    setAlertDismissed(true);
    const next = { ...dashboardFlags, licenseOverageOrgKey: null };
    setDashboardFlags(next);
  }

  return (
    <AdminShell title="Dashboard" page="dashboard">
      {/* License alert */}
      {showAlert && (
        <div className="banner banner-amber">
          <span>⚠️</span>
          <span>
            License overage detected for <strong>{alertOrg?.name || dashboardFlags.licenseOverageOrgKey}</strong>.
            Employee count exceeds licensed seats. Please review billing.
          </span>
          <button className="alert-close" onClick={dismissAlert}>✕</button>
        </div>
      )}

      {/* KPI Strip */}
      <div className="kpi-strip">
        <div className="kpi-card">
          <div className="kpi-label">Organizations</div>
          <div className="kpi-value">{orgs.length}</div>
          <div className="kpi-sub">+1 this month</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-label">Total Employees</div>
          <div className="kpi-value">{totalEmployees}</div>
          <div className="kpi-sub">Across all orgs</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-label">Active Review Cycles</div>
          <div className="kpi-value">2</div>
          <div className="kpi-sub">Running now</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-label">Licensed Seats</div>
          <div className="kpi-value">{totalSeats.toLocaleString()}</div>
          <div className="kpi-sub">{seatUsagePct}% used</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-label">HR Admins</div>
          <div className="kpi-value">6</div>
          <div className="kpi-sub">Platform-wide</div>
        </div>
      </div>

      {/* Dashboard Grid */}
      <div className="dash-grid" onClick={() => setActiveMenu(null)}>
        {/* LEFT */}
        <div className="dash-left">
          {/* Organizations card */}
          <div className="card">
            <div className="card-head">
              <div>
                <div className="fw-600">Organizations</div>
                <div className="text-sm text-muted mt-4">All tenants on this platform</div>
              </div>
              <button
                className="btn btn-primary btn-sm"
                onClick={e => { e.stopPropagation(); window.location.hash = '#create-org'; }}
              >
                Add Organization
              </button>
            </div>
            <OrgTable
              orgs={orgs}
              activeMenu={activeMenu}
              onMenuToggle={handleMenuToggle}
              onRowDblClick={handleRowDblClick}
              onEdit={handleEdit}
              onDelete={handleDelete}
            />
          </div>

          {/* Recent Activity */}
          <div className="card">
            <div className="card-head">
              <div>
                <div className="fw-600">Recent Activity</div>
                <div className="text-sm text-muted mt-4">Platform event stream</div>
              </div>
            </div>
            <div className="card-p">
              {feedData.map((item, i) => (
                <div
                  key={i}
                  style={{ display: 'flex', gap: 10, padding: '9px 10px', borderRadius: 8, background: item.bg, marginBottom: 6, fontSize: 12.5, color: '#374151' }}
                >
                  <span style={{ flexShrink: 0 }}>{item.ic}</span>
                  <div>
                    <span dangerouslySetInnerHTML={{ __html: item.text }} />
                    <div style={{ fontSize: 11, color: '#9CA3AF', marginTop: 2 }}>{item.time}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* RIGHT */}
        <div className="dash-right">
          {/* Pending Actions */}
          <div className="card">
            <div className="card-head">
              <div className="fw-600">Pending Actions</div>
              <span className="badge badge-red">{pendingActions.length}</span>
            </div>
            <div className="card-p compact-list">
              {pendingActions.map((item, i) => (
                <div key={i} className="list-row">
                  <span>{item.text}</span><span>›</span>
                </div>
              ))}
            </div>
          </div>

          {/* System Health */}
          <div className="card">
            <div className="card-head">
              <div className="fw-600">System Health</div>
              <span className="badge badge-green">Healthy</span>
            </div>
            <div className="card-p compact-list">
              {[
                { label: 'API Uptime',     val: 99,  color: '#16A34A' },
                { label: 'DB Response',    val: 94,  color: '#16A34A' },
                { label: 'Email Delivery', val: 98,  color: '#16A34A' },
                { label: 'Storage Usage',  val: 67,  color: '#D97706' },
              ].map(row => (
                <div key={row.label} className="health-row">
                  <span>{row.label}</span>
                  <div>
                    <span>{row.val}%</span>
                    <div className="mini-progress">
                      <div className="mini-progress-fill" style={{ width: `${row.val}%`, background: row.color }} />
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Module Usage */}
          <div className="card">
            <div className="card-head"><div className="fw-600">Module Usage</div></div>
            <div className="card-p compact-list">
              {[
                { label: 'Performance Mgmt', val: '3/3' },
                { label: 'Goal Management',  val: '2/3' },
                { label: '360 Feedback',     val: '1/3' },
                { label: 'Compensation',     val: '1/3' },
                { label: 'Succession Planning', val: '0/3' },
              ].map(row => (
                <div key={row.label} className="health-row">
                  <span>{row.label}</span><span>{row.val}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* Modals */}
      {detailOrgKey && (
        <OrgDetailModal orgKey={detailOrgKey} onClose={() => setDetailOrgKey(null)} />
      )}
      {deleteOrgKey && (
        <DeleteOrgModal
          orgKey={deleteOrgKey}
          onClose={() => setDeleteOrgKey(null)}
          onDeleted={() => setDeleteOrgKey(null)}
        />
      )}
    </AdminShell>
  );
}

export function OrgTable({ orgs, activeMenu, onMenuToggle, onRowDblClick, onEdit, onDelete }) {
  return (
    <table className="org-table">
      <thead>
        <tr>
          <th>Organization</th>
          <th>Industry</th>
          <th>Employees</th>
          <th>Setup</th>
          <th>Status</th>
          <th>Action</th>
        </tr>
      </thead>
      <tbody>
        {orgs.map(org => (
          <tr key={org.key} className="org-row-clickable" onDoubleClick={() => onRowDblClick && onRowDblClick(org.key)}>
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
              <div className="fw-600">{org.employees}</div>
              <div className="text-xs text-muted">of {org.seats} seats</div>
            </td>
            <td>
              <div className="mini-progress">
                <div className="mini-progress-fill" style={{ width: `${org.setupPct}%`, background: org.setupColor }} />
              </div>
            </td>
            <td><span className={`badge ${org.statusBadgeClass}`}>{org.status}</span></td>
            <td>
              <div className="org-action-wrap" onClick={e => e.stopPropagation()}>
                <button
                  className="org-menu-btn"
                  onClick={e => onMenuToggle && onMenuToggle(e, org.key)}
                  aria-label="Organization actions"
                >
                  ⋯
                </button>
                {activeMenu === org.key && (
                  <div className="org-menu">
                    <button className="org-menu-item" onClick={() => onEdit && onEdit(org.key)}>Edit</button>
                    <button className="org-menu-item danger" onClick={() => onDelete && onDelete(org.key)}>Delete</button>
                  </div>
                )}
              </div>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
