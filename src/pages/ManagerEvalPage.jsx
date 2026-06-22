import { useEffect, useMemo, useRef, useState } from 'react';
import { readEmployeeSessionSync, readWorkflowSync, persistWorkflow } from '../backend/stateStore';
import { useApp } from '../AppContext';
import { usePMSData, SUB_PHASE } from '../hooks/usePMSData';
import { RatingWidget } from '../components/RatingWidget';
import { getEmployeeStage, setEmployeeStage, submitEmployeeStage, readRatings, sendBackForCompletion } from '../backend/ratingsStore';
import { resolveCompetenciesForEmployee } from '../backend/competencyResolver';
import { computeGoalAutoRatings, computeSelfScoreBreakdown, formatFinalRating, getScaleLevels } from '../backend/scoring';

const FIELD_LABEL = { fontSize: 10.5, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '.04em' };
const COMP_ACCENT = '#0E7490';

// Format a stored score the same way the configured rating display shows it.
function formatChoiceLabel(config, score) {
  if (score === null || score === undefined || score === '') return '—';
  const scale = getScaleLevels(config);
  const lvl = scale.find((l) => String(l.n) === String(Number(score)));
  if (!lvl) return String(score);
  const disp = config?.ratingChoiceDisplay || 'number-label';
  if (disp === 'number-only') return String(lvl.code || lvl.n);
  if (disp === 'label-only') return String(lvl.l || lvl.code || lvl.n);
  return `${lvl.code || lvl.n} - ${lvl.l || ''}`;
}

const BORDER = '#E2E8F0';
const SOFT_BG = '#F8FAFC';
const FALLBACK_GOAL_COLORS = ['#2563EB', '#EC4899', '#EAB308', '#7C3AED', '#F97316', '#0EA5E9', '#14B8A6'];
// Shared column layout: [name | target | employee | manager]. The goal header
// and the KPI rows both use this so the score boxes line up over the
// achievement boxes in one column.
const SCORE_GRID = 'minmax(0, 1fr) minmax(110px, 0.14fr) minmax(150px, 0.18fr) minmax(220px, 0.24fr)';

function normalizeCode(v) {
  return String(v || '').trim().toUpperCase();
}

function findEmployee(employees, empCode) {
  return employees.find((e) => normalizeCode(e['Employee Code']) === normalizeCode(empCode)) || null;
}

function getEmployeeGroup(config, employee) {
  const groupName = String(employee?.['Group Name'] || '').trim().toLowerCase();
  if (!groupName) return null;
  return (config?.goalGroups || []).find(
    (g) => String(g.name || '').trim().toLowerCase() === groupName
  ) || null;
}

function getGoalColor(kra = {}, config = {}, index = 0) {
  const stored = String(kra.displayColor || '').trim();
  if (stored) return stored;
  const perspectiveName = String(kra.perspName || '').trim();
  const perspective = (config?.perspectives || []).find(
    (p) => String(p?.name || '').trim() === perspectiveName
  );
  if (perspective?.color) return perspective.color;
  return FALLBACK_GOAL_COLORS[index % FALLBACK_GOAL_COLORS.length];
}

// Target-type formatting — same logic the employee page uses, so units (₹, %, days) match.
const DEFAULT_TARGET_TYPES = [
  { id: 'tt_default_number', name: 'Number', unit: '', unitPosition: 'suffix', isNumeric: true },
  { id: 'tt_default_percentage', name: 'Percentage', unit: '%', unitPosition: 'suffix', isNumeric: true },
  { id: 'tt_default_currency', name: 'Currency', unit: '₹', unitPosition: 'prefix', isNumeric: true },
  { id: 'tt_neg_number', name: 'Negative number', unit: '', unitPosition: 'suffix', isNumeric: true, lowerIsBetter: true },
  { id: 'tt_neg_currency', name: 'Negative currency', unit: '₹', unitPosition: 'prefix', isNumeric: true, lowerIsBetter: true },
  { id: 'tt_default_text', name: 'Free text', unit: '', unitPosition: 'suffix', isNumeric: false },
];
function normalizeTargetTypeName(value) {
  return String(value || '').trim().toLowerCase().replace(/[_\s-]+/g, ' ');
}
function getMergedTargetTypes(config = {}) {
  const stored = Array.isArray(config?.targetTypes) ? config.targetTypes : [];
  const storedById = new Map(stored.map((type) => [type.id, type]));
  const defaults = DEFAULT_TARGET_TYPES.map((type) => ({ ...type, ...(storedById.get(type.id) || {}) }));
  const custom = stored.filter((type) => type?.id && !DEFAULT_TARGET_TYPES.some((item) => item.id === type.id));
  return [...defaults, ...custom].filter((type) => !type.hidden);
}
function getTargetTypeMeta(typeId, targetTypes = []) {
  const raw = String(typeId || '').trim();
  const normalized = normalizeTargetTypeName(raw);
  return (targetTypes || []).find((type) => type.id === raw)
    || (targetTypes || []).find((type) => normalizeTargetTypeName(type.name) === normalized)
    || DEFAULT_TARGET_TYPES.find((type) => type.id === raw)
    || DEFAULT_TARGET_TYPES.find((type) => normalizeTargetTypeName(type.name) === normalized)
    || DEFAULT_TARGET_TYPES.find((type) => type.id === 'tt_default_text');
}
function formatTargetValue(value, typeId, targetTypes = []) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  const meta = getTargetTypeMeta(typeId, targetTypes);
  const unit = String(meta?.unit || '').trim();
  if (!unit) return text;
  return meta?.unitPosition === 'prefix' ? `${unit} ${text}` : `${text} ${unit}`;
}

function getReports(employees, managerCode) {
  const code = normalizeCode(managerCode);
  return employees.filter((e) => normalizeCode(e['Reporting Manager Code']) === code);
}

function getEmployeeGoals(orgKey, empCode) {
  const wf = readWorkflowSync(orgKey);
  const submission = wf.submissions?.[normalizeCode(empCode)];
  return submission?.goals || [];
}

function getOverrideManagerCode() {
  const hash = window.location.hash || '';
  const qIdx = hash.indexOf('?');
  if (qIdx === -1) return '';
  const params = new URLSearchParams(hash.slice(qIdx + 1));
  return params.get('as') || '';
}

