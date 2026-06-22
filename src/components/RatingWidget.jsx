// One reusable score input. Reads scoreInputMode + scorePrecision from the
// wizard config so every page (self / manager / HR) renders consistently.

import { useEffect, useMemo, useRef, useState } from 'react';

const SCALE_DEFAULTS = {
  3: ['Below Expectations', 'Meets Expectations', 'Exceeds Expectations'],
  4: ['Below Expectations', 'Meets Expectations', 'Exceeds Expectations', 'Outstanding'],
  5: ['Needs Improvement', 'Below Expectations', 'Meets Expectations', 'Exceeds Expectations', 'Outstanding'],
  7: ['Unsatisfactory', 'Needs Improvement', 'Partially Meets', 'Meets Expectations', 'Exceeds Expectations', 'Strong Performance', 'Outstanding'],
};

function getScaleLevels(config = {}) {
  const cfg = config || {};
  const N = Math.max(2, Math.min(10, Number(cfg.scalePoints) || 5));
  const labels = cfg.scaleLabels || {};
  const codes = cfg.scaleRankCodes || {};
  return Array.from({ length: N }, (_, i) => {
    const n = i + 1;
    const defaultLabel = SCALE_DEFAULTS[N]?.[i] || '';
    return { n, l: String(labels[n] || defaultLabel), code: String(codes[n] ?? n) };
  });
}

function formatChoice(level, config = {}) {
  const display = String(config?.ratingChoiceDisplay || 'number-label');
  if (display === 'number-only') return String(level.code || level.n);
  if (display === 'label-only') return String(level.l || level.code || level.n);
  return `${level.code || level.n} - ${level.l || ''}`;
}

function getStep(config = {}) {
  // Accepts wizard IDs ('integer' | 'half' | 'one-decimal') and legacy aliases.
  const p = config?.scorePrecision;
  if (p === 'tenth' || p === 'one-decimal') return 0.1;
  if (p === 'half') return 0.5;
  return 1;
}

