import { useMemo } from 'react';
import {
  defaultWindowsForFiscalYear,
  validateCycleWindows,
  reviewCycleWindows,
} from '../backend/cyclePhase';

// Compact two-calendar editor. Used in CreateOrgPage (initial setup) and in
// HRCycleDashboard (per-org edit). Pure controlled component.
export default function PhaseSettingsEditor({
  value,
  onChange,
  fiscalYearStartsOn = '',
  fiscalYearEndsOn   = '',
  disabled = false,
}) {
  const validation = useMemo(() => validateCycleWindows(value), [value]);
  const review = useMemo(() => reviewCycleWindows(value, new Date()), [value]);

  function patch(updater) {
    const next = updater(JSON.parse(JSON.stringify(value || {})));
    onChange(next);
  }

  function applyDefaults() {
    const defaults = defaultWindowsForFiscalYear({
      startsOn: fiscalYearStartsOn,
      endsOn:   fiscalYearEndsOn,
    });
    if (defaults) onChange(defaults);
  }

  const goal = value?.goalSetting || {};
  const evalPhase = value?.evaluation || {};
  const hasFiscalRange = !!(fiscalYearStartsOn && fiscalYearEndsOn);

  return (
    <div style={{ display: 'grid', gap: 12 }}>
      {hasFiscalRange && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end' }}>
          <button
            type="button"
            onClick={applyDefaults}
            disabled={disabled}
            style={{
              padding: '5px 11px',
              borderRadius: 7,
              border: '1px solid #CBD5E1',
              background: '#fff',
              color: '#1E40AF',
              fontSize: 11.5,
              fontWeight: 700,
              cursor: disabled ? 'not-allowed' : 'pointer',
              fontFamily: 'inherit',
            }}
          >
            Smart defaults from fiscal year
          </button>
        </div>
      )}

      <PhaseCard
        title="Goal-setting"
        accent="#2563EB"
        phase={goal}
        subKeys={[
          { key: 'goalCreation',    label: 'Goal creation' },
          { key: 'managerApproval', label: 'Manager approval' },
        ]}
        onPatch={(updater) => patch((draft) => { draft.goalSetting = updater(draft.goalSetting || {}); return draft; })}
        disabled={disabled}
      />

      <PhaseCard
        title="Evaluation"
        accent="#7C3AED"
        phase={evalPhase}
        subKeys={[
          { key: 'selfEvaluation',    label: 'Self evaluation' },
          { key: 'managerEvaluation', label: 'Manager evaluation' },
        ]}
        onPatch={(updater) => patch((draft) => { draft.evaluation = updater(draft.evaluation || {}); return draft; })}
        disabled={disabled}
      />

      <Timeline value={value} fiscalYearStartsOn={fiscalYearStartsOn} fiscalYearEndsOn={fiscalYearEndsOn} />

      {!validation.ok && (
        <div
          role="alert"
          style={{ padding: '9px 12px', borderRadius: 8, border: '1px solid #FCA5A5', background: '#FEF2F2', color: '#991B1B', fontSize: 12 }}
        >
          <strong>Fix:</strong> {validation.errors[0]}
          {validation.errors.length > 1 && <span style={{ color: '#B91C1C', marginLeft: 6 }}>(+{validation.errors.length - 1} more)</span>}
        </div>
      )}
      {validation.ok && review.warnings.length > 0 && (
        <div
          style={{ padding: '9px 12px', borderRadius: 8, border: '1px solid #FCD34D', background: '#FFFBEB', color: '#92400E', fontSize: 12 }}
        >
          <strong>Heads-up:</strong> {review.warnings[0]}
          {review.warnings.length > 1 && <span style={{ color: '#92400E', marginLeft: 6 }}>(+{review.warnings.length - 1} more)</span>}
        </div>
      )}
    </div>
  );
}