export default function ManagerEvalPage({ embedded = false, overrideMgrCode = '', overrideOrgKey = '' } = {}) {
  const empSession = readEmployeeSessionSync();
  const { role, orgKey: adminOrgKey } = useApp();
  const isHRAdmin = role === 'hr-admin' || role === 'super-admin';
  const overrideCode = embedded ? overrideMgrCode : getOverrideManagerCode();
  const orgKey = overrideOrgKey || empSession?.orgKey || (isHRAdmin ? adminOrgKey : '') || '';
  const actingMgrCode = embedded
    ? (overrideMgrCode || empSession?.empCode)
    : (isHRAdmin && overrideCode ? overrideCode : empSession?.empCode);

  const { ready, config, employees, subPhase, activeSubPhases = [] } = usePMSData(orgKey);
  const manager = findEmployee(employees, actingMgrCode);
  const reports = useMemo(() => getReports(employees, actingMgrCode), [employees, actingMgrCode]);
  // Manager-eval is "active" only when at least one direct report has
  // submitted their self-evaluation — that's the gating signal in the real
  // chain (goals approved → self-eval → manager-eval).
  const anyReportReady = useMemo(() => {
    const ratings = (orgKey ? readRatings(orgKey) : { ratings: {} }).ratings || {};
    return reports.some((r) => {
      const code = String(r['Employee Code'] || '').trim().toUpperCase();
      return !!ratings[code]?.self?.submittedAt;
    });
  }, [reports, orgKey]);
  const [expandedCode, setExpandedCode] = useState('');
  const [mgrFilter, setMgrFilter] = useState('all');
  const [mgrSearch, setMgrSearch] = useState('');
  const [tick, setTick] = useState(0); // bump to re-read the ratings store after an action
  // Re-read the tiles whenever the ratings store changes (own action, cloud
  // sync settling, or another tab) — keeps the list from feeling "sticky".
  useEffect(() => {
    const refresh = () => setTick((t) => t + 1);
    window.addEventListener('zarohr-ratings-changed', refresh);
    return () => window.removeEventListener('zarohr-ratings-changed', refresh);
  }, []);
  const actor = isHRAdmin ? `HR (${empSession?.empCode || 'admin'} as ${actingMgrCode})` : actingMgrCode;

  if (!empSession?.empCode && !isHRAdmin) return <ShellMessage title="Sign in required" message="Open this page from the employee sign-in flow." />;
  if (!ready) return <ShellMessage title="Loading…" message="Reading cycle data." />;
  if (!manager) return <ShellMessage title="Manager not found" message={`No employee with code "${actingMgrCode || '—'}" exists for this org.${isHRAdmin && !overrideCode ? ' HR admins: append #manager-eval?as=MGR_CODE to act as a specific manager.' : ''}`} />;
  // Phase is "active" for this manager when:
  //  - calendar / legacy phase is in manager-evaluation, OR
  //  - any of their direct reports has goals approved (per-employee signal).
  const managerWindowActive = activeSubPhases.includes(SUB_PHASE.MANAGER_EVALUATION) || subPhase === SUB_PHASE.MANAGER_EVALUATION;
  const phaseActive = managerWindowActive || anyReportReady;
  const previewMode = !phaseActive && (isHRAdmin || !!overrideCode);
  if (!phaseActive && !previewMode) {
    return <ShellMessage title="Manager evaluation is not open" message={`Current cycle phase: ${subPhase}. Manager evaluation is only editable during the manager-evaluation window in the cycle calendar.`} />;
  }
  if (reports.length === 0) {
    return <ShellMessage title="No direct reports" message="You don't have anyone reporting to you for this cycle." />;
  }

  // Same shell as "My Team Goals": status buckets + self-eval completion per report.
  const STATUS = {
    rated:    { label: 'Rated',              color: '#16A34A', bg: '#F0FDF4', border: '#BBF7D0' },
    'to-rate':{ label: 'To rate',            color: '#1D4ED8', bg: '#EFF6FF', border: '#BFDBFE' },
    awaiting: { label: 'Awaiting self-eval', color: '#D97706', bg: '#FFF7ED', border: '#FED7AA' },
  };
  const filled = (v) => v !== undefined && v !== null && v !== '';
  const selfCompletion = (code, reportRow) => {
    const gs = getEmployeeGoals(orgKey, code);
    const grp = getEmployeeGroup(config, reportRow);
    const atKpi = grp?.kpiRatingMode !== 'free-text';
    const items = atKpi ? gs.flatMap((k) => k.kpis || []) : gs;
    const comps = resolveCompetenciesForEmployee(config, reportRow).competencies;
    const self = getEmployeeStage(orgKey, code, 'self') || {};
    const total = items.length + comps.length;
    if (!total) return 0;
    const scored = items.filter((it) => filled(self.itemScores?.[it.id])).length
      + comps.filter((n) => filled(self.competencyScores?.[n])).length;
    return Math.round((scored / total) * 100);
  };
  void tick; // referenced so a bump re-reads the ratings store below
  const rows = reports.map((r) => {
    const code = r['Employee Code'];
    const selfStage = getEmployeeStage(orgKey, code, 'self');
    const mgrStage = getEmployeeStage(orgKey, code, 'manager');
    const requested = !!selfStage?.completionRequested && !selfStage?.submittedAt;
    const bucket = mgrStage?.submittedAt ? 'rated' : (selfStage?.submittedAt ? 'to-rate' : 'awaiting');
    return { report: r, code, bucket, requested, completion: selfCompletion(code, r), goalCount: getEmployeeGoals(orgKey, code).length };
  });
  const counts = rows.reduce((acc, r) => { acc[r.bucket] = (acc[r.bucket] || 0) + 1; return acc; }, {});
  counts.all = rows.length;
  const FILTERS = [
    { id: 'all', label: 'All', color: '#475569', activeBg: '#0F172A' },
    { id: 'to-rate', label: 'To rate', color: '#1D4ED8', activeBg: '#1D4ED8' },
    { id: 'rated', label: 'Rated', color: '#16A34A', activeBg: '#16A34A' },
    { id: 'awaiting', label: 'Awaiting self-eval', color: '#D97706', activeBg: '#D97706' },
  ];
  const order = { 'to-rate': 0, awaiting: 1, rated: 2 };
  const q = String(mgrSearch || '').toLowerCase().trim();
  const visible = rows
    .filter((r) => mgrFilter === 'all' || r.bucket === mgrFilter)
    .filter((r) => !q || [r.report['Employee Name'], r.code, r.report['Designation'], STATUS[r.bucket].label].some((v) => String(v || '').toLowerCase().includes(q)))
    .sort((a, b) => (order[a.bucket] ?? 9) - (order[b.bucket] ?? 9));

  return (
    <div style={embedded
      ? { padding: '0' }
      : { minHeight: '100vh', background: SOFT_BG, padding: '32px 16px', fontFamily: "'Geist','Inter','Segoe UI',Arial,sans-serif" }
    }>
      <div style={embedded ? {} : { maxWidth: 1180, margin: '0 auto' }}>
        {previewMode && (
          <NoticeCard tone="warn" title="HR proxy mode">
            Calendar phase is "{subPhase}", not manager-evaluation. HR proxy bypass is active, so edits are still saved against this employee record.
          </NoticeCard>
        )}

        {/* Filter row + search — same layout as My Team Goals */}
        <div style={{ display: 'flex', gap: 12, alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', marginBottom: 14 }}>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {FILTERS.map((f) => {
              const active = mgrFilter === f.id;
              return (
                <button key={f.id} type="button" onClick={() => { setMgrFilter(f.id); setExpandedCode(''); }}
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '6px 12px', borderRadius: 999, cursor: 'pointer', fontFamily: 'inherit', fontSize: 12.5, fontWeight: 700, border: `1.5px solid ${active ? f.activeBg : '#E2E8F0'}`, background: active ? f.activeBg : '#fff', color: active ? '#fff' : f.color }}>
                  {f.label}
                  <span style={{ background: active ? 'rgba(255,255,255,.22)' : '#F1F5F9', color: active ? '#fff' : f.color, padding: '1px 8px', borderRadius: 999, fontSize: 11, fontWeight: 800 }}>{counts[f.id] || 0}</span>
                </button>
              );
            })}
          </div>
          <div style={{ position: 'relative', width: 'min(280px, 100%)' }}>
            <input value={mgrSearch} onChange={(e) => setMgrSearch(e.target.value)} placeholder="Search team"
              style={{ width: '100%', boxSizing: 'border-box', padding: '8px 12px 8px 32px', borderRadius: 999, border: '1.5px solid #D9E2EC', background: '#fff', color: '#0F172A', fontFamily: 'inherit', fontSize: 12.5, outline: 'none' }} />
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#94A3B8" strokeWidth="2.3" strokeLinecap="round" strokeLinejoin="round" style={{ position: 'absolute', left: 11, top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none' }}>
              <circle cx="11" cy="11" r="8" /><path d="m21 21-4.35-4.35" />
            </svg>
          </div>
        </div>

        {visible.length === 0 && (
          <div style={{ padding: '22px 20px', textAlign: 'center', color: '#94A3B8', fontSize: 13, border: '1px dashed #D9E2EC', borderRadius: 12 }}>
            No team members found.
          </div>
        )}

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 8 }}>
          {visible.map(({ report, code, bucket, requested, completion, goalCount }) => {
            const st = requested
              ? { label: 'Completion requested', color: '#7C3AED', bg: '#F5F3FF', border: '#DDD6FE' }
              : STATUS[bucket];
            const expanded = expandedCode === normalizeCode(code);
            const canRate = bucket !== 'awaiting';
            const barColor = bucket === 'rated' ? '#16A34A' : '#2563EB';
            return (
              <div key={code}
                onClick={() => { if (canRate) setExpandedCode(expanded ? '' : normalizeCode(code)); }}
                style={{ background: '#fff', border: '1px solid #E9EDF2', borderRadius: 10, padding: expanded ? '8px 14px 14px' : '8px 14px', gridColumn: expanded ? '1 / -1' : 'auto', cursor: canRate ? 'pointer' : 'default', opacity: canRate ? 1 : 0.7 }}>
                <div style={{ display: 'flex', gap: 12, alignItems: 'center', minWidth: 0 }}>
                  <div style={{ minWidth: 0, flex: '0 1 180px' }}>
                    <div style={{ fontSize: 13, fontWeight: 700, color: '#0F172A', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{report['Employee Name'] || code}</div>
                    <div style={{ fontSize: 11, color: '#94A3B8', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{code} · {goalCount} goal{goalCount === 1 ? '' : 's'}{report['Designation'] ? ` · ${report['Designation']}` : ''}</div>
                  </div>
                  <span title={st.label} style={{ flexShrink: 0, width: 9, height: 9, borderRadius: '50%', background: st.color, border: `2px solid ${st.bg}`, boxShadow: `0 0 0 1px ${st.border}` }} />
                  <div style={{ flex: '1 1 100px', minWidth: 60, maxWidth: 220, height: 5, background: '#E2E8F0', borderRadius: 999, overflow: 'hidden' }}>
                    <div style={{ height: '100%', width: `${completion}%`, background: barColor, borderRadius: 999, transition: 'width .2s ease' }} />
                  </div>
                  <div style={{ flexShrink: 0, fontSize: 13, fontWeight: 800, color: barColor, minWidth: 38, textAlign: 'right' }}>{completion}%</div>
                  {canRate && <span style={{ flexShrink: 0, fontSize: 12, color: '#94A3B8' }}>{expanded ? '▲' : '▾'}</span>}
                </div>
                {expanded && (
                  <div onClick={(e) => e.stopPropagation()} style={{ marginTop: 12, borderTop: `1px solid ${BORDER}`, paddingTop: 12 }}>
                    <ReportEditor key={code} report={report} orgKey={orgKey} config={config} actor={actor} previewMode={previewMode} subPhase={subPhase}
                      onCompletionRequested={() => { setExpandedCode(''); setTick((t) => t + 1); }} />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function ReportList({ reports, activeCode, onPick, orgKey }) {
  return (
    <div style={{ background: '#fff', border: `1px solid ${BORDER}`, borderRadius: 12, padding: 6 }}>
      {reports.map((r) => {
        const code = r['Employee Code'];
        const isOn = normalizeCode(activeCode) === normalizeCode(code);
        const selfStage = getEmployeeStage(orgKey, code, 'self');
        const managerStage = getEmployeeStage(orgKey, code, 'manager');
        const selfSubmitted = !!selfStage?.submittedAt;
        const managerSubmitted = !!managerStage?.submittedAt;
        const status = managerSubmitted ? 'rated' : selfSubmitted ? 'ready' : 'waiting';
        const statusStyle = {
          rated:   { bg: '#DCFCE7', color: '#16A34A', label: 'Rated' },
          ready:   { bg: '#DBEAFE', color: '#1D4ED8', label: 'Self submitted — ready to rate' },
          waiting: { bg: '#FEF3C7', color: '#92400E', label: 'Waiting on self-eval' },
        }[status];
        return (
          <button
            key={code} type="button" onClick={() => onPick(code)}
            style={{
              display: 'block', width: '100%', textAlign: 'left',
              padding: '10px 12px', borderRadius: 8, marginBottom: 4,
              background: isOn ? '#EFF6FF' : 'transparent',
              border: 'none', cursor: 'pointer', fontFamily: 'inherit',
              opacity: status === 'waiting' ? 0.6 : 1,
            }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: '#0F172A' }}>{r['Employee Name'] || code}</div>
            <div style={{ fontSize: 11.5, color: '#64748B', marginTop: 2 }}>{r['Role'] || r['Designation'] || ''} · {code}</div>
            <div style={{ marginTop: 4 }}>
              <span style={{
                fontSize: 10.5, fontWeight: 700, padding: '2px 7px', borderRadius: 999,
                background: statusStyle.bg, color: statusStyle.color,
              }}>{statusStyle.label}</span>
            </div>
          </button>
        );
      })}
    </div>
  );
}

// Employee's pick, read-only — beside the manager's input.
function EmployeePick({ value }) {
  const blank = value === '—' || value === '' || value === null || value === undefined;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'flex-start', minWidth: 0, width: '100%' }}>
      <span style={{ ...FIELD_LABEL, color: '#94A3B8' }}>Employee</span>
      <span className="emp-pick-wrap" style={{ position: 'relative', display: 'block', maxWidth: '100%' }}>
        <span style={{ display: 'block', maxWidth: '100%', padding: '8px 12px', borderRadius: 8, border: '1px solid #E2E8F0', background: '#F8FAFC', fontSize: 13, fontWeight: 800, color: blank ? '#CBD5E1' : '#0F172A', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', boxSizing: 'border-box' }}>{blank ? '—' : value}</span>
        {!blank && (
          <>
            <style>{`
              .emp-pick-wrap .emp-pick-tip {
                position: absolute;
                top: calc(100% + 6px);
                left: 0;
                opacity: 0;
                pointer-events: none;
                padding: 6px 9px;
                border-radius: 8px;
                background: #0F172A;
                color: #FFFFFF;
                font-size: 11.5px;
                font-weight: 750;
                line-height: 1.2;
                white-space: nowrap;
                box-shadow: 0 10px 26px rgba(15,23,42,.20);
                transition: opacity 90ms ease;
                z-index: 20;
              }
              .emp-pick-wrap:hover .emp-pick-tip { opacity: 1; }
            `}</style>
            <span className="emp-pick-tip" role="tooltip">{value}</span>
          </>
        )}
      </span>
    </div>
  );
}

// Employee read-only pick + manager's editable rating, side by side, employee-page style.
function CommentBox({ value, onChange, disabled, placeholder }) {
  return (
    <textarea
      value={value} onChange={onChange}
      disabled={disabled} rows={2} placeholder={placeholder}
      style={{ width: '100%', marginTop: 10, padding: 9, borderRadius: 8, border: `1px solid ${BORDER}`, fontFamily: 'inherit', fontSize: 12.5, resize: 'vertical', boxSizing: 'border-box' }}
    />
  );
}

function ScorePair({ config, selfScore, value, onChange, disabled, accent = '#2563EB', invalid = false, suggestedScore = null }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(170px, 1fr) minmax(220px, 1.2fr)', gap: 14, alignItems: 'start', width: '100%' }}>
      <EmployeePick value={formatChoiceLabel(config, selfScore)} />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'flex-start' }}>
        <span style={{ ...FIELD_LABEL, color: invalid ? '#E11D48' : accent }}>Manager score</span>
        <RatingWidget value={value} onChange={onChange} config={config} disabled={disabled} suggestedScore={suggestedScore} />
      </div>
    </div>
  );
}

function TargetBox({ value, targetType, targetTypes }) {
  const hasTarget = value !== undefined && value !== null && String(value).trim() !== '';
  return (
    <div style={{ fontSize: 13.5, fontWeight: 850, color: hasTarget ? '#0F172A' : '#CBD5E1', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
      {hasTarget ? formatTargetValue(value, targetType, targetTypes) : '—'}
    </div>
  );
}

// Achievement is a fact — the manager can correct a wrong value. Employee's
// original stays visible ("Employee said: X"), and a "Corrected" flag shows when changed.
function AchievementCorrect({ value, employeeValue, onChange, disabled, targetType, targetTypes }) {
  const meta = getTargetTypeMeta(targetType, targetTypes);
  const unit = String(meta?.unit || '').trim();
  const inputType = normalizeTargetTypeName(meta?.name) === 'date' ? 'date' : 'text';
  const empHas = employeeValue !== undefined && employeeValue !== null && String(employeeValue).trim() !== '';
  const corrected = String(value ?? '').trim() !== String(employeeValue ?? '').trim();
  return (
    <>
      <div style={{ fontSize: 13.5, fontWeight: 800, color: empHas ? '#0F172A' : '#CBD5E1', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
        {empHas ? formatTargetValue(employeeValue, targetType, targetTypes) : 'Left blank'}
      </div>
      <div style={{ minWidth: 0 }}>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, width: '100%', boxSizing: 'border-box', minHeight: 42, padding: '7px 10px', borderRadius: 8, border: `1px solid ${corrected ? '#DDD6FE' : '#E2E8F0'}`, background: corrected ? '#FBFAFF' : '#fff' }}>
        {unit && meta?.unitPosition === 'prefix' ? <span style={{ color: '#94A3B8', fontWeight: 800, fontSize: 13 }}>{unit}</span> : null}
        <input type={inputType} inputMode={meta?.isNumeric ? 'decimal' : undefined} value={value ?? ''} disabled={disabled}
          onChange={(e) => onChange(e.target.value)} placeholder={empHas ? 'Same as employee' : 'Enter achieved'}
          style={{ width: '100%', minWidth: 0, border: 'none', outline: 'none', padding: 0, fontSize: 13.5, fontWeight: 700, color: '#0F172A', background: 'transparent', fontFamily: 'inherit' }} />
        {unit && meta?.unitPosition !== 'prefix' ? <span style={{ color: '#94A3B8', fontWeight: 800, fontSize: 13 }}>{unit}</span> : null}
      </span>
      {corrected && <div style={{ marginTop: 3, fontSize: 10.5, color: '#7C3AED', fontWeight: 750 }}>Corrected</div>}
      </div>
    </>
  );
}

function ReportEditor({ report, orgKey, config, actor, previewMode, subPhase, onCompletionRequested }) {
  const empCode = report['Employee Code'];
  const goals = useMemo(() => getEmployeeGoals(orgKey, empCode), [orgKey, empCode]);
  const group = getEmployeeGroup(config, report);
  const rateAtKpi = group?.kpiRatingMode !== 'free-text';
  const configuredTargetLevel = config?.targetLevelMode === 'KRA'
    ? 'KRA'
    : config?.targetLevelMode === 'KPI'
      ? 'KPI'
      : config?.targetLevel === 'KRA'
        ? 'KRA'
        : 'KPI';
  const targetLevel = group?.targetLevel === 'KRA' ? 'KRA' : (group?.targetLevel === 'KPI' ? 'KPI' : configuredTargetLevel);
  const targetsEnabled = config?.targetsEnabled !== false;
  const targetAtKra = targetsEnabled && targetLevel === 'KRA';
  const targetAtKpi = targetsEnabled && targetLevel !== 'KRA';
  const autoOn = config.autoRating !== false;
  const managerCanOverrideAuto = config.managerOverrideAuto !== false;
  const bands = config.autoRatingBands || [];
  const resolved = useMemo(() => resolveCompetenciesForEmployee(config, report), [config, report]);
  const competencies = resolved.competencies;
  const targetTypes = useMemo(() => getMergedTargetTypes(config), [config]);
  const selfStage = getEmployeeStage(orgKey, empCode, 'self') || {};
  const mgrStage = getEmployeeStage(orgKey, empCode, 'manager') || {};
  const [scores, setScores] = useState(mgrStage.itemScores || {});
  const [comments, setComments] = useState(mgrStage.itemComments || {});
  const [compScores, setCompScores] = useState(mgrStage.competencyScores || {});
  const [overallComment, setOverallComment] = useState(mgrStage.overallComment || '');
  const [overallOpen, setOverallOpen] = useState(!!(mgrStage.overallComment || ''));
  const [summaryOpen, setSummaryOpen] = useState(false);
  const [msg, setMsg] = useState('');
  // Manager-correctable achievement, pre-filled from the employee's entry.
  const empAchievements = selfStage.achievements || {};
  const [achievements, setAchievements] = useState({ ...empAchievements, ...(mgrStage.achievements || {}) });
  const [requestOpen, setRequestOpen] = useState(false);
  const [requestNote, setRequestNote] = useState('');
  const [submitErrors, setSubmitErrors] = useState([]);
  const [errorsOpen, setErrorsOpen] = useState(false);
  const saved = !!mgrStage.submittedAt;

  const commentMode = config.managerCommentMode || 'overall';
  // KPIs the employee left blank (with a target) — enables "Request completion".
  const blankCount = targetAtKra
    ? goals.filter((kra) => kra.target && String(empAchievements[kra.id] ?? '').trim() === '').length
    : goals.flatMap((k) => k.kpis || [])
      .filter((kpi) => kpi.target && String(empAchievements[kpi.id] ?? '').trim() === '').length;

  const clearSubmitFeedback = () => {
    if (submitErrors.length) setSubmitErrors([]);
    if (msg) setMsg('');
  };
  const setScore = (id, v) => {
    clearSubmitFeedback();
    setScores((p) => ({ ...p, [id]: v }));
  };
  const setComment = (id, v) => setComments((p) => ({ ...p, [id]: v }));
  const setCompetencyScore = (name, v) => {
    clearSubmitFeedback();
    setCompScores((p) => ({ ...p, [name]: v }));
  };
  const onRequestCompletion = () => {
    const note = requestNote.trim();
    sendBackForCompletion(orgKey, empCode, buildPayload(), note, actor);
    // Notify the employee (bell) that their self-eval has been reopened.
    const wf = readWorkflowSync(orgKey) || { submissions: {}, notifications: [] };
    const notif = {
      id: `notif_self_${normalizeCode(empCode)}_${Date.now()}`,
      type: 'self-completion-requested',
      recipientCode: normalizeCode(empCode),
      senderCode: '',
      submissionCode: normalizeCode(empCode),
      title: 'Self-evaluation reopened by your manager',
      message: note
        ? `Your manager asked you to complete your self-evaluation: “${note}”`
        : 'Your manager asked you to complete your self-evaluation before they finish your rating.',
      createdAt: new Date().toISOString(),
      read: false,
    };
    persistWorkflow(orgKey, { ...wf, notifications: [notif, ...(wf.notifications || [])] });
    setRequestOpen(false);
    onCompletionRequested?.();
  };

  const breakdown = computeSelfScoreBreakdown({
    config, goals, scores, rateAtKpi,
    competencies, compScores,
    competenciesSelfRated: config.competenciesEnabled !== false,
    resolved,
  });

  const buildPayload = () => ({
    itemScores: scores,
    itemComments: comments,
    achievements,
    competencyScores: compScores,
    overallScore: breakdown.final,
    overallComment,
  });
  const goalsScored = breakdown.goalRatingScored ?? breakdown.goalRows.filter((g) => g.score !== null && g.score !== undefined).length;
  const compsScored = breakdown.compRows.filter((c) => c.score !== null && c.score !== undefined).length;
  const goalRatingTotal = breakdown.goalRatingTotal ?? breakdown.goalRows.length;
  const totalToRate = goalRatingTotal + (breakdown.compEnabled ? breakdown.compRows.length : 0);
  const ratedCount = goalsScored + (breakdown.compEnabled ? compsScored : 0);
  const isMissingScore = (value) => value === null || value === undefined || value === '';
  const autoScores = useMemo(() => {
    if (!autoOn) return {};
    const out = {};
    goals.forEach((kra) => {
      const auto = computeGoalAutoRatings({
        kra,
        achievements,
        targetLevel,
        rateAtKpi,
        bands,
        targetTypes,
      });
      Object.entries(auto.scores || {}).forEach(([id, score]) => {
        if (score !== null && score !== undefined && Number.isFinite(Number(score))) out[id] = score;
      });
    });
    return out;
  }, [autoOn, goals, achievements, targetLevel, rateAtKpi, bands, targetTypes]);
  // Track the score we last auto-applied per item so the suggestion stays in
  // sync as the manager corrects an achievement — but back off once they pick
  // their own score. Otherwise the score froze on the first value auto-filled
  // (e.g. the first digit typed while correcting an achievement).
  const autoAppliedRef = useRef({});
  useEffect(() => {
    if (!autoOn || saved) return;
    // Compute purely and mutate the ref OUTSIDE setScores — the setScores
    // updater can run twice (StrictMode), which would corrupt a ref mutated
    // inside it and revert the sync.
    let changed = false;
    const next = { ...scores };
    const applied = { ...autoAppliedRef.current };
    Object.entries(autoScores).forEach(([id, score]) => {
      const lastAuto = applied[id];
      const untouched = isMissingScore(next[id]) || String(next[id]) === String(lastAuto);
      if (untouched) {
        if (String(next[id]) !== String(score)) {
          next[id] = score;
          changed = true;
        }
        applied[id] = score;
      }
    });
    autoAppliedRef.current = applied;
    if (changed) setScores(next);
  }, [autoScores, scores, autoOn, saved]);
  const scoreLockedByAuto = (id) => saved || (!managerCanOverrideAuto && autoScores[id] !== null && autoScores[id] !== undefined);
  const validateManagerEvaluation = () => {
    const errors = [];
    const addError = (key, text) => errors.push({ key, text, severity: 'hard' });
    if (goals.length === 0) addError('goals', 'No approved goals are available to rate.');
    goals.forEach((kra) => {
      if (!rateAtKpi && isMissingScore(scores[kra.id])) {
        addError(`score:${kra.id}`, `Add manager score for "${kra.name || 'this goal'}".`);
      }
      if (rateAtKpi) {
        (kra.kpis || []).forEach((kpi) => {
          if (isMissingScore(scores[kpi.id])) {
            addError(`score:${kpi.id}`, `Add manager score for KPI "${kpi.name || 'Unnamed KPI'}".`);
          }
        });
      }
    });
    if (breakdown.compEnabled) {
      competencies.forEach((name) => {
        if (isMissingScore(compScores[name])) {
          addError(`competency:${name}`, `Add manager score for competency "${name}".`);
        }
      });
    }
    return errors;
  };
  const invalidKeys = new Set(submitErrors.map((err) => err.key));
  const hasHardErrors = submitErrors.some((e) => e.severity === 'hard');

  const onSave = () => { setEmployeeStage(orgKey, empCode, 'manager', buildPayload()); setMsg('Draft saved.'); };
  const onSubmit = () => {
    // Require every goal + competency to be scored before submitting.
    const errors = validateManagerEvaluation();
    if (errors.length > 0 || !breakdown.complete) {
      setSubmitErrors(errors.length ? errors : [{ key: 'ratings', text: `Score every goal and competency before submitting — ${ratedCount} of ${totalToRate} rated.`, severity: 'hard' }]);
      setMsg('');
      return;
    }
    setSubmitErrors([]);
    submitEmployeeStage(orgKey, empCode, 'manager', buildPayload(), actor);
    setMsg('Submitted.');
  };

  const actionButtons = (
    <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
      <button type="button" onClick={onSave} disabled={saved} style={btnStyle('ghost', saved)}>Save draft</button>
      <button type="button" onClick={onSubmit} disabled={saved} style={btnStyle('primary', saved)}>Submit rating</button>
      {blankCount > 0 && !saved && !requestOpen && (
        <button type="button" onClick={() => setRequestOpen(true)}
          style={{ padding: '8px 14px', borderRadius: 8, fontSize: 13, fontWeight: 750, border: '1.5px solid #DDD6FE', background: '#F5F3FF', color: '#6D28D9', cursor: 'pointer', fontFamily: 'inherit' }}>
          {`Request completion (${blankCount})`}
        </button>
      )}
      {requestOpen && !saved && (
        <button type="button" onClick={onRequestCompletion}
          style={{ padding: '8px 14px', borderRadius: 8, fontSize: 13, fontWeight: 750, border: 'none', background: '#7C3AED', color: '#fff', cursor: 'pointer', fontFamily: 'inherit' }}>
          Confirm send back
        </button>
      )}
      {msg && <span style={{ fontSize: 12, color: '#16A34A', fontWeight: 750 }}>{msg}</span>}
      {saved && <span style={{ fontSize: 12, color: '#16A34A', fontWeight: 750 }}>Submitted — waiting on HR review.</span>}
    </div>
  );
  const errorPanel = (
    submitErrors.length > 0 ? (
      <div style={{ marginBottom: 10, borderRadius: 9, background: '#FFF7F8', border: '1px solid #FBD9DE', color: '#9F1239', overflow: 'hidden' }}>
        <button
          type="button"
          onClick={() => setErrorsOpen((o) => !o)}
          style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, width: '100%', padding: '9px 11px', background: 'transparent', border: 'none', cursor: 'pointer', fontFamily: 'inherit', color: 'inherit', textAlign: 'left' }}
        >
          <span style={{ fontSize: 12.5, fontWeight: 800 }}>
            {hasHardErrors
              ? `${submitErrors.length} ${submitErrors.length === 1 ? 'field' : 'fields'} still need a value`
              : `${submitErrors.length} achievement ${submitErrors.length === 1 ? 'field is' : 'fields are'} blank — submit anyway, or fill them in`}
          </span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11.5, fontWeight: 700, whiteSpace: 'nowrap' }}>
            {errorsOpen ? 'Hide ▲' : 'View ▼'}
          </span>
        </button>
        {errorsOpen && (
          <ul style={{ margin: 0, padding: '0 14px 11px 28px', maxHeight: 168, overflowY: 'auto', listStyle: 'disc' }}>
            {submitErrors.map((err) => (
              <li key={err.key} style={{ fontSize: 11.5, lineHeight: 1.5, marginTop: 3 }}>{err.text}</li>
            ))}
          </ul>
        )}
      </div>
    ) : null
  );
  const requestCompletionPanel = (
    requestOpen && !saved ? (
      <div style={{ marginBottom: 10, padding: '10px 12px', background: '#FBFAFF', border: '1px solid #DDD6FE', borderRadius: 10 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'flex-start', flexWrap: 'wrap' }}>
          <div style={{ minWidth: 220, flex: '1 1 360px' }}>
            <div style={{ fontSize: 12.5, fontWeight: 800, color: '#6D28D9' }}>Send back to {report['Employee Name'] || empCode}</div>
            <div style={{ fontSize: 11.5, color: '#64748B', marginTop: 3, lineHeight: 1.4 }}>
              Saves your manager draft and reopens self-evaluation for {blankCount} blank achievement{blankCount === 1 ? '' : 's'}.
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexShrink: 0 }}>
            <button type="button" onClick={() => setRequestOpen(false)} style={{ ...btnStyle('ghost', false), padding: '8px 12px', fontSize: 12.5 }}>Cancel</button>
          </div>
        </div>
        <textarea value={requestNote} onChange={(e) => setRequestNote(e.target.value)} rows={2}
          placeholder="Optional note to employee"
          style={{ width: '100%', marginTop: 9, padding: '8px 10px', borderRadius: 8, border: `1px solid ${BORDER}`, fontFamily: 'inherit', fontSize: 12.5, resize: 'vertical', boxSizing: 'border-box', minHeight: 56, maxHeight: 92 }} />
      </div>
    ) : null
  );

  return (
    <div>
      {previewMode && (
        <NoticeCard tone="warn" title="HR proxy mode">
          Calendar phase is "{subPhase}", not manager-evaluation. HR proxy bypass is active, so edits are still saved against this employee record.
        </NoticeCard>
      )}

      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 14, alignItems: 'center', flexWrap: 'wrap', padding: '10px 14px', marginBottom: 12, background: '#fff', border: `1.5px solid ${BORDER}`, borderRadius: 12 }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 15, fontWeight: 850, color: '#0F172A' }}>{report['Employee Name'] || empCode}</div>
          <div style={{ fontSize: 12, color: '#64748B', marginTop: 2 }}>
            {ratedCount} of {totalToRate} rated{blankCount > 0 ? ` · ${blankCount} blank achievement${blankCount === 1 ? '' : 's'}` : ''}
          </div>
        </div>
      </div>

      {/* GOALS */}
      {goals.length === 0 && (
        <NoticeCard tone="warn" title="No goals on record">This employee has no goals submitted for this cycle.</NoticeCard>
      )}
      {goals.map((kra, idx) => {
        const goalColor = getGoalColor(kra, config, idx);
        const hasKpis = (kra.kpis || []).length > 0;
        return (
          <div key={kra.id} style={{ background: '#fff', border: `1px solid ${goalColor}33`, borderLeft: `4px solid ${goalColor}`, borderRadius: 12, marginBottom: 12, overflow: 'hidden' }}>
            {/* Goal header */}
            <div style={{ padding: '10px 16px', borderBottom: `1px solid ${BORDER}`, background: `${goalColor}0D`, display: 'grid', gridTemplateColumns: !rateAtKpi ? SCORE_GRID : '1fr', columnGap: 18, rowGap: 10, alignItems: 'center' }}>
              <div style={{ minWidth: 0, gridColumn: !rateAtKpi ? '1 / 3' : 'auto' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontSize: 10.5, fontWeight: 800, color: goalColor, textTransform: 'uppercase', letterSpacing: '.06em' }}>{kra.perspName && kra.perspName !== 'All KRAs' ? kra.perspName : `Goal ${idx + 1}`}</span>
                  <span style={{ padding: '2px 9px', borderRadius: 999, background: '#fff', color: goalColor, fontSize: 11, fontWeight: 800, border: `1px solid ${goalColor}33` }}>{kra.weight || 0}%</span>
                </div>
                <div style={{ fontSize: 15.5, fontWeight: 800, color: '#0F172A', marginTop: 3 }}>{kra.name}</div>
              </div>
              {!rateAtKpi && (
                <>
                  <EmployeePick value={formatChoiceLabel(config, selfStage.itemScores?.[kra.id])} />
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'flex-start' }}>
                    <span style={{ ...FIELD_LABEL, color: invalidKeys.has(`score:${kra.id}`) ? '#E11D48' : goalColor }}>Manager score</span>
                    <RatingWidget value={scores[kra.id] ?? null} onChange={(v) => setScore(kra.id, v)} config={config} disabled={scoreLockedByAuto(kra.id)} suggestedScore={autoOn ? autoScores[kra.id] : null} />
                  </div>
                </>
              )}
              {targetAtKra && kra.target && (
                <div style={{ gridColumn: '1 / -1', display: 'grid', gridTemplateColumns: SCORE_GRID, columnGap: 18, alignItems: 'center', marginTop: 4 }}>
                  <span />
                  <span style={{ ...FIELD_LABEL, color: '#94A3B8' }}>Target</span>
                  <span style={{ ...FIELD_LABEL, color: '#94A3B8' }}>Employee achievement</span>
                  <span style={{ ...FIELD_LABEL, color: goalColor }}>Manager achievement</span>
                  <span />
                  <TargetBox value={kra.target} targetType={kra.targetType} targetTypes={targetTypes} />
                  <AchievementCorrect value={achievements[kra.id]} employeeValue={empAchievements[kra.id]} onChange={(v) => setAchievements((p) => ({ ...p, [kra.id]: v }))} disabled={saved} targetType={kra.targetType} targetTypes={targetTypes} />
                </div>
              )}
            </div>

            {/* KPIs */}
            <div style={{ padding: '8px 16px 10px' }}>
              {hasKpis && (
                <div style={{ display: 'grid', gridTemplateColumns: targetAtKpi ? SCORE_GRID : 'minmax(0, 1fr)', columnGap: 18, padding: '0 0 7px', alignItems: 'end' }}>
                  <span style={{ fontSize: 10, fontWeight: 850, color: '#94A3B8', textTransform: 'uppercase', letterSpacing: '.04em' }}>Key Performance Indicators</span>
                  {targetAtKpi && <span style={{ ...FIELD_LABEL, color: '#94A3B8' }}>Target</span>}
                  {targetAtKpi && <span style={{ ...FIELD_LABEL, color: '#94A3B8' }}>Employee achievement</span>}
                  {targetAtKpi && <span style={{ ...FIELD_LABEL, color: goalColor }}>Manager achievement</span>}
                </div>
              )}
              {hasKpis ? kra.kpis.map((kpi, kIdx) => (
                <div key={kpi.id} style={{ padding: '10px 0', borderTop: '1px solid #F1F5F9' }}>
                  <div style={{ display: 'grid', gridTemplateColumns: targetAtKpi ? SCORE_GRID : 'minmax(0, 1fr)', columnGap: 18, alignItems: 'center' }}>
                    <div style={{ display: 'flex', gap: 9, alignItems: 'center', minWidth: 0 }}>
                      <span style={{ color: goalColor, fontWeight: 800, fontSize: 13 }}>•</span>
                      <span style={{ fontSize: 13.5, fontWeight: 700, color: '#0F172A' }}>{kpi.name}</span>
                    </div>
                    {targetAtKpi && <TargetBox value={kpi.target} targetType={kpi.targetType} targetTypes={targetTypes} />}
                    {targetAtKpi && (kpi.target
                      ? <AchievementCorrect value={achievements[kpi.id]} employeeValue={empAchievements[kpi.id]} onChange={(v) => setAchievements((p) => ({ ...p, [kpi.id]: v }))} disabled={saved} targetType={kpi.targetType} targetTypes={targetTypes} />
                      : <span style={{ fontSize: 12, color: '#CBD5E1', paddingTop: 6 }}>—</span>)}
                  </div>
                  {rateAtKpi && (
                    <div style={{ marginTop: 8, paddingTop: 8, borderTop: '1px dashed #F1F5F9', display: 'flex', justifyContent: 'flex-end' }}>
                      <div style={{ width: 'min(520px, 100%)' }}>
                      <ScorePair config={config} selfScore={selfStage.itemScores?.[kpi.id]} value={scores[kpi.id] ?? null} onChange={(v) => setScore(kpi.id, v)} disabled={scoreLockedByAuto(kpi.id)} accent={goalColor} invalid={invalidKeys.has(`score:${kpi.id}`)} suggestedScore={autoOn ? autoScores[kpi.id] : null} />
                      </div>
                    </div>
                  )}
                  {commentMode === 'per-item' && <CommentBox value={comments[kpi.id] || ''} onChange={(e) => setComment(kpi.id, e.target.value)} disabled={saved} placeholder={`Comment on "${kpi.name}"…`} />}
                </div>
              )) : <div style={{ fontSize: 12.5, color: '#94A3B8', padding: '6px 0' }}>No KPIs.</div>}
              {commentMode === 'per-goal' && <CommentBox value={comments[kra.id] || ''} onChange={(e) => setComment(kra.id, e.target.value)} disabled={saved} placeholder={`Comment on "${kra.name}"…`} />}
            </div>
          </div>
        );
      })}

      {/* COMPETENCIES */}
      {competencies.length > 0 && (
        <div style={{ background: '#fff', border: `1px solid ${COMP_ACCENT}33`, borderLeft: `4px solid ${COMP_ACCENT}`, borderRadius: 14, marginBottom: 14, overflow: 'hidden' }}>
          <div style={{ padding: '12px 18px', borderBottom: `1px solid ${BORDER}`, background: `${COMP_ACCENT}0D`, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
            <div style={{ fontSize: 14, fontWeight: 800, color: '#0F172A' }}>Competencies</div>
            <span title={resolved.sourceLabel} style={{ padding: '4px 10px', borderRadius: 999, background: '#ECFEFF', color: COMP_ACCENT, fontSize: 11, fontWeight: 700 }}>{resolved.sourceLabel}</span>
          </div>
          <div style={{ padding: '6px 18px 12px' }}>
            {competencies.map((name) => (
              <div key={name} style={{ display: 'grid', gridTemplateColumns: 'minmax(220px, 1fr) minmax(410px, 520px)', gap: 18, alignItems: 'center', padding: '12px 0', borderTop: '1px solid #F1F5F9' }}>
                <div style={{ fontSize: 13.5, fontWeight: 700, color: '#0F172A' }}>{name}</div>
                <ScorePair config={config} selfScore={selfStage.competencyScores?.[name]} value={compScores[name] ?? null} onChange={(v) => setCompetencyScore(name, v)} disabled={saved} accent={COMP_ACCENT} invalid={invalidKeys.has(`competency:${name}`)} />
              </div>
            ))}
          </div>
        </div>
      )}

      {/* MANAGER FINAL SCORE SUMMARY */}
      <ManagerScoreSummary open={summaryOpen} onToggle={() => setSummaryOpen((o) => !o)} config={config} breakdown={breakdown} />

      {/* OVERALL COMMENT (collapsible, like employee page) */}
      <button type="button" onClick={() => setOverallOpen((o) => !o)}
        style={{ display: 'block', width: '100%', textAlign: 'left', cursor: 'pointer', background: 'transparent', border: 'none', marginTop: 16, marginBottom: 10, padding: '0 4px', fontFamily: 'inherit' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: 15, fontWeight: 800, color: '#0F172A' }}>Overall comment</span>
          <span style={{ display: 'inline-flex', alignItems: 'center', padding: '3px 10px', borderRadius: 999, background: '#EFF6FF', color: '#2563EB', fontSize: 12, fontWeight: 700 }}>{overallOpen ? 'Hide ▲' : (overallComment ? 'Edit ▼' : 'Add ▼')}</span>
        </div>
      </button>
      {overallOpen && (
        <textarea value={overallComment} onChange={(e) => setOverallComment(e.target.value)} disabled={saved} rows={3}
          placeholder={`Your overall summary of ${report['Employee Name'] || empCode}'s performance this cycle…`}
          style={{ width: '100%', padding: 10, borderRadius: 8, border: `1px solid ${BORDER}`, fontFamily: 'inherit', fontSize: 13, resize: 'vertical', boxSizing: 'border-box' }} />
      )}

      {/* SUBMIT */}
      <div style={{ marginTop: 18, padding: '14px 18px', background: '#fff', border: `1px solid ${submitErrors.length ? '#FBC4CB' : BORDER}`, borderRadius: 12, position: 'sticky', bottom: 12, boxShadow: '0 -8px 24px rgba(15,23,42,0.04)', zIndex: 5 }}>
        {errorPanel}
        {requestCompletionPanel}
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          {actionButtons}
        </div>
      </div>
    </div>
  );
}

