import { useState, useMemo, useEffect, useRef } from 'react';
import { useApp } from '../AppContext';
import { LaunchOverview, OrgChartPanel } from '../PMSWizard';
import zaroLogo from '../../images/final zaro logo.png';
import { downloadEmployeeTemplate, parseEmployeeXlsx, employeeTemplateMeta } from '../templateUtils';
import { BRAND_PALETTES, resolveBrandPalette, deriveCustomPalette, buildHeroGradient, buildSwatchGradient, buildHeroBackground, resolveHero, fillAccent, CARD_ACCENT_MODES, CARD_PREVIEW_TINTS, normalizeCardsMode, cardStripeWidth } from '../brandPalettes';
import {
  readWorkflowSync,
  persistWorkflow,
  hydrateWorkflow,
  readWizardStateSync,
  persistWizardState,
  hydrateWizardState,
  readEmployeeCredentialsSync,
  persistEmployeeCredentials,
  persistEmployeeSession,
} from '../backend/stateStore';
import { resetUserPasswordByAdmin } from '../backend/authService';
import { sendCustomBroadcast, sendManagerSummaryEmails } from '../backend/emailService';
import { hashPasswordValue } from '../backend/passwordCrypto';
import { logAuditEvent } from '../backend/auditLog';
import {
  getDefaultSmtpSettings,
  loadOrgSmtpSettings,
  saveOrgSmtpSettings,
  sendOrgSmtpTestEmail,
  verifyOrgSmtpConnection,
} from '../backend/emailSmtpService';

const WIZARD_STATE_KEY = 'zarohr_pms_wizard_state_v1';
const GOAL_WORKFLOW_KEY = 'zarohr_goal_workflow_v1';

/* ── Workflow helpers (shared shape with EmployeePage) ───── */
function normalizeCodeStr(value) { return String(value || '').trim().toLowerCase(); }
function workflowStorageKey(orgKey) { return `${GOAL_WORKFLOW_KEY}:${orgKey || 'default'}`; }
function loadWorkflowState(orgKey) {
  if (!orgKey) return { submissions: {}, notifications: [] };
  return readWorkflowSync(orgKey);
}
function saveWorkflowState(orgKey, wf) {
  if (!orgKey) return;
  persistWorkflow(orgKey, wf);
}

function resolveEmployeeEmail(emp = {}) {
  return (
    emp['Email ID'] ||
    emp.Email ||
    emp.email ||
    emp['Work Email'] ||
    emp['Official Email'] ||
    emp['Email Address'] ||
    ''
  );
}
// Map a PMS stage id → the matching submission.status.
function stageToStatus(stageId) {
  if (stageId === 'goal-creation') return 'draft';
  if (stageId === 'pending-approval') return 'pending-manager';
  // Everything past approval is considered approved from a submission perspective.
  return 'approved';
}
function makeNotif(type, { recipientCode, senderCode = '', title, message, submissionCode = '' }) {
  return {
    id: `notif_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    type,
    recipientCode: normalizeCodeStr(recipientCode),
    senderCode: normalizeCodeStr(senderCode),
    submissionCode: normalizeCodeStr(submissionCode),
    title,
    message,
    createdAt: new Date().toISOString(),
    read: false,
  };
}

/**
 * Read an image file and return a compressed data URL.
 *
 * Two gates: pixel dimensions AND byte size. Either one triggers a canvas re-encode.
 * Previously we only re-encoded when dimensions exceeded `maxDim`, so a 3 MB 800×600 PNG
 * passed through raw — which overflows the ~5 MB localStorage quota silently and the
 * image appeared to "not save". Now we also re-encode anything larger than `maxBytes`.
 *
 * `forceMime` lets the caller pick the output format — hero images pass 'image/jpeg' since
 * hero backgrounds never need alpha, and JPEG compresses photos 5-10× better than PNG.
 */
function readImageAsDataUrl(file, {
  maxDim = 512,
  quality = 0.92,
  maxBytes = 250 * 1024,
  forceMime = null,
} = {}) {
  return new Promise((resolve, reject) => {
    if (!file) { reject(new Error('No file')); return; }
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error || new Error('Could not read file'));
    reader.onload = () => {
      const raw = reader.result;
      // SVGs are tiny vectors — no point in rasterising them.
      if (file.type === 'image/svg+xml') { resolve(raw); return; }
      const img = new Image();
      img.onerror = () => resolve(raw);
      img.onload = () => {
        const largestDim = Math.max(img.width, img.height);
        const dimScale = Math.min(1, maxDim / largestDim);
        // Separate byte-budget scale: base64 inflates ~33%, so the actual stored size is
        // ~1.33× the file size. If the source is already well under the byte budget AND
        // fits the dimension budget, skip the canvas round-trip entirely.
        if (dimScale >= 1 && file.size <= maxBytes && !forceMime) { resolve(raw); return; }
        // Need to re-encode. Start with dim scale; if that alone isn't aggressive enough
        // to hit the byte budget, shrink further. Bytes scale with area (≈ scale²), so
        // take the sqrt of the ratio to estimate the extra downscale needed.
        let scale = dimScale;
        if (file.size > maxBytes) {
          const byteScale = Math.sqrt(maxBytes / file.size);
          scale = Math.min(scale, byteScale);
        }
        const w = Math.max(1, Math.round(img.width * scale));
        const h = Math.max(1, Math.round(img.height * scale));
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        const ctx = canvas.getContext('2d');
        // White fill first so JPEGs of PNGs-with-transparency don't render black backgrounds.
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, w, h);
        ctx.drawImage(img, 0, 0, w, h);
        const mime = forceMime || (file.type === 'image/png' ? 'image/png' : 'image/jpeg');
        try { resolve(canvas.toDataURL(mime, quality)); }
        catch { resolve(raw); }
      };
      img.src = raw;
    };
    reader.readAsDataURL(file);
  });
}

function isImageFile(file) {
  if (!file) return false;
  if (file.type?.startsWith('image/')) return true;
  return /\.(png|jpe?g|gif|webp|svg)$/i.test(file.name || '');
}

/* ── Shared Upload Sheet button (matches PMSWizard style) ─── */
function UploadSheetButton({ onDownload, fileRef, phase = 'idle' }) {
  const wrapRef = useRef(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    function handlePointerDown(event) {
      if (wrapRef.current && !wrapRef.current.contains(event.target)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handlePointerDown);
    return () => document.removeEventListener('mousedown', handlePointerDown);
  }, [open]);

  return (
    <div ref={wrapRef} style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'flex-end', gap: 6 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <button
          type="button"
          onClick={() => setOpen(prev => !prev)}
          style={{
            fontSize: 12.5,
            color: phase === 'parsing' ? '#94A3B8' : '#2563EB',
            background: open ? '#FFFFFF' : '#F8FAFC',
            border: '1px solid #D7E3F4',
            borderRadius: 12,
            padding: '7px 13px',
            minWidth: 108,
            cursor: 'pointer',
            fontWeight: 700,
            fontFamily: 'inherit',
          }}
        >
          {phase === 'parsing' ? 'Uploading…' : 'Upload Sheet'}
        </button>
        <button
          type="button"
          onClick={onDownload}
          title="Download template"
          aria-label="Download template"
          style={{
            width: open ? 34 : 0,
            opacity: open ? 1 : 0,
            overflow: 'hidden',
            padding: '7px 0',
            border: open ? '1px solid #D6E4FF' : '1px solid transparent',
            background: '#FFFFFF',
            color: '#2563EB',
            borderRadius: 10,
            cursor: open ? 'pointer' : 'default',
            fontSize: 17,
            lineHeight: 1,
            transition: 'width .18s ease, opacity .18s ease',
            pointerEvents: open ? 'auto' : 'none',
            fontFamily: 'inherit',
          }}
        >
          ⬇
        </button>
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          title="Upload sheet"
          aria-label="Upload sheet"
          disabled={!open || phase === 'parsing'}
          style={{
            width: open ? 34 : 0,
            opacity: open ? 1 : 0,
            overflow: 'hidden',
            padding: '7px 0',
            border: open ? '1px solid #D6E4FF' : '1px solid transparent',
            background: '#F8FBFF',
            color: phase === 'parsing' ? '#94A3B8' : '#2563EB',
            borderRadius: 10,
            cursor: !open || phase === 'parsing' ? 'default' : 'pointer',
            fontSize: 17,
            lineHeight: 1,
            transition: 'width .18s ease, opacity .18s ease',
            pointerEvents: open ? 'auto' : 'none',
            fontFamily: 'inherit',
          }}
        >
          ⬆
        </button>
      </div>
    </div>
  );
}

/* ── PMS employee stages ─────────────────────────────────── */
const EMP_STAGES = [
  { id: 'goal-creation',    label: 'Goal Creation',       short: 'Goal Creation',    color: '#4F46E5', bg: '#EEF2FF', border: '#C7D2FE' },
  { id: 'pending-approval', label: 'Pending Approval',    short: 'Pending Approval', color: '#D97706', bg: '#FFFBEB', border: '#FDE68A' },
  { id: 'self-evaluation',  label: 'Self Evaluation',     short: 'Self Eval',        color: '#0891B2', bg: '#ECFEFF', border: '#A5F3FC' },
  { id: 'mgr-evaluation',   label: 'Manager Evaluation',  short: 'Manager Eval',     color: '#7C3AED', bg: '#F5F3FF', border: '#DDD6FE' },
  { id: 'completed',        label: 'Completed',           short: 'Completed',        color: '#16A34A', bg: '#F0FDF4', border: '#BBF7D0' },
];
function getEmpStage(emp) { return emp._pmsStage || 'goal-creation'; }

/* ── persistence ─────────────────────────────────────────── */
function loadWizardConfig(orgKey) {
  const p = readWizardStateSync(orgKey);
  return p?.config || null;
}
function saveWizardConfig(orgKey, newConfig) {
  const base = readWizardStateSync(orgKey) || {};
  persistWizardState(orgKey, { ...base, config: newConfig });
}

/* ── confetti ─────────────────────────────────────────────── */
const CONFETTI_COLORS = ['#4F46E5','#22C55E','#F59E0B','#EC4899','#06B6D4','#8B5CF6'];
function Confetti() {
  const pieces = useMemo(() => Array.from({ length: 36 }, (_, i) => ({
    id: i, left: Math.random() * 100, delay: Math.random() * 1.2,
    dur: 1.8 + Math.random() * 1.2, size: 6 + Math.random() * 6,
    color: CONFETTI_COLORS[i % CONFETTI_COLORS.length],
  })), []);
  return (
    <div style={{ position: 'fixed', inset: 0, pointerEvents: 'none', zIndex: 999, overflow: 'hidden' }}>
      <style>{`@keyframes cf{0%{transform:translateY(-20px) rotate(0);opacity:1}100%{transform:translateY(105vh) rotate(720deg);opacity:0}}`}</style>
      {pieces.map((p) => (
        <div key={p.id} style={{ position: 'absolute', left: `${p.left}%`, top: 0, width: p.size, height: p.size, borderRadius: p.id % 2 === 0 ? '50%' : '2px', background: p.color, animation: `cf ${p.dur}s ${p.delay}s ease-in forwards` }} />
      ))}
    </div>
  );
}

/* ── shared tiny components ──────────────────────────────── */
function MiniBar({ value, max, color }) {
  const pct = max > 0 ? Math.min(value / max, 1) : 0;
  return (
    <div style={{ height: 5, borderRadius: 99, background: '#E9EDF2', overflow: 'hidden' }}>
      <div style={{ height: '100%', width: `${pct * 100}%`, background: color, borderRadius: 99, transition: 'width 600ms ease' }} />
    </div>
  );
}
function StagePill({ stageId }) {
  const s = EMP_STAGES.find((x) => x.id === stageId) || EMP_STAGES[0];
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11.5, fontWeight: 600, color: s.color, background: s.bg, border: `1px solid ${s.border}`, borderRadius: 999, padding: '3px 10px', whiteSpace: 'nowrap' }}>
      <span style={{ width: 6, height: 6, borderRadius: '50%', background: s.color, flexShrink: 0 }} />
      {s.label}
    </span>
  );
}
function getInitials(name) {
  const parts = String(name || '').trim().split(/\s+/);
  return (parts[0]?.[0] || '').concat(parts[1]?.[0] || '').toUpperCase() || '?';
}

function OrganogramIcon({ size = 16, color = '#0F172A' }) {
  // Minimal hierarchy-tree glyph: one parent node with two children connected by clean lines.
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="9" y="2.5" width="6" height="5" rx="1.3" stroke={color} strokeWidth="1.7" />
      <rect x="2" y="16.5" width="6" height="5" rx="1.3" stroke={color} strokeWidth="1.7" />
      <rect x="16" y="16.5" width="6" height="5" rx="1.3" stroke={color} strokeWidth="1.7" />
      <path d="M12 7.5V11M5 16.5V12.5h14v4" stroke={color} strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/* ── xlsx bulk helpers ───────────────────────────────────── */
let _xlsxMod = null;
async function loadXLSX() {
  if (!_xlsxMod) _xlsxMod = await import('xlsx');
  return _xlsxMod;
}
function readFileAsArrayBuffer(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => resolve(e.target.result);
    reader.onerror = reject;
    reader.readAsArrayBuffer(file);
  });
}
async function parseSingleColXlsx(file) {
  try {
    const XLSX = await loadXLSX();
    const buf = await readFileAsArrayBuffer(file);
    const wb = XLSX.read(buf, { type: 'array' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1 });
    return rows.slice(1).map((r) => String(r[0] || '').trim()).filter(Boolean);
  } catch { return []; }
}
async function parseTwoColXlsx(file) {
  try {
    const XLSX = await loadXLSX();
    const buf = await readFileAsArrayBuffer(file);
    const wb = XLSX.read(buf, { type: 'array' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1 });
    return rows.slice(1).map((r) => ({ col1: String(r[0] || '').trim(), col2: String(r[1] || '').trim() })).filter((r) => r.col1);
  } catch { return []; }
}
function downloadCsvTemplate(filename, headers, example) {
  const blob = new Blob([[headers, example].map((r) => r.join(',')).join('\n')], { type: 'text/csv' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = filename; a.click();
}
// Parse first sheet using row 0 as headers; returns array of plain objects keyed by header name.
async function parseObjectsXlsx(file) {
  try {
    const XLSX = await loadXLSX();
    const buf = await readFileAsArrayBuffer(file);
    const wb = XLSX.read(buf, { type: 'array' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    return XLSX.utils.sheet_to_json(ws, { defval: '' });
  } catch { return []; }
}

// Reporting managers referenced by code but not themselves uploaded as employees.
// They show up alongside regular employees in admin lists. Their email lives on
// the children's "Reporting Manager Email" field — `_external` flags the row so
// updates can fan out to every child that reports to them.
function synthesizeExternalManagers(employees) {
  const byCode = new Map();
  employees.forEach((e) => byCode.set(String(e['Employee Code'] || '').trim().toLowerCase(), e));
  const map = new Map();
  employees.forEach((e) => {
    const raw = String(e['Reporting Manager Code'] || '').trim();
    if (!raw) return;
    const lower = raw.toLowerCase();
    if (byCode.has(lower)) return;
    if (map.has(lower)) { map.get(lower)._reportsCount += 1; return; }
    const name = String(e['Reporting Manager Name'] || '').trim() || raw;
    const email = String(e['Reporting Manager Email'] || '').trim();
    map.set(lower, {
      'Employee Code': raw,
      'Employee Name': name,
      'Email ID': email,
      'Designation': '',
      _external: true,
      _reportsCount: 1,
    });
  });
  return Array.from(map.values()).sort((a, b) => (a['Employee Name'] || '').localeCompare(b['Employee Name'] || ''));
}

// Combined roster: real employees + synthesized external-manager rows.
function buildRoster(employees) {
  return [...employees, ...synthesizeExternalManagers(employees)];
}

// Patch an email onto an employee. For a regular row it updates "Email ID".
// For an external manager row it walks every child whose Reporting Manager Code
// matches and updates their "Reporting Manager Email" — that is where the value
// is actually stored.
function applyEmailPatch(employees, code, newEmail) {
  const lower = String(code || '').trim().toLowerCase();
  const realIdx = employees.findIndex((e) => String(e['Employee Code'] || '').trim().toLowerCase() === lower);
  if (realIdx >= 0) {
    return employees.map((e, i) => i === realIdx ? { ...e, 'Email ID': newEmail } : e);
  }
  return employees.map((e) => {
    if (String(e['Reporting Manager Code'] || '').trim().toLowerCase() === lower) {
      return { ...e, 'Reporting Manager Email': newEmail };
    }
    return e;
  });
}

/* ══════════════════════════════════════════════════════════════
   NAV MODULES definition
══════════════════════════════════════════════════════════════ */
const NAV_MODULES = [
  { id: 'overview',    icon: '🏠', label: 'Overview',            group: 'main' },
  { id: 'emp-status',  icon: '👥', label: 'Employee Status',     group: 'main' },
  { id: 'comms',       icon: '✉️',  label: 'Communications',      group: 'ops' },
  { id: 'stage',       icon: '🔀', label: 'Stage Control',       group: 'ops' },
  { id: 'mgr-change',  icon: '👤', label: 'Manager Change',      group: 'ops' },
  { id: 'grp-transfer',icon: '📦', label: 'Group Transfer',      group: 'ops' },
  { id: 'roster',      icon: '📋', label: 'Add / Remove',        group: 'ops' },
  { id: 'test-creds',  icon: '👁',  label: 'View as Proxy',       group: 'dev' },
  { id: 'hr-team',     icon: '🛡',  label: 'HR Team',             group: 'dev' },
  { id: 'email-settings', icon: '📨', label: 'Email Settings',    group: 'dev' },
  { id: 'config',      icon: '⚙️',  label: 'Configuration',       group: 'dev' },
];

/* ══════════════════════════════════════════════════════════════
   MODULE VIEWS
══════════════════════════════════════════════════════════════ */

/* ── Donut / Pie chart (CSS conic-gradient) ─────────────────── */
function DonutChart({ slices, size = 120, thickness = 28, label, subLabel }) {
  // slices: [{ color, value }]
  const total = slices.reduce((s, x) => s + x.value, 0) || 1;
  let cursor = 0;
  const gradient = slices.map((s) => {
    const pct = (s.value / total) * 100;
    const from = cursor; cursor += pct;
    return `${s.color} ${from.toFixed(1)}% ${cursor.toFixed(1)}%`;
  }).join(', ');
  const inner = size - thickness * 2;
  return (
    <div style={{ position: 'relative', width: size, height: size, flexShrink: 0 }}>
      <div style={{ width: size, height: size, borderRadius: '50%', background: `conic-gradient(${gradient})` }} />
      <div style={{ position: 'absolute', top: thickness, left: thickness, width: inner, height: inner, borderRadius: '50%', background: '#fff', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
        {label && <div style={{ fontSize: 16, fontWeight: 800, color: '#0D1117', lineHeight: 1 }}>{label}</div>}
        {subLabel && <div style={{ fontSize: 10, color: '#94A3B8', marginTop: 2 }}>{subLabel}</div>}
      </div>
    </div>
  );
}

/* ── Overview ──────────────────────────────────────────────── */
function ModuleOverview({ employees, groups, orgName, congratsDismissed, onDismiss, showConfetti }) {
  const stageSummary = useMemo(() => {
    const c = {}; EMP_STAGES.forEach((s) => { c[s.id] = 0; });
    employees.forEach((e) => { const s = getEmpStage(e); c[s] = (c[s] || 0) + 1; });
    return c;
  }, [employees]);

  const groupCounts = useMemo(() => {
    const c = {};
    employees.forEach((e) => { const g = e['Group Name'] || e.assignedGoalGroupName || 'Unassigned'; c[g] = (c[g] || 0) + 1; });
    return c;
  }, [employees]);
  const GROUP_COLORS = ['#4F46E5', '#0891B2', '#16A34A', '#D97706', '#7C3AED', '#EC4899', '#EF4444', '#14B8A6'];
  const groupRows = Object.entries(groupCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([name, value], i) => ({ name, value, color: GROUP_COLORS[i % GROUP_COLORS.length] }));

  const allCodes = useMemo(() => new Set(employees.map((e) => String(e['Employee Code'] || '').trim().toLowerCase())), [employees]);
  const externalManagerCount = useMemo(() => employees.filter((e) => {
    const mgr = String(e['Reporting Manager Code'] || '').trim().toLowerCase();
    return mgr && !allCodes.has(mgr);
  }).length, [employees, allCodes]);
  const noManagerCount = useMemo(() => employees.filter((e) => !String(e['Reporting Manager Code'] || '').trim()).length, [employees]);

  const total = employees.length;
  const completed = stageSummary['completed'] || 0;
  const inEvaluation = (stageSummary['self-evaluation'] || 0) + (stageSummary['mgr-evaluation'] || 0);
  const completionPct = total > 0 ? Math.round((completed / total) * 100) : 0;

  const statCards = [
    { label: 'Total Employees', value: total,                              color: '#4F46E5', bg: 'linear-gradient(135deg,#EEF2FF 0%,#FFFFFF 100%)' },
    { label: 'In Goal Creation', value: stageSummary['goal-creation'] || 0, color: '#4F46E5', bg: 'linear-gradient(135deg,#EEF2FF 0%,#FFFFFF 100%)' },
    { label: 'Pending Approval', value: stageSummary['pending-approval'] || 0, color: '#D97706', bg: 'linear-gradient(135deg,#FFFBEB 0%,#FFFFFF 100%)' },
    { label: 'In Evaluation',    value: inEvaluation,                       color: '#0891B2', bg: 'linear-gradient(135deg,#ECFEFF 0%,#FFFFFF 100%)' },
    { label: 'Completed',        value: completed,                          color: '#16A34A', bg: 'linear-gradient(135deg,#F0FDF4 0%,#FFFFFF 100%)' },
  ];

  return (
    <div>
      <style>{`@keyframes popIn{from{transform:scale(0.5);opacity:0}to{transform:scale(1);opacity:1}}@keyframes slideUp{from{transform:translateY(12px);opacity:0}to{transform:translateY(0);opacity:1}}@keyframes barGrow{from{width:0}to{width:var(--w)}}`}</style>
      {showConfetti && <Confetti />}
      {!congratsDismissed && (
        <div style={{ background: 'linear-gradient(135deg,#1E1B4B 0%,#312E81 50%,#4338CA 100%)', borderRadius: 14, padding: '24px 28px', marginBottom: 20, color: '#fff', position: 'relative', overflow: 'hidden' }}>
          <div style={{ position: 'absolute', right: -30, top: -30, width: 180, height: 180, borderRadius: '50%', background: 'rgba(255,255,255,.05)', pointerEvents: 'none' }} />
          <div style={{ fontSize: 32, animation: 'popIn 0.5s ease', marginBottom: 6 }}>🎉</div>
          <div style={{ fontSize: 20, fontWeight: 800, marginBottom: 6, animation: 'slideUp 0.5s 0.1s ease both' }}>Goal Setting is Live for {orgName}!</div>
          <div style={{ fontSize: 13.5, color: '#C7D2FE', lineHeight: 1.6, animation: 'slideUp 0.5s 0.2s ease both' }}>
            PMS is configured and live. Employees can now log in and start setting their goals.
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 14, flexWrap: 'wrap', animation: 'slideUp 0.5s 0.3s ease both' }}>
            {[`${total} Employees enrolled`, `${groups.length} Group${groups.length !== 1 ? 's' : ''} configured`].map((t) => (
              <span key={t} style={{ fontSize: 12, background: 'rgba(255,255,255,.12)', border: '1px solid rgba(255,255,255,.2)', borderRadius: 20, padding: '4px 12px', color: '#E0E7FF' }}>{t}</span>
            ))}
          </div>
          <button type="button" onClick={onDismiss} style={{ position: 'absolute', top: 12, right: 14, background: 'rgba(255,255,255,.12)', border: 'none', color: '#E0E7FF', borderRadius: 6, padding: '3px 8px', cursor: 'pointer', fontSize: 12, fontFamily: 'inherit' }}>Dismiss</button>
        </div>
      )}

      {/* Operational stat strip */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 12, marginBottom: 20 }}>
        {statCards.map((s) => (
          <div key={s.label} style={{ background: s.bg, border: '1px solid #E9EDF2', borderRadius: 14, padding: '16px 18px', position: 'relative', overflow: 'hidden' }}>
            <div style={{ fontSize: 11, color: '#64748B', fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase', marginBottom: 6 }}>{s.label}</div>
            <div style={{ fontSize: 30, fontWeight: 800, color: s.color, lineHeight: 1 }}>{s.value}</div>
            {total > 0 && s.label !== 'Total Employees' && (
              <div style={{ fontSize: 11, color: '#94A3B8', marginTop: 6 }}>{Math.round((s.value / total) * 100)}% of total</div>
            )}
          </div>
        ))}
      </div>

      {/* Cycle Progress funnel */}
      <div style={{ background: '#fff', border: '1px solid #E9EDF2', borderRadius: 14, padding: '20px 22px', marginBottom: 20 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 16, gap: 12, flexWrap: 'wrap' }}>
          <div>
            <div style={{ fontSize: 15, fontWeight: 800, color: '#0F172A' }}>Cycle Progress</div>
            <div style={{ fontSize: 12, color: '#64748B', marginTop: 2 }}>Where every employee is in the PMS flow right now.</div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: '#F0FDF4', border: '1px solid #BBF7D0', borderRadius: 999, padding: '4px 12px' }}>
            <span style={{ fontSize: 13, fontWeight: 800, color: '#16A34A' }}>{completionPct}%</span>
            <span style={{ fontSize: 11.5, color: '#15803D', fontWeight: 600 }}>complete</span>
          </div>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: `repeat(${EMP_STAGES.length}, 1fr)`, gap: 10 }}>
          {EMP_STAGES.map((s, i) => {
            const count = stageSummary[s.id] || 0;
            const pct = total > 0 ? (count / total) * 100 : 0;
            const isLast = i === EMP_STAGES.length - 1;
            return (
              <div key={s.id} style={{ position: 'relative', borderRadius: 12, border: `1.5px solid ${count > 0 ? s.border : '#F1F5F9'}`, background: count > 0 ? s.bg : '#FBFCFE', padding: '14px 14px 12px', transition: 'all 240ms ease' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 10 }}>
                  <span style={{ width: 8, height: 8, borderRadius: '50%', background: s.color, flexShrink: 0 }} />
                  <span style={{ fontSize: 11.5, fontWeight: 700, color: count > 0 ? s.color : '#94A3B8', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{s.short}</span>
                </div>
                <div style={{ fontSize: 26, fontWeight: 800, color: count > 0 ? s.color : '#CBD5E1', lineHeight: 1, marginBottom: 8 }}>{count}</div>
                <div style={{ height: 4, borderRadius: 99, background: '#F1F5F9', overflow: 'hidden' }}>
                  <div style={{ height: '100%', borderRadius: 99, background: s.color, width: `${pct}%`, transition: 'width 600ms ease' }} />
                </div>
                {!isLast && (
                  <div style={{ position: 'absolute', right: -7, top: '50%', transform: 'translateY(-50%)', width: 14, height: 14, borderRadius: '50%', background: '#fff', border: '1.5px solid #E2E8F0', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#94A3B8', fontSize: 9, fontWeight: 700, zIndex: 2 }}>›</div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Quick Insights + Group breakdown row */}
      <div style={{ display: 'grid', gridTemplateColumns: '1.4fr 1fr', gap: 14, marginBottom: 20 }}>
        {/* Quick Insights */}
        <div style={{ background: '#fff', border: '1px solid #E9EDF2', borderRadius: 14, padding: '18px 20px' }}>
          <div style={{ fontSize: 13.5, fontWeight: 800, color: '#0F172A', marginBottom: 12 }}>Quick Insights</div>
          {total === 0 ? (
            <div style={{ fontSize: 12.5, color: '#94A3B8' }}>Add employees to see insights.</div>
          ) : (
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              {(() => {
                const insights = [];
                const goalCreationPct = Math.round(((stageSummary['goal-creation'] || 0) / total) * 100);
                const pendingPct = Math.round(((stageSummary['pending-approval'] || 0) / total) * 100);
                const topGroup = groupRows[0];
                if (goalCreationPct > 0) insights.push({ text: `${goalCreationPct}% in goal creation`, color: '#FFFBEB', border: '#FDE68A', tc: '#92400E', dot: '#D97706' });
                if (pendingPct > 0) insights.push({ text: `${pendingPct}% awaiting approval`, color: '#FEF2F2', border: '#FECACA', tc: '#991B1B', dot: '#DC2626' });
                if (topGroup && groupRows.length > 1) insights.push({ text: `Largest group: ${topGroup.name} (${topGroup.value})`, color: '#EEF2FF', border: '#C7D2FE', tc: '#3730A3', dot: '#4F46E5' });
                if (externalManagerCount > 0) insights.push({ text: `${externalManagerCount} report to managers outside the upload`, color: '#FFF7ED', border: '#FED7AA', tc: '#9A3412', dot: '#EA580C' });
                if (noManagerCount > 0) insights.push({ text: `${noManagerCount} have no manager assigned`, color: '#FEF2F2', border: '#FECACA', tc: '#991B1B', dot: '#DC2626' });
                if (insights.length === 0) insights.push({ text: 'Everything looks healthy.', color: '#F0FDF4', border: '#BBF7D0', tc: '#166534', dot: '#16A34A' });
                return insights.map((ins, i) => (
                  <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, background: ins.color, border: `1px solid ${ins.border}`, borderRadius: 999, padding: '6px 14px' }}>
                    <span style={{ width: 7, height: 7, borderRadius: '50%', background: ins.dot, flexShrink: 0 }} />
                    <span style={{ fontSize: 12, fontWeight: 600, color: ins.tc }}>{ins.text}</span>
                  </div>
                ));
              })()}
            </div>
          )}
        </div>

        {/* By Group bar list */}
        <div style={{ background: '#fff', border: '1px solid #E9EDF2', borderRadius: 14, padding: '18px 20px' }}>
          <div style={{ fontSize: 13.5, fontWeight: 800, color: '#0F172A', marginBottom: 12 }}>Employees by Group</div>
          {groupRows.length === 0 ? (
            <div style={{ fontSize: 12.5, color: '#94A3B8' }}>No groups yet.</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {groupRows.map((g) => {
                const pct = total > 0 ? Math.round((g.value / total) * 100) : 0;
                return (
                  <div key={g.name}>
                    <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 5, gap: 8 }}>
                      <span style={{ fontSize: 12.5, fontWeight: 600, color: '#374151', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>{g.name}</span>
                      <span style={{ fontSize: 12, fontWeight: 700, color: g.color, flexShrink: 0 }}>{g.value} <span style={{ color: '#94A3B8', fontWeight: 500 }}>· {pct}%</span></span>
                    </div>
                    <div style={{ height: 6, borderRadius: 99, background: '#F1F5F9', overflow: 'hidden' }}>
                      <div style={{ height: '100%', borderRadius: 99, background: g.color, width: `${pct}%`, transition: 'width 600ms ease' }} />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ── Employee Status ────────────────────────────────────────── */
function LoginStatusPill({ status }) {
  const map = {
    permanent: { label: 'Password Set',   color: '#15803D', bg: '#F0FDF4', border: '#BBF7D0' },
    temp:      { label: 'Temp Password',  color: '#B45309', bg: '#FFFBEB', border: '#FDE68A' },
    none:      { label: 'Not Activated',  color: '#64748B', bg: '#F8FAFC', border: '#E2E8F0' },
  };
  const s = map[status] || map.none;
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11, fontWeight: 600, color: s.color, background: s.bg, border: `1px solid ${s.border}`, borderRadius: 999, padding: '3px 9px', whiteSpace: 'nowrap' }}>
      <span style={{ width: 6, height: 6, borderRadius: '50%', background: s.color, flexShrink: 0 }} />
      {s.label}
    </span>
  );
}

async function downloadEmpStatusExcel({ employees, credentials, workflow, orgName }) {
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Zaro HR';
  wb.created = new Date();

  const ws = wb.addWorksheet('Employee Status', { views: [{ state: 'frozen', ySplit: 2 }] });

  const COLS = [
    { header: 'Employee Name',      key: 'name',       width: 24 },
    { header: 'Employee Code',      key: 'code',       width: 14 },
    { header: 'Designation',        key: 'desig',      width: 22 },
    { header: 'Group',              key: 'group',      width: 18 },
    { header: 'Manager Name',       key: 'mgrName',    width: 22 },
    { header: 'Manager Code',       key: 'mgrCode',    width: 14 },
    { header: 'PMS Stage',          key: 'stage',      width: 20 },
    { header: 'Login Status',       key: 'loginStatus',width: 18 },
    { header: 'Goals Submitted',    key: 'goalsCount', width: 16 },
    { header: 'Submission Status',  key: 'subStatus',  width: 20 },
  ];
  ws.columns = COLS;

  // Title row
  ws.insertRow(1, []);
  ws.mergeCells(`A1:${String.fromCharCode(64 + COLS.length)}1`);
  const titleCell = ws.getCell('A1');
  titleCell.value = `${orgName || 'Organization'} — Employee Status Report`;
  titleCell.font = { name: 'Calibri', size: 13, bold: true, color: { argb: 'FFFFFFFF' } };
  titleCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1D4ED8' } };
  titleCell.alignment = { vertical: 'middle', horizontal: 'left', indent: 2 };
  ws.getRow(1).height = 28;

  // Header row (row 2)
  const hRow = ws.getRow(2);
  COLS.forEach((col, i) => {
    const cell = hRow.getCell(i + 1);
    cell.value = col.header;
    cell.font = { name: 'Calibri', size: 10.5, bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E3A8A' } };
    cell.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };
    cell.border = { bottom: { style: 'thin', color: { argb: 'FF1D4ED8' } } };
  });
  hRow.height = 20;

  const loginStatusLabel = (code) => {
    const cred = credentials[code] || credentials[String(code || '').toLowerCase()];
    if (!cred) return 'Not Activated';
    return cred.isTemp ? 'Temp Password' : 'Password Set';
  };

  employees.forEach((emp, i) => {
    const code = String(emp['Employee Code'] || '').trim();
    const sub  = workflow?.submissions?.[code.toLowerCase()] || workflow?.submissions?.[code] || {};
    const goals = Array.isArray(sub.goals) ? sub.goals.length : 0;
    const stage = EMP_STAGES.find((s) => s.id === getEmpStage(emp))?.label || getEmpStage(emp);

    const dataRow = ws.addRow({
      name:       emp['Employee Name'] || '',
      code,
      desig:      emp.Designation || emp.Role || '',
      group:      emp['Group Name'] || emp.assignedGoalGroupName || '',
      mgrName:    emp['Reporting Manager Name'] || '',
      mgrCode:    emp['Reporting Manager Code'] || '',
      stage,
      loginStatus: loginStatusLabel(code),
      goalsCount:  goals,
      subStatus:   sub.status || 'not started',
    });
    const isAlt = i % 2 !== 0;
    dataRow.eachCell((cell) => {
      cell.font = { name: 'Calibri', size: 10.5 };
      cell.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };
      if (isAlt) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF8FAFC' } };
      cell.border = { bottom: { style: 'hair', color: { argb: 'FFE2E8F0' } } };
    });
    dataRow.height = 18;
  });

  // Auto-filter on header row
  ws.autoFilter = { from: { row: 2, column: 1 }, to: { row: 2, column: COLS.length } };

  const buf = await wb.xlsx.writeBuffer();
  const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `employee-status-${new Date().toISOString().slice(0, 10)}.xlsx`;
  a.click(); URL.revokeObjectURL(url);
}

function ModuleEmpStatus({ employees, groups, orgKey, org }) {
  const [search, setSearch]           = useState('');
  const [filterStage, setFilterStage] = useState('');
  const [filterGroup, setFilterGroup] = useState('');
  const [filterLogin, setFilterLogin] = useState('');
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [credTick, setCredTick] = useState(0);
  const [resetState, setResetState] = useState({ key: '', message: '', tone: 'info' });

  // Read credentials once on mount and whenever orgKey changes
  const credentials = useMemo(() => {
    return readEmployeeCredentialsSync();
  }, [orgKey, credTick]); // eslint-disable-line react-hooks/exhaustive-deps

  const workflow = useMemo(() => loadWorkflowState(orgKey), [orgKey]);

  const empByCode = useMemo(() => {
    const m = {};
    employees.forEach((e) => { m[String(e['Employee Code'] || '').trim().toLowerCase()] = e; });
    return m;
  }, [employees]);

  function getLoginStatus(code) {
    const c = String(code || '').trim();
    const cred = credentials[c] || credentials[c.toLowerCase()];
    if (!cred) return 'none';
    return cred.isTemp ? 'temp' : 'permanent';
  }

  // Summary counts for the stat bar
  const counts = useMemo(() => {
    let permanent = 0, temp = 0, none = 0;
    employees.forEach((e) => {
      const s = getLoginStatus(e['Employee Code']);
      if (s === 'permanent') permanent++;
      else if (s === 'temp') temp++;
      else none++;
    });
    return { permanent, temp, none };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [employees, credentials]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return employees.filter((e) => {
      const matchSearch = !q || `${e['Employee Name'] || ''} ${e['Employee Code'] || ''}`.toLowerCase().includes(q);
      const matchStage  = !filterStage || getEmpStage(e) === filterStage;
      const matchGroup  = !filterGroup || (e['Group Name'] || e.assignedGoalGroupName || '') === filterGroup;
      const matchLogin  = !filterLogin || getLoginStatus(e['Employee Code']) === filterLogin;
      return matchSearch && matchStage && matchGroup && matchLogin;
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [employees, search, filterStage, filterGroup, filterLogin, credentials]);

  const selectStyle = { border: '1.5px solid #E2E8F0', borderRadius: 8, padding: '7px 10px', fontSize: 12.5, fontFamily: 'inherit', background: '#fff', color: '#0D1117', outline: 'none' };

  async function handleDownload() {
    setDownloading(true);
    try {
      await downloadEmpStatusExcel({ employees: filtered, credentials, workflow, orgName: org?.name });
    } finally { setDownloading(false); }
  }

  async function handleResetPassword(emp) {
    const code = String(emp?.['Employee Code'] || '').trim();
    if (!code) return;
    setResetState({ key: code, message: '', tone: 'info' });
    const result = await resetUserPasswordByAdmin({ orgKey, credentialKey: code, prefix: 'Emp' });
    if (result?.ok) {
      void logAuditEvent({
        orgKey,
        actorRole: 'hr-admin',
        actorName: org?.hrAdminName || 'HR Admin',
        actionType: 'employee-password-reset',
        targetType: 'employee',
        targetCode: code,
        details: {
          employeeName: emp['Employee Name'] || '',
        },
      });
      setCredTick((v) => v + 1);
      navigator.clipboard?.writeText(result.tempPassword || '').catch(() => {});
      setResetState({
        key: code,
        tone: 'good',
        message: `Temporary password reset and copied for ${emp['Employee Name'] || code}.`,
      });
      return;
    }
    setResetState({
      key: code,
      tone: 'bad',
      message: result?.error || 'Password reset failed.',
    });
  }

  return (
    <div>
      {/* Stat bar */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(160px,1fr))', gap: 10, marginBottom: 16 }}>
        {[
          { label: 'Password Set',  value: counts.permanent, color: '#15803D', bg: '#F0FDF4', border: '#BBF7D0', filter: 'permanent' },
          { label: 'Temp Password', value: counts.temp,      color: '#B45309', bg: '#FFFBEB', border: '#FDE68A', filter: 'temp' },
          { label: 'Not Activated', value: counts.none,      color: '#64748B', bg: '#F8FAFC', border: '#E2E8F0', filter: 'none' },
          { label: 'Total',         value: employees.length, color: '#1D4ED8', bg: '#EFF6FF', border: '#BFDBFE', filter: ''    },
        ].map(({ label, value, color, bg, border, filter }) => (
          <button key={label} type="button" onClick={() => setFilterLogin(filterLogin === filter && filter ? '' : filter)}
            style={{ textAlign: 'left', background: filterLogin === filter && filter ? bg : '#fff', border: `1.5px solid ${filterLogin === filter && filter ? border : '#E9EDF2'}`, borderRadius: 10, padding: '12px 14px', cursor: filter ? 'pointer' : 'default', transition: 'all 160ms ease', fontFamily: 'inherit' }}>
            <div style={{ fontSize: 22, fontWeight: 800, color, lineHeight: 1 }}>{value}</div>
            <div style={{ fontSize: 11.5, color: '#64748B', marginTop: 4, fontWeight: 500 }}>{label}</div>
          </button>
        ))}
      </div>

      {/* Search + Filters toggle + Download */}
      {(() => {
        const activeFilterCount = (filterStage ? 1 : 0) + (filterGroup ? 1 : 0) + (filterLogin ? 1 : 0);
        const anyActive = !!(search || activeFilterCount);
        return (
          <>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: filtersOpen ? 8 : 12 }}>
              <div style={{ position: 'relative', flex: '1 1 200px' }}>
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" style={{ position: 'absolute', left: 9, top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none', color: '#94A3B8' }}>
                  <circle cx="6.5" cy="6.5" r="4.5" stroke="currentColor" strokeWidth="1.4"/><line x1="10" y1="10" x2="14" y2="14" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
                </svg>
                <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search name or code…"
                  style={{ ...selectStyle, width: '100%', boxSizing: 'border-box', paddingLeft: 28 }} />
              </div>

              {/* Filters toggle */}
              <button type="button" onClick={() => setFiltersOpen(v => !v)}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '7px 13px', background: filtersOpen || activeFilterCount > 0 ? '#EEF2FF' : '#fff', color: filtersOpen || activeFilterCount > 0 ? '#4338CA' : '#475569', border: `1.5px solid ${filtersOpen || activeFilterCount > 0 ? '#C7D2FE' : '#E2E8F0'}`, borderRadius: 8, fontSize: 12.5, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit', transition: 'all 160ms ease', flexShrink: 0 }}>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/></svg>
                Filters
                {activeFilterCount > 0 && <span style={{ background: '#4338CA', color: '#fff', borderRadius: 999, fontSize: 10.5, fontWeight: 700, padding: '1px 7px' }}>{activeFilterCount}</span>}
                <svg width="10" height="10" viewBox="0 0 16 16" fill="none" style={{ transform: filtersOpen ? 'rotate(180deg)' : 'none', transition: 'transform 200ms ease' }}><path d="M3 6l5 5 5-5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/></svg>
              </button>

              {anyActive && (
                <button type="button" onClick={() => { setSearch(''); setFilterStage(''); setFilterGroup(''); setFilterLogin(''); }}
                  style={{ padding: '7px 12px', background: '#fff', color: '#475569', border: '1.5px solid #E2E8F0', borderRadius: 8, fontSize: 12.5, cursor: 'pointer', fontFamily: 'inherit', flexShrink: 0 }}>
                  Clear
                </button>
              )}

              <div style={{ marginLeft: 'auto', display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 3, flexShrink: 0 }}>
                <button type="button" onClick={handleDownload} disabled={downloading}
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '7px 14px', background: downloading ? '#F1F5F9' : '#0F172A', color: downloading ? '#94A3B8' : '#fff', border: 'none', borderRadius: 8, fontSize: 12.5, fontWeight: 600, cursor: downloading ? 'default' : 'pointer', fontFamily: 'inherit' }}>
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                  {downloading ? 'Preparing…' : 'Download Excel'}
                </button>
                <span style={{ fontSize: 11, color: filtered.length < employees.length ? '#B45309' : '#94A3B8' }}>
                  {filtered.length < employees.length
                    ? `${filtered.length} of ${employees.length} employees (filtered)`
                    : `All ${employees.length} employees`}
                </span>
              </div>
            </div>

            {/* Collapsible filter panel */}
            <div style={{ display: 'grid', gridTemplateRows: filtersOpen ? '1fr' : '0fr', opacity: filtersOpen ? 1 : 0, transition: 'grid-template-rows 260ms cubic-bezier(0.22,1,0.36,1), opacity 200ms ease', marginBottom: filtersOpen ? 12 : 0 }}>
              <div style={{ overflow: 'hidden', minHeight: 0 }}>
                <div style={{ background: '#FAFBFF', border: '1px solid #E2E8F0', borderRadius: 10, padding: '12px 14px', display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 10 }}>
                  <div>
                    <div style={{ fontSize: 11, fontWeight: 700, color: '#94A3B8', textTransform: 'uppercase', letterSpacing: '.05em', marginBottom: 5 }}>Stage</div>
                    <select value={filterStage} onChange={(e) => setFilterStage(e.target.value)} style={{ ...selectStyle, width: '100%' }}>
                      <option value="">All Stages</option>
                      {EMP_STAGES.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
                    </select>
                  </div>
                  <div>
                    <div style={{ fontSize: 11, fontWeight: 700, color: '#94A3B8', textTransform: 'uppercase', letterSpacing: '.05em', marginBottom: 5 }}>Group</div>
                    <select value={filterGroup} onChange={(e) => setFilterGroup(e.target.value)} style={{ ...selectStyle, width: '100%' }}>
                      <option value="">All Groups</option>
                      {groups.map((g) => <option key={g.id} value={g.name}>{g.name}</option>)}
                    </select>
                  </div>
                  <div>
                    <div style={{ fontSize: 11, fontWeight: 700, color: '#94A3B8', textTransform: 'uppercase', letterSpacing: '.05em', marginBottom: 5 }}>Login Status</div>
                    <select value={filterLogin} onChange={(e) => setFilterLogin(e.target.value)} style={{ ...selectStyle, width: '100%' }}>
                      <option value="">All</option>
                      <option value="permanent">Password Set</option>
                      <option value="temp">Temp Password</option>
                      <option value="none">Not Activated</option>
                    </select>
                  </div>
                </div>
              </div>
            </div>
          </>
        );
      })()}

      {/* Table */}
      <div style={{ border: '1px solid #E9EDF2', borderRadius: 10, overflow: 'hidden' }}>
        <table style={{ width: '100%', fontSize: 12.5, borderCollapse: 'collapse', tableLayout: 'fixed' }}>
          <colgroup>
            <col style={{ width: '17%' }} />
            <col style={{ width: '8%' }} />
            <col style={{ width: '15%' }} />
            <col style={{ width: '11%' }} />
            <col style={{ width: '14%' }} />
            <col style={{ width: '12%' }} />
            <col style={{ width: '15%' }} />
            <col style={{ width: '8%' }} />
          </colgroup>
          <thead>
            <tr style={{ background: '#F8FAFC' }}>
              {['Employee', 'Code', 'Designation', 'Group', 'Manager', 'Login', 'Stage', 'Actions'].map((h) => (
                <th key={h} style={{ padding: '9px 12px', textAlign: 'left', fontSize: 11, fontWeight: 700, color: '#94A3B8', textTransform: 'uppercase', letterSpacing: '0.05em', borderBottom: '1px solid #E9EDF2' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 && <tr><td colSpan={8} style={{ padding: '20px', textAlign: 'center', color: '#94A3B8' }}>No employees match your filter.</td></tr>}
            {filtered.slice(0, 100).map((emp, i) => {
              const code = emp['Employee Code'] || '—';
              const name = emp['Employee Name'] || code;
              const desig = emp.Designation || emp.Role || '—';
              const grp   = emp['Group Name'] || emp.assignedGoalGroupName || '—';
              const mgrCode = String(emp['Reporting Manager Code'] || '').trim();
              const mgrEmp  = mgrCode ? empByCode[mgrCode.toLowerCase()] : null;
              const mgrName = mgrEmp?.['Employee Name'] || String(emp['Reporting Manager Name'] || '').trim() || mgrCode || '—';
              return (
                <tr key={code + i} style={{ borderTop: '1px solid #F1F5F9', background: i % 2 === 0 ? '#fff' : '#FAFBFC' }}>
                  <td style={{ padding: '9px 12px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                      <div style={{ width: 28, height: 28, borderRadius: '50%', background: 'linear-gradient(135deg,#4F46E5,#7C3AED)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 10, fontWeight: 800, flexShrink: 0 }}>{getInitials(name)}</div>
                      <span style={{ fontWeight: 500, color: '#0D1117', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</span>
                    </div>
                  </td>
                  <td style={{ padding: '9px 12px', fontFamily: 'monospace', fontWeight: 700, color: '#4F46E5' }}>{code}</td>
                  <td style={{ padding: '9px 12px', color: '#64748B', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{desig}</td>
                  <td style={{ padding: '9px 12px', color: '#64748B', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{grp}</td>
                  <td style={{ padding: '9px 12px' }}>
                    <div style={{ fontSize: 12, fontWeight: 500, color: '#374151', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{mgrName}</div>
                    {mgrCode && <div style={{ fontSize: 10.5, color: '#94A3B8', fontFamily: 'monospace' }}>{mgrCode}</div>}
                  </td>
                  <td style={{ padding: '9px 12px' }}><LoginStatusPill status={getLoginStatus(code)} /></td>
                  <td style={{ padding: '9px 12px' }}><StagePill stageId={getEmpStage(emp)} /></td>
                  <td style={{ padding: '9px 12px' }}>
                    <button
                      type="button"
                      onClick={() => handleResetPassword(emp)}
                      disabled={resetState.key === code && !resetState.message}
                      style={{ padding: '6px 10px', background: '#fff', color: '#4338CA', border: '1.5px solid #C7D2FE', borderRadius: 8, fontSize: 11.5, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap' }}
                    >
                      Reset password
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {(resetState.message || filtered.length > 100) && (
          <div style={{ padding: '8px 12px', fontSize: 11.5, color: resetState.tone === 'bad' ? '#B91C1C' : resetState.tone === 'good' ? '#166534' : '#94A3B8', borderTop: '1px solid #F1F5F9', display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
            <span>{resetState.message || '\u00A0'}</span>
            {filtered.length > 100 && <span style={{ color: '#94A3B8' }}>Showing 100 of {filtered.length} — use search to narrow down</span>}
          </div>
        )}
      </div>
    </div>
  );
}

/* ── Communications ──────────────────────────────────────────── */
// Renders a plain-text email body as styled JSX. Detects a "Key : Value" credential block and
// presents it as a coloured card; everything else is rendered as normal typography-styled paragraphs.
function renderEmailBody(text, theme) {
  const paragraphs = String(text || '').split(/\n\s*\n/);
  const keyValRe = /^\s*([A-Za-z][A-Za-z\s]{0,30}?)\s*:\s*(.+?)\s*$/;

  return paragraphs.map((para, pi) => {
    const lines = para.split('\n');
    // A block of consecutive "Label : Value" lines (≥ 2) is treated as credentials.
    const isKvBlock = lines.length >= 2 && lines.every((l) => keyValRe.test(l));
    if (isKvBlock) {
      return (
        <div key={pi} style={{ background: theme.credBg, border: `1px solid ${theme.credBorder}`, borderRadius: 10, padding: '12px 16px', margin: '6px 0 14px' }}>
          {lines.map((l, i) => {
            const [, k, v] = l.match(keyValRe);
            return (
              <div key={i} style={{ display: 'flex', justifyContent: 'space-between', gap: 12, padding: '3px 0', fontSize: 13 }}>
                <span style={{ color: '#64748B', fontWeight: 600 }}>{k.trim()}</span>
                <span style={{ color: theme.accent, fontWeight: 700, fontFamily: "'Geist Mono','SF Mono',Menlo,monospace" }}>{v.trim()}</span>
              </div>
            );
          })}
        </div>
      );
    }
    // Short, trailing paragraph after "regards" → muted signature style.
    const looksLikeSignature = pi === paragraphs.length - 1 && /regards|sincerely|thanks/i.test(lines[0] || '');
    return (
      <p key={pi} style={{ margin: '0 0 14px', color: looksLikeSignature ? '#64748B' : '#1E293B', whiteSpace: 'pre-wrap' }}>
        {para}
      </p>
    );
  });
}

const COMMS_CHANNELS = [
  {
    id: 'email', label: 'Email', ready: true,
    accent: '#4F46E5', accentBg: '#EEF2FF', accentBorder: '#C7D2FE',
    icon: (<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2.5" y="5" width="19" height="14" rx="2.2"/><path d="m3.5 7 8.5 6.2L20.5 7"/></svg>),
  },
  {
    id: 'sms', label: 'SMS', ready: false,
    accent: '#0891B2', accentBg: '#ECFEFF', accentBorder: '#A5F3FC',
    icon: (<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>),
  },
  {
    id: 'whatsapp', label: 'WhatsApp', ready: false,
    accent: '#16A34A', accentBg: '#F0FDF4', accentBorder: '#BBF7D0',
    icon: (<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 22a10 10 0 1 0-8.66-5.01L2 22l5.2-1.38A10 10 0 0 0 12 22z"/><path d="M8.5 9.5c0 .83.34 2 1 3 .9 1.35 2.05 2.5 3.5 3.4 1 .6 2.2 1 3 1 .8 0 1.4-.5 1.5-1.2.05-.3 0-.6-.2-.8-.4-.4-1.6-1-2-1.1-.2-.05-.4 0-.5.2l-.5.6c-.15.2-.35.3-.6.2-.6-.2-1.5-.7-2.2-1.4-.6-.6-1.1-1.4-1.4-2-.1-.2 0-.4.15-.55l.5-.5c.2-.2.25-.4.2-.6-.05-.4-.65-1.65-1.05-2-.2-.2-.5-.25-.8-.2-.7.1-1.2.7-1.2 1.5z"/></svg>),
  },
];
const COMMS_TOKENS = [
  { key: '{employee_name}', label: 'Employee Name' },
  { key: '{employee_code}', label: 'Employee Code' },
  { key: '{password}', label: 'Password' },
];

// One-tap brand palettes — each preset is just a single brand colour. The header gradient,
// CTA, and accent are auto-derived from it, so the HR admin never deals with "from / to" maths.
const COMMS_THEME_PRESETS = [
  { id: 'indigo',   label: 'Indigo',   brand: '#4F46E5' },
  { id: 'ocean',    label: 'Ocean',    brand: '#0EA5E9' },
  { id: 'emerald',  label: 'Emerald',  brand: '#16A34A' },
  { id: 'sunset',   label: 'Sunset',   brand: '#EA580C' },
  { id: 'plum',     label: 'Plum',     brand: '#7C3AED' },
  { id: 'graphite', label: 'Graphite', brand: '#0F172A' },
];
const DEFAULT_EMAIL_THEME = {
  brand:      COMMS_THEME_PRESETS[0].brand,
  ctaLabel:   'Log in to Performance Hub',
  footerText: '',
  showFooter: true,
  showZaroBadge: true,
  logo:       null,            // data URL
  logoPosition: 'header-left', // header-left | header-center | header-right | hide
  logoSize:   'medium',        // small | medium | large
  buttonStyle: 'solid',        // solid | outline | pill | ghost
  buttonAlign: 'left',         // left | center | right
};

const LOGO_POSITIONS = [
  { id: 'header-left',   label: 'Left' },
  { id: 'header-center', label: 'Center' },
  { id: 'header-right',  label: 'Right' },
  { id: 'hide',          label: 'Hide' },
];
const LOGO_SIZES = ['small', 'medium', 'large'];
const BUTTON_STYLES = [
  { id: 'solid',   label: 'Solid' },
  { id: 'outline', label: 'Outline' },
  { id: 'pill',    label: 'Pill' },
  { id: 'ghost',   label: 'Text link' },
];
function withAlpha(hex, alpha) {
  const m = /^#?([a-fA-F0-9]{6})$/.exec(String(hex || ''));
  if (!m) return hex;
  const r = parseInt(m[1].slice(0, 2), 16);
  const g = parseInt(m[1].slice(2, 4), 16);
  const b = parseInt(m[1].slice(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}
function darkenHex(hex, pct = 0.22) {
  const m = /^#?([a-fA-F0-9]{6})$/.exec(String(hex || ''));
  if (!m) return hex;
  const clamp = (v) => Math.max(0, Math.min(255, Math.round(v)));
  const r = clamp(parseInt(m[1].slice(0, 2), 16) * (1 - pct));
  const g = clamp(parseInt(m[1].slice(2, 4), 16) * (1 - pct));
  const b = clamp(parseInt(m[1].slice(4, 6), 16) * (1 - pct));
  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
}

// Simple preview hover-edit affordance. Outlines on hover, shows a pencil pill, click → parent handler.
function PreviewHotspot({ label, onClick, children, inline = false }) {
  const [hovered, setHovered] = useState(false);
  return (
    <div onClick={onClick} onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}
      style={{
        position: 'relative',
        display: inline ? 'inline-block' : 'block',
        cursor: 'pointer',
        outline: hovered ? '2px solid rgba(79,70,229,0.45)' : '2px solid transparent',
        outlineOffset: -2,
        borderRadius: inline ? 8 : 0,
        transition: 'outline-color 160ms ease',
      }}>
      {children}
      {hovered && (
        <div style={{ position: 'absolute', top: 6, right: 6, padding: '3px 8px', borderRadius: 999, background: '#4F46E5', color: '#fff', fontSize: 10, fontWeight: 700, boxShadow: '0 4px 10px rgba(79,70,229,.35)', pointerEvents: 'none', display: 'inline-flex', alignItems: 'center', gap: 4, zIndex: 2 }}>
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/></svg>
          {label}
        </div>
      )}
    </div>
  );
}

function ComposeRecipients({
  recipients, groups,
  recipSearch, setRecipSearch,
  recipFilter, setRecipFilter,
  emailEdits, setEmailEdits,
  commitEmail, getEmail,
  bulkEmailFileRef, handleBulkEmailFile,
  bulkEmailPreview, setBulkEmailPreview,
  applyBulkEmail,
  downloadCurrentEmailList,
  recipToast,
  sendConfig,
  sendState,
  onSend,
  activeTemplate,
}) {
  const totalCount = recipients.length;
  const withEmail = recipients.filter((e) => getEmail(e)).length;
  const missingCount = totalCount - withEmail;

  const filteredList = useMemo(() => {
    const q = recipSearch.trim().toLowerCase();
    return recipients.filter((e) => {
      if (recipFilter === 'missing' && getEmail(e)) return false;
      if (q) {
        const hay = `${e['Employee Name'] || ''} ${e['Employee Code'] || ''} ${getEmail(e)}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [recipients, recipSearch, recipFilter, getEmail]);

  const inputCell = { width: '100%', boxSizing: 'border-box', border: '1.5px solid #E2E8F0', borderRadius: 7, padding: '6px 10px', fontSize: 12.5, outline: 'none', fontFamily: 'inherit', color: '#0F172A', background: '#fff' };

  return (
    <div style={{ position: 'relative' }}>
      {recipToast && <div style={{ position: 'fixed', bottom: 28, right: 28, zIndex: 50, background: '#F0FDF4', border: '1px solid #BBF7D0', borderRadius: 9, padding: '10px 16px', fontSize: 12.5, fontWeight: 600, color: '#15803D', boxShadow: '0 4px 16px rgba(0,0,0,.1)' }}>✓ {recipToast}</div>}

      {/* Summary chips */}
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 14 }}>
        <Chip label="Total" value={totalCount} tone="neutral" />
        <Chip label="With email" value={withEmail} tone="ok" />
        <Chip label="Missing email" value={missingCount} tone={missingCount > 0 ? 'warn' : 'neutral'} />
        <Chip label="Groups" value={groups.length} tone="neutral" />
      </div>

      {/* Toolbar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12, flexWrap: 'wrap' }}>
        <input value={recipSearch} onChange={(e) => setRecipSearch(e.target.value)}
          placeholder="Search name, code, or email…"
          style={{ flex: 1, minWidth: 240, boxSizing: 'border-box', border: '1.5px solid #E2E8F0', borderRadius: 9, padding: '8px 12px', fontSize: 13, outline: 'none', fontFamily: 'inherit', color: '#0F172A', background: '#fff' }} />

        <div style={{ display: 'inline-flex', background: '#F1F5F9', padding: 3, borderRadius: 9, gap: 2 }}>
          {[{ k: 'all', label: 'All' }, { k: 'missing', label: `Missing email${missingCount > 0 ? ` · ${missingCount}` : ''}` }].map((f) => (
            <button key={f.k} type="button" onClick={() => setRecipFilter(f.k)}
              style={{ padding: '6px 12px', borderRadius: 7, border: 'none', cursor: 'pointer', fontFamily: 'inherit', fontSize: 12, fontWeight: recipFilter === f.k ? 700 : 500, background: recipFilter === f.k ? '#fff' : 'transparent', color: recipFilter === f.k ? '#0F172A' : '#64748B', boxShadow: recipFilter === f.k ? '0 1px 3px rgba(15,23,42,.08)' : 'none' }}>
              {f.label}
            </button>
          ))}
        </div>

        <input ref={bulkEmailFileRef} type="file" accept=".xlsx,.xls,.csv" style={{ display: 'none' }} onChange={handleBulkEmailFile} />
        <button type="button" onClick={downloadCurrentEmailList}
          title="Exports a CSV with the current Employee Code and Email for every recipient. Edit the second column and re-upload."
          style={{ padding: '8px 12px', background: '#fff', color: '#475569', border: '1.5px solid #E2E8F0', borderRadius: 9, fontSize: 12, cursor: 'pointer', fontFamily: 'inherit', fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
          Download current list
        </button>
        <button type="button" onClick={() => bulkEmailFileRef.current?.click()}
          style={{ padding: '8px 14px', background: '#4F46E5', color: '#fff', border: 'none', borderRadius: 9, fontSize: 12.5, cursor: 'pointer', fontFamily: 'inherit', fontWeight: 700, boxShadow: '0 4px 12px rgba(79,70,229,.25)' }}>
          Upload edited list
        </button>
      </div>

      {/* Bulk preview */}
      {bulkEmailPreview && (
        <div style={{ background: '#fff', border: '1px solid #E9EDF2', borderRadius: 12, padding: 14, marginBottom: 14 }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: '#374151', marginBottom: 8 }}>
            {bulkEmailPreview.filter((r) => r.found && r.valid && r.changed).length} will update,
            {' '}{bulkEmailPreview.filter((r) => !r.found).length} not found,
            {' '}{bulkEmailPreview.filter((r) => r.found && !r.valid).length} invalid
          </div>
          <div style={{ border: '1px solid #E9EDF2', borderRadius: 8, overflow: 'hidden', maxHeight: 240, overflowY: 'auto', marginBottom: 10 }}>
            <table style={{ width: '100%', fontSize: 12.5, borderCollapse: 'collapse' }}>
              <thead><tr style={{ background: '#F8FAFC' }}>
                {['Employee', 'Current', 'New', 'Status'].map((h) => <th key={h} style={{ padding: '7px 10px', textAlign: 'left', fontSize: 11, fontWeight: 700, color: '#94A3B8', textTransform: 'uppercase', position: 'sticky', top: 0, background: '#F8FAFC' }}>{h}</th>)}
              </tr></thead>
              <tbody>{bulkEmailPreview.map((r, i) => (
                <tr key={i} style={{ borderTop: '1px solid #F1F5F9' }}>
                  <td style={{ padding: '6px 10px' }}>
                    <span style={{ fontFamily: 'monospace', fontWeight: 700, color: '#4F46E5' }}>{r.code}</span>
                    {r.name && <span style={{ color: '#374151' }}> — {r.name}</span>}
                  </td>
                  <td style={{ padding: '6px 10px', color: '#94A3B8' }}>{r.currentEmail || '—'}</td>
                  <td style={{ padding: '6px 10px', color: '#0F172A' }}>{r.newEmail || '—'}</td>
                  <td style={{ padding: '6px 10px' }}>
                    {!r.found && <Pill text="Not found" tone="warn" />}
                    {r.found && !r.valid && <Pill text="Invalid format" tone="warn" />}
                    {r.found && r.valid && r.changed && <Pill text="Will update" tone="ok" />}
                    {r.found && r.valid && !r.changed && <Pill text="No change" tone="neutral" />}
                  </td>
                </tr>
              ))}</tbody>
            </table>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="button" onClick={applyBulkEmail} disabled={!bulkEmailPreview.some((r) => r.found && r.valid && r.changed)}
              style={{ padding: '8px 16px', background: '#16A34A', color: '#fff', border: 'none', borderRadius: 7, fontSize: 12.5, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' }}>
              Apply changes
            </button>
            <button type="button" onClick={() => setBulkEmailPreview(null)} style={{ padding: '7px 14px', background: '#F1F5F9', color: '#374151', border: '1.5px solid #E2E8F0', borderRadius: 7, fontSize: 12.5, cursor: 'pointer', fontFamily: 'inherit' }}>Cancel</button>
          </div>
        </div>
      )}

      {/* Recipients table */}
      <div style={{ background: '#fff', border: '1px solid #E9EDF2', borderRadius: 12, overflow: 'hidden' }}>
        <div style={{ maxHeight: 460, overflow: 'auto' }}>
          <table style={{ width: '100%', fontSize: 12.5, borderCollapse: 'collapse' }}>
            <thead><tr style={{ background: '#F8FAFC', position: 'sticky', top: 0 }}>
              {['Name', 'Code', 'Email', ''].map((h, i) => (
                <th key={i} style={{ padding: '10px 14px', textAlign: 'left', fontSize: 11, fontWeight: 700, color: '#94A3B8', textTransform: 'uppercase', letterSpacing: '0.04em', borderBottom: '1px solid #E2E8F0', background: '#F8FAFC', whiteSpace: 'nowrap' }}>{h}</th>
              ))}
            </tr></thead>
            <tbody>
              {filteredList.map((emp) => {
                const code = String(emp['Employee Code'] || '').trim();
                const current = getEmail(emp);
                const editVal = emailEdits[code];
                const editing = editVal !== undefined;
                const value = editing ? editVal : current;
                const dirty = editing && (editVal ?? '').trim() !== current;
                const valid = !value || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
                return (
                  <tr key={code} style={{ borderTop: '1px solid #F1F5F9' }}>
                    <td style={{ padding: '8px 14px', fontWeight: 600, color: '#0F172A' }}>{emp['Employee Name'] || '—'}</td>
                    <td style={{ padding: '8px 14px', color: '#94A3B8', fontFamily: 'monospace' }}>{code}</td>
                    <td style={{ padding: '6px 10px' }}>
                      <input
                        value={value}
                        onChange={(e) => setEmailEdits((p) => ({ ...p, [code]: e.target.value }))}
                        placeholder={current ? '' : 'Add email…'}
                        type="email"
                        style={{ ...inputCell, borderColor: !valid ? '#FCA5A5' : dirty ? '#A5B4FC' : '#E2E8F0' }}
                      />
                    </td>
                    <td style={{ padding: '6px 10px', whiteSpace: 'nowrap' }}>
                      {dirty && valid && (
                        <button type="button" onClick={() => commitEmail(code)}
                          style={{ padding: '6px 12px', background: '#4F46E5', color: '#fff', border: 'none', borderRadius: 7, fontSize: 11.5, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' }}>
                          Save
                        </button>
                      )}
                      {dirty && !valid && (
                        <span style={{ fontSize: 11, color: '#991B1B', fontWeight: 600 }}>Invalid</span>
                      )}
                      {!dirty && !current && <span style={{ fontSize: 11, color: '#92400E', fontWeight: 600 }}>Missing</span>}
                    </td>
                  </tr>
                );
              })}
              {filteredList.length === 0 && (
                <tr><td colSpan={4} style={{ padding: '32px 14px', textAlign: 'center', color: '#94A3B8', fontSize: 13 }}>No employees match this filter.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Send footer */}
      {(() => {
        const sending = sendState?.status === 'sending';
        const sent = sendState?.status === 'sent';
        const failed = sendState?.status === 'failed';
        const disabled = !!sendConfig?.disabled || sending;
        const banner = sent
          ? { bg: '#F0FDF4', bd: '#BBF7D0', tx: '#166534', label: sendState.message || 'Sent.' }
          : failed
          ? { bg: '#FEF2F2', bd: '#FECACA', tx: '#991B1B', label: sendState.message || 'Send failed.' }
          : { bg: '#EFF6FF', bd: '#BFDBFE', tx: '#1D4ED8', label: activeTemplate === 'cycle-launch'
              ? 'Manual broadcast — sends when you click below.'
              : activeTemplate === 'co-admin-invite'
              ? 'Sends the welcome email to all Co-Admins on the HR Team that have an email and a temp password.'
              : activeTemplate === 'scoped-hr-invite'
              ? 'Sends the welcome email to all Scoped HR members on the HR Team that have an email and a temp password.'
              : 'Manual manager summary — sends to reporting managers only when you click below.' };
        return (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 14, padding: '12px 16px', background: banner.bg, border: `1px solid ${banner.bd}`, borderRadius: 11, gap: 12, flexWrap: 'wrap' }}>
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: 12, color: banner.tx }}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, marginTop: 1 }}>
                {sent ? <><polyline points="20 6 9 17 4 12"/></> : failed ? <><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></> : <><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></>}
              </svg>
              <span>{banner.label}</span>
            </div>
            <button type="button" disabled={disabled} onClick={onSend}
              style={{ padding: '9px 18px', background: disabled ? '#E2E8F0' : '#4F46E5', color: disabled ? '#94A3B8' : '#fff', border: 'none', borderRadius: 9, fontSize: 13, fontWeight: 700, cursor: disabled ? 'not-allowed' : 'pointer', fontFamily: 'inherit', display: 'inline-flex', alignItems: 'center', gap: 7, boxShadow: disabled ? 'none' : '0 4px 12px rgba(79,70,229,.25)' }}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
              {sending ? 'Sending…' : (sendConfig?.label || `Send to ${withEmail}`)}
            </button>
          </div>
        );
      })()}
    </div>
  );
}

