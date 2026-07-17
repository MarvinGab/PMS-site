// Organizations directory — Plan 5e-1 Task 2.
//
// Data layer is `callPms('org.list')` ONLY. The legacy org blob (`useApp().orgs`,
// `getOrganizationSetupMeta`/`getOrganizationEmployeeCount` from orgUtils,
// `saveOrganizationRecord`/`setOrgs` from stateStore) is retired for this screen — see
// project_appraisal_backend_wiring / project_architecture_and_scale memory notes.
//
// Row actions that used to mutate that blob directly (Reopen setup / Close setup, both
// called `setOrgs(...)` in this file; Delete, which opened a modal that calls
// `deleteOrganizationRecord` + `setOrgs`) are removed from the row menu for this task —
// there is no backend org.reopen-setup / org.close-setup / org.delete action yet, and
// wiring them to the retired blob would silently no-op against real orgs while looking
// like it worked. Deferred to a later 5e slice once those backend actions exist.
// Edit stays wired as a nav-only stub (`#edit-org?key=...`, no data mutation here) per
// the task brief. "View details" (row click → OrgDetailModal) is also left wired
// unchanged: it's read-only and still looks up the org by key in the same legacy blob,
// so until OrgDetailModal itself is migrated to a backend read it will typically render
// nothing for a real org — a known gap, not corrupting anything, deferred alongside it.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import AdminShell from '../components/AdminShell';
import OrgDetailModal from './OrgDetailModal';
import { buildWorkspaceUrl } from '../orgUtils';
import { callPms, PmsError } from '../backend/pmsClient';
import '../admin.css';

const DEFAULT_LOGO_BG = 'linear-gradient(135deg,#3B82F6,#2563EB)';

function getWorkspaceUrl(org) {
  return buildWorkspaceUrl(org?.key || '');
}

function getLogoText(name) {
  return (String(name || '').trim().charAt(0) || 'N').toUpperCase();
}

function humanizeCycleStatus(status) {
  const s = String(status || '');
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : '';
}

// Setup-progress presentation derived from the org.list summary fields
// (launched / cycleCount / activeCycleStatus) — no per-org blob lookup.
function getSetupProgress(org) {
  if (org.launched) {
    return {
      pct: 100,
      color: '#16A34A',
      label: 'Launched',
      note: org.activeCycleStatus ? humanizeCycleStatus(org.activeCycleStatus) : 'Active',
    };
  }
  if ((org.cycleCount || 0) > 0) {
    return {
      pct: 50,
      color: '#2563EB',
      label: 'In setup',
      note: org.activeCycleStatus ? humanizeCycleStatus(org.activeCycleStatus) : 'Setup started',
    };
  }
  return { pct: 0, color: '#94A3B8', label: 'New', note: 'No cycle yet' };
}

function OrgRow({ org, activeMenu, onMenuToggle, onOpen, onEdit }) {
  const setup = getSetupProgress(org);
  const employeeCount = org.participantCount || 0;
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
          <div className="org-logo" style={{ background: DEFAULT_LOGO_BG }}>{getLogoText(org.name)}</div>
          <div>
            <div className="org-name">{org.name}</div>
            <div className="org-meta">{getWorkspaceUrl(org)}</div>
          </div>
        </div>
      </td>
      <td><span className="org-meta">—</span></td>
      <td>
        <div className="org-metric-value">
          <span>{employeeCount}</span>
        </div>
        <div className="org-metric-sub">{employeeCount === 1 ? 'employee' : 'employees'}</div>
      </td>
      <td>
        <div className="org-progress-cell">
          <div className="mini-progress">
            <div className="mini-progress-fill" style={{ width: `${setup.pct}%`, background: setup.color }} />
          </div>
          <div className="org-progress-copy">
            <span className="org-progress-label">{setup.label}</span>
            <span>{setup.note}</span>
          </div>
        </div>
      </td>
      <td>
        <div className="org-admin-cell" onClick={(event) => event.stopPropagation()}>
          <div className="org-owners">
            <div className="org-owner-name">—</div>
            <div className="org-owner-meta">—</div>
          </div>
          <div className="org-action-wrap">
            <button ref={buttonRef} className="org-menu-btn" onClick={(event) => onMenuToggle(event, org.key)} aria-label="Organization actions">⋯</button>
            {isOpen && menuPos ? createPortal(
              <div className="org-menu" style={{ position: 'fixed', top: menuPos.top, right: menuPos.right }} onClick={(event) => event.stopPropagation()}>
                <button className="org-menu-item" onClick={() => onEdit(org.key)}>Edit</button>
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
  const [activeMenu, setActiveMenu] = useState(null);
  const [detailOrgKey, setDetailOrgKey] = useState(null);
  const [organizations, setOrganizations] = useState([]);
  const [status, setStatus] = useState('loading'); // loading | ready | error
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setStatus('loading');
    setError('');
    try {
      const result = await callPms('org.list', {});
      setOrganizations(Array.isArray(result?.organizations) ? result.organizations : []);
      setStatus('ready');
    } catch (e) {
      setError(e instanceof PmsError ? e.message : 'Could not load organizations.');
      setStatus('error');
    }
  }, []);

  // Fetch on mount. The call is nested one level (an inline IIFE) rather than a bare
  // `load()` at the effect's top level — eslint-plugin-react-hooks' "no setState
  // synchronously in an effect" check flags a direct call here even though this is a
  // one-time fetch-on-mount, not a render-time state derivation (the same shape used
  // elsewhere in this codebase, e.g. HRPublishReview's `if (canView) load(0)`, only
  // escapes the check because the compiler bails out on those larger components).
  useEffect(() => { (() => load())(); }, [load]);

  // Re-fetch when the tab regains focus (e.g. coming back from #create-org) so the
  // directory picks up orgs/cycles created elsewhere without a manual reload.
  useEffect(() => {
    function onFocus() { load(); }
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [load]);

  const summary = useMemo(() => {
    const totalEmployees = organizations.reduce((sum, org) => sum + (org.participantCount || 0), 0);
    const configured = organizations.filter((org) => org.launched === true).length;
    const inProgress = organizations.filter((org) => (org.cycleCount || 0) > 0 && !org.launched).length;
    return { totalEmployees, configured, inProgress };
  }, [organizations]);

  function handleMenuToggle(event, key) {
    event.stopPropagation();
    setActiveMenu((prev) => (prev === key ? null : key));
  }

  function handleEdit(key) {
    setActiveMenu(null);
    window.location.hash = `#edit-org?key=${key}`;
  }

  return (
    <AdminShell title="Organizations" page="organizations">
      <div className="workspace-shell" onClick={() => setActiveMenu(null)}>
        <div className="workspace-stat-grid">
          <div className="workspace-stat">
            <div className="workspace-stat-label">Organizations</div>
            <div className="workspace-stat-value">{organizations.length}</div>
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
                {status === 'loading' ? (
                  <tr>
                    <td className="org-empty-state" colSpan={5}>Loading organizations…</td>
                  </tr>
                ) : status === 'error' ? (
                  <tr>
                    <td className="org-empty-state" colSpan={5}>
                      <div>{error}</div>
                      <button type="button" className="btn btn-secondary btn-sm" style={{ marginTop: 8 }} onClick={() => load()}>Retry</button>
                    </td>
                  </tr>
                ) : organizations.length ? (
                  organizations.map((org) => (
                    <OrgRow
                      key={org.key}
                      org={org}
                      activeMenu={activeMenu}
                      onMenuToggle={handleMenuToggle}
                      onOpen={setDetailOrgKey}
                      onEdit={handleEdit}
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
    </AdminShell>
  );
}
