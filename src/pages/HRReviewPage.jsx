import { useEffect, useMemo, useState } from 'react';
import { useApp } from '../AppContext';
import { usePMSData } from '../hooks/usePMSData';
import { persistWorkflow, readWorkflowSync } from '../backend/stateStore';
import {
  readRatings,
  hydrateRatings,
  recordCalibrationMove,
  publishCycle,
  isPublished,
  seedSampleRatings,
  subscribeToRatings,
} from '../backend/ratingsStore';

const BORDER = '#E2E8F0';
const SOFT_BG = '#F8FAFC';
const INK = '#0F172A';
const MUTED = '#64748B';
const BLUE = '#2563EB';
const VIOLET = '#7C3AED';
const GREEN = '#16A34A';
const RED = '#DC2626';

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

function getScale(config) {
  const N = Math.max(2, Math.min(10, Number(config?.scalePoints) || 5));
  const labels = config?.scaleLabels || {};
  const codes = config?.scaleRankCodes || {};
  return Array.from({ length: N }, (_, i) => {
    const n = i + 1;
    return { n, l: String(labels[n] || ''), code: String(codes[n] ?? n) };
  });
}

function formatFinalRank(level, config = {}, decimal = null) {
  if (!level) return '';
  const display = String(config?.finalRatingDisplay || 'code-label');
  const code = String(level.code || level.n);
  const label = String(level.l || '').trim();
  const hasDecimal = Number.isFinite(Number(decimal));
  const score = hasDecimal ? Number(decimal).toFixed(2) : code;
  if (display === 'code') return code;
  if (display === 'label') return label || code;
  if (display === 'decimal-code') return hasDecimal ? `${score} - ${code}` : code;
  if (display === 'decimal-label') return hasDecimal ? `${score} - ${label || code}` : (label || code);
  return label ? `${code} - ${label}` : code;
}

function getBellBands(config) {
  const raw = Array.isArray(config?.bellBands) ? config.bellBands : [];
  const scale = getScale(config);
  return scale.map((_, i) => Number(raw[i] ?? (i === Math.floor(scale.length / 2) ? 40 : 15)));
}

function getBellTolerances(config) {
  const raw = Array.isArray(config?.bellTolerances) ? config.bellTolerances : [];
  const scale = getScale(config);
  return scale.map((_, i) => Number(raw[i] ?? (i === Math.floor(scale.length / 2) ? 5 : 2)));
}

function effectiveScore(stages) {
  if (stages?.final?.calibratedScore !== undefined) return Number(stages.final.calibratedScore);
  if (stages?.manager?.overallScore !== undefined && stages?.manager?.overallScore !== null) return Number(stages.manager.overallScore);
  return null;
}

function normalizeCode(v) {
  return String(v || '').trim().toUpperCase();
}

function averageObjectScores(obj) {
  const nums = Object.values(obj || {}).map(Number).filter(Number.isFinite);
  if (!nums.length) return null;
  return nums.reduce((sum, n) => sum + n, 0) / nums.length;
}

function stageScore(stage) {
  if (!stage) return null;
  if (stage.overallScore !== undefined && stage.overallScore !== null && stage.overallScore !== '') return Number(stage.overallScore);
  return averageObjectScores(stage.itemScores);
}

function displayScore(score, scale, config) {
  if (!Number.isFinite(Number(score))) return '—';
  const rounded = Math.max(1, Math.min(scale.length, Math.round(Number(score))));
  const level = scale.find((item) => item.n === rounded);
  return formatFinalRank(level, config, score);
}

function scoreDelta(a, b) {
  if (!Number.isFinite(Number(a)) || !Number.isFinite(Number(b))) return '—';
  const diff = Number(b) - Number(a);
  if (Math.abs(diff) < 0.01) return '0';
  return `${diff > 0 ? '+' : ''}${diff.toFixed(2).replace(/\.00$/, '')}`;
}

