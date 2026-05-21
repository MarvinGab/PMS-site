import { useEffect, useMemo, useRef, useState } from 'react';
import {
  validateCycleWindows,
  reviewCycleWindows,
} from '../backend/cyclePhase';

// Compact two-calendar editor with internal draft + explicit Save. Used in
// CreateOrgPage (initial setup) and HRCycleDashboard (per-org edit). The
// editor only notifies its parent through `onChange` when the admin clicks
// Save — keystrokes and drag-moves stay local so we don't write on every
// micro-edit.
export default function PhaseSettingsEditor({
  value,
  onChange,
  fiscalYearStartsOn = '',
  fiscalYearEndsOn   = '',
  disabled = false,
}) {
  const [draft, setDraft] = useState(value || null);
  const [savedSig, setSavedSig] = useState(() => signature(value));

  // Adopt new external values when we don't have unsaved edits. Avoids
  // clobbering a draft mid-edit just because another tab pushed an update.
  useEffect(() => {
    const incoming = signature(value);
    if (incoming === savedSig) return;
    const isDirty = signature(draft) !== savedSig;
    if (isDirty) return;
    setDraft(value || null);
    setSavedSig(incoming);
  }, [value, savedSig, draft]);

  const dirty = signature(draft) !== savedSig;
  const validation = useMemo(() => validateCycleWindows(draft), [draft]);
  const review = useMemo(() => reviewCycleWindows(draft, new Date()), [draft]);

  function patch(updater) {
    setDraft((current) => updater(JSON.parse(JSON.stringify(current || {}))));
  }

  function commitSave() {
    if (!dirty || !validation.ok) return;
    onChange?.(draft);
    setSavedSig(signature(draft));
  }

  function discard() {
    setDraft(value || null);
    setSavedSig(signature(value));
  }

  const goal = draft?.goalSetting || {};
  const evalPhase = draft?.evaluation || {};

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
        onPatch={(updater) => patch((d) => { d.goalSetting = updater(d.goalSetting || {}); return d; })}
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
        onPatch={(updater) => patch((d) => { d.evaluation = updater(d.evaluation || {}); return d; })}
        disabled={disabled}
      />

      <Timeline
        value={draft}
        fiscalYearStartsOn={fiscalYearStartsOn}
        fiscalYearEndsOn={fiscalYearEndsOn}
        onPatch={patch}
        disabled={disabled}
      />

      {!validation.ok && (
        <div role="alert" style={alertStyles.error}>
          <strong>Fix:</strong> {validation.errors[0]}
          {validation.errors.length > 1 && <span style={{ color: '#B91C1C', marginLeft: 6 }}>(+{validation.errors.length - 1} more)</span>}
        </div>
      )}
      {validation.ok && review.warnings.length > 0 && (
        <div style={alertStyles.warn}>
          <strong>Heads-up:</strong> {review.warnings[0]}
          {review.warnings.length > 1 && <span style={{ color: '#92400E', marginLeft: 6 }}>(+{review.warnings.length - 1} more)</span>}
        </div>
      )}

      <SaveBar
        dirty={dirty}
        validationOk={validation.ok}
        disabled={disabled}
        onSave={commitSave}
        onDiscard={discard}
      />
    </div>
  );
}

function signature(v) { return JSON.stringify(v || null); }

const alertStyles = {
  error: { padding: '9px 12px', borderRadius: 8, border: '1px solid #FCA5A5', background: '#FEF2F2', color: '#991B1B', fontSize: 12 },
  warn:  { padding: '9px 12px', borderRadius: 8, border: '1px solid #FCD34D', background: '#FFFBEB', color: '#92400E', fontSize: 12 },
};

function SaveBar({ dirty, validationOk, disabled, onSave, onDiscard }) {
  if (!dirty) return null;
  const canSave = !disabled && validationOk;
  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      gap: 12, padding: '11px 14px',
      borderRadius: 10, border: '1px solid #BFDBFE',
      background: '#EFF6FF',
    }}>
      <span style={{ fontSize: 12.5, color: '#1E3A8A', fontWeight: 700, display: 'inline-flex', alignItems: 'center', gap: 8 }}>
        <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#F59E0B', display: 'inline-block' }} />
        Unsaved changes — review the timeline, then save.
      </span>
      <div style={{ display: 'flex', gap: 8 }}>
        <button type="button" onClick={onDiscard} disabled={disabled} style={btnSecondary}>Discard</button>
        <button
          type="button"
          onClick={onSave}
          disabled={!canSave}
          style={{ ...btnPrimary, opacity: canSave ? 1 : 0.5, cursor: canSave ? 'pointer' : 'not-allowed' }}
        >
          Save changes
        </button>
      </div>
    </div>
  );
}

