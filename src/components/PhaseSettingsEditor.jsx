import { useMemo } from 'react';
import {
  defaultWindowsForFiscalYear,
  validateCycleWindows,
  PHASE_KIND,
} from '../backend/cyclePhase';

// Two-calendar editor. Used in CreateOrgPage (initial setup) and in
// HRCycleDashboard (per-org edit). Pure controlled component: parent owns
// `value` (a cyclePhaseWindows object) and `onChange`.
export default function PhaseSettingsEditor({
  value,
  onChange,
  fiscalYearStartsOn = '',
  fiscalYearEndsOn   = '',
  disabled = false,
}) {
  const validation = useMemo(() => validateCycleWindows(value), [value]);

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

  return (
    <div className="phase-settings-editor" style={{ display: 'grid', gap: 18 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontSize: 14, fontWeight: 800, color: '#0F172A' }}>Cycle phase calendar</div>
          <div style={{ fontSize: 12.5, color: '#64748B', marginTop: 4, lineHeight: 1.5 }}>
            The calendar decides which phase the cycle is in. Set when goal-setting and evaluation open, and split each into its sub-phases.
          </div>
        </div>
        {fiscalYearStartsOn && fiscalYearEndsOn && (
          <button
            type="button"
            onClick={applyDefaults}
            disabled={disabled}
            style={{
              padding: '7px 13px',
              borderRadius: 8,
              border: '1px solid #CBD5E1',
              background: '#fff',
              color: '#0F172A',
              fontSize: 12.5,
              fontWeight: 700,
              cursor: disabled ? 'not-allowed' : 'pointer',
              fontFamily: 'inherit',
            }}
          >
            Use smart defaults
          </button>
        )}
      </div>

      <PhaseCard
        title="Goal-setting phase"
        accent="#2563EB"
        helper="When employees create goals and managers approve them."
        phase={goal}
        subKeys={[
          { key: 'goalCreation',    label: 'Goal creation',    helper: 'Employee adds KRAs / KPIs / targets.' },
          { key: 'managerApproval', label: 'Manager approval', helper: 'Manager reviews and approves the plan.' },
        ]}
        onPatch={(updater) => patch((draft) => { draft.goalSetting = updater(draft.goalSetting || {}); return draft; })}
        disabled={disabled}
      />

      <PhaseCard
        title="Evaluation phase"
        accent="#7C3AED"
        helper="Year-end (or cycle-end) appraisal — self rating then manager rating."
        phase={evalPhase}
        subKeys={[
          { key: 'selfEvaluation',    label: 'Self evaluation',    helper: 'Employee rates themselves against approved goals.' },
          { key: 'managerEvaluation', label: 'Manager evaluation', helper: 'Manager rates the employee.' },
        ]}
        onPatch={(updater) => patch((draft) => { draft.evaluation = updater(draft.evaluation || {}); return draft; })}
        disabled={disabled}
      />

      <Timeline value={value} fiscalYearStartsOn={fiscalYearStartsOn} fiscalYearEndsOn={fiscalYearEndsOn} />

      {!validation.ok && (
        <div
          role="alert"
          style={{ padding: '11px 14px', borderRadius: 9, border: '1px solid #FCA5A5', background: '#FEF2F2', color: '#991B1B', fontSize: 12.5 }}
        >
          <div style={{ fontWeight: 800, marginBottom: 4 }}>Fix these before saving:</div>
          <ul style={{ margin: 0, paddingLeft: 18, display: 'grid', gap: 3 }}>
            {validation.errors.map((err, i) => <li key={i}>{err}</li>)}
          </ul>
        </div>
      )}
    </div>
  );
}