function buildDistribution(rows, scalePoints) {
  const counts = Array.from({ length: scalePoints || 5 }, () => 0);
  rows.forEach((row) => {
    if (!Number.isFinite(Number(row.finalScore))) return;
    const idx = Math.max(0, Math.min((scalePoints || 5) - 1, Math.round(Number(row.finalScore)) - 1));
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

function statusFor(stages) {
  if (stages?.final?.calibratedScore !== undefined) return { label: 'Calibrated', color: '#7C3AED' };
  if (stages?.manager?.submittedAt) return { label: 'Ready for HR', color: '#2563EB' };
  if (stages?.self?.submittedAt) return { label: 'Waiting on manager', color: '#0891B2' };
  return { label: 'Incomplete', color: '#64748B' };
}

function MetricCard({ label, value, tone = '#0F172A' }) {
  return (
    <div style={{ background: '#fff', border: `1px solid ${BORDER}`, borderRadius: 12, padding: '14px 16px' }}>
      <div style={{ fontSize: 11, fontWeight: 900, color: '#64748B', textTransform: 'uppercase' }}>{label}</div>
      <div style={{ fontSize: 24, fontWeight: 900, color: tone, marginTop: 4 }}>{value}</div>
    </div>
  );
}

function EmployeeReviewTable({ rows, scale, config, orgKey, actor, published, onChanged, onOpen, onRemind }) {
  if (!rows.length) {
    return <div style={{ padding: 18, fontSize: 13, color: '#64748B', textAlign: 'center' }}>No employees match the selected filters.</div>;
  }
  return (
    <div style={{ border: `1px solid ${BORDER}`, borderRadius: 10, overflow: 'hidden' }}>
      <div style={{ display: 'grid', gridTemplateColumns: '2.2fr 1fr 1fr 1fr 0.9fr 1.35fr', gap: 10, padding: '9px 12px', background: '#F8FAFC', fontSize: 11, fontWeight: 900, color: '#64748B', textTransform: 'uppercase' }}>
        <span>Employee</span>
        <span>Self</span>
        <span>Manager</span>
        <span>Final</span>
        <span>Status</span>
        <span>Action</span>
      </div>
      {rows.map((row) => (
        <EmployeeReviewRow
          key={row.code}
          row={row}
          scale={scale}
          config={config}
          orgKey={orgKey}
          actor={actor}
          published={published}
          onChanged={onChanged}
          onOpen={onOpen}
          onRemind={onRemind}
        />
      ))}
    </div>
  );
}

function EmployeeReviewRow({ row, scale, config, orgKey, actor, published, onChanged, onOpen, onRemind }) {
  const [editing, setEditing] = useState(false);
  const [targetScore, setTargetScore] = useState(row.finalScore || row.managerScore || '');
  const [reason, setReason] = useState('');
  const canCalibrate = !published && Number.isFinite(Number(row.managerScore));
  const completed = !!row.stages?.manager?.submittedAt;
  const finalChanged = Number.isFinite(Number(row.finalScore)) && Number.isFinite(Number(row.managerScore)) && Number(row.finalScore) !== Number(row.managerScore);
  const gap = scoreDelta(row.selfScore, row.managerScore);

  const submitCalibration = () => {
    if (!canCalibrate || !reason.trim()) return;
    const before = Number.isFinite(Number(row.finalScore)) ? Number(row.finalScore) : Number(row.managerScore);
    recordCalibrationMove(orgKey, row.code, before, Number(targetScore), reason.trim(), actor);
    setEditing(false);
    setReason('');
    onChanged();
  };

  return (
    <div style={{ borderTop: `1px solid ${BORDER}` }}>
      <div style={{ display: 'grid', gridTemplateColumns: '2.2fr 1fr 1fr 1fr 0.9fr 1.35fr', gap: 10, padding: '11px 12px', alignItems: 'center', fontSize: 12.5 }}>
        <button type="button" onClick={() => onOpen(row.code)} style={{ textAlign: 'left', border: 0, background: 'transparent', padding: 0, cursor: 'pointer', fontFamily: 'inherit' }}>
          <div style={{ fontWeight: 800, color: '#0F172A' }}>{row.emp['Employee Name'] || row.code}</div>
          <div style={{ color: '#64748B', fontSize: 11.5, marginTop: 2 }}>
            {row.code} · {row.emp.Role || row.emp.Designation || '—'} · {row.emp['Group Name'] || '—'}
          </div>
        </button>
        {completed ? <ScoreCell score={row.selfScore} scale={scale} config={config} /> : <MutedDash />}
        {completed ? <ScoreCell score={row.managerScore} scale={scale} config={config} strong /> : <MutedDash />}
        {completed ? <ScoreCell score={row.finalScore} scale={scale} config={config} strong accent={finalChanged ? '#7C3AED' : '#0F172A'} /> : <MutedDash />}
        <PillStatus label={row.status.label} color={row.status.color} />
        <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
          <button type="button" onClick={() => onOpen(row.code)} style={btnStyle('ghost', false)}>View</button>
          {!completed && <button type="button" onClick={() => onRemind(row)} style={btnStyle('ghost', false)}>Remind</button>}
          <button type="button" onClick={() => setEditing((v) => !v)} disabled={!canCalibrate} style={btnStyle('primary', !canCalibrate || published)}>Calibrate</button>
        </div>
      </div>
      {completed && gap !== '—' && (
        <div style={{ padding: '0 12px 10px 12px', fontSize: 11.5, color: '#64748B' }}>
          Self vs manager difference: <strong style={{ color: gap === '0' ? '#16A34A' : '#F97316' }}>{gap}</strong>
        </div>
      )}
      {editing && (
        <div style={{ padding: '0 12px 12px', display: 'grid', gridTemplateColumns: '180px 1fr auto', gap: 8, alignItems: 'end' }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ fontSize: 11, fontWeight: 800, color: '#64748B', textTransform: 'uppercase' }}>Final rating</span>
            <select value={targetScore} onChange={(e) => setTargetScore(e.target.value)} style={{ padding: '8px 10px', borderRadius: 8, border: `1px solid ${BORDER}`, fontSize: 12.5 }}>
              {scale.map((lvl) => <option key={lvl.n} value={lvl.n}>{formatFinalRank(lvl, config)}</option>)}
            </select>
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ fontSize: 11, fontWeight: 800, color: '#64748B', textTransform: 'uppercase' }}>Reason</span>
            <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason for final rating change" style={{ padding: '8px 10px', borderRadius: 8, border: `1px solid ${BORDER}`, fontSize: 12.5 }} />
          </label>
          <button type="button" onClick={submitCalibration} disabled={!reason.trim()} style={btnStyle('primary', !reason.trim())}>Save</button>
        </div>
      )}
    </div>
  );
}

