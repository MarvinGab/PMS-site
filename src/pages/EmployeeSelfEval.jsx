// Employee self-evaluation screen — Plan 5c Task 2.
//
// Data layer is `callWorkflow` ONLY (eval.context / eval.ensure / eval.save-scores /
// eval.submit). No org-blob, no browser-persisted cache, no legacy data-layer module.
//
// The read-only KRA/KPI display grammar (card layout, accent colors, weight/target rows)
// is ported from src/pages/EmployeeGoals.jsx and src/pages/ManagerGoalReview.jsx — same
// visual language, but goal CONTENT is always read-only here: the employee rates goals,
// they never edit title/target/weight (that's the goal-setting screen's job).
//
// NOTE on which items get a rating input: `eval.context` left-joins each goal item onto
// `evaluation_goal_scores` and returns `item.score = null` when no score row exists for
// that item, vs `item.score = { achievement_value, achievement_percent, score, comment }`
// (all fields possibly null) when a row *does* exist. The backend only seeds a score row
// per item at the cycle's configured rating level (`ratingLevelFor` — KRA-only or KPI-only,
// see supabase/functions/pms-workflow/evals.ts `seedScores`). So `item.score !== null` is
// the authoritative signal for "this item is rateable" — it already encodes the KRA-vs-KPI
// rating level server-side, so the frontend doesn't need to (and isn't given enough info
// via `config` to) re-derive that decision independently.
//
// NOTE on achievement-value vs rating-scale select: `eval.context`'s `items` do not expose
// `cycle_target_types.is_numeric` (only `scoringContext` on the backend sees that, for
// computing achievement% + auto-rating). The task brief's own heuristic — "if the target
// type is numeric (has a target_value)" — is what's used here: a rateable item with a
// non-empty `target_value` gets an achievement-value input (backend computes % + auto-rates
// from bands) plus an optional manual rating-scale override; a rateable item with no target
// value gets a plain rating-scale select. `config.kpiRatingMode === 'free-text'` additionally
// hides the achievement-value input on KPI rows (falls back to the rating-scale select),
// per the brief.

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

const REASON_MESSAGES = {
  NO_PLAN: 'No goal plan found yet.',
  GOALS_NOT_APPROVED: "Your goals aren't approved yet.",
  WINDOW_CLOSED: 'The self-evaluation window is closed.',
};

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

function hasNumericTarget(item) {
  return String(item?.target_value ?? '').trim() !== '';
}

// ---- Read (DB rows + LEFT-joined score) -> local editable rating maps ---------------

function buildGoalEdits(items) {
  const map = {};
  (items || []).forEach((it) => {
    if (!it.score) return; // not rateable at this cycle's rating level
    map[it.id] = {
      achievementValue: it.score.achievement_value ?? '',
      score: it.score.score === null || it.score.score === undefined ? '' : String(it.score.score),
      comment: it.score.comment ?? '',
    };
  });
  return map;
}

function buildCompEdits(competencies) {
  const map = {};
  (competencies || []).forEach((c) => {
    map[c.competency_name] = {
      score: c.score?.score === null || c.score?.score === undefined ? '' : String(c.score.score),
      comment: c.score?.comment ?? '',
    };
  });
  return map;
}

function toGoalScoresPayload(goalEdits) {
  return Object.entries(goalEdits).map(([goalItemId, v]) => ({
    goalItemId,
    achievementValue: v.achievementValue || undefined,
    score: v.score === '' ? undefined : Number(v.score),
    comment: v.comment || undefined,
  }));
}

function toCompScoresPayload(compEdits) {
  return Object.entries(compEdits).map(([competencyName, v]) => ({
    competencyName,
    score: v.score === '' ? undefined : Number(v.score),
    comment: v.comment || undefined,
  }));
}