// Normalize wizard's scoreInputMode IDs to the widget's internal mode names.
function getMode(config = {}) {
  const raw = String(config?.scoreInputMode || 'dropdown').toLowerCase();
  if (raw === 'segmented' || raw === 'band' || raw === 'pills' || raw === 'band-pills') return 'band';
  if (raw === 'number' || raw === 'numeric') return 'numeric';
  if (raw === 'stars' || raw === 'star') return 'stars';
  if (raw === 'slider' || raw === 'range') return 'slider';
  return 'dropdown';
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

function roundToStep(value, step) {
  if (step >= 1) return Math.round(value);
  const inv = Math.round(1 / step);
  return Math.round(value * inv) / inv;
}

export function RatingWidget({ value, onChange, config, disabled, suggestedScore = null }) {
  const scale = useMemo(() => getScaleLevels(config), [config]);
  const N = scale.length;
  const step = getStep(config);
  const mode = getMode(config);

  if (mode === 'dropdown') {
    // Only treat it as "selected" (blue) when the value matches a real option —
    // otherwise it would show the placeholder but look selected.
    const matched = (value === null || value === undefined || value === '')
      ? null
      : scale.find((l) => String(l.n) === String(Number(value)));
    const selVal = matched ? String(matched.n) : '';
    return (
      <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <select
          value={selVal}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}
          style={{
            padding: '8px 12px', borderRadius: 8, fontSize: 13, fontWeight: 700,
            border: `1.5px solid ${selVal ? '#2563EB' : '#CBD5E1'}`,
            background: selVal ? '#EFF6FF' : '#fff',
            color: selVal ? '#1D4ED8' : '#64748B',
            cursor: disabled ? 'not-allowed' : 'pointer', fontFamily: 'inherit',
            minWidth: 190, maxWidth: '100%',
          }}>
          <option value="">Select a rating…</option>
          {scale.map((lvl) => (
            <option key={lvl.n} value={lvl.n}>{formatChoice(lvl, config)}</option>
          ))}
        </select>
        {suggestedScore !== null && suggestedScore !== undefined && (
          <SuggestedChip value={suggestedScore} onClick={() => onChange(suggestedScore)} disabled={disabled} />
        )}
      </div>
    );
  }

  if (mode === 'band') {
    // Position the tooltip on hover and clamp it inside the nearest clipping
    // ancestor (goal cards use overflow:hidden), so edge buttons never get cut off.
    const positionTooltip = (wrap) => {
      const tip = wrap.querySelector('.rating-choice-tooltip');
      const btn = wrap.querySelector('button');
      if (!tip || !btn) return;
      tip.classList.remove('rt-above');
      tip.style.left = '0px';
      const tipRect = tip.getBoundingClientRect();
      const tipWidth = tipRect.width;
      const tipHeight = tipRect.height;
      const btnRect = btn.getBoundingClientRect();
      const wrapLeft = wrap.getBoundingClientRect().left;
      let bound = { left: 0, right: window.innerWidth, top: 0, bottom: window.innerHeight };
      let p = wrap.parentElement;
      while (p) {
        const s = getComputedStyle(p);
        const clips = [s.overflow, s.overflowX, s.overflowY].some(
          (v) => v === 'hidden' || v === 'auto' || v === 'scroll' || v === 'clip'
        );
        if (clips) {
          const r = p.getBoundingClientRect();
          bound = { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
          break;
        }
        p = p.parentElement;
      }
      const pad = 6;
      const btnCenter = btnRect.left + btnRect.width / 2;
      let left = btnCenter - tipWidth / 2;
      left = Math.max(bound.left + pad, Math.min(left, bound.right - pad - tipWidth));
      tip.style.left = `${left - wrapLeft}px`;
      tip.style.setProperty('--arrow-left', `${btnCenter - left}px`);
      // Flip above when there isn't room below inside the clipping ancestor.
      const fitsBelow = btnRect.bottom + 8 + tipHeight <= bound.bottom - pad;
      const fitsAbove = btnRect.top - 8 - tipHeight >= bound.top + pad;
      if (!fitsBelow && fitsAbove) tip.classList.add('rt-above');
    };
    return (
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
        <style>{`
          .rating-choice-wrap {
            position: relative;
            display: inline-flex;
          }
          .rating-choice-tooltip {
            position: absolute;
            top: calc(100% + 8px);
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
          .rating-choice-wrap:hover .rating-choice-tooltip {
            opacity: 1;
          }
          .rating-choice-tooltip::after {
            content: "";
            position: absolute;
            bottom: 100%;
            left: var(--arrow-left, 50%);
            width: 8px;
            height: 8px;
            background: #0F172A;
            transform: translate(-50%, 4px) rotate(45deg);
          }
          .rating-choice-tooltip.rt-above {
            top: auto;
            bottom: calc(100% + 8px);
          }
          .rating-choice-tooltip.rt-above::after {
            bottom: auto;
            top: 100%;
            transform: translate(-50%, -4px) rotate(45deg);
          }
        `}</style>
        {scale.map((lvl) => {
          const on = Number(value) === lvl.n;
          const hoverLabel = lvl.l ? `${lvl.code || lvl.n} - ${lvl.l}` : String(lvl.code || lvl.n);
          return (
            <span key={lvl.n} className="rating-choice-wrap" onMouseEnter={(e) => positionTooltip(e.currentTarget)}>
              <button
                type="button" disabled={disabled}
                aria-label={hoverLabel}
                onClick={() => onChange(lvl.n)}
                style={{
                  padding: '6px 12px', borderRadius: 8, fontSize: 12.5, fontWeight: 700,
                  border: `1.5px solid ${on ? '#2563EB' : '#CBD5E1'}`,
                  background: on ? '#EFF6FF' : '#fff',
                  color: on ? '#1D4ED8' : '#475569',
                  cursor: disabled ? 'not-allowed' : 'pointer', fontFamily: 'inherit',
                  transition: 'border-color 120ms ease, background 120ms ease, color 120ms ease, transform 120ms ease',
                }}>
                {formatChoice(lvl, config)}
              </button>
              <span className="rating-choice-tooltip" role="tooltip">{hoverLabel}</span>
            </span>
          );
        })}
        {suggestedScore !== null && suggestedScore !== undefined && (
          <SuggestedChip value={suggestedScore} onClick={() => onChange(suggestedScore)} disabled={disabled} />
        )}
      </div>
    );
  }

  if (mode === 'stars') {
    return (
      <StarsRating
        N={N} step={step} value={value} onChange={onChange} disabled={disabled}
        suggested={suggestedScore}
      />
    );
  }

  if (mode === 'numeric') {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <input
          type="number" min={0} max={N} step={step} value={value ?? ''}
          disabled={disabled}
          onChange={(e) => {
            const raw = e.target.value;
            if (raw === '') return onChange(null);
            const num = clamp(Number(raw), 0, N);
            onChange(roundToStep(num, step));
          }}
          style={{ width: 90, padding: '6px 8px', border: '1px solid #CBD5E1', borderRadius: 8, fontSize: 13 }}
        />
        <span style={{ fontSize: 12, color: '#64748B' }}>out of {N}</span>
        {suggestedScore !== null && suggestedScore !== undefined && (
          <SuggestedChip value={suggestedScore} onClick={() => onChange(suggestedScore)} disabled={disabled} />
        )}
      </div>
    );
  }

  if (mode === 'slider') {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 260 }}>
        <input
          type="range" min={0} max={N} step={step} value={value || 0}
          disabled={disabled}
          onChange={(e) => onChange(Number(e.target.value))}
          style={{ flex: 1 }}
        />
        <div style={{ width: 80, textAlign: 'right', fontSize: 13, fontWeight: 700 }}>
          {value ? `${Number(value).toFixed(step === 1 ? 0 : 1)} / ${N}` : `— / ${N}`}
        </div>
        {suggestedScore !== null && suggestedScore !== undefined && (
          <SuggestedChip value={suggestedScore} onClick={() => onChange(suggestedScore)} disabled={disabled} />
        )}
      </div>
    );
  }

  return (
    <StarsRating
      N={N} step={step} value={value} onChange={onChange} disabled={disabled}
      suggested={suggestedScore}
    />
  );
}

