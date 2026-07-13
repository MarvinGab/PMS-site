import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ResponsiveContainer, ComposedChart, Bar, Line, XAxis, YAxis,
  CartesianGrid, Tooltip as RToolTip, ReferenceArea, ReferenceLine,
} from 'recharts';
import { useApp } from '../AppContext';
import { usePMSData } from '../hooks/usePMSData';
import { computeSelfScoreBreakdown, findRankForDecimal, getMergedRankRanges, getScaleLevels } from '../backend/scoring';
import { resolveCompetenciesForEmployee } from '../backend/competencyResolver';
import { ManagerEvalReadOnly } from '../components/ManagerEvalReadOnly';
import { RatingWidget } from '../components/RatingWidget';
import { persistWorkflow, readWorkflowSync, hydrateWorkflow } from '../backend/stateStore';
import {
  readRatings,
  hydrateRatings,
  submitEmployeeStageAndPersist,
  publishCycleAndPersist,
  revokePublishCycleAndPersist,
  isPublished,
  clearSeededRatings,
  SEED_MARKER,
  subscribeToRatings,
  resolveConcern,
} from '../backend/ratingsStore';
import { pushNotification, addBellNotifications } from '../backend/notify';
import { sendCustomBroadcast } from '../backend/emailService';
import { isSessionTimeoutMessage } from '../backend/sessionTimeout';
import { resolveEmployeeStageState } from '../backend/stageResolver';

const BORDER = '#E2E8F0';
const SOFT_BG = '#F8FAFC';
const INK = '#0F172A';
const MUTED = '#64748B';
const BLUE = '#2563EB';
const VIOLET = '#7C3AED';
const GREEN = '#16A34A';
const AMBER = '#D97706';

function uniqueStamp() {
  return Date.now();
}

// Fixed tracks keep the employee column from absorbing unused table width.
const CALIBRATION_GRID = '34px 220px 108px 108px 108px 66px 210px 96px 68px';
const RED = '#DC2626';

const FINAL_DISPLAY_IDS = new Set(['code', 'code-label', 'label', 'decimal', 'decimal-code', 'decimal-label']);

function finalDisplay(config = {}) {
  const raw = String(config?.finalRatingDisplay || 'code-label');
  return FINAL_DISPLAY_IDS.has(raw) ? raw : 'code-label';
}