function mFmt(v, points) {
  if (v === null || v === undefined) return '—';
  const r = Math.round(v * 100) / 100;
  const txt = (r % 1 === 0) ? String(r) : r.toFixed(2);
  return points ? `${txt} / ${points}` : txt;
}

function ManagerScoreSummary({ open, onToggle, config, breakdown }) {
  const { goalRows, goalsScore, goalsComplete, compEnabled, compRows, compScore, compsComplete, goalShare, compShare, final, complete, scalePoints } = breakdown;
  const ACCENT = '#2563EB';
  const goalsScored = breakdown.goalRatingScored ?? goalRows.filter((g) => g.score !== null && g.score !== undefined).length;
  const goalTotal = breakdown.goalRatingTotal ?? goalRows.length;
  const compsScored = compRows.filter((c) => c.score !== null && c.score !== undefined).length;
  const total = goalTotal + (compEnabled ? compRows.length : 0);
  const scored = goalsScored + (compEnabled ? compsScored : 0);
  const finalText = (complete && final != null) ? formatFinalRating(config, final) : null;
  return (
    <div style={{ marginTop: 14, border: `1px solid ${BORDER}`, borderRadius: 14, background: '#fff', overflow: 'hidden' }}>
      <button type="button" onClick={onToggle}
        style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 14, width: '100%', padding: '14px 18px', background: `${ACCENT}08`, border: 'none', cursor: 'pointer', fontFamily: 'inherit', textAlign: 'left' }}>
        <span>
          <span style={{ fontSize: 10.5, fontWeight: 800, color: ACCENT, textTransform: 'uppercase', letterSpacing: '.06em' }}>Manager final score</span>
          <span style={{ display: 'block', fontSize: 12, color: '#64748B', marginTop: 2 }}>{complete ? 'How it adds up — tap to see the breakdown' : `Finish rating to see the final · ${scored} of ${total} done`}</span>
        </span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 12, whiteSpace: 'nowrap' }}>
          {complete ? <span style={{ fontSize: 18, fontWeight: 900, color: ACCENT }}>{finalText}</span> : <span style={{ fontSize: 13, fontWeight: 800, color: '#94A3B8' }}>{scored} / {total} rated</span>}
          <span style={{ fontSize: 12, fontWeight: 700, color: '#64748B' }}>{open ? 'Hide ▲' : 'View ▼'}</span>
        </span>
      </button>
      {open && (
        <div style={{ padding: '14px 18px' }}>
          <div style={{ fontSize: 11, fontWeight: 800, color: '#7C3AED', textTransform: 'uppercase', letterSpacing: '.05em', marginBottom: 2 }}>Goals</div>
          {goalRows.map((g) => (
            <div key={g.id} style={{ display: 'flex', justifyContent: 'space-between', gap: 12, padding: '6px 0', borderTop: '1px solid #F1F5F9' }}>
              <span style={{ fontSize: 13, color: '#334155' }}>{g.name}</span>
              <span style={{ display: 'flex', gap: 10 }}>
                <span style={{ fontSize: 11.5, color: '#94A3B8', fontWeight: 700 }}>weight {g.weight}%</span>
                <span style={{ fontSize: 13, fontWeight: 800, color: g.score == null ? '#CBD5E1' : '#7C3AED' }}>{mFmt(g.score)}</span>
              </span>
            </div>
          ))}
          <div style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0 0', marginTop: 4, borderTop: '2px solid #7C3AED22' }}>
            <span style={{ fontSize: 12.5, fontWeight: 800, color: '#0F172A' }}>Goals score {compEnabled ? `· counts for ${goalShare}%` : ''}</span>
            {goalsComplete ? <span style={{ fontSize: 14, fontWeight: 900, color: '#7C3AED' }}>{mFmt(goalsScore, scalePoints)}</span> : <span style={{ fontSize: 12, fontWeight: 700, color: '#94A3B8' }}>{goalsScored} of {goalTotal} rated</span>}
          </div>
          {compEnabled && (
            <div style={{ marginTop: 16 }}>
              <div style={{ fontSize: 11, fontWeight: 800, color: COMP_ACCENT, textTransform: 'uppercase', letterSpacing: '.05em', marginBottom: 2 }}>Competencies</div>
              {compRows.map((c) => (
                <div key={c.name} style={{ display: 'flex', justifyContent: 'space-between', gap: 12, padding: '6px 0', borderTop: '1px solid #F1F5F9' }}>
                  <span style={{ fontSize: 13, color: '#334155' }}>{c.name}</span>
                  <span style={{ fontSize: 13, fontWeight: 800, color: c.score == null ? '#CBD5E1' : COMP_ACCENT }}>{mFmt(c.score)}</span>
                </div>
              ))}
              <div style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0 0', marginTop: 4, borderTop: `2px solid ${COMP_ACCENT}22` }}>
                <span style={{ fontSize: 12.5, fontWeight: 800, color: '#0F172A' }}>Competency score · counts for {compShare}%</span>
                {compsComplete ? <span style={{ fontSize: 14, fontWeight: 900, color: COMP_ACCENT }}>{mFmt(compScore, scalePoints)}</span> : <span style={{ fontSize: 12, fontWeight: 700, color: '#94A3B8' }}>{compsScored} of {compRows.length} rated</span>}
              </div>
            </div>
          )}
          <div style={{ marginTop: 16, padding: '12px 14px', borderRadius: 10, background: `${ACCENT}0A`, border: `1px solid ${ACCENT}22` }}>
            {complete ? (
              <>
                {compEnabled ? (
                  <div style={{ fontSize: 12.5, color: '#334155', lineHeight: 1.6 }}>
                    <strong>{mFmt(goalsScore)}</strong> × {goalShare}% + <strong>{mFmt(compScore)}</strong> × {compShare}% = <strong style={{ color: ACCENT, fontSize: 15 }}>{mFmt(final, scalePoints)}</strong>
                  </div>
                ) : (
                  <div style={{ fontSize: 12.5, color: '#334155' }}>Goals score = <strong style={{ color: ACCENT, fontSize: 15 }}>{mFmt(final, scalePoints)}</strong></div>
                )}
                <div style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontSize: 11.5, fontWeight: 800, color: '#64748B', textTransform: 'uppercase', letterSpacing: '.04em' }}>Final rating</span>
                  <span style={{ fontSize: 14, fontWeight: 900, color: ACCENT }}>{finalText}</span>
                </div>
              </>
            ) : (
              <div style={{ fontSize: 12.5, color: '#475569', lineHeight: 1.5 }}>The final rating appears once everything is rated — <strong>{scored} of {total}</strong> done.{compEnabled ? ` Goals count for ${goalShare}%, competencies ${compShare}%.` : ''}</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function Header({ title, subtitle }) {
  return (
    <div style={{ marginBottom: 18 }}>
      <div style={{ fontSize: 24, fontWeight: 800, color: '#0F172A' }}>{title}</div>
      <div style={{ fontSize: 13, color: '#64748B', marginTop: 4 }}>{subtitle}</div>
    </div>
  );
}
function PillStatus({ label, color }) {
  return <span style={{ padding: '5px 11px', borderRadius: 999, background: `${color}1A`, color, fontSize: 12, fontWeight: 700 }}>{label}</span>;
}
function Card({ children, accent = BORDER }) {
  return <div style={{ background: '#fff', border: `1px solid ${accent === BORDER ? BORDER : `${accent}33`}`, borderLeft: accent === BORDER ? `1px solid ${BORDER}` : `4px solid ${accent}`, borderRadius: 12, marginBottom: 14, overflow: 'hidden' }}>{children}</div>;
}
function CardHead({ children, accent = '#FAFBFF' }) {
  const hasAccent = accent !== '#FAFBFF';
  return <div style={{ padding: '14px 18px', borderBottom: `1px solid ${BORDER}`, background: hasAccent ? `${accent}0D` : '#FAFBFF' }}>{children}</div>;
}
function CardBody({ children }) {
  return <div style={{ padding: '8px 18px 16px' }}>{children}</div>;
}
function NoticeCard({ tone, title, children }) {
  const bg = tone === 'warn' ? '#FEF3C7' : '#EFF6FF';
  const border = tone === 'warn' ? '#FDE68A' : '#BFDBFE';
  const color = tone === 'warn' ? '#92400E' : '#1E40AF';
  return (
    <div style={{ background: bg, border: `1px solid ${border}`, borderRadius: 12, padding: 16, marginBottom: 14 }}>
      <div style={{ fontSize: 13, fontWeight: 800, color }}>{title}</div>
      <div style={{ fontSize: 12, color, marginTop: 4 }}>{children}</div>
    </div>
  );
}
function ShellMessage({ title, message }) {
  return (
    <div style={{ minHeight: '100vh', background: SOFT_BG, padding: 40, fontFamily: "'Geist','Inter','Segoe UI',Arial,sans-serif" }}>
      <div style={{ maxWidth: 540, margin: '60px auto', background: '#fff', border: `1px solid ${BORDER}`, borderRadius: 12, padding: 32, textAlign: 'center' }}>
        <div style={{ fontSize: 18, fontWeight: 800, color: '#0F172A' }}>{title}</div>
        <div style={{ fontSize: 13, color: '#64748B', marginTop: 8 }}>{message}</div>
      </div>
    </div>
  );
}
function btnStyle(kind, disabled) {
  if (kind === 'primary') {
    return {
      padding: '8px 16px', borderRadius: 8, fontSize: 13, fontWeight: 700,
      border: '1px solid #2563EB',
      background: disabled ? '#94A3B8' : '#2563EB',
      color: '#fff',
      cursor: disabled ? 'not-allowed' : 'pointer', fontFamily: 'inherit',
    };
  }
  return {
    padding: '8px 16px', borderRadius: 8, fontSize: 13, fontWeight: 700,
    border: `1px solid ${BORDER}`,
    background: '#fff', color: disabled ? '#94A3B8' : '#334155',
    cursor: disabled ? 'not-allowed' : 'pointer', fontFamily: 'inherit',
  };
}