function MutedDash() {
  return <span style={{ color: '#CBD5E1', fontWeight: 800 }}>—</span>;
}

function ScoreCell({ score, scale, config, strong = false, accent = '#0F172A' }) {
  const empty = !Number.isFinite(Number(score));
  return (
    <span style={{ fontWeight: strong ? 850 : 700, color: empty ? '#94A3B8' : accent }}>
      {displayScore(score, scale, config)}
    </span>
  );
}

function ReviewDetailModal({ row, orgKey, config, scale, onClose }) {
  const goals = getEmployeeGoals(orgKey, row.code);
  const items = flattenGoalItems(goals);
  const self = row.stages?.self || {};
  const manager = row.stages?.manager || {};
  const final = row.stages?.final || {};
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.48)', zIndex: 60, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
      <div style={{ width: 'min(980px, 96vw)', maxHeight: '88vh', overflow: 'hidden', background: '#fff', borderRadius: 16, border: `1px solid ${BORDER}`, boxShadow: '0 24px 80px rgba(15,23,42,0.22)' }}>
        <div style={{ padding: '18px 22px', borderBottom: `1px solid ${BORDER}`, display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'flex-start' }}>
          <div>
            <div style={{ fontSize: 20, fontWeight: 900, color: '#0F172A' }}>{row.emp['Employee Name'] || row.code}</div>
            <div style={{ fontSize: 12.5, color: '#64748B', marginTop: 3 }}>
              {row.code} · {row.emp.Role || row.emp.Designation || '—'} · {row.emp['Group Name'] || '—'}
            </div>
          </div>
          <button type="button" onClick={onClose} style={{ width: 38, height: 38, borderRadius: 10, border: `1px solid ${BORDER}`, background: '#fff', cursor: 'pointer', fontSize: 20, color: '#64748B' }}>×</button>
        </div>
        <div style={{ padding: 22, overflow: 'auto', maxHeight: 'calc(88vh - 82px)' }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 10, marginBottom: 16 }}>
            <MetricCard label="Self rating" value={displayScore(row.selfScore, scale, config)} tone="#0891B2" />
            <MetricCard label="Manager rating" value={displayScore(row.managerScore, scale, config)} tone="#2563EB" />
            <MetricCard label="Final rating" value={displayScore(row.finalScore, scale, config)} tone="#7C3AED" />
            <MetricCard label="Self vs manager" value={scoreDelta(row.selfScore, row.managerScore)} tone="#F97316" />
          </div>
          <div style={{ border: `1px solid ${BORDER}`, borderRadius: 12, overflow: 'hidden', marginBottom: 14 }}>
            <div style={{ display: 'grid', gridTemplateColumns: '2fr 0.8fr 0.8fr 0.8fr 1fr', gap: 10, padding: '9px 12px', background: '#F8FAFC', fontSize: 11, fontWeight: 900, color: '#64748B', textTransform: 'uppercase' }}>
              <span>KRA / KPI</span><span>Self ach.</span><span>Self score</span><span>Mgr score</span><span>Manager comment</span>
            </div>
            {items.length ? items.map((item) => (
              <div key={item.id} style={{ display: 'grid', gridTemplateColumns: '2fr 0.8fr 0.8fr 0.8fr 1fr', gap: 10, padding: '11px 12px', borderTop: `1px solid ${BORDER}`, fontSize: 12.5, alignItems: 'start' }}>
                <div>
                  <div style={{ fontWeight: 800, color: '#0F172A' }}>{item.name}</div>
                  <div style={{ fontSize: 11.5, color: '#64748B', marginTop: 2 }}>Goal {item.goalIndex} · {item.kind}{item.parentName && item.parentName !== item.name ? ` · ${item.parentName}` : ''}</div>
                </div>
                <span>{self.achievements?.[item.id] ?? manager.achievements?.[item.id] ?? '—'}</span>
                <span>{self.itemScores?.[item.id] ?? '—'}</span>
                <span style={{ fontWeight: 800 }}>{manager.itemScores?.[item.id] ?? '—'}</span>
                <span style={{ color: '#475569' }}>{manager.itemComments?.[item.id] || '—'}</span>
              </div>
            )) : (
              <div style={{ padding: 16, fontSize: 13, color: '#64748B' }}>No goal details found for this employee.</div>
            )}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <CommentBox title="Self comment" text={self.overallComment} />
            <CommentBox title="Manager comment" text={manager.overallComment} />
          </div>
          {final.calibrationNote && (
            <div style={{ marginTop: 12, padding: 12, borderRadius: 10, border: '1px solid #DDD6FE', background: '#F5F3FF', color: '#5B21B6', fontSize: 12.5, fontWeight: 700 }}>
              Calibration reason: {final.calibrationNote}
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

export default function HRReviewPage({ embedded = false } = {}) {
  const { orgKey, userName } = useApp();
  const { ready, config, employees } = usePMSData(orgKey);
  const [activeTab, setActiveTab] = useState('bell');
  const [groupFilter, setGroupFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [auditSearch, setAuditSearch] = useState('');
  const [selectedCode, setSelectedCode] = useState('');
  const [tick, setTick] = useState(0);
  const [toast, setToast] = useState('');

  useEffect(() => {
    const refresh = () => setTick((t) => t + 1);
    void hydrateRatings(orgKey).then(refresh);
    const unsubscribeRatings = subscribeToRatings(orgKey, refresh);
    window.addEventListener('zarohr-ratings-changed', refresh);
    return () => {
      window.removeEventListener('zarohr-ratings-changed', refresh);
      unsubscribeRatings();
    };
  }, [orgKey]);

  const groups = useMemo(() => (config?.goalGroups || []).map((g) => g.name).filter(Boolean), [config]);
  const empMap = useMemo(() => {
    const m = {};
    employees.forEach((e) => { m[normalizeCode(e['Employee Code'])] = e['Employee Name'] || ''; });
    return m;
  }, [employees]);

  const ratings = readRatings(orgKey);
  void tick;
  const allRows = employees.map((emp) => {
    const code = String(emp['Employee Code'] || '').trim();
    const stages = ratings.ratings?.[code] || {};
    const selfScore = stageScore(stages.self);
    const managerScore = stageScore(stages.manager);
    const finalScore = effectiveScore(stages);
    const managerDone = !!stages.manager?.submittedAt;
    const selfDone = !!stages.self?.submittedAt;
    return {
      emp,
      code,
      stages,
      selfScore,
      managerScore,
      finalScore,
      score: finalScore,
      managerDone,
      selfDone,
      status: statusFor(stages),
    };
  });

  const empRatings = allRows.filter((row) => {
    const inGroup = groupFilter === 'all' || String(row.emp['Group Name'] || '').trim() === groupFilter;
    const needle = search.trim().toLowerCase();
    const matchesSearch = !needle || [
      row.emp['Employee Name'],
      row.emp['Employee Code'],
      row.emp.Role,
      row.emp.Designation,
      row.emp['Group Name'],
    ].some((v) => String(v || '').toLowerCase().includes(needle));
    return inGroup && matchesSearch;
  });

  const rated = empRatings.filter((r) => r.score !== null);
  const completedRows = empRatings.filter((r) => r.managerDone && r.score !== null);
  const scale = getScale(config);
  const targets = getBellBands(config);
  const tolerances = getBellTolerances(config);
  const dist = buildDistribution(completedRows, scale.length);

  const sortedTopDown = scale.slice().sort((a, b) => b.n - a.n);
  const published = isPublished(orgKey);
  const bellMode = config?.bellMode || 'soft';
  const selectedRow = empRatings.find((row) => normalizeCode(row.code) === normalizeCode(selectedCode));
  const selfSubmitted = allRows.filter((row) => row.stages?.self?.submittedAt).length;
  const managerSubmitted = allRows.filter((row) => row.stages?.manager?.submittedAt).length;
  const calibratedCount = allRows.filter((row) => row.stages?.final?.calibratedScore !== undefined).length;
  const waitingOnSelf = allRows.filter((row) => !row.selfDone).length;
  const waitingOnManager = allRows.filter((row) => row.selfDone && !row.managerDone).length;

  const outOfTolerance = dist.total === 0 ? [] : scale.map((_, i) => {
    const diff = Math.abs((dist.pct[i] || 0) - (targets[i] || 0));
    return diff > (tolerances[i] || 0) ? { rank: i + 1, diff, target: targets[i], actual: dist.pct[i] } : null;
  }).filter(Boolean);
  const hasOutOfTolerance = outOfTolerance.length > 0;
  const publishBlocked = bellMode === 'hard' && hasOutOfTolerance;
  const [publishReason, setPublishReason] = useState('');

  const onSeedSample = () => {
    seedSampleRatings(orgKey, employees, scale.length);
    setTick((t) => t + 1);
  };
  const onPublish = () => {
    if (publishBlocked) return;
    if (bellMode === 'soft' && hasOutOfTolerance && !publishReason.trim()) {
      window.alert('Add an override reason — distribution is outside tolerance.');
      return;
    }
    if (!window.confirm('Publish final ratings? This cannot be undone.')) return;
    publishCycle(orgKey, userName || 'HR admin', publishReason.trim());
    setPublishReason('');
    setTick((t) => t + 1);
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
  const sendBulkReminders = () => {
    const targets = empRatings.filter((row) => !row.managerDone);
    if (!targets.length) {
      setToast('No pending reminders to send.');
      window.setTimeout(() => setToast(''), 2800);
      return;
    }
    const wf = readWorkflowSync(orgKey) || { submissions: {}, notifications: [] };
    const notifications = targets.map((row) => {
      const needsSelf = !row.selfDone;
      const recipientCode = needsSelf ? row.code : row.emp['Reporting Manager Code'];
      if (!recipientCode) return null;
      return makeNotif('goal-reminder', {
        recipientCode,
        senderCode: userName || 'HR',
        submissionCode: row.code,
        title: needsSelf ? 'Self-evaluation reminder' : 'Manager rating reminder',
        message: needsSelf
          ? 'HR requested that you complete and submit your self-evaluation.'
          : `${row.emp['Employee Name'] || row.code} is waiting for your manager rating.`,
      });
    }).filter(Boolean);
    persistWorkflow(orgKey, { ...(wf || {}), notifications: [...notifications, ...(wf.notifications || [])] });
    setToast(`Sent ${notifications.length} reminder${notifications.length === 1 ? '' : 's'}.`);
    window.setTimeout(() => setToast(''), 2800);
  };
  const downloadEmployeeRegister = () => {
    const headers = ['Employee Code', 'Employee Name', 'Designation', 'Group', 'Self Status', 'Manager Status', 'Self Rating', 'Manager Rating', 'Final Rating', 'Difference', 'Review Status'];
    const rows = empRatings.map((row) => {
      const completed = row.managerDone;
      return [
        row.code,
        row.emp['Employee Name'] || '',
        row.emp.Role || row.emp.Designation || '',
        row.emp['Group Name'] || '',
        row.selfDone ? 'Submitted' : 'Pending',
        row.managerDone ? 'Submitted' : 'Pending',
        completed ? displayScore(row.selfScore, scale, config) : '',
        completed ? displayScore(row.managerScore, scale, config) : '',
        completed ? displayScore(row.finalScore, scale, config) : '',
        completed ? scoreDelta(row.selfScore, row.managerScore) : '',
        row.status.label,
      ];
    });
    downloadCsv('hr_review_employee_register.csv', headers, rows);
  };

  if (!ready) return <ShellMessage title="Loading…" message="Reading cycle data." />;

  return (
    <div style={embedded ? { fontFamily: "'Geist','Inter','Segoe UI',Arial,sans-serif" } : { minHeight: '100vh', background: SOFT_BG, padding: '32px 16px', fontFamily: "'Geist','Inter','Segoe UI',Arial,sans-serif" }}>
      <div style={embedded ? {} : { maxWidth: 1240, margin: '0 auto' }}>
        <Header
          title="HR Review"
          subtitle={`${completedRows.length} completed ratings · ${bellMode === 'hard' ? 'Hard' : 'Soft'} bell-curve mode`}
          right={
            <div style={{ display: 'flex', gap: 8 }}>
              {!published && rated.length > 0 && (
                <button type="button" onClick={onPublish} disabled={publishBlocked} style={btnStyle('primary', publishBlocked)}>
                  {publishBlocked ? 'Publish blocked' : 'Publish cycle'}
                </button>
              )}
              {published && <PillStatus label={`Published ${new Date(ratings.publishedAt).toLocaleDateString()}`} color="#16A34A" />}
            </div>
          }
        />

        <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
          {[
            { id: 'bell', label: 'Bell Curve', count: dist.total },
            { id: 'employees', label: 'Employee Register', count: empRatings.length },
            { id: 'audit', label: 'Audit', count: (ratings.auditLog || []).length },
          ].map((tab) => (
            <button key={tab.id} type="button" onClick={() => setActiveTab(tab.id)}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 8, padding: '9px 14px', borderRadius: 999, border: `1.5px solid ${activeTab === tab.id ? BLUE : BORDER}`, background: activeTab === tab.id ? BLUE : '#fff', color: activeTab === tab.id ? '#fff' : '#334155', cursor: 'pointer', fontFamily: 'inherit', fontSize: 13, fontWeight: 850 }}>
              {tab.label}
              <span style={{ padding: '1px 8px', borderRadius: 999, background: activeTab === tab.id ? 'rgba(255,255,255,.18)' : '#F1F5F9', fontSize: 11 }}>{tab.count}</span>
            </button>
          ))}
        </div>

        {activeTab === 'bell' && (
          <>
            <BellHero
              completed={completedRows.length}
              total={allRows.length}
              calibrated={calibratedCount}
              waitingOnSelf={waitingOnSelf}
              waitingOnManager={waitingOnManager}
              bellMode={bellMode}
              hasOutOfTolerance={hasOutOfTolerance}
              outOfTolerance={outOfTolerance}
              scale={scale}
              config={config}
            />

            {!published && hasOutOfTolerance && (
              <div style={{
                background: bellMode === 'hard' ? '#FEF2F2' : '#FFFBEB',
                border: `1px solid ${bellMode === 'hard' ? '#FECACA' : '#FDE68A'}`,
                color: bellMode === 'hard' ? '#B91C1C' : '#92400E',
                borderRadius: 14, padding: 14, marginBottom: 14,
              }}>
                <div style={{ fontSize: 13, fontWeight: 850 }}>
                  {bellMode === 'hard'
                    ? `${outOfTolerance.length} rank${outOfTolerance.length === 1 ? '' : 's'} outside tolerance. Publishing is blocked.`
                    : `${outOfTolerance.length} rank${outOfTolerance.length === 1 ? '' : 's'} outside tolerance. Add an override reason to publish.`}
                </div>
                {bellMode === 'soft' && (
                  <input
                    value={publishReason}
                    onChange={(e) => setPublishReason(e.target.value)}
                    placeholder="Override reason for publishing outside tolerance"
                    style={{ width: '100%', marginTop: 10, padding: 10, borderRadius: 10, border: '1px solid #FDE68A', fontSize: 12.5, background: '#fff', boxSizing: 'border-box' }}
                  />
                )}
              </div>
            )}

            <PremiumBellCard>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, marginBottom: 18 }}>
                <div>
                  <div style={{ fontSize: 20, fontWeight: 950, color: INK }}>Bell curve distribution</div>
                  <div style={{ fontSize: 12.5, color: MUTED, marginTop: 3 }}>Completed ratings only. Target bands glow behind actual distribution.</div>
                </div>
                <PillStatus label={`${dist.total} completed`} color={BLUE} />
              </div>
              <DistributionChart scale={sortedTopDown} targets={targets} tolerances={tolerances} actuals={dist.pct} counts={dist.counts} config={config} />
            </PremiumBellCard>

            <Card>
              <CardHead>
                <div style={{ fontSize: 14, fontWeight: 800, color: INK }}>Calibration lanes</div>
                <div style={{ fontSize: 12, color: MUTED, marginTop: 2 }}>Use the rank lanes only after ratings are complete. Incomplete employees stay in the register.</div>
              </CardHead>
              <CardBody>
                {sortedTopDown.map((lvl) => {
                  const inRank = completedRows.filter((r) => Math.round(Number(r.score)) === lvl.n);
                  return (
                    <div key={lvl.n} style={{ padding: '12px 0', borderTop: `1px dashed ${BORDER}` }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                        <div style={{ fontSize: 13, fontWeight: 850, color: INK }}>{formatFinalRank(lvl, config)}</div>
                        <span style={{ fontSize: 11.5, color: MUTED, fontWeight: 750 }}>{inRank.length} employees</span>
                      </div>
                      {inRank.length === 0 ? <div style={{ fontSize: 12, color: '#94A3B8' }}>No completed ratings at this rank.</div> : (
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 8 }}>
                          {inRank.map(({ emp, code, score, stages }) => (
                            <CalibratorRow key={code} emp={emp} code={code} currentScore={score} stages={stages} maxRank={scale.length} orgKey={orgKey} actor={userName || 'HR admin'} onChanged={() => setTick((t) => t + 1)} published={published} />
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </CardBody>
            </Card>
          </>
        )}

        {activeTab === 'employees' && (
          <Card>
            <CardHead>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
                <div>
                  <div style={{ fontSize: 16, fontWeight: 850, color: INK }}>Employee register</div>
                  <div style={{ fontSize: 12, color: MUTED, marginTop: 2 }}>Operational list with downloads and reminders. Rating differences appear only after manager completion.</div>
                </div>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search employee" style={{ width: 220, padding: '8px 10px', border: `1px solid ${BORDER}`, borderRadius: 9, fontSize: 12.5 }} />
                  <select value={groupFilter} onChange={(e) => setGroupFilter(e.target.value)} style={{ padding: '8px 10px', border: `1px solid ${BORDER}`, borderRadius: 9, fontSize: 12.5 }}>
                    <option value="all">All groups</option>
                    {groups.map((g) => <option key={g} value={g}>{g}</option>)}
                  </select>
                  <button type="button" onClick={downloadEmployeeRegister} style={btnStyle('ghost', false)}>Download CSV</button>
                  <button type="button" onClick={sendBulkReminders} style={btnStyle('primary', false)}>Send reminders</button>
                </div>
              </div>
            </CardHead>
            <CardBody>
              <EmployeeReviewTable rows={empRatings} scale={scale} config={config} orgKey={orgKey} actor={userName || 'HR admin'} published={published} onChanged={() => setTick((t) => t + 1)} onOpen={(code) => setSelectedCode(code)} onRemind={sendReminder} />
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
                <input
                  value={auditSearch}
                  onChange={(e) => setAuditSearch(e.target.value)}
                  placeholder="Search by name or code"
                  style={{ width: 240, padding: '8px 10px', border: `1px solid ${BORDER}`, borderRadius: 9, fontSize: 12.5 }}
                />
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
            row={selectedRow}
            orgKey={orgKey}
            config={config}
            scale={scale}
            onClose={() => setSelectedCode('')}
          />
        )}

        {toast && <div style={{ position: 'fixed', right: 22, bottom: 22, zIndex: 90, background: '#0F172A', color: '#fff', padding: '10px 14px', borderRadius: 10, boxShadow: '0 18px 40px rgba(15,23,42,.24)', fontSize: 12.5, fontWeight: 750 }}>{toast}</div>}
      </div>
    </div>
  );
}

function BellHero({ completed, total, calibrated, waitingOnSelf, waitingOnManager, bellMode }) {
  const completion = total ? Math.round((completed / total) * 100) : 0;
  return (
    <div style={{
      position: 'relative', overflow: 'hidden', borderRadius: 16, padding: 18, marginBottom: 16,
      background: 'linear-gradient(135deg, #1D4ED8 0%, #7C3AED 100%)',
      color: '#fff', boxShadow: '0 18px 50px rgba(37,99,235,.2)',
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
        <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8, padding: '5px 10px', borderRadius: 999, background: 'rgba(255,255,255,.14)', border: '1px solid rgba(255,255,255,.22)', fontSize: 11, fontWeight: 850, textTransform: 'uppercase', letterSpacing: '.06em' }}>
          Bell curve calibration · {bellMode}
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(110px, 1fr))', gap: 12, flex: 1, minWidth: 480 }}>
          <HeroMetric label="Completed" value={`${completed}/${total}`} sub={`${completion}% ready`} />
          <HeroMetric label="Calibrated" value={calibrated} sub="HR moves" />
          <HeroMetric label="Awaiting self" value={waitingOnSelf} sub="employee action" />
          <HeroMetric label="Awaiting manager" value={waitingOnManager} sub="remind from register" />
        </div>
      </div>
    </div>
  );
}

function HeroMetric({ label, value, sub }) {
  return (
    <div style={{ background: 'rgba(255,255,255,.13)', border: '1px solid rgba(255,255,255,.22)', borderRadius: 16, padding: 14, backdropFilter: 'blur(10px)' }}>
      <div style={{ fontSize: 10.5, fontWeight: 900, textTransform: 'uppercase', letterSpacing: '.08em', color: 'rgba(255,255,255,.66)' }}>{label}</div>
      <div style={{ fontSize: 26, fontWeight: 950, marginTop: 6 }}>{value}</div>
      <div style={{ fontSize: 11.5, color: 'rgba(255,255,255,.68)', marginTop: 2 }}>{sub}</div>
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
  'request-completion': { label: 'Asked to complete', color: '#D97706' },
  'calibrate': { label: 'Changed final rating', color: '#7C3AED' },
  'publish': { label: 'Published the cycle', color: '#16A34A' },
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

function AuditTable({ rows, empMap = {} }) {
  return (
    <div>
      {rows.slice().reverse().map((row, i) => {
        const meta = ACTION_META[row.action] || { label: row.action, color: '#64748B' };
        const empName = row.empCode ? (empMap[normalizeCode(row.empCode)] || row.empCode) : '';
        const changed = row.before !== undefined && row.after !== undefined;
        const actor = prettyActor(row.actor);
        return (
          <div key={i} style={{ display: 'flex', gap: 12, padding: '13px 4px', borderTop: i ? `1px solid ${BORDER}` : 'none', alignItems: 'flex-start' }}>
            <span style={{ width: 9, height: 9, borderRadius: 999, background: meta.color, marginTop: 5, flexShrink: 0 }} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 13, fontWeight: 800, color: '#0F172A' }}>{meta.label}</span>
                {changed && (
                  <span style={{ padding: '2px 9px', borderRadius: 999, background: '#F5F3FF', color: '#7C3AED', fontSize: 11.5, fontWeight: 800 }}>
                    {row.before} → {row.after}
                  </span>
                )}
              </div>
              <div style={{ fontSize: 12, color: '#64748B', marginTop: 3 }}>
                {empName && <>for <strong style={{ color: '#475569' }}>{empName}</strong></>}
                {empName && actor && ' · '}
                {actor && <>by {actor}</>}
              </div>
              {row.reason && (
                <div style={{ fontSize: 12, color: '#475569', marginTop: 4, fontStyle: 'italic' }}>“{row.reason}”</div>
              )}
            </div>
            <div style={{ fontSize: 11.5, color: '#94A3B8', whiteSpace: 'nowrap', marginTop: 1 }}>{formatWhen(row.ts)}</div>
          </div>
        );
      })}
    </div>
  );
}

function DistributionChart({ scale, targets, tolerances, actuals, counts = [], config }) {
  const max = Math.max(...targets, ...actuals, 1);
  return (
    <div style={{ display: 'flex', alignItems: 'flex-end', gap: 14, minHeight: 260, padding: '20px 0 28px' }}>
      {scale.map((lvl, i) => {
        const dataIndex = Math.max(0, Number(lvl.n) - 1);
        const target = targets[dataIndex] || 0;
        const actual = actuals[dataIndex] || 0;
        const tol = tolerances[dataIndex] || 0;
        const targetH = (target / max) * 190;
        const actualH = (actual / max) * 190;
        const tolH = (tol / max) * 190;
        const inRange = Math.abs(actual - target) <= tol;
        const actualColor = inRange ? GREEN : RED;
        return (
          <div key={lvl.n} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', minWidth: 0 }}>
            <div style={{ fontSize: 12, fontWeight: 900, color: actualColor, marginBottom: 8 }}>
              {actual}% <span style={{ color: '#94A3B8', fontWeight: 750 }}>({counts[dataIndex] || 0})</span>
            </div>
            <div style={{ position: 'relative', width: '100%', maxWidth: 120, height: 210, display: 'flex', alignItems: 'flex-end', justifyContent: 'center', gap: 8, padding: '0 8px' }}>
              <div style={{ position: 'absolute', left: '50%', transform: 'translateX(-50%)', bottom: 0, width: 78, height: targetH, background: 'linear-gradient(180deg, rgba(37,99,235,.22), rgba(124,58,237,.10))', borderRadius: '12px 12px 0 0', border: '1.5px dashed rgba(37,99,235,.55)' }} />
              <div style={{ position: 'relative', width: 38, height: Math.max(6, actualH), background: `linear-gradient(180deg, ${actualColor}, ${inRange ? '#22C55E' : '#EF4444'})`, borderRadius: '12px 12px 0 0', boxShadow: `0 14px 32px ${inRange ? 'rgba(22,163,74,.28)' : 'rgba(220,38,38,.25)'}` }} />
              {tol > 0 && (
                <div style={{
                  position: 'absolute', left: 5, right: 5,
                  bottom: Math.max(0, targetH - tolH),
                  height: Math.min(tolH * 2, targetH + tolH),
                  background: 'rgba(22,163,74,0.10)',
                  border: '1.5px dashed #16A34A',
                  borderRadius: 4, pointerEvents: 'none',
                }} />
              )}
            </div>
            <div style={{ fontSize: 11.5, color: '#475569', marginTop: 8, textAlign: 'center', lineHeight: 1.25, fontWeight: 800 }}>
              {formatFinalRank(lvl, config)}
            </div>
            <div style={{ fontSize: 10.5, color: '#94A3B8', marginTop: 3 }}>Target {target}% · ±{tol}%</div>
          </div>
        );
      })}
    </div>
  );
}

function ToleranceTable({ scale, targets, tolerances, actuals, counts, config }) {
  return (
    <div style={{ marginTop: 12, border: `1px solid ${BORDER}`, borderRadius: 10, overflow: 'hidden' }}>
      <div style={{ display: 'grid', gridTemplateColumns: '1.5fr 1fr 1fr 1fr 1fr', padding: '8px 12px', background: '#F8FAFC', fontSize: 11, fontWeight: 900, color: '#64748B', textTransform: 'uppercase' }}>
        <span>Rank</span><span>Target</span><span>Tolerance</span><span>Actual</span><span>Status</span>
      </div>
      {scale.map((lvl, i) => {
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

function CalibratorRow({ emp, code, currentScore, maxRank, orgKey, actor, onChanged, published, stages }) {
  const [showReason, setShowReason] = useState(false);
  const [reason, setReason] = useState('');
  const [pendingTarget, setPendingTarget] = useState(null);

  const move = (delta) => {
    const next = Math.max(1, Math.min(maxRank, Number(currentScore) + delta));
    if (next === Number(currentScore)) return;
    setPendingTarget(next);
    setShowReason(true);
  };
  const confirm = () => {
    if (!reason.trim()) return;
    recordCalibrationMove(orgKey, code, currentScore, pendingTarget, reason.trim(), actor);
    setShowReason(false); setReason(''); setPendingTarget(null);
    onChanged();
  };

  return (
    <div style={{ padding: 10, border: `1px solid ${BORDER}`, borderRadius: 8, background: '#fff' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <div style={{ fontSize: 12.5, fontWeight: 700, color: '#0F172A' }}>{emp['Employee Name'] || code}</div>
          <div style={{ fontSize: 10.5, color: '#64748B' }}>{emp['Role'] || emp['Designation'] || ''} · {code}</div>
        </div>
        {!published && (
          <div style={{ display: 'flex', gap: 4 }}>
            <button type="button" onClick={() => move(-1)} disabled={Number(currentScore) <= 1} style={miniBtn}>−</button>
            <button type="button" onClick={() => move(1)} disabled={Number(currentScore) >= maxRank} style={miniBtn}>+</button>
          </div>
        )}
      </div>
      {showReason && (
        <div style={{ marginTop: 8, padding: 8, background: '#FEF3C7', border: '1px solid #FDE68A', borderRadius: 8 }}>
          <div style={{ fontSize: 11.5, color: '#92400E', fontWeight: 700, marginBottom: 6 }}>
            Move {currentScore} → {pendingTarget}? Add a calibration reason:
          </div>
          <input
            value={reason} onChange={(e) => setReason(e.target.value)}
            placeholder="Reason for calibration"
            style={{ width: '100%', padding: 6, borderRadius: 6, border: `1px solid ${BORDER}`, fontSize: 12 }}
          />
          <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
            <button type="button" onClick={confirm} disabled={!reason.trim()} style={btnStyle('primary', !reason.trim())}>Confirm</button>
            <button type="button" onClick={() => { setShowReason(false); setReason(''); setPendingTarget(null); }} style={btnStyle('ghost', false)}>Cancel</button>
          </div>
        </div>
      )}
      {stages?.final?.calibrationNote && (
        <div style={{ marginTop: 6, fontSize: 11, color: '#7C3AED', fontStyle: 'italic' }}>
          Calibrated: {stages.final.calibrationNote}
        </div>
      )}
    </div>
  );
}

const miniBtn = {
  width: 26, height: 26, borderRadius: 6, border: `1px solid ${BORDER}`,
  background: '#fff', color: '#334155', fontSize: 14, fontWeight: 700,
  cursor: 'pointer', fontFamily: 'inherit',
};

function Header({ title, subtitle, right }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 18 }}>
      <div>
        <div style={{ fontSize: 24, fontWeight: 800, color: '#0F172A' }}>{title}</div>
        <div style={{ fontSize: 13, color: '#64748B', marginTop: 4 }}>{subtitle}</div>
      </div>
      {right}
    </div>
  );
}
function PillStatus({ label, color }) {
  return <span style={{ padding: '5px 11px', borderRadius: 999, background: `${color}1A`, color, fontSize: 12, fontWeight: 700 }}>{label}</span>;
}
function Card({ children }) {
  return <div style={{ background: '#fff', border: `1px solid ${BORDER}`, borderRadius: 12, marginBottom: 14, overflow: 'hidden' }}>{children}</div>;
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