function StarsRating({ N, step, value, onChange, disabled, suggested }) {
  const containerRef = useRef(null);
  const [hoverVal, setHoverVal] = useState(null);
  const [dragging, setDragging] = useState(false);

  const computeFromX = (clientX) => {
    const el = containerRef.current;
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    const x = clientX - rect.left;
    const fraction = Math.max(0, Math.min(1, x / rect.width));
    let raw = fraction * N;
    raw = roundToStep(raw, step);
    return clamp(raw, 0, N);
  };

  useEffect(() => {
    if (!dragging) return;
    const move = (e) => {
      const v = computeFromX(e.clientX);
      if (v !== null) {
        setHoverVal(v);
        onChange(v);
      }
    };
    const up = () => setDragging(false);
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    return () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dragging, N, step]);

  const handleDown = (e) => {
    if (disabled) return;
    e.preventDefault();
    const v = computeFromX(e.clientX);
    if (v !== null) onChange(v);
    setDragging(true);
  };

  // Only reflect the dragged value — never a blank hover, so stars stay put until clicked/dragged.
  const display = (dragging && hoverVal !== null) ? hoverVal : (Number(value) || 0);
  const numericLabel = value ? `${Number(value).toFixed(step === 1 ? 0 : 1)} / ${N}` : `— / ${N}`;

  return (
    <div style={{ display: 'inline-flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
      <div
        ref={containerRef}
        onMouseDown={handleDown}
        role="slider"
        aria-valuemin={0}
        aria-valuemax={N}
        aria-valuenow={Number(value) || 0}
        tabIndex={disabled ? -1 : 0}
        onKeyDown={(e) => {
          if (disabled) return;
          if (e.key === 'ArrowRight' || e.key === 'ArrowUp') {
            e.preventDefault();
            onChange(clamp(roundToStep((Number(value) || 0) + step, step), 0, N));
          } else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') {
            e.preventDefault();
            onChange(clamp(roundToStep((Number(value) || 0) - step, step), 0, N));
          }
        }}
        style={{
          display: 'inline-flex',
          gap: 4,
          padding: '6px 8px',
          cursor: disabled ? 'not-allowed' : 'pointer',
          userSelect: 'none',
          background: dragging ? '#FFFBEB' : 'transparent',
          borderRadius: 8,
          border: `1px solid ${dragging ? '#FCD34D' : 'transparent'}`,
          transition: 'background 0.1s, border-color 0.1s',
          outline: 'none',
        }}>
        {Array.from({ length: N }, (_, i) => {
          const fill = clamp(display - i, 0, 1);
          return (
            <div key={i} style={{ position: 'relative', fontSize: 28, lineHeight: 1, width: '1em', height: '1em' }}>
              <span style={{ position: 'absolute', top: 0, left: 0, color: '#E2E8F0' }}>★</span>
              <span style={{
                position: 'absolute', top: 0, left: 0,
                color: '#F59E0B',
                width: `${fill * 100}%`,
                overflow: 'hidden',
                display: 'inline-block',
                whiteSpace: 'nowrap',
              }}>★</span>
            </div>
          );
        })}
      </div>
      <div style={{ fontSize: 14, fontWeight: 800, color: value ? '#0F172A' : '#94A3B8', minWidth: 60, fontVariantNumeric: 'tabular-nums' }}>
        {numericLabel}
      </div>
      {suggested !== null && suggested !== undefined && (
        <SuggestedChip value={suggested} onClick={() => onChange(suggested)} disabled={disabled} />
      )}
    </div>
  );
}

function SuggestedChip({ value, onClick, disabled }) {
  return (
    <button
      type="button" onClick={onClick} disabled={disabled}
      style={{
        padding: '4px 9px', borderRadius: 14, fontSize: 11, fontWeight: 700,
        border: '1px dashed #2563EB', background: '#EFF6FF', color: '#1D4ED8',
        cursor: disabled ? 'not-allowed' : 'pointer', fontFamily: 'inherit',
      }}>
      Auto: {value} (use)
    </button>
  );
}

// Compute auto-rated score for an achievement %, based on wizard's bands.
export function autoScoreFromAchievement(achievementPct, bands = []) {
  if (achievementPct === null || achievementPct === undefined) return null;
  const num = Number(achievementPct);
  if (!Number.isFinite(num)) return null;
  for (const band of (bands || [])) {
    const from = Number(band.from);
    const to = band.to === '' || band.to === undefined ? Infinity : Number(band.to);
    if (Number.isFinite(from) && num >= from && num <= to) return Number(band.point);
  }
  return null;
}