function buildTree(items) {
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

// ---- Small presentational pieces -----------------------------------------------------

function RatingScaleSelect({ value, ratingScale, disabled, onChange }) {
  return (
    <select
      value={value ?? ''}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
      style={{ padding: '8px 10px', borderRadius: 9, border: '1.5px solid #D9E2EC', fontFamily: 'inherit', fontSize: 13, background: '#fff', minWidth: 160 }}
    >
      <option value="">Rate…</option>
      {(ratingScale || []).map((lvl) => (
        <option key={lvl.id ?? lvl.point} value={lvl.point}>{lvl.label} ({lvl.point})</option>
      ))}
    </select>
  );
}

function RatingRow({
  item, color, editable, readOnly, achievementMode, ratingScale, edit, onChange,
}) {
  const target = formatTarget(item);
  const savedPct = item.score?.achievement_percent;
  const savedScore = item.score?.score;

  if (readOnly) {
    return (
      <div style={{ marginTop: 10, padding: '10px 12px', borderRadius: 10, background: '#F8FAFC', border: '1px solid #E2E8F0' }}>
        <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', fontSize: 12.5 }}>
          {item.score?.achievement_value != null && item.score.achievement_value !== '' && (
            <span style={{ color: '#334155' }}><strong>Achieved:</strong> {item.score.achievement_value}{savedPct != null ? ` (${savedPct}%)` : ''}</span>
          )}
          <span style={{ color: '#334155' }}><strong>Rating:</strong> {savedScore != null ? savedScore : '—'}</span>
        </div>
        {item.score?.comment && <div style={{ marginTop: 6, fontSize: 12, color: '#64748B' }}>{item.score.comment}</div>}
      </div>
    );
  }

  return (
    <div style={{ marginTop: 10, padding: '10px 12px', borderRadius: 10, background: '#fff', border: `1px solid ${color}33` }}>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
        {achievementMode && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ fontSize: 11, fontWeight: 700, color: '#64748B', textTransform: 'uppercase', letterSpacing: '.05em' }}>Achieved</span>
            <input
              type="text"
              value={edit?.achievementValue ?? ''}
              disabled={!editable}
              placeholder={target || 'Value'}
              onChange={(e) => onChange('achievementValue', e.target.value)}
              style={{ width: 120, padding: '8px 10px', borderRadius: 9, border: '1.5px solid #D9E2EC', fontFamily: 'inherit', fontSize: 13, boxSizing: 'border-box' }}
            />
            {savedPct != null && <span style={{ fontSize: 11.5, color: '#94A3B8' }}>last saved: {savedPct}%{savedScore != null ? ` → ${savedScore}` : ''}</span>}
          </div>
        )}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontSize: 11, fontWeight: 700, color: '#64748B', textTransform: 'uppercase', letterSpacing: '.05em' }}>
            {achievementMode ? 'Override rating' : 'Rating'}
          </span>
          <RatingScaleSelect
            value={edit?.score ?? ''}
            ratingScale={ratingScale}
            disabled={!editable}
            onChange={(v) => onChange('score', v)}
          />
        </div>
      </div>
      <textarea
        value={edit?.comment ?? ''}
        disabled={!editable}
        onChange={(e) => onChange('comment', e.target.value)}
        placeholder="Comment (optional)"
        rows={2}
        style={{ marginTop: 8, width: '100%', boxSizing: 'border-box', padding: '8px 10px', borderRadius: 9, border: '1.5px solid #D9E2EC', fontFamily: 'inherit', fontSize: 12.5, resize: 'none' }}
      />
    </div>
  );
}

function KpiRow({ kpi, color, editable, readOnly, kpiRatingMode, ratingScale, showTarget, edit, onChange }) {
  const target = formatTarget(kpi);
  const rateable = !!kpi.score;
  const achievementMode = hasNumericTarget(kpi) && kpiRatingMode !== 'free-text';
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
      {(kpi.perspective || (showTarget && target)) && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 6 }}>
          {kpi.perspective && <span style={{ fontSize: 11, color: '#94A3B8' }}>{kpi.perspective}</span>}
          {showTarget && target && <span style={{ fontSize: 11, fontWeight: 700, color: '#334155' }}>Target: {target}</span>}
        </div>
      )}
      {rateable && (
        <RatingRow
          item={kpi} color={color} editable={editable} readOnly={readOnly}
          achievementMode={achievementMode} ratingScale={ratingScale} edit={edit} onChange={onChange}
        />
      )}
    </div>
  );
}

