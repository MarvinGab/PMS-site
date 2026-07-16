// HR review & publish screen — Plan 5d-core Task 2.
//
// Data layer is `callPms`/`callWorkflow` ONLY (publish.review-list / publish.bell-check /
// publish.publish / publish.revoke via callPms; calibration.adjust via callWorkflow). No
// org-blob, no browser-persisted cache, no legacy data-layer module.
//
// NOTE on `cycleId`: the deployed `publish.review-list` handler (supabase/functions/pms-admin/
// publishing.ts) requires an explicit `cycleId` — unlike `goal.review-queue`/`eval.context`,
// it does NOT resolve "the org's current review-status cycle" server-side (confirmed live via
// admin-check.mjs's `publish.review-list` assertions, which always pass `cycleId: pcycle.id`).
// There is no deployed read that lets this screen discover that id on its own (no cycle-list/
// current-cycle-for-HR action exists), and adding one is outside this task's file scope
// (`src/pages/HRPublishReview.jsx` only — no backend changes/deploys here). So this component
// takes `cycleId` as a prop: whichever screen hosts it (Task 3's routing / a cycle picker)
// already knows which cycle it's drilling into, and passes the id down. Every write action
// below then sources its own cycleId from the loaded `data.cycle.id`, matching the contract.
//
// The status-pill / accent / background-refetch grammar mirrors ManagerGoalReview.jsx and
// EmployeeSelfEval.jsx: post-action refetches pass `background=true` so a save/publish/revoke
// never blanks the screen back to a bare loading state; busy disables every action + input.
//
// Palette: red/green are reserved for real validation/status states (feedback_red_green_reserved)
// — used here ONLY for "within/outside tolerance" and "published" state, never as decoration.

import { useCallback, useEffect, useState } from 'react';
import { useApp } from '../AppContext';
import { callPms, callWorkflow, PmsError } from '../backend/pmsClient';
import '../admin.css';

const PAGE_SIZE = 50;

const GREEN = { bg: '#DCFCE7', color: '#166534' };
const RED = { bg: '#FEE2E2', color: '#991B1B' };
const AMBER = { bg: '#FEF3C7', color: '#92400E' };
const NEUTRAL = { bg: '#F1F5F9', color: '#334155' };
const BLUE = { bg: '#DBEAFE', color: '#1E3A8A' };

const FINAL_STATUS_META = {
  submitted: { label: 'Submitted', ...BLUE },
  draft: { label: 'Draft', ...NEUTRAL },
  missing: { label: 'Missing', ...AMBER },
};

function Pill({ meta }) {
  return (
    <span style={{
      display: 'inline-block', fontSize: 11, fontWeight: 700, color: meta.color, background: meta.bg,
      padding: '3px 10px', borderRadius: 999, whiteSpace: 'nowrap',
    }}>
      {meta.label}
    </span>
  );
}

function FinalStatusPill({ status }) {
  const meta = FINAL_STATUS_META[status] || { label: status || '—', ...NEUTRAL };
  return <Pill meta={meta} />;
}

