import { useEffect, useMemo, useState } from 'react';
import {
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

  const goal = value?.goalSetting || {};
  const evalPhase = value?.evaluation || {};

  return (
    <div style={{ display: 'grid', gap: 14 }}>
      <PhaseCard
        title="Goal-setting"
        accent="#2563EB"
        phase={goal}
        minDate={fiscalYearStartsOn}
        maxDate={fiscalYearEndsOn}
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
        minDate={fiscalYearStartsOn}
        maxDate={fiscalYearEndsOn}
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

function subWindowsMatchPhase(phase, subKeys) {
  if (!phase?.startsOn || !phase?.endsOn) return true;
  return subKeys.every(({ key }) => {
    const sub = phase.subPhases?.[key] || {};
    return sub.startsOn === phase.startsOn && sub.endsOn === phase.endsOn;
  });
}

function syncSubWindowsToPhase(draft, subKeys, startsOn = draft.startsOn || '', endsOn = draft.endsOn || '') {
  if (!draft.subPhases) draft.subPhases = {};
  subKeys.forEach(({ key }) => {
    draft.subPhases[key] = { startsOn, endsOn };
  });
  return draft;
}

function clampDate(value, minDate, maxDate) {
  if (!value) return '';
  if (minDate && value < minDate) return minDate;
  if (maxDate && value > maxDate) return maxDate;
  return value;
}

function normalizeRange(startValue, endValue, minDate, maxDate) {
  let startsOn = clampDate(startValue || '', minDate, maxDate);
  let endsOn = clampDate(endValue || '', minDate, maxDate);
  if (startsOn && endsOn && endsOn < startsOn) {
    endsOn = startsOn;
  }
  return { startsOn, endsOn };
}

function clampSubWindowsToPhase(draft, subKeys) {
  if (!draft.subPhases) draft.subPhases = {};
  subKeys.forEach(({ key }) => {
    const sub = draft.subPhases[key] || {};
    draft.subPhases[key] = normalizeRange(sub.startsOn, sub.endsOn, draft.startsOn || '', draft.endsOn || '');
  });
  return draft;
}

function PhaseCard({ title, accent, phase, subKeys, onPatch, disabled, minDate, maxDate }) {
  const subWindowsSynced = subWindowsMatchPhase(phase, subKeys);
  const [customSubWindows, setCustomSubWindows] = useState(!subWindowsSynced);

  useEffect(() => {
    if (!subWindowsSynced) setCustomSubWindows(true);
  }, [subWindowsSynced]);

  const subLabel = subKeys.map((item) => item.label).join(' and ');

  return (
    <div style={{ border: '1px solid #D8E1EE', borderRadius: 12, background: '#fff', overflow: 'hidden', boxShadow: '0 1px 2px rgba(15,23,42,.04)' }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(150px, 190px) minmax(260px, 1fr) auto', alignItems: 'center', gap: 14, padding: '13px 16px', borderLeft: `4px solid ${accent}`, borderBottom: '1px solid #E8EEF6', background: 'linear-gradient(180deg,#FFFFFF 0%,#F8FAFC 100%)' }}>
        <div>
          <div style={{ fontSize: 12.5, fontWeight: 850, color: '#0F172A', textTransform: 'uppercase', letterSpacing: '.04em' }}>{title}</div>
          <div style={{ marginTop: 3, fontSize: 11.5, fontWeight: 700, color: '#94A3B8' }}>Phase window</div>
        </div>
        <div style={{ minWidth: 0 }}>
          <DateRange
            startValue={phase.startsOn || ''}
            endValue={phase.endsOn || ''}
            minDate={minDate}
            maxDate={maxDate}
            disabled={disabled}
            onChange={(s, e) => onPatch((draft) => {
              const wasSynced = subWindowsMatchPhase(draft, subKeys);
              const next = normalizeRange(s, e, minDate, maxDate);
              draft.startsOn = next.startsOn;
              draft.endsOn = next.endsOn;
              if (wasSynced || !customSubWindows) {
                syncSubWindowsToPhase(draft, subKeys, next.startsOn, next.endsOn);
              } else {
                clampSubWindowsToPhase(draft, subKeys);
              }
              return draft;
            })}
          />
        </div>
        <button
          type="button"
          disabled={disabled || !phase.startsOn || !phase.endsOn}
          onClick={() => {
            if (customSubWindows) {
              onPatch((draft) => syncSubWindowsToPhase(draft, subKeys));
              setCustomSubWindows(false);
            } else {
              onPatch((draft) => syncSubWindowsToPhase(draft, subKeys));
              setCustomSubWindows(true);
            }
          }}
          style={{
            padding: '8px 15px',
            borderRadius: 999,
            border: `1px solid ${customSubWindows ? '#CBD5E1' : '#BFDBFE'}`,
            background: customSubWindows ? '#fff' : '#EFF6FF',
            color: customSubWindows ? '#475569' : '#1D4ED8',
            fontSize: 12.5,
            fontWeight: 800,
            cursor: disabled ? 'not-allowed' : 'pointer',
            fontFamily: 'inherit',
            whiteSpace: 'nowrap',
          }}
        >
          {customSubWindows ? 'Use same dates' : 'Customize windows'}
        </button>
      </div>
      {customSubWindows ? (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', background: '#FBFCFE' }}>
          {subKeys.map(({ key, label }, idx) => {
            const sub = phase.subPhases?.[key] || {};
            return (
              <div
                key={key}
                style={{
                  padding: '14px 16px',
                  borderLeft: idx === 0 ? 'none' : '1px solid #E8EEF6',
                  display: 'grid',
                  gap: 9,
                  minWidth: 0,
                }}
              >
                <span style={{ fontSize: 12.5, fontWeight: 800, color: '#475569', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{label}</span>
                <DateRange
                  startValue={sub.startsOn || ''}
                  endValue={sub.endsOn || ''}
                  minDate={phase.startsOn || ''}
                  maxDate={phase.endsOn || ''}
                  disabled={disabled}
                  compact
                  onChange={(s, e) => onPatch((draft) => {
                    if (!draft.subPhases) draft.subPhases = {};
                    draft.subPhases[key] = normalizeRange(s, e, draft.startsOn || '', draft.endsOn || '');
                    return draft;
                  })}
                />
              </div>
            );
          })}
        </div>
      ) : (
        <div style={{ padding: '13px 16px', background: '#FBFCFE', fontSize: 13, color: '#64748B', borderTop: '1px solid #E8EEF6' }}>
          <strong style={{ color: '#334155' }}>{subLabel}</strong> use the same dates as the {title.toLowerCase()} phase.
        </div>
      )}
    </div>
  );
}

function DateRange({ startValue, endValue, onChange, disabled, compact = false, minDate = '', maxDate = '' }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: compact ? 'minmax(112px, 1fr) 16px minmax(112px, 1fr)' : 'minmax(130px, 1fr) 18px minmax(130px, 1fr)', alignItems: 'center', gap: compact ? 7 : 10, minWidth: 0 }}>
      <DateField value={startValue} minDate={minDate} maxDate={endValue || maxDate} disabled={disabled} onChange={(v) => onChange(v, endValue)} compact={compact} />
      <span style={{ fontSize: 13, color: '#94A3B8', fontWeight: 800, textAlign: 'center' }}>→</span>
      <DateField value={endValue} minDate={startValue || minDate} maxDate={maxDate} disabled={disabled} onChange={(v) => onChange(startValue, v)} compact={compact} />
    </div>
  );
}

function openNativePicker(event) {
  try {
    event.currentTarget.showPicker?.();
  } catch {
    // Some browsers only allow showPicker from a direct click. The input still
    // works normally when that API is blocked.
  }
}

function DateField({ value, onChange, disabled, compact = false, minDate = '', maxDate = '' }) {
  return (
    <input
      type="date"
      value={value || ''}
      min={minDate || undefined}
      max={maxDate || undefined}
      onChange={(e) => onChange(e.target.value)}
      onFocus={openNativePicker}
      onClick={openNativePicker}
      disabled={disabled}
      style={{
        width: '100%',
        padding: compact ? '8px 9px' : '10px 12px',
        borderRadius: 9,
        border: '1px solid #CBD5E1',
        boxShadow: 'inset 0 1px 0 rgba(15,23,42,.03)',
        fontSize: compact ? 12.5 : 14,
        fontWeight: 650,
        fontFamily: 'inherit',
        color: '#0F172A',
        background: disabled ? '#F1F5F9' : '#fff',
        minWidth: 0,
        colorScheme: 'light',
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

  const goalSynced = subWindowsMatchPhase(value?.goalSetting, [
    { key: 'goalCreation' },
    { key: 'managerApproval' },
  ]);
  const evaluationSynced = subWindowsMatchPhase(value?.evaluation, [
    { key: 'selfEvaluation' },
    { key: 'managerEvaluation' },
  ]);

  const rawBars = [
    ...(goalSynced
      ? [{ label: 'Goal-setting', win: value?.goalSetting, color: 'linear-gradient(90deg,#3B82F6,#1D4ED8)', row: 0 }]
      : [
          { label: 'Goal creation',    win: value?.goalSetting?.subPhases?.goalCreation,    color: '#3B82F6', row: 0 },
          { label: 'Manager approval', win: value?.goalSetting?.subPhases?.managerApproval, color: '#1D4ED8', row: 0 },
        ]),
    ...(evaluationSynced
      ? [{ label: 'Evaluation', win: value?.evaluation, color: 'linear-gradient(90deg,#A78BFA,#7C3AED)', row: 1 }]
      : [
          { label: 'Self evaluation',    win: value?.evaluation?.subPhases?.selfEvaluation,    color: '#A78BFA', row: 1 },
          { label: 'Manager evaluation', win: value?.evaluation?.subPhases?.managerEvaluation, color: '#7C3AED', row: 1 },
        ]),
  ];

  const bars = rawBars.map((bar) => {
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