function KraCard({
  node, index, color, editable, readOnly, kpiRatingMode, ratingScale, showKraTarget, showKpiTarget,
  goalEdits, onChangeGoal,
}) {
  const { kra, kpis } = node;
  const target = formatTarget(kra);
  const rateable = !!kra.score;
  const achievementMode = hasNumericTarget(kra);

  return (
    <div style={{ marginBottom: 16, borderRadius: 14, border: `1.5px solid ${color}33`, background: '#fff', boxShadow: '0 2px 10px rgba(15,23,42,.05)', overflow: 'hidden' }}>
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
        {(kra.perspective || (showKraTarget && target)) && (
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 8 }}>
            {kra.perspective && <span style={{ fontSize: 11.5, color: '#64748B' }}>{kra.perspective}</span>}
            {showKraTarget && target && <span style={{ fontSize: 11.5, fontWeight: 700, color: '#334155' }}>Target: {target}</span>}
          </div>
        )}
        {rateable && (
          <RatingRow
            item={kra} color={color} editable={editable} readOnly={readOnly}
            achievementMode={achievementMode} ratingScale={ratingScale}
            edit={goalEdits[kra.id]} onChange={(field, value) => onChangeGoal(kra.id, field, value)}
          />
        )}
      </div>

      {kpis.length > 0 && (
        <div style={{ padding: '12px 16px 14px' }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: '#64748B', textTransform: 'uppercase', letterSpacing: '.07em', marginBottom: 8 }}>
            KPIs
          </div>
          {kpis.map((kpi) => (
            <KpiRow
              key={kpi.id}
              kpi={kpi}
              color={color}
              editable={editable}
              readOnly={readOnly}
              kpiRatingMode={kpiRatingMode}
              ratingScale={ratingScale}
              showTarget={showKpiTarget}
              edit={goalEdits[kpi.id]}
              onChange={(field, value) => onChangeGoal(kpi.id, field, value)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function CompetencyRow({ comp, color, editable, readOnly, ratingScale, edit, onChange }) {
  if (readOnly) {
    return (
      <div style={{ padding: '10px 12px', borderRadius: 10, background: '#fff', border: '1px solid #E9EDF2', marginBottom: 8 }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: '#0F172A' }}>{comp.competency_name}</div>
        <div style={{ marginTop: 6, fontSize: 12.5, color: '#334155' }}>
          <strong>Rating:</strong> {comp.score?.score != null ? comp.score.score : '—'}
        </div>
        {comp.score?.comment && <div style={{ marginTop: 4, fontSize: 12, color: '#64748B' }}>{comp.score.comment}</div>}
      </div>
    );
  }
  return (
    <div style={{ padding: '10px 12px', borderRadius: 10, background: '#fff', border: `1px solid ${color}33`, marginBottom: 8 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: '#0F172A' }}>{comp.competency_name}</div>
        <RatingScaleSelect
          value={edit?.score ?? ''}
          ratingScale={ratingScale}
          disabled={!editable}
          onChange={(v) => onChange('score', v)}
        />
      </div>
      <textarea
        value={edit?.comment ?? ''}
        disabled={!editable}
        onChange={(e) => onChange('comment', e.target.value)}
        placeholder="Comment (optional)"
        rows={2}
        style={{ marginTop: 8, width: '100%', boxSizing: 'border-box', padding: '8px 10px', borderRadius: 9, border: '1.5px solid #D9E2EC', fontFamily: 'inherit', fontSize: 12.5, resize: 'none' }}
      />
    </div>
  );
}

// ---- Main component -------------------------------------------------------------------

export default function EmployeeSelfEval() {
  const { orgId, employeeId } = useApp();
  const [ctx, setCtx] = useState(null); // eval.context result (source of truth)
  const [status, setStatus] = useState('loading'); // loading | ready | error
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState('');
  const [actionNotice, setActionNotice] = useState('');
  const [overallScore, setOverallScore] = useState(undefined); // only known right after save/submit

  const [goalEdits, setGoalEdits] = useState({});
  const [compEdits, setCompEdits] = useState({});

  const applyCtx = useCallback((data) => {
    setCtx(data);
    setGoalEdits(buildGoalEdits(data.items));
    setCompEdits(buildCompEdits(data.competencies));
  }, []);

  const load = useCallback(async () => {
    setStatus('loading'); setError('');
    try {
      let data = await callWorkflow('eval.context', { orgId });
      if (data.available && data.cycle && !data.evaluation) {
        await callWorkflow('eval.ensure', { orgId, cycleId: data.cycle.id, stage: 'self' });
        data = await callWorkflow('eval.context', { orgId });
      }
      applyCtx(data);
      setStatus('ready');
    } catch (e) {
      setError(e instanceof PmsError ? e.message : 'Could not load your self-evaluation.');
      setStatus('error');
    }
  }, [orgId, applyCtx]);

  useEffect(() => { if (orgId) load(); }, [orgId, load]);

  // Background refetch (after save/submit/errors): re-pull eval.context without flipping
  // the whole screen back to 'loading' — keeps the form mounted so a save doesn't flash.
  const refreshBackground = useCallback(async () => {
    try {
      const data = await callWorkflow('eval.context', { orgId });
      applyCtx(data);
      return data;
    } catch (e) {
      setActionError(e instanceof PmsError ? e.message : 'Could not refresh your self-evaluation.');
      return null;
    }
  }, [orgId, applyCtx]);

  async function startEvaluation() {
    if (!ctx?.cycle) return;
    setBusy(true); setActionError('');
    try {
      await callWorkflow('eval.ensure', { orgId, cycleId: ctx.cycle.id, stage: 'self' });
      await refreshBackground();
    } catch (e) {
      setActionError(e instanceof PmsError ? e.message : 'Could not start your self-evaluation.');
    } finally { setBusy(false); }
  }

  async function handleActionError(e, verb) {
    if (e instanceof PmsError && e.code === 'CONFLICT') {
      setActionError('Someone changed this — reloading.');
      await refreshBackground();
      return;
    }
    if (e instanceof PmsError && e.code === 'WINDOW_CLOSED') {
      setActionError('The self-evaluation window is closed.');
      await refreshBackground();
      return;
    }
    if (e instanceof PmsError && (e.code === 'GOALS_NOT_APPROVED' || e.code === 'SELF_NOT_SUBMITTED' || e.code === 'MANAGER_NOT_SUBMITTED')) {
      setActionError(e.message);
      await refreshBackground();
      return;
    }
    if (e instanceof PmsError && e.code === 'EVAL_LOCKED') {
      setActionError('This evaluation is no longer editable — reloading.');
      await refreshBackground();
      return;
    }
    if (e instanceof PmsError && e.code === 'FORBIDDEN') {
      setActionError("You don't have permission to do that.");
      return;
    }
    if (e instanceof PmsError && e.code === 'NOTHING_SCORED') {
      setActionError('Rate at least one goal before submitting.');
      return;
    }
    setActionError(e instanceof PmsError ? e.message : `Could not ${verb}.`);
  }

  async function save() {
    if (!ctx?.cycle || !ctx?.evaluation || !employeeId) return;
    setBusy(true); setActionError(''); setActionNotice('');
    try {
      const data = await callWorkflow('eval.save-scores', {
        orgId, cycleId: ctx.cycle.id, employeeId, stage: 'self', evalVersion: ctx.evaluation.version,
        goalScores: toGoalScoresPayload(goalEdits), competencyScores: toCompScoresPayload(compEdits),
      });
      if (data?.evaluation?.overall_score !== undefined) setOverallScore(data.evaluation.overall_score);
      await refreshBackground();
      setActionNotice('Saved.');
    } catch (e) {
      await handleActionError(e, 'save your ratings');
    } finally { setBusy(false); }
  }

  async function submit() {
    if (!ctx?.cycle || !ctx?.evaluation || !employeeId) return;
    setBusy(true); setActionError(''); setActionNotice('');
    try {
      // Save first so nothing typed since the last save is lost on submit.
      const saved = await callWorkflow('eval.save-scores', {
        orgId, cycleId: ctx.cycle.id, employeeId, stage: 'self', evalVersion: ctx.evaluation.version,
        goalScores: toGoalScoresPayload(goalEdits), competencyScores: toCompScoresPayload(compEdits),
      });
      const data = await callWorkflow('eval.submit', {
        orgId, cycleId: ctx.cycle.id, employeeId, stage: 'self', evalVersion: saved.evaluation.version,
      });
      if (data?.evaluation?.overall_score !== undefined) setOverallScore(data.evaluation.overall_score);
      setActionNotice('Self-evaluation submitted.');
      await refreshBackground();
    } catch (e) {
      await handleActionError(e, 'submit your self-evaluation');
    } finally { setBusy(false); }
  }

  function changeGoal(itemId, field, value) {
    setGoalEdits((cur) => ({ ...cur, [itemId]: { ...cur[itemId], [field]: value } }));
  }
  function changeComp(name, field, value) {
    setCompEdits((cur) => ({ ...cur, [name]: { ...cur[name], [field]: value } }));
  }

  const config = ctx?.config || {};
  const tree = useMemo(() => buildTree(ctx?.items), [ctx]);
  const showKraTarget = config.targetLevelMode === 'KRA';
  const showKpiTarget = config.targetLevelMode !== 'KRA';
  const readOnly = ctx?.evaluation?.status === 'submitted';
  const editable = ctx?.evaluation?.status === 'draft';

  if (status === 'loading') return <div style={{ padding: 20, fontSize: 13.5, color: '#64748B' }}>Loading your self-evaluation…</div>;
  if (status === 'error') {
    return (
      <div style={{ padding: 20 }}>
        <div className="login-error" style={{ marginBottom: 12 }}>{error}</div>
        <button type="button" className="btn" onClick={load}>Retry</button>
      </div>
    );
  }
  if (!ctx?.cycle) return <div style={{ padding: 20, fontSize: 13.5, color: '#64748B' }}>No active appraisal cycle yet.</div>;

  if (!ctx.available && !ctx.evaluation) {
    return (
      <div style={{ padding: 20 }}>
        <div style={{ fontSize: 17, fontWeight: 800, color: '#0F172A', marginBottom: 10 }}>{ctx.cycle.name}</div>
        <div style={{ padding: '18px 20px', borderRadius: 14, border: '1px solid #E2E8F0', background: '#F8FAFC', textAlign: 'center', color: '#64748B', fontSize: 13 }}>
          {REASON_MESSAGES[ctx.reason] || 'Self-evaluation is not available yet.'}
        </div>
      </div>
    );
  }

  // Available but somehow no evaluation yet (auto-ensure on load should normally cover
  // this) — offer a manual start as a fallback rather than a dead end.
  if (!ctx.evaluation) {
    return (
      <div style={{ padding: 20 }}>
        <div style={{ fontSize: 17, fontWeight: 800, color: '#0F172A', marginBottom: 10 }}>{ctx.cycle.name}</div>
        {actionError && <div className="login-error" style={{ marginBottom: 12 }}>{actionError}</div>}
        <div style={{ padding: '18px 20px', borderRadius: 14, border: '1.5px dashed #C7D2FE', background: '#F6F8FF', textAlign: 'center' }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: '#0F172A', marginBottom: 4 }}>You haven't started your self-evaluation yet.</div>
          <button type="button" className="btn btn-primary" disabled={busy} onClick={startEvaluation}>Start my self-evaluation</button>
        </div>
      </div>
    );
  }

  return (
    <div style={{ padding: 20 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
        <div>
          <div style={{ fontSize: 17, fontWeight: 800, color: '#0F172A' }}>{ctx.cycle.name}</div>
          <div style={{ fontSize: 12.5, color: '#64748B', marginTop: 2 }}>
            {ctx.window?.selfEvalOpen ? 'Self-evaluation window is open' : 'Self-evaluation window is closed'}
          </div>
        </div>
        <span style={{ fontSize: 12, fontWeight: 700, color: '#334155', background: '#F1F5F9', border: '1px solid #E2E8F0', padding: '5px 12px', borderRadius: 999 }}>
          {readOnly ? 'Submitted — awaiting review' : 'Draft'}
        </span>
      </div>

      {actionNotice && (
        <div style={{ marginBottom: 12, padding: '9px 12px', borderRadius: 10, background: '#F8FAFC', border: '1px solid #E2E8F0', color: '#334155', fontSize: 12.5, fontWeight: 600 }}>
          {actionNotice}{overallScore != null ? ` Overall: ${overallScore}.` : ''}
        </div>
      )}
      {actionError && <div className="login-error" style={{ marginBottom: 12 }}>{actionError}</div>}

      {readOnly && (
        <div style={{ marginBottom: 14, padding: '10px 14px', borderRadius: 10, background: '#F8FAFC', border: '1px solid #E2E8F0', color: '#475569', fontSize: 12.5, fontWeight: 600 }}>
          Your self-evaluation has been submitted and can no longer be edited.
        </div>
      )}
      {editable && !ctx.window?.selfEvalOpen && (
        <div style={{ marginBottom: 14, padding: '10px 14px', borderRadius: 10, background: '#F8FAFC', border: '1px solid #E2E8F0', color: '#475569', fontSize: 12.5, fontWeight: 600 }}>
          The self-evaluation window isn't open yet — you can view your goals but not save changes.
        </div>
      )}

      {tree.length === 0 && (
        <div style={{ padding: 16, borderRadius: 12, border: '1px dashed #E2E8F0', color: '#94A3B8', fontSize: 13, textAlign: 'center', marginBottom: 14 }}>
          No goals on your approved plan yet.
        </div>
      )}

      {tree.map((node, i) => (
        <KraCard
          key={node.kra.id}
          node={node}
          index={i}
          color={accentFor(node.kra.id, i)}
          editable={editable}
          readOnly={readOnly}
          kpiRatingMode={config.kpiRatingMode}
          ratingScale={config.ratingScale}
          showKraTarget={showKraTarget}
          showKpiTarget={showKpiTarget}
          goalEdits={goalEdits}
          onChangeGoal={changeGoal}
        />
      ))}

      {config.competency?.enabled && (ctx.competencies || []).length > 0 && (
        <div style={{ marginTop: 8, marginBottom: 16 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: '#64748B', textTransform: 'uppercase', letterSpacing: '.07em', marginBottom: 8 }}>
            Competencies
          </div>
          {ctx.competencies.map((comp, i) => (
            <CompetencyRow
              key={comp.id ?? comp.competency_name}
              comp={comp}
              color={accentFor(comp.competency_name, i)}
              editable={editable}
              readOnly={readOnly}
              ratingScale={config.ratingScale}
              edit={compEdits[comp.competency_name]}
              onChange={(field, value) => changeComp(comp.competency_name, field, value)}
            />
          ))}
        </div>
      )}

      {editable && (
        <div style={{ display: 'flex', gap: 10, marginTop: 8 }}>
          <button type="button" className="btn" disabled={busy || !ctx.window?.selfEvalOpen} onClick={save}>Save</button>
          <button type="button" className="btn btn-primary" disabled={busy || !ctx.window?.selfEvalOpen} onClick={submit}>Submit</button>
        </div>
      )}
    </div>
  );
}