function makeNotif(type, { recipientCode, senderCode = '', title, message, submissionCode = '' }) {
  return {
    id: `notif_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    type,
    recipientCode: normalizeCode(recipientCode).toLowerCase(),
    senderCode: normalizeCode(senderCode).toLowerCase(),
    submissionCode: normalizeCode(submissionCode).toLowerCase(),
    title,
    message,
    createdAt: new Date().toISOString(),
    read: false,
  };
}

function csvCell(value) {
  const text = String(value ?? '');
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function downloadCsv(filename, headers, rows) {
  const csv = [headers, ...rows].map((row) => row.map(csvCell).join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

function cleanFilenamePart(value) {
  return String(value || 'all').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'all';
}

function targetUnit(item = {}) {
  return String(item.targetUnit || item.unit || item.targetType || '').trim();
}

function targetText(item = {}) {
  const target = item.target ?? item.targetValue ?? item.value ?? '';
  const unit = targetUnit(item);
  if (target === '' || target === null || target === undefined) return '—';
  if (unit === 'percentage' || unit === '%') return `${target} %`;
  if (unit === 'currency') return `₹ ${target}`;
  return unit ? `${target} ${unit}` : String(target);
}

function stageAchievement(stage = {}, item = {}) {
  const id = item?.id;
  if (!id) return '';
  const raw = stage.achievements?.[id] ?? stage.kpiAchievements?.[id] ?? stage.kraAchievements?.[id] ?? '';
  if (raw === '' || raw === null || raw === undefined) return '';
  const unit = targetUnit(item);
  if (unit === 'percentage' || unit === '%') return `${raw} %`;
  if (unit === 'currency') return `₹ ${raw}`;
  return unit ? `${raw} ${unit}` : String(raw);
}

function stageScore(stage = {}, item = {}) {
  const id = item?.id;
  if (!id) return '';
  const score = stage.itemScores?.[id] ?? stage.kpiScores?.[id]?.score ?? stage.kraScores?.[id]?.score ?? '';
  return score === null || score === undefined ? '' : score;
}

// Single scale source for HR Review — same as the rest of the app
// (getScaleLevels carries the standard default names). On top of that we fall
// back to the default name when an org's stored label is junk (blank or just
// the rank number) and drop a junk rank code (e.g. "0.00"), so the lanes,
// bell curve, register, dropdown and exports all show clean level names.
function isJunkScaleText(value, rankN) {
  const s = String(value ?? '').trim();
  return !s || s === String(rankN) || /^0+(\.0+)?$/.test(s);
}
function getScale(config) {
  const merged = getScaleLevels(config);
  const defaults = getScaleLevels({ scalePoints: config?.scalePoints });
  return merged.map((lvl, i) => {
    const name = isJunkScaleText(lvl.l, lvl.n) ? String(defaults[i]?.l || '') : String(lvl.l);
    const rawCode = String(lvl.code ?? '').trim();
    const code = (!rawCode || /^0+(\.0+)?$/.test(rawCode)) ? String(lvl.n) : rawCode;
    return { n: lvl.n, l: name, code };
  });
}

// Clean label for a rank in axes / lanes. Bands are whole ranks, so score
// spread lives in the separate histogram instead of changing the bell curve.
function rankAxisLabel(level, config) {
  if (!level) return '';
  const n = Number(level.n);
  const label = String(level.l || '').trim();
  const hasLabel = label && label !== String(n) && !/^0+(\.0+)?$/.test(label);
  const rawCode = String(level.code ?? '').trim();
  const code = (!rawCode || /^0+(\.0+)?$/.test(rawCode)) ? String(n) : rawCode;
  const display = finalDisplay(config);
  if (display === 'label') return hasLabel ? label : `Rank ${n}`;
  if (display === 'code' || display === 'decimal') return code;
  if (display === 'decimal-code' || display === 'decimal-label') return hasLabel ? `${code} · ${label}` : `Rank ${n}`;
  return hasLabel ? `${code} · ${label}` : `Rank ${n}`;
}

// Smooth (Catmull-Rom → Bézier) SVG path through a list of [x,y] points.
function splinePath(points, smoothing = 0.18) {
  if (!points || points.length < 2) return points?.length ? `M ${points[0][0]} ${points[0][1]}` : '';
  const ctrl = (cur, prev, next, reverse) => {
    prev = prev || cur; next = next || cur;
    const dx = next[0] - prev[0], dy = next[1] - prev[1];
    const ang = Math.atan2(dy, dx) + (reverse ? Math.PI : 0);
    const len = Math.hypot(dx, dy) * smoothing;
    return [cur[0] + Math.cos(ang) * len, cur[1] + Math.sin(ang) * len];
  };
  let d = `M ${points[0][0]} ${points[0][1]}`;
  for (let i = 1; i < points.length; i++) {
    const cps = ctrl(points[i - 1], points[i - 2], points[i], false);
    const cpe = ctrl(points[i], points[i - 1], points[i + 1], true);
    d += ` C ${cps[0]} ${cps[1]}, ${cpe[0]} ${cpe[1]}, ${points[i][0]} ${points[i][1]}`;
  }
  return d;
}

function formatFinalRank(level, config = {}, decimal = null) {
  if (!level) return '';
  const display = finalDisplay(config);
  const code = String(level.code || level.n);
  const label = String(level.l || '').trim();
  const hasDecimal = Number.isFinite(Number(decimal));
  const score = hasDecimal ? Number(decimal).toFixed(2) : code;
  if (display === 'code') return code;
  if (display === 'label') return label || code;
  if (display === 'decimal') return hasDecimal ? score : code;
  if (display === 'decimal-code') return hasDecimal ? `${score} - ${code}` : code;
  if (display === 'decimal-label') return hasDecimal ? `${score} - ${label || code}` : (label || code);
  return label ? `${code} - ${label}` : code;
}

function getBellBands(config) {
  const raw = Array.isArray(config?.bellBands) ? config.bellBands : [];
  const scale = getScale(config);
  const sortedTopDown = scale.slice().sort((a, b) => b.n - a.n);
  const center = Math.floor(sortedTopDown.length / 2);
  const byRank = Array.from({ length: scale.length }, () => 0);
  sortedTopDown.forEach((lvl, i) => {
    byRank[Math.max(0, Number(lvl.n) - 1)] = Number(raw[i] ?? (i === center ? 40 : 15));
  });
  return byRank;
}

function getBellTolerances(config) {
  const raw = Array.isArray(config?.bellTolerances) ? config.bellTolerances : [];
  const scale = getScale(config);
  const sortedTopDown = scale.slice().sort((a, b) => b.n - a.n);
  const center = Math.floor(sortedTopDown.length / 2);
  const byRank = Array.from({ length: scale.length }, () => 0);
  sortedTopDown.forEach((lvl, i) => {
    byRank[Math.max(0, Number(lvl.n) - 1)] = Number(raw[i] ?? (i === center ? 5 : 2));
  });
  return byRank;
}

function hrFinalScore(stages) {
  if (stages?.final?.calibratedScore !== undefined && Number(stages.final.calibratedScore) >= 1) return Number(stages.final.calibratedScore);
  if (stages?.manager?.overallScore !== undefined && stages?.manager?.overallScore !== null) return Number(stages.manager.overallScore);
  return null;
}

function hodFinalScore(stages) {
  if (stages?.hod?.calibratedScore !== undefined && Number(stages.hod.calibratedScore) >= 1) return Number(stages.hod.calibratedScore);
  if (stages?.manager?.overallScore !== undefined && stages?.manager?.overallScore !== null) return Number(stages.manager.overallScore);
  return null;
}

function normalizeCode(v) {
  return String(v || '').trim().toUpperCase();
}

function normalizeFilterValue(v) {
  return String(v || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

function gradeSortValue(value) {
  const text = String(value || '').trim();
  if (!text) return { missing: 1, number: Number.POSITIVE_INFINITY, text: '' };
  const match = text.match(/-?\d+(?:\.\d+)?/);
  return {
    missing: 0,
    number: match ? Number(match[0]) : Number.POSITIVE_INFINITY,
    text: text.toLowerCase(),
  };
}

function compareRowsByGradeThenName(a, b) {
  const ag = gradeSortValue(a?.emp?.Grade);
  const bg = gradeSortValue(b?.emp?.Grade);
  if (ag.missing !== bg.missing) return ag.missing - bg.missing;
  if (ag.number !== bg.number) return ag.number - bg.number;
  const gradeText = ag.text.localeCompare(bg.text, undefined, { numeric: true, sensitivity: 'base' });
  if (gradeText !== 0) return gradeText;
  return String(a?.emp?.['Employee Name'] || a?.code || '').localeCompare(String(b?.emp?.['Employee Name'] || b?.code || ''), undefined, { numeric: true, sensitivity: 'base' });
}

function storedOverallScore(stage) {
  if (!stage) return null;
  const score = Number(stage.overallScore);
  return Number.isFinite(score) ? score : null;
}

function groupForEmployee(config, emp) {
  const groupName = String(emp?.['Group Name'] || '').trim().toLowerCase();
  if (!groupName) return null;
  return (config?.goalGroups || []).find((g) => String(g.name || '').trim().toLowerCase() === groupName) || null;
}

function selfStageScore(stage, config, orgKey, emp, submission = null) {
  if (!stage) return null;
  const stored = storedOverallScore(stage);
  if (stored !== null) return stored;
  if (!stage.submittedAt) return null;
  const goals = getEmployeeGoals(orgKey, emp?.['Employee Code']);
  const effectiveSubmission = submission || readWorkflowSync(orgKey)?.submissions?.[normalizeCode(emp?.['Employee Code'])] || null;
  const resolved = resolveCompetenciesForEmployee(config, emp, effectiveSubmission);
  const group = groupForEmployee(config, emp);
  const breakdown = computeSelfScoreBreakdown({
    config,
    goals,
    scores: stage.itemScores || {},
    rateAtKpi: group?.kpiRatingMode !== 'free-text',
    competencies: resolved.competencies || [],
    compScores: stage.competencyScores || {},
    competenciesSelfRated: config?.competencyAllowSelfRate !== false,
    resolved,
  });
  return Number.isFinite(Number(breakdown.final)) ? Number(breakdown.final) : null;
}

function rankForScore(score, scale, config) {
  if (!Number.isFinite(Number(score))) return null;
  const ranges = getMergedRankRanges(scale, config?.scaleRankRanges || {});
  return findRankForDecimal(Number(score), ranges, scale) || null;
}

function displayScore(score, scale, config) {
  if (!Number.isFinite(Number(score))) return '—';
  const level = rankForScore(score, scale, config);
  return formatFinalRank(level, config, score);
}

function scoreDelta(a, b) {
  if (!Number.isFinite(Number(a)) || !Number.isFinite(Number(b))) return '—';
  const diff = Number(b) - Number(a);
  if (Math.abs(diff) < 0.01) return '0';
  return `${diff > 0 ? '+' : ''}${diff.toFixed(2).replace(/\.00$/, '')}`;
}

function gapToneFromValues(a, b) {
  if (!Number.isFinite(Number(a)) || !Number.isFinite(Number(b))) return MUTED;
  const diff = Number(b) - Number(a);
  const abs = Math.abs(diff);
  if (abs < 0.01) return INK;
  if (abs < 0.5) return MUTED;
  if (abs < 1) return AMBER;
  return RED;
}

function varianceTone(diff, tolerance = 0) {
  if (!Number.isFinite(Number(diff))) return MUTED;
  const n = Number(diff);
  const abs = Math.abs(n);
  const tol = Math.max(0, Number(tolerance || 0));
  if (abs < 0.01) return GREEN;
  if (abs <= tol) return GREEN;
  if (tol > 0 && abs <= tol * 2) return AMBER;
  return RED;
}

function buildDistribution(rows, scale, config) {
  const counts = Array.from({ length: scale.length || 5 }, () => 0);
  rows.forEach((row) => {
    const level = rankForScore(row.finalScore, scale, config);
    if (!level) return;
    const idx = Math.max(0, Math.min((scale.length || 5) - 1, Number(level.n) - 1));
    counts[idx] += 1;
  });
  const total = counts.reduce((sum, n) => sum + n, 0);
  const pct = counts.map((n) => (total > 0 ? Math.round((n / total) * 100) : 0));
  return { counts, pct, total };
}

function getEmployeeGoals(orgKey, empCode) {
  const wf = readWorkflowSync(orgKey);
  return wf.submissions?.[normalizeCode(empCode)]?.goals || [];
}

function flattenGoalItems(goals = []) {
  const rows = [];
  goals.forEach((kra, kraIndex) => {
    const kpis = Array.isArray(kra.kpis) ? kra.kpis : [];
    if (kpis.length) {
      kpis.forEach((kpi) => rows.push({ ...kpi, parentName: kra.name, kind: 'KPI', goalIndex: kraIndex + 1 }));
    } else {
      rows.push({ ...kra, parentName: kra.name, kind: 'KRA', goalIndex: kraIndex + 1 });
    }
  });
  return rows;
}

// Cycle-stage vocabulary + colors — kept identical to the Employee Status page
// (HRCycleDashboard EMP_STAGES) so the same person reads the same everywhere.
const STAGE_PILLS = {
  'goal-creation':    { label: 'Goal creation',      color: '#4F46E5', bg: '#EEF2FF', border: '#C7D2FE' },
  'pending-approval': { label: 'Approval pending',   color: '#D97706', bg: '#FFFBEB', border: '#FDE68A' },
  'self-evaluation':  { label: 'Self evaluation',    color: '#0891B2', bg: '#ECFEFF', border: '#A5F3FC' },
  'mgr-evaluation':   { label: 'Manager evaluation', color: '#7C3AED', bg: '#F5F3FF', border: '#DDD6FE' },
  'hr-review':        { label: 'HR review',          color: '#EA580C', bg: '#FFF7ED', border: '#FED7AA' },
  'calibrated':       { label: 'Calibrated',         color: '#7C3AED', bg: '#F5F3FF', border: '#DDD6FE' },
  'completed':        { label: 'Completed',          color: '#16A34A', bg: '#F0FDF4', border: '#BBF7D0' },
};

// Mirror of HRCycleDashboard statusToStage — resolves the live cycle stage from the
// workflow submission status + rating stages, so this column matches Employee Status.
function MetricCard({ label, value, tone = '#0F172A' }) {
  return (
    <div style={{ background: '#fff', border: `1px solid ${BORDER}`, borderRadius: 12, padding: '14px 16px' }}>
      <div style={{ fontSize: 11, fontWeight: 900, color: '#64748B', textTransform: 'uppercase' }}>{label}</div>
      <div style={{ fontSize: 24, fontWeight: 900, color: tone, marginTop: 4 }}>{value}</div>
    </div>
  );
}

function FilterIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M4 6h16M7 12h10M10 18h4" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" />
    </svg>
  );
}

function DownloadIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M12 4v10m0 0 4-4m-4 4-4-4M5 20h14" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function EmployeeReviewTable({ rows, scale, viewConfig, visibleMetaColumns = [], filterSignature = '', hodMode = false, onOpen, onRemind }) {
  if (!rows.length) {
    return <div style={{ padding: 18, fontSize: 13, color: '#64748B', textAlign: 'center' }}>No employees match the selected filters.</div>;
  }
  const metaColumns = (visibleMetaColumns || []).filter(Boolean);
  const gridTemplate = [
    'minmax(190px, 1.35fr)',
    'minmax(92px, .68fr)',
    'minmax(92px, .68fr)',
    'minmax(92px, .68fr)',
    'minmax(92px, .68fr)',
    'minmax(58px, .42fr)',
    'minmax(128px, .86fr)',
    '44px',
  ].join(' ');
  return (
    <div style={{ border: `1px solid ${BORDER}`, borderRadius: 10, overflow: 'visible', background: '#fff' }}>
      <div style={{ display: 'grid', gridTemplateColumns: gridTemplate, gap: 10, padding: '9px 12px', background: '#F8FAFC', borderRadius: '10px 10px 0 0', fontSize: 11, fontWeight: 900, color: '#64748B', textTransform: 'uppercase', transition: 'grid-template-columns 180ms ease' }}>
        <span>Employee</span>
        <span style={{ textAlign: 'center' }}>Self</span>
        <span style={{ textAlign: 'center' }}>Manager</span>
        <span style={{ textAlign: 'center' }}>HOD</span>
        <span style={{ textAlign: 'center' }}>Final</span>
        <span style={{ textAlign: 'center' }}>Gap</span>
        <span style={{ textAlign: 'center' }}>Status</span>
        <span style={{ justifySelf: 'end' }} />
      </div>
      <div key={filterSignature} style={{ animation: 'hrRowsIn 170ms ease' }}>
        {rows.map((row) => (
          <EmployeeReviewRow
            key={row.code}
            row={row}
            scale={scale}
            viewConfig={viewConfig}
            metaColumns={metaColumns}
            gridTemplate={gridTemplate}
            hodMode={hodMode}
            onOpen={onOpen}
            onRemind={onRemind}
          />
        ))}
      </div>
    </div>
  );
}

function EmployeeReviewRow({ row, scale, viewConfig, metaColumns = [], gridTemplate, hodMode = false, onOpen, onRemind }) {
  const completed = !!row.stages?.manager?.submittedAt;
  const finalChanged = Number.isFinite(Number(row.finalScore)) && Number.isFinite(Number(row.managerScore)) && Number(row.finalScore) !== Number(row.managerScore);
  const hodDone = row.stages?.hod?.calibratedScore !== undefined && Number(row.hodScore) >= 1;
  const gap = scoreDelta(row.selfScore, row.managerScore);
  const gapTone = gapToneFromValues(row.selfScore, row.managerScore);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef(null);
  const btnRef = useRef(null);
  useEffect(() => {
    if (!menuOpen) return undefined;
    const onDown = (event) => {
      if (menuRef.current?.contains(event.target) || btnRef.current?.contains(event.target)) return;
      setMenuOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [menuOpen]);
  const metaValue = (column) => {
    if (column.key === 'grade') return row.emp.Grade || 'Ungraded';
    if (column.key === 'group') return row.emp['Group Name'] || '—';
    if (column.key === 'role') return row.emp.Role || row.emp.Designation || '—';
    if (column.key === 'hod') return row.hodName || row.emp['HOD Code'] || 'No HOD';
    if (column.key === 'manager') return row.managerName || row.emp['Reporting Manager Code'] || 'No manager';
    if (column.key === 'gap') return scoreDelta(row.selfScore, row.managerScore);
    return '—';
  };
  const subtitleParts = [
    row.code,
    ...metaColumns.map((column) => {
      const value = metaValue(column);
      return value && value !== '—' ? `${column.label}: ${value}` : '';
    }).filter(Boolean),
  ];

  return (
    <div style={{ borderTop: `1px solid ${BORDER}` }}>
      <div style={{ display: 'grid', gridTemplateColumns: gridTemplate, gap: 10, padding: '11px 12px', alignItems: 'center', fontSize: 12.5 }}>
        <button type="button" onClick={() => onOpen(row.code)} style={{ textAlign: 'left', border: 0, background: 'transparent', padding: 0, cursor: 'pointer', fontFamily: 'inherit' }}>
          <div style={{ fontWeight: 800, color: '#0F172A' }}>{row.emp['Employee Name'] || row.code}</div>
          <div title={subtitleParts.join(' · ')} style={{ color: '#64748B', fontSize: 11.5, marginTop: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {subtitleParts.join(' · ')}
          </div>
        </button>
        {row.selfDone ? <ScoreCell score={row.selfScore} scale={scale} config={viewConfig} /> : <MutedDash />}
        {completed ? <ScoreCell score={row.managerScore} scale={scale} config={viewConfig} strong /> : <MutedDash />}
        {completed && hodDone ? <ScoreCell score={row.hodScore} scale={scale} config={viewConfig} strong accent="#0891B2" /> : <MutedDash />}
        {completed ? <ScoreCell score={row.finalScore} scale={scale} config={viewConfig} strong accent={finalChanged ? '#7C3AED' : '#0F172A'} /> : <MutedDash />}
        <span style={{ textAlign: 'center', color: gapTone, fontWeight: 900 }}>{completed ? gap : '—'}</span>
        <span style={{ justifySelf: 'center' }}><StagePill stage={row.status} /></span>
        <div style={{ position: 'relative', justifySelf: 'end' }}>
          <button
            ref={btnRef}
            type="button"
            onClick={() => setMenuOpen((open) => !open)}
            aria-label="Row actions"
            style={{ width: 32, height: 32, borderRadius: 9, border: `1px solid ${menuOpen ? BLUE : BORDER}`, background: menuOpen ? '#EFF6FF' : '#fff', color: menuOpen ? BLUE : MUTED, cursor: 'pointer', fontFamily: 'inherit', fontSize: 18, lineHeight: 1, fontWeight: 900 }}
          >
            ⋯
          </button>
          {menuOpen && (
            <div ref={menuRef} style={{ position: 'absolute', right: 0, top: 38, zIndex: 30, width: 168, background: '#fff', border: `1px solid ${BORDER}`, borderRadius: 12, boxShadow: '0 12px 28px rgba(15,23,42,0.14)', padding: 6 }}>
              <button type="button" onClick={() => { setMenuOpen(false); onOpen(row.code); }} style={menuItemStyle}>View details</button>
              {!hodMode && !completed && <button type="button" onClick={() => { setMenuOpen(false); onRemind(row); }} style={menuItemStyle}>Remind</button>}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function MutedDash() {
  return <span style={{ display: 'block', textAlign: 'center', color: '#CBD5E1', fontWeight: 800 }}>—</span>;
}

// Cool-tone pill per rank band (no red/green — those are reserved for
// validation states). Higher ranks shift toward violet, lower toward slate.
function bandPillStyle(rankN) {
  const tones = {
    1: { bg: '#F1F5F9', fg: '#475569' },
    2: { bg: '#EFF6FF', fg: '#2563EB' },
    3: { bg: '#EEF2FF', fg: '#4F46E5' },
    4: { bg: '#F5F3FF', fg: '#7C3AED' },
    5: { bg: '#FAF5FF', fg: '#9333EA' },
  };
  const t = tones[Number(rankN)] || tones[1];
  return {
    display: 'inline-block', maxWidth: 118, overflow: 'hidden', textOverflow: 'ellipsis',
    whiteSpace: 'nowrap', verticalAlign: 'middle',
    background: t.bg, color: t.fg, borderRadius: 999, padding: '1px 7px',
    fontSize: 10.5, fontWeight: 800, letterSpacing: 0.1,
  };
}

function ScoreCell({ score, scale, config, strong = false, accent = '#0F172A' }) {
  if (!Number.isFinite(Number(score))) {
    return <span style={{ fontWeight: strong ? 850 : 700, color: '#94A3B8' }}>—</span>;
  }
  const text = displayScore(score, scale, config);
  const dash = text.indexOf(' - ');
  const num = dash >= 0 ? text.slice(0, dash) : text;
  const band = dash >= 0 ? text.slice(dash + 3) : '';
  const level = rankForScore(score, scale, config);
  return (
    <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3, minWidth: 0 }}>
      <span style={{ fontWeight: strong ? 850 : 750, color: accent }}>{num}</span>
      {band && <span title={band} style={bandPillStyle(level?.n)}>{band}</span>}
    </span>
  );
}

function DetailRatingBox({ label, score, scale, config, tone = INK, pulse = false, editable = false, displayText = '', children = null }) {
  const value = displayText || displayScore(score, scale, config);
  const hasScore = Number.isFinite(Number(score));
  const dash = value.indexOf(' - ');
  const num = dash >= 0 ? value.slice(0, dash) : value;
  const band = dash >= 0 ? value.slice(dash + 3) : '';
  return (
    <div
      style={{
        border: `1px solid ${editable ? '#C7D2FE' : (pulse ? '#BFDBFE' : BORDER)}`,
        borderRadius: 11,
        background: editable ? '#FBFAFF' : '#fff',
        padding: '9px 12px',
        boxShadow: editable ? '0 6px 16px rgba(79,70,229,0.06)' : 'none',
        animation: pulse ? 'ratingChangedBlink 900ms ease 1' : 'none',
      }}
    >
      <div style={{ fontSize: 9.5, fontWeight: 900, color: MUTED, textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 4 }}>{label}</div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 7, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 21, fontWeight: 900, color: hasScore ? tone : '#94A3B8', lineHeight: 1.05 }}>{hasScore ? num : '—'}</span>
        {hasScore && band && <span style={{ fontSize: 11, fontWeight: 800, color: tone, opacity: 0.85 }}>{band}</span>}
      </div>
      {children}
    </div>
  );
}

function ReviewDetailModal({ row, orgKey, config, viewConfig, scale, actor, published, hodMode = false, onChanged, onClose }) {
  const disp = viewConfig || config;
  const goals = getEmployeeGoals(orgKey, row.code);
  const self = row.stages?.self || {};
  const manager = row.stages?.manager || {};
  const hod = row.stages?.hod || {};
  const final = row.stages?.final || {};
  const hasFinalCalibration = final.calibratedScore !== undefined && Number.isFinite(Number(final.calibratedScore)) && Number(final.calibratedScore) >= 1;
  const hasHodCalibration = hod.calibratedScore !== undefined && Number.isFinite(Number(row.hodScore)) && Number(row.hodScore) >= 1;
  const hrLockedForHod = hodMode && hasFinalCalibration;
  const canCalibrate = !published && !hrLockedForHod && row.managerDone && Number.isFinite(Number(row.managerScore));
  const calibrateFrom = hodMode
    ? (hasHodCalibration ? Number(row.hodScore) : Number(row.managerScore))
    : (hasFinalCalibration ? Number(final.calibratedScore) : Number(row.managerScore));
  const calibratedScore = hodMode
    ? (hasHodCalibration ? row.hodScore : row.managerScore)
    : (hasFinalCalibration ? final.calibratedScore : row.managerScore);
  const calibratedLabel = hodMode && hasHodCalibration ? 'HOD rating' : 'Final rating';
  const calibratedChanged = (hodMode ? hasHodCalibration : hasFinalCalibration)
    && Number.isFinite(Number(calibratedScore))
    && Number.isFinite(Number(row.managerScore))
    && Math.abs(Number(calibratedScore) - Number(row.managerScore)) >= 0.01;
  const [liveCalibratedScore, setLiveCalibratedScore] = useState(calibratedScore);
  const [liveCalibratedText, setLiveCalibratedText] = useState('');
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.48)', zIndex: 13000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
      <div style={{ width: 'min(1180px, 96vw)', maxHeight: '88vh', overflow: 'hidden', background: '#fff', borderRadius: 16, border: `1px solid ${BORDER}`, boxShadow: '0 24px 80px rgba(15,23,42,0.22)' }}>
        <div style={{ padding: '18px 22px', borderBottom: `1px solid ${BORDER}`, display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'flex-start' }}>
          <div>
            <div style={{ fontSize: 20, fontWeight: 900, color: '#0F172A' }}>{row.emp['Employee Name'] || row.code}</div>
            <div style={{ fontSize: 12.5, color: '#64748B', marginTop: 4 }}>
              {row.code} · Manager: <strong style={{ color: INK, fontWeight: 800 }}>{row.managerName || 'No manager'}</strong>
              {row.managerCode || row.emp['Reporting Manager Code'] ? ` (${row.managerCode || row.emp['Reporting Manager Code']})` : ''}
            </div>
          </div>
          <button type="button" onClick={onClose} style={{ width: 38, height: 38, borderRadius: 10, border: `1px solid ${BORDER}`, background: '#fff', cursor: 'pointer', fontSize: 20, color: '#64748B' }}>×</button>
        </div>
        <div style={{ padding: 22, overflow: 'auto', maxHeight: 'calc(88vh - 82px)' }}>
          <div style={{ display: 'grid', gap: 14 }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(150px, 1fr))', gap: 10, alignItems: 'start' }}>
              <DetailRatingBox label="Self rating" score={row.selfScore} scale={scale} config={disp} tone="#0891B2" />
              <DetailRatingBox label="Manager rating" score={row.managerScore} scale={scale} config={disp} tone="#2563EB" />
              <DetailRatingBox label={calibratedLabel} score={canCalibrate ? liveCalibratedScore : calibratedScore} scale={scale} config={disp} tone={hodMode && hasHodCalibration ? '#0891B2' : '#7C3AED'} pulse={calibratedChanged} editable={canCalibrate} displayText={canCalibrate ? liveCalibratedText : ''}>
                {canCalibrate && (
                  <CalibratePanel currentValue={calibrateFrom} scale={scale} config={config} orgKey={orgKey} code={row.code} actor={actor}
                    mode={hodMode ? 'hod' : 'final'} hasCalibration={hodMode ? hasHodCalibration : hasFinalCalibration}
                    onChanged={onChanged} onClose={onClose} onDraftScoreChange={setLiveCalibratedScore} onDraftDisplayChange={setLiveCalibratedText} />
                )}
              </DetailRatingBox>
            </div>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 12, fontWeight: 900, color: MUTED, textTransform: 'uppercase', letterSpacing: '.06em', margin: '0 0 10px' }}>
                Goal details
              </div>
              <div style={{ marginBottom: 14 }}>
                <ManagerEvalReadOnly config={config} emp={row.emp} goals={goals} submission={row.submission} selfStage={self} managerStage={manager} />
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <CommentBox title="Self comment" text={self.overallComment} />
                <CommentBox title="Manager comment" text={manager.overallComment} />
              </div>
            </div>
          </div>
          {final.calibrationNote && (
            <div style={{ marginTop: 12, padding: 12, borderRadius: 10, border: '1px solid #DDD6FE', background: '#F5F3FF', color: '#5B21B6', fontSize: 12.5, fontWeight: 700 }}>
              Calibration reason: {final.calibrationNote}
            </div>
          )}
          {hod.calibrationNote && (
            <div style={{ marginTop: 12, padding: 12, borderRadius: 10, border: '1px solid #BAE6FD', background: '#F0F9FF', color: '#0369A1', fontSize: 12.5, fontWeight: 700 }}>
              HOD note: {hod.calibrationNote}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function CommentBox({ title, text }) {
  return (
    <div style={{ border: `1px solid ${BORDER}`, borderRadius: 10, padding: 12, background: '#FAFBFF' }}>
      <div style={{ fontSize: 11, fontWeight: 900, color: '#64748B', textTransform: 'uppercase', marginBottom: 6 }}>{title}</div>
      <div style={{ fontSize: 12.5, color: '#334155', minHeight: 36 }}>{text || '—'}</div>
    </div>
  );
}

function DetailInfo({ label, value }) {
  return (
    <div style={{ minWidth: 0 }}>
      <div style={{ fontSize: 10.5, fontWeight: 900, color: MUTED, textTransform: 'uppercase', letterSpacing: '.04em', marginBottom: 3 }}>{label}</div>
      <div title={value} style={{ fontSize: 12.5, fontWeight: 800, color: INK, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{value}</div>
    </div>
  );
}

function FilterField({ label, value, onChange, options = [], allLabel = 'All', noneOption = null }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
      <span style={{ fontSize: 10.5, fontWeight: 900, color: MUTED, textTransform: 'uppercase', letterSpacing: '.04em' }}>{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)} style={{ width: '100%', padding: '9px 10px', border: `1px solid ${BORDER}`, borderRadius: 9, background: '#fff', color: INK, fontSize: 12.5, fontWeight: 750, fontFamily: 'inherit' }}>
        <option value="all">{allLabel}</option>
        {noneOption && <option value={noneOption[0]}>{noneOption[1]}</option>}
        {options.map(([optionValue, optionLabel]) => <option key={optionValue} value={optionValue}>{optionLabel}</option>)}
      </select>
    </label>
  );
}

function BellCurveToolbar({
  search,
  setSearch,
  activeFilters,
  clearAllFilters,
  shown,
  total,
  groups,
  designations,
  managers,
  grades,
  hods,
  hodMode,
  groupFilter,
  setGroupFilter,
  desigFilter,
  setDesigFilter,
  managerFilter,
  setManagerFilter,
  gradeFilter,
  setGradeFilter,
  hodFilter,
  setHodFilter,
  gapFilter,
  setGapFilter,
  onDownloadBell,
  onDownloadDetails,
  primaryExportLabel = 'Bell curve CSV',
  shownLabel = 'completed employees',
}) {
  const [filterOpen, setFilterOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const filterRef = useRef(null);
  const exportRef = useRef(null);

  useEffect(() => {
    if (!filterOpen && !exportOpen) return undefined;
    const onDown = (event) => {
      if (filterRef.current?.contains(event.target) || exportRef.current?.contains(event.target)) return;
      setFilterOpen(false);
      setExportOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [filterOpen, exportOpen]);

  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
      <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search employee" style={{ width: 260, padding: '8px 11px', border: `1px solid ${BORDER}`, borderRadius: 9, fontSize: 12.5, fontFamily: 'inherit' }} />
      <div ref={filterRef} style={{ position: 'relative' }}>
        <button
          type="button"
          onClick={() => setFilterOpen((open) => { if (!open) setExportOpen(false); return !open; })}
          title="Filters"
          aria-label="Filters"
          aria-expanded={filterOpen}
          style={{ ...btnStyle(activeFilters.length ? 'primary' : 'ghost', false), width: 42, height: 42, padding: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', position: 'relative', flexShrink: 0 }}
        >
          <FilterIcon />
          {activeFilters.length > 0 && (
            <span style={{ position: 'absolute', top: -6, right: -6, minWidth: 19, height: 19, borderRadius: 999, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', background: filterOpen ? '#fff' : BLUE, color: filterOpen ? BLUE : '#fff', border: `1px solid ${filterOpen ? '#BFDBFE' : BLUE}`, fontSize: 11, fontWeight: 900 }}>
              {activeFilters.length}
            </span>
          )}
        </button>
        {filterOpen && (
          <div style={{ position: 'absolute', right: 0, top: 48, zIndex: 100, width: 420, maxWidth: 'calc(100vw - 40px)', background: '#fff', border: `1px solid ${BORDER}`, borderRadius: 14, boxShadow: '0 18px 48px rgba(15,23,42,0.18)', overflow: 'hidden', animation: 'hrFilterIn 150ms ease' }}>
            <div style={{ padding: '13px 14px', borderBottom: `1px solid ${BORDER}`, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
              <div>
                <div style={{ fontSize: 13.5, fontWeight: 950, color: INK }}>Advanced filters</div>
                <div style={{ fontSize: 11.5, color: MUTED, marginTop: 2 }}>{shown} of {total} {shownLabel} shown</div>
              </div>
              <button type="button" onClick={clearAllFilters} disabled={activeFilters.length === 0} style={{ border: 0, background: 'transparent', color: activeFilters.length ? BLUE : '#CBD5E1', fontSize: 12.5, fontWeight: 850, cursor: activeFilters.length ? 'pointer' : 'default', fontFamily: 'inherit' }}>Reset</button>
            </div>
            <div style={{ padding: 14, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <FilterField label="Group" value={groupFilter} onChange={setGroupFilter} options={groups.map((g) => [g, g])} allLabel="All groups" />
              <FilterField label="Role" value={desigFilter} onChange={setDesigFilter} options={designations.map((d) => [d, d])} allLabel="All roles" />
              <FilterField label="Manager" value={managerFilter} onChange={setManagerFilter} options={managers} allLabel="All managers" noneOption={['__none__', 'No manager']} />
              <FilterField label="Grade" value={gradeFilter} onChange={setGradeFilter} options={grades.map((g) => [g, g])} allLabel="All grades" noneOption={['__ungraded__', 'Ungraded']} />
              {!hodMode && <FilterField label="HOD" value={hodFilter} onChange={setHodFilter} options={hods} allLabel="All HODs" noneOption={['__none__', 'No HOD']} />}
              <FilterField label="Gap" value={gapFilter} onChange={setGapFilter} options={[['positive', '+ manager higher'], ['negative', '- manager lower'], ['zero', '0 no gap']]} allLabel="All gaps" />
            </div>
          </div>
        )}
      </div>
      <div ref={exportRef} style={{ position: 'relative' }}>
        <button
          type="button"
          onClick={() => setExportOpen((open) => { if (!open) setFilterOpen(false); return !open; })}
          title="Export"
          aria-label="Export"
          aria-expanded={exportOpen}
          style={{ ...btnStyle('ghost', false), width: 42, height: 42, padding: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}
        >
          <DownloadIcon />
        </button>
        {exportOpen && (
          <div style={{ position: 'absolute', right: 0, top: 48, zIndex: 90, width: 220, background: '#fff', border: `1px solid ${BORDER}`, borderRadius: 12, boxShadow: '0 14px 34px rgba(15,23,42,0.16)', padding: 6, animation: 'hrFilterIn 150ms ease' }}>
            <button type="button" onClick={() => { setExportOpen(false); onDownloadBell(); }} style={menuItemStyle}>{primaryExportLabel}</button>
            <button type="button" onClick={() => { setExportOpen(false); onDownloadDetails(); }} style={menuItemStyle}>Goal details CSV</button>
          </div>
        )}
      </div>
    </div>
  );
}

export default function HRReviewPage({ embedded = false, hodMode = false, hodCode = '', overrideOrgKey = '', actorName = '' } = {}) {
  const { orgKey: appOrgKey, userName } = useApp();
  const orgKey = overrideOrgKey || appOrgKey;
  const actorDisplayName = actorName || userName || (hodMode ? 'HOD' : 'HR admin');
  const { ready, config, employees, org } = usePMSData(orgKey);
  const bellEnabled = config?.bellEnabled !== false;
  const [activeTab, setActiveTab] = useState(() => (
    !hodMode && config?.finalEmployeeAcceptanceEnabled === true && isPublished(orgKey)
      ? 'acknowledgement'
      : (bellEnabled ? 'bell' : 'employees')
  ));
  const [groupFilter, setGroupFilter] = useState('all');
  const [desigFilter, setDesigFilter] = useState('all');
  const [gradeFilter, setGradeFilter] = useState('all');
  const [hodFilter, setHodFilter] = useState('all');
  const [managerFilter, setManagerFilter] = useState('all');
  const [gapFilter, setGapFilter] = useState('all');
  const [filterOpen, setFilterOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const filterRef = useRef(null);
  const exportRef = useRef(null);
  const [search, setSearch] = useState('');
  const [auditSearch, setAuditSearch] = useState('');
  const [selectedCode, setSelectedCode] = useState('');
  const [tick, setTick] = useState(0);
  const [toast, setToast] = useState('');
  const [scoreHistogramView, setScoreHistogramView] = useState('combined');
  // Open during the HR-review/calibration phases, and ALWAYS once results are
  // published — so HR never loses access to results + acknowledgements even if
  // the legacy cycle-phase flag has moved on.
  // Open during the HR-review/calibration phases, once results are published, OR
  // whenever there's any rating activity to review (a manager has submitted, or a
  // calibration exists). This keeps HR Review reachable even if the legacy
  // cycle-phase flag drifts or the publish flag flickers during a sync hiccup.
  const hrReviewOpen = org?.currentPhase === 'hr-review'
    || org?.currentPhase === 'calibrated'
    || isPublished(orgKey)
    || Object.values(readRatings(orgKey)?.ratings || {}).some((s) => !!s?.manager?.submittedAt || s?.final?.calibratedScore !== undefined || s?.hod?.calibratedScore !== undefined);

  useEffect(() => {
    if (bellEnabled && activeTab === 'employees') {
      queueMicrotask(() => setActiveTab('bell'));
    }
    if (!bellEnabled && activeTab === 'bell') {
      queueMicrotask(() => setActiveTab('employees'));
    }
  }, [activeTab, bellEnabled]);

  useEffect(() => {
    if (!filterOpen && !exportOpen) return undefined;
    const onDown = (event) => {
      if (filterRef.current?.contains(event.target) || exportRef.current?.contains(event.target)) return;
      setFilterOpen(false);
      setExportOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [filterOpen, exportOpen]);

  useEffect(() => {
    if (!orgKey) return undefined;
    const refresh = () => setTick((t) => t + 1);
    // Pull both stores from the DB on mount: ratings drive scores + late stages,
    // workflow drives the early stages (goal creation / approval / self-eval).
    const rehydrate = () => {
      void hydrateRatings(orgKey).then(refresh);
      void hydrateWorkflow(orgKey).then(refresh);
    };
    rehydrate();
    const unsubscribeRatings = subscribeToRatings(orgKey, refresh);
    window.addEventListener('zarohr-ratings-changed', refresh);
    window.addEventListener('storage', refresh);
    // Safety net (same as the Employee Status page): re-read on focus / tab
    // return so a missed live update self-heals without a manual reload.
    window.addEventListener('focus', rehydrate);
    document.addEventListener('visibilitychange', rehydrate);
    return () => {
      window.removeEventListener('zarohr-ratings-changed', refresh);
      window.removeEventListener('storage', refresh);
      window.removeEventListener('focus', rehydrate);
      document.removeEventListener('visibilitychange', rehydrate);
      unsubscribeRatings();
    };
  }, [orgKey]);

  const viewConfig = useMemo(() => ({ ...config, finalRatingDisplay: finalDisplay(config) }), [config]);
  const groups = useMemo(() => {
    const set = new Map();
    (config?.goalGroups || []).forEach((g) => {
      const name = String(g.name || '').trim();
      if (name) set.set(normalizeFilterValue(name), name);
    });
    employees.forEach((e) => {
      const name = String(e['Group Name'] || '').trim();
      if (name && name.toUpperCase() !== 'NONE') set.set(normalizeFilterValue(name), name);
    });
    return Array.from(set.values()).sort((a, b) => a.localeCompare(b));
  }, [config, employees]);
  const grades = useMemo(() => {
    const set = new Set();
    employees.forEach((e) => { const d = String(e.Grade || '').trim(); if (d) set.add(d); });
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [employees]);
  const hods = useMemo(() => {
    const byCode = new Map(employees.map((e) => [normalizeCode(e['Employee Code']), e]));
    const set = new Map();
    employees.forEach((e) => {
      const code = normalizeCode(e['HOD Code']);
      if (!code) return;
      const hodEmp = byCode.get(code);
      set.set(code, hodEmp?.['Employee Name'] || code);
    });
    return Array.from(set.entries()).sort((a, b) => a[1].localeCompare(b[1]));
  }, [employees]);
  const managers = useMemo(() => {
    const byCode = new Map(employees.map((e) => [normalizeCode(e['Employee Code']), e]));
    const set = new Map();
    employees.forEach((e) => {
      const code = normalizeCode(e['Reporting Manager Code']);
      if (!code) return;
      const managerEmp = byCode.get(code);
      set.set(code, managerEmp?.['Employee Name'] || code);
    });
    return Array.from(set.entries()).sort((a, b) => a[1].localeCompare(b[1]));
  }, [employees]);
  const designations = useMemo(() => {
    const set = new Set();
    employees.forEach((e) => { const d = String(e.Role || e.Designation || '').trim(); if (d) set.add(d); });
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [employees]);
  const empMap = useMemo(() => {
    const m = {};
    employees.forEach((e) => { m[normalizeCode(e['Employee Code'])] = e['Employee Name'] || ''; });
    return m;
  }, [employees]);

  const ratings = readRatings(orgKey);
  void tick;
  // How many employees carry demo-seeded ratings (so we can offer a cleanup).
  const seededCount = useMemo(() => {
    const isSeeded = (s) => !!s && (s._seeded === true || s.overallComment === SEED_MARKER);
    return Object.values(ratings.ratings || {}).filter(
      (stages) => stages && Object.values(stages).some(isSeeded)
    ).length;
  }, [ratings]);
  const wfSubmissions = readWorkflowSync(orgKey)?.submissions || {};
  const published = isPublished(orgKey);
  const employeeByCode = new Map(employees.map((e) => [normalizeCode(e['Employee Code']), e]));
  const reviewEmployees = employees.filter((emp) => !(
    emp?._outsidePms || emp?._pmsExempt ||
    String(emp?.['Group Name'] || '').trim().toUpperCase() === 'NONE'
  ));
  const allRows = reviewEmployees.map((emp) => {
    const code = String(emp['Employee Code'] || '').trim();
    const managerCode = normalizeCode(emp['Reporting Manager Code']);
    const hodOwnerCode = normalizeCode(emp['HOD Code']);
    const managerName = managerCode ? (employeeByCode.get(managerCode)?.['Employee Name'] || managerCode) : '';
    const hodName = hodOwnerCode ? (employeeByCode.get(hodOwnerCode)?.['Employee Name'] || hodOwnerCode) : '';
    const stages = ratings.ratings?.[code] || {};
    const submission = wfSubmissions[normalizeCode(code)] || null;
    const selfScore = selfStageScore(stages.self, config, orgKey, emp, submission);
    const managerScore = storedOverallScore(stages.manager);
    const hodScore = stages?.hod?.calibratedScore !== undefined ? Number(stages.hod.calibratedScore) : null;
    const finalScore = hrFinalScore(stages);
    const stageState = resolveEmployeeStageState(submission, stages, published);
    const { managerDone, selfDone, stageId } = stageState;
    const reviewScore = hodMode
      ? (stageState.hodDone ? hodFinalScore(stages) : managerScore)
      : (stageState.finalDone ? finalScore : managerScore);
    return {
      emp,
      code,
      submission,
      stages,
      selfScore: selfDone ? selfScore : null,
      managerScore: managerDone ? managerScore : null,
      hodScore: stageState.hodDone ? hodScore : null,
      finalScore: stageState.finalDone ? finalScore : (managerDone ? managerScore : null),
      score: managerDone ? reviewScore : null,
      managerDone,
      selfDone,
      managerCode,
      managerName,
      hodName,
      stageId,
      status: STAGE_PILLS[stageId] || STAGE_PILLS['goal-creation'],
    };
  });

  const scopedRows = hodMode
    ? allRows.filter((row) => normalizeCode(row.emp['HOD Code']) === normalizeCode(hodCode))
    : allRows;

  const hasGradeRows = scopedRows.some((row) => String(row.emp.Grade || '').trim());
  const empRatings = scopedRows.filter((row) => {
    const inGroup = groupFilter === 'all' || String(row.emp['Group Name'] || '').trim() === String(groupFilter || '').trim();
    const inDesig = desigFilter === 'all' || normalizeFilterValue(row.emp.Role || row.emp.Designation) === normalizeFilterValue(desigFilter);
    const inGrade = gradeFilter === 'all' || normalizeFilterValue(row.emp.Grade) === normalizeFilterValue(gradeFilter) || (gradeFilter === '__ungraded__' && !String(row.emp.Grade || '').trim());
    const inHod = hodMode || hodFilter === 'all' || normalizeCode(row.emp['HOD Code']) === normalizeCode(hodFilter) || (hodFilter === '__none__' && !normalizeCode(row.emp['HOD Code']));
    const inManager = managerFilter === 'all' || normalizeCode(row.emp['Reporting Manager Code']) === normalizeCode(managerFilter) || (managerFilter === '__none__' && !normalizeCode(row.emp['Reporting Manager Code']));
    const gapValue = Number(row.managerScore) - Number(row.selfScore);
    const hasGap = Number.isFinite(gapValue);
    const inGap = gapFilter === 'all'
      || (gapFilter === 'positive' && hasGap && gapValue > 0.01)
      || (gapFilter === 'negative' && hasGap && gapValue < -0.01)
      || (gapFilter === 'zero' && hasGap && Math.abs(gapValue) <= 0.01);
    const needle = search.trim().toLowerCase();
    const matchesSearch = !needle || [
      row.emp['Employee Name'],
      row.emp['Employee Code'],
      row.emp.Role,
      row.emp.Designation,
      row.emp['Group Name'],
      row.emp.Grade,
      row.emp['HOD Code'],
      row.managerName,
      row.hodName,
    ].some((v) => String(v || '').toLowerCase().includes(needle));
    return inGroup && inDesig && inGrade && inHod && inManager && inGap && matchesSearch;
  }).sort((a, b) => (hasGradeRows ? compareRowsByGradeThenName(a, b) : 0));
  const visibleMetaColumns = [
    ...(groupFilter !== 'all' ? [{ key: 'group', label: 'Group' }] : []),
    ...(desigFilter !== 'all' ? [{ key: 'role', label: 'Role' }] : []),
    ...(gradeFilter !== 'all' ? [{ key: 'grade', label: 'Grade' }] : []),
    ...(managerFilter !== 'all' ? [{ key: 'manager', label: 'Manager' }] : []),
    ...(!hodMode && hodFilter !== 'all' ? [{ key: 'hod', label: 'HOD' }] : []),
    ...(gapFilter !== 'all' ? [{ key: 'gap', label: 'Gap' }] : []),
  ];
  const filterSignature = `${search.trim()}|${groupFilter}|${desigFilter}|${gradeFilter}|${managerFilter}|${hodFilter}|${gapFilter}`;
  void filterSignature;
  const activeFilters = [
    ...(groupFilter !== 'all' ? [{ key: 'group', label: `Group: ${groupFilter}`, clear: () => setGroupFilter('all') }] : []),
    ...(desigFilter !== 'all' ? [{ key: 'role', label: `Role: ${desigFilter}`, clear: () => setDesigFilter('all') }] : []),
    ...(managerFilter !== 'all' ? [{
      key: 'manager',
      label: `Manager: ${managerFilter === '__none__' ? 'No manager' : (managers.find(([code]) => code === managerFilter)?.[1] || managerFilter)}`,
      clear: () => setManagerFilter('all'),
    }] : []),
    ...(gradeFilter !== 'all' ? [{ key: 'grade', label: `Grade: ${gradeFilter === '__ungraded__' ? 'Ungraded' : gradeFilter}`, clear: () => setGradeFilter('all') }] : []),
    ...(!hodMode && hodFilter !== 'all' ? [{
      key: 'hod',
      label: `HOD: ${hodFilter === '__none__' ? 'No HOD' : (hods.find(([code]) => code === hodFilter)?.[1] || hodFilter)}`,
      clear: () => setHodFilter('all'),
    }] : []),
    ...(gapFilter !== 'all' ? [{
      key: 'gap',
      label: `Gap: ${gapFilter === 'positive' ? '+' : gapFilter === 'negative' ? '-' : '0'}`,
      clear: () => setGapFilter('all'),
    }] : []),
  ];
  const clearAllFilters = () => {
    setGroupFilter('all');
    setDesigFilter('all');
    setManagerFilter('all');
    setGradeFilter('all');
    setHodFilter('all');
    setGapFilter('all');
  };

  const completedRows = empRatings.filter((r) => r.managerDone && r.score !== null);

  // Acknowledgement (employee accept / raise-concern on the published rating).
  const ackEnabled = !hodMode && config?.finalEmployeeAcceptanceEnabled === true;
  const ackStatusOf = (row) => {
    const a = row.stages?.acceptance || {};
    if (a.decision === 'accepted') return 'accepted';
    if (a.decision === 'rejected') return a.resolution ? 'concern-resolved' : 'concern-open';
    return 'none';
  };
  const ackRows = ackEnabled ? scopedRows.filter((r) => r.managerDone) : [];
  const ackCounts = ackRows.reduce((acc, r) => { const s = ackStatusOf(r); acc[s] = (acc[s] || 0) + 1; return acc; }, {});
  const openConcernCount = ackCounts['concern-open'] || 0;
  const [resolveCode, setResolveCode] = useState('');
  const resolveRow = ackRows.find((r) => normalizeCode(r.code) === normalizeCode(resolveCode)) || null;
  const onResolveExplain = async (row, message) => {
    const result = await resolveConcern(orgKey, row.code, { type: 'explained', message }, actorDisplayName);
    if (!result?.ok) {
      setToast(result?.error || 'Could not resolve concern.');
      window.setTimeout(() => setToast(''), 4200);
      return;
    }
    setResolveCode('');
    setTick((t) => t + 1);
    // Notification + email are best-effort — never block/hang the UI.
    pushNotification({
      orgKey, org, config, employees,
      notif: {
        id: `notif_concern_${normalizeCode(row.code)}_${uniqueStamp()}`,
        type: 'concern-resolved', recipientCode: normalizeCode(row.code),
        title: 'HR has responded to your concern',
        message: 'HR has followed up on your concern via email. This request is now marked as resolved.',
        createdAt: new Date().toISOString(), read: false,
      },
      email: { subject: 'Response to your appraisal concern', body: message },
    }).catch(() => {});
  };
  const onResolveRecalibrate = async (row, score, note) => {
    const calibrationResult = await saveCalibrationStage(orgKey, row.code, 'final', row.stages?.final, score, note || 'Recalibrated after employee concern', actorDisplayName);
    if (!calibrationResult?.ok) {
      setToast(calibrationResult?.error || 'Could not recalibrate rating.');
      window.setTimeout(() => setToast(''), 4200);
      return;
    }
    const result = await resolveConcern(orgKey, row.code, { type: 'recalibrated', message: note }, actorDisplayName);
    if (!result?.ok) {
      setToast(result?.error || 'Could not reopen acknowledgement.');
      window.setTimeout(() => setToast(''), 4200);
      return;
    }
    setResolveCode('');
    setTick((t) => t + 1);
    // Notification + email are best-effort — never block/hang the UI.
    pushNotification({
      orgKey, org, config, employees,
      notif: {
        id: `notif_recal_${normalizeCode(row.code)}_${uniqueStamp()}`,
        type: 'concern-recalibrated', recipientCode: normalizeCode(row.code),
        title: 'HR has recalibrated your rating',
        message: 'HR has recalibrated your rating upon your request. Please review and respond again.',
        createdAt: new Date().toISOString(), read: false,
      },
      email: { subject: 'Your appraisal rating was recalibrated', body: 'HR has recalibrated your rating following your concern. Please sign in to review and respond again.' },
    }).catch(() => {});
  };

  const scale = getScale(config);
  const targets = getBellBands(config);
  const tolerances = getBellTolerances(config);
  const dist = buildDistribution(completedRows, scale, config);

  const sortedTopDown = scale.slice().sort((a, b) => b.n - a.n);
  const bellMode = config?.bellMode || 'soft';
  const selectedRow = empRatings.find((row) => normalizeCode(row.code) === normalizeCode(selectedCode));
  const calibratedCount = scopedRows.filter((row) => hodMode ? row.stages?.hod?.calibratedScore !== undefined : row.stages?.final?.calibratedScore !== undefined).length;
  const waitingOnSelf = scopedRows.filter((row) => !row.selfDone).length;
  const waitingOnManager = scopedRows.filter((row) => row.selfDone && !row.managerDone).length;
  const avgSelf = averageScore(completedRows.map((row) => row.selfScore));
  const avgManager = averageScore(completedRows.map((row) => row.managerScore));
  const avgFinal = averageScore(completedRows.map((row) => row.score));

  // Publishing is only meaningful once every participating PMS employee has a
  // finalized manager rating. allRows already excludes exempt / NONE rows.
  const eligibleRows = allRows;
  const pendingToPublish = eligibleRows.filter((row) => !row.managerDone).length;
  const readyToPublish = eligibleRows.length > 0 && pendingToPublish === 0;

  const outOfTolerance = !bellEnabled || dist.total === 0 ? [] : scale.map((_, i) => {
    const diff = Math.abs((dist.pct[i] || 0) - (targets[i] || 0));
    return diff > (tolerances[i] || 0) ? { rank: i + 1, diff, target: targets[i], actual: dist.pct[i] } : null;
  }).filter(Boolean);
  const hasOutOfTolerance = outOfTolerance.length > 0;
  const publishBlocked = bellEnabled && bellMode === 'hard' && hasOutOfTolerance;
  const [publishReason, setPublishReason] = useState('');
  const [publishOpen, setPublishOpen] = useState(false);
  const [publishBusy, setPublishBusy] = useState(false);

  const onClearSeeded = () => {
    const ok = window.confirm(
      `Remove demo-seeded ratings for ${seededCount} employee${seededCount === 1 ? '' : 's'}? `
      + 'Real self/manager submissions are kept. Everyone seeded will drop back to their true stage.'
    );
    if (!ok) return;
    const affected = clearSeededRatings(orgKey);
    setTick((t) => t + 1);
    window.alert(`Removed demo data from ${affected} employee${affected === 1 ? '' : 's'}.`);
  };
  const onPublish = () => {
    if (publishBlocked) return;
    setPublishOpen(true);
  };
  const confirmPublish = async () => {
    const reason = publishReason.trim();
    if (publishBusy || (bellEnabled && bellMode === 'soft' && hasOutOfTolerance && !reason)) return;

    setPublishBusy(true);
    const result = await publishCycleAndPersist(orgKey, actorDisplayName, reason);
    setPublishBusy(false);
    if (!result?.ok) {
      // Session errors already raise the sign-in modal; only toast other errors.
      if (!isSessionTimeoutMessage(result?.error || '')) {
        setToast(result?.error || 'Could not publish cycle. Please retry.');
        window.setTimeout(() => setToast(''), 4200);
      }
      return;
    }

    setPublishReason('');
    setPublishOpen(false);
    setTick((t) => t + 1);

    // Notify all employees in ONE write (not one per person — that was slow).
    const stamp = uniqueStamp();
    addBellNotifications(orgKey, completedRows.map((row, i) => ({
      id: `notif_pub_${normalizeCode(row.code)}_${stamp}_${i}`,
      type: 'results-published', recipientCode: normalizeCode(row.code),
      title: 'Your appraisal results are now available',
      message: 'Your final rating has been published. Sign in to review it.',
      createdAt: new Date().toISOString(), read: false,
    })));

    // Emails are best-effort and must never block the UI.
    if (config?.emailCommsEnabled && org) {
      const recipients = completedRows
        .map((row) => ({ 'Employee Name': row.emp['Employee Name'] || row.code, 'Email ID': String(row.emp['Email ID'] || row.emp.Email || '').trim(), 'Employee Code': row.code }))
        .filter((r) => r['Email ID']);
      if (recipients.length) {
        sendCustomBroadcast({ org, recipients, template: { subject: 'Your appraisal results are now available', body: 'Hi {employee_name},\n\nYour final rating for this cycle has been published. Sign in to review it.' } }).catch(() => {});
      }
    }
  };
  const onRevokePublish = async () => {
    const ok = window.confirm(
      'Testing only: revoke published results and return the cycle to HR review/calibration? Existing ratings and calibrations will be kept.'
    );
    if (!ok) return;
    const result = await revokePublishCycleAndPersist(orgKey, actorDisplayName);
    if (!result?.ok) {
      setToast(result?.error || 'Could not revoke publish.');
      window.setTimeout(() => setToast(''), 4200);
      return;
    }
    setTick((t) => t + 1);
    setToast('Publish revoked for testing. Employees are back to the review/calibration stage.');
    window.setTimeout(() => setToast(''), 3200);
  };
  const sendReminder = (row) => {
    const wf = readWorkflowSync(orgKey) || { submissions: {}, notifications: [] };
    const needsSelf = !row.selfDone;
    const managerCode = row.emp['Reporting Manager Code'] || '';
    const recipientCode = needsSelf ? row.code : managerCode;
    if (!recipientCode) {
      setToast('No reminder recipient found for this employee.');
      return;
    }
    const title = needsSelf ? 'Self-evaluation reminder' : 'Manager rating reminder';
    const message = needsSelf
      ? 'HR requested that you complete and submit your self-evaluation.'
      : `${row.emp['Employee Name'] || row.code} is waiting for your manager rating.`;
    const notification = makeNotif('goal-reminder', {
      recipientCode,
      senderCode: userName || 'HR',
      submissionCode: row.code,
      title,
      message,
    });
    persistWorkflow(orgKey, { ...(wf || {}), notifications: [notification, ...(wf.notifications || [])] });
    setToast(`Reminder sent for ${row.emp['Employee Name'] || row.code}.`);
    window.setTimeout(() => setToast(''), 2800);
  };
  void sendReminder;
  const downloadEmployeeRegister = () => {
    const headers = ['Employee Code', 'Employee Name', 'Designation', 'Group', 'Grade', 'HOD Code', 'Current Stage', 'Self Status', 'Manager Status', 'HOD Status', 'Final Status', 'Self Score', 'Self Rating', 'Manager Score', 'Manager Rating', 'HOD Score', 'HOD Rating', 'Final Score', 'Final Rating', 'Manager minus Self', 'Calibrated', 'Calibration Note',
      ...(ackEnabled ? ['Acknowledgement', 'Concern Reason'] : [])];
    const ackLabel = { accepted: 'Accepted', 'concern-open': 'Concern raised', 'concern-resolved': 'Concern raised (resolved)', none: 'No response yet' };
    const rows = empRatings.map((row) => {
      const completed = row.managerDone;
      const calibrated = row.stages?.final?.calibratedScore !== undefined;
      const hodDone = row.stages?.hod?.calibratedScore !== undefined;
      return [
        row.code,
        row.emp['Employee Name'] || '',
        row.emp.Role || row.emp.Designation || '',
        row.emp['Group Name'] || '',
        row.emp.Grade || '',
        row.emp['HOD Code'] || '',
        row.status.label,
        row.selfDone ? 'Submitted' : 'Pending',
        row.managerDone ? 'Submitted' : 'Pending',
        row.emp['HOD Code'] ? (hodDone ? 'Calibrated' : 'Pending') : '',
        published ? 'Published/finalized' : (calibrated ? 'Calibrated' : ''),
        Number.isFinite(Number(row.selfScore)) ? Number(row.selfScore).toFixed(2) : '',
        row.selfDone ? displayScore(row.selfScore, scale, config) : '',
        Number.isFinite(Number(row.managerScore)) ? Number(row.managerScore).toFixed(2) : '',
        completed ? displayScore(row.managerScore, scale, config) : '',
        Number.isFinite(Number(row.hodScore)) ? Number(row.hodScore).toFixed(2) : '',
        completed && Number.isFinite(Number(row.hodScore)) ? displayScore(row.hodScore, scale, config) : '',
        Number.isFinite(Number(row.finalScore)) ? Number(row.finalScore).toFixed(2) : '',
        completed ? displayScore(row.finalScore, scale, config) : '',
        completed ? scoreDelta(row.selfScore, row.managerScore) : '',
        calibrated ? 'Yes' : 'No',
        row.stages?.final?.calibrationNote || '',
        ...(ackEnabled ? [ackLabel[ackStatusOf(row)] || '', row.stages?.acceptance?.reason || ''] : []),
      ];
    });
    downloadCsv(`hr_review_employee_register_${cleanFilenamePart(groupFilter)}_${cleanFilenamePart(desigFilter)}_${cleanFilenamePart(gradeFilter)}_${cleanFilenamePart(hodFilter)}.csv`, headers, rows);
  };

  const downloadBellCurveExport = () => {
    const headers = ['Employee Code', 'Employee Name', 'Self Score', 'Self Rating', 'Manager Score', 'Manager Rating', hodMode ? 'HOD Score' : 'Final Score', hodMode ? 'HOD Rating' : 'Final Rating', 'Manager minus Self', 'Current Band', 'Calibrated', 'Calibration Note'];
    const rows = completedRows.map((row) => {
      const stage = hodMode ? row.stages?.hod : row.stages?.final;
      const calibrated = stage?.calibratedScore !== undefined && stage?.calibratedScore !== null;
      const activeScore = row.score;
      const band = rankForScore(activeScore, scale, config);
      return [
        row.code,
        row.emp['Employee Name'] || '',
        Number.isFinite(Number(row.selfScore)) ? Number(row.selfScore).toFixed(2) : '',
        displayScore(row.selfScore, scale, config),
        Number.isFinite(Number(row.managerScore)) ? Number(row.managerScore).toFixed(2) : '',
        displayScore(row.managerScore, scale, config),
        Number.isFinite(Number(activeScore)) ? Number(activeScore).toFixed(2) : '',
        displayScore(activeScore, scale, config),
        scoreDelta(row.selfScore, row.managerScore),
        band ? rankAxisLabel(band, config) : '',
        calibrated ? 'Yes' : 'No',
        stage?.calibrationNote || '',
      ];
    });
    downloadCsv(`${hodMode ? 'hod' : 'hr'}_bell_curve_${cleanFilenamePart(groupFilter)}_${cleanFilenamePart(desigFilter)}_${cleanFilenamePart(gradeFilter)}_${cleanFilenamePart(hodFilter)}.csv`, headers, rows);
  };

  const downloadGoalDetailExport = () => {
    const headers = [
      'Employee Code', 'Employee Name', 'Designation', 'Group', 'Current Stage',
      'Goal No', 'KRA', 'Item Type', 'KPI / Item', 'Target',
      'Self Achievement', 'Manager Achievement',
      'Self Score', 'Manager Score',
      'Self Comment', 'Manager Comment',
      'Overall Self Score', 'Overall Manager Score', 'Overall Final Score',
    ];
    const rows = empRatings.flatMap((row) => {
      const goals = getEmployeeGoals(orgKey, row.code);
      const items = flattenGoalItems(goals);
      const self = row.stages?.self || {};
      const manager = row.stages?.manager || {};
      if (!items.length) {
        return [[
          row.code, row.emp['Employee Name'] || '', row.emp.Role || row.emp.Designation || '', row.emp['Group Name'] || '', row.status.label,
          '', '', '', '', '', '', '', '', '', self.overallComment || '', manager.overallComment || '',
          Number.isFinite(Number(row.selfScore)) ? Number(row.selfScore).toFixed(2) : '',
          Number.isFinite(Number(row.managerScore)) ? Number(row.managerScore).toFixed(2) : '',
          Number.isFinite(Number(row.finalScore)) ? Number(row.finalScore).toFixed(2) : '',
        ]];
      }
      return items.map((item) => [
        row.code,
        row.emp['Employee Name'] || '',
        row.emp.Role || row.emp.Designation || '',
        row.emp['Group Name'] || '',
        row.status.label,
        item.goalIndex,
        item.parentName || '',
        item.kind || '',
        item.name || '',
        targetText(item),
        stageAchievement(self, item),
        stageAchievement(manager, item),
        stageScore(self, item),
        stageScore(manager, item),
        self.itemComments?.[item.id] || self.kpiScores?.[item.id]?.comment || self.kraScores?.[item.id]?.comment || '',
        manager.itemComments?.[item.id] || manager.kpiScores?.[item.id]?.comment || manager.kraScores?.[item.id]?.comment || '',
        Number.isFinite(Number(row.selfScore)) ? Number(row.selfScore).toFixed(2) : '',
        Number.isFinite(Number(row.managerScore)) ? Number(row.managerScore).toFixed(2) : '',
        Number.isFinite(Number(row.finalScore)) ? Number(row.finalScore).toFixed(2) : '',
      ]);
    });
    downloadCsv(`hr_review_goal_detail_${cleanFilenamePart(groupFilter)}_${cleanFilenamePart(desigFilter)}.csv`, headers, rows);
  };

  const downloadAuditLog = () => {
    const headers = ['When', 'Action', 'Employee Code', 'Employee', 'By', 'Before', 'After', 'Reason'];
    const log = (ratings.auditLog || []).slice().sort((a, b) => (Date.parse(b?.ts) || 0) - (Date.parse(a?.ts) || 0));
    const rows = log.map((row) => {
      const meta = ACTION_META[row.action] || { label: row.action };
      const empName = row.empCode ? (empMap[normalizeCode(row.empCode)] || '') : '';
      return [
        formatWhen(row.ts),
        meta.label,
        row.empCode || '',
        empName,
        prettyActor(row.actor),
        row.before ?? '',
        row.after ?? '',
        row.reason || '',
      ];
    });
    downloadCsv('hr_review_activity_log.csv', headers, rows);
  };

  if (!ready) return <ShellMessage title="Loading…" message="Reading cycle data." />;
  if (!hrReviewOpen) {
    return <ShellMessage title={hodMode ? 'HOD calibration is not open' : 'HR Review is not open'} message={`Current cycle phase: ${org?.currentPhase || 'not set'}. Move the cycle to HR review before calibrating or publishing.`} />;
  }

  return (
    <div style={embedded ? { fontFamily: "'Geist','Inter','Segoe UI',Arial,sans-serif" } : { minHeight: '100vh', background: SOFT_BG, padding: '32px 16px', fontFamily: "'Geist','Inter','Segoe UI',Arial,sans-serif" }}>
      <style>{`
        @keyframes hrFilterIn {
          from { opacity: 0; transform: translateY(-5px) scale(.985); }
          to { opacity: 1; transform: translateY(0) scale(1); }
        }
        @keyframes hrRowsIn {
          from { opacity: .72; transform: translateY(3px); }
          to { opacity: 1; transform: translateY(0); }
        }
        @keyframes ratingChangedBlink {
          0% { box-shadow: 0 0 0 0 rgba(37,99,235,0); transform: scale(1); }
          35% { box-shadow: 0 0 0 5px rgba(37,99,235,.20); transform: scale(1.015); }
          100% { box-shadow: 0 8px 20px rgba(37,99,235,0.12); transform: scale(1); }
        }
      `}</style>
      <div style={embedded ? {} : { maxWidth: 1240, margin: '0 auto' }}>
        <Header
          title={hodMode ? 'My Team Calibration' : 'HR Review'}
          right={!hodMode ? (
            <div style={{ display: 'flex', gap: 8 }}>
              <button type="button" onClick={downloadEmployeeRegister} style={btnStyle('ghost', false)}>
                Download register
              </button>
              <button type="button" onClick={downloadGoalDetailExport} style={btnStyle('ghost', false)}>
                Download details
              </button>
              {!published && seededCount > 0 && (
                <button type="button" onClick={onClearSeeded}
                  style={{ padding: '8px 14px', borderRadius: 8, fontSize: 13, fontWeight: 700, border: '1.5px solid #FCA5A5', background: '#FEF2F2', color: '#B91C1C', cursor: 'pointer', fontFamily: 'inherit' }}>
                  Remove demo data ({seededCount})
                </button>
              )}
              {!published && !readyToPublish && (
                <span style={{ alignSelf: 'center', fontSize: 12.5, color: MUTED, fontWeight: 600 }}>
                  {pendingToPublish} rating{pendingToPublish === 1 ? '' : 's'} pending
                </span>
              )}
              {!published && readyToPublish && (
                <button type="button" onClick={onPublish} disabled={publishBlocked} style={btnStyle('primary', publishBlocked)}>
                  {publishBlocked ? 'Publish blocked' : 'Publish cycle'}
                </button>
              )}
              {published && (
                <>
                  <button
                    type="button"
                    onClick={onRevokePublish}
                    title="Testing only"
                    style={{
                      padding: '8px 14px',
                      borderRadius: 8,
                      fontSize: 13,
                      fontWeight: 800,
                      border: '1.5px solid #FDBA74',
                      background: '#FFF7ED',
                      color: '#C2410C',
                      cursor: 'pointer',
                      fontFamily: 'inherit',
                    }}
                  >
                    Revoke publish
                  </button>
                  <PillStatus label={`Published ${new Date(ratings.publishedAt).toLocaleDateString()}`} color="#16A34A" />
                </>
              )}
            </div>
          ) : null}
        />

        <div style={{ display: 'flex', gap: 8, margin: '8px 0 16px', flexWrap: 'wrap', alignItems: 'center' }}>
          {[
            ...(!bellEnabled ? [{ id: 'employees', label: 'Employee Register', count: completedRows.length }] : []),
            ...(bellEnabled ? [{ id: 'bell', label: 'Bell Curve', count: dist.total }] : []),
            { id: 'scores', label: 'Score Histogram', count: dist.total },
            ...(ackEnabled ? [{ id: 'acknowledgement', label: 'Acknowledgement', count: openConcernCount, alert: openConcernCount > 0 }] : []),
            ...(!hodMode ? [{ id: 'audit', label: 'Audit', count: (ratings.auditLog || []).length }] : []),
          ].map((tab) => (
            <button key={tab.id} type="button" onClick={() => setActiveTab(tab.id)}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 8, padding: '9px 14px', borderRadius: 999, border: `1.5px solid ${activeTab === tab.id ? BLUE : BORDER}`, background: activeTab === tab.id ? BLUE : '#fff', color: activeTab === tab.id ? '#fff' : '#334155', cursor: 'pointer', fontFamily: 'inherit', fontSize: 13, fontWeight: 850 }}>
              {tab.label}
              <span style={{ padding: '1px 8px', borderRadius: 999, background: tab.alert && activeTab !== tab.id ? '#DC2626' : (activeTab === tab.id ? 'rgba(255,255,255,.18)' : '#F1F5F9'), color: tab.alert && activeTab !== tab.id ? '#fff' : 'inherit', fontSize: 11, fontWeight: 850 }}>{tab.count}</span>
            </button>
          ))}
        </div>

        {activeTab === 'bell' && (
          <>
            <BellHero
              completed={completedRows.length}
              total={scopedRows.length}
              calibrated={calibratedCount}
              waitingOnSelf={waitingOnSelf}
              waitingOnManager={waitingOnManager}
              bellMode={bellMode}
              hodMode={hodMode}
              hasOutOfTolerance={hasOutOfTolerance}
              outOfTolerance={outOfTolerance}
              scale={scale}
              config={config}
            />

            <PremiumBellCard>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, marginBottom: 18 }}>
                <div>
                  <div style={{ fontSize: 20, fontWeight: 950, color: INK }}>Bell curve distribution</div>
                </div>
                <DistributionLegend />
              </div>
              <DistributionChart scale={sortedTopDown} targets={targets} tolerances={tolerances} actuals={dist.pct} counts={dist.counts} />
            </PremiumBellCard>

            <CalibrationWorkspace
              rows={completedRows}
              scale={scale}
              config={config}
              viewConfig={viewConfig}
              orgKey={orgKey}
              actor={actorDisplayName}
              published={published}
              targets={targets}
              tolerances={tolerances}
              actuals={dist.pct}
              counts={dist.counts}
              mode={hodMode ? 'hod' : 'final'}
              toolbar={(
                <BellCurveToolbar
                  search={search}
                  setSearch={setSearch}
                  activeFilters={activeFilters}
                  clearAllFilters={clearAllFilters}
                  shown={completedRows.length}
                  total={scopedRows.filter((row) => row.managerDone && row.score !== null).length}
                  groups={groups}
                  designations={designations}
                  managers={managers}
                  grades={grades}
                  hods={hods}
                  hodMode={hodMode}
                  groupFilter={groupFilter}
                  setGroupFilter={setGroupFilter}
                  desigFilter={desigFilter}
                  setDesigFilter={setDesigFilter}
                  managerFilter={managerFilter}
                  setManagerFilter={setManagerFilter}
                  gradeFilter={gradeFilter}
                  setGradeFilter={setGradeFilter}
                  hodFilter={hodFilter}
                  setHodFilter={setHodFilter}
                  gapFilter={gapFilter}
                  setGapFilter={setGapFilter}
                  onDownloadBell={downloadBellCurveExport}
                  onDownloadDetails={downloadGoalDetailExport}
                />
              )}
              activeFilters={activeFilters}
              visibleMetaColumns={visibleMetaColumns}
              onChanged={() => setTick((t) => t + 1)}
              onOpen={(code) => setSelectedCode(code)}
            />
          </>
        )}

        {activeTab === 'scores' && (
          <PremiumBellCard>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, marginBottom: 18 }}>
              <div>
                <div style={{ fontSize: 20, fontWeight: 950, color: INK }}>Score histogram</div>
                <div style={{ fontSize: 12.5, color: MUTED, marginTop: 3 }}>Compare self, manager, and {hodMode ? 'HOD' : 'final'} score spread for completed reviews.</div>
              </div>
              <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                <button type="button" onClick={() => setScoreHistogramView('combined')} style={segBtn(scoreHistogramView === 'combined')}>Combined</button>
                <button type="button" onClick={() => setScoreHistogramView('separate')} style={segBtn(scoreHistogramView === 'separate')}>Split</button>
                <button type="button" onClick={downloadEmployeeRegister} style={btnStyle('ghost', false)}>Download scores</button>
              </div>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(120px, 1fr))', gap: 10, marginBottom: 14 }}>
              <SummaryTile label="Completed" value={dist.total} sub="manager-rated employees" tone={BLUE} />
              <SummaryTile label="Self avg" value={formatAverage(avgSelf)} sub="submitted self scores" tone="#0891B2" />
              <SummaryTile label="Manager avg" value={formatAverage(avgManager)} sub="manager scores" tone={BLUE} />
              <SummaryTile label={hodMode ? 'HOD avg' : 'Final avg'} value={formatAverage(avgFinal)} sub={`${calibratedCount} calibrated`} tone={VIOLET} />
            </div>
            <ScoreSpreadChart rows={empRatings} scale={scale} config={config} view={scoreHistogramView} />
          </PremiumBellCard>
        )}

        {activeTab === 'employees' && !bellEnabled && (
          <CalibrationWorkspace
            rows={completedRows}
            scale={scale}
            config={config}
            viewConfig={viewConfig}
            orgKey={orgKey}
            actor={actorDisplayName}
            published={published}
            mode={hodMode ? 'hod' : 'final'}
            title="Employee register"
            subtitle="Every completed rating and quick calibration action in one table."
            showBandSummary={false}
            emptyMessage="No completed manager ratings match these filters."
            toolbar={(
              <BellCurveToolbar
                search={search}
                setSearch={setSearch}
                activeFilters={activeFilters}
                clearAllFilters={clearAllFilters}
                shown={completedRows.length}
                total={scopedRows.filter((row) => row.managerDone && row.score !== null).length}
                shownLabel="completed employees"
                groups={groups}
                designations={designations}
                managers={managers}
                grades={grades}
                hods={hods}
                hodMode={hodMode}
                groupFilter={groupFilter}
                setGroupFilter={setGroupFilter}
                desigFilter={desigFilter}
                setDesigFilter={setDesigFilter}
                managerFilter={managerFilter}
                setManagerFilter={setManagerFilter}
                gradeFilter={gradeFilter}
                setGradeFilter={setGradeFilter}
                hodFilter={hodFilter}
                setHodFilter={setHodFilter}
                gapFilter={gapFilter}
                setGapFilter={setGapFilter}
                onDownloadBell={downloadEmployeeRegister}
                onDownloadDetails={downloadGoalDetailExport}
                primaryExportLabel="Employee register CSV"
              />
            )}
            activeFilters={activeFilters}
            visibleMetaColumns={visibleMetaColumns}
            onChanged={() => setTick((t) => t + 1)}
            onOpen={(code) => setSelectedCode(code)}
          />
        )}

        {activeTab === 'acknowledgement' && (
          <Card>
            <CardHead>
              <div>
                <div style={{ fontSize: 16, fontWeight: 850, color: INK }}>Acknowledgement</div>
                <div style={{ fontSize: 11, color: MUTED, marginTop: 2 }}>How employees responded to their published rating.</div>
              </div>
            </CardHead>
            <CardBody>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(120px, 1fr))', gap: 10, marginBottom: 14 }}>
                <SummaryTile label="Accepted" value={ackCounts['accepted'] || 0} tone={GREEN} />
                <SummaryTile label="Concern raised" value={(ackCounts['concern-open'] || 0) + (ackCounts['concern-resolved'] || 0)} tone="#D97706" />
                <SummaryTile label="No response yet" value={ackCounts['none'] || 0} tone={MUTED} />
              </div>
              <div style={{ border: `1px solid ${BORDER}`, borderRadius: 10, overflow: 'hidden' }}>
                <div style={{ display: 'grid', gridTemplateColumns: 'minmax(180px, 1.4fr) 150px minmax(120px, 2fr) 96px', gap: 12, padding: '7px 14px', background: '#F8FAFC', fontSize: 10, fontWeight: 900, color: MUTED, textTransform: 'uppercase', letterSpacing: '.04em' }}>
                  <span>Employee</span><span>Status</span><span>Concern</span><span style={{ justifySelf: 'end' }}>Action</span>
                </div>
                {ackRows.length ? ackRows.map((row) => {
                  const st = ackStatusOf(row);
                  const a = row.stages?.acceptance || {};
                  const chip = st === 'accepted' ? { t: 'Accepted', c: '#15803D', b: '#F0FDF4' }
                    : st === 'concern-open' ? { t: 'Concern raised', c: '#B45309', b: '#FFFBEB' }
                    : st === 'concern-resolved' ? { t: 'Concern · resolved', c: '#1E40AF', b: '#EFF6FF' }
                    : { t: 'No response yet', c: '#64748B', b: '#F1F5F9' };
                  return (
                    <div key={row.code} style={{ display: 'grid', gridTemplateColumns: 'minmax(180px, 1.4fr) 150px minmax(120px, 2fr) 96px', gap: 12, padding: '7px 14px', borderTop: `1px solid ${BORDER}`, alignItems: 'center', fontSize: 12.5 }}>
                      <div style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        <span style={{ fontWeight: 800, color: INK }}>{row.emp['Employee Name'] || row.code}</span>
                        <span style={{ fontSize: 11, color: MUTED, marginLeft: 7 }}>{row.code}</span>
                      </div>
                      <span><span style={{ display: 'inline-block', padding: '2px 8px', borderRadius: 999, background: chip.b, color: chip.c, fontSize: 11, fontWeight: 850, whiteSpace: 'nowrap' }}>{chip.t}</span></span>
                      <span title={a.reason || ''} style={{ color: '#475569', fontStyle: a.reason ? 'italic' : 'normal', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.reason ? `“${a.reason}”` : '—'}</span>
                      <div style={{ justifySelf: 'end' }}>
                        {st === 'concern-open'
                          ? <button type="button" onClick={() => setResolveCode(row.code)} style={{ ...btnStyle('primary', false), padding: '5px 12px', fontSize: 12 }}>Resolve</button>
                          : <span style={{ fontSize: 11.5, color: MUTED }}>{st === 'concern-resolved' ? '✓' : '—'}</span>}
                      </div>
                    </div>
                  );
                }) : <div style={{ padding: 18, textAlign: 'center', color: MUTED, fontSize: 13 }}>No employees to acknowledge yet.</div>}
              </div>
            </CardBody>
          </Card>
        )}

        {activeTab === 'audit' && (
          <Card>
            <CardHead>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
                <div>
                  <div style={{ fontSize: 16, fontWeight: 850, color: INK }}>Activity log</div>
                  <div style={{ fontSize: 12, color: MUTED, marginTop: 2 }}>Every action in this cycle, newest first.</div>
                </div>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  <input
                    value={auditSearch}
                    onChange={(e) => setAuditSearch(e.target.value)}
                    placeholder="Search by name or code"
                    style={{ width: 240, padding: '8px 10px', border: `1px solid ${BORDER}`, borderRadius: 9, fontSize: 12.5 }}
                  />
                  <button type="button" onClick={downloadAuditLog} disabled={(ratings.auditLog || []).length === 0} style={{ ...btnStyle('ghost', (ratings.auditLog || []).length === 0), flexShrink: 0 }}>Download CSV</button>
                </div>
              </div>
            </CardHead>
            <CardBody>
              {(() => {
                const needle = auditSearch.trim().toLowerCase();
                const filtered = (ratings.auditLog || []).filter((row) => {
                  if (!needle) return true;
                  const code = String(row.empCode || '');
                  const name = empMap[normalizeCode(code)] || '';
                  return code.toLowerCase().includes(needle) || name.toLowerCase().includes(needle);
                });
                if ((ratings.auditLog || []).length === 0) return <div style={{ padding: 16, color: MUTED, fontSize: 13 }}>No activity yet.</div>;
                if (filtered.length === 0) return <div style={{ padding: 16, color: MUTED, fontSize: 13 }}>No activity for “{auditSearch.trim()}”.</div>;
                return <AuditTable rows={filtered} empMap={empMap} />;
              })()}
            </CardBody>
          </Card>
        )}

        {selectedRow && (
          <ReviewDetailModal
            key={`${selectedRow.code}:${hodMode ? 'hod' : 'final'}:${selectedRow.score ?? 'none'}`}
            row={selectedRow}
            orgKey={orgKey}
            config={config}
            viewConfig={viewConfig}
            scale={scale}
            actor={actorDisplayName}
            published={published}
            hodMode={hodMode}
            onChanged={() => setTick((t) => t + 1)}
            onClose={() => setSelectedCode('')}
          />
        )}

        {publishOpen && (
          <PublishModal
            bellMode={bellMode}
            hasOutOfTolerance={hasOutOfTolerance}
            outOfTolerance={outOfTolerance}
            reason={publishReason}
            onReason={setPublishReason}
            onConfirm={confirmPublish}
            onClose={() => setPublishOpen(false)}
            saving={publishBusy}
          />
        )}

        {resolveRow && (
          <ConcernResolveModal
            row={resolveRow}
            scale={scale}
            config={config}
            onExplain={onResolveExplain}
            onRecalibrate={onResolveRecalibrate}
            onClose={() => setResolveCode('')}
          />
        )}

        {toast && <div style={{ position: 'fixed', right: 22, bottom: 22, zIndex: 90, background: '#0F172A', color: '#fff', padding: '10px 14px', borderRadius: 10, boxShadow: '0 18px 40px rgba(15,23,42,.24)', fontSize: 12.5, fontWeight: 750 }}>{toast}</div>}
      </div>
    </div>
  );
}

function ConcernResolveModal({ row, scale, config, onExplain, onRecalibrate, onClose }) {
  const a = row.stages?.acceptance || {};
  const [mode, setMode] = useState('');
  const [message, setMessage] = useState('');
  const [rank, setRank] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const optionBtn = { textAlign: 'left', border: `1px solid ${BORDER}`, background: '#fff', borderRadius: 10, padding: '11px 13px', cursor: 'pointer', fontFamily: 'inherit', fontSize: 13, fontWeight: 850, color: INK };
  const doExplain = async () => { if (!message.trim() || busy) return; setBusy(true); await onExplain(row, message.trim()); };
  const doRecal = async () => { const s = Number(rank); if (!Number.isFinite(s) || s < 1 || busy) return; setBusy(true); await onRecalibrate(row, s, note.trim()); };
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.48)', zIndex: 14000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }} onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} style={{ width: 'min(520px, 96vw)', background: '#fff', borderRadius: 16, border: `1px solid ${BORDER}`, boxShadow: '0 24px 80px rgba(15,23,42,0.22)', overflow: 'hidden' }}>
        <div style={{ padding: '16px 20px', borderBottom: `1px solid ${BORDER}` }}>
          <div style={{ fontSize: 16, fontWeight: 900, color: INK }}>Resolve concern</div>
          <div style={{ fontSize: 12.5, color: MUTED, marginTop: 3 }}>{row.emp['Employee Name'] || row.code}</div>
        </div>
        <div style={{ padding: 20 }}>
          {a.reason && <div style={{ marginBottom: 14, padding: '10px 12px', borderRadius: 10, background: '#FFFBEB', border: '1px solid #FDE68A', fontSize: 12.5, color: '#92400E', fontStyle: 'italic' }}>“{a.reason}”</div>}
          {mode === '' && (
            <div style={{ display: 'grid', gap: 10 }}>
              <button type="button" onClick={() => setMode('explain')} style={optionBtn}>Explain &amp; close<div style={{ fontSize: 11.5, color: MUTED, fontWeight: 600, marginTop: 2 }}>Reply by email and mark resolved. No rating change.</div></button>
              <button type="button" onClick={() => setMode('recalibrate')} style={optionBtn}>Recalibrate<div style={{ fontSize: 11.5, color: MUTED, fontWeight: 600, marginTop: 2 }}>Change the rating and send it back for the employee to respond again.</div></button>
            </div>
          )}
          {mode === 'explain' && (
            <textarea value={message} onChange={(e) => setMessage(e.target.value)} rows={4} autoFocus placeholder="Message to employee"
              style={{ width: '100%', boxSizing: 'border-box', padding: 11, borderRadius: 10, border: `1px solid ${BORDER}`, fontSize: 13, fontFamily: 'inherit', resize: 'vertical' }} />
          )}
          {mode === 'recalibrate' && (
            <>
              <div style={{ fontSize: 11, fontWeight: 850, color: MUTED, textTransform: 'uppercase', marginBottom: 6 }}>New final band</div>
              <select value={rank} onChange={(e) => setRank(e.target.value)} style={{ width: '100%', padding: '9px 10px', borderRadius: 9, border: `1px solid ${BORDER}`, fontSize: 13, fontFamily: 'inherit', marginBottom: 10 }}>
                <option value="">Choose a band</option>
                {scale.slice().sort((x, y) => y.n - x.n).map((lvl) => <option key={lvl.n} value={lvl.n}>{rankAxisLabel(lvl, config)}</option>)}
              </select>
              <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Reason for recalibration (optional)"
                style={{ width: '100%', boxSizing: 'border-box', padding: '9px 10px', borderRadius: 9, border: `1px solid ${BORDER}`, fontSize: 13, fontFamily: 'inherit' }} />
            </>
          )}
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, padding: '12px 20px', borderTop: `1px solid ${BORDER}`, background: '#F8FAFC' }}>
          {mode !== '' && <button type="button" onClick={() => setMode('')} style={btnStyle('ghost', false)}>Back</button>}
          <button type="button" onClick={onClose} style={btnStyle('ghost', false)}>Cancel</button>
          {mode === 'explain' && <button type="button" onClick={doExplain} disabled={busy || !message.trim()} style={btnStyle('primary', busy || !message.trim())}>Send &amp; close</button>}
          {mode === 'recalibrate' && <button type="button" onClick={doRecal} disabled={busy || !rank} style={btnStyle('primary', busy || !rank)}>Recalibrate &amp; resend</button>}
        </div>
      </div>
    </div>
  );
}

function PublishModal({ bellMode, hasOutOfTolerance, outOfTolerance, reason, onReason, onConfirm, onClose, saving = false }) {
  const needsReason = bellMode === 'soft' && hasOutOfTolerance;
  const canConfirm = !saving && (!needsReason || reason.trim().length > 0);
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.48)', zIndex: 14000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}
      onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} style={{ width: 'min(480px, 96vw)', background: '#fff', borderRadius: 16, border: `1px solid ${BORDER}`, boxShadow: '0 24px 80px rgba(15,23,42,0.22)', overflow: 'hidden' }}>
        <div style={{ padding: '18px 20px 14px' }}>
          <div style={{ fontSize: 17, fontWeight: 900, color: INK }}>Publish final ratings</div>
          <div style={{ fontSize: 12.5, color: MUTED, marginTop: 4, lineHeight: 1.5 }}>
            This releases results to employees and cannot be undone.
          </div>
          {needsReason && (
            <div style={{ marginTop: 14 }}>
              <div style={{ fontSize: 12.5, color: '#92400E', fontWeight: 700, lineHeight: 1.5, marginBottom: 8 }}>
                {outOfTolerance.length} rating band{outOfTolerance.length === 1 ? '' : 's'} differ from the configured bell curve range. Add a reason to publish anyway.
              </div>
              <textarea
                value={reason}
                onChange={(e) => onReason(e.target.value)}
                autoFocus
                rows={3}
                placeholder="Reason for publishing despite bell curve variance"
                style={{ width: '100%', boxSizing: 'border-box', padding: 11, borderRadius: 10, border: `1px solid ${BORDER}`, fontSize: 13, fontFamily: 'inherit', resize: 'vertical', outlineColor: BLUE }}
              />
            </div>
          )}
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, padding: '12px 20px', borderTop: `1px solid ${BORDER}`, background: '#F8FAFC' }}>
          <button type="button" onClick={onClose} disabled={saving} style={btnStyle('ghost', saving)}>Cancel</button>
          <button type="button" onClick={onConfirm} disabled={!canConfirm} style={btnStyle('primary', !canConfirm)}>{saving ? 'Publishing...' : 'Publish cycle'}</button>
        </div>
      </div>
    </div>
  );
}

function BellHero({ completed, total, calibrated, waitingOnSelf, waitingOnManager, bellMode, hodMode = false }) {
  const completion = total ? Math.round((completed / total) * 100) : 0;
  return (
    <div style={{
      position: 'relative', overflow: 'hidden', borderRadius: 12, padding: '10px 16px', marginBottom: 14,
      background: 'linear-gradient(135deg, #1D4ED8 0%, #7C3AED 100%)',
      color: '#fff', boxShadow: '0 10px 28px rgba(37,99,235,.18)',
      display: 'flex', alignItems: 'center', gap: 18, flexWrap: 'wrap',
    }}>
      <div style={{ display: 'inline-flex', flexDirection: 'column', gap: 2, whiteSpace: 'nowrap' }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7, fontSize: 11, fontWeight: 850, textTransform: 'uppercase', letterSpacing: '.05em' }}>
          <span style={{ width: 7, height: 7, borderRadius: '50%', background: 'rgba(255,255,255,.9)', flexShrink: 0 }} />
          Bell curve
        </span>
        <span style={{ fontSize: 10, fontWeight: 700, color: 'rgba(255,255,255,.72)', paddingLeft: 14 }}>
          ({bellMode === 'hard' ? 'Enforced' : 'Advisory'})
        </span>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 0, flex: 1, minWidth: 360, flexWrap: 'wrap' }}>
        <HeroMetric label="Completed" value={`${completed}/${total}`} sub={`${completion}%`} />
        <HeroMetric label="Calibrated" value={calibrated} sub={hodMode ? 'HOD moves' : 'HR moves'} />
        <HeroMetric label="Awaiting self" value={waitingOnSelf} sub="employee" />
        <HeroMetric label="Awaiting mgr" value={waitingOnManager} sub="register" last />
      </div>
    </div>
  );
}

function SummaryTile({ label, value, sub, tone }) {
  return (
    <div style={{ background: '#fff', border: `1px solid ${BORDER}`, borderRadius: 12, padding: '11px 12px', minWidth: 0 }}>
      <div style={{ fontSize: 10.5, fontWeight: 900, color: MUTED, textTransform: 'uppercase', letterSpacing: '.04em' }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 950, color: tone || INK, marginTop: 5, lineHeight: 1 }}>{value}</div>
      <div style={{ fontSize: 11.5, color: MUTED, marginTop: 5, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{sub}</div>
    </div>
  );
}

function HeroMetric({ label, value, sub, last }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'baseline', gap: 8, flex: 1, minWidth: 120,
      padding: '2px 16px',
      borderRight: last ? 'none' : '1px solid rgba(255,255,255,.18)',
    }}>
      <div style={{ fontSize: 22, fontWeight: 900, lineHeight: 1, letterSpacing: '-.01em' }}>{value}</div>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 10.5, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '.04em', color: 'rgba(255,255,255,.82)', whiteSpace: 'nowrap' }}>{label}</div>
        <div style={{ fontSize: 10, color: 'rgba(255,255,255,.62)', whiteSpace: 'nowrap' }}>{sub}</div>
      </div>
    </div>
  );
}

function PremiumBellCard({ children }) {
  return (
    <div style={{
      position: 'relative', background: '#fff', border: '1px solid #D9E2EC', borderRadius: 18, marginBottom: 16,
      padding: 20, overflow: 'hidden', boxShadow: '0 18px 60px rgba(15,23,42,.08)',
    }}>
      <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(180deg, rgba(37,99,235,.06), transparent 42%)', pointerEvents: 'none' }} />
      <div style={{ position: 'relative' }}>{children}</div>
    </div>
  );
}

const ACTION_META = {
  'submit-self': { label: 'Submitted self-evaluation', color: '#0891B2' },
  'submit-manager': { label: 'Submitted manager rating', color: '#2563EB' },
  'submit-final': { label: 'Submitted final rating', color: '#7C3AED' },
  'request-completion': { label: 'Asked to complete', color: '#D97706' },
  'calibrate': { label: 'Changed final rating', color: '#7C3AED' },
  'hod-calibrate': { label: 'HOD calibrated', color: '#0891B2' },
  'publish': { label: 'Published the cycle', color: '#16A34A' },
  'revoke-publish': { label: 'Revoked publish', color: '#C2410C' },
};

function prettyActor(actor) {
  if (!actor) return '';
  // Collapse "HR (1025 as 1025)" → "HR · 1025"; "HR (3000 as 1025)" → "HR · 3000 (for 1025)"
  const m = String(actor).match(/^(.*?)\s*\((\w+)\s+as\s+(\w+)\)\s*$/);
  if (!m) return actor;
  const [, name, a, b] = m;
  const who = a === b ? a : `${a} (for ${b})`;
  return name.trim() ? `${name.trim()} · ${who}` : who;
}

function formatWhen(ts) {
  const d = new Date(ts);
  return d.toLocaleDateString(undefined, { day: '2-digit', month: 'short' }) + ', ' +
    d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

// Human day bucket for grouping the activity log: Today / Yesterday / dated.
function dayLabel(ts) {
  const d = new Date(ts);
  const now = new Date();
  const startOf = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((startOf(now) - startOf(d)) / 86400000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  return d.toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' });
}

function timeOnly(ts) {
  return new Date(ts).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

function AuditTable({ rows, empMap = {} }) {
  const sorted = rows.slice().sort((a, b) => (Date.parse(b?.ts) || 0) - (Date.parse(a?.ts) || 0));
  return (
    <div style={{ border: `1px solid ${BORDER}`, borderRadius: 10, overflowX: 'auto' }}>
      <div style={{ minWidth: 920 }}>
        <div style={{ display: 'grid', gridTemplateColumns: '130px 1.35fr 1.35fr 1.2fr 1fr 1.4fr', gap: 12, padding: '9px 12px', background: '#F8FAFC', fontSize: 11, fontWeight: 900, color: MUTED, textTransform: 'uppercase' }}>
          <span>When</span><span>Activity</span><span>Employee</span><span>By</span><span>Change</span><span>Reason</span>
        </div>
        {sorted.map((row, i) => {
          const meta = ACTION_META[row.action] || { label: row.action, color: '#64748B' };
          const empName = row.empCode ? (empMap[normalizeCode(row.empCode)] || '') : '';
          const changed = row.before !== undefined && row.after !== undefined;
          return (
            <div key={`${row.ts}-${row.action}-${i}`} style={{ display: 'grid', gridTemplateColumns: '130px 1.35fr 1.35fr 1.2fr 1fr 1.4fr', gap: 12, padding: '11px 12px', borderTop: `1px solid ${BORDER}`, alignItems: 'start', fontSize: 12.5 }}>
              <div>
                <div style={{ fontWeight: 850, color: INK }}>{dayLabel(row.ts)}</div>
                <div style={{ fontSize: 11.5, color: MUTED, marginTop: 2 }}>{timeOnly(row.ts)}</div>
              </div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', minWidth: 0 }}>
                <span style={{ width: 8, height: 8, borderRadius: 999, background: meta.color, flexShrink: 0 }} />
                <span style={{ fontWeight: 850, color: INK, minWidth: 0 }}>{meta.label}</span>
              </div>
              <div>
                <div style={{ fontWeight: 800, color: INK }}>{empName || row.empCode || 'Cycle'}</div>
                {row.empCode && <div style={{ fontSize: 11.5, color: MUTED, marginTop: 2 }}>{row.empCode}</div>}
              </div>
              <div style={{ color: '#475569', fontWeight: 650 }}>{prettyActor(row.actor) || '—'}</div>
              <div style={{ color: changed ? VIOLET : MUTED, fontWeight: changed ? 850 : 650 }}>{changed ? `${row.before} → ${row.after}` : '—'}</div>
              <div style={{ color: row.reason ? '#475569' : '#CBD5E1', lineHeight: 1.35 }}>{row.reason || '—'}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// Compact "curve line over bars": thin actual bars, a faint target band behind,
// and a smooth line through the actual %s. Crisp 1:1 SVG (real pixel width via
// ResizeObserver — no aspect-ratio distortion).
function DistributionChart({ scale, targets, tolerances, actuals, counts = [] }) {
  const ref = useRef(null);
  const [w, setW] = useState(900);
  useEffect(() => {
    if (!ref.current || typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) setW(Math.max(320, e.contentRect.width));
    });
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);

  const pts = scale; // already ordered top-down (5 → 1)
  const n = pts.length;
  const H = 172;
  const padX = Math.max(40, w / (n * 2.2));
  const padTop = 30;
  const padBottom = 50;
  const plotW = Math.max(1, w - padX * 2);
  const plotH = H - padTop - padBottom;
  const baseY = padTop + plotH;
  const max = Math.max(...targets, ...actuals, 1);
  const di = (lvl) => Math.max(0, Number(lvl.n) - 1);
  const X = (i) => padX + (n === 1 ? plotW / 2 : (plotW * i) / (n - 1));
  const Y = (v) => padTop + plotH - (Math.max(0, v) / max) * plotH;
  const barW = Math.max(10, Math.min(34, (plotW / Math.max(1, n)) * 0.34));

  const actualPts = pts.map((lvl, i) => [X(i), Y(actuals[di(lvl)] || 0)]);
  const targetPts = pts.map((lvl, i) => [X(i), Y(targets[di(lvl)] || 0)]);
  const targetArea = `${splinePath(targetPts)} L ${X(n - 1)} ${baseY} L ${X(0)} ${baseY} Z`;

  return (
    <div ref={ref} style={{ width: '100%' }}>
      <svg width={w} height={H} viewBox={`0 0 ${w} ${H}`} style={{ display: 'block', overflow: 'visible' }}>
        <line x1={padX - 6} y1={baseY} x2={w - padX + 6} y2={baseY} stroke="#E2E8F0" strokeWidth="1" />
        {/* target band + dashed target line */}
        <path d={targetArea} fill="rgba(37,99,235,0.06)" />
        <path d={splinePath(targetPts)} fill="none" stroke="rgba(37,99,235,0.45)" strokeWidth="2" strokeDasharray="6 5" />
        {/* thin actual bars */}
        {pts.map((lvl, i) => {
          const a = actuals[di(lvl)] || 0;
          const inRange = Math.abs(a - (targets[di(lvl)] || 0)) <= (tolerances[di(lvl)] || 0);
          return <rect key={`bar${lvl.n}`} x={X(i) - barW / 2} y={Y(a)} width={barW} height={Math.max(0, baseY - Y(a))} rx="4" fill={inRange ? GREEN : RED} opacity="0.15" />;
        })}
        {/* actual smooth line */}
        <path d={splinePath(actualPts)} fill="none" stroke={BLUE} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
        {/* dots, % labels, axis labels */}
        {pts.map((lvl, i) => {
          const a = actuals[di(lvl)] || 0;
          const tgt = targets[di(lvl)] || 0;
          const inRange = Math.abs(a - tgt) <= (tolerances[di(lvl)] || 0);
          const col = inRange ? GREEN : RED;
          const [px, py] = actualPts[i];
          return (
            <g key={`pt${lvl.n}`}>
              <circle cx={px} cy={py} r="4.5" fill="#fff" stroke={col} strokeWidth="2.5" />
              <text x={px} y={py - 11} textAnchor="middle" fontSize="13" fontWeight="800" fill={col}>{a}%<tspan fill="#94A3B8" fontWeight="700"> ({counts[di(lvl)] || 0})</tspan></text>
              <text x={px} y={baseY + 22} textAnchor="middle" fontSize="12.5" fontWeight="900" fill="#475569">{lvl.n}</text>
              <text x={px} y={baseY + 38} textAnchor="middle" fontSize="10.5" fontWeight="700" fill="#64748B">{lvl.l || `Rank ${lvl.n}`}</text>
              <text x={px} y={baseY + 53} textAnchor="middle" fontSize="10.5" fontWeight="600" fill="#94A3B8">Target {tgt}%</text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

// Bell-curve legend — lives in the card header so it doesn't crowd the axis.
function DistributionLegend() {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 14, fontSize: 11, fontWeight: 700, color: MUTED, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><span style={{ width: 18, height: 0, borderTop: `2.5px solid ${BLUE}` }} />Actual</span>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><span style={{ width: 18, height: 0, borderTop: '2px dashed rgba(37,99,235,.55)' }} />Target</span>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><span style={{ width: 10, height: 10, borderRadius: '50%', background: GREEN }} />In tolerance</span>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><span style={{ width: 10, height: 10, borderRadius: '50%', background: RED }} />Off target</span>
    </div>
  );
}

const SCORE_HISTOGRAM_SERIES = [
  { id: 'self', label: 'Self rating', color: '#0891B2', value: (row) => row.selfDone ? row.selfScore : null },
  { id: 'manager', label: 'Manager rating', color: '#2563EB', value: (row) => row.managerDone ? row.managerScore : null },
  { id: 'hod', label: 'HOD', color: '#0EA5E9', value: (row) => row.managerDone ? row.hodScore : null },
  { id: 'calibrated', label: 'Calibrated', color: '#EA580C', value: (row) => row.stages?.final?.calibratedScore },
];

// Finer (0.25-wide) buckets so the distribution reads as a real shape even with
// hundreds of employees. Each bucket carries one count per series for Recharts.
// Out-of-range / placeholder values (<1) are ignored, not clamped.
function buildScoreHistogram(rows, series, maxRank, step = 0.25) {
  const r2 = (x) => Math.round(x * 100) / 100;
  const buckets = [];
  for (let lo = 1; lo < maxRank - 1e-9; lo = r2(lo + step)) {
    const hi = r2(Math.min(maxRank, lo + step));
    const bucket = { lo: r2(lo), hi, mid: r2((r2(lo) + hi) / 2) };
    series.forEach((s) => { bucket[s.id] = 0; });
    buckets.push(bucket);
  }
  const stats = Object.fromEntries(series.map((s) => [s.id, { scored: 0, sum: 0, avg: null }]));
  rows.forEach((row) => {
    series.forEach((s) => {
      const score = Number(s.value(row));
      if (!Number.isFinite(score) || score < 1 - 1e-9 || score > maxRank + 1e-9) return;
      stats[s.id].scored += 1;
      stats[s.id].sum += score;
      let idx = Math.floor((score - 1) / step + 1e-9);
      if (idx >= buckets.length) idx = buckets.length - 1;
      if (idx < 0) idx = 0;
      buckets[idx][s.id] += 1;
    });
  });
  series.forEach((s) => {
    const st = stats[s.id];
    st.avg = st.scored ? r2(st.sum / st.scored) : null;
  });
  return { buckets, stats, step };
}

// Band regions (1..maxRank) so the histogram can shade by rating band — keeping
// it consistent with the labels used in the table and bell curve. Cool tones
// only (no red/green, which are reserved for validation states).
function buildBandRegions(scale, config) {
  const ranges = getMergedRankRanges(scale, config?.scaleRankRanges || {});
  const tones = {
    1: '#F1F5F9', 2: '#EFF6FF', 3: '#EEF2FF', 4: '#F5F3FF', 5: '#FAF5FF',
  };
  return ranges.map((r) => {
    const lvl = scale.find((s) => Number(s.n) === Number(r.n));
    return { n: r.n, from: r.from, to: r.to, label: (lvl?.l || `Rank ${r.n}`), tint: tones[Number(r.n)] || '#F1F5F9' };
  });
}

function ScoreSpreadChart({ rows, scale, config, view = 'separate' }) {
  const maxRank = scale.length || 5;
  const bands = buildBandRegions(scale, config);
  if (view === 'separate') {
    return (
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 12 }}>
        {SCORE_HISTOGRAM_SERIES.map((series) => (
          <div key={series.id} style={{ border: `1px solid ${BORDER}`, borderRadius: 10, padding: 12, background: '#fff' }}>
            <ScoreHistogramPanel rows={rows} maxRank={maxRank} bands={bands} series={[series]} title={series.label} height={140} showBandLabels={false} />
          </div>
        ))}
      </div>
    );
  }
  return (
    <div style={{ border: `1px solid ${BORDER}`, borderRadius: 12, background: '#fff', padding: 14 }}>
      <ScoreHistogramPanel rows={rows} maxRank={maxRank} bands={bands} series={SCORE_HISTOGRAM_SERIES.filter((s) => s.id !== 'calibrated')} title="Self vs manager vs final" height={240} />
    </div>
  );
}

function rankBadgeStyle(active = false) {
  return {
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    minWidth: 24, height: 24, padding: '0 7px', borderRadius: 7,
    background: active ? '#EFF6FF' : '#F1F5F9',
    color: active ? BLUE : '#64748B', fontSize: 12.5, fontWeight: 900,
  };
}

function bandSummaryStyle(active) {
  return {
    border: `1.5px solid ${active ? BLUE : BORDER}`,
    background: active ? '#EFF6FF' : '#fff',
    borderRadius: 10,
    padding: '10px 11px',
    textAlign: 'left',
    cursor: 'pointer',
    fontFamily: 'inherit',
    minWidth: 0,
  };
}

function calibrationPayload(stage = {}, score, reason, actor) {
  const ts = new Date().toISOString();
  return {
    ...(stage || {}),
    calibratedScore: score,
    calibrationNote: reason || '',
    calibratedBy: actor || '',
    calibratedAt: ts,
    updatedAt: ts,
  };
}

async function saveCalibrationStage(orgKey, code, stageName, stage, score, reason, actor) {
  return submitEmployeeStageAndPersist(
    orgKey,
    code,
    stageName,
    calibrationPayload(stage, score, reason, actor),
    actor,
    // Optimistic + fallback: apply locally instantly and sync in the background,
    // so calibration (incl. resolving a concern by recalibrating) never hangs on
    // a slow/unreachable server.
    { allowFallback: true, optimistic: true },
  );
}

function CalibrationWorkspace({
  rows,
  scale,
  config,
  viewConfig,
  orgKey,
  actor,
  published,
  targets = [],
  tolerances = [],
  actuals = [],
  counts = [],
  mode = 'final',
  toolbar = null,
  activeFilters = [],
  visibleMetaColumns = [],
  title,
  subtitle,
  showBandSummary = true,
  emptyMessage = 'No completed manager ratings in this band.',
  onChanged,
  onOpen,
}) {
  const [bandFilter, setBandFilter] = useState('all');
  const [selected, setSelected] = useState(new Set());
  const [bulkRank, setBulkRank] = useState('');
  const [bulkReason, setBulkReason] = useState('');
  const sortedTopDown = scale.slice().sort((a, b) => b.n - a.n);
  const hasGradeRows = rows.some((row) => String(row.emp.Grade || '').trim());
  const filteredRows = rows
    .filter((row) => bandFilter === 'all' || rankForScore(row.score, scale, config)?.n === Number(bandFilter))
    .sort((a, b) => {
      if (hasGradeRows) {
        const gradeOrder = compareRowsByGradeThenName(a, b);
        if (gradeOrder !== 0) return gradeOrder;
      }
      const ar = rankForScore(a.score, scale, config)?.n || 0;
      const br = rankForScore(b.score, scale, config)?.n || 0;
      if (br !== ar) return br - ar;
      return String(a.emp['Employee Name'] || a.code).localeCompare(String(b.emp['Employee Name'] || b.code));
    });
  const visibleCodes = filteredRows.map((row) => row.code);
  const allVisibleSelected = visibleCodes.length > 0 && visibleCodes.every((code) => selected.has(code));
  const selectedRows = rows.filter((row) => selected.has(row.code));
  const canBulk = !published && selectedRows.length > 0 && bulkRank && selectedRows.every((row) => !(mode === 'hod' && row.stages?.final?.calibratedScore !== undefined));

  const toggleSelected = (code) => setSelected((prev) => {
    const next = new Set(prev);
    if (next.has(code)) next.delete(code);
    else next.add(code);
    return next;
  });
  const toggleAllVisible = () => setSelected((prev) => {
    const next = new Set(prev);
    if (allVisibleSelected) visibleCodes.forEach((code) => next.delete(code));
    else visibleCodes.forEach((code) => next.add(code));
    return next;
  });
  const applyBulk = async () => {
    if (!canBulk) return;
    const nextScore = Number(bulkRank);
    const results = await Promise.all(selectedRows.map((row) => {
      const before = Number.isFinite(Number(row.finalScore)) ? round2(row.finalScore) : nextScore;
      void before;
      const stageName = mode === 'hod' ? 'hod' : 'final';
      const stage = mode === 'hod' ? row.stages?.hod : row.stages?.final;
      return saveCalibrationStage(orgKey, row.code, stageName, stage, nextScore, bulkReason.trim(), actor);
    }));
    const failed = results.filter((result) => !result?.ok);
    if (failed.length) {
      window.alert(`Could not save ${failed.length} calibration move${failed.length === 1 ? '' : 's'}. Please retry.`);
      return;
    }
    setSelected(new Set());
    setBulkRank('');
    setBulkReason('');
    onChanged();
  };

  return (
    <Card>
      <CardHead>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 14, alignItems: 'center' }}>
          <div>
            <div style={{ fontSize: 16, fontWeight: 900, color: INK }}>{title || (mode === 'hod' ? 'My team calibration' : 'Calibration workspace')}</div>
            <div style={{ fontSize: 11, color: MUTED, marginTop: 2 }}>{subtitle || 'Adjust final bands fast — open detail only when needed.'}</div>
          </div>
          {toolbar}
        </div>
        {activeFilters.length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, justifyContent: 'flex-end', marginTop: 12 }}>
            {activeFilters.map((filter) => (
              <button key={filter.key} type="button" onClick={filter.clear} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, border: '1px solid #BFDBFE', background: '#EFF6FF', color: '#1D4ED8', borderRadius: 999, padding: '4px 8px 4px 10px', fontSize: 11.5, fontWeight: 850, cursor: 'pointer', fontFamily: 'inherit' }}>
                {filter.label}
                <span style={{ fontSize: 14, lineHeight: 1 }}>×</span>
              </button>
            ))}
          </div>
        )}
      </CardHead>
      <CardBody>
        {showBandSummary && (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 8, margin: '8px 0 12px' }}>
            <button type="button" onClick={() => setBandFilter('all')} style={bandSummaryStyle(bandFilter === 'all')}>
              <span style={{ fontSize: 11, fontWeight: 900, color: MUTED, textTransform: 'uppercase' }}>All bands</span>
              <strong style={{ display: 'block', fontSize: 18, color: INK, marginTop: 6 }}>{rows.length}</strong>
            </button>
            {sortedTopDown.map((lvl) => {
              const idx = Number(lvl.n) - 1;
              const active = bandFilter === String(lvl.n);
              const diff = (actuals[idx] || 0) - (targets[idx] || 0);
              const varianceColor = varianceTone(diff, tolerances[idx] || 0);
              const targetCount = Math.round(((targets[idx] || 0) / 100) * rows.length);
              const peopleDiff = (counts[idx] || 0) - targetCount;
              return (
                <button key={lvl.n} type="button" onClick={() => setBandFilter(String(lvl.n))} style={bandSummaryStyle(active)}>
                  <span style={{ display: 'flex', alignItems: 'center', gap: 7, minWidth: 0 }}>
                    <span style={rankBadgeStyle(active)}>{lvl.n}</span>
                    <span style={{ fontSize: 12.5, fontWeight: 900, color: INK, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{lvl.l || `Rank ${lvl.n}`}</span>
                  </span>
                  <span style={{ display: 'flex', justifyContent: 'space-between', gap: 8, marginTop: 8, fontSize: 11.5, fontWeight: 800, color: MUTED }}>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                      {counts[idx] || 0} people
                      {peopleDiff !== 0 && (
                        <span style={{ color: varianceColor, fontWeight: 900 }} title={`${Math.abs(peopleDiff)} ${peopleDiff > 0 ? 'over' : 'under'} target (${targetCount})`}>
                          {peopleDiff > 0 ? '▲' : '▼'}{Math.abs(peopleDiff)}
                        </span>
                      )}
                    </span>
                    <span style={{ color: varianceColor }}>{actuals[idx] || 0}% / {targets[idx] || 0}%</span>
                  </span>
                </button>
              );
            })}
          </div>
        )}
        {selectedRows.length > 0 && (
          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(150px, 1fr) 190px minmax(220px, 1.2fr) auto', gap: 8, alignItems: 'center', padding: 10, border: `1px solid ${BORDER}`, borderRadius: 10, background: '#F8FAFC', marginBottom: 10 }}>
            <div style={{ fontSize: 12.5, fontWeight: 850, color: INK }}>{selectedRows.length} selected</div>
            <select value={bulkRank} onChange={(e) => setBulkRank(e.target.value)} disabled={published} style={{ ...filterSelectStyle, maxWidth: 'none', width: '100%' }}>
              <option value="">Move to band</option>
              {sortedTopDown.map((lvl) => <option key={lvl.n} value={lvl.n}>{rankAxisLabel(lvl, config)}</option>)}
            </select>
            <input value={bulkReason} onChange={(e) => setBulkReason(e.target.value)} disabled={published} placeholder="Reason (optional)" style={{ padding: '8px 10px', border: `1px solid ${BORDER}`, borderRadius: 8, fontSize: 12.5, fontFamily: 'inherit' }} />
            <button type="button" onClick={applyBulk} disabled={!canBulk} style={btnStyle('primary', !canBulk)}>Apply</button>
          </div>
        )}
        <div style={{ border: `1px solid ${BORDER}`, borderRadius: 10, overflowX: 'auto' }}>
          <div style={{ width: 'max-content', minWidth: '100%' }}>
            <div style={{ display: 'grid', gridTemplateColumns: CALIBRATION_GRID, gap: 8, padding: '8px 10px', background: '#F8FAFC', fontSize: 10.5, fontWeight: 900, color: MUTED, textTransform: 'uppercase', alignItems: 'center' }}>
              <input type="checkbox" checked={allVisibleSelected} onChange={toggleAllVisible} aria-label="Select all visible employees" />
              <span>Employee</span><span style={{ textAlign: 'center' }}>Self</span><span style={{ textAlign: 'center' }}>Manager</span><span style={{ textAlign: 'center' }}>{mode === 'hod' ? 'HOD' : 'Final'}</span><span style={{ textAlign: 'center' }}>Gap</span><span style={{ textAlign: 'center' }}>Calibrate</span><span style={{ textAlign: 'center' }}>Note</span><span style={{ justifySelf: 'end' }}>Actions</span>
            </div>
            {filteredRows.length ? filteredRows.map((row) => (
              <CalibrationTableRow key={`${row.code}:${mode}:${rankForScore(row.score, scale, config)?.n || 'none'}`} row={row} selected={selected.has(row.code)} onSelect={() => toggleSelected(row.code)}
                scale={scale} config={config} viewConfig={viewConfig} orgKey={orgKey} actor={actor} published={published}
                mode={mode} metaColumns={visibleMetaColumns} onChanged={onChanged} onOpen={onOpen} />
            )) : (
              <div style={{ padding: 18, textAlign: 'center', fontSize: 13, color: MUTED }}>{emptyMessage}</div>
            )}
          </div>
        </div>
      </CardBody>
    </Card>
  );
}

function CalibrationTableRow({ row, selected, onSelect, scale, config, viewConfig, orgKey, actor, published, mode = 'final', metaColumns = [], onChanged, onOpen }) {
  const currentRank = rankForScore(row.score, scale, config);
  const [targetRank, setTargetRank] = useState(String(currentRank?.n || ''));
  const [quickDirty, setQuickDirty] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [noteDraft, setNoteDraft] = useState('');
  const [noteSaving, setNoteSaving] = useState(false);
  const menuRef = useRef(null);
  const menuBtnRef = useRef(null);
  const targetScore = targetRank ? Number(targetRank) : null;
  const currentRankValue = currentRank?.n ? Number(currentRank.n) : null;
  const targetRankValue = targetRank ? Number(targetRank) : null;
  const changed = Number.isFinite(targetRankValue) && Number.isFinite(currentRankValue) && targetRankValue !== currentRankValue;
  const hrLockedForHod = mode === 'hod' && row.stages?.final?.calibratedScore !== undefined;
  const canSave = !published && !hrLockedForHod && changed && !noteSaving;
  const gap = scoreDelta(row.selfScore, row.managerScore);
  const stage = mode === 'hod' ? row.stages?.hod : row.stages?.final;
  const calibrated = stage?.calibratedScore !== undefined && stage?.calibratedScore !== null;
  const savedNote = String(stage?.calibrationNote || '').trim();
  const hasReason = calibrated && !!savedNote;
  useEffect(() => {
    if (!menuOpen) return undefined;
    const onDown = (event) => {
      if (menuRef.current?.contains(event.target) || menuBtnRef.current?.contains(event.target)) return;
      setMenuOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [menuOpen]);
  const metaValue = (column) => {
    if (column.key === 'grade') return row.emp.Grade || 'Ungraded';
    if (column.key === 'group') return row.emp['Group Name'] || '—';
    if (column.key === 'role') return row.emp.Role || row.emp.Designation || '—';
    if (column.key === 'hod') return row.hodName || row.emp['HOD Code'] || 'No HOD';
    if (column.key === 'manager') return row.managerName || row.emp['Reporting Manager Code'] || 'No manager';
    if (column.key === 'gap') return scoreDelta(row.selfScore, row.managerScore);
    return '—';
  };
  const subtitleParts = [
    row.code,
    ...(metaColumns || []).map((column) => {
      const value = metaValue(column);
      return value && value !== '—' ? `${column.label}: ${value}` : '';
    }).filter(Boolean),
  ];

  const cancelDraft = () => {
    setTargetRank(String(currentRank?.n || ''));
    setNoteDraft(savedNote);
    setQuickDirty(false);
  };
  const selectQuickRank = (value) => {
    const nextScore = Number(value);
    setTargetRank(String(value || ''));
    const isDirty = Number.isFinite(nextScore) && Number.isFinite(currentRankValue) && Number(nextScore) !== currentRankValue;
    if (isDirty && !quickDirty) setNoteDraft(savedNote);
    setQuickDirty(isDirty);
  };
  const saveQuickCalibration = async () => {
    if (!canSave) return;
    setNoteSaving(true);
    const stageName = mode === 'hod' ? 'hod' : 'final';
    const result = await saveCalibrationStage(orgKey, row.code, stageName, stage, targetScore, noteDraft.trim(), actor);
    setNoteSaving(false);
    if (!result?.ok) {
      window.alert(result?.error || 'Could not save calibration. Please retry.');
      return;
    }
    setQuickDirty(false);
    onChanged();
  };

  return (
    <div style={{ display: 'grid', gridTemplateColumns: CALIBRATION_GRID, gap: 8, padding: '9px 10px', borderTop: `1px solid ${BORDER}`, alignItems: 'center', fontSize: 12 }}>
      <input type="checkbox" checked={selected} onChange={onSelect} aria-label={`Select ${row.emp['Employee Name'] || row.code}`} />
      <button type="button" onClick={() => onOpen(row.code)} style={{ textAlign: 'left', border: 0, background: 'transparent', padding: 0, cursor: 'pointer', fontFamily: 'inherit', minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
          <span style={{ fontWeight: 900, color: INK, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{row.emp['Employee Name'] || row.code}</span>
          {calibrated && <span style={{ fontSize: 10.5, fontWeight: 900, color: mode === 'hod' ? '#0369A1' : VIOLET, background: mode === 'hod' ? '#F0F9FF' : '#F5F3FF', borderRadius: 999, padding: '1px 6px' }}>Calibrated</span>}
        </div>
        <div title={subtitleParts.join(' · ')} style={{ color: MUTED, fontSize: 11.5, marginTop: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{subtitleParts.join(' · ')}</div>
      </button>
      <ScoreCell score={row.selfScore} scale={scale} config={viewConfig} />
      <ScoreCell score={row.managerScore} scale={scale} config={viewConfig} strong />
      <ScoreCell score={row.score} scale={scale} config={viewConfig} strong accent={calibrated ? (mode === 'hod' ? '#0891B2' : VIOLET) : INK} />
      <span style={{ textAlign: 'center', fontWeight: 850, color: gapToneFromValues(row.selfScore, row.managerScore) }}>{gap}</span>
      <div style={{ minWidth: 0 }}>
        <select
          value={targetRank || String(currentRank?.n || '')}
          onChange={(e) => selectQuickRank(e.target.value)}
          disabled={published || hrLockedForHod}
          title={hrLockedForHod ? 'HR final is already set for this employee.' : 'Choose a band, then save'}
          style={{
            width: '100%',
            minWidth: 0,
            padding: '7px 8px',
            borderRadius: 9,
            border: `1px solid ${quickDirty ? BLUE : (calibrated ? '#C4B5FD' : BORDER)}`,
            background: published || hrLockedForHod ? '#F8FAFC' : (quickDirty ? '#EFF6FF' : (calibrated ? '#F5F3FF' : '#fff')),
            color: published || hrLockedForHod ? '#94A3B8' : (quickDirty ? BLUE : (calibrated ? VIOLET : INK)),
            fontSize: 12,
            fontWeight: 850,
            fontFamily: 'inherit',
            cursor: published || hrLockedForHod ? 'not-allowed' : 'pointer',
          }}
        >
          {scale.slice().sort((a, b) => b.n - a.n).map((lvl) => <option key={lvl.n} value={lvl.n}>{rankAxisLabel(lvl, config)}</option>)}
        </select>
      </div>
      <div style={{ minWidth: 0, display: 'flex', justifyContent: 'center' }}>
        {quickDirty ? (
          <input
            value={noteDraft}
            onChange={(event) => setNoteDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') saveQuickCalibration();
              if (event.key === 'Escape') cancelDraft();
            }}
            autoFocus
            placeholder="Optional note"
            aria-label={`Optional calibration note for ${row.emp['Employee Name'] || row.code}`}
            style={{ width: '100%', minWidth: 0, boxSizing: 'border-box', padding: '7px 8px', borderRadius: 8, border: `1px solid ${BORDER}`, background: '#fff', color: INK, fontSize: 11.5, fontFamily: 'inherit', outlineColor: BLUE }}
          />
        ) : hasReason ? (
          <CalibrationNoteIndicator note={savedNote} />
        ) : (
          <span style={{ color: '#CBD5E1', fontWeight: 800 }}>—</span>
        )}
      </div>
      <div style={{ justifySelf: 'end' }}>
        {quickDirty ? (
          <div style={{ display: 'flex', gap: 5, alignItems: 'center' }}>
            <button type="button" onClick={saveQuickCalibration} disabled={!canSave} aria-label="Apply calibration" title="Apply calibration"
              style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 30, height: 30, borderRadius: 8, border: 'none', background: canSave ? BLUE : '#E2E8F0', color: canSave ? '#fff' : '#94A3B8', cursor: canSave ? 'pointer' : 'not-allowed', fontFamily: 'inherit', fontSize: 16, fontWeight: 900, lineHeight: 1 }}>
              {noteSaving ? '…' : '✓'}
            </button>
            <button type="button" onClick={cancelDraft} aria-label="Cancel calibration" title="Cancel calibration"
              style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 30, height: 30, borderRadius: 8, border: `1px solid ${BORDER}`, background: '#fff', color: MUTED, cursor: 'pointer', fontFamily: 'inherit', fontSize: 18, fontWeight: 900, lineHeight: 1 }}>
              ×
            </button>
          </div>
        ) : (
          <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 6, position: 'relative' }}>
            <button
              ref={menuBtnRef}
              type="button"
              onClick={() => setMenuOpen((open) => !open)}
              aria-label="Calibration row actions"
              title="More actions"
              style={{
                width: 30,
                height: 30,
                borderRadius: 9,
                border: `1px solid ${menuOpen ? BLUE : BORDER}`,
                background: menuOpen ? '#EFF6FF' : '#fff',
                color: menuOpen ? BLUE : MUTED,
                cursor: 'pointer',
                fontFamily: 'inherit',
                fontSize: 18,
                lineHeight: 1,
                fontWeight: 900,
              }}
            >
              ⋯
            </button>
            {menuOpen && (
              <div ref={menuRef} style={{ position: 'absolute', right: 0, top: 36, zIndex: 80, width: 184, background: '#fff', border: `1px solid ${BORDER}`, borderRadius: 12, boxShadow: '0 12px 28px rgba(15,23,42,0.14)', padding: 6 }}>
                <button type="button" onClick={() => { setMenuOpen(false); onOpen(row.code); }} style={menuItemStyle}>View details</button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function CalibrationNoteIndicator({ note }) {
  const [open, setOpen] = useState(false);
  const [pinned, setPinned] = useState(false);
  return (
    <span style={{ position: 'relative', display: 'inline-flex' }}>
      <button
        type="button"
        title={note}
        aria-expanded={open}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => { if (!pinned) setOpen(false); }}
        onFocus={() => setOpen(true)}
        onBlur={() => { setOpen(false); setPinned(false); }}
        onClick={() => {
          const next = !pinned;
          setPinned(next);
          setOpen(next);
        }}
        style={{ height: 27, padding: '0 9px', borderRadius: 999, border: '1px solid #DDD6FE', background: '#F5F3FF', color: VIOLET, fontSize: 10.5, fontWeight: 850, cursor: 'pointer', fontFamily: 'inherit' }}
      >
        Note
      </button>
      {open && (
        <span role="tooltip" style={{ position: 'absolute', zIndex: 100, right: 0, bottom: 34, width: 240, padding: '9px 11px', borderRadius: 9, border: '1px solid #DDD6FE', background: '#fff', boxShadow: '0 10px 28px rgba(15,23,42,0.16)', color: '#4C1D95', fontSize: 11.5, fontWeight: 700, lineHeight: 1.45, whiteSpace: 'normal', overflowWrap: 'anywhere' }}>
          {note}
        </span>
      )}
    </span>
  );
}

// Tooltip showing the exact bucket range + per-series counts on hover, so we
// don't need a number stamped on every bar.
function HistogramTooltip({ active, payload, series }) {
  if (!active || !payload || !payload.length) return null;
  const row = payload[0]?.payload;
  if (!row) return null;
  return (
    <div style={{ background: '#fff', border: `1px solid ${BORDER}`, borderRadius: 8, padding: '8px 10px', boxShadow: '0 8px 20px rgba(15,23,42,0.14)', fontSize: 12 }}>
      <div style={{ fontWeight: 800, color: INK, marginBottom: 4 }}>{row.lo.toFixed(2)} – {row.hi.toFixed(2)}</div>
      {series.map((s) => (
        <div key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 6, color: MUTED }}>
          <span style={{ width: 9, height: 9, borderRadius: 2, background: s.color }} />
          <span>{s.label}:</span>
          <strong style={{ color: INK }}>{row[s.id] || 0}</strong>
          <span style={{ color: '#94A3B8' }}>{(row[s.id] || 0) === 1 ? 'person' : 'people'}</span>
        </div>
      ))}
    </div>
  );
}

function ScoreHistogramPanel({ rows, maxRank = 5, bands = [], series, title, height = 250, showBandLabels = true }) {
  const { buckets, stats } = buildScoreHistogram(rows, series, maxRank);
  const scored = series.reduce((sum, s) => sum + stats[s.id].scored, 0);
  const single = series.length === 1;
  const ticks = [];
  for (let v = 1; v <= maxRank + 1e-9; v += 0.5) ticks.push(Math.round(v * 100) / 100);

  return (
    <div style={{ width: '100%' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, marginBottom: 8 }}>
        <div style={{ fontSize: 13, fontWeight: 900, color: INK }}>{title}</div>
        <div style={{ fontSize: 11.5, color: MUTED, fontWeight: 800 }}>{scored} scored</div>
      </div>
      {scored === 0 ? (
        <div style={{ padding: '28px 0', textAlign: 'center', fontSize: 13, color: MUTED }}>No completed scores yet.</div>
      ) : (
        <ResponsiveContainer width="100%" height={height}>
          <ComposedChart data={buckets} margin={{ top: 18, right: 14, left: 0, bottom: 4 }} barCategoryGap={0}>
            {/* Rating-band regions behind everything, consistent with the table/bell curve. */}
            {bands.map((band) => (
              <ReferenceArea key={`band-${band.n}`} x1={band.from} x2={band.to} fill={band.tint} fillOpacity={0.65} strokeOpacity={0}
                label={showBandLabels ? { value: band.label, position: 'insideTop', fontSize: 9.5, fill: '#94A3B8', fontWeight: 700 } : undefined} />
            ))}
            <CartesianGrid vertical={false} stroke="#EEF2F6" />
            <XAxis dataKey="mid" type="number" domain={[1, maxRank]} ticks={ticks} tickFormatter={(v) => v.toFixed(1)}
              tick={{ fontSize: 10.5, fill: '#64748B', fontWeight: 600 }} tickLine={false} axisLine={{ stroke: '#E2E8F0' }} height={20} />
            <YAxis allowDecimals={false} width={34} tick={{ fontSize: 10.5, fill: '#64748B', fontWeight: 600 }} tickLine={false} axisLine={false} />
            <RToolTip content={<HistogramTooltip series={series} />} cursor={{ fill: 'rgba(148,163,184,0.12)' }} />
            {series.map((s) => (
              <Bar key={`bar-${s.id}`} dataKey={s.id} fill={s.color} fillOpacity={0.5} radius={[2, 2, 0, 0]} maxBarSize={18} isAnimationActive={false} />
            ))}
            {/* Smooth density curve overlay so the overall shape reads at a glance. */}
            {series.map((s) => (
              <Line key={`line-${s.id}`} type="monotone" dataKey={s.id} stroke={s.color} strokeWidth={2} dot={false} isAnimationActive={false} />
            ))}
            {single && stats[series[0].id].avg !== null && (
              <ReferenceLine x={stats[series[0].id].avg} stroke={series[0].color} strokeDasharray="5 4" strokeWidth={1.4}
                label={{ value: `avg ${stats[series[0].id].avg.toFixed(2)}`, position: 'top', fontSize: 10.5, fill: series[0].color, fontWeight: 800 }} />
            )}
          </ComposedChart>
        </ResponsiveContainer>
      )}
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginTop: 6, fontSize: 11, fontWeight: 700, color: MUTED, flexWrap: 'wrap' }}>
        {series.map((s) => (
          <span key={s.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <span style={{ width: 14, height: 10, borderRadius: 3, background: s.color, opacity: 0.6 }} />
            {s.label}
            {stats[s.id].avg !== null && <strong style={{ color: INK }}>avg {stats[s.id].avg.toFixed(2)}</strong>}
          </span>
        ))}
      </div>
    </div>
  );
}

function ToleranceTable({ scale, targets, tolerances, actuals, counts, config }) {
  return (
    <div style={{ marginTop: 12, border: `1px solid ${BORDER}`, borderRadius: 10, overflow: 'hidden' }}>
      <div style={{ display: 'grid', gridTemplateColumns: '1.5fr 1fr 1fr 1fr 1fr', padding: '8px 12px', background: '#F8FAFC', fontSize: 11, fontWeight: 900, color: '#64748B', textTransform: 'uppercase' }}>
        <span>Rank</span><span>Target</span><span>Tolerance</span><span>Actual</span><span>Status</span>
      </div>
      {scale.map((lvl) => {
        const dataIndex = Math.max(0, Number(lvl.n) - 1);
        const target = targets[dataIndex] || 0;
        const tol = tolerances[dataIndex] || 0;
        const actual = actuals[dataIndex] || 0;
        const diff = actual - target;
        const inRange = Math.abs(diff) <= tol;
        return (
          <div key={lvl.n} style={{ display: 'grid', gridTemplateColumns: '1.5fr 1fr 1fr 1fr 1fr', padding: '8px 12px', borderTop: `1px solid ${BORDER}`, fontSize: 12.5 }}>
            <span style={{ fontWeight: 800, color: '#0F172A' }}>{formatFinalRank(lvl, config)}</span>
            <span>{target}%</span>
            <span>±{tol}%</span>
            <span>{actual}% <span style={{ color: '#94A3B8', fontSize: 11 }}>({counts[dataIndex] || 0})</span></span>
            <span style={{ color: inRange ? '#16A34A' : '#DC2626', fontWeight: 700 }}>
              {inRange ? 'In tolerance' : `${diff > 0 ? '+' : ''}${diff}%`}
            </span>
          </div>
        );
      })}
    </div>
  );
}

const round2 = (n) => Math.round(Number(n) * 100) / 100;
const clampN = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

function averageScore(values = []) {
  const nums = values.map(Number).filter((n) => Number.isFinite(n));
  if (!nums.length) return null;
  return round2(nums.reduce((sum, n) => sum + n, 0) / nums.length);
}

function formatAverage(value) {
  return value !== null && value !== undefined && Number.isFinite(Number(value)) ? Number(value).toFixed(2) : '—';
}

// Shared, mode-aware calibration editor used by both the lanes and the register.
// Records a calibrated value as a separate layer (manager's original is never
// overwritten) with actor/time audit data.
function CalibratePanel({ currentValue, scale, config, orgKey, code, actor, mode = 'final', hasCalibration = false, onChanged, onClose, onOpenRating, onDraftScoreChange, onDraftDisplayChange }) {
  const maxRank = scale.length || 5;
  const cur = Number(currentValue);
  const curStr = String(Number.isFinite(cur) ? clampN(cur, 1, maxRank) : 1);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(curStr);
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);

  const num = Number(draft);
  const inRange = Number.isFinite(num) && num >= 1 && num <= maxRank;
  const nextScore = inRange ? clampN(num, 1, maxRank) : null;
  const nextDisplay = inRange ? displayScore(nextScore, scale, config) : '';
  const curRank = rankForScore(cur, scale, config)?.n;
  const changed = inRange && (!Number.isFinite(cur) || Math.abs(Number(cur) - Number(nextScore)) >= 0.01 || Number(curRank) !== Number(rankForScore(nextScore, scale, config)?.n));
  useEffect(() => {
    if (!open) {
      if (typeof onDraftScoreChange === 'function') onDraftScoreChange(currentValue);
      if (typeof onDraftDisplayChange === 'function') onDraftDisplayChange('');
      return;
    }
    if (typeof onDraftScoreChange === 'function') onDraftScoreChange(inRange ? nextScore : currentValue);
    if (typeof onDraftDisplayChange === 'function') onDraftDisplayChange(inRange ? nextDisplay : '');
  }, [currentValue, inRange, nextDisplay, nextScore, onDraftDisplayChange, onDraftScoreChange, open]);
  const reset = () => {
    setDraft(curStr);
    setReason('');
    setOpen(false);
    if (typeof onDraftScoreChange === 'function') onDraftScoreChange(currentValue);
    if (typeof onDraftDisplayChange === 'function') onDraftDisplayChange('');
  };
  const save = async () => {
    if (!changed || saving) return;
    setSaving(true);
    const stageName = mode === 'hod' ? 'hod' : 'final';
    const result = await saveCalibrationStage(orgKey, code, stageName, {}, nextScore, reason.trim(), actor);
    setSaving(false);
    if (!result?.ok) {
      window.alert(result?.error || 'Could not save calibration. Please retry.');
      return;
    }
    onChanged(); onClose();
  };
  const resetSaved = async () => {
    if (!hasCalibration || saving) return;
    setSaving(true);
    const result = await submitEmployeeStageAndPersist(
      orgKey,
      code,
      mode === 'hod' ? 'hod' : 'final',
      {},
      actor,
      { allowFallback: false, optimistic: false },
    );
    setSaving(false);
    if (!result?.ok) {
      window.alert(result?.error || 'Could not reset calibration. Please retry.');
      return;
    }
    if (typeof onDraftDisplayChange === 'function') onDraftDisplayChange('');
    onChanged();
    setOpen(false);
  };

  if (!open) {
    return (
      <div style={{ marginTop: 9, paddingTop: 9, borderTop: '1px solid #EEF0F5', display: 'flex', gap: 6, alignItems: 'center' }}>
        <button
          type="button"
          onClick={() => setOpen(true)}
          style={{
            flex: 1,
            border: 'none',
            background: VIOLET,
            color: '#fff',
            borderRadius: 8,
            padding: '7px 10px',
            fontSize: 12,
            fontWeight: 850,
            cursor: 'pointer',
            fontFamily: 'inherit',
          }}
        >
          Calibrate
        </button>
        {hasCalibration && (
          <button
            type="button"
            onClick={resetSaved}
            title="Reset calibration"
            style={{
              border: `1px solid ${BORDER}`,
              background: '#fff',
              color: '#64748B',
              borderRadius: 8,
              padding: '7px 11px',
              fontSize: 12,
              fontWeight: 800,
              cursor: 'pointer',
              fontFamily: 'inherit',
              whiteSpace: 'nowrap',
            }}
          >
            Reset
          </button>
        )}
      </div>
    );
  }

  return (
    <div style={{ marginTop: 12, borderTop: '1px solid #E0E7FF', paddingTop: 11 }}>
      <div style={{ padding: '8px 0 2px', overflow: 'hidden' }}>
        <RatingWidget
          value={inRange ? nextScore : null}
          onChange={(value) => {
            if (value === null || value === undefined || value === '') return setDraft('');
            const n = Number(value);
            setDraft(Number.isFinite(n) ? String(clampN(n, 1, maxRank)) : '');
          }}
          config={config}
          disabled={false}
        />
      </div>
      <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason (optional)" autoFocus
        onKeyDown={(e) => { if (e.key === 'Enter') save(); if (e.key === 'Escape') onClose(); }}
        style={{ width: '100%', boxSizing: 'border-box', marginTop: 8, padding: '9px 10px', borderRadius: 9, border: `1px solid ${BORDER}`, background: '#fff', color: INK, fontSize: 12.5, fontFamily: 'inherit', outlineColor: BLUE }} />
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginTop: 8 }}>
        <button type="button" onClick={save} disabled={!changed || saving}
          style={{ border: 'none', borderRadius: 9, padding: '8px 10px', background: !changed || saving ? '#E2E8F0' : '#2563EB', color: !changed || saving ? '#94A3B8' : '#fff', fontSize: 12.5, fontWeight: 850, cursor: !changed || saving ? 'not-allowed' : 'pointer', fontFamily: 'inherit' }}>
          {saving ? 'Saving…' : 'Confirm'}
        </button>
        <button type="button" onClick={reset}
          style={{ border: `1px solid ${BORDER}`, borderRadius: 9, padding: '8px 10px', background: '#fff', color: '#334155', fontSize: 12.5, fontWeight: 850, cursor: 'pointer', fontFamily: 'inherit' }}>
          Cancel
        </button>
        {onOpenRating && <button type="button" onClick={onOpenRating} style={{ ...btnStyle('ghost', false), color: BLUE, marginLeft: 'auto' }}>Open full rating →</button>}
      </div>
    </div>
  );
}

const menuItemStyle = {
  width: '100%',
  textAlign: 'left',
  border: 0,
  background: 'transparent',
  padding: '8px 9px',
  borderRadius: 8,
  cursor: 'pointer',
  color: INK,
  fontFamily: 'inherit',
  fontSize: 12.5,
  fontWeight: 750,
};

const filterSelectStyle = {
  flexShrink: 0, maxWidth: 170, padding: '8px 10px', border: `1px solid ${BORDER}`,
  borderRadius: 9, fontSize: 12.5, fontWeight: 600, color: '#334155',
  background: '#fff', cursor: 'pointer', fontFamily: 'inherit',
};

function segBtn(active) {
  return {
    padding: '7px 12px',
    borderRadius: 8,
    border: `1.5px solid ${active ? BLUE : BORDER}`,
    background: active ? '#EFF6FF' : '#fff',
    color: active ? BLUE : '#334155',
    fontSize: 12.5,
    fontWeight: 850,
    cursor: 'pointer',
    fontFamily: 'inherit',
  };
}

function Header({ title, subtitle, right }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 18 }}>
      <div>
        <div style={{ fontSize: 24, fontWeight: 800, color: '#0F172A' }}>{title}</div>
        {subtitle && <div style={{ fontSize: 13, color: '#64748B', marginTop: 4 }}>{subtitle}</div>}
      </div>
      {right}
    </div>
  );
}
function PillStatus({ label, color }) {
  return <span style={{ padding: '5px 11px', borderRadius: 999, background: `${color}1A`, color, fontSize: 12, fontWeight: 700 }}>{label}</span>;
}
// Cycle-stage pill — same bg/border/dot treatment as the Employee Status page.
function StagePill({ stage }) {
  const s = stage || STAGE_PILLS['goal-creation'];
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '4px 10px', borderRadius: 999, background: s.bg, border: `1px solid ${s.border}`, color: s.color, fontSize: 11.5, fontWeight: 700, whiteSpace: 'nowrap' }}>
      <span style={{ width: 6, height: 6, borderRadius: '50%', background: s.color, flexShrink: 0 }} />
      {s.label}
    </span>
  );
}
function Card({ children }) {
  return <div style={{ background: '#fff', border: `1px solid ${BORDER}`, borderRadius: 12, marginBottom: 14, overflow: 'visible' }}>{children}</div>;
}
function CardHead({ children }) {
  return <div style={{ padding: '14px 18px', borderBottom: `1px solid ${BORDER}`, background: '#FAFBFF' }}>{children}</div>;
}
function CardBody({ children }) {
  return <div style={{ padding: '8px 18px 16px' }}>{children}</div>;
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
      padding: '7px 14px', borderRadius: 8, fontSize: 12.5, fontWeight: 700,
      border: '1px solid #2563EB',
      background: disabled ? '#94A3B8' : '#2563EB', color: '#fff',
      cursor: disabled ? 'not-allowed' : 'pointer', fontFamily: 'inherit',
    };
  }
  return {
    padding: '7px 14px', borderRadius: 8, fontSize: 12.5, fontWeight: 700,
    border: `1px solid ${BORDER}`,
    background: '#fff', color: disabled ? '#94A3B8' : '#334155',
    cursor: disabled ? 'not-allowed' : 'pointer', fontFamily: 'inherit',
  };
}