function Chip({ label, value, tone }) {
  const colors = tone === 'ok'    ? { bg: '#F0FDF4', bd: '#BBF7D0', tx: '#166534' }
              : tone === 'warn'   ? { bg: '#FFFBEB', bd: '#FDE68A', tx: '#92400E' }
              :                     { bg: '#F8FAFC', bd: '#E2E8F0', tx: '#475569' };
  return (
    <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8, padding: '6px 12px', background: colors.bg, border: `1px solid ${colors.bd}`, borderRadius: 999 }}>
      <span style={{ fontSize: 11.5, fontWeight: 600, color: colors.tx, opacity: 0.85 }}>{label}</span>
      <span style={{ fontSize: 13, fontWeight: 800, color: colors.tx }}>{value}</span>
    </div>
  );
}

function Pill({ text, tone }) {
  const colors = tone === 'ok'    ? { bg: '#F0FDF4', tx: '#15803D' }
              : tone === 'warn'   ? { bg: '#FEF2F2', tx: '#991B1B' }
              :                     { bg: '#F1F5F9', tx: '#64748B' };
  return <span style={{ fontSize: 11, fontWeight: 600, color: colors.tx, background: colors.bg, borderRadius: 5, padding: '2px 8px' }}>{text}</span>;
}

function ModuleComms({ employees, groups, org, config, onUpdate, onConfigPatch }) {
  const [activeTab, setActiveTab] = useState('email');
  const [stepTab, setStepTab] = useState('compose'); // 'compose' | 'design' | 'recipients'
  const [activeTemplate, setActiveTemplate] = useState('cycle-launch');

  const defaultTemplates = useMemo(() => ({
    'cycle-launch': {
      subject: `Welcome to ${org.name || 'the PMS'} — Your Goal Setting is Now Open`,
      body: `Dear {employee_name},\n\nThe Performance Management System for ${org.name || 'our organization'} is now live!\n\nYour login credentials:\n  Employee Code : {employee_code}\n  Password      : {password}\n\nPlease log in to complete your goal-setting for this appraisal cycle.\n\nWarm regards,\n${org.hrAdminName || 'HR Team'}`,
    },
    'co-admin-invite': {
      subject: `${org.name || 'PMS'} — you've been added as a Co-Admin`,
      body: `Hello {employee_name},\n\n${org.hrAdminName || 'HR'} has added you as a Co-Admin for ${org.name || 'our organization'} on Zaro HR.\n\nYour login email : {recipient_email}\nTemporary password : {temporary_password}\n\nYou'll have full HR-admin access. Please log in and change your password right after.\n\nWarm regards,\n${org.hrAdminName || 'HR Team'}`,
    },
    'scoped-hr-invite': {
      subject: `${org.name || 'PMS'} — your Scoped HR access is ready`,
      body: `Hello {employee_name},\n\n${org.hrAdminName || 'HR'} has set you up as a Scoped HR member for ${org.name || 'our organization'} on Zaro HR.\n\nYour login email : {recipient_email}\nTemporary password : {temporary_password}\n\nYour access is limited to the scope HR has assigned. Please log in and change your password right after.\n\nWarm regards,\n${org.hrAdminName || 'HR Team'}`,
    },
    'manager-summary': {
      subject: `${org.name || 'PMS'} — your reportee setup summary`,
      body: `Hello {employee_name},\n\nThe following reportees are mapped to you for this cycle:\n\n{reportee_list}\n\nLog in to review their goal-setting progress.\n\nWarm regards,\n${org.hrAdminName || 'HR Team'}`,
    },
  }), [org.name, org.hrAdminName]);

  const initialTemplates = config?.emailTemplates?.templates || defaultTemplates;
  const [templates, setTemplates] = useState(initialTemplates);
  const [previewIndex, setPreviewIndex] = useState(0);

  // Auto-populate the email-design logo from the org-level brand logo (captured
  // during setup or HR Team page) on first mount. Users can replace or remove it.
  const [emailTheme, setEmailTheme] = useState(() => ({
    ...DEFAULT_EMAIL_THEME,
    logo: org?.brandLogo || null,
    ...(config?.emailTemplates?.theme || {}),
  }));
  function updateTheme(patch) { setEmailTheme((prev) => ({ ...prev, ...patch })); }
  function applyPreset(preset) { updateTheme({ brand: preset.brand }); }
  async function uploadLogo(file) {
    if (!file || !file.type?.startsWith('image/')) return;
    try {
      const dataUrl = await readImageAsDataUrl(file);
      updateTheme({ logo: dataUrl });
    } catch (_) { /* silently ignore — UI stays in previous state */ }
  }

  // Subject/body are derived from the active template; setters route back into
  // the templates store. Persistence is debounced into `config.emailTemplates`
  // so manual Communications sends use the same drafts the HR admin designed here.
  const subject = templates[activeTemplate]?.subject ?? '';
  const body = templates[activeTemplate]?.body ?? '';
  const setSubject = (v) => setTemplates((p) => ({ ...p, [activeTemplate]: { ...(p[activeTemplate] || {}), subject: typeof v === 'function' ? v(p[activeTemplate]?.subject ?? '') : v } }));
  const setBody = (v) => setTemplates((p) => ({ ...p, [activeTemplate]: { ...(p[activeTemplate] || {}), body: typeof v === 'function' ? v(p[activeTemplate]?.body ?? '') : v } }));

  const initialPersistRef = useRef(true);
  useEffect(() => {
    if (initialPersistRef.current) { initialPersistRef.current = false; return; }
    const id = setTimeout(() => {
      onConfigPatch?.({ emailTemplates: { templates, theme: emailTheme } });
    }, 400);
    return () => clearTimeout(id);
  }, [templates, emailTheme, onConfigPatch]);

  // Send state — broadcasts go through the Edge Function via emailService.
  const [sendState, setSendState] = useState({ status: 'idle', message: '' });

  const sendConfig = useMemo(() => {
    if (activeTemplate === 'cycle-launch') {
      const recipients = (employees || []).filter((e) => String(e?.['Email ID'] || e?.Email || '').trim());
      return {
        label: `Send launch email to ${recipients.length} employee${recipients.length !== 1 ? 's' : ''}`,
        disabled: recipients.length === 0,
        recipients,
        kind: 'broadcast',
      };
    }
    if (activeTemplate === 'co-admin-invite' || activeTemplate === 'scoped-hr-invite') {
      const wantedType = activeTemplate === 'co-admin-invite' ? 'co-admin' : 'scoped-hr';
      const team = (org?.hrTeam || []).filter((m) => m.type === wantedType && String(m.email || '').trim() && !m.isInPMS);
      const recipients = team.map((m) => ({
        'Employee Name': m.name || m.email,
        'Employee Code': m.empCode || m.id || '',
        'Email ID': m.email,
        _hrTeamMember: m,
      }));
      const label = activeTemplate === 'co-admin-invite' ? 'Co-Admin' : 'Scoped HR';
      return {
        label: `Send ${label} invite to ${recipients.length} member${recipients.length !== 1 ? 's' : ''}`,
        disabled: recipients.length === 0,
        recipients,
        kind: 'broadcast',
      };
    }
    // manager-summary
    const seen = new Set();
    (employees || []).forEach((e) => {
      const m = String(e?.['Reporting Manager Email'] || '').trim().toLowerCase();
      if (m) seen.add(m);
    });
    return {
      label: `Send summary to ${seen.size} manager${seen.size !== 1 ? 's' : ''}`,
      disabled: seen.size === 0,
      recipients: [],
      kind: 'manager-summary',
    };
  }, [activeTemplate, employees, org?.hrTeam]);

  async function handleSend() {
    if (sendConfig.disabled || sendState.status === 'sending') return;
    const tpl = templates[activeTemplate];
    if (!tpl?.subject || !tpl?.body) {
      setSendState({ status: 'failed', message: 'Subject and body are required.' });
      return;
    }
    setSendState({ status: 'sending', message: '' });
    try {
      let res;
      if (sendConfig.kind === 'broadcast') {
        // HR-team invites need per-recipient passwords (each member has their own
        // temp password); cycle-launch uses the org-wide one. Provide a tokensFor
        // resolver so the renderer picks up the right value per message.
        const tokensFor = (rcpt) => {
          const member = rcpt?._hrTeamMember;
          if (!member) return undefined;
          return {
            temporary_password: member.password || '',
            password: member.password || '',
          };
        };
        res = await sendCustomBroadcast({ org, recipients: sendConfig.recipients, theme: emailTheme, template: tpl, tokensFor });
      } else {
        res = await sendManagerSummaryEmails({ org, employees, theme: emailTheme, template: tpl });
      }
      if (res?.ok || res?.skipped) {
        const sent = res.sent ?? sendConfig.recipients.length ?? 0;
        const failed = res.failed ?? 0;
        setSendState({
          status: 'sent',
          message: res.skipped ? 'Nothing to send.' : `Sent ${sent}${failed ? ` · ${failed} failed` : ''}.`,
        });
      } else {
        setSendState({ status: 'failed', message: res?.error || 'Send failed.' });
      }
    } catch (err) {
      setSendState({ status: 'failed', message: err?.message || 'Send failed.' });
    }
  }

  // Recipients-tab state. The list shown in admin includes external managers
  // (referenced as Reporting Manager Code but not in `employees`); they are
  // first-class here per HR's request.
  const getEmail = (emp) => String(emp?.['Email ID'] || emp?.['Email'] || '').trim();
  const allRecipients = useMemo(() => buildRoster(employees), [employees]);
  const [recipSearch, setRecipSearch] = useState('');
  const [recipFilter, setRecipFilter] = useState('all'); // 'all' | 'missing'
  const [emailEdits, setEmailEdits] = useState({});
  const [bulkEmailPreview, setBulkEmailPreview] = useState(null);
  const [recipToast, setRecipToast] = useState(null);
  const bulkEmailFileRef = useRef(null);
  function showRecipToast(m) { setRecipToast(m); setTimeout(() => setRecipToast(null), 2500); }

  function commitEmail(code) {
    const newEmail = String(emailEdits[code] ?? '').trim();
    const updated = applyEmailPatch(employees, code, newEmail);
    onUpdate?.(updated);
    setEmailEdits((p) => { const x = { ...p }; delete x[code]; return x; });
    showRecipToast(newEmail ? 'Email saved' : 'Email cleared');
  }

  function downloadCurrentEmailList() {
    const rows = allRecipients.map((r) => [r['Employee Code'] || '', r['Employee Name'] || '', getEmail(r)]);
    const csv = [['Employee Code', 'Employee Name', 'Email'], ...rows].map((row) => row.map((cell) => {
      const s = String(cell ?? '');
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    }).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'employee_emails.csv';
    a.click();
  }

  async function handleBulkEmailFile(e) {
    const file = e.target.files?.[0]; if (!file) return;
    e.target.value = '';
    try {
      // Read with headers so we can support either "Code, Email" or "Code, Name, Email" layouts.
      const rows = await parseObjectsXlsx(file);
      if (!rows.length) { showRecipToast('No rows found'); return; }
      // Find the email column by name, with a fallback to whatever the second non-name column is.
      const headers = Object.keys(rows[0] || {});
      const emailKey = headers.find((h) => /^email/i.test(String(h).trim())) ||
                       headers.find((h) => !/code|name/i.test(String(h).trim())) ||
                       headers[1];
      const codeKey = headers.find((h) => /employee\s*code|^code$/i.test(String(h).trim())) || headers[0];
      const recipByCode = {};
      allRecipients.forEach((r) => { recipByCode[String(r['Employee Code'] || '').trim().toLowerCase()] = r; });
      const seen = new Set();
      const preview = rows.map((row) => {
        const code = String(row[codeKey] ?? '').trim();
        const email = String(row[emailKey] ?? '').trim();
        if (!code) return null;
        const key = code.toLowerCase();
        if (seen.has(key)) return null;
        seen.add(key);
        const match = recipByCode[key];
        const current = match ? getEmail(match) : '';
        const valid = !email || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
        return {
          code, name: match?.['Employee Name'] || '',
          newEmail: email, currentEmail: current,
          found: !!match, valid,
          changed: !!match && valid && email !== current,
        };
      }).filter(Boolean);
      setBulkEmailPreview(preview);
    } catch (err) {
      showRecipToast(err?.message || 'Could not parse file');
    }
  }

  function applyBulkEmail() {
    const valid = bulkEmailPreview.filter((r) => r.found && r.valid && r.changed);
    if (valid.length === 0) { setBulkEmailPreview(null); return; }
    let updated = employees;
    valid.forEach((r) => { updated = applyEmailPatch(updated, r.code, r.newEmail); });
    onUpdate?.(updated);
    showRecipToast(`${valid.length} email${valid.length !== 1 ? 's' : ''} updated`);
    setBulkEmailPreview(null);
  }

  // Derived brand tones
  const brand = emailTheme.brand;
  const brandDark = darkenHex(brand, 0.22);
  const brandTheme = { accent: brand, credBg: withAlpha(brand, 0.08), credBorder: withAlpha(brand, 0.25) };

  // Preview context — driven by which template is being edited so that admin
  // and manager-summary drafts don't render against an employee. Each template
  // has its own sensible "stand-in" recipient.
  const sampleEmployee = employees[previewIndex] || employees[0] || null;
  const previewContext = (() => {
    const hrTeam = org?.hrTeam || [];
    if (activeTemplate === 'co-admin-invite') {
      const sample = hrTeam.find((m) => m.type === 'co-admin' && m.email);
      return {
        kind: 'co-admin',
        name: sample?.name || 'Co-Admin Name',
        email: sample?.email || 'coadmin@example.com',
        code: sample?.empCode || '—',
        password: sample?.password || 'TempPass123',
        sampleReportees: [],
      };
    }
    if (activeTemplate === 'scoped-hr-invite') {
      const sample = hrTeam.find((m) => m.type === 'scoped-hr' && m.email);
      return {
        kind: 'scoped-hr',
        name: sample?.name || 'Scoped HR Name',
        email: sample?.email || 'scopedhr@example.com',
        code: sample?.empCode || '—',
        password: sample?.password || 'TempPass123',
        sampleReportees: [],
      };
    }
    if (activeTemplate === 'manager-summary') {
      const samples = (employees || []).slice(0, 3).map((e) => ({
        name: e['Employee Name'] || e['Employee Code'] || 'Employee',
        code: e['Employee Code'] || '',
        designation: e.Designation || e.Role || '',
      }));
      const synthName = sampleEmployee?.['Reporting Manager Name'] || 'Reporting Manager';
      const synthEmail = sampleEmployee?.['Reporting Manager Email'] || 'manager@example.com';
      return {
        kind: 'manager',
        name: synthName,
        email: synthEmail,
        code: sampleEmployee?.['Reporting Manager Code'] || '—',
        sampleReportees: samples,
      };
    }
    return {
      kind: 'employee',
      name: sampleEmployee?.['Employee Name'] || 'Aftab Alam',
      email: sampleEmployee?.['Email ID'] || sampleEmployee?.Email || 'employee@example.com',
      code: sampleEmployee?.['Employee Code'] || '1001',
      sampleReportees: [],
    };
  })();
  const previewEmp = previewContext.kind === 'employee' ? sampleEmployee : { _preview: true };
  const resolve = (text) => {
    if (!text) return text;
    const reportees = previewContext.sampleReportees;
    const reporteeList = reportees.length
      ? reportees.map((r) => `• ${r.name}${r.designation ? ` — ${r.designation}` : ''}${r.code ? ` (${r.code})` : ''}`).join('\n')
      : '—';
    return text
      .replace(/\{employee_name\}/g, previewContext.name)
      .replace(/\{employee_code\}/g, previewContext.code)
      .replace(/\{recipient_email\}/g, previewContext.email)
      .replace(/\{temporary_password\}/g, previewContext.password || org.temporaryPassword || 'Pass@1234')
      .replace(/\{password\}/g, previewContext.password || org.temporaryPassword || 'Pass@1234')
      .replace(/\{manager_name\}/g, previewContext.name)
      .replace(/\{reportee_list\}/g, reporteeList)
      .replace(/\{reportee_count\}/g, String(reportees.length || 0))
      .replace(/\{organization_name\}/g, org.name || 'Your organization')
      .replace(/\{login_url\}/g, '#');
  };
  const previewSubject = resolve(subject);
  const previewBody = resolve(body);
  const activeChannel = COMMS_CHANNELS.find((c) => c.id === activeTab) || COMMS_CHANNELS[0];

  const bodyRef = useRef(null);
  const subjectRef = useRef(null);
  function insertToken(target, token) {
    const el = target === 'subject' ? subjectRef.current : bodyRef.current;
    const setter = target === 'subject' ? setSubject : setBody;
    const value = target === 'subject' ? subject : body;
    if (!el) { setter(value + token); return; }
    const start = el.selectionStart ?? value.length;
    const end = el.selectionEnd ?? value.length;
    const next = value.slice(0, start) + token + value.slice(end);
    setter(next);
    requestAnimationFrame(() => { el.focus(); const pos = start + token.length; el.setSelectionRange(pos, pos); });
  }

  // Section refs — clicking a preview element scrolls the matching editor section into view + pulses it.
  const paletteRef = useRef(null);
  const logoSectionRef = useRef(null);
  const buttonSectionRef = useRef(null);
  const footerSectionRef = useRef(null);
  const [flashSection, setFlashSection] = useState(null);
  function focusSection(target) {
    const map = { header: paletteRef, logo: logoSectionRef, cta: buttonSectionRef, footer: footerSectionRef };
    const r = map[target]?.current;
    if (!r) return;
    r.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    setFlashSection(target);
    setTimeout(() => setFlashSection(null), 900);
  }
  const flashRing = (key) => (flashSection === key ? '0 0 0 3px rgba(79,70,229,0.25)' : 'none');

  // Derived button visual style
  function ctaStyle() {
    const base = { display: 'inline-flex', alignItems: 'center', gap: 8, padding: '11px 22px', fontSize: 13.5, fontWeight: 700, fontFamily: 'inherit', transition: 'all 160ms ease' };
    if (emailTheme.buttonStyle === 'outline') {
      return { ...base, background: '#fff', color: brand, border: `2px solid ${brand}`, borderRadius: 10, boxShadow: 'none' };
    }
    if (emailTheme.buttonStyle === 'pill') {
      return { ...base, background: `linear-gradient(135deg, ${brand} 0%, ${brandDark} 100%)`, color: '#fff', border: 'none', borderRadius: 999, boxShadow: `0 6px 14px ${withAlpha(brand, 0.32)}` };
    }
    if (emailTheme.buttonStyle === 'ghost') {
      return { ...base, background: 'transparent', color: brand, border: 'none', borderRadius: 4, padding: '4px 0', fontWeight: 700, textDecoration: 'underline', textUnderlineOffset: 4 };
    }
    // solid (default)
    return { ...base, background: `linear-gradient(135deg, ${brand} 0%, ${brandDark} 100%)`, color: '#fff', border: 'none', borderRadius: 10, boxShadow: `0 6px 14px ${withAlpha(brand, 0.32)}` };
  }
  // Free-position logo — dragged anywhere over the email card, resized via the
  // bottom-right handle. Coordinates and width live on the email theme.
  // Simple logo placement — derived from `logoPosition` + `logoSize`. No drag.
  const logoHeightPx = emailTheme.logoSize === 'small' ? 26 : emailTheme.logoSize === 'large' ? 48 : 36;
  const showLogo = emailTheme.logo && emailTheme.logoPosition !== 'hide';
  const logoJustify = emailTheme.logoPosition === 'header-center'
    ? 'center'
    : emailTheme.logoPosition === 'header-right'
    ? 'flex-end'
    : 'flex-start';

  return (
    <div>
      <style>{`@keyframes flashPulse{0%{box-shadow:0 0 0 0 rgba(79,70,229,0.35)}100%{box-shadow:0 0 0 10px rgba(79,70,229,0)}}`}</style>
      {/* Thin top-row channel tabs (underline style, minimal height). */}
      <div style={{ display: 'flex', gap: 2, marginBottom: 14, borderBottom: '1px solid #E2E8F0' }}>
        {COMMS_CHANNELS.map((c) => {
          const isActive = activeTab === c.id;
          const disabled = !c.ready;
          return (
            <button key={c.id} type="button" disabled={disabled} onClick={() => !disabled && setActiveTab(c.id)}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 7, padding: '8px 14px', border: 'none',
                borderBottom: `2px solid ${isActive ? c.accent : 'transparent'}`, marginBottom: -1,
                background: 'transparent', color: isActive ? c.accent : disabled ? '#CBD5E1' : '#64748B',
                fontWeight: isActive ? 700 : 500, fontSize: 12.5, fontFamily: 'inherit',
                cursor: disabled ? 'not-allowed' : 'pointer', transition: 'all 160ms ease',
              }}>
              <span style={{ display: 'inline-flex', opacity: disabled ? 0.55 : 1 }}>{c.icon}</span>
              <span>{c.label}</span>
              {disabled && <span style={{ fontSize: 10, fontWeight: 700, color: '#94A3B8', background: '#F1F5F9', padding: '1px 7px', borderRadius: 999 }}>Soon</span>}
            </button>
          );
        })}
      </div>

      {activeTab === 'email' && (
        <>
          {/* Always-visible primary Send button so HR can ship from any tab */}
          {(() => {
            const sending = sendState.status === 'sending';
            const sent = sendState.status === 'sent';
            const failed = sendState.status === 'failed';
            const disabled = !!sendConfig.disabled || sending;
            return (
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12, gap: 10, flexWrap: 'wrap' }}>
                <div style={{ fontSize: 12.5, color: sent ? '#166534' : failed ? '#991B1B' : '#64748B', fontWeight: sent || failed ? 700 : 500 }}>
                  {sendState.message || (sending ? 'Sending…' : 'Pick a template, edit it, then send.')}
                </div>
                <button type="button" disabled={disabled} onClick={handleSend}
                  style={{ padding: '8px 16px', background: disabled ? '#E2E8F0' : '#4F46E5', color: disabled ? '#94A3B8' : '#fff', border: 'none', borderRadius: 9, fontSize: 12.5, fontWeight: 700, cursor: disabled ? 'not-allowed' : 'pointer', fontFamily: 'inherit', display: 'inline-flex', alignItems: 'center', gap: 7, boxShadow: disabled ? 'none' : '0 4px 12px rgba(79,70,229,.25)' }}>
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
                  {sending ? 'Sending…' : (sendConfig.label || 'Send')}
                </button>
              </div>
            );
          })()}

          {/* Template switcher — drafts share the same brand/design but each has its own subject + body */}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
            {[
              { k: 'cycle-launch',     label: 'Cycle launch',     desc: 'Broadcast to all employees' },
              { k: 'co-admin-invite',  label: 'Co-Admin invite',  desc: 'Send when you add a Co-Admin' },
              { k: 'scoped-hr-invite', label: 'Scoped HR invite', desc: 'Send when you add a Scoped HR' },
              { k: 'manager-summary',  label: 'Manager summary',  desc: 'Manual send to reporting managers' },
            ].map((t) => {
              const active = activeTemplate === t.k;
              return (
                <button key={t.k} type="button" onClick={() => setActiveTemplate(t.k)}
                  style={{ flex: '1 1 200px', textAlign: 'left', padding: '10px 14px', borderRadius: 10, border: `1.5px solid ${active ? '#4F46E5' : '#E2E8F0'}`, background: active ? '#EEF2FF' : '#fff', cursor: 'pointer', fontFamily: 'inherit', boxShadow: active ? '0 4px 12px rgba(79,70,229,.15)' : 'none', transition: 'all 160ms ease' }}>
                  <div style={{ fontSize: 12.5, fontWeight: 700, color: active ? '#312E81' : '#0F172A' }}>{t.label}</div>
                  <div style={{ fontSize: 11, color: '#64748B', marginTop: 2 }}>{t.desc}</div>
                </button>
              );
            })}
          </div>

          {/* Step tabs */}
          <div style={{ display: 'inline-flex', gap: 2, padding: 4, background: '#F1F5F9', borderRadius: 11, marginBottom: 16 }}>
            {[
              { k: 'compose', label: 'Compose' },
              { k: 'design',  label: 'Design' },
              { k: 'recipients', label: `Recipients · ${allRecipients.length}` },
            ].map((t) => {
              const active = stepTab === t.k;
              return (
                <button key={t.k} type="button" onClick={() => setStepTab(t.k)}
                  style={{ padding: '7px 16px', borderRadius: 8, border: 'none', cursor: 'pointer', fontFamily: 'inherit', fontSize: 12.5, fontWeight: active ? 700 : 500, background: active ? '#fff' : 'transparent', color: active ? '#0F172A' : '#64748B', boxShadow: active ? '0 1px 4px rgba(15,23,42,.08)' : 'none', transition: 'all 160ms ease' }}>
                  {t.label}
                </button>
              );
            })}
          </div>

          {(stepTab === 'compose' || stepTab === 'design') && (
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1.05fr) minmax(0,1fr)', gap: 16 }}>

          {/* ── Editor column ── */}
          <div style={{ background: '#fff', border: '1px solid #E9EDF2', borderRadius: 14, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
            <div style={{ padding: '14px 18px', borderBottom: '1px solid #F1F5F9', display: 'flex', alignItems: 'center', gap: 10 }}>
              <div style={{ width: 30, height: 30, borderRadius: 9, background: activeChannel.accentBg, border: `1px solid ${activeChannel.accentBorder}`, display: 'flex', alignItems: 'center', justifyContent: 'center', color: activeChannel.accent }}>
                {activeChannel.icon}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13.5, fontWeight: 700, color: '#0F172A' }}>{stepTab === 'design' ? 'Brand & design' : 'Email template'}</div>
                <div style={{ fontSize: 11.5, color: '#94A3B8' }}>{stepTab === 'design' ? 'Pick a colour, drop a logo, choose a button — preview updates live.' : 'Click a token to insert it where your cursor is.'}</div>
              </div>
            </div>

            <div style={{ padding: '16px 18px 18px', display: 'flex', flexDirection: 'column', gap: 14 }}>
              {stepTab === 'compose' && <>
              {/* Subject */}
              <div>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
                  <label style={{ fontSize: 11, fontWeight: 700, color: '#94A3B8', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Subject</label>
                  <div style={{ display: 'flex', gap: 5 }}>
                    {COMMS_TOKENS.map((t) => (
                      <button key={t.key} type="button" onClick={() => insertToken('subject', t.key)}
                        style={{ fontSize: 10.5, fontWeight: 600, color: '#4338CA', background: '#EEF2FF', border: '1px solid #C7D2FE', borderRadius: 999, padding: '2px 9px', cursor: 'pointer', fontFamily: 'inherit' }}>
                        + {t.label}
                      </button>
                    ))}
                  </div>
                </div>
                <input ref={subjectRef} value={subject} onChange={(e) => setSubject(e.target.value)}
                  style={{ width: '100%', boxSizing: 'border-box', border: '1.5px solid #E2E8F0', borderRadius: 9, padding: '10px 13px', fontSize: 13.5, outline: 'none', fontFamily: 'inherit', color: '#0D1117', background: '#fff' }} />
              </div>

              {/* Body */}
              <div style={{ display: 'flex', flexDirection: 'column', flex: 1 }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
                  <label style={{ fontSize: 11, fontWeight: 700, color: '#94A3B8', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Body</label>
                  <div style={{ display: 'flex', gap: 5 }}>
                    {COMMS_TOKENS.map((t) => (
                      <button key={t.key} type="button" onClick={() => insertToken('body', t.key)}
                        style={{ fontSize: 10.5, fontWeight: 600, color: '#4338CA', background: '#EEF2FF', border: '1px solid #C7D2FE', borderRadius: 999, padding: '2px 9px', cursor: 'pointer', fontFamily: 'inherit' }}>
                        + {t.label}
                      </button>
                    ))}
                  </div>
                </div>
                <textarea ref={bodyRef} value={body} onChange={(e) => setBody(e.target.value)} rows={14}
                  style={{ width: '100%', boxSizing: 'border-box', border: '1.5px solid #E2E8F0', borderRadius: 9, padding: '12px 14px', fontSize: 13, lineHeight: 1.7, outline: 'none', fontFamily: "'Geist Mono','SF Mono',Menlo,monospace", color: '#0D1117', resize: 'vertical', background: '#fff' }} />
              </div>

              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '6px 2px' }}>
                <span style={{ fontSize: 12, color: '#64748B' }}>Want a different look or logo?</span>
                <button type="button" onClick={() => setStepTab('design')} style={{ background: 'transparent', border: 'none', color: '#4F46E5', fontWeight: 700, fontSize: 12.5, cursor: 'pointer', fontFamily: 'inherit', padding: 0 }}>
                  Customize design →
                </button>
              </div>
              </>}

              {stepTab === 'design' && <>
              {/* ── Design: palette / logo / button / footer ── */}
              <div ref={paletteRef} style={{ border: `1.5px solid ${flashSection === 'header' ? '#A5B4FC' : '#E2E8F0'}`, borderRadius: 10, background: '#fff', padding: '12px 14px', display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10, boxShadow: flashRing('header'), transition: 'box-shadow 260ms ease, border-color 260ms ease' }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: '#94A3B8', textTransform: 'uppercase', letterSpacing: '0.05em', minWidth: 80 }}>Palette</div>
                {COMMS_THEME_PRESETS.map((p) => {
                  const active = brand.toLowerCase() === p.brand.toLowerCase();
                  return (
                    <button key={p.id} type="button" onClick={() => applyPreset(p)} title={p.label}
                      style={{ width: 24, height: 24, borderRadius: 999, padding: 0, cursor: 'pointer', border: `2px solid ${active ? '#0F172A' : 'transparent'}`, background: p.brand, boxShadow: active ? '0 0 0 3px rgba(15,23,42,.08)' : 'inset 0 0 0 1px rgba(15,23,42,.08)' }} />
                  );
                })}
                <label style={{ position: 'relative', width: 24, height: 24, borderRadius: 999, cursor: 'pointer', border: '1.5px solid #E2E8F0', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', color: '#64748B', background: '#fff' }} title="Custom">
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M12 5v14M5 12h14"/></svg>
                  <input type="color" value={brand} onChange={(e) => updateTheme({ brand: e.target.value })} style={{ position: 'absolute', inset: 0, opacity: 0, cursor: 'pointer' }} />
                </label>
              </div>

              {/* Logo section — upload + position + size */}
              <div ref={logoSectionRef} style={{ border: `1.5px solid ${flashSection === 'logo' ? '#A5B4FC' : '#E2E8F0'}`, borderRadius: 10, background: '#fff', padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 10, boxShadow: flashRing('logo'), transition: 'box-shadow 260ms ease, border-color 260ms ease' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: '#94A3B8', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Logo</div>
                  {emailTheme.logo ? (
                    <>
                      <img src={emailTheme.logo} alt="Logo" style={{ height: 28, maxWidth: 100, borderRadius: 5, background: '#F1F5F9', border: '1px solid #E2E8F0', padding: 2, objectFit: 'contain' }} />
                      <label style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '5px 10px', border: '1.5px solid #E2E8F0', borderRadius: 7, cursor: 'pointer', fontSize: 11.5, fontWeight: 600, color: '#475569', background: '#fff' }}>
                        Replace
                        <input
                          type="file"
                          accept="image/*"
                          onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; uploadLogo(f); }}
                          style={{ display: 'none' }}
                        />
                      </label>
                      <button type="button" onClick={() => updateTheme({ logo: null })} style={{ padding: '5px 10px', background: '#fff', color: '#DC2626', border: '1.5px solid #FECACA', borderRadius: 7, fontSize: 11, cursor: 'pointer', fontFamily: 'inherit', fontWeight: 600 }}>
                        Remove
                      </button>
                    </>
                  ) : (
                    <>
                      <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 12px', border: '1.5px dashed #CBD5E1', borderRadius: 8, cursor: 'pointer', fontSize: 11.5, fontWeight: 600, color: '#475569', background: '#fff' }}>
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
                        Upload company logo
                        <input
                          type="file"
                          accept="image/*"
                          onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; uploadLogo(f); }}
                          style={{ display: 'none' }}
                        />
                      </label>
                      {org?.brandLogo && (
                        <button type="button"
                          onClick={() => updateTheme({ logo: org.brandLogo })}
                          style={{ padding: '6px 12px', background: '#EEF2FF', color: '#4338CA', border: '1.5px solid #C7D2FE', borderRadius: 8, fontSize: 11.5, cursor: 'pointer', fontFamily: 'inherit', fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                          <img src={org.brandLogo} alt="" style={{ width: 16, height: 16, borderRadius: 3, objectFit: 'contain' }} />
                          Use org logo
                        </button>
                      )}
                    </>
                  )}
                </div>
                {emailTheme.logo && (
                  <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', paddingTop: 6, borderTop: '1px dashed #E2E8F0' }}>
                    <div>
                      <div style={{ fontSize: 10.5, fontWeight: 600, color: '#94A3B8', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4 }}>Position</div>
                      <div style={{ display: 'inline-flex', gap: 4, background: '#F1F5F9', padding: 3, borderRadius: 8 }}>
                        {LOGO_POSITIONS.map((p) => {
                          const active = (emailTheme.logoPosition || 'header-left') === p.id;
                          return (
                            <button key={p.id} type="button" onClick={() => updateTheme({ logoPosition: p.id })}
                              style={{ padding: '5px 11px', borderRadius: 6, border: 'none', background: active ? '#fff' : 'transparent', color: active ? '#0F172A' : '#64748B', fontWeight: active ? 700 : 500, fontSize: 11, cursor: 'pointer', fontFamily: 'inherit', boxShadow: active ? '0 1px 3px rgba(15,23,42,.08)' : 'none' }}>
                              {p.label}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                    <div>
                      <div style={{ fontSize: 10.5, fontWeight: 600, color: '#94A3B8', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4 }}>Size</div>
                      <div style={{ display: 'inline-flex', gap: 4, background: '#F1F5F9', padding: 3, borderRadius: 8 }}>
                        {LOGO_SIZES.map((s) => {
                          const active = (emailTheme.logoSize || 'medium') === s;
                          return (
                            <button key={s} type="button" onClick={() => updateTheme({ logoSize: s })}
                              style={{ padding: '5px 11px', borderRadius: 6, border: 'none', background: active ? '#fff' : 'transparent', color: active ? '#0F172A' : '#64748B', fontWeight: active ? 700 : 500, fontSize: 11, cursor: 'pointer', fontFamily: 'inherit', textTransform: 'capitalize', boxShadow: active ? '0 1px 3px rgba(15,23,42,.08)' : 'none' }}>
                              {s}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  </div>
                )}
              </div>

              {/* Button section — label + style + alignment */}
              <div ref={buttonSectionRef} style={{ border: `1.5px solid ${flashSection === 'cta' ? '#A5B4FC' : '#E2E8F0'}`, borderRadius: 10, background: '#fff', padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 10, boxShadow: flashRing('cta'), transition: 'box-shadow 260ms ease, border-color 260ms ease' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: '#94A3B8', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Button</div>
                  <input type="text" value={emailTheme.ctaLabel} onChange={(e) => updateTheme({ ctaLabel: e.target.value })}
                    placeholder="Log in to Performance Hub"
                    style={{ flex: 1, minWidth: 200, border: '1.5px solid #E2E8F0', borderRadius: 7, padding: '6px 10px', fontSize: 12.5, outline: 'none', fontFamily: 'inherit', color: '#0F172A', background: '#fff' }} />
                </div>
                <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                  <div>
                    <div style={{ fontSize: 10.5, fontWeight: 600, color: '#94A3B8', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4 }}>Style</div>
                    <div style={{ display: 'inline-flex', gap: 4, background: '#F1F5F9', padding: 3, borderRadius: 8 }}>
                      {BUTTON_STYLES.map((s) => (
                        <button key={s.id} type="button" onClick={() => updateTheme({ buttonStyle: s.id })}
                          style={{ padding: '5px 10px', borderRadius: 6, border: 'none', background: emailTheme.buttonStyle === s.id ? '#fff' : 'transparent', color: emailTheme.buttonStyle === s.id ? '#0F172A' : '#64748B', fontWeight: emailTheme.buttonStyle === s.id ? 700 : 500, fontSize: 11, cursor: 'pointer', fontFamily: 'inherit', boxShadow: emailTheme.buttonStyle === s.id ? '0 1px 3px rgba(15,23,42,.08)' : 'none' }}>
                          {s.label}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div>
                    <div style={{ fontSize: 10.5, fontWeight: 600, color: '#94A3B8', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4 }}>Align</div>
                    <div style={{ display: 'inline-flex', gap: 4, background: '#F1F5F9', padding: 3, borderRadius: 8 }}>
                      {['left', 'center', 'right'].map((a) => (
                        <button key={a} type="button" onClick={() => updateTheme({ buttonAlign: a })}
                          style={{ padding: '5px 10px', borderRadius: 6, border: 'none', background: emailTheme.buttonAlign === a ? '#fff' : 'transparent', color: emailTheme.buttonAlign === a ? '#0F172A' : '#64748B', fontWeight: emailTheme.buttonAlign === a ? 700 : 500, fontSize: 11, cursor: 'pointer', fontFamily: 'inherit', textTransform: 'capitalize', boxShadow: emailTheme.buttonAlign === a ? '0 1px 3px rgba(15,23,42,.08)' : 'none' }}>
                          {a}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              </div>

              {/* Footer section */}
              <div ref={footerSectionRef} style={{ border: `1.5px solid ${flashSection === 'footer' ? '#A5B4FC' : '#E2E8F0'}`, borderRadius: 10, background: '#fff', padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 10, boxShadow: flashRing('footer'), transition: 'box-shadow 260ms ease, border-color 260ms ease' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: '#94A3B8', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Footer</div>
                  <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: '#475569', cursor: 'pointer', userSelect: 'none', marginLeft: 'auto' }}>
                    <input type="checkbox" checked={emailTheme.showFooter !== false}
                      onChange={(e) => updateTheme({ showFooter: e.target.checked })}
                      style={{ width: 14, height: 14, accentColor: '#4F46E5' }} />
                    <span>Show footer</span>
                  </label>
                  <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: '#475569', cursor: 'pointer', userSelect: 'none' }}>
                    <input type="checkbox" checked={emailTheme.showZaroBadge !== false}
                      onChange={(e) => updateTheme({ showZaroBadge: e.target.checked })}
                      disabled={emailTheme.showFooter === false}
                      style={{ width: 14, height: 14, accentColor: '#4F46E5' }} />
                    <span>Show Zaro HR badge</span>
                  </label>
                  <button type="button" onClick={() => setEmailTheme(DEFAULT_EMAIL_THEME)}
                    style={{ padding: '6px 12px', background: 'transparent', color: '#64748B', border: 'none', borderRadius: 7, fontSize: 11.5, cursor: 'pointer', fontFamily: 'inherit', fontWeight: 600 }}>
                    Reset all
                  </button>
                </div>
                {emailTheme.showFooter !== false && (
                  <input type="text" value={emailTheme.footerText} onChange={(e) => updateTheme({ footerText: e.target.value })}
                    style={{ width: '100%', boxSizing: 'border-box', border: '1.5px solid #E2E8F0', borderRadius: 7, padding: '7px 10px', fontSize: 12.5, outline: 'none', fontFamily: 'inherit', color: '#0F172A', background: '#fff' }} />
                )}
              </div>

              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '6px 2px' }}>
                <span style={{ fontSize: 11.5, color: '#94A3B8' }}>Tip · click any element in the preview to jump to its control.</span>
                <button type="button" onClick={() => setStepTab('compose')} style={{ background: 'transparent', border: 'none', color: '#4F46E5', fontWeight: 700, fontSize: 12.5, cursor: 'pointer', fontFamily: 'inherit', padding: 0 }}>
                  ← Back to compose
                </button>
              </div>
              </>}
            </div>
          </div>

          {/* ── Preview column (no chrome) ── */}
          <div style={{ background: '#fff', border: '1px solid #E9EDF2', borderRadius: 14, overflow: 'hidden', display: 'flex', flexDirection: 'column', position: 'relative' }}>
            {/* Preview toolbar — sits above the rendered email instead of floating */}
            {employees.length > 0 && (
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, padding: '10px 14px', borderBottom: '1px solid #F1F5F9', background: '#fff' }}>
                <div style={{ display: 'inline-flex', alignItems: 'center', gap: 7, fontSize: 11, fontWeight: 700, color: '#94A3B8', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-10 6L2 7"/></svg>
                  Live preview
                </div>
                <label style={{ display: 'inline-flex', alignItems: 'center', gap: 7, fontSize: 12, color: '#475569' }}>
                  <span style={{ color: '#94A3B8' }}>Preview as</span>
                  {previewContext.kind === 'employee' ? (
                    <select value={previewIndex} onChange={(e) => setPreviewIndex(Number(e.target.value))}
                      style={{ border: '1.5px solid #E2E8F0', background: '#fff', padding: '5px 10px', borderRadius: 7, fontSize: 12, fontFamily: 'inherit', color: '#0F172A', fontWeight: 600, outline: 'none', cursor: 'pointer', maxWidth: 180 }}>
                      {employees.map((e, i) => (
                        <option key={e['Employee Code'] + i} value={i}>
                          {e['Employee Name'] || e['Employee Code']}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <span style={{ padding: '5px 10px', borderRadius: 7, fontSize: 12, fontWeight: 600, color: '#0F172A', background: '#F1F5F9', border: '1.5px solid #E2E8F0', maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {previewContext.kind === 'admin' ? `${previewContext.name} · admin` : `${previewContext.name} · manager`}
                    </span>
                  )}
                </label>
              </div>
            )}
            {previewEmp ? (
              <div style={{ padding: '20px 18px 22px', flex: 1, overflow: 'auto', background: 'linear-gradient(180deg,#F1F5F9 0%,#FAFBFF 100%)' }}>
                {/* The rendered email — styling-only. Clicks scroll the editor to the relevant controls. */}
                <div style={{ position: 'relative', background: '#fff', borderRadius: 14, overflow: 'hidden', boxShadow: '0 10px 30px rgba(15,23,42,.08)', border: '1px solid #E2E8F0' }}>
                  {/* Brand header */}
                  <PreviewHotspot label="Edit header" onClick={() => focusSection('header')}>
                    <div style={{ background: `linear-gradient(135deg, ${brand} 0%, ${brandDark} 100%)`, padding: '22px 24px', color: '#fff', position: 'relative', overflow: 'hidden' }}>
                      <div style={{ position: 'absolute', right: -40, top: -40, width: 160, height: 160, borderRadius: '50%', background: 'rgba(255,255,255,.08)' }} />
                      {showLogo && (
                        <div style={{ position: 'relative', display: 'flex', justifyContent: logoJustify, marginBottom: 12 }}>
                          <PreviewHotspot label="Edit logo" onClick={(e) => { e.stopPropagation(); focusSection('logo'); }} inline>
                            <img src={emailTheme.logo} alt="Logo" draggable={false}
                              style={{ height: logoHeightPx, width: 'auto', maxWidth: 200, borderRadius: 6, background: 'rgba(255,255,255,0.95)', padding: 4, boxSizing: 'border-box', objectFit: 'contain', display: 'block' }} />
                          </PreviewHotspot>
                        </div>
                      )}
                      <div style={{ position: 'relative', minWidth: 0 }}>
                        {(() => {
                          const effective = emailTheme.headerLabel != null ? emailTheme.headerLabel : (org.name || '');
                          if (!effective.trim()) return null;
                          return (
                            <div style={{ fontSize: 11.5, fontWeight: 700, opacity: 0.78, letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: 6 }}>
                              {effective}
                            </div>
                          );
                        })()}
                        {previewSubject.trim() && (
                          <div style={{ fontSize: 19, fontWeight: 800, lineHeight: 1.3 }}>{previewSubject}</div>
                        )}
                      </div>
                    </div>
                  </PreviewHotspot>

                  {/* Body */}
                  <div style={{ position: 'relative' }}>
                    <div style={{ position: 'relative', padding: '22px 26px 14px', fontSize: 13.5, lineHeight: 1.7, color: '#1E293B' }}>
                      {renderEmailBody(previewBody, brandTheme)}
                    </div>

                    {/* CTA */}
                    <PreviewHotspot label="Edit button" onClick={() => focusSection('cta')}>
                      <div style={{ padding: '0 26px 22px', display: 'flex', justifyContent: emailTheme.buttonAlign === 'center' ? 'center' : emailTheme.buttonAlign === 'right' ? 'flex-end' : 'flex-start' }}>
                        <div style={ctaStyle()}>
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><polyline points="10 17 15 12 10 7"/><line x1="15" y1="12" x2="3" y2="12"/></svg>
                          {emailTheme.ctaLabel || 'Log in to Performance Hub'}
                        </div>
                      </div>
                    </PreviewHotspot>
                  </div>

                  {/* Footer */}
                  {emailTheme.showFooter !== false && (
                    <PreviewHotspot label="Edit footer" onClick={() => focusSection('footer')}>
                      <div style={{ borderTop: '1px solid #F1F5F9', background: '#FAFBFF', padding: '12px 26px', fontSize: 11, color: '#94A3B8', display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
                        <span>{emailTheme.footerText || ''}</span>
                        {emailTheme.showZaroBadge !== false && <span>Powered by Zaro HR</span>}
                      </div>
                    </PreviewHotspot>
                  )}
                </div>
              </div>
            ) : (
              <div style={{ padding: '32px 20px', textAlign: 'center', color: '#94A3B8', fontSize: 13 }}>
                Upload employees to see a live preview.
              </div>
            )}
          </div>

        </div>
          )}

          {stepTab === 'recipients' && (
            <ComposeRecipients
              recipients={allRecipients}
              groups={groups}
              recipSearch={recipSearch} setRecipSearch={setRecipSearch}
              recipFilter={recipFilter} setRecipFilter={setRecipFilter}
              emailEdits={emailEdits} setEmailEdits={setEmailEdits}
              commitEmail={commitEmail}
              getEmail={getEmail}
              bulkEmailFileRef={bulkEmailFileRef}
              handleBulkEmailFile={handleBulkEmailFile}
              bulkEmailPreview={bulkEmailPreview} setBulkEmailPreview={setBulkEmailPreview}
              applyBulkEmail={applyBulkEmail}
              downloadCurrentEmailList={downloadCurrentEmailList}
              recipToast={recipToast}
              sendConfig={sendConfig}
              sendState={sendState}
              onSend={handleSend}
              activeTemplate={activeTemplate}
            />
          )}
        </>
      )}

      {activeTab !== 'email' && (
        <div style={{ background: '#fff', border: '1.5px dashed #E2E8F0', borderRadius: 14, padding: '48px 20px', textAlign: 'center' }}>
          <div style={{ display: 'inline-flex', width: 46, height: 46, borderRadius: 12, background: activeChannel.accentBg, border: `1px solid ${activeChannel.accentBorder}`, alignItems: 'center', justifyContent: 'center', color: activeChannel.accent, marginBottom: 12 }}>
            {activeChannel.icon}
          </div>
          <div style={{ fontSize: 15, fontWeight: 700, color: '#0F172A' }}>{activeChannel.label} — coming soon</div>
          <div style={{ fontSize: 12.5, color: '#94A3B8', marginTop: 4 }}>This channel will unlock once delivery is wired.</div>
        </div>
      )}
    </div>
  );
}

/* ── Stage Control ──────────────────────────────────────────── */
function ModuleStageControl({ employees, onUpdate, orgKey }) {
  // When HR forces a stage change, also update the goal workflow so the manager's approvals queue
  // and notifications fire — otherwise stage and submission.status drift apart.
  function syncWorkflowForStageChange(codeToTarget) {
    if (!orgKey || !codeToTarget || codeToTarget.size === 0) return;
    const wf = loadWorkflowState(orgKey);
    const nextSubs = { ...(wf.submissions || {}) };
    const newNotifs = [];
    const nowIso = new Date().toISOString();
    const empByCode = {};
    employees.forEach((e) => { empByCode[normalizeCodeStr(e['Employee Code'])] = e; });
    codeToTarget.forEach((targetStage, rawCode) => {
      const key = normalizeCodeStr(rawCode);
      const emp = empByCode[key];
      if (!emp) return;
      const existing = nextSubs[key] || null;
      const prevStatus = existing?.status || null;
      const newStatus = stageToStatus(targetStage);
      const managerCode = String(emp['Reporting Manager Code'] || '').trim();
      const employeeName = emp['Employee Name'] || emp['Employee Code'];
      const next = {
        ...(existing || {
          employeeCode: emp['Employee Code'],
          employeeName,
          managerCode,
          goals: [],
          createdAt: nowIso,
        }),
        status: newStatus,
        updatedAt: nowIso,
        managerCode: existing?.managerCode || managerCode,
      };
      if (newStatus === 'pending-manager') {
        next.submittedAt = existing?.submittedAt || nowIso;
      }
      if (newStatus === 'approved') {
        next.approvedAt = existing?.approvedAt || nowIso;
        next.managerDecisionAt = nowIso;
        next.managerApprovedBy = 'hr-admin';
        next.managerNote = existing?.managerNote || 'Advanced by HR.';
      }
      if (newStatus === 'draft') {
        // HR rolled the employee back to goal-creation — clear approval fields so editing re-opens.
        next.managerDecisionAt = null;
        next.managerNote = '';
      }
      nextSubs[key] = next;

      // Notifications — only when meaningful.
      if (newStatus === 'pending-manager' && managerCode && prevStatus !== 'pending-manager') {
        newNotifs.push(makeNotif('goal-submitted', {
          recipientCode: managerCode,
          senderCode: emp['Employee Code'],
          submissionCode: emp['Employee Code'],
          title: `${employeeName} submitted goals`,
          message: `${employeeName} sent a goal plan for your approval. (Advanced by HR.)`,
        }));
      }
      if (newStatus === 'approved' && prevStatus !== 'approved') {
        newNotifs.push(makeNotif('goal-approved', {
          recipientCode: emp['Employee Code'],
          submissionCode: emp['Employee Code'],
          title: 'Goals approved',
          message: 'Your goal plan has been approved by HR.',
        }));
      }
      if (newStatus === 'draft' && prevStatus && prevStatus !== 'draft') {
        newNotifs.push(makeNotif('goal-reminder', {
          recipientCode: emp['Employee Code'],
          submissionCode: emp['Employee Code'],
          title: 'Goal-setting reopened',
          message: 'HR has reopened goal-setting for you. Please revisit and resubmit your plan.',
        }));
      }
    });
    saveWorkflowState(orgKey, {
      submissions: nextSubs,
      notifications: [...newNotifs, ...(wf.notifications || [])],
    });
  }

  const [mode, setMode]             = useState('single');
  const [search, setSearch]         = useState('');
  const [filterStage, setFilterStage] = useState('');
  const [selected, setSelected]     = useState(new Set());
  const [targetStage, setTargetStage] = useState('pending-approval');
  const [bulkPreview, setBulkPreview] = useState(null);
  const [bulkOverride, setBulkOverride] = useState(''); // optional: force all rows to one target stage
  const [toast, setToast]           = useState(null);
  const fileRef = useRef(null);

  function showToast(msg) { setToast(msg); setTimeout(() => setToast(null), 3000); }

  const stageSummary = useMemo(() => {
    const c = {}; EMP_STAGES.forEach((s) => { c[s.id] = 0; });
    employees.forEach((e) => { const s = getEmpStage(e); c[s] = (c[s] || 0) + 1; });
    return c;
  }, [employees]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return employees.filter((e) => {
      const matchSearch = !q || `${e['Employee Name'] || ''} ${e['Employee Code'] || ''}`.toLowerCase().includes(q);
      const matchStage = !filterStage || getEmpStage(e) === filterStage;
      return matchSearch && matchStage;
    });
  }, [employees, search, filterStage]);

  function toggleAllVisible() {
    const allCodes = new Set(filtered.map((e) => e['Employee Code']));
    const allSelected = filtered.length > 0 && filtered.every((e) => selected.has(e['Employee Code']));
    setSelected(allSelected ? new Set([...selected].filter((c) => !allCodes.has(c))) : new Set([...selected, ...allCodes]));
  }
  function toggle(code) { setSelected((p) => { const n = new Set(p); n.has(code) ? n.delete(code) : n.add(code); return n; }); }

  function applySelected() {
    if (!selected.size) return;
    const updated = employees.map((e) => selected.has(e['Employee Code']) ? { ...e, _pmsStage: targetStage } : e);
    onUpdate(updated);
    // Keep the workflow submissions + notifications in sync with the stage change.
    const codeToTarget = new Map();
    selected.forEach((code) => { codeToTarget.set(code, targetStage); });
    syncWorkflowForStageChange(codeToTarget);
    showToast(`${selected.size} employee${selected.size !== 1 ? 's' : ''} moved to "${EMP_STAGES.find((s) => s.id === targetStage)?.label}"`);
    setSelected(new Set());
  }

  // Match a free-form stage label from a sheet to an EMP_STAGES id (case-insensitive, accepts label/short/id).
  function resolveStageId(raw) {
    const v = String(raw || '').trim().toLowerCase();
    if (!v) return null;
    const found = EMP_STAGES.find((s) =>
      s.id.toLowerCase() === v ||
      s.label.toLowerCase() === v ||
      s.short.toLowerCase() === v
    );
    return found?.id || null;
  }

  async function handleFile(e) {
    const file = e.target.files?.[0]; if (!file) return;
    const empByCode = {};
    employees.forEach((emp) => { empByCode[String(emp['Employee Code'] || '').trim().toLowerCase()] = emp; });
    const rows = await parseObjectsXlsx(file);
    const norm = rows.map((r, i) => {
      const codeRaw = String(r['Employee Code'] ?? r['employee code'] ?? r['Code'] ?? '').trim();
      const fromRaw = String(r['Current Stage'] ?? r['From Stage'] ?? r['current stage'] ?? '').trim();
      const toRaw = String(r['Target Stage'] ?? r['New Stage'] ?? r['To Stage'] ?? r['target stage'] ?? '').trim();
      const code = codeRaw.toLowerCase();
      const emp = empByCode[code];
      const fromId = resolveStageId(fromRaw);
      const toId = resolveStageId(toRaw);
      const actualFromId = emp ? getEmpStage(emp) : null;
      let status = 'ok'; let reason = '';
      if (!codeRaw) { status = 'error'; reason = 'Missing Employee Code'; }
      else if (!emp) { status = 'error'; reason = 'Code not found'; }
      else if (fromRaw && !fromId) { status = 'error'; reason = `Unknown stage "${fromRaw}"`; }
      else if (toRaw && !toId) { status = 'error'; reason = `Unknown stage "${toRaw}"`; }
      else if (fromId && actualFromId !== fromId) { status = 'mismatch'; reason = `Sheet says "${fromRaw}", DB has "${EMP_STAGES.find((s) => s.id === actualFromId)?.label}"`; }
      else if (!toId && !bulkOverride) { status = 'error'; reason = 'Missing Target Stage (and no override set)'; }
      return {
        index: i + 2,
        code: codeRaw,
        name: emp?.['Employee Name'] || '',
        actualFromId,
        sheetFromId: fromId,
        toId,
        status,
        reason,
      };
    });
    setBulkPreview(norm);
    e.target.value = '';
  }

  function applyBulk() {
    if (!bulkPreview) return;
    const okRows = bulkPreview.filter((r) => r.status === 'ok' && (r.toId || bulkOverride));
    if (!okRows.length) return;
    const codeToTarget = new Map();
    okRows.forEach((r) => { codeToTarget.set(r.code.toLowerCase(), r.toId || bulkOverride); });
    const updated = employees.map((e) => {
      const code = String(e['Employee Code'] || '').trim().toLowerCase();
      const target = codeToTarget.get(code);
      return target ? { ...e, _pmsStage: target } : e;
    });
    onUpdate(updated);
    syncWorkflowForStageChange(codeToTarget);
    showToast(`${okRows.length} employee${okRows.length !== 1 ? 's' : ''} updated`);
    setBulkPreview(null);
  }

  function downloadStageTemplate() {
    const headers = ['Employee Code', 'Employee Name', 'Current Stage', 'Target Stage'];
    // Pre-fill with all real employees so the user can edit-in-place; Target Stage left blank
    // (HR fills it themselves; movement can be forward OR backward — see "rollback" instructions row).
    const dataRows = employees.map((e) => [
      e['Employee Code'] || '',
      e['Employee Name'] || '',
      EMP_STAGES.find((s) => s.id === getEmpStage(e))?.label || '',
      '',
    ]);
    const rows = dataRows.length > 0 ? dataRows : [['E001', 'Sample Name', 'Goal Creation', 'Pending Approval']];
    const csv = [headers, ...rows].map((r) => r.map((v) => /[",\n]/.test(v) ? `"${String(v).replace(/"/g, '""')}"` : v).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'stage_change.csv'; a.click();
  }

  const inputStyle = { border: '1.5px solid #E2E8F0', borderRadius: 8, padding: '8px 12px', fontSize: 13, outline: 'none', fontFamily: 'inherit', color: '#0D1117', background: '#fff' };
  const btnP = { padding: '9px 18px', background: '#4F46E5', color: '#fff', border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' };
  const btnS = { padding: '9px 16px', background: '#fff', color: '#374151', border: '1.5px solid #E2E8F0', borderRadius: 8, fontSize: 13, cursor: 'pointer', fontFamily: 'inherit' };

  const okCount = bulkPreview ? bulkPreview.filter((r) => r.status === 'ok').length : 0;
  const mismatchCount = bulkPreview ? bulkPreview.filter((r) => r.status === 'mismatch').length : 0;
  const errorCount = bulkPreview ? bulkPreview.filter((r) => r.status === 'error').length : 0;

  return (
    <div style={{ position: 'relative', paddingBottom: selected.size > 0 ? 90 : 0 }}>
      {toast && <div style={{ position: 'fixed', bottom: 28, right: 28, zIndex: 50, background: '#F0FDF4', border: '1px solid #BBF7D0', borderRadius: 9, padding: '10px 16px', fontSize: 12.5, fontWeight: 600, color: '#15803D', boxShadow: '0 4px 16px rgba(0,0,0,.1)' }}>✓ {toast}</div>}

      {/* Stage chips — clickable to filter */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 18 }}>
        <button type="button" onClick={() => setFilterStage('')}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 14px', borderRadius: 999, background: !filterStage ? '#0F172A' : '#fff', border: `1.5px solid ${!filterStage ? '#0F172A' : '#E2E8F0'}`, fontSize: 12, fontWeight: 700, color: !filterStage ? '#fff' : '#475569', cursor: 'pointer', fontFamily: 'inherit' }}>
          All<span style={{ background: !filterStage ? 'rgba(255,255,255,.18)' : '#F1F5F9', borderRadius: 999, padding: '0 8px', fontSize: 11.5, fontWeight: 700 }}>{employees.length}</span>
        </button>
        {EMP_STAGES.map((s) => {
          const active = filterStage === s.id;
          const count = stageSummary[s.id] || 0;
          return (
            <button key={s.id} type="button" onClick={() => setFilterStage(active ? '' : s.id)}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 8, padding: '6px 14px', borderRadius: 999, background: active ? s.color : s.bg, border: `1.5px solid ${active ? s.color : s.border}`, fontSize: 12, fontWeight: 700, color: active ? '#fff' : s.color, cursor: 'pointer', fontFamily: 'inherit', transition: 'all 180ms ease' }}>
              <span style={{ width: 7, height: 7, borderRadius: '50%', background: active ? '#fff' : s.color }} />
              {s.label}
              <span style={{ background: active ? 'rgba(255,255,255,.22)' : 'rgba(15,23,42,.06)', borderRadius: 999, padding: '0 8px', fontSize: 11.5, fontWeight: 700 }}>{count}</span>
            </button>
          );
        })}
      </div>

      {/* Mode toggle */}
      <div style={{ display: 'flex', background: '#F1F5F9', borderRadius: 10, padding: 4, gap: 2, width: 'fit-content', marginBottom: 18 }}>
        {[{ id: 'single', label: 'Select in table' }, { id: 'bulk', label: 'Bulk via sheet' }].map((m) => (
          <button key={m.id} type="button" onClick={() => { setMode(m.id); setBulkPreview(null); setSelected(new Set()); }}
            style={{ padding: '7px 18px', borderRadius: 7, border: 'none', cursor: 'pointer', fontFamily: 'inherit', fontSize: 12.5, fontWeight: mode === m.id ? 700 : 500, background: mode === m.id ? '#fff' : 'transparent', color: mode === m.id ? '#0D1117' : '#64748B', boxShadow: mode === m.id ? '0 1px 4px rgba(0,0,0,.08)' : 'none', transition: 'all 160ms ease' }}>
            {m.label}
          </button>
        ))}
      </div>

      {mode === 'single' && (
        <>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 12, flexWrap: 'wrap' }}>
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search name or code…" style={{ ...inputStyle, width: 260 }} />
            {filterStage && (
              <span style={{ fontSize: 12, color: '#64748B' }}>Filtered by <strong style={{ color: '#0F172A' }}>{EMP_STAGES.find((s) => s.id === filterStage)?.label}</strong></span>
            )}
            <span style={{ fontSize: 12, color: '#94A3B8', marginLeft: 'auto' }}>{filtered.length} of {employees.length}</span>
          </div>
          <div style={{ border: '1px solid #E9EDF2', borderRadius: 12, overflow: 'hidden', background: '#fff' }}>
            <table style={{ width: '100%', fontSize: 13, borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ background: '#F8FAFC', borderBottom: '1px solid #E9EDF2' }}>
                  <th style={{ padding: '11px 14px', width: 40 }}>
                    <input type="checkbox"
                      checked={filtered.length > 0 && filtered.every((e) => selected.has(e['Employee Code']))}
                      onChange={toggleAllVisible} />
                  </th>
                  {['Name', 'Code', 'Group', 'Current Stage'].map((h) => (
                    <th key={h} style={{ padding: '11px 14px', textAlign: 'left', fontSize: 11, fontWeight: 700, color: '#94A3B8', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtered.length === 0 && (
                  <tr><td colSpan={5} style={{ padding: '20px', textAlign: 'center', color: '#94A3B8' }}>No employees match.</td></tr>
                )}
                {filtered.slice(0, 100).map((emp) => {
                  const code = emp['Employee Code'] || '—';
                  const isChecked = selected.has(code);
                  return (
                    <tr key={code} style={{ borderTop: '1px solid #F1F5F9', background: isChecked ? '#EEF2FF' : 'transparent', cursor: 'pointer', transition: 'background 120ms ease' }} onClick={() => toggle(code)}>
                      <td style={{ padding: '10px 14px' }}><input type="checkbox" checked={isChecked} onChange={() => {}} /></td>
                      <td style={{ padding: '10px 14px', fontWeight: 500, color: '#0D1117' }}>{emp['Employee Name'] || code}</td>
                      <td style={{ padding: '10px 14px', fontFamily: 'monospace', fontWeight: 700, color: '#4F46E5' }}>{code}</td>
                      <td style={{ padding: '10px 14px', color: '#64748B' }}>{emp['Group Name'] || emp.assignedGoalGroupName || '—'}</td>
                      <td style={{ padding: '10px 14px' }}><StagePill stageId={getEmpStage(emp)} /></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Sticky action panel — appears when there's a selection */}
          {selected.size > 0 && (
            <div style={{ position: 'sticky', bottom: 0, marginTop: 18, padding: '16px 20px', background: 'linear-gradient(180deg,#FFFFFF 0%,#FAFBFF 100%)', border: '1.5px solid #C7D2FE', borderRadius: 14, boxShadow: '0 -10px 24px rgba(15,23,42,0.08)', display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <div style={{ width: 36, height: 36, borderRadius: 10, background: '#4F46E5', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 14, fontWeight: 800 }}>{selected.size}</div>
                <div>
                  <div style={{ fontSize: 13.5, fontWeight: 700, color: '#0F172A' }}>{selected.size} employee{selected.size !== 1 ? 's' : ''} selected</div>
                  <div style={{ fontSize: 11.5, color: '#64748B' }}>Pick a target stage and apply.</div>
                </div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginLeft: 'auto', flexWrap: 'wrap' }}>
                <span style={{ fontSize: 12.5, color: '#475569', fontWeight: 600 }}>Move to:</span>
                <select value={targetStage} onChange={(e) => setTargetStage(e.target.value)} style={{ ...inputStyle, minWidth: 200, fontWeight: 600 }}>
                  {EMP_STAGES.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
                </select>
                <button type="button" onClick={applySelected} style={btnP}>Apply change</button>
                <button type="button" onClick={() => setSelected(new Set())} style={btnS}>Clear</button>
              </div>
            </div>
          )}
        </>
      )}

      {mode === 'bulk' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div style={{ background: 'linear-gradient(135deg,#F8FAFF 0%,#FFFFFF 100%)', border: '1px solid #E9EDF2', borderRadius: 12, padding: '18px 20px' }}>
            <div style={{ fontSize: 13.5, fontWeight: 700, color: '#0F172A', marginBottom: 4 }}>Sheet-driven stage update</div>
            <div style={{ fontSize: 12.5, color: '#64748B', lineHeight: 1.6, marginBottom: 14 }}>
              The downloaded template has every employee with their current stage pre-filled. Set <strong>Target Stage</strong> per row and re-upload — Target can move them forward <em>or back</em> to a previous stage.
              We validate before applying: unknown stages and current-stage mismatches are flagged and skipped.
            </div>
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
              <button type="button" onClick={downloadStageTemplate} style={btnS}>Download template</button>
              <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv" style={{ display: 'none' }} onChange={handleFile} />
              <button type="button" onClick={() => fileRef.current?.click()} style={btnP}>Upload sheet</button>
              <span style={{ fontSize: 12, color: '#94A3B8', marginLeft: 8 }}>·</span>
              <span style={{ fontSize: 12.5, color: '#475569' }}>Optional override —</span>
              <select value={bulkOverride} onChange={(e) => setBulkOverride(e.target.value)} style={{ ...inputStyle, fontSize: 12.5 }}>
                <option value="">Use Target Stage from sheet</option>
                {EMP_STAGES.map((s) => <option key={s.id} value={s.id}>Force all → {s.label}</option>)}
              </select>
            </div>
          </div>

          {bulkPreview && (
            <div style={{ background: '#fff', border: '1px solid #E9EDF2', borderRadius: 12, overflow: 'hidden' }}>
              <div style={{ padding: '14px 18px', borderBottom: '1px solid #F1F5F9', display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                <div style={{ fontSize: 13.5, fontWeight: 700, color: '#0F172A' }}>Preview — {bulkPreview.length} row{bulkPreview.length !== 1 ? 's' : ''}</div>
                <div style={{ display: 'flex', gap: 6, marginLeft: 'auto', flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 11.5, fontWeight: 700, color: '#15803D', background: '#F0FDF4', border: '1px solid #BBF7D0', borderRadius: 999, padding: '3px 10px' }}>{okCount} ready</span>
                  {mismatchCount > 0 && <span style={{ fontSize: 11.5, fontWeight: 700, color: '#92400E', background: '#FFFBEB', border: '1px solid #FDE68A', borderRadius: 999, padding: '3px 10px' }}>{mismatchCount} stage mismatch</span>}
                  {errorCount > 0 && <span style={{ fontSize: 11.5, fontWeight: 700, color: '#991B1B', background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: 999, padding: '3px 10px' }}>{errorCount} error</span>}
                </div>
              </div>
              <div style={{ maxHeight: 380, overflow: 'auto' }}>
                <table style={{ width: '100%', fontSize: 12.5, borderCollapse: 'collapse' }}>
                  <thead>
                    <tr style={{ background: '#F8FAFC', position: 'sticky', top: 0, zIndex: 1 }}>
                      {['#', 'Code', 'Name', 'Current → Target', 'Status'].map((h) => (
                        <th key={h} style={{ padding: '10px 14px', textAlign: 'left', fontSize: 11, fontWeight: 700, color: '#94A3B8', textTransform: 'uppercase', borderBottom: '1px solid #E9EDF2' }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {bulkPreview.map((r) => {
                      const target = r.toId || bulkOverride || null;
                      const statusColor = r.status === 'ok' ? { tc: '#15803D', bg: '#F0FDF4', bd: '#BBF7D0' } : r.status === 'mismatch' ? { tc: '#92400E', bg: '#FFFBEB', bd: '#FDE68A' } : { tc: '#991B1B', bg: '#FEF2F2', bd: '#FECACA' };
                      const statusLabel = r.status === 'ok' ? 'Ready' : r.status === 'mismatch' ? 'Mismatch' : 'Error';
                      return (
                        <tr key={r.index} style={{ borderTop: '1px solid #F1F5F9' }}>
                          <td style={{ padding: '9px 14px', color: '#94A3B8', fontFamily: 'monospace' }}>{r.index}</td>
                          <td style={{ padding: '9px 14px', fontFamily: 'monospace', fontWeight: 700, color: '#4F46E5' }}>{r.code || '—'}</td>
                          <td style={{ padding: '9px 14px', color: '#0D1117' }}>{r.name || '—'}</td>
                          <td style={{ padding: '9px 14px' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                              {r.actualFromId ? <StagePill stageId={r.actualFromId} /> : <span style={{ fontSize: 11, color: '#94A3B8' }}>—</span>}
                              <span style={{ color: '#94A3B8', fontSize: 12 }}>→</span>
                              {target ? <StagePill stageId={target} /> : <span style={{ fontSize: 11, color: '#DC2626' }}>missing</span>}
                            </div>
                          </td>
                          <td style={{ padding: '9px 14px' }}>
                            <span title={r.reason} style={{ fontSize: 11, fontWeight: 700, color: statusColor.tc, background: statusColor.bg, border: `1px solid ${statusColor.bd}`, borderRadius: 999, padding: '3px 10px' }}>{statusLabel}</span>
                            {r.reason && <div style={{ fontSize: 10.5, color: '#64748B', marginTop: 3 }}>{r.reason}</div>}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <div style={{ display: 'flex', gap: 10, padding: '14px 18px', borderTop: '1px solid #F1F5F9', background: '#FAFBFF' }}>
                <button type="button" disabled={okCount === 0} onClick={applyBulk} style={{ ...btnP, background: okCount === 0 ? '#CBD5E1' : '#4F46E5', cursor: okCount === 0 ? 'not-allowed' : 'pointer' }}>
                  Apply {okCount} ready row{okCount !== 1 ? 's' : ''}
                </button>
                <button type="button" onClick={() => setBulkPreview(null)} style={btnS}>Cancel</button>
                {(mismatchCount > 0 || errorCount > 0) && (
                  <span style={{ fontSize: 12, color: '#94A3B8', alignSelf: 'center', marginLeft: 'auto' }}>
                    Rows with errors or mismatches will be skipped.
                  </span>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ── Manager Change ─────────────────────────────────────────── */
function ModuleMgrChange({ employees, config, onUpdate }) {
  const hasL2 = (config?.managerLevels || 1) >= 2;
  const [mode, setMode]       = useState('single');
  const [search, setSearch]   = useState('');
  const [selected, setSelected] = useState(null);
  const [newL1, setNewL1]     = useState('');
  const [newL2, setNewL2]     = useState('');
  const [bulkPreview, setBulkPreview] = useState(null);
  const [toast, setToast]     = useState(null);
  const fileRef = useRef(null);
  function showToast(msg) { setToast(msg); setTimeout(() => setToast(null), 3000); }

  const results = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q || q.length < 2 || selected) return [];
    return employees.filter((e) => `${e['Employee Name'] || ''} ${e['Employee Code'] || ''}`.toLowerCase().includes(q)).slice(0, 6);
  }, [search, employees, selected]);

  function applyChange() {
    if (!selected || !newL1.trim()) return;
    const code = selected['Employee Code'];
    const updated = employees.map((e) => e['Employee Code'] === code ? { ...e, 'Reporting Manager Code': newL1.trim(), ...(newL2 ? { 'L2 Manager Code': newL2.trim() } : {}) } : e);
    onUpdate(updated); showToast(`Manager updated for ${selected['Employee Name'] || code}`);
    setSelected(null); setSearch(''); setNewL1(''); setNewL2('');
  }

  async function handleFile(e) {
    const file = e.target.files?.[0]; if (!file) return;
    const empByCode = {};
    employees.forEach((emp) => { empByCode[String(emp['Employee Code'] || '').trim().toLowerCase()] = emp; });
    const rows = await parseTwoColXlsx(file);
    setBulkPreview(rows.map((r) => ({ code: r.col1, name: empByCode[r.col1.toLowerCase()]?.['Employee Name'], newMgr: r.col2, found: !!empByCode[r.col1.toLowerCase()] })));
    e.target.value = '';
  }

  function applyBulk() {
    const valid = bulkPreview.filter((r) => r.found);
    const map = {}; valid.forEach((r) => { map[r.code] = r.newMgr; });
    const updated = employees.map((e) => map[e['Employee Code']] ? { ...e, 'Reporting Manager Code': map[e['Employee Code']] } : e);
    onUpdate(updated); showToast(`Manager updated for ${valid.length} employees`); setBulkPreview(null);
  }

  const inputStyle = { width: '100%', boxSizing: 'border-box', border: '1.5px solid #E2E8F0', borderRadius: 8, padding: '8px 11px', fontSize: 13, outline: 'none', fontFamily: 'inherit', color: '#0D1117' };
  const btnP = { padding: '8px 16px', background: '#4F46E5', color: '#fff', border: 'none', borderRadius: 7, fontSize: 12.5, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' };
  const btnS = { padding: '7px 14px', background: '#F1F5F9', color: '#374151', border: '1.5px solid #E2E8F0', borderRadius: 7, fontSize: 12.5, cursor: 'pointer', fontFamily: 'inherit' };

  return (
    <div style={{ position: 'relative', maxWidth: 560 }}>
      {toast && <div style={{ position: 'fixed', bottom: 28, right: 28, zIndex: 50, background: '#F0FDF4', border: '1px solid #BBF7D0', borderRadius: 9, padding: '10px 16px', fontSize: 12.5, fontWeight: 600, color: '#15803D', boxShadow: '0 4px 16px rgba(0,0,0,.1)' }}>✓ {toast}</div>}
      <div style={{ display: 'flex', background: '#F1F5F9', borderRadius: 9, padding: 3, gap: 2, width: 'fit-content', marginBottom: 20 }}>
        {['single', 'bulk'].map((m) => (
          <button key={m} type="button" onClick={() => { setMode(m); setBulkPreview(null); setSelected(null); setSearch(''); }}
            style={{ padding: '5px 14px', borderRadius: 7, border: 'none', cursor: 'pointer', fontFamily: 'inherit', fontSize: 12, fontWeight: mode === m ? 600 : 400, background: mode === m ? '#fff' : 'transparent', color: mode === m ? '#0D1117' : '#64748B', boxShadow: mode === m ? '0 1px 4px rgba(0,0,0,.08)' : 'none' }}>
            {m === 'single' ? 'Single' : 'Bulk upload'}
          </button>
        ))}
      </div>

      {mode === 'single' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div>
            <label style={{ fontSize: 11.5, fontWeight: 600, color: '#64748B', display: 'block', marginBottom: 5 }}>Search Employee</label>
            <input value={search} onChange={(e) => { setSearch(e.target.value); setSelected(null); }} placeholder="Name or code…" style={inputStyle} />
            {results.length > 0 && (
              <div style={{ border: '1px solid #E9EDF2', borderRadius: 8, marginTop: 4, overflow: 'hidden' }}>
                {results.map((emp) => (
                  <button key={emp['Employee Code']} type="button" onClick={() => { setSelected(emp); setSearch(emp['Employee Name'] || ''); }}
                    style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', background: '#fff', border: 'none', borderBottom: '1px solid #F1F5F9', cursor: 'pointer', fontFamily: 'inherit', textAlign: 'left' }}>
                    <span style={{ fontSize: 12.5, fontWeight: 600, color: '#0D1117' }}>{emp['Employee Name']}</span>
                    <span style={{ fontSize: 12, color: '#94A3B8' }}>{emp['Employee Code']}</span>
                    <span style={{ marginLeft: 'auto', fontSize: 11.5, color: '#64748B' }}>Current L1: {emp['Reporting Manager Code'] || '—'}</span>
                  </button>
                ))}
              </div>
            )}
            {selected && <div style={{ marginTop: 8, background: '#F0FDF4', border: '1.5px solid #BBF7D0', borderRadius: 9, padding: '8px 12px', fontSize: 12.5, color: '#166534' }}>✓ <strong>{selected['Employee Name']}</strong> — current L1: <strong>{selected['Reporting Manager Code'] || '—'}</strong></div>}
          </div>
          <div>
            <label style={{ fontSize: 11.5, fontWeight: 600, color: '#64748B', display: 'block', marginBottom: 5 }}>New {hasL2 ? 'L1 ' : ''}Manager Code</label>
            <input value={newL1} onChange={(e) => setNewL1(e.target.value)} placeholder="e.g. 3000" style={inputStyle} />
          </div>
          {hasL2 && (
            <div>
              <label style={{ fontSize: 11.5, fontWeight: 600, color: '#64748B', display: 'block', marginBottom: 5 }}>New L2 Manager Code <span style={{ fontWeight: 400, color: '#94A3B8' }}>(optional)</span></label>
              <input value={newL2} onChange={(e) => setNewL2(e.target.value)} placeholder="e.g. 4000" style={inputStyle} />
            </div>
          )}
          <button type="button" onClick={applyChange} disabled={!selected || !newL1.trim()}
            style={{ ...btnP, width: 'fit-content', opacity: !selected || !newL1.trim() ? 0.5 : 1, cursor: !selected || !newL1.trim() ? 'not-allowed' : 'pointer' }}>
            Update Manager
          </button>
        </div>
      )}

      {mode === 'bulk' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div style={{ background: '#F8FAFC', border: '1px solid #E9EDF2', borderRadius: 10, padding: '14px 16px' }}>
            <div style={{ fontSize: 12.5, fontWeight: 600, color: '#374151', marginBottom: 4 }}>Columns: <code style={{ background: '#E2E8F0', padding: '1px 6px', borderRadius: 4, fontSize: 12 }}>Employee Code, New Manager Code</code></div>
            {hasL2 && <div style={{ fontSize: 12, color: '#94A3B8' }}>Optionally add a 3rd column for L2 Manager Code</div>}
          </div>
          <div>
            <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv" style={{ display: 'none' }} onChange={handleFile} />
            <UploadSheetButton
              onDownload={() => downloadCsvTemplate(
                'manager_change.csv',
                hasL2 ? ['Employee Code', 'New Manager Code', 'New L2 Manager Code'] : ['Employee Code', 'New Manager Code'],
                hasL2 ? ['E001', '3000', '4000'] : ['E001', '3000'],
              )}
              fileRef={fileRef}
            />
          </div>
          {bulkPreview && (
            <div>
              <div style={{ fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 8 }}>Preview — {bulkPreview.filter(r => r.found).length} valid</div>
              <div style={{ border: '1px solid #E9EDF2', borderRadius: 9, overflow: 'hidden', marginBottom: 10 }}>
                <table style={{ width: '100%', fontSize: 12.5, borderCollapse: 'collapse' }}>
                  <thead><tr style={{ background: '#F8FAFC' }}>{['Employee', 'New L1 Manager', 'Status'].map((h) => <th key={h} style={{ padding: '8px 12px', textAlign: 'left', fontSize: 11, fontWeight: 700, color: '#94A3B8', textTransform: 'uppercase' }}>{h}</th>)}</tr></thead>
                  <tbody>{bulkPreview.map((r, i) => <tr key={i} style={{ borderTop: '1px solid #F1F5F9' }}>
                    <td style={{ padding: '7px 12px' }}><span style={{ fontFamily: 'monospace', fontWeight: 700, color: '#4F46E5' }}>{r.code}</span>{r.name && <span style={{ color: '#374151' }}> — {r.name}</span>}</td>
                    <td style={{ padding: '7px 12px', fontFamily: 'monospace', fontWeight: 600 }}>{r.newMgr}</td>
                    <td style={{ padding: '7px 12px' }}><span style={{ fontSize: 11, fontWeight: 600, color: r.found ? '#15803D' : '#991B1B', background: r.found ? '#F0FDF4' : '#FEF2F2', borderRadius: 5, padding: '2px 7px' }}>{r.found ? '✓' : '✗ Not found'}</span></td>
                  </tr>)}</tbody>
                </table>
              </div>
              <div style={{ display: 'flex', gap: 8 }}><button type="button" onClick={applyBulk} style={btnP}>Apply</button><button type="button" onClick={() => setBulkPreview(null)} style={btnS}>Cancel</button></div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ── Group Transfer ──────────────────────────────────────────── */
function ModuleGrpTransfer({ employees, groups, onUpdate }) {
  const [mode, setMode]       = useState('single');
  const [search, setSearch]   = useState('');
  const [selected, setSelected] = useState(null);
  const [targetGrp, setTargetGrp] = useState('');
  const [bulkPreview, setBulkPreview] = useState(null);
  const [toast, setToast]     = useState(null);
  const fileRef = useRef(null);
  function showToast(msg) { setToast(msg); setTimeout(() => setToast(null), 3000); }

  const results = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q || q.length < 2 || selected) return [];
    return employees.filter((e) => `${e['Employee Name'] || ''} ${e['Employee Code'] || ''}`.toLowerCase().includes(q)).slice(0, 6);
  }, [search, employees, selected]);

  function applyChange() {
    if (!selected || !targetGrp) return;
    const code = selected['Employee Code'];
    const updated = employees.map((e) => e['Employee Code'] === code ? { ...e, 'Group Name': targetGrp, assignedGoalGroupName: targetGrp } : e);
    onUpdate(updated); showToast(`${selected['Employee Name'] || code} transferred to "${targetGrp}"`);
    setSelected(null); setSearch(''); setTargetGrp('');
  }

  async function handleFile(e) {
    const file = e.target.files?.[0]; if (!file) return;
    const empByCode = {};
    employees.forEach((emp) => { empByCode[String(emp['Employee Code'] || '').trim().toLowerCase()] = emp; });
    const validGroups = new Set(groups.map((g) => g.name?.trim().toLowerCase()));
    const rows = await parseTwoColXlsx(file);
    setBulkPreview(rows.map((r) => ({ code: r.col1, name: empByCode[r.col1.toLowerCase()]?.['Employee Name'], newGroup: r.col2, found: !!empByCode[r.col1.toLowerCase()], grpValid: validGroups.has(r.col2.trim().toLowerCase()) })));
    e.target.value = '';
  }

  function applyBulk() {
    const valid = bulkPreview.filter((r) => r.found && r.grpValid);
    const map = {}; valid.forEach((r) => { map[r.code] = r.newGroup; });
    const updated = employees.map((e) => map[e['Employee Code']] ? { ...e, 'Group Name': map[e['Employee Code']], assignedGoalGroupName: map[e['Employee Code']] } : e);
    onUpdate(updated); showToast(`${valid.length} employees transferred`); setBulkPreview(null);
  }

  const inputStyle = { width: '100%', boxSizing: 'border-box', border: '1.5px solid #E2E8F0', borderRadius: 10, padding: '10px 13px', fontSize: 13, outline: 'none', fontFamily: 'inherit', color: '#0F172A', background: '#fff', transition: 'border-color 160ms ease, box-shadow 160ms ease' };
  const btnP = { padding: '8px 16px', background: '#4F46E5', color: '#fff', border: 'none', borderRadius: 7, fontSize: 12.5, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' };
  const btnS = { padding: '7px 14px', background: '#F1F5F9', color: '#374151', border: '1.5px solid #E2E8F0', borderRadius: 7, fontSize: 12.5, cursor: 'pointer', fontFamily: 'inherit' };

  const step = (n, label, on) => (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
      <span style={{
        width: 22, height: 22, borderRadius: '50%',
        background: on ? 'linear-gradient(135deg,#4F46E5,#6366F1)' : '#F1F5F9',
        color: on ? '#fff' : '#94A3B8',
        fontSize: 11, fontWeight: 800,
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        flexShrink: 0,
        boxShadow: on ? '0 2px 6px rgba(79,70,229,.30)' : 'none',
        transition: 'all 200ms ease',
      }}>{n}</span>
      <span style={{ fontSize: 13, fontWeight: on ? 700 : 600, color: on ? '#0F172A' : '#94A3B8' }}>{label}</span>
    </div>
  );

  const currentGrp = selected?.['Group Name'] || selected?.assignedGoalGroupName || '';
  const sameGroup = !!(selected && targetGrp && String(currentGrp).trim() === String(targetGrp).trim());
  const canSubmit = !!selected && !!targetGrp && !sameGroup;

  return (
    <div style={{ position: 'relative', maxWidth: 580 }}>
      {toast && <div style={{ position: 'fixed', bottom: 28, right: 28, zIndex: 50, background: '#F0FDF4', border: '1px solid #BBF7D0', borderRadius: 9, padding: '10px 16px', fontSize: 12.5, fontWeight: 600, color: '#15803D', boxShadow: '0 4px 16px rgba(0,0,0,.1)' }}>✓ {toast}</div>}

      {/* Intro */}
      <div style={{ marginBottom: 20 }}>
        <div style={{ fontSize: 16, fontWeight: 800, color: '#0F172A', marginBottom: 4 }}>Group transfer</div>
        <div style={{ fontSize: 13, color: '#64748B', lineHeight: 1.5 }}>Move an employee to a different goal group. Pick one at a time, or upload a sheet for bulk changes.</div>
      </div>

      {/* Mode tabs */}
      <div style={{ display: 'flex', background: '#F1F5F9', borderRadius: 10, padding: 3, gap: 2, width: 'fit-content', marginBottom: 22 }}>
        {['single', 'bulk'].map((m) => (
          <button key={m} type="button" onClick={() => { setMode(m); setBulkPreview(null); setSelected(null); setSearch(''); setTargetGrp(''); }}
            style={{ padding: '6px 16px', borderRadius: 8, border: 'none', cursor: 'pointer', fontFamily: 'inherit', fontSize: 12.5, fontWeight: mode === m ? 700 : 500, background: mode === m ? '#fff' : 'transparent', color: mode === m ? '#0F172A' : '#64748B', boxShadow: mode === m ? '0 1px 4px rgba(15,23,42,.08)' : 'none', transition: 'all 160ms ease' }}>
            {m === 'single' ? 'Single' : 'Bulk upload'}
          </button>
        ))}
      </div>

      {mode === 'single' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 22 }}>
          {/* Step 1 — Pick employee */}
          <div>
            {step(1, 'Pick an employee', true)}
            {!selected ? (
              <div style={{ position: 'relative' }}>
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#94A3B8" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" style={{ position: 'absolute', left: 13, top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none' }}>
                  <circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>
                </svg>
                <input value={search} onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search by name or employee code"
                  style={{ ...inputStyle, paddingLeft: 36 }}
                  onFocus={(e) => { e.currentTarget.style.borderColor = '#A5B4FC'; e.currentTarget.style.boxShadow = '0 0 0 3px rgba(79,70,229,.12)'; }}
                  onBlur={(e) => { e.currentTarget.style.borderColor = '#E2E8F0'; e.currentTarget.style.boxShadow = 'none'; }}
                />
                {results.length > 0 && (
                  <div style={{ border: '1px solid #E9EDF2', borderRadius: 10, marginTop: 6, overflow: 'hidden', background: '#fff', boxShadow: '0 8px 20px rgba(15,23,42,.08)' }}>
                    {results.map((emp) => (
                      <button key={emp['Employee Code']} type="button" onClick={() => { setSelected(emp); setSearch(''); }}
                        style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', background: '#fff', border: 'none', borderBottom: '1px solid #F1F5F9', cursor: 'pointer', fontFamily: 'inherit', textAlign: 'left' }}>
                        <span style={{ fontSize: 13, fontWeight: 700, color: '#0F172A' }}>{emp['Employee Name']}</span>
                        <span style={{ fontSize: 11.5, color: '#94A3B8', background: '#F1F5F9', padding: '1px 7px', borderRadius: 999, fontWeight: 600 }}>{emp['Employee Code']}</span>
                        <span style={{ marginLeft: 'auto', fontSize: 11.5, color: '#64748B' }}>{emp['Group Name'] || 'No group'}</span>
                      </button>
                    ))}
                  </div>
                )}
                {search.trim().length >= 2 && results.length === 0 && !selected && (
                  <div style={{ marginTop: 6, fontSize: 12, color: '#94A3B8', padding: '4px 2px' }}>No employees match &ldquo;{search}&rdquo;.</div>
                )}
              </div>
            ) : (
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, background: '#fff', border: '1.5px solid #E2E8F0', borderRadius: 12, padding: '12px 14px', boxShadow: '0 2px 8px rgba(15,23,42,.04)' }}>
                <div style={{ width: 36, height: 36, borderRadius: '50%', background: 'linear-gradient(135deg,#4F46E5,#6366F1)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontSize: 13, fontWeight: 800, flexShrink: 0 }}>
                  {String(selected['Employee Name'] || '?').trim().split(/\s+/).map((p) => p[0]).slice(0, 2).join('').toUpperCase()}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
                    <span style={{ fontSize: 13.5, fontWeight: 700, color: '#0F172A' }}>{selected['Employee Name']}</span>
                    <span style={{ fontSize: 11.5, color: '#94A3B8', fontFamily: 'monospace' }}>{selected['Employee Code']}</span>
                  </div>
                  <div style={{ fontSize: 12, color: '#64748B', marginTop: 2 }}>Currently in <strong style={{ color: '#334155' }}>{currentGrp || 'no group'}</strong></div>
                </div>
                <button type="button" onClick={() => { setSelected(null); setSearch(''); setTargetGrp(''); }} aria-label="Change employee"
                  style={{ width: 28, height: 28, borderRadius: 8, border: 'none', background: '#F1F5F9', color: '#64748B', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
                </button>
              </div>
            )}
          </div>

          {/* Step 2 — Target group */}
          <div>
            {step(2, 'Choose target group', !!selected)}
            <select value={targetGrp} onChange={(e) => setTargetGrp(e.target.value)}
              disabled={!selected}
              style={{ ...inputStyle, cursor: selected ? 'pointer' : 'not-allowed', opacity: selected ? 1 : 0.6 }}>
              <option value="">{selected ? 'Select a group…' : 'Pick an employee first'}</option>
              {groups.map((g) => <option key={g.id} value={g.name} disabled={g.name === currentGrp}>
                {g.name}{g.name === currentGrp ? ' · current group' : ''}
              </option>)}
            </select>
          </div>

          {/* Live preview / warning */}
          {selected && targetGrp && !sameGroup && (
            <div style={{ padding: '12px 14px', background: 'linear-gradient(135deg,#EEF2FF 0%, #F5F3FF 100%)', border: '1px solid #C7D2FE', borderRadius: 12, fontSize: 13, color: '#334155', display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#4F46E5" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}><path d="M5 12h14"/><path d="m12 5 7 7-7 7"/></svg>
              <span>
                <strong>{selected['Employee Name']}</strong>{' '}
                <span style={{ color: '#64748B' }}>will move from</span>{' '}
                <span style={{ background: '#fff', border: '1px solid #E2E8F0', padding: '2px 9px', borderRadius: 999, fontWeight: 700, fontSize: 12 }}>{currentGrp || '—'}</span>{' '}
                <span style={{ color: '#64748B' }}>to</span>{' '}
                <span style={{ background: '#4F46E5', color: '#fff', padding: '2px 9px', borderRadius: 999, fontWeight: 700, fontSize: 12 }}>{targetGrp}</span>
              </span>
            </div>
          )}
          {sameGroup && (
            <div style={{ padding: '10px 14px', background: '#FFF7ED', border: '1px solid #FED7AA', borderRadius: 10, fontSize: 12.5, color: '#9A3412' }}>
              This employee is already in <strong>{targetGrp}</strong>. Pick a different group.
            </div>
          )}

          {/* CTA */}
          <button type="button" onClick={applyChange} disabled={!canSubmit}
            style={{
              alignSelf: 'flex-start',
              padding: '10px 20px',
              background: canSubmit ? 'linear-gradient(135deg,#4F46E5,#6366F1)' : '#E2E8F0',
              color: canSubmit ? '#fff' : '#94A3B8',
              border: 'none', borderRadius: 10,
              fontSize: 13, fontWeight: 700, fontFamily: 'inherit',
              cursor: canSubmit ? 'pointer' : 'not-allowed',
              boxShadow: canSubmit ? '0 6px 16px rgba(79,70,229,.30)' : 'none',
              transition: 'transform 120ms ease, box-shadow 180ms ease',
            }}
            onMouseEnter={(e) => { if (canSubmit) e.currentTarget.style.transform = 'translateY(-1px)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.transform = 'translateY(0)'; }}
          >
            {canSubmit && selected?.['Employee Name']
              ? `Move ${selected['Employee Name'].split(' ')[0]} →`
              : 'Move employee'}
          </button>
        </div>
      )}

      {mode === 'bulk' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div style={{ background: '#F8FAFC', border: '1px solid #E9EDF2', borderRadius: 10, padding: '14px 16px' }}>
            <div style={{ fontSize: 12.5, fontWeight: 600, color: '#374151', marginBottom: 4 }}>Columns: <code style={{ background: '#E2E8F0', padding: '1px 6px', borderRadius: 4, fontSize: 12 }}>Employee Code, Target Group Name</code></div>
            <div style={{ fontSize: 12, color: '#94A3B8' }}>Valid groups: {groups.map((g) => g.name).join(', ')}</div>
          </div>
          <div><input ref={fileRef} type="file" accept=".xlsx,.xls,.csv" style={{ display: 'none' }} onChange={handleFile} /><UploadSheetButton onDownload={() => downloadCsvTemplate('group_transfer.csv', ['Employee Code', 'Target Group Name'], ['E001', groups[0]?.name || 'Group A'])} fileRef={fileRef} /></div>
          {bulkPreview && (
            <div>
              <div style={{ fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 8 }}>Preview</div>
              <div style={{ border: '1px solid #E9EDF2', borderRadius: 9, overflow: 'hidden', marginBottom: 10 }}>
                <table style={{ width: '100%', fontSize: 12.5, borderCollapse: 'collapse' }}>
                  <thead><tr style={{ background: '#F8FAFC' }}>{['Employee', 'Target Group', 'Status'].map((h) => <th key={h} style={{ padding: '8px 12px', textAlign: 'left', fontSize: 11, fontWeight: 700, color: '#94A3B8', textTransform: 'uppercase' }}>{h}</th>)}</tr></thead>
                  <tbody>{bulkPreview.map((r, i) => <tr key={i} style={{ borderTop: '1px solid #F1F5F9' }}>
                    <td style={{ padding: '7px 12px' }}><span style={{ fontFamily: 'monospace', fontWeight: 700, color: '#4F46E5' }}>{r.code}</span>{r.name && <span style={{ color: '#374151' }}> — {r.name}</span>}</td>
                    <td style={{ padding: '7px 12px', fontWeight: 500 }}>{r.newGroup}</td>
                    <td style={{ padding: '7px 12px' }}>
                      {!r.found && <span style={{ fontSize: 11, fontWeight: 600, color: '#991B1B', background: '#FEF2F2', borderRadius: 5, padding: '2px 7px' }}>✗ Emp not found</span>}
                      {r.found && !r.grpValid && <span style={{ fontSize: 11, fontWeight: 600, color: '#92400E', background: '#FFFBEB', borderRadius: 5, padding: '2px 7px' }}>⚠ Group not found</span>}
                      {r.found && r.grpValid && <span style={{ fontSize: 11, fontWeight: 600, color: '#15803D', background: '#F0FDF4', borderRadius: 5, padding: '2px 7px' }}>✓ Valid</span>}
                    </td>
                  </tr>)}</tbody>
                </table>
              </div>
              <div style={{ display: 'flex', gap: 8 }}><button type="button" onClick={applyBulk} style={btnP}>Apply</button><button type="button" onClick={() => setBulkPreview(null)} style={btnS}>Cancel</button></div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// Manager picker for the manual-add form. When the typed code matches an existing
// roster row, the name (and email, if configured) auto-fill from that row and are
// shown read-only; otherwise the fields are editable so HR can capture a brand-new
// manager inline. The new manager will appear in the recipients/pick lists via the
// synthesized-external-manager pathway.
function ManagerBlock({ code, match, onCodeChange, nameValue, onNameChange, emailValue, onEmailChange, needsEmail, inputBase, getStoredEmail }) {
  const isExisting = !!match;
  const displayName = isExisting ? (match['Employee Name'] || '') : nameValue;
  const displayEmail = isExisting ? getStoredEmail(match) : (emailValue || '');
  const lockedStyle = { ...inputBase, background: '#F1F5F9', color: '#475569', cursor: 'default' };
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12 }}>
      <div>
        <label style={{ fontSize: 11.5, fontWeight: 600, color: '#64748B', display: 'block', marginBottom: 5 }}>Code</label>
        <input value={code} onChange={(e) => onCodeChange(e.target.value)} placeholder="e.g. 1005" style={inputBase} />
      </div>
      <div>
        <label style={{ fontSize: 11.5, fontWeight: 600, color: '#64748B', display: 'block', marginBottom: 5 }}>Name</label>
        {isExisting ? (
          <input value={displayName} readOnly style={lockedStyle} />
        ) : (
          <input value={nameValue} onChange={(e) => onNameChange(e.target.value)} placeholder={code ? 'Enter manager name…' : '—'} disabled={!code} style={code ? inputBase : lockedStyle} />
        )}
      </div>
      {needsEmail && (
        <div>
          <label style={{ fontSize: 11.5, fontWeight: 600, color: '#64748B', display: 'block', marginBottom: 5 }}>Email</label>
          {isExisting ? (
            <input value={displayEmail} readOnly placeholder="—" style={lockedStyle} />
          ) : (
            <input type="email" value={emailValue || ''} onChange={(e) => onEmailChange(e.target.value)} placeholder={code ? 'Enter manager email…' : '—'} disabled={!code} style={code ? inputBase : lockedStyle} />
          )}
        </div>
      )}
    </div>
  );
}

/* ── Add / Remove ───────────────────────────────────────────── */
function ModuleRoster({ employees, config, onUpdate }) {
  const [addMode, setAddMode] = useState('upload');           // 'upload' | 'manual'
  const [removeMode, setRemoveMode] = useState('pick');        // 'pick' | 'bulk'
  const [addPreview, setAddPreview] = useState(null);
  const [manualForm, setManualForm] = useState({});
  const [manualError, setManualError] = useState('');
  // When the typed reporting-manager code is new, HR can opt to also create a
  // full PMS employee record for that manager (group + role + email). Otherwise
  // the manager surfaces only as a reference (synthesized external).
  const [l1NewMgrInPMS, setL1NewMgrInPMS] = useState(false);
  const [l1NewMgrGroup, setL1NewMgrGroup] = useState('');
  const [l1NewMgrSegment, setL1NewMgrSegment] = useState('');
  const [removeSearch, setRemoveSearch] = useState('');
  const [removeSelected, setRemoveSelected] = useState([]);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [bulkDelPreview, setBulkDelPreview] = useState(null);
  const [confirmBulkDel, setConfirmBulkDel] = useState(false);
  const [toast, setToast] = useState(null);
  const addFileRef = useRef(null);
  const delFileRef = useRef(null);

  const meta = useMemo(() => employeeTemplateMeta(config || {}), [config]);
  const goalGroups = useMemo(() => (config?.goalGroups || []), [config]);

  // Per-group routing field — derive from currently-picked group only.
  const selectedGroupName = String(manualForm['Group Name'] || '').trim();
  const selectedGroup = useMemo(
    () => goalGroups.find((g) => String(g?.name || '').trim().toLowerCase() === selectedGroupName.toLowerCase()) || null,
    [goalGroups, selectedGroupName],
  );
  const segmentAttr = String(selectedGroup?.segmentAttr || '').trim();
  const segmentValues = useMemo(
    () => [...new Set((selectedGroup?.segmentValues || []).map((v) => String(v || '').trim()).filter(Boolean))],
    [selectedGroup],
  );

  // Manager autofill — when the user types a manager code that already exists in
  // the org (PMS or external-manager reference), pull their name/email from there
  // instead of asking again. New codes get blank fields the user can fill in.
  const rosterByCode = useMemo(() => {
    const m = {};
    buildRoster(employees).forEach((e) => {
      const code = String(e['Employee Code'] || '').trim().toLowerCase();
      if (code) m[code] = e;
    });
    return m;
  }, [employees]);
  function lookupByCode(code) {
    const k = String(code || '').trim().toLowerCase();
    return k ? (rosterByCode[k] || null) : null;
  }

  const l1Code = String(manualForm['Reporting Manager Code'] || '').trim();
  const l1Match = lookupByCode(l1Code);
  const l2Code = String(manualForm['L2 Manager Code'] || '').trim();
  const l2Match = lookupByCode(l2Code);
  function getStoredEmail(emp) {
    return String(emp?.['Email ID'] || emp?.['Email'] || '').trim();
  }

  // Group + segment options for the new-manager-in-PMS sub-form.
  const l1MgrGroupObj = useMemo(
    () => goalGroups.find((g) => String(g?.name || '').trim().toLowerCase() === l1NewMgrGroup.trim().toLowerCase()) || null,
    [goalGroups, l1NewMgrGroup],
  );
  const l1MgrSegmentAttr = String(l1MgrGroupObj?.segmentAttr || '').trim();
  const l1MgrSegmentValues = useMemo(
    () => [...new Set((l1MgrGroupObj?.segmentValues || []).map((v) => String(v || '').trim()).filter(Boolean))],
    [l1MgrGroupObj],
  );

  // Build the field list dynamically. Manager fields are rendered separately
  // because they auto-fill when the code already exists in the org.
  const manualFields = useMemo(() => {
    const f = [
      { key: 'Employee Code',  required: true },
      { key: 'Employee Name',  required: true },
    ];
    if (meta.needsEmail)    f.push({ key: 'Email ID' });
    if (meta.hasGoalGroups) f.push({ key: 'Group Name', required: true, type: 'group' });
    if (segmentAttr && segmentValues.length > 0) f.push({ key: segmentAttr, required: true, type: 'segment' });
    return f;
  }, [meta, segmentAttr, segmentValues]);

  function setGroupAndResetRouting(value) {
    setManualForm((prev) => {
      const next = { ...prev, 'Group Name': value };
      // Clear any prior routing-field value when the group changes.
      goalGroups.forEach((g) => {
        const a = String(g?.segmentAttr || '').trim();
        if (a) delete next[a];
      });
      return next;
    });
  }

  function showToast(msg) { setToast(msg); setTimeout(() => setToast(null), 3000); }

  async function handleAddFile(e) {
    const file = e.target.files?.[0]; if (!file) return;
    e.target.value = '';
    const existingCodes = new Set(employees.map((emp) => String(emp['Employee Code'] || '').trim().toLowerCase()));
    try {
      const result = await parseEmployeeXlsx(file);
      const rows = result.employees || [];
      const preview = rows.map((r) => {
        const code = String(r['Employee Code'] || '').trim();
        return { ...r, 'Employee Code': code, _duplicate: existingCodes.has(code.toLowerCase()), _missing: !code };
      }).filter((r) => !r._missing);
      if (preview.length === 0 && rows.length === 0) { showToast('No employee rows found — check the file format'); return; }
      setAddPreview(preview);
    } catch (err) { showToast(err?.message || 'Could not parse file — use .xlsx or .csv'); }
  }

  function applyAdd() {
    if (!addPreview) return;
    const toAdd = addPreview.filter((r) => !r._duplicate);
    const updated = [...employees, ...toAdd.map(({ _duplicate, _missing, ...rest }) => rest)];
    onUpdate(updated);
    showToast(`${toAdd.length} employee${toAdd.length !== 1 ? 's' : ''} added`);
    setAddPreview(null);
  }

  function applyManualAdd() {
    setManualError('');
    const code = String(manualForm['Employee Code'] || '').trim();
    const name = String(manualForm['Employee Name'] || '').trim();
    if (!code) { setManualError('Employee Code is required'); return; }
    if (!name) { setManualError('Employee Name is required'); return; }
    const existingCodes = new Set(employees.map((emp) => String(emp['Employee Code'] || '').trim().toLowerCase()));
    if (existingCodes.has(code.toLowerCase())) { setManualError(`Employee Code "${code}" already exists`); return; }
    if (meta.hasGoalGroups && !selectedGroup) {
      setManualError('Group Name is required'); return;
    }
    if (segmentAttr && segmentValues.length > 0) {
      const v = String(manualForm[segmentAttr] || '').trim();
      if (!v) { setManualError(`${segmentAttr} is required for "${selectedGroup.name}"`); return; }
      if (!segmentValues.some((cv) => cv.toLowerCase() === v.toLowerCase())) {
        setManualError(`${segmentAttr} must be one of: ${segmentValues.join(', ')}`);
        return;
      }
    }

    const newEmp = {};
    // Basic + group + segment from form / template headers.
    meta.headers.forEach((h) => { newEmp[h] = String(manualForm[h] || '').trim(); });
    if (segmentAttr) newEmp[segmentAttr] = String(manualForm[segmentAttr] || '').trim();

    // If the new L1 manager is being added as a full PMS employee, validate now
    // so we fail before mutating state.
    let mgrEmp = null;
    if (l1Code && !l1Match && l1NewMgrInPMS) {
      const mgrName = String(manualForm['Reporting Manager Name'] || '').trim();
      if (!mgrName) { setManualError('Reporting manager name is required'); return; }
      if (meta.hasGoalGroups) {
        if (!l1MgrGroupObj) { setManualError("Pick a group for the new manager (or uncheck 'Also add as PMS employee')"); return; }
        if (l1MgrSegmentAttr && l1MgrSegmentValues.length > 0) {
          if (!l1NewMgrSegment) { setManualError(`${l1MgrSegmentAttr} is required for the new manager`); return; }
          if (!l1MgrSegmentValues.some((v) => v.toLowerCase() === l1NewMgrSegment.toLowerCase())) {
            setManualError(`${l1MgrSegmentAttr} must be one of: ${l1MgrSegmentValues.join(', ')}`);
            return;
          }
        }
      }
      mgrEmp = {};
      meta.headers.forEach((h) => { mgrEmp[h] = ''; });
      mgrEmp['Employee Code'] = l1Code;
      mgrEmp['Employee Name'] = mgrName;
      if (meta.needsEmail) mgrEmp['Email ID'] = String(manualForm['Reporting Manager Email'] || '').trim();
      if (meta.hasGoalGroups) mgrEmp['Group Name'] = l1MgrGroupObj?.name || '';
      if (l1MgrSegmentAttr) mgrEmp[l1MgrSegmentAttr] = l1NewMgrSegment;
    }

    // Resolve L1 manager — prefer existing roster row over what the user typed.
    if (l1Code) {
      newEmp['Reporting Manager Code'] = l1Code;
      if (l1Match) {
        newEmp['Reporting Manager Name']  = l1Match['Employee Name'] || '';
        if (meta.needsEmail) newEmp['Reporting Manager Email'] = getStoredEmail(l1Match);
      } else {
        newEmp['Reporting Manager Name']  = String(manualForm['Reporting Manager Name'] || '').trim();
        if (meta.needsEmail) newEmp['Reporting Manager Email'] = String(manualForm['Reporting Manager Email'] || '').trim();
      }
    }

    // Resolve L2 manager same way.
    if (meta.hasL2 && l2Code) {
      newEmp['L2 Manager Code'] = l2Code;
      newEmp['L2 Manager Name'] = l2Match
        ? (l2Match['Employee Name'] || '')
        : String(manualForm['L2 Manager Name'] || '').trim();
    }

    const additions = mgrEmp ? [mgrEmp, newEmp] : [newEmp];
    onUpdate([...employees, ...additions]);
    showToast(mgrEmp ? `${name} added · manager ${mgrEmp['Employee Name']} also added to PMS` : `${name} added`);
    setManualForm({});
    setL1NewMgrInPMS(false); setL1NewMgrGroup(''); setL1NewMgrSegment('');
  }

  // Pick & Remove operates on the full roster — real employees + reporting managers
  // who only exist as references. Removing an external is a no-op against `employees`,
  // but they remain selectable so HR can clear them via the upstream Manager Change
  // module without losing sight of them here.
  const fullRoster = useMemo(() => buildRoster(employees), [employees]);
  const removeResults = useMemo(() => {
    const q = removeSearch.trim().toLowerCase();
    if (!q) return fullRoster;
    return fullRoster.filter((e) => `${e['Employee Name'] || ''} ${e['Employee Code'] || ''} ${e['Group Name'] || ''}`.toLowerCase().includes(q));
  }, [removeSearch, fullRoster]);

  function toggleRemove(code) {
    setRemoveSelected((prev) => prev.includes(code) ? prev.filter((c) => c !== code) : [...prev, code]);
  }

  function applyRemove() {
    const toRemove = new Set(removeSelected);
    const before = employees.length;
    const next = employees.filter((e) => !toRemove.has(String(e['Employee Code'] || '').trim()));
    const removedCount = before - next.length;
    onUpdate(next);
    showToast(`${removedCount} employee${removedCount !== 1 ? 's' : ''} removed`);
    setRemoveSelected([]); setRemoveSearch(''); setConfirmRemove(false);
  }

  async function handleBulkDelFile(e) {
    const file = e.target.files?.[0]; if (!file) return;
    e.target.value = '';
    try {
      const rows = await parseTwoColXlsx(file);
      if (!rows.length) { showToast('No employee codes found — first column must be Employee Code'); return; }
      const empByCode = {};
      fullRoster.forEach((emp) => { empByCode[String(emp['Employee Code'] || '').trim().toLowerCase()] = emp; });
      const seen = new Set();
      const preview = rows.map((r) => {
        const code = r.col1;
        const key = code.toLowerCase();
        if (seen.has(key)) return null;
        seen.add(key);
        const match = empByCode[key];
        return { code, name: match?.['Employee Name'] || '', found: !!match };
      }).filter(Boolean);
      setBulkDelPreview(preview);
      setConfirmBulkDel(false);
    } catch (err) {
      showToast(err?.message || 'Could not parse file — use .xlsx or .csv');
    }
  }

  function applyBulkDelete() {
    const toRemove = new Set(bulkDelPreview.filter((r) => r.found).map((r) => r.code.toLowerCase()));
    if (toRemove.size === 0) { showToast('No matching employees to remove'); setBulkDelPreview(null); return; }
    onUpdate(employees.filter((e) => !toRemove.has(String(e['Employee Code'] || '').trim().toLowerCase())));
    showToast(`${toRemove.size} employee${toRemove.size !== 1 ? 's' : ''} removed`);
    setBulkDelPreview(null); setConfirmBulkDel(false);
  }

  const btnP = { padding: '8px 16px', background: '#4F46E5', color: '#fff', border: 'none', borderRadius: 8, fontSize: 12.5, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' };
  const btnS = { padding: '7px 14px', background: '#fff', color: '#475569', border: '1.5px solid #E2E8F0', borderRadius: 8, fontSize: 12.5, cursor: 'pointer', fontFamily: 'inherit', fontWeight: 600 };
  const btnD = { padding: '8px 16px', background: '#DC2626', color: '#fff', border: 'none', borderRadius: 8, fontSize: 12.5, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' };
  const inputBase = { width: '100%', boxSizing: 'border-box', border: '1.5px solid #E2E8F0', borderRadius: 8, padding: '8px 12px', fontSize: 13, outline: 'none', fontFamily: 'inherit', color: '#0F172A', background: '#fff' };
  const cardBase = { background: '#fff', border: '1px solid #E9EDF2', borderRadius: 14 };
  const tabPills = (active, options, onPick) => (
    <div style={{ display: 'inline-flex', background: '#F1F5F9', padding: 3, borderRadius: 9, gap: 2 }}>
      {options.map((o) => (
        <button key={o.k} type="button" onClick={() => onPick(o.k)}
          style={{ padding: '6px 14px', borderRadius: 7, border: 'none', cursor: 'pointer', fontFamily: 'inherit', fontSize: 12.5, fontWeight: active === o.k ? 700 : 500, background: active === o.k ? '#fff' : 'transparent', color: active === o.k ? '#0F172A' : '#64748B', boxShadow: active === o.k ? '0 1px 3px rgba(15,23,42,.08)' : 'none' }}>
          {o.label}
        </button>
      ))}
    </div>
  );

  const visibleNotSelected = removeResults.filter((e) => !removeSelected.includes(String(e['Employee Code'] || '').trim()));
  const allVisibleSelected = visibleNotSelected.length === 0 && removeResults.length > 0;
  function toggleSelectAllVisible() {
    if (allVisibleSelected) {
      const visibleCodes = new Set(removeResults.map((e) => String(e['Employee Code'] || '').trim()));
      setRemoveSelected((prev) => prev.filter((c) => !visibleCodes.has(c)));
    } else {
      const additions = visibleNotSelected.map((e) => String(e['Employee Code'] || '').trim());
      setRemoveSelected((prev) => Array.from(new Set([...prev, ...additions])));
    }
  }

  return (
    <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'flex-start', position: 'relative', maxWidth: 1320 }}>
      {toast && <div style={{ position: 'fixed', bottom: 28, right: 28, zIndex: 50, background: '#F0FDF4', border: '1px solid #BBF7D0', borderRadius: 9, padding: '10px 16px', fontSize: 12.5, fontWeight: 600, color: '#15803D', boxShadow: '0 4px 16px rgba(0,0,0,.1)' }}>✓ {toast}</div>}

      {/* ── ADD ─────────────────────────────────────────────────── */}
      <section style={{ ...cardBase, flex: '1 1 360px', maxWidth: 460, minWidth: 0 }}>
        <header style={{ padding: '14px 18px', borderBottom: '1px solid #F1F5F9', display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13.5, fontWeight: 700, color: '#0F172A' }}>Add employees</div>
            <div style={{ fontSize: 11.5, color: '#94A3B8' }}>Upload a sheet, or add a single employee manually.</div>
          </div>
          {tabPills(addMode, [{ k: 'upload', label: 'Upload sheet' }, { k: 'manual', label: 'Add manually' }],
            (k) => { setAddMode(k); setAddPreview(null); setManualForm({}); setManualError(''); })}
        </header>

        <div style={{ padding: '16px 18px' }}>
          {addMode === 'upload' && (
            <>
              <input ref={addFileRef} type="file" accept=".xlsx,.xls,.csv" style={{ display: 'none' }} onChange={handleAddFile} />
              <UploadSheetButton onDownload={() => downloadEmployeeTemplate(config || {})} fileRef={addFileRef} />
              <div style={{ fontSize: 11.5, color: '#94A3B8', marginTop: 8 }}>New employees are appended; duplicate codes are skipped automatically.</div>

              {addPreview && (
                <div style={{ marginTop: 14 }}>
                  <div style={{ fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 8 }}>
                    {addPreview.filter((r) => !r._duplicate).length} new · {addPreview.filter((r) => r._duplicate).length} duplicate{addPreview.filter((r) => r._duplicate).length !== 1 ? 's' : ''} (skipped)
                  </div>
                  <div style={{ border: '1px solid #E9EDF2', borderRadius: 9, overflow: 'hidden', maxHeight: 220, overflowY: 'auto', marginBottom: 10 }}>
                    <table style={{ width: '100%', fontSize: 12.5, borderCollapse: 'collapse' }}>
                      <thead><tr style={{ background: '#F8FAFC' }}>
                        {['Name', 'Code', 'Group', 'Status'].map((h) => <th key={h} style={{ padding: '7px 10px', textAlign: 'left', fontSize: 11, fontWeight: 700, color: '#94A3B8', textTransform: 'uppercase' }}>{h}</th>)}
                      </tr></thead>
                      <tbody>{addPreview.map((r, i) => (
                        <tr key={i} style={{ borderTop: '1px solid #F1F5F9', opacity: r._duplicate ? 0.5 : 1 }}>
                          <td style={{ padding: '6px 10px' }}>{r['Employee Name'] || '—'}</td>
                          <td style={{ padding: '6px 10px', fontFamily: 'monospace', fontWeight: 700, color: '#4F46E5' }}>{r['Employee Code']}</td>
                          <td style={{ padding: '6px 10px', color: '#64748B' }}>{r['Group Name'] || '—'}</td>
                          <td style={{ padding: '6px 10px' }}>
                            <span style={{ fontSize: 11, fontWeight: 600, color: r._duplicate ? '#92400E' : '#15803D', background: r._duplicate ? '#FFFBEB' : '#F0FDF4', borderRadius: 5, padding: '2px 7px' }}>
                              {r._duplicate ? 'Duplicate' : '✓ New'}
                            </span>
                          </td>
                        </tr>
                      ))}</tbody>
                    </table>
                  </div>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button type="button" style={{ ...btnP, background: '#16A34A' }} onClick={applyAdd} disabled={!addPreview.some((r) => !r._duplicate)}>
                      Add {addPreview.filter((r) => !r._duplicate).length} employee{addPreview.filter((r) => !r._duplicate).length !== 1 ? 's' : ''}
                    </button>
                    <button type="button" style={btnS} onClick={() => setAddPreview(null)}>Cancel</button>
                  </div>
                </div>
              )}
            </>
          )}

          {addMode === 'manual' && (
            <>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12 }}>
                {manualFields.map((f) => {
                  const required = f.required;
                  const value = manualForm[f.key] || '';
                  if (f.type === 'group') {
                    return (
                      <div key={f.key}>
                        <label style={{ fontSize: 11.5, fontWeight: 600, color: '#64748B', display: 'block', marginBottom: 5 }}>
                          {f.key}{required && <span style={{ color: '#DC2626' }}> *</span>}
                        </label>
                        <select value={value} onChange={(e) => setGroupAndResetRouting(e.target.value)} style={inputBase}>
                          <option value="">Select a group…</option>
                          {meta.groupNames.map((g) => <option key={g} value={g}>{g}</option>)}
                        </select>
                      </div>
                    );
                  }
                  if (f.type === 'segment') {
                    return (
                      <div key={f.key}>
                        <label style={{ fontSize: 11.5, fontWeight: 600, color: '#64748B', display: 'block', marginBottom: 5 }}>
                          {f.key}{required && <span style={{ color: '#DC2626' }}> *</span>}
                          <span style={{ fontWeight: 500, color: '#94A3B8', marginLeft: 6 }}>· for {selectedGroup?.name}</span>
                        </label>
                        <select value={value} onChange={(e) => setManualForm((p) => ({ ...p, [f.key]: e.target.value }))} style={inputBase}>
                          <option value="">Select…</option>
                          {segmentValues.map((v) => <option key={v} value={v}>{v}</option>)}
                        </select>
                      </div>
                    );
                  }
                  return (
                    <div key={f.key}>
                      <label style={{ fontSize: 11.5, fontWeight: 600, color: '#64748B', display: 'block', marginBottom: 5 }}>
                        {f.key}{required && <span style={{ color: '#DC2626' }}> *</span>}
                      </label>
                      <input
                        value={value}
                        onChange={(e) => setManualForm((p) => ({ ...p, [f.key]: e.target.value }))}
                        placeholder={`Enter ${f.key.toLowerCase()}…`}
                        type={f.key.toLowerCase().includes('email') ? 'email' : 'text'}
                        style={inputBase}
                      />
                    </div>
                  );
                })}
              </div>

              {/* Reporting Manager — autofills when the code is already in the org */}
              <div style={{ marginTop: 14, padding: '12px 14px', background: '#FAFBFF', border: '1px solid #E2E8F0', borderRadius: 10 }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: '#475569', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 10 }}>Reporting manager</div>
                <ManagerBlock
                  code={l1Code}
                  match={l1Match}
                  onCodeChange={(v) => setManualForm((p) => ({ ...p, 'Reporting Manager Code': v }))}
                  nameValue={manualForm['Reporting Manager Name'] || ''}
                  onNameChange={(v) => setManualForm((p) => ({ ...p, 'Reporting Manager Name': v }))}
                  emailValue={manualForm['Reporting Manager Email'] || ''}
                  onEmailChange={(v) => setManualForm((p) => ({ ...p, 'Reporting Manager Email': v }))}
                  needsEmail={meta.needsEmail}
                  inputBase={inputBase}
                  getStoredEmail={getStoredEmail}
                />
                {!l1Code && <div style={{ fontSize: 11.5, color: '#94A3B8', marginTop: 8 }}>Leave blank for the top-of-hierarchy roles.</div>}
                {l1Code && !l1Match && (
                  <div style={{ marginTop: 10 }}>
                    <div style={{ fontSize: 11.5, color: '#475569', marginBottom: 8 }}>
                      Code <code style={{ background: '#F1F5F9', padding: '1px 6px', borderRadius: 4, fontSize: 11 }}>{l1Code}</code> is new — fill in the name{meta.needsEmail ? ' and email' : ''} above.
                    </div>
                    <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 12.5, color: '#0F172A', cursor: 'pointer', userSelect: 'none' }}>
                      <input type="checkbox" checked={l1NewMgrInPMS}
                        onChange={(e) => { setL1NewMgrInPMS(e.target.checked); if (!e.target.checked) { setL1NewMgrGroup(''); setL1NewMgrSegment(''); } }}
                        style={{ width: 15, height: 15, accentColor: '#4F46E5' }} />
                      <span>Also add this manager as a PMS employee</span>
                    </label>
                    {l1NewMgrInPMS && (
                      <div style={{ marginTop: 10, padding: '12px 14px', background: '#fff', border: '1px solid #E2E8F0', borderRadius: 9 }}>
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12 }}>
                          {meta.hasGoalGroups && (
                            <div>
                              <label style={{ fontSize: 11.5, fontWeight: 600, color: '#64748B', display: 'block', marginBottom: 5 }}>
                                Group <span style={{ color: '#DC2626' }}>*</span>
                              </label>
                              <select value={l1NewMgrGroup} onChange={(e) => { setL1NewMgrGroup(e.target.value); setL1NewMgrSegment(''); }} style={inputBase}>
                                <option value="">Select a group…</option>
                                {meta.groupNames.map((g) => <option key={g} value={g}>{g}</option>)}
                              </select>
                            </div>
                          )}
                          {l1MgrSegmentAttr && l1MgrSegmentValues.length > 0 && (
                            <div>
                              <label style={{ fontSize: 11.5, fontWeight: 600, color: '#64748B', display: 'block', marginBottom: 5 }}>
                                {l1MgrSegmentAttr} <span style={{ color: '#DC2626' }}>*</span>
                                <span style={{ fontWeight: 500, color: '#94A3B8', marginLeft: 6 }}>· for {l1MgrGroupObj?.name}</span>
                              </label>
                              <select value={l1NewMgrSegment} onChange={(e) => setL1NewMgrSegment(e.target.value)} style={inputBase}>
                                <option value="">Select…</option>
                                {l1MgrSegmentValues.map((v) => <option key={v} value={v}>{v}</option>)}
                              </select>
                            </div>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>

              {meta.hasL2 && (
                <div style={{ marginTop: 12, padding: '12px 14px', background: '#FAFBFF', border: '1px solid #E2E8F0', borderRadius: 10 }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: '#475569', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 10 }}>L2 manager <span style={{ fontWeight: 500, color: '#94A3B8', textTransform: 'none', letterSpacing: 0 }}>· optional</span></div>
                  <ManagerBlock
                    code={l2Code}
                    match={l2Match}
                    onCodeChange={(v) => setManualForm((p) => ({ ...p, 'L2 Manager Code': v }))}
                    nameValue={manualForm['L2 Manager Name'] || ''}
                    onNameChange={(v) => setManualForm((p) => ({ ...p, 'L2 Manager Name': v }))}
                    needsEmail={false}
                    inputBase={inputBase}
                    getStoredEmail={getStoredEmail}
                  />
                </div>
              )}

              {manualError && (
                <div style={{ marginTop: 12, padding: '8px 12px', background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: 8, fontSize: 12.5, color: '#991B1B' }}>{manualError}</div>
              )}
              <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
                <button type="button" style={{ ...btnP, background: '#16A34A' }} onClick={applyManualAdd}>Add employee</button>
                <button type="button" style={btnS} onClick={() => { setManualForm({}); setManualError(''); }}>Clear</button>
              </div>
            </>
          )}
        </div>
      </section>

      {/* ── REMOVE ──────────────────────────────────────────────── */}
      <section style={{ ...cardBase, flex: '2 1 480px', minWidth: 0 }}>
        <header style={{ padding: '14px 18px', borderBottom: '1px solid #F1F5F9', display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13.5, fontWeight: 700, color: '#0F172A' }}>Remove employees</div>
            <div style={{ fontSize: 11.5, color: '#94A3B8' }}>{employees.length} in PMS · removal needs confirmation.</div>
          </div>
          {tabPills(removeMode, [{ k: 'pick', label: 'Pick & remove' }, { k: 'bulk', label: 'Bulk by code' }],
            (k) => { setRemoveMode(k); setRemoveSelected([]); setRemoveSearch(''); setConfirmRemove(false); setBulkDelPreview(null); setConfirmBulkDel(false); })}
        </header>

        <div style={{ padding: '14px 18px' }}>
          {removeMode === 'pick' && (
            <>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
                <input
                  value={removeSearch}
                  onChange={(e) => setRemoveSearch(e.target.value)}
                  placeholder="Filter by name, code, or group…"
                  style={{ ...inputBase, flex: 1, minWidth: 220 }}
                />
                <button type="button" onClick={toggleSelectAllVisible} style={btnS}>
                  {allVisibleSelected ? 'Unselect all' : `Select all${removeSearch ? ' visible' : ''}`}
                </button>
              </div>

              <div style={{ border: '1px solid #E9EDF2', borderRadius: 10, overflow: 'hidden' }}>
                <div style={{ maxHeight: 540, overflow: 'auto' }}>
                  {removeResults.length === 0 ? (
                    <div style={{ padding: '32px 14px', textAlign: 'center', color: '#94A3B8', fontSize: 13 }}>
                      {employees.length === 0 ? 'No employees in PMS yet.' : `No matches for "${removeSearch}".`}
                    </div>
                  ) : (
                    removeResults.map((emp) => {
                      const code = String(emp['Employee Code'] || '').trim();
                      const isSelected = removeSelected.includes(code);
                      return (
                        <button key={code} type="button" onClick={() => toggleRemove(code)}
                          style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', background: isSelected ? '#FEF2F2' : '#fff', border: 'none', borderBottom: '1px solid #F1F5F9', cursor: 'pointer', fontFamily: 'inherit', textAlign: 'left' }}>
                          <div style={{ width: 16, height: 16, borderRadius: 4, border: `2px solid ${isSelected ? '#DC2626' : '#E2E8F0'}`, background: isSelected ? '#DC2626' : '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                            {isSelected && <span style={{ color: '#fff', fontSize: 10, fontWeight: 800 }}>✓</span>}
                          </div>
                          <div style={{ width: 26, height: 26, borderRadius: '50%', background: 'linear-gradient(135deg,#4F46E5,#7C3AED)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 9, fontWeight: 800, flexShrink: 0 }}>{getInitials(emp['Employee Name'] || code)}</div>
                          <span style={{ fontSize: 12.5, fontWeight: 600, color: '#0D1117', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{emp['Employee Name'] || code}</span>
                          <span style={{ fontSize: 12, color: '#94A3B8', fontFamily: 'monospace', flexShrink: 0 }}>{code}</span>
                          <span style={{ fontSize: 11.5, color: '#64748B', flexShrink: 0, maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{emp['Group Name'] || emp.assignedGoalGroupName || ''}</span>
                        </button>
                      );
                    })
                  )}
                </div>
              </div>

              {/* Sticky-style action footer */}
              <div style={{ marginTop: 12, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', justifyContent: 'space-between' }}>
                <span style={{ fontSize: 12.5, color: removeSelected.length > 0 ? '#0F172A' : '#94A3B8', fontWeight: removeSelected.length > 0 ? 700 : 500 }}>
                  {removeSelected.length} selected · showing {removeResults.length} of {employees.length}
                </span>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  {removeSelected.length > 0 && (
                    <button type="button" style={{ ...btnS, fontSize: 11.5 }} onClick={() => { setRemoveSelected([]); setConfirmRemove(false); }}>Clear</button>
                  )}
                  {!confirmRemove ? (
                    <button type="button" style={{ ...btnD, opacity: removeSelected.length === 0 ? 0.5 : 1, cursor: removeSelected.length === 0 ? 'not-allowed' : 'pointer' }} disabled={removeSelected.length === 0} onClick={() => setConfirmRemove(true)}>
                      Remove {removeSelected.length || ''}
                    </button>
                  ) : (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: 8, padding: '6px 10px' }}>
                      <span style={{ fontSize: 12.5, color: '#991B1B', fontWeight: 600 }}>Confirm removal of {removeSelected.length}?</span>
                      <button type="button" style={btnD} onClick={applyRemove}>Yes, remove</button>
                      <button type="button" style={btnS} onClick={() => setConfirmRemove(false)}>Cancel</button>
                    </div>
                  )}
                </div>
              </div>
            </>
          )}

          {removeMode === 'bulk' && (
            <>
              <div style={{ background: '#F8FAFC', border: '1px solid #E9EDF2', borderRadius: 10, padding: '10px 14px', marginBottom: 12, fontSize: 12, color: '#64748B' }}>
                Single column: <code style={{ background: '#E2E8F0', padding: '1px 6px', borderRadius: 4, fontSize: 11.5 }}>Employee Code</code>. Codes not in the org are skipped.
              </div>
              <input ref={delFileRef} type="file" accept=".xlsx,.xls,.csv" style={{ display: 'none' }} onChange={handleBulkDelFile} />
              <UploadSheetButton onDownload={() => downloadCsvTemplate('employee_codes_to_remove.csv', ['Employee Code'], ['EMP001'])} fileRef={delFileRef} />

              {bulkDelPreview && (
                <div style={{ marginTop: 14 }}>
                  <div style={{ fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 8 }}>
                    {bulkDelPreview.filter((r) => r.found).length} match · {bulkDelPreview.filter((r) => !r.found).length} not found
                  </div>
                  <div style={{ border: '1px solid #E9EDF2', borderRadius: 9, overflow: 'hidden', maxHeight: 240, overflowY: 'auto', marginBottom: 10 }}>
                    <table style={{ width: '100%', fontSize: 12.5, borderCollapse: 'collapse' }}>
                      <thead><tr style={{ background: '#F8FAFC' }}>
                        {['Code', 'Name', 'Status'].map((h) => <th key={h} style={{ padding: '7px 10px', textAlign: 'left', fontSize: 11, fontWeight: 700, color: '#94A3B8', textTransform: 'uppercase', position: 'sticky', top: 0, background: '#F8FAFC' }}>{h}</th>)}
                      </tr></thead>
                      <tbody>{bulkDelPreview.map((r, i) => (
                        <tr key={i} style={{ borderTop: '1px solid #F1F5F9', opacity: r.found ? 1 : 0.5 }}>
                          <td style={{ padding: '6px 10px', fontFamily: 'monospace', fontWeight: 700, color: '#4F46E5' }}>{r.code}</td>
                          <td style={{ padding: '6px 10px' }}>{r.name || '—'}</td>
                          <td style={{ padding: '6px 10px' }}>
                            <span style={{ fontSize: 11, fontWeight: 600, color: r.found ? '#991B1B' : '#92400E', background: r.found ? '#FEF2F2' : '#FFFBEB', borderRadius: 5, padding: '2px 7px' }}>
                              {r.found ? 'Will remove' : 'Not found'}
                            </span>
                          </td>
                        </tr>
                      ))}</tbody>
                    </table>
                  </div>
                  {(() => {
                    const matchCount = bulkDelPreview.filter((r) => r.found).length;
                    return (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                        {!confirmBulkDel
                          ? <button type="button" style={btnD} onClick={() => setConfirmBulkDel(true)} disabled={matchCount === 0}>Remove {matchCount} employee{matchCount !== 1 ? 's' : ''}</button>
                          : (
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: 8, padding: '6px 10px' }}>
                              <span style={{ fontSize: 12.5, color: '#991B1B', fontWeight: 600 }}>Confirm removal of {matchCount}?</span>
                              <button type="button" style={btnD} onClick={applyBulkDelete}>Yes, remove</button>
                              <button type="button" style={btnS} onClick={() => setConfirmBulkDel(false)}>Cancel</button>
                            </div>
                          )
                        }
                        <button type="button" style={btnS} onClick={() => { setBulkDelPreview(null); setConfirmBulkDel(false); }}>Clear</button>
                      </div>
                    );
                  })()}
                </div>
              )}
            </>
          )}
        </div>
      </section>
    </div>
  );
}

/* ── Test Credentials ───────────────────────────────────────── */
function ModuleTestCreds({ employees, org, orgKey }) {
  const [search, setSearch] = useState('');
  const [filterGroup, setFilterGroup] = useState('');
  const [filterStage, setFilterStage] = useState('');
  const [filterManager, setFilterManager] = useState('');
  const [filtersOpen, setFiltersOpen] = useState(false);
  const orgPalette = useMemo(() => resolveBrandPalette(org?.brandPalette), [org?.brandPalette]);
  const externalTint = orgPalette.primary;
  const externalTintDark = orgPalette.primaryDark || orgPalette.primary;
  const externalTintBg = `${externalTint}0D`;
  const externalTintSoft = `${externalTint}14`;
  const externalTintBorder = `${externalTint}33`;

  function openEmp(emp) {
    void logAuditEvent({
      orgKey,
      actorRole: 'hr-admin',
      actorName: org?.hrAdminName || 'HR Admin',
      actionType: 'proxy-open',
      targetType: 'employee',
      targetCode: String(emp['Employee Code'] || '').trim(),
      details: {
        employeeName: emp['Employee Name'] || '',
      },
    });
    persistEmployeeSession({
      isLoggedIn: true,
      role: 'employee',
      empCode: emp['Employee Code'],
      userName: emp['Employee Name'],
      designation: emp.Designation || '',
      managerCode: emp['Reporting Manager Code'] || '',
      orgKey,
      _impersonatedFromAdmin: true,
    });
    window.location.hash = '#employee';
  }

  const empByCode = useMemo(() => {
    const m = {};
    employees.forEach((e) => { m[String(e['Employee Code'] || '').trim().toLowerCase()] = e; });
    return m;
  }, [employees]);

  // External managers — referenced as a manager by at least one employee but not themselves uploaded.
  // Synthesised as virtual rows so HR can log in as them to test the manager flow.
  const externalManagers = useMemo(() => {
    const map = new Map();
    employees.forEach((e) => {
      const raw = String(e['Reporting Manager Code'] || '').trim();
      if (!raw) return;
      const lower = raw.toLowerCase();
      if (empByCode[lower]) return; // real employee, already in list
      const existing = map.get(lower);
      if (existing) { existing._reportsCount += 1; return; }
      const name = String(e['Reporting Manager Name'] || '').trim() || raw;
      map.set(lower, {
        'Employee Code': raw,
        'Employee Name': name,
        Designation: 'Manager (not in PMS)',
        _external: true,
        _reportsCount: 1,
      });
    });
    return Array.from(map.values()).sort((a, b) => (a['Employee Name'] || '').localeCompare(b['Employee Name'] || ''));
  }, [employees, empByCode]);

  const allRows = useMemo(() => [...employees, ...externalManagers], [employees, externalManagers]);

  // Build group + manager option lists from data
  const groupOptions = useMemo(() => {
    const set = new Set();
    employees.forEach((e) => {
      const g = String(e['Group Name'] || e.assignedGoalGroupName || '').trim();
      if (g) set.add(g);
    });
    return Array.from(set).sort();
  }, [employees]);
  const managerOptions = useMemo(() => {
    const map = new Map(); // mgrCode → display label
    employees.forEach((e) => {
      const code = String(e['Reporting Manager Code'] || '').trim();
      if (!code) return;
      if (!map.has(code)) {
        const mgrEmp = empByCode[code.toLowerCase()];
        const name = mgrEmp?.['Employee Name'] || String(e['Reporting Manager Name'] || '').trim() || code;
        map.set(code, `${name} · ${code}`);
      }
    });
    return Array.from(map.entries()).sort((a, b) => a[1].localeCompare(b[1]));
  }, [employees, empByCode]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return allRows.filter((e) => {
      const matchSearch = !q || `${e['Employee Name'] || ''} ${e['Employee Code'] || ''} ${e.Designation || ''}`.toLowerCase().includes(q);
      const grp = String(e['Group Name'] || e.assignedGoalGroupName || '').trim();
      // External managers have no group / stage — they pass group/stage filters only when no filter is set.
      const matchGroup = !filterGroup || (e._external ? false : grp === filterGroup);
      const matchStage = !filterStage || (e._external ? false : getEmpStage(e) === filterStage);
      const matchMgr = !filterManager || String(e['Reporting Manager Code'] || '').trim() === filterManager;
      return matchSearch && matchGroup && matchStage && matchMgr;
    });
  }, [allRows, search, filterGroup, filterStage, filterManager]);

  // Group counts for the chip-row
  const groupCounts = useMemo(() => {
    const c = {};
    employees.forEach((e) => {
      const g = String(e['Group Name'] || e.assignedGoalGroupName || '').trim() || '—';
      c[g] = (c[g] || 0) + 1;
    });
    return c;
  }, [employees]);

  const GROUP_COLORS = ['#4F46E5', '#0891B2', '#16A34A', '#D97706', '#7C3AED', '#EC4899', '#EF4444', '#14B8A6'];
  const groupColor = (name) => {
    const i = groupOptions.indexOf(name);
    return GROUP_COLORS[(i >= 0 ? i : 0) % GROUP_COLORS.length];
  };

  const inputStyle = { border: '1.5px solid #E2E8F0', borderRadius: 8, padding: '8px 12px', fontSize: 13, outline: 'none', fontFamily: 'inherit', color: '#0D1117', background: '#fff' };

  const activeFilterCount = (filterGroup ? 1 : 0) + (filterStage ? 1 : 0) + (filterManager ? 1 : 0);
  const anyFilter = !!(search || activeFilterCount > 0);

  return (
    <div>
      {/* Search + Filter + temp-password pill row */}
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: filtersOpen ? 10 : 12, flexWrap: 'wrap' }}>
        <div style={{ position: 'relative', flex: '1 1 240px', minWidth: 200 }}>
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none', color: '#94A3B8' }}>
            <circle cx="6.5" cy="6.5" r="4.5" stroke="currentColor" strokeWidth="1.4"/><line x1="10" y1="10" x2="14" y2="14" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
          </svg>
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search name, code, or designation…" style={{ ...inputStyle, width: '100%', boxSizing: 'border-box', paddingLeft: 30 }} />
        </div>
        <button type="button" onClick={() => setFiltersOpen((v) => !v)}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 8, padding: '8px 14px', background: filtersOpen || activeFilterCount > 0 ? '#EEF2FF' : '#fff', color: filtersOpen || activeFilterCount > 0 ? '#4338CA' : '#475569', border: `1.5px solid ${filtersOpen || activeFilterCount > 0 ? '#C7D2FE' : '#E2E8F0'}`, borderRadius: 8, fontSize: 12.5, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit', transition: 'all 160ms ease' }}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/></svg>
          Filters
          {activeFilterCount > 0 && (
            <span style={{ background: '#4338CA', color: '#fff', borderRadius: 999, fontSize: 10.5, fontWeight: 700, padding: '1px 7px', minWidth: 16, textAlign: 'center' }}>{activeFilterCount}</span>
          )}
          <svg width="10" height="10" viewBox="0 0 16 16" fill="none" style={{ marginLeft: 2, transform: filtersOpen ? 'rotate(180deg)' : 'rotate(0)', transition: 'transform 200ms ease' }}><path d="M3 6l5 5 5-5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/></svg>
        </button>
        {anyFilter && (
          <button type="button" onClick={() => { setSearch(''); setFilterGroup(''); setFilterStage(''); setFilterManager(''); }}
            style={{ padding: '8px 14px', background: '#fff', color: '#475569', border: '1.5px solid #E2E8F0', borderRadius: 8, fontSize: 12.5, cursor: 'pointer', fontFamily: 'inherit' }}>Clear all</button>
        )}
        <span style={{ fontSize: 12, color: '#94A3B8' }}>{filtered.length} of {allRows.length}{externalManagers.length > 0 ? ` · ${externalManagers.length} external mgr${externalManagers.length !== 1 ? 's' : ''}` : ''}</span>
        <span style={{ marginLeft: 'auto', fontSize: 11.5, color: '#64748B', background: '#F8FAFC', border: '1px solid #E2E8F0', borderRadius: 999, padding: '6px 12px' }}>
          Proxy mode uses the employee session directly. Reset individual passwords from Employee Status.
        </span>
      </div>

      {/* Collapsible filters panel */}
      <div style={{
        display: 'grid',
        gridTemplateRows: filtersOpen ? '1fr' : '0fr',
        opacity: filtersOpen ? 1 : 0,
        transition: 'grid-template-rows 280ms cubic-bezier(0.22,1,0.36,1), opacity 220ms ease, margin 220ms ease',
        marginBottom: filtersOpen ? 12 : 0,
      }}>
        <div style={{ overflow: 'hidden', minHeight: 0 }}>
          <div style={{ background: '#FAFBFF', border: '1px solid #E2E8F0', borderRadius: 12, padding: '14px 16px', display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12 }}>
            <div>
              <div style={{ fontSize: 11, fontWeight: 700, color: '#94A3B8', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>Group</div>
              <select value={filterGroup} onChange={(e) => setFilterGroup(e.target.value)} style={{ ...inputStyle, width: '100%' }}>
                <option value="">All groups</option>
                {groupOptions.map((g) => <option key={g} value={g}>{g}</option>)}
              </select>
            </div>
            <div>
              <div style={{ fontSize: 11, fontWeight: 700, color: '#94A3B8', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>Stage</div>
              <select value={filterStage} onChange={(e) => setFilterStage(e.target.value)} style={{ ...inputStyle, width: '100%' }}>
                <option value="">All stages</option>
                {EMP_STAGES.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
              </select>
            </div>
            <div>
              <div style={{ fontSize: 11, fontWeight: 700, color: '#94A3B8', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>Manager</div>
              <select value={filterManager} onChange={(e) => setFilterManager(e.target.value)} style={{ ...inputStyle, width: '100%' }}>
                <option value="">All managers</option>
                {managerOptions.map(([code, label]) => <option key={code} value={code}>{label}</option>)}
              </select>
            </div>
          </div>
        </div>
      </div>

      {/* Quick-jump group chips */}
      {groupOptions.length > 1 && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 16 }}>
          <button type="button" onClick={() => setFilterGroup('')}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '4px 12px', borderRadius: 999, background: !filterGroup ? '#0F172A' : '#fff', border: `1.5px solid ${!filterGroup ? '#0F172A' : '#E2E8F0'}`, fontSize: 11.5, fontWeight: 700, color: !filterGroup ? '#fff' : '#475569', cursor: 'pointer', fontFamily: 'inherit' }}>
            All<span style={{ background: !filterGroup ? 'rgba(255,255,255,.18)' : '#F1F5F9', borderRadius: 999, padding: '0 7px', fontSize: 11, fontWeight: 700 }}>{allRows.length}</span>
          </button>
          {groupOptions.map((g) => {
            const active = filterGroup === g;
            const color = groupColor(g);
            return (
              <button key={g} type="button" onClick={() => setFilterGroup(active ? '' : g)}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '4px 12px', borderRadius: 999, background: active ? color : '#fff', border: `1.5px solid ${active ? color : '#E2E8F0'}`, fontSize: 11.5, fontWeight: 700, color: active ? '#fff' : '#475569', cursor: 'pointer', fontFamily: 'inherit', transition: 'all 160ms ease' }}>
                <span style={{ width: 7, height: 7, borderRadius: '50%', background: active ? '#fff' : color }} />
                {g}<span style={{ background: active ? 'rgba(255,255,255,.22)' : '#F1F5F9', borderRadius: 999, padding: '0 7px', fontSize: 11, fontWeight: 700 }}>{groupCounts[g] || 0}</span>
              </button>
            );
          })}
        </div>
      )}

      {/* Table */}
      <div style={{ border: '1px solid #E9EDF2', borderRadius: 12, overflow: 'hidden', background: '#fff' }}>
        <table style={{ width: '100%', fontSize: 13, borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ background: '#F8FAFC' }}>
              {['Name', 'Code', 'Group', 'Designation', 'Manager', 'Stage', 'Action'].map((h) => (
                <th key={h} style={{ padding: '11px 14px', textAlign: 'left', fontSize: 11, fontWeight: 700, color: '#94A3B8', textTransform: 'uppercase', letterSpacing: '0.05em', borderBottom: '1px solid #E9EDF2' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 && (
              <tr><td colSpan={7} style={{ padding: '20px', textAlign: 'center', color: '#94A3B8' }}>{employees.length === 0 ? 'No employees uploaded yet.' : 'No employees match these filters.'}</td></tr>
            )}
            {filtered.slice(0, 100).map((emp, i) => {
              const code = emp['Employee Code'] || '—';
              const name = emp['Employee Name'] || '—';
              const grp = String(emp['Group Name'] || emp.assignedGoalGroupName || '').trim() || '—';
              const mgrCode = String(emp['Reporting Manager Code'] || '').trim();
              const mgrEmp = mgrCode ? empByCode[mgrCode.toLowerCase()] : null;
              const mgrName = mgrEmp?.['Employee Name'] || String(emp['Reporting Manager Name'] || '').trim() || '';
              const gColor = grp !== '—' ? groupColor(grp) : '#94A3B8';
              const isExternal = !!emp._external;
              return (
                <tr key={code + i} style={{ borderTop: '1px solid #F1F5F9', background: isExternal ? externalTintBg : 'transparent', transition: 'background 120ms ease' }}>
                  <td style={{ padding: '10px 14px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <div style={{ width: 28, height: 28, borderRadius: '50%', background: isExternal ? fillAccent(orgPalette, { gradient: true }) : 'linear-gradient(135deg,#4F46E5,#7C3AED)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 10, fontWeight: 800, flexShrink: 0 }}>{getInitials(name)}</div>
                      <div style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.3 }}>
                        <span style={{ fontWeight: 500, color: '#0D1117' }}>{name}</span>
                        {isExternal && (
                          <span style={{ fontSize: 10.5, fontWeight: 700, color: externalTintDark, background: externalTintSoft, border: `1px solid ${externalTintBorder}`, borderRadius: 999, padding: '1px 7px', marginTop: 3, width: 'max-content' }}>
                            External · {emp._reportsCount} direct report{emp._reportsCount !== 1 ? 's' : ''}
                          </span>
                        )}
                      </div>
                    </div>
                  </td>
                  <td style={{ padding: '10px 14px', fontFamily: 'monospace', fontWeight: 700, color: isExternal ? externalTintDark : '#4F46E5' }}>{code}</td>
                  <td style={{ padding: '10px 14px' }}>
                    {grp === '—' ? (
                      <span style={{ fontSize: 12, color: '#94A3B8' }}>—</span>
                    ) : (
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11.5, fontWeight: 600, color: gColor, background: `${gColor}10`, border: `1px solid ${gColor}33`, borderRadius: 999, padding: '3px 10px' }}>
                        <span style={{ width: 6, height: 6, borderRadius: '50%', background: gColor }} />{grp}
                      </span>
                    )}
                  </td>
                  <td style={{ padding: '10px 14px', color: '#64748B' }}>{emp.Designation || emp.Role || '—'}</td>
                  <td style={{ padding: '10px 14px', color: '#64748B' }}>
                    {isExternal ? (
                      <span style={{ color: '#94A3B8' }}>—</span>
                    ) : mgrCode ? (
                      <div style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.3 }}>
                        <span style={{ color: '#0D1117', fontSize: 12.5 }}>{mgrName || mgrCode}</span>
                        {mgrName && <span style={{ fontFamily: 'monospace', fontSize: 11, color: '#94A3B8' }}>{mgrCode}</span>}
                      </div>
                    ) : <span style={{ color: '#94A3B8' }}>—</span>}
                  </td>
                  <td style={{ padding: '10px 14px' }}>
                    {isExternal ? <span style={{ fontSize: 11.5, color: '#94A3B8' }}>—</span> : <StagePill stageId={getEmpStage(emp)} />}
                  </td>
                  <td style={{ padding: '10px 14px' }}>
                    <button type="button" onClick={() => openEmp(emp)} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '6px 12px', background: isExternal ? externalTintSoft : '#EEF2FF', color: isExternal ? externalTintDark : '#4338CA', border: `1.5px solid ${isExternal ? externalTintBorder : '#C7D2FE'}`, borderRadius: 8, cursor: 'pointer', fontSize: 12, fontWeight: 600, fontFamily: 'inherit' }}>Open →</button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {filtered.length > 100 && <div style={{ padding: '10px 14px', fontSize: 11.5, color: '#94A3B8', borderTop: '1px solid #F1F5F9', background: '#FAFBFC' }}>Showing first 100 of {filtered.length} matching · narrow your filters to see more.</div>}
      </div>
    </div>
  );
}

/* ── Configuration ──────────────────────────────────────────── */
// Defined at module scope — declaring them inside ModuleConfig would give them
// a fresh identity on every render, causing React to unmount the whole subtree
// (including the brand-name input and logo upload control) on every keystroke.
function ConfigSection({ title, children, style = {} }) {
  return (
    <div style={{ background: '#fff', border: '1.5px solid #E9EDF2', borderRadius: 12, padding: '16px 20px', ...style }}>
      <div style={{ fontSize: 11.5, fontWeight: 700, color: '#94A3B8', textTransform: 'uppercase', letterSpacing: '.07em', marginBottom: 12 }}>{title}</div>
      {children}
    </div>
  );
}
function ConfigRow({ label, value, mono }) {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 8 }}>
      <span style={{ fontSize: 12.5, color: '#64748B', width: 160, flexShrink: 0 }}>{label}</span>
      <span style={{ fontSize: 13, fontWeight: 600, color: '#0D1117', fontFamily: mono ? 'monospace' : 'inherit' }}>{value || '—'}</span>
    </div>
  );
}

// Reusable palette swatch grid — 6 preset cards + a Custom card with a <input type="color">.
// Purely presentational; parent owns storage shape via onPickPreset/onPickCustom callbacks.
function PaletteGrid({ selectedId, customHex, onPickPreset, onPickCustom }) {
  const isCustom = selectedId === 'custom';
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: 10 }}>
      {BRAND_PALETTES.map((p) => {
        const active = p.id === selectedId;
        return (
          <button key={p.id} type="button" onClick={() => onPickPreset(p.id)}
            style={{
              textAlign: 'left', cursor: 'pointer', fontFamily: 'inherit',
              padding: 10, background: '#fff',
              border: `2px solid ${active ? p.primary : '#E9EDF2'}`,
              borderRadius: 12,
              boxShadow: active ? `0 8px 20px ${p.primary}22` : '0 1px 2px rgba(15,23,42,.03)',
              transition: 'all 180ms ease',
              display: 'flex', flexDirection: 'column', gap: 8,
            }}
          >
            <div style={{ height: 46, borderRadius: 8, background: buildSwatchGradient(p), boxShadow: 'inset 0 1px 0 rgba(255,255,255,.35), inset 0 -1px 0 rgba(15,23,42,.12)', position: 'relative' }}>
              {active && (
                <span style={{ position: 'absolute', top: 6, right: 6, width: 18, height: 18, borderRadius: '50%', background: '#fff', color: p.primary, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 800, boxShadow: '0 2px 6px rgba(0,0,0,.18)' }}>
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
                </span>
              )}
            </div>
            <div>
              <div style={{ fontSize: 13, fontWeight: 700, color: '#0F172A' }}>{p.name}</div>
              <div style={{ fontSize: 11.5, color: '#94A3B8', marginTop: 2, lineHeight: 1.4 }}>{p.description}</div>
            </div>
          </button>
        );
      })}
      <label style={{
        textAlign: 'left', cursor: 'pointer', fontFamily: 'inherit',
        padding: 10, background: '#fff',
        border: `2px solid ${isCustom ? customHex : '#E9EDF2'}`,
        borderRadius: 12,
        boxShadow: isCustom ? `0 8px 20px ${customHex}22` : '0 1px 2px rgba(15,23,42,.03)',
        transition: 'all 180ms ease',
        display: 'flex', flexDirection: 'column', gap: 8, position: 'relative',
      }}>
        <div style={{ height: 46, borderRadius: 8, position: 'relative', background: buildSwatchGradient(deriveCustomPalette(customHex)), boxShadow: 'inset 0 1px 0 rgba(255,255,255,.35), inset 0 -1px 0 rgba(15,23,42,.12)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <span style={{ fontSize: 11, fontWeight: 800, color: '#fff', background: 'rgba(15,23,42,0.32)', padding: '3px 10px', borderRadius: 999, letterSpacing: '.02em' }}>
            {isCustom ? customHex.toUpperCase() : 'Pick a colour'}
          </span>
        </div>
        <div>
          <div style={{ fontSize: 13, fontWeight: 700, color: '#0F172A' }}>Custom</div>
          <div style={{ fontSize: 11.5, color: '#94A3B8', marginTop: 2, lineHeight: 1.4 }}>Any hex — gradient auto-derived.</div>
        </div>
        <input type="color" value={customHex} onChange={(e) => onPickCustom(e.target.value)}
          style={{ position: 'absolute', inset: 0, opacity: 0, cursor: 'pointer' }}
          aria-label="Pick custom brand colour"
        />
      </label>
    </div>
  );
}

// The main Theme editor. Four tabs on the left (Primary / Hero / Cards / Fill), sticky
// live-preview on the right. Each tab owns its own control panel; everything reads from the
// same stored org shape so preview + employee page stay in sync.
function BrandThemeEditor({ org, onChange }) {
  const [tab, setTab] = useState('primary');

  // ── Resolve current values with safe defaults ──────────────────────────────
  const primaryId    = org.brandPalette?.id || 'indigo';
  const primaryIsCustom = primaryId === 'custom';
  const primaryHex   = (primaryIsCustom && org.brandPalette?.primary) || '#4F46E5';
  const primaryPalette = primaryIsCustom ? deriveCustomPalette(primaryHex) : resolveBrandPalette(primaryId);

  const storedHero   = org.brandHero;
  const heroResolved = resolveHero(storedHero, primaryPalette);
  // `heroAppliedMode` is what's actually saved + rendering on the employee page.
  // `heroViewMode` is what the admin is currently *looking at* in the editor — it drives the
  // panel switcher only and does NOT write to storage. Previously we wrote the mode on tab
  // click, which meant scrolling through Gradient → Solid → Image applied whatever you
  // visited last. Now the commit moment is moved down into each mode's own controls (pick a
  // palette card, change the colour picker, upload an image). A small "• Applied" marker on
  // the active saved tab makes clear which one is really live.
  const heroAppliedMode = storedHero?.mode || heroResolved.mode;
  const [heroViewMode, setHeroViewMode] = useState(heroAppliedMode);
  useEffect(() => { setHeroViewMode(heroAppliedMode); }, [heroAppliedMode]);

  const cardsMode    = normalizeCardsMode(org.brandCards);
  const fillMode     = org.brandFill  || 'gradient';

  // ── Handlers ───────────────────────────────────────────────────────────────
  const pickPrimaryPreset = (id) => onChange?.({ brandPalette: { id } });
  const pickPrimaryCustom = (hex) => onChange?.({ brandPalette: { id: 'custom', primary: hex } });

  const setHeroPaletteId = (id) => onChange?.({ brandHero: { mode: 'palette', palette: { id } } });
  const setHeroPaletteCustom = (hex) => onChange?.({ brandHero: { mode: 'palette', palette: { id: 'custom', primary: hex } } });
  const setHeroSolid = (hex) => onChange?.({ brandHero: { mode: 'solid', solid: hex } });
  const setHeroImage = (dataUrl) => onChange?.({ brandHero: { mode: 'image', image: dataUrl } });
  const clearHero = () => onChange?.({ brandHero: null });

  const [heroImageError, setHeroImageError] = useState('');
  const [heroDragOver,   setHeroDragOver]   = useState(false);
  function handleHeroImage(file) {
    if (!file) return;
    if (!isImageFile(file)) { setHeroImageError('Please choose an image file.'); return; }
    setHeroImageError('');
    // Hero backgrounds need far more pixels than logos because they render full-width with
    // `cover`. Keep aspect ratio, center-crop at render time, and store a high-quality JPEG
    // that is still small enough for localStorage.
    readImageAsDataUrl(file, { maxDim: 2400, quality: 0.9, maxBytes: 1400 * 1024, forceMime: 'image/jpeg' })
      .then((dataUrl) => {
        const saved = onChange?.({ brandHero: { mode: 'image', image: dataUrl } });
        if (saved === false) setHeroImageError('Image too large to save. Try a smaller file.');
      })
      .catch(() => setHeroImageError('Could not read that image.'));
  }
  function handleHeroDrop(e) {
    e.preventDefault(); e.stopPropagation();
    setHeroDragOver(false);
    const file = e.dataTransfer?.files?.[0];
    if (file) handleHeroImage(file);
  }
  function handleHeroDragOver(e) {
    e.preventDefault(); e.stopPropagation();
    setHeroDragOver(true);
  }
  function handleHeroDragLeave(e) {
    e.preventDefault(); e.stopPropagation();
    setHeroDragOver(false);
  }

  // Hero palette section needs its own selected/custom tracking separately from primary.
  const heroPaletteId  = heroAppliedMode === 'palette' ? (storedHero?.palette?.id || primaryId) : primaryId;
  const heroCustomHex  = (heroPaletteId === 'custom' && storedHero?.palette?.primary) || primaryHex;
  const heroSolidHex   = storedHero?.solid || primaryPalette.primary;

  const TABS = [
    { id: 'primary', label: 'Primary' },
    { id: 'hero',    label: 'Hero' },
    { id: 'cards',   label: 'Cards' },
    { id: 'fill',    label: 'Fill' },
  ];

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(280px, 340px)', gap: 20, alignItems: 'start' }}>
      {/* ─── Left: tabbed editor ─── */}
      <div>
        <div style={{ display: 'inline-flex', background: '#F1F5F9', borderRadius: 10, padding: 3, gap: 2, marginBottom: 14 }}>
          {TABS.map((t) => {
            const active = tab === t.id;
            return (
              <button key={t.id} type="button" onClick={() => setTab(t.id)}
                style={{ padding: '7px 14px', borderRadius: 8, border: 'none', cursor: 'pointer', fontFamily: 'inherit', fontSize: 12.5, fontWeight: active ? 700 : 500, background: active ? '#fff' : 'transparent', color: active ? '#0F172A' : '#64748B', boxShadow: active ? '0 1px 4px rgba(15,23,42,.08)' : 'none', transition: 'all 160ms ease' }}>
                {t.label}
              </button>
            );
          })}
        </div>

        {/* ─── Primary tab ─── */}
        {tab === 'primary' && (
          <div>
            <div style={{ fontSize: 12, color: '#64748B', marginBottom: 10, lineHeight: 1.5 }}>
              The single accent used for buttons, active tabs, chat bubbles, and chips.
            </div>
            <PaletteGrid selectedId={primaryId} customHex={primaryHex}
              onPickPreset={pickPrimaryPreset} onPickCustom={pickPrimaryCustom} />
          </div>
        )}

        {/* ─── Hero tab ─── */}
        {tab === 'hero' && (
          <div>
            <div style={{ fontSize: 12, color: '#64748B', marginBottom: 12, lineHeight: 1.5 }}>
              The big welcome banner at the top of every page. Can mirror the primary palette, use a different gradient, a solid colour, or your own image.
            </div>
            {/* Mode switcher — view-only navigation. Clicking a tab does NOT save; the commit
                happens inside each mode's controls (palette click, colour change, image drop). */}
            <div style={{ display: 'inline-flex', background: '#F8FAFC', border: '1px solid #E9EDF2', borderRadius: 10, padding: 3, gap: 2, marginBottom: 12, alignItems: 'center' }}>
              {[
                { id: 'palette', label: 'Gradient' },
                { id: 'solid',   label: 'Solid' },
                { id: 'image',   label: 'Image' },
              ].map((m) => {
                const viewing = heroViewMode === m.id;
                const applied = heroAppliedMode === m.id && !!storedHero;
                return (
                  <button key={m.id} type="button" onClick={() => setHeroViewMode(m.id)}
                    style={{ position: 'relative', padding: '6px 14px', borderRadius: 7, border: 'none', cursor: 'pointer', fontFamily: 'inherit', fontSize: 12, fontWeight: viewing ? 700 : 500, background: viewing ? '#fff' : 'transparent', color: viewing ? '#0F172A' : '#64748B', boxShadow: viewing ? '0 1px 3px rgba(15,23,42,.08)' : 'none', transition: 'all 140ms ease', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                    {m.label}
                    {applied && (
                      <span title="Currently applied" style={{ width: 6, height: 6, borderRadius: '50%', background: primaryPalette.primary, boxShadow: `0 0 0 2px ${primaryPalette.primary}22` }} />
                    )}
                  </button>
                );
              })}
              {storedHero && (
                <button type="button" onClick={clearHero}
                  style={{ padding: '6px 10px', borderRadius: 7, border: 'none', background: 'transparent', color: '#94A3B8', fontFamily: 'inherit', fontSize: 11.5, cursor: 'pointer', marginLeft: 4 }}>
                  Reset
                </button>
              )}
            </div>

            {/* Status hint — tells the admin whether the tab they're looking at is live. */}
            {heroViewMode !== heroAppliedMode && (
              <div style={{ fontSize: 11.5, color: '#64748B', marginBottom: 10, padding: '6px 10px', background: '#F8FAFC', border: '1px dashed #E2E8F0', borderRadius: 8, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#94A3B8" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>
                <span>
                  Currently looking at <strong style={{ color: '#0F172A' }}>{heroViewMode === 'palette' ? 'Gradient' : heroViewMode === 'solid' ? 'Solid' : 'Image'}</strong>.
                  {heroViewMode === 'palette' && ' Pick a palette below to apply it.'}
                  {heroViewMode === 'solid'   && ' Change the colour below to apply it.'}
                  {heroViewMode === 'image'   && ' Upload or drop a file below to apply it.'}
                </span>
              </div>
            )}

            {heroViewMode === 'palette' && (
              <PaletteGrid
                selectedId={heroPaletteId}
                customHex={heroCustomHex}
                onPickPreset={setHeroPaletteId}
                onPickCustom={setHeroPaletteCustom}
              />
            )}
            {heroViewMode === 'solid' && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: 14, border: '1.5px solid #E9EDF2', borderRadius: 12, background: '#fff' }}>
                <label style={{ position: 'relative', width: 56, height: 56, borderRadius: 10, cursor: 'pointer', flexShrink: 0, border: '1.5px solid #E2E8F0', overflow: 'hidden' }}>
                  <div style={{ position: 'absolute', inset: 0, background: heroSolidHex }} />
                  <input type="color" value={heroSolidHex} onChange={(e) => setHeroSolid(e.target.value)}
                    style={{ position: 'absolute', inset: 0, opacity: 0, cursor: 'pointer' }}
                    aria-label="Pick hero solid colour" />
                </label>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: '#0F172A' }}>Solid colour</div>
                  <div style={{ fontSize: 11.5, color: '#94A3B8', marginTop: 2 }}>
                    {heroAppliedMode === 'solid' ? <>Applied: <code style={{ fontSize: 11 }}>{heroSolidHex.toUpperCase()}</code></> : 'Click the swatch to pick a colour — that applies it.'}
                  </div>
                </div>
              </div>
            )}
            {heroViewMode === 'image' && (
              <div style={{ padding: 14, border: '1.5px solid #E9EDF2', borderRadius: 12, background: '#fff' }}>
                {storedHero?.image ? (
                  <div>
                    <div style={{ height: 120, borderRadius: 10, background: `linear-gradient(135deg, rgba(15,23,42,0.45), rgba(15,23,42,0.30)), url("${storedHero.image}") center/cover no-repeat`, marginBottom: 12, display: 'flex', alignItems: 'flex-end', padding: 10 }}>
                      <span style={{ fontSize: 11, fontWeight: 700, color: '#fff', textShadow: '0 1px 4px rgba(0,0,0,.5)' }}>Image applied ✓</span>
                    </div>
                    <div style={{ display: 'flex', gap: 8 }}>
                      <label style={{ padding: '7px 14px', border: '1.5px solid #E2E8F0', borderRadius: 8, cursor: 'pointer', fontSize: 12.5, fontWeight: 600, color: '#475569', background: '#fff', fontFamily: 'inherit' }}>
                        Replace image
                        <input type="file" accept="image/*" style={{ display: 'none' }}
                          onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; handleHeroImage(f); }} />
                      </label>
                      <button type="button" onClick={clearHero}
                        style={{ padding: '7px 14px', border: '1.5px solid #FECACA', background: '#fff', color: '#DC2626', borderRadius: 8, fontSize: 12, cursor: 'pointer', fontWeight: 600, fontFamily: 'inherit' }}>
                        Remove
                      </button>
                    </div>
                  </div>
                ) : (
                  <label
                    onDragOver={handleHeroDragOver}
                    onDragEnter={handleHeroDragOver}
                    onDragLeave={handleHeroDragLeave}
                    onDrop={handleHeroDrop}
                    style={{
                      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8,
                      padding: '26px 12px',
                      border: `1.5px dashed ${heroDragOver ? primaryPalette.primary : '#CBD5E1'}`,
                      background: heroDragOver ? `${primaryPalette.primary}0D` : '#fff',
                      borderRadius: 10, cursor: 'pointer', textAlign: 'center',
                      transition: 'border-color 140ms ease, background 140ms ease',
                    }}>
                    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke={heroDragOver ? primaryPalette.primary : '#94A3B8'} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
                    <div style={{ fontSize: 13, fontWeight: 700, color: '#0F172A' }}>
                      {heroDragOver ? 'Drop to upload' : 'Upload hero image'}
                    </div>
                    <div style={{ fontSize: 11.5, color: '#94A3B8' }}>Click to browse, or drag and drop. JPG / PNG. A dark overlay is applied automatically for text legibility.</div>
                    <input type="file" accept="image/*" style={{ display: 'none' }}
                      onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; handleHeroImage(f); }} />
                  </label>
                )}
                {heroImageError && <div style={{ fontSize: 12, color: '#DC2626', marginTop: 8, fontWeight: 600 }}>{heroImageError}</div>}
              </div>
            )}
          </div>
        )}

        {/* ─── Cards tab ─── */}
        {tab === 'cards' && (
          <div>
            <div style={{ fontSize: 12, color: '#64748B', marginBottom: 12, lineHeight: 1.5 }}>
              Style of a goal card. The stripe colour comes from the perspective / goal group — red, amber and green are reserved for status, so they never appear here.
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10 }}>
              {CARD_ACCENT_MODES.map((m) => {
                const active = cardsMode === m.id;
                const previewTint = CARD_PREVIEW_TINTS[0]; // non-semantic indigo
                const stripeW = cardStripeWidth(m.id);
                const wash = cardAccentStylePreview(m.id, previewTint);
                return (
                  <button key={m.id} type="button" onClick={() => onChange?.({ brandCards: m.id })}
                    style={{ textAlign: 'left', padding: 10, border: `2px solid ${active ? primaryPalette.primary : '#E9EDF2'}`, borderRadius: 12, background: '#fff', cursor: 'pointer', fontFamily: 'inherit', display: 'flex', flexDirection: 'column', gap: 8, boxShadow: active ? `0 8px 20px ${primaryPalette.primary}22` : '0 1px 2px rgba(15,23,42,.03)', transition: 'all 180ms ease' }}>
                    {/* Mock card preview: real stripe + optional wash, so the thumbnail
                        reflects how the actual goal card will look. */}
                    <div style={{
                      position: 'relative', overflow: 'hidden',
                      height: 54, borderRadius: 8,
                      background: '#fff',
                      border: '1px solid #E9EDF2',
                      padding: `8px 10px 8px ${stripeW + 10}px`,
                      display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 4,
                      ...wash,
                    }}>
                      {stripeW > 0 && (
                        <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: stripeW, background: previewTint }} />
                      )}
                      <div style={{ height: 5, width: '62%', background: 'rgba(15,23,42,.22)', borderRadius: 3 }} />
                      <div style={{ height: 4, width: '34%', background: 'rgba(15,23,42,.12)', borderRadius: 3 }} />
                    </div>
                    <div>
                      <div style={{ fontSize: 12.5, fontWeight: 700, color: '#0F172A' }}>{m.name}</div>
                      <div style={{ fontSize: 11, color: '#94A3B8', marginTop: 2, lineHeight: 1.35 }}>{m.description}</div>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* ─── Fill tab ─── */}
        {tab === 'fill' && (
          <div>
            <div style={{ fontSize: 12, color: '#64748B', marginBottom: 12, lineHeight: 1.5 }}>
              Every accent surface (buttons, chat bubbles, chips, send button) uses either a gradient or a flat fill. Switch the whole thing here.
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              {[
                { id: 'gradient', name: 'Gradient', desc: 'Warm feel — primary → primaryDark.' },
                { id: 'solid',    name: 'Solid',    desc: 'Flat, minimal — just the primary colour.' },
              ].map((m) => {
                const active = fillMode === m.id;
                return (
                  <button key={m.id} type="button" onClick={() => onChange?.({ brandFill: m.id })}
                    style={{ textAlign: 'left', padding: 10, border: `2px solid ${active ? primaryPalette.primary : '#E9EDF2'}`, borderRadius: 12, background: '#fff', cursor: 'pointer', fontFamily: 'inherit', display: 'flex', flexDirection: 'column', gap: 8, boxShadow: active ? `0 8px 20px ${primaryPalette.primary}22` : '0 1px 2px rgba(15,23,42,.03)', transition: 'all 180ms ease' }}>
                    <div style={{ height: 40, borderRadius: 8, background: m.id === 'gradient' ? `linear-gradient(135deg, ${primaryPalette.primary}, ${primaryPalette.primaryDark})` : primaryPalette.primary }} />
                    <div>
                      <div style={{ fontSize: 12.5, fontWeight: 700, color: '#0F172A' }}>{m.name}</div>
                      <div style={{ fontSize: 11, color: '#94A3B8', marginTop: 2, lineHeight: 1.35 }}>{m.desc}</div>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {/* ─── Right: unified live preview ─── */}
      <div style={{ position: 'sticky', top: 16 }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: '#94A3B8', textTransform: 'uppercase', letterSpacing: '.07em', marginBottom: 8 }}>Live preview</div>
        <div style={{ border: '1.5px solid #E9EDF2', borderRadius: 14, overflow: 'hidden', background: '#fff' }}>
          {/* Preview is tab-scoped: each tab shows only the surfaces it actually controls. */}
          {(tab === 'primary' || tab === 'hero') && (
            <div style={{ padding: '16px 14px', color: '#fff', ...buildHeroBackground(heroResolved), position: 'relative' }}>
              <div style={{ fontSize: 13, fontWeight: 800, textShadow: '0 2px 10px rgba(15,23,42,.3)' }}>Hi, Priya 👋</div>
              <div style={{ fontSize: 11.5, marginTop: 4, color: 'rgba(255,255,255,.88)' }}>3 active goals this cycle.</div>
              <div style={{ marginTop: 10, padding: '8px 10px', background: 'linear-gradient(135deg,rgba(255,255,255,.22),rgba(255,255,255,.08))', borderRadius: 9, border: '1px solid rgba(255,255,255,.28)', boxShadow: 'inset 0 1px 0 rgba(255,255,255,.36)' }}>
                <div style={{ fontSize: 10, fontWeight: 700, opacity: 0.9, textTransform: 'uppercase', letterSpacing: '.06em' }}>Goal plan completion</div>
                <span style={{ fontSize: 18, fontWeight: 800 }}>72%</span>
              </div>
            </div>
          )}

          {tab === 'primary' && (
            <div style={{ padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 10 }}>
              <div style={{ display: 'flex', gap: 6 }}>
                <span style={{ padding: '5px 11px', borderRadius: 999, background: primaryPalette.primary, color: '#fff', fontSize: 11, fontWeight: 700 }}>My Goals</span>
                <span style={{ padding: '5px 11px', borderRadius: 999, background: '#fff', color: '#475569', border: '1.5px solid #E2E8F0', fontSize: 11, fontWeight: 700 }}>Messages</span>
              </div>
              <button type="button" disabled style={{
                padding: '7px 12px',
                background: fillAccent(primaryPalette, { gradient: fillMode === 'gradient' }),
                color: '#fff', border: 'none', borderRadius: 8,
                fontSize: 11.5, fontWeight: 700, alignSelf: 'flex-start', cursor: 'default',
                boxShadow: `0 4px 10px ${primaryPalette.primary}55`, fontFamily: 'inherit',
              }}>
                Primary action →
              </button>
            </div>
          )}

          {tab === 'cards' && (
            <div style={{ padding: '14px', display: 'flex', flexDirection: 'column', gap: 10 }}>
              {/* Two mock cards with non-semantic perspective tints (indigo + cyan). Green,
                  amber and red are deliberately avoided — those tones already mean
                  approved / pending / rejected everywhere else in the app. */}
              {[
                { title: 'Drive Q2 retention',    meta: 'Customer / Stakeholder · 25%', tint: CARD_PREVIEW_TINTS[0] },
                { title: 'Reduce onboarding TAT', meta: 'Internal Process · 20%',        tint: CARD_PREVIEW_TINTS[1] },
              ].map((g, i) => {
                const stripeW = cardStripeWidth(cardsMode);
                const wash = cardAccentStylePreview(cardsMode, g.tint);
                return (
                  <div key={i} style={{
                    position: 'relative', overflow: 'hidden',
                    padding: `10px 12px 10px ${stripeW + 12}px`,
                    borderRadius: 10, background: '#fff',
                    border: '1.5px solid #E9EDF2',
                    ...wash,
                  }}>
                    {stripeW > 0 && (
                      <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: stripeW, background: g.tint }} />
                    )}
                    <div style={{ fontSize: 11.5, fontWeight: 700, color: '#0F172A' }}>{g.title}</div>
                    <div style={{ fontSize: 10.5, color: '#64748B', marginTop: 2 }}>{g.meta}</div>
                  </div>
                );
              })}
            </div>
          )}

          {tab === 'fill' && (
            <div style={{ padding: '14px', display: 'flex', flexDirection: 'column', gap: 12 }}>
              {/* Outgoing chat bubble */}
              <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                <div style={{
                  maxWidth: '80%',
                  padding: '8px 12px',
                  borderRadius: '14px 14px 4px 14px',
                  background: fillAccent(primaryPalette, { gradient: fillMode === 'gradient' }),
                  color: '#fff', fontSize: 11.5,
                  boxShadow: `0 2px 8px ${primaryPalette.primary}38`,
                }}>
                  Thanks, looks good!
                </div>
              </div>
              {/* CTA + unread chip */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <button type="button" disabled style={{
                  padding: '7px 14px',
                  background: fillAccent(primaryPalette, { gradient: fillMode === 'gradient' }),
                  color: '#fff', border: 'none', borderRadius: 8,
                  fontSize: 11.5, fontWeight: 700, cursor: 'default',
                  boxShadow: `0 4px 10px ${primaryPalette.primary}55`, fontFamily: 'inherit',
                }}>
                  Send reminder →
                </button>
                <span style={{
                  padding: '3px 10px', borderRadius: 999,
                  background: fillAccent(primaryPalette, { gradient: fillMode === 'gradient' }),
                  color: '#fff', fontSize: 10.5, fontWeight: 800,
                  boxShadow: `0 2px 6px ${primaryPalette.primary}45`,
                }}>
                  3 new
                </span>
              </div>
              {/* Round send button */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <div style={{ fontSize: 10.5, color: '#94A3B8', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.05em' }}>Send</div>
                <button type="button" disabled style={{
                  width: 30, height: 30, borderRadius: '50%', border: 'none',
                  background: fillAccent(primaryPalette, { gradient: fillMode === 'gradient' }),
                  color: '#fff', cursor: 'default',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  boxShadow: `0 3px 9px ${primaryPalette.primary}55`,
                }}>
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 2 11 13"/><path d="M22 2 15 22l-4-9-9-4z"/></svg>
                </button>
              </div>
            </div>
          )}
        </div>
        <div style={{ display: 'flex', gap: 6, marginTop: 10, alignItems: 'center', fontSize: 11, color: '#64748B' }}>
          <span style={{ width: 14, height: 14, borderRadius: 4, background: primaryPalette.primary, border: '1px solid rgba(15,23,42,.08)' }} />
          <code style={{ fontSize: 11, color: '#475569' }}>{primaryPalette.primary.toUpperCase()}</code>
          <span style={{ marginLeft: 'auto', color: '#94A3B8' }}>{primaryPalette.name}</span>
        </div>
      </div>
    </div>
  );
}

// Preview-only card styling. Matches the runtime `cardAccentStyle` in brandPalettes.js but
// with ~2× stronger wash so the subtle tint reads clearly on a thumbnail-sized card.
// 'minimal' and 'default' return {} — those modes are distinguished by whether the stripe
// is rendered (caller handles that with `cardStripeWidth`), not by any body tint.
function cardAccentStylePreview(mode, tint) {
  if (!tint || !mode || mode !== 'colourful') return {};
  const m = /^#?([a-fA-F0-9]{6})$/.exec(String(tint || ''));
  if (!m) return {};
  const r = parseInt(m[1].slice(0, 2), 16);
  const g = parseInt(m[1].slice(2, 4), 16);
  const b = parseInt(m[1].slice(4, 6), 16);
  return {
    background: `linear-gradient(90deg, rgba(${r},${g},${b},0.20) 0%, rgba(${r},${g},${b},0.04) 80%)`,
    border: `1.5px solid rgba(${r},${g},${b},0.40)`,
  };
}

function ModuleConfig({ config, org, onEditSetup, onBrandChange }) {
  const [logoError, setLogoError] = useState('');
  // Local mirror of brandName so typing doesn't thrash parent state / localStorage on every keystroke.
  const [brandNameDraft, setBrandNameDraft] = useState(org.brandName || '');
  useEffect(() => { setBrandNameDraft(org.brandName || ''); }, [org.brandName]);
  function commitBrandName(value) {
    if ((org.brandName || '') === value) return;
    onBrandChange?.({ brandName: value });
  }

  function handleLogoUpload(file) {
    if (!file || !onBrandChange) return;
    if (!isImageFile(file)) {
      setLogoError('Please choose an image file (PNG, JPG, or SVG).');
      return;
    }
    setLogoError('');
    readImageAsDataUrl(file, { maxDim: 320, quality: 0.86 })
      .then((dataUrl) => {
        const saved = onBrandChange({ brandLogo: dataUrl });
        if (saved === false) {
          setLogoError('That image is still too large to save. Try a smaller logo file.');
        }
      })
      .catch(() => setLogoError('Could not read that image. Try another file.'));
  }
  if (!config) {
    return (
      <div style={{ textAlign: 'center', padding: '48px 20px', color: '#94A3B8' }}>
        <div style={{ fontSize: 36, marginBottom: 12 }}>⚙️</div>
        <div style={{ fontSize: 15, fontWeight: 700, color: '#374151', marginBottom: 6 }}>No configuration found</div>
        <div style={{ fontSize: 13, marginBottom: 20 }}>Configuration data could not be loaded.</div>
        <button type="button" onClick={onEditSetup} style={{ padding: '9px 20px', background: '#4F46E5', color: '#fff', border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' }}>← Go to Setup</button>
      </div>
    );
  }

  const employees = config.employeeUploadData?.employees || [];

  return (
    // Cap at a sane max so the page doesn't stretch on ultra-wide monitors, but let it breathe.
    // Sections are laid out in a 12-col grid below so narrow sections (Branding / Organisation /
    // Framework / Groups) pair up into two columns, while wider ones (Theme, Goal Limits) span
    // the whole row. `alignItems: start` keeps each card at its own natural height instead of
    // stretching pairs to match the taller sibling.
    <div style={{ maxWidth: 1400, display: 'grid', gridTemplateColumns: 'repeat(12, 1fr)', gap: 14, alignItems: 'start' }}>
      <div style={{ gridColumn: '1 / -1', display: 'flex', justifyContent: 'flex-end' }}>
        <button type="button" onClick={onEditSetup}
          style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 16px', background: '#4F46E5', color: '#fff', border: 'none', borderRadius: 8, fontSize: 12.5, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' }}>
          ✏️ Edit Configuration
        </button>
      </div>

      <ConfigSection title="Branding" style={{ gridColumn: 'span 6', marginBottom: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap', marginBottom: 8 }}>
          <div style={{ width: 56, height: 56, borderRadius: 12, background: '#F8FAFC', border: '1.5px dashed #E2E8F0', display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden', flexShrink: 0 }}>
	            {org.brandLogo ? (
	              <img src={org.brandLogo} alt="Brand logo" style={{ width: '100%', height: '100%', objectFit: 'contain', padding: 4, boxSizing: 'border-box' }} />
            ) : (
              <span style={{ fontSize: 11, fontWeight: 700, color: '#94A3B8', textAlign: 'center' }}>No logo</span>
            )}
          </div>
          <div style={{ flex: 1, minWidth: 220 }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: '#0F172A' }}>{org.brandName || org.name || 'Your organization'}</div>
            <div style={{ fontSize: 12, color: '#64748B', marginTop: 3, lineHeight: 1.55 }}>
              Replaces the Zaro HR logo + wordmark on the top-left of every admin + employee page for this org. PNG / JPG / SVG, ideally square.
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '7px 14px', border: '1.5px solid #E2E8F0', borderRadius: 8, cursor: 'pointer', fontSize: 12.5, fontWeight: 600, color: '#475569', background: '#fff' }}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
              {org.brandLogo ? 'Replace' : 'Upload logo'}
              <input
                type="file"
                accept="image/*"
                onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; handleLogoUpload(f); }}
                style={{ display: 'none' }}
              />
            </label>
            {org.brandLogo && (
              <button type="button" onClick={() => onBrandChange({ brandLogo: null })}
                style={{ padding: '7px 12px', border: '1.5px solid #FECACA', background: '#fff', color: '#DC2626', borderRadius: 8, fontSize: 12, cursor: 'pointer', fontFamily: 'inherit', fontWeight: 600 }}>
                Remove
              </button>
            )}
          </div>
        </div>
        {logoError && (
          <div style={{ fontSize: 12, color: '#DC2626', marginTop: 8, fontWeight: 600 }}>{logoError}</div>
        )}
        <div style={{ marginTop: 10 }}>
          <label style={{ fontSize: 12, color: '#64748B', fontWeight: 600, display: 'block', marginBottom: 5 }}>Brand name (optional)</label>
          <input
            type="text"
            value={brandNameDraft}
            placeholder={org.name || 'Shown next to the logo'}
            onChange={(e) => setBrandNameDraft(e.target.value)}
            onBlur={() => commitBrandName(brandNameDraft.trim())}
            onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
            style={{ width: '100%', maxWidth: 360, border: '1.5px solid #E2E8F0', borderRadius: 8, padding: '8px 12px', fontSize: 13, outline: 'none', fontFamily: 'inherit', color: '#0F172A', background: '#fff', boxSizing: 'border-box' }}
          />
        </div>
      </ConfigSection>

      <ConfigSection title="Organisation" style={{ gridColumn: 'span 6', marginBottom: 0 }}>
        <ConfigRow label="Name" value={org.name} />
        <ConfigRow label="Industry" value={org.industry} />
        <ConfigRow label="HR Admin" value={org.hrAdminName} />
        <ConfigRow label="PMS Calendar" value={org.pmsCalendar} />
        <ConfigRow label="Employees in PMS" value={employees.length} />
      </ConfigSection>

      <ConfigSection title="Theme" style={{ gridColumn: '1 / -1', marginBottom: 0 }}>
        <BrandThemeEditor org={org} onChange={onBrandChange} />
      </ConfigSection>

      {/* Performance Framework / Employee Groups / Goal Limits sections used to live here as
          read-only echoes of the wizard config. They've been removed — admins edit those via
          "Edit Configuration" at the top. */}
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════
   MODULE: HR TEAM
══════════════════════════════════════════════════════════════ */
const OPS_MODULES_LIST = [
  { id: 'overview',      label: 'Overview' },
  { id: 'emp-status',    label: 'Employee Status' },
  { id: 'comms',         label: 'Communications' },
  { id: 'stage',         label: 'Stage Control' },
  { id: 'mgr-change',    label: 'Manager Change' },
  { id: 'grp-transfer',  label: 'Group Transfer' },
  { id: 'roster',        label: 'Add / Remove' },
  { id: 'test-creds',    label: 'View as Proxy' },
];

function genTempPassword() {
  return 'HR@' + Math.random().toString(36).slice(2, 6).toUpperCase();
}

function ModuleEmailSettings({ org, orgKey }) {
  const [settings, setSettings] = useState(() => getDefaultSmtpSettings());
  const [testEmail, setTestEmail] = useState('');
  const [loadState, setLoadState] = useState({ loading: true, error: '' });
  const [saveState, setSaveState] = useState({ status: 'idle', message: '' });
  const [verifyState, setVerifyState] = useState({ status: 'idle', message: '' });
  const [testState, setTestState] = useState({ status: 'idle', message: '' });

  useEffect(() => {
    let cancelled = false;
    async function run() {
      if (!orgKey) {
        if (!cancelled) {
          setLoadState({ loading: false, error: 'Organization context is missing.' });
        }
        return;
      }
      setLoadState({ loading: true, error: '' });
      const result = await loadOrgSmtpSettings(orgKey);
      if (cancelled) return;
      if (result?.ok) {
        setSettings(result.settings || getDefaultSmtpSettings());
        setLoadState({ loading: false, error: '' });
      } else {
        setSettings(getDefaultSmtpSettings());
        setLoadState({ loading: false, error: result?.error || 'Could not load email settings.' });
      }
    }
    run();
    return () => { cancelled = true; };
  }, [orgKey]);

  function updateSetting(key, value) {
    setSettings((prev) => ({ ...prev, [key]: value }));
  }

  async function handleSave() {
    setSaveState({ status: 'saving', message: '' });
    const result = await saveOrgSmtpSettings(orgKey, settings);
    if (result?.ok) {
      setSettings(result.settings || settings);
      setSaveState({ status: 'saved', message: 'SMTP settings saved.' });
      return;
    }
    setSaveState({ status: 'failed', message: result?.error || 'Could not save SMTP settings.' });
  }

  async function handleVerify() {
    setVerifyState({ status: 'verifying', message: '' });
    const result = await verifyOrgSmtpConnection(orgKey, settings);
    if (result?.ok) {
      setVerifyState({ status: 'verified', message: result?.message || 'SMTP connection verified.' });
      return;
    }
    setVerifyState({ status: 'failed', message: result?.error || 'SMTP verification failed.' });
  }

  async function handleSendTest() {
    if (!String(testEmail || '').trim()) {
      setTestState({ status: 'failed', message: 'Enter a recipient email for the test message.' });
      return;
    }
    setTestState({ status: 'sending', message: '' });
    const result = await sendOrgSmtpTestEmail(orgKey, settings, testEmail);
    if (result?.ok) {
      setTestState({ status: 'sent', message: result?.message || 'Test email sent.' });
      return;
    }
    setTestState({ status: 'failed', message: result?.error || 'Test email failed.' });
  }

  const S = {
    card: { background: '#fff', border: '1px solid #E9EDF2', borderRadius: 14, padding: '22px 22px 20px' },
    label: { display: 'block', fontSize: 11.5, fontWeight: 700, color: '#64748B', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 7 },
    input: { width: '100%', padding: '11px 13px', border: '1.5px solid #E2E8F0', borderRadius: 10, fontSize: 14, color: '#0F172A', fontFamily: 'inherit', boxSizing: 'border-box', outline: 'none', background: '#fff' },
    btnPrimary: { padding: '10px 16px', background: '#0F4C81', color: '#fff', border: 'none', borderRadius: 10, fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' },
    btnSecondary: { padding: '10px 16px', background: '#fff', color: '#334155', border: '1.5px solid #D9E2EC', borderRadius: 10, fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' },
  };

  const noticeStyle = (tone) => ({
    borderRadius: 10,
    padding: '10px 12px',
    fontSize: 12.5,
    border: `1px solid ${tone === 'good' ? '#BBF7D0' : tone === 'bad' ? '#FECACA' : '#DBEAFE'}`,
    background: tone === 'good' ? '#F0FDF4' : tone === 'bad' ? '#FEF2F2' : '#EFF6FF',
    color: tone === 'good' ? '#166534' : tone === 'bad' ? '#B91C1C' : '#1D4ED8',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
    lineHeight: 1.55,
  });

  return (
    <div style={{ maxWidth: 980 }}>
      <div style={{ marginBottom: 22 }}>
        <h2 style={{ fontSize: 20, fontWeight: 700, color: '#0F172A', margin: 0 }}>Email Settings</h2>
        <p style={{ fontSize: 13, color: '#64748B', margin: '4px 0 0' }}>
          By default, all emails for {org?.name || 'this organization'} go from the ZaroHR sender. Enable custom SMTP only if this organization wants mail to go from its own mailbox.
        </p>
      </div>

      {loadState.error && <div style={{ ...noticeStyle('bad'), marginBottom: 16 }}>{loadState.error}</div>}

      <div style={{ ...S.card, marginBottom: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap', marginBottom: 20 }}>
          <div>
            <div style={{ fontSize: 18, fontWeight: 700, color: '#0F172A' }}>Custom Email Sender</div>
            <div style={{ fontSize: 13, color: '#64748B', marginTop: 3 }}>Pick how this organization sends outbound mail.</div>
          </div>
          <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer', userSelect: 'none' }}>
            <span style={{ fontSize: 12, fontWeight: 700, color: settings.isEnabled ? '#0F4C81' : '#64748B', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
              {settings.isEnabled ? 'Custom sender enabled' : 'Using default ZaroHR sender'}
            </span>
            <span style={{ position: 'relative', width: 52, height: 30, background: settings.isEnabled ? '#0F4C81' : '#CBD5E1', borderRadius: 999, transition: 'background 160ms ease' }}>
              <input
                type="checkbox"
                checked={settings.isEnabled}
                onChange={(e) => updateSetting('isEnabled', e.target.checked)}
                style={{ position: 'absolute', inset: 0, opacity: 0, cursor: 'pointer' }}
              />
              <span style={{ position: 'absolute', top: 3, left: settings.isEnabled ? 25 : 3, width: 24, height: 24, borderRadius: '50%', background: '#fff', transition: 'left 160ms ease' }} />
            </span>
          </label>
        </div>

        {/* Provider tabs */}
        <div style={{ display: 'inline-flex', gap: 2, padding: 4, background: '#F1F5F9', borderRadius: 11, marginBottom: 18 }}>
          {[
            { k: 'smtp', label: 'SMTP' },
            { k: 'microsoft', label: 'Microsoft 365' },
            { k: 'google', label: 'Google Workspace' },
          ].map((tab) => {
            const active = (settings.provider || 'smtp') === tab.k;
            return (
              <button key={tab.k} type="button" onClick={() => updateSetting('provider', tab.k)}
                style={{ padding: '8px 18px', borderRadius: 8, border: 'none', cursor: 'pointer', fontFamily: 'inherit', fontSize: 13, fontWeight: active ? 700 : 500, background: active ? '#fff' : 'transparent', color: active ? '#0F172A' : '#64748B', boxShadow: active ? '0 1px 4px rgba(15,23,42,.08)' : 'none' }}>
                {tab.label}
              </button>
            );
          })}
        </div>

        <div style={{ ...noticeStyle('info'), marginBottom: 18 }}>
          {settings.provider === 'microsoft'
            ? 'Sends through Microsoft Graph using a tenant-registered app with Mail.Send application permission. Falls back to the default ZaroHR sender if the toggle is off or credentials are incomplete.'
            : settings.provider === 'google'
            ? 'Sends through the Gmail API using an OAuth client with gmail.send scope. Falls back to the default ZaroHR sender if the toggle is off or credentials are incomplete.'
            : 'Standard SMTP. Falls back to the default ZaroHR sender if the toggle is off or credentials are incomplete.'}
        </div>

        {/* SMTP fields */}
        {settings.provider === 'smtp' && (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(240px, 1fr))', gap: 16, marginBottom: 16 }}>
            <div>
              <label style={S.label}>Use TLS / STARTTLS</label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '11px 13px', border: '1.5px solid #E2E8F0', borderRadius: 10, cursor: 'pointer' }}>
                <input type="checkbox" checked={settings.useTls} onChange={(e) => updateSetting('useTls', e.target.checked)} style={{ width: 16, height: 16, accentColor: '#0F4C81' }} />
                <span style={{ fontSize: 13, color: '#334155' }}>Secure the SMTP connection</span>
              </label>
            </div>
            <div>
              <label style={S.label}>SMTP Port</label>
              <input style={S.input} value={settings.smtpPort} onChange={(e) => updateSetting('smtpPort', e.target.value)} placeholder="465" inputMode="numeric" />
            </div>
            <div>
              <label style={S.label}>SMTP Host</label>
              <input style={S.input} value={settings.smtpHost} onChange={(e) => updateSetting('smtpHost', e.target.value)} placeholder="smtp.hostinger.com" />
            </div>
            <div>
              <label style={S.label}>SMTP Username</label>
              <input style={S.input} value={settings.smtpUsername} onChange={(e) => updateSetting('smtpUsername', e.target.value)} placeholder="noreply@yourdomain.com" />
            </div>
            <div>
              <label style={S.label}>SMTP Password / API Key</label>
              <input style={S.input} type="password" value={settings.smtpPassword} onChange={(e) => updateSetting('smtpPassword', e.target.value)} placeholder={settings.hasPassword ? 'Saved password retained unless you replace it' : 'Your mailbox password'} />
            </div>
          </div>
        )}

        {/* Microsoft fields */}
        {settings.provider === 'microsoft' && (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(240px, 1fr))', gap: 16, marginBottom: 16 }}>
            <div style={{ gridColumn: '1 / -1' }}>
              <label style={S.label}>Tenant ID (Directory ID)</label>
              <input style={S.input} value={settings.msTenantId} onChange={(e) => updateSetting('msTenantId', e.target.value)} placeholder="00000000-0000-0000-0000-000000000000" />
            </div>
            <div>
              <label style={S.label}>Client ID (Application ID)</label>
              <input style={S.input} value={settings.msClientId} onChange={(e) => updateSetting('msClientId', e.target.value)} placeholder="00000000-0000-0000-0000-000000000000" />
            </div>
            <div>
              <label style={S.label}>Client Secret Value</label>
              <input style={S.input} type="password" value={settings.msClientSecret} onChange={(e) => updateSetting('msClientSecret', e.target.value)} placeholder={settings.hasMsClientSecret ? 'Saved secret retained unless you replace it' : 'Paste the secret VALUE (not the secret ID)'} />
            </div>
            <div style={{ gridColumn: '1 / -1', fontSize: 12, color: '#64748B', lineHeight: 1.6 }}>
              In Azure Entra → App registrations: register an app, add an API permission for Microsoft Graph → Application → <strong>Mail.Send</strong>, grant admin consent, then create a client secret. The Sender Email below must be a real mailbox in this tenant.
            </div>
          </div>
        )}

        {/* Google fields */}
        {settings.provider === 'google' && (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(240px, 1fr))', gap: 16, marginBottom: 16 }}>
            <div>
              <label style={S.label}>Client ID</label>
              <input style={S.input} value={settings.googleClientId} onChange={(e) => updateSetting('googleClientId', e.target.value)} placeholder="xxxxxxxxxxxx.apps.googleusercontent.com" />
            </div>
            <div>
              <label style={S.label}>Client Secret</label>
              <input style={S.input} type="password" value={settings.googleClientSecret} onChange={(e) => updateSetting('googleClientSecret', e.target.value)} placeholder={settings.hasGoogleClientSecret ? 'Saved secret retained unless you replace it' : 'OAuth client secret'} />
            </div>
            <div style={{ gridColumn: '1 / -1' }}>
              <label style={S.label}>Refresh Token</label>
              <input style={S.input} type="password" value={settings.googleRefreshToken} onChange={(e) => updateSetting('googleRefreshToken', e.target.value)} placeholder={settings.hasGoogleRefreshToken ? 'Saved token retained unless you replace it' : 'Refresh token issued for the sender mailbox with gmail.send scope'} />
            </div>
            <div style={{ gridColumn: '1 / -1', fontSize: 12, color: '#64748B', lineHeight: 1.6 }}>
              In Google Cloud Console: enable the Gmail API, create an OAuth 2.0 Client (Web), and complete a one-time consent for the sender mailbox with the <strong>https://www.googleapis.com/auth/gmail.send</strong> scope to obtain a refresh token. The Sender Email below must match the mailbox that consented.
            </div>
          </div>
        )}

        {/* Shared identity fields (apply to all providers) */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(240px, 1fr))', gap: 16, marginBottom: 16 }}>
          <div>
            <label style={S.label}>From Name</label>
            <input style={S.input} value={settings.fromName} onChange={(e) => updateSetting('fromName', e.target.value)} placeholder="Your Org HR" />
          </div>
          <div>
            <label style={S.label}>{settings.provider === 'smtp' ? 'From Email Address' : 'Sender Mailbox (From Email)'}</label>
            <input style={S.input} value={settings.fromEmail} onChange={(e) => updateSetting('fromEmail', e.target.value)} placeholder="noreply@yourdomain.com" />
          </div>
          <div style={{ gridColumn: '1 / -1' }}>
            <label style={S.label}>Email Footer Text</label>
            <textarea style={{ ...S.input, minHeight: 88, resize: 'vertical' }} value={settings.footerText} onChange={(e) => updateSetting('footerText', e.target.value)} placeholder="© Your Org HR. All rights reserved." />
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <button type="button" onClick={handleSave} disabled={loadState.loading || saveState.status === 'saving'} style={{ ...S.btnPrimary, opacity: loadState.loading || saveState.status === 'saving' ? 0.7 : 1 }}>
            {saveState.status === 'saving' ? 'Saving…' : 'Save settings'}
          </button>
          {saveState.message && (
            <span style={{ fontSize: 12.5, color: saveState.status === 'failed' ? '#B91C1C' : '#166534' }}>
              {saveState.message}
            </span>
          )}
        </div>
      </div>

      <div style={S.card}>
        <div style={{ fontSize: 18, fontWeight: 700, color: '#0F172A', marginBottom: 4 }}>Test This Configuration</div>
        <div style={{ fontSize: 13, color: '#64748B', marginBottom: 18 }}>Verify the connection or send a one-off test email before relying on the organization sender.</div>

        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(260px, 1fr) auto auto', gap: 12, alignItems: 'end' }}>
          <div>
            <label style={S.label}>Recipient Email</label>
            <input style={S.input} value={testEmail} onChange={(e) => setTestEmail(e.target.value)} placeholder="you@example.com" />
          </div>
          <button type="button" onClick={handleVerify} disabled={verifyState.status === 'verifying'} style={{ ...S.btnSecondary, whiteSpace: 'nowrap', opacity: verifyState.status === 'verifying' ? 0.7 : 1 }}>
            {verifyState.status === 'verifying' ? 'Verifying…' : 'Verify connection'}
          </button>
          <button type="button" onClick={handleSendTest} disabled={testState.status === 'sending'} style={{ ...S.btnPrimary, whiteSpace: 'nowrap', opacity: testState.status === 'sending' ? 0.7 : 1 }}>
            {testState.status === 'sending' ? 'Sending…' : 'Send test email'}
          </button>
        </div>

        {(verifyState.message || testState.message || loadState.loading) && (
          <div style={{ marginTop: 16, display: 'flex', flexDirection: 'column', gap: 8 }}>
            {loadState.loading && <div style={noticeStyle('info')}>Loading SMTP settings…</div>}
            {verifyState.message && <div style={noticeStyle(verifyState.status === 'failed' ? 'bad' : 'good')}>{verifyState.message}</div>}
            {testState.message && <div style={noticeStyle(testState.status === 'failed' ? 'bad' : 'good')}>{testState.message}</div>}
          </div>
        )}
      </div>
    </div>
  );
}

function ModuleHRTeam({ org, orgKey, employees, groups, onOrgChange }) {
  const hrTeam = org?.hrTeam || [];
  const [panel, setPanel] = useState(null); // null | 'co-admin' | 'scoped-hr'
  const [formName, setFormName] = useState('');
  const [formEmail, setFormEmail] = useState('');
  const [formEmpCode, setFormEmpCode] = useState('');
  const [formIsInPMS, setFormIsInPMS] = useState(false);
  const [formEmpSearch, setFormEmpSearch] = useState('');
  const [formScopeType, setFormScopeType] = useState('all');
  const [formScopeGroups, setFormScopeGroups] = useState([]);
  const [formScopeEmps, setFormScopeEmps] = useState([]);
  const [formModules, setFormModules] = useState(OPS_MODULES_LIST.map((m) => m.id));
  const [error, setError] = useState('');
  const [genPass, setGenPass] = useState('');
  const [scopeSearch, setScopeSearch] = useState('');
  const [resetState, setResetState] = useState({ status: 'idle', message: '' });

  const empMatches = useMemo(() => {
    const q = formEmpSearch.trim().toLowerCase();
    if (!q) return [];
    return employees.filter((e) => {
      const code = String(e['Employee Code'] || '').toLowerCase();
      const name = String(e['Employee Name'] || '').toLowerCase();
      return code.includes(q) || name.includes(q);
    }).slice(0, 8);
  }, [employees, formEmpSearch]);

  const scopeEmpMatches = useMemo(() => {
    const q = scopeSearch.trim().toLowerCase();
    if (!q) return [];
    return employees.filter((e) => {
      const code = String(e['Employee Code'] || '').toLowerCase();
      const name = String(e['Employee Name'] || '').toLowerCase();
      return (code.includes(q) || name.includes(q)) && !formScopeEmps.includes(String(e['Employee Code'] || '').trim());
    }).slice(0, 6);
  }, [employees, scopeSearch, formScopeEmps]);

  function resetForm() {
    setFormName(''); setFormEmail(''); setFormEmpCode(''); setFormIsInPMS(false);
    setFormEmpSearch(''); setFormScopeType('all'); setFormScopeGroups([]);
    setFormScopeEmps([]); setFormModules(OPS_MODULES_LIST.map((m) => m.id)); setError(''); setGenPass('');
    setScopeSearch('');
  }

  function openAdd(type) { resetForm(); setGenPass(genTempPassword()); setPanel(type); }

  async function handleSave() {
    setError('');
    if (formIsInPMS && !formEmpCode) { setError('Please select a PMS employee.'); return; }
    if (!formIsInPMS && !formName.trim()) { setError('Name is required.'); return; }
    if (!formIsInPMS && !formEmail.trim()) { setError('Email is required.'); return; }
    const type = panel;
    let name = formName.trim();
    const email = formEmail.trim();
    if (formIsInPMS) {
      const emp = employees.find((e) => String(e['Employee Code'] || '').trim() === formEmpCode);
      name = emp?.['Employee Name'] || formEmpCode;
    }
    if (!formIsInPMS) {
      if (hrTeam.find((m) => m.email === email)) { setError('A team member with this email already exists.'); return; }
      if (email.toLowerCase() === (org.hrAdminEmail || '').toLowerCase()) { setError('This email belongs to the primary HR Admin.'); return; }
    }
    const newMember = {
      id: `hrm_${Date.now()}`,
      type,
      name,
      email: formIsInPMS ? '' : email,
      empCode: formIsInPMS ? formEmpCode : null,
      isInPMS: formIsInPMS,
      ...(type === 'scoped-hr' ? {
        scopeType: formScopeType,
        scopeGroups: formScopeType === 'group' ? formScopeGroups : [],
        scopeEmpCodes: formScopeType === 'manual' ? formScopeEmps : [],
        allowedModules: formModules,
      } : {}),
      password: formIsInPMS ? null : genPass,
      isTemp: !formIsInPMS,
    };
    if (!formIsInPMS) {
      const creds = readEmployeeCredentialsSync();
      creds[email] = {
        passwordHash: await hashPasswordValue(genPass),
        name,
        email,
        designation: type === 'co-admin' ? 'Co-Admin HR' : 'Scoped HR',
        managerCode: '',
        orgKey: orgKey || '',
        isTemp: true,
        isHRTeam: true,
        hrTeamType: type,
      };
      persistEmployeeCredentials(creds);
    }
    onOrgChange({ hrTeam: [...hrTeam, newMember] });
    setPanel(null);
    resetForm();
  }

  function removeMember(id) {
    const m = hrTeam.find((x) => x.id === id);
    if (m && !m.isInPMS && m.email) {
      const creds = readEmployeeCredentialsSync();
      delete creds[m.email];
      persistEmployeeCredentials(creds);
    }
    onOrgChange({ hrTeam: hrTeam.filter((x) => x.id !== id) });
  }

  async function resetMemberPassword(member) {
    if (!member || member.isInPMS) {
      setResetState({ status: 'failed', message: 'Password reset is available only for email-based HR team logins.' });
      return;
    }
    const credentialKey = String(member.email || '').trim();
    if (!credentialKey) {
      setResetState({ status: 'failed', message: 'This HR team member does not have a saved login email.' });
      return;
    }
    setResetState({ status: 'sending', message: `Resetting password for ${member.name || credentialKey}…` });
    const result = await resetUserPasswordByAdmin({
      orgKey,
      credentialKey,
      prefix: member.type === 'co-admin' ? 'CoAdmin' : 'ScopedHR',
    });
    if (!result?.ok) {
      setResetState({ status: 'failed', message: result?.error || 'Failed to reset this password.' });
      return;
    }
    onOrgChange({
      hrTeam: hrTeam.map((entry) => (
        entry.id === member.id
          ? { ...entry, password: result.tempPassword, isTemp: true }
          : entry
      )),
    });
    void logAuditEvent({
      orgKey,
      actorRole: 'hr-admin',
      actorName: org?.hrAdminName || 'HR Admin',
      actionType: 'hr-team-password-reset',
      targetType: member.type || 'hr-team',
      targetCode: String(member.email || member.id || '').trim(),
      details: {
        memberName: member.name || '',
      },
    });
    try { await navigator.clipboard?.writeText(result.tempPassword || ''); } catch (_) {}
    setResetState({
      status: 'sent',
      message: `Temporary password reset for ${member.name || credentialKey}. The new password was copied to your clipboard.`,
    });
  }

  const S = {
    label: { fontSize: 11.5, fontWeight: 700, color: '#64748B', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 6, display: 'block' },
    input: { width: '100%', padding: '7px 10px', border: '1.5px solid #E2E8F0', borderRadius: 8, fontSize: 13, fontFamily: 'inherit', outline: 'none', boxSizing: 'border-box' },
    btnPrimary: { padding: '8px 18px', background: '#4F46E5', color: '#fff', border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' },
    btnSecondary: { padding: '8px 16px', background: '#F1F5F9', color: '#374151', border: '1.5px solid #E2E8F0', borderRadius: 8, fontSize: 13, fontWeight: 500, cursor: 'pointer', fontFamily: 'inherit' },
  };

  function MemberCard({ m }) {
    const [showPass, setShowPass] = useState(false);
    const [copied, setCopied] = useState(false);
    const livePass = useMemo(() => {
      if (m.isInPMS || !m.email) return null;
      return readEmployeeCredentialsSync()?.[m.email]?.password || m.password;
    }, [m]);
    function copy() { navigator.clipboard?.writeText(livePass || '').catch(() => {}); setCopied(true); setTimeout(() => setCopied(false), 1500); }
    return (
      <div style={{ background: '#fff', border: '1.5px solid #E9EDF2', borderRadius: 10, padding: '14px 16px', display: 'flex', alignItems: 'flex-start', gap: 12 }}>
        <div style={{ width: 36, height: 36, borderRadius: '50%', background: m.type === 'co-admin' ? '#EEF2FF' : '#FEF9C3', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 16, flexShrink: 0 }}>{m.type === 'co-admin' ? '🛡' : '🔒'}</div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 2, flexWrap: 'wrap' }}>
            <span style={{ fontWeight: 600, fontSize: 13.5, color: '#0F172A' }}>{m.name}</span>
            {m.type === 'co-admin'
              ? <span style={{ fontSize: 10.5, fontWeight: 700, background: '#EEF2FF', color: '#4338CA', borderRadius: 6, padding: '2px 7px' }}>Co-Admin</span>
              : <span style={{ fontSize: 10.5, fontWeight: 700, background: '#FEF9C3', color: '#92400E', borderRadius: 6, padding: '2px 7px' }}>Scoped HR</span>}
            {m.isInPMS && <span style={{ fontSize: 10.5, fontWeight: 600, background: '#F0FDF4', color: '#15803D', borderRadius: 6, padding: '2px 7px' }}>PMS Employee</span>}
          </div>
          <div style={{ fontSize: 12, color: '#64748B' }}>{m.isInPMS ? `Employee Code: ${m.empCode}` : m.email}</div>
          {m.type === 'scoped-hr' && (
            <div style={{ fontSize: 11.5, color: '#94A3B8', marginTop: 3 }}>
              Scope: {m.scopeType === 'all' ? 'All employees' : m.scopeType === 'group' ? (m.scopeGroups?.join(', ') || 'No groups') : `${m.scopeEmpCodes?.length || 0} employees`}
              {' · '}{m.allowedModules?.length || 0} modules
            </div>
          )}
          {!m.isInPMS && livePass && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 6 }}>
              <span style={{ fontSize: 11.5, color: '#64748B' }}>Temp pass:</span>
              <span style={{ fontSize: 12, fontFamily: 'monospace', color: '#374151', background: '#F8FAFC', border: '1px solid #E2E8F0', borderRadius: 5, padding: '1px 7px' }}>{showPass ? livePass : '••••••••'}</span>
              <button type="button" onClick={() => setShowPass((p) => !p)} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 13, padding: 0, color: '#94A3B8' }}>{showPass ? '🙈' : '👁'}</button>
              <button type="button" onClick={copy} style={{ border: 'none', cursor: 'pointer', fontSize: 11, padding: '1px 6px', color: copied ? '#16A34A' : '#64748B', background: copied ? '#F0FDF4' : '#F1F5F9', borderRadius: 5 }}>{copied ? '✓' : 'Copy'}</button>
            </div>
          )}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'flex-end', flexShrink: 0 }}>
          {!m.isInPMS && (
            <button
              type="button"
              onClick={() => resetMemberPassword(m)}
              style={{ background: '#EEF2FF', border: '1.5px solid #C7D2FE', borderRadius: 7, padding: '4px 10px', fontSize: 11.5, color: '#4338CA', cursor: 'pointer', fontFamily: 'inherit' }}
            >
              Reset password
            </button>
          )}
          <button type="button" onClick={() => removeMember(m.id)} style={{ background: 'none', border: '1.5px solid #FCA5A5', borderRadius: 7, padding: '4px 10px', fontSize: 11.5, color: '#DC2626', cursor: 'pointer', fontFamily: 'inherit' }}>Remove</button>
        </div>
      </div>
    );
  }

  const coadmins = hrTeam.filter((m) => m.type === 'co-admin');
  const scopedHRs = hrTeam.filter((m) => m.type === 'scoped-hr');

  return (
    <div style={{ maxWidth: 760 }}>
      <div style={{ marginBottom: 24 }}>
        <h2 style={{ fontSize: 20, fontWeight: 700, color: '#0F172A', margin: 0 }}>HR Team</h2>
        <p style={{ fontSize: 13, color: '#64748B', margin: '4px 0 0' }}>Assign co-admins and scoped HR members for this organization.</p>
      </div>

      {resetState.message && (
        <div style={{
          marginBottom: 16,
          padding: '11px 14px',
          borderRadius: 10,
          border: `1px solid ${resetState.status === 'failed' ? '#FECACA' : resetState.status === 'sent' ? '#BBF7D0' : '#C7D2FE'}`,
          background: resetState.status === 'failed' ? '#FEF2F2' : resetState.status === 'sent' ? '#F0FDF4' : '#EEF2FF',
          color: resetState.status === 'failed' ? '#991B1B' : resetState.status === 'sent' ? '#166534' : '#3730A3',
          fontSize: 12.5,
          fontWeight: 600,
        }}>
          {resetState.message}
        </div>
      )}

      {/* Primary HR Admin */}
      <div style={{ background: '#F0FDF4', border: '1.5px solid #BBF7D0', borderRadius: 10, padding: '12px 16px', marginBottom: 24, display: 'flex', alignItems: 'center', gap: 12 }}>
        <div style={{ width: 36, height: 36, borderRadius: '50%', background: '#DCFCE7', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 16, flexShrink: 0 }}>👑</div>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontWeight: 600, fontSize: 13.5, color: '#15803D' }}>{org.hrAdminName}</span>
            <span style={{ fontSize: 10.5, fontWeight: 700, background: '#DCFCE7', color: '#15803D', borderRadius: 6, padding: '2px 7px' }}>Primary HR Admin</span>
          </div>
          <div style={{ fontSize: 12, color: '#16A34A' }}>{org.hrAdminEmail}</div>
        </div>
      </div>

      {/* Co-Admins */}
      <div style={{ marginBottom: 24 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
          <div>
            <div style={{ fontWeight: 700, fontSize: 14, color: '#0F172A' }}>Co-Admins</div>
            <div style={{ fontSize: 12, color: '#64748B', marginTop: 1 }}>Full HR access, including HR team management.</div>
          </div>
          <button type="button" onClick={() => openAdd('co-admin')} style={S.btnPrimary}>+ Add Co-Admin</button>
        </div>
        {coadmins.length === 0
          ? <div style={{ border: '1.5px dashed #E2E8F0', borderRadius: 10, padding: 20, textAlign: 'center', color: '#94A3B8', fontSize: 13 }}>No co-admins assigned yet.</div>
          : <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>{coadmins.map((m) => <MemberCard key={m.id} m={m} />)}</div>}
      </div>

      {/* Scoped HR */}
      <div style={{ marginBottom: 24 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
          <div>
            <div style={{ fontWeight: 700, fontSize: 14, color: '#0F172A' }}>Scoped HR</div>
            <div style={{ fontSize: 12, color: '#64748B', marginTop: 1 }}>Partial access, scoped to a subset of employees and modules.</div>
          </div>
          <button type="button" onClick={() => openAdd('scoped-hr')} style={S.btnPrimary}>+ Add Scoped HR</button>
        </div>
        {scopedHRs.length === 0
          ? <div style={{ border: '1.5px dashed #E2E8F0', borderRadius: 10, padding: 20, textAlign: 'center', color: '#94A3B8', fontSize: 13 }}>No scoped HR members assigned yet.</div>
          : <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>{scopedHRs.map((m) => <MemberCard key={m.id} m={m} />)}</div>}
      </div>

      {/* ADD PANEL MODAL */}
      {panel && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 200, background: 'rgba(15,23,42,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}
          onClick={(e) => { if (e.target === e.currentTarget) { setPanel(null); resetForm(); } }}>
          <div style={{ background: '#fff', borderRadius: 14, width: '100%', maxWidth: 500, maxHeight: '90vh', overflowY: 'auto', padding: '28px 28px 24px', boxShadow: '0 20px 60px rgba(15,23,42,0.16)' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
              <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: '#0F172A' }}>{panel === 'co-admin' ? 'Add Co-Admin' : 'Add Scoped HR'}</h3>
              <button type="button" onClick={() => { setPanel(null); resetForm(); }} style={{ background: 'none', border: 'none', fontSize: 18, cursor: 'pointer', color: '#94A3B8', padding: '2px 6px' }}>✕</button>
            </div>

            <div style={{ marginBottom: 18 }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer', padding: '10px 14px', background: '#F8FAFC', border: '1.5px solid #E2E8F0', borderRadius: 8 }}>
                <input type="checkbox" checked={formIsInPMS} onChange={(e) => { setFormIsInPMS(e.target.checked); setFormEmpCode(''); setFormEmpSearch(''); }} style={{ width: 15, height: 15, accentColor: '#4F46E5' }} />
                <div>
                  <div style={{ fontSize: 13, fontWeight: 600, color: '#0F172A' }}>Also a PMS Employee</div>
                  <div style={{ fontSize: 11.5, color: '#64748B' }}>Link to an existing employee for dual-role access</div>
                </div>
              </label>
            </div>

            {formIsInPMS ? (
              <div style={{ marginBottom: 18 }}>
                <label style={S.label}>Select Employee</label>
                <input style={S.input} placeholder="Search by name or code…" value={formEmpSearch} onChange={(e) => setFormEmpSearch(e.target.value)} />
                {empMatches.length > 0 && (
                  <div style={{ border: '1.5px solid #E2E8F0', borderRadius: 8, marginTop: 4, overflow: 'hidden' }}>
                    {empMatches.map((e) => {
                      const code = String(e['Employee Code'] || '').trim();
                      const sel = formEmpCode === code;
                      return (
                        <button key={code} type="button" onClick={() => { setFormEmpCode(code); setFormEmpSearch(e['Employee Name'] || code); }}
                          style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', background: sel ? '#EEF2FF' : '#fff', border: 'none', borderBottom: '1px solid #F1F5F9', cursor: 'pointer', fontFamily: 'inherit', textAlign: 'left' }}>
                          <span style={{ fontSize: 12.5, color: '#0F172A', fontWeight: sel ? 600 : 400 }}>{e['Employee Name']}</span>
                          <span style={{ fontSize: 11.5, color: '#94A3B8', marginLeft: 'auto' }}>{code}</span>
                        </button>
                      );
                    })}
                  </div>
                )}
                {formEmpCode && <div style={{ marginTop: 6, fontSize: 12, color: '#16A34A', fontWeight: 500 }}>✓ Selected: {employees.find((e) => String(e['Employee Code'] || '').trim() === formEmpCode)?.['Employee Name'] || formEmpCode}</div>}
              </div>
            ) : (
              <>
                <div style={{ marginBottom: 14 }}>
                  <label style={S.label}>Full Name</label>
                  <input style={S.input} placeholder="e.g. Ramesh Kumar" value={formName} onChange={(e) => setFormName(e.target.value)} />
                </div>
                <div style={{ marginBottom: 14 }}>
                  <label style={S.label}>Email Address</label>
                  <input style={S.input} type="email" placeholder="e.g. ramesh@company.com" value={formEmail} onChange={(e) => setFormEmail(e.target.value)} />
                </div>
                <div style={{ background: '#FFFBEB', border: '1.5px solid #FDE68A', borderRadius: 8, padding: '10px 14px', marginBottom: 18, display: 'flex', alignItems: 'center', gap: 10 }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 11.5, color: '#92400E', fontWeight: 600 }}>Temporary Password</div>
                    <div style={{ fontSize: 13, fontFamily: 'monospace', color: '#0F172A', fontWeight: 700 }}>{genPass}</div>
                  </div>
                  <button type="button" onClick={() => navigator.clipboard?.writeText(genPass).catch(() => {})} style={{ ...S.btnSecondary, fontSize: 11.5, padding: '5px 10px' }}>Copy</button>
                </div>
              </>
            )}

            {panel === 'scoped-hr' && (
              <>
                <div style={{ marginBottom: 18 }}>
                  <label style={S.label}>Allowed Modules</label>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                    {OPS_MODULES_LIST.map((m) => {
                      const on = formModules.includes(m.id);
                      return (
                        <button key={m.id} type="button" onClick={() => setFormModules((prev) => on ? prev.filter((x) => x !== m.id) : [...prev, m.id])}
                          style={{ padding: '4px 10px', borderRadius: 20, border: `1.5px solid ${on ? '#4F46E5' : '#E2E8F0'}`, background: on ? '#EEF2FF' : '#fff', color: on ? '#4338CA' : '#64748B', fontSize: 12, fontWeight: on ? 600 : 400, cursor: 'pointer', fontFamily: 'inherit' }}>
                          {m.label}
                        </button>
                      );
                    })}
                  </div>
                </div>
                <div style={{ marginBottom: 18 }}>
                  <label style={S.label}>Employee Scope</label>
                  <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
                    {[['all', 'All Employees'], ['group', 'By Group'], ['manual', 'Manual Select']].map(([v, l]) => (
                      <button key={v} type="button" onClick={() => setFormScopeType(v)}
                        style={{ padding: '5px 12px', borderRadius: 7, border: `1.5px solid ${formScopeType === v ? '#4F46E5' : '#E2E8F0'}`, background: formScopeType === v ? '#EEF2FF' : '#fff', color: formScopeType === v ? '#4338CA' : '#64748B', fontSize: 12, fontWeight: formScopeType === v ? 600 : 400, cursor: 'pointer', fontFamily: 'inherit' }}>
                        {l}
                      </button>
                    ))}
                  </div>
                  {formScopeType === 'group' && (
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                      {groups.length === 0
                        ? <span style={{ fontSize: 12, color: '#94A3B8' }}>No groups configured.</span>
                        : groups.map((g) => {
                            const on = formScopeGroups.includes(g.name);
                            return (
                              <button key={g.name} type="button" onClick={() => setFormScopeGroups((prev) => on ? prev.filter((x) => x !== g.name) : [...prev, g.name])}
                                style={{ padding: '4px 10px', borderRadius: 20, border: `1.5px solid ${on ? '#4F46E5' : '#E2E8F0'}`, background: on ? '#EEF2FF' : '#fff', color: on ? '#4338CA' : '#64748B', fontSize: 12, cursor: 'pointer', fontFamily: 'inherit' }}>
                                {g.name}
                              </button>
                            );
                          })}
                    </div>
                  )}
                  {formScopeType === 'manual' && (
                    <div>
                      <input style={S.input} placeholder="Search employees…" value={scopeSearch} onChange={(e) => setScopeSearch(e.target.value)} />
                      {scopeEmpMatches.length > 0 && (
                        <div style={{ border: '1.5px solid #E2E8F0', borderRadius: 8, marginTop: 4, overflow: 'hidden' }}>
                          {scopeEmpMatches.map((e) => {
                            const code = String(e['Employee Code'] || '').trim();
                            return (
                              <button key={code} type="button" onClick={() => { setFormScopeEmps((prev) => [...prev, code]); setScopeSearch(''); }}
                                style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 10, padding: '7px 12px', background: '#fff', border: 'none', borderBottom: '1px solid #F1F5F9', cursor: 'pointer', fontFamily: 'inherit', textAlign: 'left' }}>
                                <span style={{ fontSize: 12.5, color: '#0F172A' }}>{e['Employee Name']}</span>
                                <span style={{ fontSize: 11.5, color: '#94A3B8', marginLeft: 'auto' }}>{code}</span>
                              </button>
                            );
                          })}
                        </div>
                      )}
                      {formScopeEmps.length > 0 && (
                        <div style={{ marginTop: 8, display: 'flex', flexWrap: 'wrap', gap: 5 }}>
                          {formScopeEmps.map((code) => {
                            const emp = employees.find((e) => String(e['Employee Code'] || '').trim() === code);
                            return (
                              <span key={code} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, background: '#EEF2FF', border: '1px solid #C7D2FE', borderRadius: 20, padding: '2px 8px 2px 10px', fontSize: 12, color: '#3730A3' }}>
                                {emp?.['Employee Name'] || code}
                                <button type="button" onClick={() => setFormScopeEmps((prev) => prev.filter((c) => c !== code))} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 14, color: '#818CF8', padding: 0, lineHeight: 1 }}>×</button>
                              </span>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </>
            )}

            {error && <div style={{ background: '#FEF2F2', border: '1px solid #FCA5A5', borderRadius: 7, padding: '8px 12px', fontSize: 12.5, color: '#DC2626', marginBottom: 14 }}>{error}</div>}
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button type="button" onClick={() => { setPanel(null); resetForm(); }} style={S.btnSecondary}>Cancel</button>
              <button type="button" onClick={handleSave} style={S.btnPrimary}>Add Member</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════
   MAIN COMPONENT
══════════════════════════════════════════════════════════════ */
export default function HRCycleDashboard() {
  const { orgKey, orgs, setOrgs, logout, isCoAdmin, isScopedHR, allowedModules: sessionAllowedModules, empCode: sessionEmpCode, hrTeamId, userName } = useApp();
  const org = orgs.find((o) => o.key === orgKey) || {};
  const hrTeamMember = useMemo(() => (org?.hrTeam || []).find((m) => m.id === hrTeamId) || null, [org, hrTeamId]);

  const [config, setConfig] = useState(() => loadWizardConfig(orgKey));
  const groups  = useMemo(() => config?.goalGroups || [], [config]);

  useEffect(() => {
    let cancelled = false;
    if (!orgKey) return undefined;
    hydrateWizardState(orgKey).then((state) => {
      if (cancelled) return;
      setConfig(state?.config || null);
    });
    return () => {
      cancelled = true;
    };
  }, [orgKey]);

  const [liveEmployees, setLiveEmployees] = useState(() =>
    Array.isArray(config?.employeeUploadData?.employees) ? config.employeeUploadData.employees : []
  );
  useEffect(() => {
    setLiveEmployees(Array.isArray(config?.employeeUploadData?.employees) ? config.employeeUploadData.employees : []);
  }, [config]);

  // Ensure every employee in this org has a credential entry so they can log in via LoginPage.
  // Runs whenever the employee list or org changes. Skips employees that already have credentials
  // (preserves any permanent passwords they've already set).
  useEffect(() => {
    let cancelled = false;
    const tempPass = org?.temporaryPassword;
    if (!tempPass || !liveEmployees.length) return undefined;

    (async () => {
      const existing = readEmployeeCredentialsSync();
      let changed = false;
      for (const emp of liveEmployees) {
        const code = String(emp['Employee Code'] || '').trim();
        const email = String(resolveEmployeeEmail(emp) || '').trim().toLowerCase();
        if (code && !existing[code]) {
          existing[code] = {
            passwordHash: await hashPasswordValue(tempPass),
            name: emp['Employee Name'] || '',
            email,
            empCode: code,
            designation: emp.Designation || emp.Role || '',
            managerCode: emp['Reporting Manager Code'] || '',
            orgKey: orgKey || '',
            isTemp: true,
          };
          changed = true;
        } else if (code && email && existing[code] && existing[code].email !== email) {
          existing[code] = { ...existing[code], email };
          changed = true;
        }
      }
      if (!cancelled && changed) persistEmployeeCredentials(existing);
    })();

    return () => {
      cancelled = true;
    };
  }, [liveEmployees, org?.temporaryPassword, orgKey]);

  function handleEmpUpdate(updated) {
    setLiveEmployees(updated);
    if (config) {
      const nextConfig = { ...config, employeeUploadData: { ...config.employeeUploadData, employees: updated } };
      setConfig(nextConfig);
      saveWizardConfig(orgKey, nextConfig);
    }
  }

  function handleConfigPatch(patch) {
    if (!config) return;
    const nextConfig = { ...config, ...patch };
    setConfig(nextConfig);
    saveWizardConfig(orgKey, nextConfig);
  }

  // ── Truth-source bridge ────────────────────────────────────────────────────
  // Admin dashboards read `emp._pmsStage` to compute counts / filters. Employees submitting
  // goals writes to the goal-workflow (submissions[code].status), NOT to the employee record.
  // Overlay submission.status onto each employee so Overview, Stage Control, Emp Status, etc.
  // all reflect what employees actually did, in real time.
  const [submissionStatuses, setSubmissionStatuses] = useState(() => {
    const wf = loadWorkflowState(orgKey);
    const m = {};
    Object.entries(wf.submissions || {}).forEach(([k, s]) => { if (s?.status) m[k] = s.status; });
    return m;
  });
  useEffect(() => {
    if (!orgKey) return undefined;
    function reread() {
      const wf = loadWorkflowState(orgKey);
      const m = {};
      Object.entries(wf.submissions || {}).forEach(([k, s]) => { if (s?.status) m[k] = s.status; });
      setSubmissionStatuses(m);
    }
    reread();
    void hydrateWorkflow(orgKey).then((wf) => {
      const m = {};
      Object.entries(wf?.submissions || {}).forEach(([k, s]) => { if (s?.status) m[k] = s.status; });
      setSubmissionStatuses(m);
    });
    const wfKey = workflowStorageKey(orgKey);
    function onStorage(e) { if (e.key === wfKey) reread(); }
    window.addEventListener('storage', onStorage);
    // Also reread on focus / visibility change — catches submits made in another tab the
    // storage event might miss if the origin is identical but listener timing differs.
    window.addEventListener('focus', reread);
    document.addEventListener('visibilitychange', reread);
    const t = setInterval(reread, 4000); // low-frequency catch-all
    return () => {
      window.removeEventListener('storage', onStorage);
      window.removeEventListener('focus', reread);
      document.removeEventListener('visibilitychange', reread);
      clearInterval(t);
    };
  }, [orgKey]);

  // Map submission.status → PMS stage id. Kept in sync with EmployeePage's submit flow.
  function statusToStage(status) {
    if (status === 'pending-manager') return 'pending-approval';
    if (status === 'approved') return 'self-evaluation';
    if (status === 'sent-back') return 'goal-creation';
    return 'goal-creation'; // draft / missing
  }

  // The list everyone downstream consumes: base record + live stage derived from workflow.
  const liveEmployeesWithStage = useMemo(() => liveEmployees.map((e) => {
    const key = normalizeCodeStr(e['Employee Code']);
    const wfStatus = submissionStatuses[key];
    // If workflow has a status, it wins. Otherwise keep whatever HR set via Stage Control.
    const derived = wfStatus ? statusToStage(wfStatus) : (e._pmsStage || 'goal-creation');
    return derived === e._pmsStage ? e : { ...e, _pmsStage: derived };
  }), [liveEmployees, submissionStatuses]);

  /* congrats */
  const congratsKey = `zarohr_congrats_shown_${orgKey}`;
  const [showConfetti, setShowConfetti]       = useState(() => !localStorage.getItem(congratsKey));
  const [congratsDismissed, setCongratsDismissed] = useState(false);
  useEffect(() => {
    if (showConfetti) { const t = setTimeout(() => setShowConfetti(false), 3000); localStorage.setItem(congratsKey, '1'); return () => clearTimeout(t); }
  }, [showConfetti, congratsKey]);

  /* active module — persisted per-org so refresh lands you where you were. */
  const activeModuleKey = `zarohr_admin_active_module:${orgKey || 'default'}`;
  const [activeModule, setActiveModuleInner] = useState(() => {
    try { return localStorage.getItem(activeModuleKey) || 'overview'; } catch { return 'overview'; }
  });
  const setActiveModule = (next) => {
    setActiveModuleInner(next);
    try { localStorage.setItem(activeModuleKey, next); } catch { /* ignore */ }
  };
  const [showOverview, setShowOverview] = useState(false);
  const [showOrgChart, setShowOrgChart] = useState(false);
  const workspace = useMemo(() => ({ orgKey, orgName: org.name || 'Organization' }), [orgKey, org.name]);

  function goBackToSetup() { setOrgs(orgs.map((o) => (o.key === orgKey ? { ...o, launched: false } : o))); }

  function updateOrgBrand(patch) {
    const nextOrgs = orgs.map((o) => (o.key === orgKey ? { ...o, ...patch } : o));
    setOrgs(nextOrgs);
    return true;
  }

  // Scoped HR: only show modules they're allowed; hide config + hr-team always.
  // Co-admins: full access (including hr-team management).
  const visibleNavModules = useMemo(() => {
    if (isScopedHR) {
      const allowed = new Set(sessionAllowedModules || []);
      return NAV_MODULES.filter((m) => allowed.has(m.id));
    }
    return NAV_MODULES;
  }, [isScopedHR, sessionAllowedModules]);

  const NAV_GROUPS = [
    { label: 'Main',       items: visibleNavModules.filter((m) => m.group === 'main') },
    { label: 'Operations', items: visibleNavModules.filter((m) => m.group === 'ops') },
    { label: 'Dev',        items: visibleNavModules.filter((m) => m.group === 'dev') },
  ].filter((g) => g.items.length > 0);

  // Scoped HR: filter employees down to their assigned scope.
  const scopedEmployees = useMemo(() => {
    if (!isScopedHR || !hrTeamMember) return liveEmployeesWithStage;
    const { scopeType, scopeGroups = [], scopeEmpCodes = [] } = hrTeamMember;
    if (scopeType === 'all') return liveEmployeesWithStage;
    if (scopeType === 'group') {
      const groupSet = new Set(scopeGroups);
      return liveEmployeesWithStage.filter((e) => groupSet.has(e.Group || e['Goal Group'] || e.Department || ''));
    }
    if (scopeType === 'manual') {
      const codeSet = new Set(scopeEmpCodes.map((c) => String(c).trim()));
      return liveEmployeesWithStage.filter((e) => codeSet.has(String(e['Employee Code'] || '').trim()));
    }
    return liveEmployeesWithStage;
  }, [isScopedHR, hrTeamMember, liveEmployeesWithStage]);

  const empsForModules = isScopedHR ? scopedEmployees : liveEmployeesWithStage;

  // If active module is no longer visible (e.g. scoped HR), reset to first allowed.
  useEffect(() => {
    if (!visibleNavModules.find((m) => m.id === activeModule)) {
      const first = visibleNavModules[0]?.id || 'overview';
      setActiveModule(first);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleNavModules]);

  // Dual-role switcher: if this HR is also a PMS employee, allow switching to employee view.
  const canSwitchRoles = !!sessionEmpCode && (isCoAdmin || isScopedHR);
  function switchToEmployeeView() {
    const emp = liveEmployees.find((e) => String(e['Employee Code'] || '').trim() === String(sessionEmpCode).trim());
    persistEmployeeSession({
      empCode: sessionEmpCode,
      name: emp?.['Employee Name'] || userName,
      designation: emp?.Designation || '',
      managerCode: emp?.['Reporting Manager Code'] || '',
      orgKey: orgKey || '',
      _dualRoleFromHR: true,
    });
    window.location.hash = '#employee';
  }

  function onHRTeamChange(patch) { updateOrgBrand(patch); }
  return (
    <div style={{ height: '100vh', overflow: 'hidden', background: '#F5F7FA', fontFamily: "'Geist','Inter','Segoe UI',Arial,sans-serif", fontSize: 14, color: '#0D1117', display: 'flex', flexDirection: 'column' }}>

      {showOverview && config && <LaunchOverview config={config} workspace={workspace} onClose={() => setShowOverview(false)} />}

      {/* ── ORGANOGRAM MODAL ───────────────────────────── */}
      {showOrgChart && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 200, background: 'rgba(15,23,42,0.55)', display: 'flex', alignItems: 'stretch', justifyContent: 'flex-end' }}
          onClick={(e) => { if (e.target === e.currentTarget) setShowOrgChart(false); }}>
          <div style={{ width: 'min(820px, 92vw)', background: '#F8FAFC', display: 'flex', flexDirection: 'column', boxShadow: '-8px 0 40px rgba(0,0,0,.18)', animation: 'slideInRight 200ms ease' }}>
            <style>{`@keyframes slideInRight{from{transform:translateX(40px);opacity:0}to{transform:translateX(0);opacity:1}}`}</style>
            {/* modal header */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 20px', background: '#fff', borderBottom: '1px solid #E9EDF2', flexShrink: 0 }}>
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <OrganogramIcon size={20} color="#0F172A" />
                  <span style={{ fontSize: 15, fontWeight: 700, color: '#0F172A' }}>Organogram</span>
                </div>
                <div style={{ fontSize: 12, color: '#94A3B8', marginTop: 2 }}>{org.name} · {liveEmployees.length} employees</div>
              </div>
              <button type="button" onClick={() => setShowOrgChart(false)}
                style={{ padding: '6px 12px', border: '1.5px solid #E2E8F0', borderRadius: 7, fontSize: 12, cursor: 'pointer', background: '#fff', color: '#6B7280', fontFamily: 'inherit' }}>
                ✕ Close
              </button>
            </div>
            {/* modal body */}
            <div style={{ flex: 1, overflowY: 'auto', padding: '20px 20px 32px' }}>
              <OrgChartPanel employees={liveEmployeesWithStage} groups={groups} />
            </div>
          </div>
        </div>
      )}

      {/* ── TOP BAR ────────────────────────────────────── */}
      <div style={{ background: '#fff', borderBottom: '1px solid #E9EDF2', padding: '0 20px', display: 'grid', gridTemplateColumns: '1fr auto 1fr', alignItems: 'center', height: 52, position: 'sticky', top: 0, zIndex: 100, gap: 12, flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          {org.brandLogo ? (
            // Custom brand logo — keep aspect ratio, don't crop, no wordmark beside it (the logo
            // IS the brand, and the org name is already rendered in the center of the top bar).
            <img src={org.brandLogo} alt={org.brandName || org.name || 'Brand logo'} style={{ height: 30, maxWidth: 140, width: 'auto', borderRadius: 6, objectFit: 'contain', display: 'block' }} />
          ) : (
            <>
              <img src={zaroLogo} alt="Zaro HR" style={{ width: 26, height: 26, borderRadius: 6, objectFit: 'cover' }} />
              <span style={{ fontSize: 14, fontWeight: 800, color: '#0D1117' }}>Zaro <span style={{ color: '#FFBF00' }}>HR</span></span>
            </>
          )}
        </div>
        <div style={{ fontSize: 18, fontWeight: 700, color: '#374151', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 420, textAlign: 'center' }}>
          {org.name}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, justifySelf: 'end' }}>
          {(isCoAdmin || isScopedHR) && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '3px 10px', background: isCoAdmin ? '#EEF2FF' : '#FEF9C3', border: `1px solid ${isCoAdmin ? '#C7D2FE' : '#FDE68A'}`, borderRadius: 20 }}>
              <span style={{ fontSize: 11, fontWeight: 700, color: isCoAdmin ? '#4338CA' : '#92400E' }}>{isCoAdmin ? '🛡 Co-Admin' : '🔒 Scoped HR'}</span>
            </div>
          )}
          {canSwitchRoles && (
            <button type="button" onClick={switchToEmployeeView}
              style={{ padding: '6px 12px', background: '#fff', border: '1.5px solid #E2E8F0', borderRadius: 8, fontSize: 12, fontWeight: 600, color: '#4338CA', cursor: 'pointer', fontFamily: 'inherit', display: 'inline-flex', alignItems: 'center', gap: 6 }}
              title="Switch to your employee view">
              <span>👤</span> My Employee View
            </button>
          )}
          <div style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '3px 10px', background: '#F0FDF4', border: '1px solid #BBF7D0', borderRadius: 20 }}>
            <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#22C55E', display: 'inline-block' }} />
            <span style={{ fontSize: 11.5, fontWeight: 600, color: '#16A34A' }}>Live</span>
          </div>
          <button
            onClick={() => setShowOrgChart(true)}
            aria-label="Open organogram"
            title="Open organogram"
            style={{ width: 46, height: 40, padding: 0, border: 'none', borderRadius: 0, cursor: 'pointer', background: 'transparent', fontFamily: 'inherit', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', lineHeight: 0 }}
          >
            <OrganogramIcon size={31} color="#0F172A" />
          </button>
        </div>
      </div>

      {/* ── BODY ───────────────────────────────────────── */}
      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>

        {/* LEFT SIDEBAR */}
        <div style={{ width: 224, flexShrink: 0, background: '#fff', borderRight: '1px solid #E9EDF2', display: 'flex', flexDirection: 'column', overflowY: 'auto' }}>

          {/* nav */}
          <nav style={{ flex: 1, padding: '12px 8px 0' }}>
            {NAV_GROUPS.map((grp) => (
              <div key={grp.label} style={{ marginBottom: 4 }}>
                <div style={{ fontSize: 10, fontWeight: 700, color: '#94A3B8', textTransform: 'uppercase', letterSpacing: '0.08em', padding: '6px 8px 4px' }}>{grp.label}</div>
                {grp.items.map((item) => {
                  const isActive = activeModule === item.id;
                  return (
                    <button key={item.id} type="button" onClick={() => setActiveModule(item.id)}
                      style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 9, padding: '7px 10px', borderRadius: 8, border: 'none', background: isActive ? '#EEF2FF' : 'transparent', color: isActive ? '#3730A3' : '#374151', cursor: 'pointer', fontFamily: 'inherit', fontSize: 12.5, fontWeight: isActive ? 600 : 400, textAlign: 'left', marginBottom: 1 }}>
                      <span style={{ fontSize: 14, lineHeight: 1 }}>{item.icon}</span>
                      {item.label}
                      {isActive && <span style={{ marginLeft: 'auto', width: 4, height: 4, borderRadius: '50%', background: '#4F46E5', flexShrink: 0 }} />}
                    </button>
                  );
                })}
              </div>
            ))}
          </nav>

          {/* bottom actions */}
          <div style={{ padding: '10px 8px 14px', borderTop: '1px solid #F1F5F9', marginTop: 4 }}>
            <button
              type="button"
              onClick={logout}
              style={{ width: '100%', padding: '7px 10px', background: '#fff', border: '1px solid #E2E8F0', borderRadius: 8, fontSize: 12, color: '#6B7280', cursor: 'pointer', fontFamily: 'inherit', textAlign: 'left', marginBottom: 8 }}
            >
              ↩ Sign out
            </button>
            {!isCoAdmin && !isScopedHR && (
              <button type="button" onClick={goBackToSetup}
                style={{ width: '100%', padding: '7px 10px', background: 'none', border: '1px solid #E2E8F0', borderRadius: 8, fontSize: 12, color: '#64748B', cursor: 'pointer', fontFamily: 'inherit', textAlign: 'left' }}>
                ← Edit Setup
              </button>
            )}
          </div>
        </div>

        {/* MAIN CONTENT */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '24px 28px' }}>

          {/* module content */}
          {activeModule === 'overview' && (
            <ModuleOverview employees={empsForModules} groups={groups} orgName={org.name} congratsDismissed={congratsDismissed} onDismiss={() => setCongratsDismissed(true)} showConfetti={showConfetti} />
          )}
          {activeModule === 'emp-status' && <ModuleEmpStatus employees={empsForModules} groups={groups} orgKey={orgKey} org={org} />}
          {activeModule === 'comms'      && <ModuleComms     employees={empsForModules} groups={groups} org={org} config={config} onUpdate={handleEmpUpdate} onConfigPatch={handleConfigPatch} orgKey={orgKey} />}
          {activeModule === 'stage'      && <ModuleStageControl  employees={empsForModules} onUpdate={handleEmpUpdate} orgKey={orgKey} />}
          {activeModule === 'mgr-change' && <ModuleMgrChange     employees={empsForModules} config={config} onUpdate={handleEmpUpdate} />}
          {activeModule === 'grp-transfer' && <ModuleGrpTransfer employees={empsForModules} groups={groups} onUpdate={handleEmpUpdate} />}
          {activeModule === 'roster'     && <ModuleRoster employees={empsForModules} config={config} onUpdate={handleEmpUpdate} />}
          {activeModule === 'test-creds' && <ModuleTestCreds employees={empsForModules} org={org} orgKey={orgKey} />}
          {activeModule === 'hr-team' && !isScopedHR && (
            <ModuleHRTeam org={org} orgKey={orgKey} employees={liveEmployeesWithStage} groups={groups} onOrgChange={onHRTeamChange} />
          )}
          {activeModule === 'email-settings' && !isScopedHR && (
            <ModuleEmailSettings org={org} orgKey={orgKey} />
          )}
          {activeModule === 'config' && !isScopedHR && (
            <ModuleConfig
              config={config}
              org={org}
              onEditSetup={goBackToSetup}
              onBrandChange={updateOrgBrand}
            />
          )}

        </div>
      </div>
    </div>
  );
}
