// Manager goal-review screen — closes the Plan 5b submit→approve loop.
//
// Data layer is `callWorkflow` ONLY (goal.review-queue / goal.get-plan / goal.approve /
// goal.send-back). No org-blob, no browser-persisted cache, no legacy blob data layer.
//
// The read-only KRA/KPI display grammar (card layout, accent colors, weight/target rows)
// is ported from src/pages/EmployeeGoals.jsx's KraCard/KpiRow — same visual language,
// but stripped to display-only (this screen never edits goal content, only approves or
// sends a submitted plan back).
//
// NOTE on target formatting: `goal.get-plan` returns raw DB rows (`target_type_key`,
// `target_value`) but — unlike `goal.context` — does not return the cycle's
// `cycle_target_types` config (unit/label metadata). A manager reviewing a report's plan
// has no config bundle to resolve units from, so targets are shown as
// "<value> (<humanized target_type_key>)" rather than with a resolved unit/label. This is
// a deliberate simplification given the documented backend contract for this task.

import { useEffect, useState, useCallback, useMemo } from 'react';
import { useApp } from '../AppContext';
import { callWorkflow, PmsError } from '../backend/pmsClient';
import '../admin.css';

// Accent palette for KRA cards — intentionally excludes red/green, which this app
// reserves for validation/status states (error / approved), not decoration.
const ACCENT_COLORS = [
  '#2563EB', '#EC4899', '#EAB308', '#7C3AED', '#F97316', '#06B6D4',
  '#C026D3', '#F59E0B', '#4F46E5', '#D946EF', '#0891B2', '#8B5CF6',
];

function accentFor(seed, index = 0) {
  const text = String(seed ?? index);
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
  return ACCENT_COLORS[Math.abs(hash) % ACCENT_COLORS.length];
}

// Status pill styling. Green is reserved for "Approved" (a real approved status, not
// decoration); everything else stays in the neutral/blue/amber families.
const STATUS_META = {
  submitted: { label: 'Submitted', bg: '#DBEAFE', color: '#1E3A8A' },
  approved: { label: 'Approved', bg: '#DCFCE7', color: '#166534' },
  sent_back: { label: 'Sent back for changes', bg: '#FEF3C7', color: '#92400E' },
  reopened: { label: 'Reopened by HR', bg: '#FEF3C7', color: '#92400E' },
  draft: { label: 'Draft', bg: '#F1F5F9', color: '#334155' },
};
const NOT_STARTED_META = { label: 'Not started', bg: '#F8FAFC', color: '#94A3B8' };

function statusMeta(planStatus) {
  if (!planStatus) return NOT_STARTED_META;
  return STATUS_META[planStatus] || { label: planStatus, bg: '#F1F5F9', color: '#334155' };
}

function StatusPill({ status }) {
  const meta = statusMeta(status);
  return (
    <span style={{
      display: 'inline-block', fontSize: 11, fontWeight: 700, color: meta.color, background: meta.bg,
      padding: '3px 10px', borderRadius: 999, whiteSpace: 'nowrap',
    }}>
      {meta.label}
    </span>
  );
}

function formatDate(value) {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' });
}