const btnBase = {
  fontFamily: 'inherit', fontSize: 12.5, fontWeight: 800,
  borderRadius: 8, padding: '8px 14px',
  outline: 'none',
};
const btnPrimary = { ...btnBase, background: '#2563EB', color: '#fff', border: '1px solid #2563EB', cursor: 'pointer' };
const btnSecondary = { ...btnBase, background: '#fff', color: '#475569', border: '1px solid #CBD5E1', cursor: 'pointer' };

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
              // Custom → synced: overwrite per-sub windows with the phase dates.
              onPatch((draft) => syncSubWindowsToPhase(draft, subKeys));
              setCustomSubWindows(false);
            } else {
              // Synced → custom: leave existing windows so the admin can edit them.
              setCustomSubWindows(true);
            }
          }}
          style={{
            padding: '8px 15px',
            borderRadius: 999,
            border: '1px solid #CBD5E1',
            background: '#fff',
            color: '#475569',
            fontSize: 12.5,
            fontWeight: 800,
            cursor: disabled ? 'not-allowed' : 'pointer',
            fontFamily: 'inherit',
            whiteSpace: 'nowrap',
            outline: 'none',
            boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.6)',
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

const DAY_MS = 24 * 60 * 60 * 1000;

function shiftDays(iso, days) {
  const d = parseISODate(iso);
  if (!d) return iso;
  d.setUTCDate(d.getUTCDate() + days);
  return toISODate(d);
}

function clampISO(iso, minISO, maxISO) {
  if (!iso) return iso;
  if (minISO && iso < minISO) return minISO;
  if (maxISO && iso > maxISO) return maxISO;
  return iso;
}

function Timeline({ value, fiscalYearStartsOn, fiscalYearEndsOn, onPatch, disabled }) {
  const trackRef = useRef(null);
  const [dragging, setDragging] = useState(null); // { barKey, mode } | null

  const fyStart = parseISODate(fiscalYearStartsOn);
  const fyEnd   = parseISODate(fiscalYearEndsOn);
  if (!fyStart || !fyEnd || fyEnd <= fyStart) return null;

  const span = fyEnd.getTime() - fyStart.getTime();
  const totalDays = Math.max(1, Math.round(span / DAY_MS));
  const pctFor = (date) => {
    const d = parseISODate(date);
    if (!d) return null;
    return Math.max(0, Math.min(1, (d.getTime() - fyStart.getTime()) / span));
  };

  const now = new Date();
  const todayPct = (() => {
    const t = now.getTime();
    if (t < fyStart.getTime() || t > fyEnd.getTime()) return null;
    return ((t - fyStart.getTime()) / span) * 100;
  })();

  const goalSynced = subWindowsMatchPhase(value?.goalSetting, [
    { key: 'goalCreation' },
    { key: 'managerApproval' },
  ]);
  const evaluationSynced = subWindowsMatchPhase(value?.evaluation, [
    { key: 'selfEvaluation' },
    { key: 'managerEvaluation' },
  ]);

  // `apply` mutates a draft to reflect the new range for this specific bar.
  // Keeping it on the bar metadata lets the drag handler stay generic.
  const goalSubKeys = [{ key: 'goalCreation' }, { key: 'managerApproval' }];
  const evalSubKeys = [{ key: 'selfEvaluation' }, { key: 'managerEvaluation' }];

  const rawBars = [
    ...(goalSynced
      ? [{
          key: 'goal',
          label: 'Goal-setting',
          win: value?.goalSetting,
          color: 'linear-gradient(90deg,#3B82F6,#1D4ED8)',
          solid: '#2563EB',
          apply(draft, s, e) {
            draft.goalSetting = draft.goalSetting || {};
            draft.goalSetting.startsOn = s;
            draft.goalSetting.endsOn = e;
            syncSubWindowsToPhase(draft.goalSetting, goalSubKeys, s, e);
            return draft;
          },
        }]
      : [
          {
            key: 'goal-creation', label: 'Goal creation', win: value?.goalSetting?.subPhases?.goalCreation,
            color: '#3B82F6', solid: '#3B82F6',
            apply(draft, s, e) {
              draft.goalSetting = draft.goalSetting || {};
              if (!draft.goalSetting.subPhases) draft.goalSetting.subPhases = {};
              draft.goalSetting.subPhases.goalCreation = { startsOn: s, endsOn: e };
              return draft;
            },
          },
          {
            key: 'manager-approval', label: 'Manager approval', win: value?.goalSetting?.subPhases?.managerApproval,
            color: '#1D4ED8', solid: '#1D4ED8',
            apply(draft, s, e) {
              draft.goalSetting = draft.goalSetting || {};
              if (!draft.goalSetting.subPhases) draft.goalSetting.subPhases = {};
              draft.goalSetting.subPhases.managerApproval = { startsOn: s, endsOn: e };
              return draft;
            },
          },
        ]),
    ...(evaluationSynced
      ? [{
          key: 'eval',
          label: 'Evaluation',
          win: value?.evaluation,
          color: 'linear-gradient(90deg,#A78BFA,#7C3AED)',
          solid: '#7C3AED',
          apply(draft, s, e) {
            draft.evaluation = draft.evaluation || {};
            draft.evaluation.startsOn = s;
            draft.evaluation.endsOn = e;
            syncSubWindowsToPhase(draft.evaluation, evalSubKeys, s, e);
            return draft;
          },
        }]
      : [
          {
            key: 'self-eval', label: 'Self evaluation', win: value?.evaluation?.subPhases?.selfEvaluation,
            color: '#A78BFA', solid: '#A78BFA',
            apply(draft, s, e) {
              draft.evaluation = draft.evaluation || {};
              if (!draft.evaluation.subPhases) draft.evaluation.subPhases = {};
              draft.evaluation.subPhases.selfEvaluation = { startsOn: s, endsOn: e };
              return draft;
            },
          },
          {
            key: 'mgr-eval', label: 'Manager evaluation', win: value?.evaluation?.subPhases?.managerEvaluation,
            color: '#7C3AED', solid: '#7C3AED',
            apply(draft, s, e) {
              draft.evaluation = draft.evaluation || {};
              if (!draft.evaluation.subPhases) draft.evaluation.subPhases = {};
              draft.evaluation.subPhases.managerEvaluation = { startsOn: s, endsOn: e };
              return draft;
            },
          },
        ]),
  ];

  const bars = rawBars.map((bar) => {
    const start = pctFor(bar.win?.startsOn);
    const end   = pctFor(bar.win?.endsOn);
    if (start == null || end == null || end < start) return { ...bar, render: false };
    const widthPct = Math.max(1.5, (end - start) * 100);
    return { ...bar, render: true, leftPct: start * 100, widthPct };
  });

  const renderedBars = bars.filter((b) => b.render);
  // All bars share label placement so the timeline doesn't look lopsided
  // when one phase happens to be wider than the other.
  const allFitInline = renderedBars.length > 0 && renderedBars.every((b) => b.widthPct >= 9);
  const hasOffsetLabels = !allFitInline && renderedBars.length > 0;

  function startDrag(bar, mode) {
    return (e) => {
      if (disabled || !trackRef.current) return;
      if (e.button != null && e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      const rect = trackRef.current.getBoundingClientRect();
      const startX = e.clientX;
      const origStart = bar.win?.startsOn;
      const origEnd   = bar.win?.endsOn;
      if (!origStart || !origEnd) return;
      setDragging({ key: bar.key, mode });

      function onMove(ev) {
        const dxPx = ev.clientX - startX;
        const dxDays = Math.round((dxPx / rect.width) * totalDays);
        let s = origStart;
        let ed = origEnd;
        if (mode === 'move') {
          s = shiftDays(origStart, dxDays);
          ed = shiftDays(origEnd, dxDays);
          // If a translate would push us past the FY edge, slide back
          // without resizing so the window keeps its length.
          if (s < fiscalYearStartsOn) {
            const overrun = daysDelta(fiscalYearStartsOn, s);
            s = fiscalYearStartsOn;
            ed = shiftDays(ed, -overrun);
          }
          if (ed > fiscalYearEndsOn) {
            const overrun = daysDelta(ed, fiscalYearEndsOn);
            ed = fiscalYearEndsOn;
            s = shiftDays(s, overrun);
          }
        } else if (mode === 'start') {
          s = shiftDays(origStart, dxDays);
          s = clampISO(s, fiscalYearStartsOn, ed);
        } else if (mode === 'end') {
          ed = shiftDays(origEnd, dxDays);
          ed = clampISO(ed, s, fiscalYearEndsOn);
        }
        onPatch?.((draft) => bar.apply(draft, s, ed));
      }

      function onUp() {
        setDragging(null);
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
      }

      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    };
  }

  const interactive = !disabled && onPatch;

  return (
    <div style={{ border: '1px solid #E2E8F0', borderRadius: 10, background: '#fff', padding: '14px 16px 12px', userSelect: dragging ? 'none' : 'auto' }}>
      <div
        ref={trackRef}
        style={{ position: 'relative', height: 22, background: '#F1F5F9', borderRadius: 999 }}
      >
        {renderedBars.map((bar) => {
          const showInline = allFitInline;
          const isDragging = dragging?.key === bar.key;
          return (
            <div
              key={bar.key}
              title={`${bar.label}: ${formatPrettyDate(bar.win?.startsOn) || '?'} → ${formatPrettyDate(bar.win?.endsOn) || '?'}\n${interactive ? 'Drag to move · drag the edges to resize' : ''}`}
              onPointerDown={interactive ? startDrag(bar, 'move') : undefined}
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
                fontSize: 10.5,
                fontWeight: 800,
                overflow: 'visible',
                whiteSpace: 'nowrap',
                padding: '0 8px',
                boxShadow: isDragging ? '0 0 0 2px rgba(15,23,42,0.55), 0 4px 10px rgba(15,23,42,0.15)' : '0 1px 2px rgba(15,23,42,0.12)',
                cursor: interactive ? (isDragging ? 'grabbing' : 'grab') : 'default',
                touchAction: 'none',
                transition: isDragging ? 'none' : 'box-shadow 120ms ease',
              }}
            >
              {showInline ? bar.label : ''}
              {interactive && (
                <>
                  <span
                    onPointerDown={startDrag(bar, 'start')}
                    title="Drag to change start date"
                    style={{
                      position: 'absolute', left: -3, top: -4, bottom: -4, width: 10,
                      cursor: 'ew-resize', borderRadius: 4,
                    }}
                  >
                    <span style={resizeGripStyle(bar.solid)} />
                  </span>
                  <span
                    onPointerDown={startDrag(bar, 'end')}
                    title="Drag to change end date"
                    style={{
                      position: 'absolute', right: -3, top: -4, bottom: -4, width: 10,
                      cursor: 'ew-resize', borderRadius: 4,
                    }}
                  >
                    <span style={{ ...resizeGripStyle(bar.solid), left: 'auto', right: 0 }} />
                  </span>
                </>
              )}
            </div>
          );
        })}
        {todayPct != null && (
          <div
            title={`Today · ${formatPrettyDate(toISODate(now))}`}
            style={{
              position: 'absolute',
              top: -5,
              bottom: -5,
              left: `${todayPct}%`,
              width: 2,
              background: '#0F172A',
              borderRadius: 2,
              pointerEvents: 'none',
              boxShadow: '0 0 0 2px rgba(255,255,255,0.85)',
            }}
          />
        )}
      </div>

      {hasOffsetLabels && (
        <div style={{ position: 'relative', height: 14, marginTop: 6 }}>
          {renderedBars.map((bar) => (
            <div
              key={bar.key}
              style={{
                position: 'absolute',
                left: `${Math.min(95, Math.max(5, bar.leftPct + bar.widthPct / 2))}%`,
                transform: 'translateX(-50%)',
                fontSize: 10.5,
                fontWeight: 800,
                color: '#334155',
                whiteSpace: 'nowrap',
              }}
            >
              {bar.label}
            </div>
          ))}
        </div>
      )}

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 10.5, color: '#64748B', marginTop: 8, fontWeight: 600 }}>
        <span>{formatPrettyDate(fiscalYearStartsOn) || fiscalYearStartsOn}</span>
        {todayPct != null && (
          <span style={{ color: '#0F172A' }}>Today · {formatPrettyDate(toISODate(now))}</span>
        )}
        <span>{formatPrettyDate(fiscalYearEndsOn) || fiscalYearEndsOn}</span>
      </div>

      {interactive && (
        <div style={{ marginTop: 8, fontSize: 11, color: '#94A3B8', fontWeight: 600 }}>
          Tip: drag a bar to move its window · drag the edges to resize · changes stay local until you hit Save.
        </div>
      )}
    </div>
  );
}

function resizeGripStyle(color) {
  return {
    position: 'absolute',
    top: '50%',
    left: 0,
    transform: 'translateY(-50%)',
    width: 3,
    height: 14,
    background: '#fff',
    borderRadius: 2,
    border: `1px solid ${color}`,
    pointerEvents: 'none',
  };
}

function daysDelta(fromISO, toISO) {
  const a = parseISODate(fromISO);
  const b = parseISODate(toISO);
  if (!a || !b) return 0;
  return Math.round((b.getTime() - a.getTime()) / DAY_MS);
}

function parseISODate(iso) {
  if (!iso) return null;
  const [y, m, d] = String(iso).split('-').map(Number);
  if (!y || !m || !d) return null;
  return new Date(Date.UTC(y, m - 1, d, 12, 0, 0, 0));
}

function toISODate(date) {
  if (!date) return '';
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}

const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function formatPrettyDate(iso) {
  const d = parseISODate(iso);
  if (!d) return '';
  return `${d.getUTCDate()} ${MONTH_ABBR[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}