function formatDate(value) {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function humanizeCycleStatus(status) {
  if (!status) return '';
  return String(status).replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function formatScore(score) {
  if (score === null || score === undefined) return '—';
  const n = Number(score);
  if (!Number.isFinite(n)) return '—';
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}

// ---- Bell-curve panel ---------------------------------------------------------------

function BellRow({ row }) {
  const meta = row.withinTolerance ? GREEN : RED;
  return (
    <tr>
      <td style={{ padding: '8px 10px', fontSize: 12.5, fontWeight: 700, color: '#0F172A' }}>{row.point}</td>
      <td style={{ padding: '8px 10px', fontSize: 12.5, color: '#475569' }}>
        {row.targetPercent}% &plusmn; {row.tolerancePercent}%
      </td>
      <td style={{ padding: '8px 10px', fontSize: 12.5, color: '#475569' }}>
        {row.actualPercent}% ({row.count})
      </td>
      <td style={{ padding: '8px 10px' }}><Pill meta={{ label: row.withinTolerance ? 'Within band' : 'Outside band', ...meta }} /></td>
    </tr>
  );
}

function BellPanel({ bell, onCheck, busy }) {
  const rows = bell?.rows || [];
  const overallMeta = bell?.withinTolerance ? GREEN : RED;
  return (
    <div style={{ marginBottom: 18, padding: '14px 16px', borderRadius: 14, border: '1px solid #E2E8F0', background: '#fff' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 10 }}>
        <div style={{ fontSize: 13.5, fontWeight: 800, color: '#0F172A' }}>Rating distribution</div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <Pill meta={{ label: bell?.withinTolerance ? 'Within tolerance' : 'Outside tolerance', ...overallMeta }} />
          <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={onCheck}>Check distribution</button>
        </div>
      </div>
      {rows.length === 0 ? (
        <div style={{ fontSize: 12.5, color: '#94A3B8' }}>No submitted final scores yet.</div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={{ textAlign: 'left', padding: '6px 10px', fontSize: 10.5, fontWeight: 700, color: '#64748B', textTransform: 'uppercase', letterSpacing: '.05em' }}>Rating</th>
                <th style={{ textAlign: 'left', padding: '6px 10px', fontSize: 10.5, fontWeight: 700, color: '#64748B', textTransform: 'uppercase', letterSpacing: '.05em' }}>Target</th>
                <th style={{ textAlign: 'left', padding: '6px 10px', fontSize: 10.5, fontWeight: 700, color: '#64748B', textTransform: 'uppercase', letterSpacing: '.05em' }}>Actual</th>
                <th style={{ textAlign: 'left', padding: '6px 10px', fontSize: 10.5, fontWeight: 700, color: '#64748B', textTransform: 'uppercase', letterSpacing: '.05em' }}>Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => <BellRow key={row.point} row={row} />)}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ---- Calibration inline editor -------------------------------------------------------

function CalibrateEditor({ participant, score, note, busy, onChangeScore, onChangeNote, onSave, onCancel }) {
  return (
    <div style={{ marginTop: 8, padding: '10px 12px', borderRadius: 10, background: '#F8FAFC', border: '1px solid #E2E8F0' }}>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
        <label className="lbl" htmlFor={`cal-score-${participant.employeeId}`}>New score</label>
        <input
          id={`cal-score-${participant.employeeId}`}
          type="number"
          step="any"
          value={score}
          disabled={busy}
          onChange={(e) => onChangeScore(e.target.value)}
          style={{ width: 100, padding: '7px 9px', borderRadius: 9, border: '1.5px solid #D9E2EC', fontFamily: 'inherit', fontSize: 13, boxSizing: 'border-box' }}
        />
      </div>
      <textarea
        value={note}
        disabled={busy}
        onChange={(e) => onChangeNote(e.target.value)}
        placeholder="Note (optional)"
        rows={2}
        maxLength={2000}
        style={{ marginTop: 8, width: '100%', boxSizing: 'border-box', padding: '8px 10px', borderRadius: 9, border: '1.5px solid #D9E2EC', fontFamily: 'inherit', fontSize: 12.5, resize: 'none' }}
      />
      <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
        <button type="button" className="btn btn-primary btn-sm" disabled={busy || score.trim() === ''} onClick={onSave}>Save</button>
        <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

// ---- Participant row ------------------------------------------------------------------

function ParticipantRow({
  participant, calibrating, calScore, calNote, busy,
  onStartCalibrate, onChangeScore, onChangeNote, onSaveCalibrate, onCancelCalibrate,
}) {
  const canAdjust = participant.finalStatus === 'submitted';
  return (
    <tr style={{ borderTop: '1px solid #E9EDF2' }}>
      <td style={{ padding: '10px', verticalAlign: 'top' }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: '#0F172A' }}>{participant.employeeName || '—'}</div>
        <div style={{ fontSize: 11, color: '#94A3B8' }}>{participant.employeeCode || ''}</div>
      </td>
      <td style={{ padding: '10px', verticalAlign: 'top' }}><FinalStatusPill status={participant.finalStatus} /></td>
      <td style={{ padding: '10px', verticalAlign: 'top', fontSize: 13, fontWeight: 700, color: '#0F172A' }}>{formatScore(participant.finalScore)}</td>
      <td style={{ padding: '10px', verticalAlign: 'top' }}>
        {canAdjust && calibrating !== participant.employeeId && (
          <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => onStartCalibrate(participant)}>Adjust</button>
        )}
        {canAdjust && calibrating === participant.employeeId && (
          <CalibrateEditor
            participant={participant}
            score={calScore}
            note={calNote}
            busy={busy}
            onChangeScore={onChangeScore}
            onChangeNote={onChangeNote}
            onSave={() => onSaveCalibrate(participant)}
            onCancel={onCancelCalibrate}
          />
        )}
      </td>
    </tr>
  );
}

// ---- Main component ---------------------------------------------------------------------

export default function HRPublishReview({ cycleId }) {
  const { orgId, role } = useApp();
  const canView = !!orgId && (role === 'hr_admin' || role === 'super_admin');

  const [data, setData] = useState(null); // {cycle, publication, bell, finalsMissing, total, participants}
  const [status, setStatus] = useState('loading'); // loading | ready | error
  const [error, setError] = useState('');
  const [offset, setOffset] = useState(0);
  const [listBusy, setListBusy] = useState(false);

  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState('');
  const [actionNotice, setActionNotice] = useState('');

  const [calibratingId, setCalibratingId] = useState(null);
  const [calScore, setCalScore] = useState('');
  const [calNote, setCalNote] = useState('');

  const [showForceConfirm, setShowForceConfirm] = useState(false);
  const [forceReason, setForceReason] = useState('');
  const [showRevoke, setShowRevoke] = useState(false);
  const [revokeReason, setRevokeReason] = useState('');

  // background=true → keep the current screen mounted (list/bell/publication update in
  // place) instead of flipping the whole screen back to 'loading' — used for post-action
  // refetches and pagination alike, per the ManagerGoalReview/EmployeeSelfEval pattern.
  const load = useCallback(async (offsetVal, background = false) => {
    if (!orgId || !cycleId) return null;
    if (!background) { setStatus('loading'); setError(''); } else { setListBusy(true); }
    try {
      const result = await callPms('publish.review-list', { orgId, cycleId, limit: PAGE_SIZE, offset: offsetVal });
      setData(result);
      setOffset(offsetVal);
      if (!background) setStatus('ready');
      return result;
    } catch (e) {
      const msg = e instanceof PmsError ? e.message : 'Could not load the review list.';
      if (background) setActionError(msg); else { setError(msg); setStatus('error'); }
      return null;
    } finally {
      if (background) setListBusy(false);
    }
  }, [orgId, cycleId]);

  useEffect(() => { if (canView && cycleId) load(0); }, [canView, cycleId, load]);

  async function refreshAfterAction() {
    await load(offset, true);
  }

  // ---- Calibration ----

  function startCalibrate(p) {
    if (busy) return;
    setCalibratingId(p.employeeId);
    setCalScore(p.finalScore != null ? String(p.finalScore) : '');
    setCalNote('');
    setActionError('');
  }
  function cancelCalibrate() {
    setCalibratingId(null); setCalScore(''); setCalNote('');
  }

  async function saveCalibrate(p) {
    const trimmed = calScore.trim();
    const scoreNum = Number(trimmed);
    if (trimmed === '' || Number.isNaN(scoreNum)) { setActionError('Enter a valid score.'); return; }
    setBusy(true); setActionError(''); setActionNotice('');
    try {
      await callWorkflow('calibration.adjust', {
        orgId, cycleId: data.cycle.id, employeeId: p.employeeId, stage: 'hr_final',
        evalVersion: p.evalVersion, afterScore: scoreNum, note: calNote.trim() || undefined,
      });
      setActionNotice(`Updated ${p.employeeName || 'the'} score.`);
      setCalibratingId(null); setCalScore(''); setCalNote('');
      await refreshAfterAction();
    } catch (e) {
      if (e instanceof PmsError && e.code === 'CONFLICT') {
        setActionError('Someone changed this evaluation — reloading.');
        await refreshAfterAction();
        return;
      }
      if (e instanceof PmsError && e.code === 'EVAL_NOT_SUBMITTED') {
        setActionError(e.message);
        await refreshAfterAction();
        return;
      }
      if (e instanceof PmsError && e.code === 'FORBIDDEN') {
        setActionError("You don't have permission to adjust this score.");
        return;
      }
      setActionError(e instanceof PmsError ? e.message : 'Could not save that adjustment.');
    } finally { setBusy(false); }
  }

  // ---- Bell-check ----

  async function handleCheckDistribution() {
    if (!data?.cycle) return;
    setBusy(true); setActionError(''); setActionNotice('');
    try {
      const bell = await callPms('publish.bell-check', { orgId, cycleId: data.cycle.id });
      setData((cur) => (cur ? { ...cur, bell } : cur));
      setActionNotice('Distribution refreshed.');
    } catch (e) {
      setActionError(e instanceof PmsError ? e.message : 'Could not check the distribution.');
    } finally { setBusy(false); }
  }

  // ---- Publish / revoke ----

  async function handlePublish(force = false, reason = '') {
    if (!data?.cycle) return;
    setBusy(true); setActionError(''); setActionNotice('');
    try {
      const payload = { orgId, cycleId: data.cycle.id };
      if (force) { payload.force = true; payload.reason = reason; }
      await callPms('publish.publish', payload);
      setActionNotice('Results published.');
      setShowForceConfirm(false); setForceReason('');
      await refreshAfterAction();
    } catch (e) {
      if (e instanceof PmsError && e.code === 'BELL_CURVE_VIOLATION' && !force) {
        setShowForceConfirm(true);
        setActionError(e.message);
        return;
      }
      if (e instanceof PmsError && (e.code === 'FINALS_INCOMPLETE' || e.code === 'CYCLE_WRONG_STATUS')) {
        setActionError(e.message);
        await refreshAfterAction();
        return;
      }
      if (e instanceof PmsError && e.code === 'ALREADY_PUBLISHED') {
        setActionError('This cycle has already been published.');
        await refreshAfterAction();
        return;
      }
      setActionError(e instanceof PmsError ? e.message : 'Could not publish results.');
    } finally { setBusy(false); }
  }

  async function handleRevoke() {
    if (!data?.cycle) return;
    const reason = revokeReason.trim();
    if (!reason) { setActionError('Add a reason before revoking.'); return; }
    setBusy(true); setActionError(''); setActionNotice('');
    try {
      await callPms('publish.revoke', { orgId, cycleId: data.cycle.id, reason });
      setActionNotice('Publication revoked.');
      setShowRevoke(false); setRevokeReason('');
      await refreshAfterAction();
    } catch (e) {
      if (e instanceof PmsError && e.code === 'NOT_PUBLISHED') {
        setActionError('This cycle has no active publication.');
        await refreshAfterAction();
        return;
      }
      setActionError(e instanceof PmsError ? e.message : 'Could not revoke publication.');
    } finally { setBusy(false); }
  }

  // ---- Top-level states ----

  if (!canView) {
    return <div style={{ padding: 20, fontSize: 13.5, color: '#64748B' }}>You don't have access to this screen.</div>;
  }
  if (!cycleId) {
    return <div style={{ padding: 20, fontSize: 13.5, color: '#64748B' }}>No cycle in review yet.</div>;
  }
  if (status === 'loading') {
    return <div style={{ padding: 20, fontSize: 13.5, color: '#64748B' }}>Loading the review…</div>;
  }
  if (status === 'error') {
    return (
      <div style={{ padding: 20 }}>
        <div className="login-error" style={{ marginBottom: 12 }}>{error}</div>
        <button type="button" className="btn" onClick={() => load(offset)}>Retry</button>
      </div>
    );
  }
  if (!data?.cycle) {
    return <div style={{ padding: 20, fontSize: 13.5, color: '#64748B' }}>No cycle in review yet.</div>;
  }

  const { cycle, publication, bell, finalsMissing, total, participants } = data;
  const page = participants || [];
  const rangeStart = page.length === 0 ? 0 : offset + 1;
  const rangeEnd = offset + page.length;
  const canPrev = offset > 0;
  const canNext = offset + page.length < total;

  return (
    <div style={{ padding: 20 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
        <div>
          <div style={{ fontSize: 17, fontWeight: 800, color: '#0F172A' }}>{cycle.name}</div>
          <div style={{ fontSize: 12.5, color: '#64748B', marginTop: 2 }}>{humanizeCycleStatus(cycle.status)}</div>
        </div>
        <Pill meta={{ label: publication.live ? 'Published' : 'Not published', ...(publication.live ? GREEN : NEUTRAL) }} />
      </div>

      {actionNotice && (
        <div style={{ marginBottom: 12, padding: '9px 12px', borderRadius: 10, background: '#F8FAFC', border: '1px solid #E2E8F0', color: '#334155', fontSize: 12.5, fontWeight: 600 }}>
          {actionNotice}
        </div>
      )}
      {actionError && <div className="login-error" style={{ marginBottom: 12 }}>{actionError}</div>}

      <BellPanel bell={bell} onCheck={handleCheckDistribution} busy={busy} />

      {finalsMissing > 0 && (
        <div style={{ marginBottom: 14, padding: '10px 14px', borderRadius: 10, background: '#FEF3C7', border: '1px solid #FDE68A', color: '#92400E', fontSize: 12.5, fontWeight: 600 }}>
          {finalsMissing} participant{finalsMissing === 1 ? '' : 's'} still missing a submitted final evaluation.
        </div>
      )}

      <div style={{ marginBottom: 18, padding: '14px 16px', borderRadius: 14, border: '1px solid #E2E8F0', background: '#fff' }}>
        {!publication.live && !showForceConfirm && (
          <button type="button" className="btn btn-primary" disabled={busy} onClick={() => handlePublish(false)}>Publish results</button>
        )}
        {!publication.live && showForceConfirm && (
          <div>
            <div style={{ fontSize: 12.5, color: '#475569', marginBottom: 8 }}>
              The distribution is outside tolerance. Publishing anyway requires a reason.
            </div>
            <label className="lbl" htmlFor="hr-publish-force-reason">Reason (required)</label>
            <textarea
              id="hr-publish-force-reason"
              value={forceReason}
              disabled={busy}
              onChange={(e) => setForceReason(e.target.value)}
              placeholder="Why publish despite the bell-curve violation?"
              rows={2}
              maxLength={2000}
              style={{ width: '100%', boxSizing: 'border-box', marginTop: 6, padding: '9px 11px', borderRadius: 10, border: '1.5px solid #D9E2EC', fontFamily: 'inherit', fontSize: 13, resize: 'vertical' }}
            />
            <div style={{ display: 'flex', gap: 10, marginTop: 10 }}>
              <button type="button" className="btn btn-primary" disabled={busy || !forceReason.trim()} onClick={() => handlePublish(true, forceReason.trim())}>Confirm force publish</button>
              <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => { setShowForceConfirm(false); setForceReason(''); setActionError(''); }}>Cancel</button>
            </div>
          </div>
        )}
        {publication.live && !showRevoke && (
          <div>
            <div style={{ fontSize: 12.5, color: '#475569', marginBottom: 10 }}>
              Published {formatDate(publication.publishedAt)}{publication.reason ? ` — ${publication.reason}` : ''}
            </div>
            <button type="button" className="btn btn-danger" disabled={busy} onClick={() => setShowRevoke(true)}>Revoke publication</button>
          </div>
        )}
        {publication.live && showRevoke && (
          <div>
            <label className="lbl" htmlFor="hr-revoke-reason">Reason (required)</label>
            <textarea
              id="hr-revoke-reason"
              value={revokeReason}
              disabled={busy}
              onChange={(e) => setRevokeReason(e.target.value)}
              placeholder="Why revoke this publication?"
              rows={2}
              maxLength={2000}
              style={{ width: '100%', boxSizing: 'border-box', marginTop: 6, padding: '9px 11px', borderRadius: 10, border: '1.5px solid #D9E2EC', fontFamily: 'inherit', fontSize: 13, resize: 'vertical' }}
            />
            <div style={{ display: 'flex', gap: 10, marginTop: 10 }}>
              <button type="button" className="btn btn-danger" disabled={busy || !revokeReason.trim()} onClick={handleRevoke}>Confirm revoke</button>
              <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => { setShowRevoke(false); setRevokeReason(''); setActionError(''); }}>Cancel</button>
            </div>
          </div>
        )}
      </div>

      <div style={{ padding: '14px 16px', borderRadius: 14, border: '1px solid #E2E8F0', background: '#fff' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 10 }}>
          <div style={{ fontSize: 13.5, fontWeight: 800, color: '#0F172A' }}>Participants</div>
          <div style={{ fontSize: 11.5, color: '#94A3B8' }}>
            {total === 0 ? 'No participants' : `${rangeStart}–${rangeEnd} of ${total}`}
          </div>
        </div>

        {page.length === 0 ? (
          <div style={{ padding: 16, borderRadius: 12, border: '1px dashed #E2E8F0', color: '#94A3B8', fontSize: 13, textAlign: 'center' }}>
            No active participants in this cycle.
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <th style={{ textAlign: 'left', padding: '6px 10px', fontSize: 10.5, fontWeight: 700, color: '#64748B', textTransform: 'uppercase', letterSpacing: '.05em' }}>Employee</th>
                  <th style={{ textAlign: 'left', padding: '6px 10px', fontSize: 10.5, fontWeight: 700, color: '#64748B', textTransform: 'uppercase', letterSpacing: '.05em' }}>Final status</th>
                  <th style={{ textAlign: 'left', padding: '6px 10px', fontSize: 10.5, fontWeight: 700, color: '#64748B', textTransform: 'uppercase', letterSpacing: '.05em' }}>Score</th>
                  <th style={{ textAlign: 'left', padding: '6px 10px', fontSize: 10.5, fontWeight: 700, color: '#64748B', textTransform: 'uppercase', letterSpacing: '.05em' }}></th>
                </tr>
              </thead>
              <tbody>
                {page.map((p) => (
                  <ParticipantRow
                    key={p.employeeId}
                    participant={p}
                    calibrating={calibratingId}
                    calScore={calScore}
                    calNote={calNote}
                    busy={busy}
                    onStartCalibrate={startCalibrate}
                    onChangeScore={setCalScore}
                    onChangeNote={setCalNote}
                    onSaveCalibrate={saveCalibrate}
                    onCancelCalibrate={cancelCalibrate}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}

        {(canPrev || canNext) && (
          <div style={{ display: 'flex', gap: 10, marginTop: 12 }}>
            <button type="button" className="btn btn-secondary btn-sm" disabled={listBusy || busy || !canPrev} onClick={() => load(Math.max(offset - PAGE_SIZE, 0), true)}>Previous</button>
            <button type="button" className="btn btn-secondary btn-sm" disabled={listBusy || busy || !canNext} onClick={() => load(offset + PAGE_SIZE, true)}>Next</button>
          </div>
        )}
      </div>
    </div>
  );
}