function humanizeTargetTypeKey(key) {
  if (!key) return '';
  return String(key)
    .replace(/^tt_(default_|neg_)?/, '')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function formatTarget(item) {
  const val = String(item?.target_value ?? '').trim();
  if (!val) return null;
  const typeLabel = humanizeTargetTypeKey(item?.target_type_key);
  return typeLabel ? `${val} (${typeLabel})` : val;
}

// ---- Read-only goal tree (ported grammar from EmployeeGoals' KraCard/KpiRow) ----------

function buildReadTree(items) {
  const kras = (items || []).filter((it) => it.item_type === 'kra').slice()
    .sort((a, b) => (a.display_order ?? 0) - (b.display_order ?? 0));
  const kpisByParent = new Map();
  (items || []).filter((it) => it.item_type === 'kpi').forEach((kpi) => {
    const list = kpisByParent.get(kpi.parent_item_id) || [];
    list.push(kpi);
    kpisByParent.set(kpi.parent_item_id, list);
  });
  return kras.map((kra) => ({
    kra,
    kpis: (kpisByParent.get(kra.id) || []).slice().sort((a, b) => (a.display_order ?? 0) - (b.display_order ?? 0)),
  }));
}

function KpiRowRO({ kpi, color }) {
  const target = formatTarget(kpi);
  return (
    <div style={{ padding: '10px 12px', borderRadius: 10, background: '#fff', border: '1px solid #E9EDF2', marginBottom: 8 }}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start', justifyContent: 'space-between' }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: '#0F172A', flex: 1 }}>{kpi.title}</div>
        {kpi.weight !== null && kpi.weight !== undefined && kpi.weight !== '' && (
          <span style={{ fontSize: 10.5, fontWeight: 800, color, background: `${color}14`, padding: '2px 8px', borderRadius: 999, whiteSpace: 'nowrap' }}>
            {kpi.weight}%
          </span>
        )}
      </div>
      {kpi.description && <div style={{ fontSize: 12, color: '#64748B', marginTop: 4 }}>{kpi.description}</div>}
      {(kpi.perspective || target) && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 6 }}>
          {kpi.perspective && <span style={{ fontSize: 11, color: '#94A3B8' }}>{kpi.perspective}</span>}
          {target && (
            <span style={{ fontSize: 11, fontWeight: 700, color: '#334155' }}>Target: {target}</span>
          )}
        </div>
      )}
    </div>
  );
}

function KraCardRO({ node, index, color }) {
  const { kra, kpis } = node;
  const target = formatTarget(kra);
  return (
    <div style={{ marginBottom: 14, borderRadius: 14, border: `1.5px solid ${color}33`, background: '#fff', boxShadow: '0 2px 10px rgba(15,23,42,.05)', overflow: 'hidden' }}>
      <div style={{ padding: '14px 16px', background: `linear-gradient(135deg, ${color}12, transparent 70%)`, borderBottom: `1px solid ${color}22` }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'flex-start' }}>
          <div style={{ fontSize: 10.5, fontWeight: 800, color, textTransform: 'uppercase', letterSpacing: '.08em' }}>
            Goal {index + 1}
          </div>
          {kra.weight !== null && kra.weight !== undefined && kra.weight !== '' && (
            <span style={{ fontSize: 11, fontWeight: 800, color, background: `${color}14`, padding: '2px 9px', borderRadius: 999 }}>
              {kra.weight}%
            </span>
          )}
        </div>
        <div style={{ fontSize: 14.5, fontWeight: 800, color: '#0F172A', marginTop: 6 }}>{kra.title}</div>
        {kra.description && <div style={{ fontSize: 12.5, color: '#64748B', marginTop: 4 }}>{kra.description}</div>}
        {(kra.perspective || target) && (
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 8 }}>
            {kra.perspective && <span style={{ fontSize: 11.5, color: '#64748B' }}>{kra.perspective}</span>}
            {target && <span style={{ fontSize: 11.5, fontWeight: 700, color: '#334155' }}>Target: {target}</span>}
          </div>
        )}
      </div>

      {kpis.length > 0 && (
        <div style={{ padding: '12px 16px 14px' }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: '#64748B', textTransform: 'uppercase', letterSpacing: '.07em', marginBottom: 8 }}>
            KPIs
          </div>
          {kpis.map((kpi) => <KpiRowRO key={kpi.id} kpi={kpi} color={color} />)}
        </div>
      )}
    </div>
  );
}

// ---- Report list -------------------------------------------------------------------