function PhaseCard({ title, accent, phase, subKeys, onPatch, disabled }) {
  return (
    <div style={{ border: '1px solid #E2E8F0', borderRadius: 10, background: '#fff', overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '9px 14px', borderLeft: `3px solid ${accent}`, borderBottom: '1px solid #F1F5F9', background: '#F8FAFC', flexWrap: 'wrap' }}>
        <span style={{ fontSize: 12, fontWeight: 800, color: '#0F172A', textTransform: 'uppercase', letterSpacing: '.05em', flexShrink: 0 }}>{title}</span>
        <DateRange
          startValue={phase.startsOn || ''}
          endValue={phase.endsOn || ''}
          disabled={disabled}
          onChange={(s, e) => onPatch((draft) => { draft.startsOn = s; draft.endsOn = e; return draft; })}
        />
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))' }}>
        {subKeys.map(({ key, label }, idx) => {
          const sub = phase.subPhases?.[key] || {};
          return (
            <div
              key={key}
              style={{
                padding: '9px 14px',
                borderLeft: idx === 0 ? 'none' : '1px solid #F1F5F9',
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                flexWrap: 'wrap',
              }}
            >
              <span style={{ fontSize: 11.5, fontWeight: 700, color: '#475569', flexShrink: 0, minWidth: 120 }}>{label}</span>
              <DateRange
                startValue={sub.startsOn || ''}
                endValue={sub.endsOn || ''}
                disabled={disabled}
                compact
                onChange={(s, e) => onPatch((draft) => {
                  if (!draft.subPhases) draft.subPhases = {};
                  draft.subPhases[key] = { startsOn: s, endsOn: e };
                  return draft;
                })}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}

function DateRange({ startValue, endValue, onChange, disabled, compact = false }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, flex: 1, minWidth: 0 }}>
      <DateField value={startValue} disabled={disabled} onChange={(v) => onChange(v, endValue)} compact={compact} />
      <span style={{ fontSize: 11, color: '#94A3B8', fontWeight: 700, flexShrink: 0 }}>→</span>
      <DateField value={endValue} disabled={disabled} onChange={(v) => onChange(startValue, v)} compact={compact} />
    </div>
  );
}

function DateField({ value, onChange, disabled, compact = false }) {
  return (
    <input
      type="date"
      value={value || ''}
      onChange={(e) => onChange(e.target.value)}
      disabled={disabled}
      style={{
        padding: compact ? '5px 7px' : '6px 9px',
        borderRadius: 6,
        border: '1px solid #CBD5E1',
        fontSize: compact ? 11.5 : 12,
        fontFamily: 'inherit',
        color: '#0F172A',
        background: disabled ? '#F1F5F9' : '#fff',
        flex: 1,
        minWidth: 0,
      }}
    />
  );
}

function Timeline({ value, fiscalYearStartsOn, fiscalYearEndsOn }) {
  const fyStart = parseISODate(fiscalYearStartsOn);
  const fyEnd   = parseISODate(fiscalYearEndsOn);
  if (!fyStart || !fyEnd || fyEnd <= fyStart) return null;

  const span = fyEnd.getTime() - fyStart.getTime();
  const pctFor = (date) => {
    const d = parseISODate(date);
    if (!d) return null;
    return Math.max(0, Math.min(1, (d.getTime() - fyStart.getTime()) / span));
  };

  const bars = [
    { label: 'Goal creation',       win: value?.goalSetting?.subPhases?.goalCreation,    color: '#3B82F6', row: 0 },
    { label: 'Manager approval',    win: value?.goalSetting?.subPhases?.managerApproval, color: '#1D4ED8', row: 0 },
    { label: 'Self evaluation',     win: value?.evaluation?.subPhases?.selfEvaluation,    color: '#A78BFA', row: 1 },
    { label: 'Manager evaluation',  win: value?.evaluation?.subPhases?.managerEvaluation, color: '#7C3AED', row: 1 },
  ].map((bar) => {
    const start = pctFor(bar.win?.startsOn);
    const end   = pctFor(bar.win?.endsOn);
    if (start == null || end == null || end < start) return { ...bar, render: false };
    return { ...bar, render: true, leftPct: start * 100, widthPct: Math.max(1.5, (end - start) * 100) };
  });

  return (
    <div style={{ border: '1px solid #E2E8F0', borderRadius: 8, background: '#fff', padding: '10px 14px' }}>
      {[0, 1].map((row) => (
        <div key={row} style={{ position: 'relative', height: 18, background: '#F1F5F9', borderRadius: 999, marginBottom: row === 0 ? 6 : 0 }}>
          {bars.filter((b) => b.render && b.row === row).map((bar, i) => (
            <div
              key={i}
              title={`${bar.label}: ${bar.win?.startsOn || '?'} → ${bar.win?.endsOn || '?'}`}
              style={{
                position: 'absolute',
                top: 3,
                bottom: 3,
                left: `${bar.leftPct}%`,
                width: `${bar.widthPct}%`,
                background: bar.color,
                borderRadius: 999,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: '#fff',
                fontSize: 9.5,
                fontWeight: 800,
                overflow: 'hidden',
                whiteSpace: 'nowrap',
                padding: '0 6px',
              }}
            >
              {bar.widthPct > 14 ? bar.label : ''}
            </div>
          ))}
        </div>
      ))}
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: '#94A3B8', marginTop: 5 }}>
        <span>{fiscalYearStartsOn}</span>
        <span>{fiscalYearEndsOn}</span>
      </div>
    </div>
  );
}

function parseISODate(iso) {
  if (!iso) return null;
  const [y, m, d] = String(iso).split('-').map(Number);
  if (!y || !m || !d) return null;
  return new Date(Date.UTC(y, m - 1, d, 12, 0, 0, 0));
}