function PhaseCard({ title, accent, helper, phase, subKeys, onPatch, disabled }) {
  return (
    <div style={{ border: '1px solid #E2E8F0', borderRadius: 12, background: '#fff', overflow: 'hidden' }}>
      <div style={{ padding: '13px 16px', borderLeft: `4px solid ${accent}`, borderBottom: '1px solid #F1F5F9', display: 'grid', gap: 6 }}>
        <div style={{ fontSize: 13.5, fontWeight: 800, color: '#0F172A' }}>{title}</div>
        <div style={{ fontSize: 12, color: '#64748B' }}>{helper}</div>
      </div>
      <div style={{ padding: 16, display: 'grid', gap: 14 }}>
        <DateRangeRow
          label="Phase opens"
          startLabel="Starts on"
          endLabel="Ends on"
          startValue={phase.startsOn || ''}
          endValue={phase.endsOn || ''}
          disabled={disabled}
          onChange={(startsOn, endsOn) => onPatch((draft) => {
            draft.startsOn = startsOn;
            draft.endsOn = endsOn;
            return draft;
          })}
        />
        <div style={{ display: 'grid', gap: 12, gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))' }}>
          {subKeys.map(({ key, label, helper: subHelper }) => {
            const sub = phase.subPhases?.[key] || {};
            return (
              <div key={key} style={{ border: '1px dashed #CBD5E1', borderRadius: 10, padding: 12, background: '#F8FAFC' }}>
                <div style={{ fontSize: 12, fontWeight: 800, color: '#0F172A' }}>{label}</div>
                <div style={{ fontSize: 11.5, color: '#64748B', marginTop: 3, marginBottom: 9 }}>{subHelper}</div>
                <DateRangeRow
                  startValue={sub.startsOn || ''}
                  endValue={sub.endsOn || ''}
                  disabled={disabled}
                  compact
                  onChange={(startsOn, endsOn) => onPatch((draft) => {
                    if (!draft.subPhases) draft.subPhases = {};
                    draft.subPhases[key] = { startsOn, endsOn };
                    return draft;
                  })}
                />
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function DateRangeRow({ label, startLabel = 'From', endLabel = 'To', startValue, endValue, onChange, disabled, compact = false }) {
  return (
    <div style={{ display: 'grid', gap: compact ? 6 : 8 }}>
      {label && <div style={{ fontSize: 12, fontWeight: 700, color: '#475569' }}>{label}</div>}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
        <DateField label={startLabel} value={startValue} disabled={disabled} onChange={(v) => onChange(v, endValue)} compact={compact} />
        <DateField label={endLabel}   value={endValue}   disabled={disabled} onChange={(v) => onChange(startValue, v)} compact={compact} />
      </div>
    </div>
  );
}

function DateField({ label, value, onChange, disabled, compact }) {
  return (
    <label style={{ display: 'grid', gap: 4 }}>
      <span style={{ fontSize: compact ? 10.5 : 11, fontWeight: 700, color: '#64748B', textTransform: 'uppercase', letterSpacing: '.05em' }}>{label}</span>
      <input
        type="date"
        value={value || ''}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        style={{
          padding: compact ? '7px 9px' : '9px 11px',
          borderRadius: 8,
          border: '1px solid #CBD5E1',
          fontSize: compact ? 12.5 : 13,
          fontFamily: 'inherit',
          color: '#0F172A',
          background: disabled ? '#F1F5F9' : '#fff',
        }}
      />
    </label>
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
    { label: 'Goal creation',       win: value?.goalSetting?.subPhases?.goalCreation,    color: '#3B82F6' },
    { label: 'Manager approval',    win: value?.goalSetting?.subPhases?.managerApproval, color: '#2563EB' },
    { label: 'Self evaluation',     win: value?.evaluation?.subPhases?.selfEvaluation,    color: '#A78BFA' },
    { label: 'Manager evaluation',  win: value?.evaluation?.subPhases?.managerEvaluation, color: '#7C3AED' },
  ].map((bar) => {
    const start = pctFor(bar.win?.startsOn);
    const end   = pctFor(bar.win?.endsOn);
    if (start == null || end == null || end < start) return { ...bar, render: false };
    return { ...bar, render: true, leftPct: start * 100, widthPct: Math.max(1.5, (end - start) * 100) };
  });

  return (
    <div style={{ border: '1px solid #E2E8F0', borderRadius: 10, background: '#fff', padding: 14 }}>
      <div style={{ fontSize: 11.5, fontWeight: 800, color: '#475569', textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 10 }}>Cycle timeline</div>
      <div style={{ position: 'relative', height: 26, background: '#F1F5F9', borderRadius: 999 }}>
        {bars.filter((b) => b.render).map((bar, i) => (
          <div
            key={i}
            title={`${bar.label}: ${bar.win?.startsOn || '?'} → ${bar.win?.endsOn || '?'}`}
            style={{
              position: 'absolute',
              top: 4,
              bottom: 4,
              left: `${bar.leftPct}%`,
              width: `${bar.widthPct}%`,
              background: bar.color,
              borderRadius: 999,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: '#fff',
              fontSize: 10.5,
              fontWeight: 800,
              overflow: 'hidden',
              whiteSpace: 'nowrap',
              padding: '0 6px',
            }}
          >
            {bar.widthPct > 12 ? bar.label : ''}
          </div>
        ))}
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: '#94A3B8', marginTop: 6 }}>
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