function ReportRow({ report, selected, onSelect }) {
  return (
    <button
      type="button"
      onClick={() => onSelect(report.employeeId)}
      style={{
        width: '100%', textAlign: 'left', padding: '12px 14px', borderRadius: 12, cursor: 'pointer',
        border: selected ? '1.5px solid #2563EB' : '1px solid #E2E8F0',
        background: selected ? '#EFF6FF' : '#fff', marginBottom: 8, fontFamily: 'inherit',
        display: 'flex', flexDirection: 'column', gap: 6,
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'flex-start' }}>
        <div>
          <div style={{ fontSize: 13.5, fontWeight: 700, color: '#0F172A' }}>{report.employeeName}</div>
          <div style={{ fontSize: 11, color: '#94A3B8' }}>{report.employeeCode}</div>
        </div>
        <StatusPill status={report.planStatus} />
      </div>
      <div style={{ fontSize: 11, color: '#64748B' }}>
        {report.kraCount} goal{report.kraCount === 1 ? '' : 's'}
        {report.submittedAt ? ` · submitted ${formatDate(report.submittedAt)}` : ''}
      </div>
    </button>
  );
}

// ---- Main component -----------------------------------------------------------------

export default function ManagerGoalReview() {
  const { orgId } = useApp();
  const [queue, setQueue] = useState(null); // { cycle, window, reports }
  const [status, setStatus] = useState('loading'); // loading | ready | error
  const [error, setError] = useState('');

  const [selectedId, setSelectedId] = useState(null);
  const [detail, setDetail] = useState(null); // { plan, items, competencies }
  const [detailStatus, setDetailStatus] = useState('idle'); // idle | loading | ready | error
  const [detailError, setDetailError] = useState('');

  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState('');
  const [actionNotice, setActionNotice] = useState('');
  const [showSendBack, setShowSendBack] = useState(false);
  const [note, setNote] = useState('');

  // background=true → a post-action refetch: keep the current view mounted (no
  // full-screen 'loading' flip) so approving/sending-back doesn't blank the UI.
  const loadQueue = useCallback(async (background = false) => {
    if (!background) { setStatus('loading'); setError(''); }
    try {
      const data = await callWorkflow('goal.review-queue', { orgId });
      setQueue(data);
      setStatus('ready');
      return data;
    } catch (e) {
      const msg = e instanceof PmsError ? e.message : 'Could not load your review queue.';
      if (background) { setActionError(msg); }        // keep the current queue visible
      else { setError(msg); setStatus('error'); }
      return null;
    }
  }, [orgId]);

  useEffect(() => { if (orgId) loadQueue(); }, [orgId, loadQueue]);

  const loadDetail = useCallback(async (employeeId, cycleId, background = false) => {
    if (!employeeId || !cycleId) return;
    if (!background) { setDetailStatus('loading'); setDetailError(''); }
    try {
      const data = await callWorkflow('goal.get-plan', { orgId, cycleId, employeeId });
      setDetail(data);
      setDetailStatus('ready');
    } catch (e) {
      const msg = e instanceof PmsError ? e.message : "Could not load this report's goals.";
      if (background) { setActionError(msg); }        // keep the current detail visible
      else { setDetailError(msg); setDetailStatus('error'); }
    }
  }, [orgId]);

  function selectReport(employeeId) {
    if (busy) return;
    setSelectedId(employeeId);
    setDetail(null);
    setActionError(''); setActionNotice(''); setShowSendBack(false); setNote('');
    loadDetail(employeeId, queue?.cycle?.id);
  }

  const selectedReport = useMemo(
    () => (queue?.reports || []).find((r) => r.employeeId === selectedId) || null,
    [queue, selectedId],
  );

  async function refreshAfterAction() {
    // Background refetch: the list + detail update in place without the screen
    // (and the just-set approve/send-back banner) flashing through 'loading'.
    const fresh = await loadQueue(true);
    if (selectedId && fresh?.cycle?.id) await loadDetail(selectedId, fresh.cycle.id, true);
  }

  async function handleActionError(e) {
    if (e instanceof PmsError && e.code === 'CONFLICT') {
      setActionError('Someone changed this plan — reloading.');
      await refreshAfterAction();
      return;
    }
    if (e instanceof PmsError && (e.code === 'PLAN_STATE' || e.code === 'WINDOW_CLOSED' || e.code === 'FORBIDDEN')) {
      setActionError(e.message);
      await refreshAfterAction();
      return;
    }
    setActionError(e instanceof PmsError ? e.message : 'That action failed.');
  }

  async function handleApprove() {
    const cycleId = queue?.cycle?.id;
    const plan = detail?.plan;
    if (!selectedId || !cycleId || !plan) return;
    setBusy(true); setActionError(''); setActionNotice('');
    try {
      await callWorkflow('goal.approve', { orgId, cycleId, employeeId: selectedId, planVersion: plan.version });
      setActionNotice('Plan approved.');
      await refreshAfterAction();
    } catch (e) {
      await handleActionError(e);
    } finally { setBusy(false); }
  }

  async function handleSendBack() {
    const cycleId = queue?.cycle?.id;
    const plan = detail?.plan;
    if (!selectedId || !cycleId || !plan) return;
    const trimmed = note.trim();
    if (!trimmed) { setActionError('Add a note explaining what needs to change before sending back.'); return; }
    setBusy(true); setActionError(''); setActionNotice('');
    try {
      await callWorkflow('goal.send-back', { orgId, cycleId, employeeId: selectedId, planVersion: plan.version, note: trimmed });
      setShowSendBack(false); setNote('');
      setActionNotice('Sent back to the employee for changes.');
      await refreshAfterAction();
    } catch (e) {
      await handleActionError(e);
    } finally { setBusy(false); }
  }

  // ---- Top-level states ----
  if (status === 'loading') {
    return <div style={{ padding: 20, fontSize: 13.5, color: '#64748B' }}>Loading your team's goals…</div>;
  }
  if (status === 'error') {
    return (
      <div style={{ padding: 20 }}>
        <div className="login-error" style={{ marginBottom: 12 }}>{error}</div>
        <button type="button" className="btn" onClick={() => loadQueue()}>Retry</button>
      </div>
    );
  }
  if (!queue?.cycle) {
    return <div style={{ padding: 20, fontSize: 13.5, color: '#64748B' }}>No active appraisal cycle yet.</div>;
  }
  if ((queue.reports || []).length === 0) {
    return <div style={{ padding: 20, fontSize: 13.5, color: '#64748B' }}>You have no direct reports in this cycle.</div>;
  }

  const windowOpen = !!queue.window?.approvalOpen;
  const planStatus = detail?.plan?.status || null;
  const tree = detail ? buildReadTree(detail.items) : [];
  const canAct = planStatus === 'submitted';

  return (
    <div style={{ padding: 20 }}>
      <div style={{ marginBottom: 16 }}>
        <div style={{ fontSize: 17, fontWeight: 800, color: '#0F172A' }}>{queue.cycle.name}</div>
        <div style={{ fontSize: 12.5, color: '#64748B', marginTop: 2 }}>
          {windowOpen ? 'Manager approval window is open' : 'Manager approval window is closed'}
        </div>
      </div>

      <div style={{ display: 'flex', gap: 20, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        <div style={{ flex: '0 0 300px', minWidth: 260 }}>
          {queue.reports.map((r) => (
            <ReportRow key={r.employeeId} report={r} selected={r.employeeId === selectedId} onSelect={selectReport} />
          ))}
        </div>

        <div style={{ flex: '1 1 420px', minWidth: 320 }}>
          {!selectedId && (
            <div style={{ padding: 24, borderRadius: 14, border: '1px dashed #E2E8F0', color: '#94A3B8', fontSize: 13, textAlign: 'center' }}>
              Select a direct report to review their goals.
            </div>
          )}

          {selectedId && detailStatus === 'loading' && (
            <div style={{ padding: 20, fontSize: 13.5, color: '#64748B' }}>Loading this report's goals…</div>
          )}

          {selectedId && detailStatus === 'error' && (
            <div>
              <div className="login-error" style={{ marginBottom: 12 }}>{detailError}</div>
              <button type="button" className="btn" onClick={() => loadDetail(selectedId, queue.cycle.id)}>Retry</button>
            </div>
          )}

          {selectedId && detailStatus === 'ready' && detail && (
            <div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 10, marginBottom: 14, flexWrap: 'wrap' }}>
                <div>
                  <div style={{ fontSize: 15, fontWeight: 800, color: '#0F172A' }}>{selectedReport?.employeeName}</div>
                  <div style={{ fontSize: 11.5, color: '#94A3B8' }}>{selectedReport?.employeeCode}</div>
                </div>
                <StatusPill status={planStatus} />
              </div>

              {actionNotice && (
                <div style={{ marginBottom: 12, padding: '9px 12px', borderRadius: 10, background: '#F8FAFC', border: '1px solid #E2E8F0', color: '#334155', fontSize: 12.5, fontWeight: 600 }}>
                  {actionNotice}
                </div>
              )}
              {actionError && <div className="login-error" style={{ marginBottom: 12 }}>{actionError}</div>}

              {!detail.plan && (
                <div style={{ padding: 16, borderRadius: 12, border: '1px dashed #E2E8F0', color: '#94A3B8', fontSize: 13, textAlign: 'center', marginBottom: 14 }}>
                  This report hasn't started their goal plan yet.
                </div>
              )}

              {detail.plan && tree.length === 0 && (
                <div style={{ padding: 16, borderRadius: 12, border: '1px dashed #E2E8F0', color: '#94A3B8', fontSize: 13, textAlign: 'center', marginBottom: 14 }}>
                  No goals on this plan yet.
                </div>
              )}

              {tree.map((node, i) => (
                <KraCardRO key={node.kra.id} node={node} index={i} color={accentFor(node.kra.id, i)} />
              ))}

              {canAct && !windowOpen && (
                <div style={{ marginTop: 14, padding: '10px 14px', borderRadius: 10, background: '#F8FAFC', border: '1px solid #E2E8F0', color: '#475569', fontSize: 12.5, fontWeight: 600 }}>
                  The manager approval window isn't open yet.
                </div>
              )}

              {canAct && windowOpen && (
                <div style={{ marginTop: 16 }}>
                  {!showSendBack && (
                    <div style={{ display: 'flex', gap: 10 }}>
                      <button type="button" className="btn btn-primary" disabled={busy} onClick={handleApprove}>Approve</button>
                      <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => { setShowSendBack(true); setActionError(''); }}>Send back</button>
                    </div>
                  )}
                  {showSendBack && (
                    <div>
                      <label className="lbl" htmlFor="mgr-goal-send-back-note">What needs to change?</label>
                      <textarea
                        id="mgr-goal-send-back-note"
                        value={note}
                        disabled={busy}
                        onChange={(e) => setNote(e.target.value)}
                        placeholder="Let the employee know what to revise before resubmitting."
                        rows={3}
                        maxLength={2000}
                        style={{ width: '100%', boxSizing: 'border-box', marginTop: 6, padding: '9px 11px', borderRadius: 10, border: '1.5px solid #D9E2EC', fontFamily: 'inherit', fontSize: 13, resize: 'vertical' }}
                      />
                      <div style={{ display: 'flex', gap: 10, marginTop: 10 }}>
                        <button type="button" className="btn btn-primary" disabled={busy || !note.trim()} onClick={handleSendBack}>Confirm send back</button>
                        <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => { setShowSendBack(false); setNote(''); setActionError(''); }}>Cancel</button>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
