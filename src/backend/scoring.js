// Shared scoring + final-rating formatting.
// Mirrors the rating-scale logic configured in the wizard (PMSWizard.jsx) so every
// page shows the final score the same way the org configured it.

const SCALE_DEFAULTS = {
  3: [{ n: 1, l: 'Below Expectations' }, { n: 2, l: 'Meets Expectations' }, { n: 3, l: 'Exceeds Expectations' }],
  4: [{ n: 1, l: 'Below Expectations' }, { n: 2, l: 'Meets Expectations' }, { n: 3, l: 'Exceeds Expectations' }, { n: 4, l: 'Outstanding' }],
  5: [{ n: 1, l: 'Needs Improvement' }, { n: 2, l: 'Below Expectations' }, { n: 3, l: 'Meets Expectations' }, { n: 4, l: 'Exceeds Expectations' }, { n: 5, l: 'Outstanding' }],
  7: [{ n: 1, l: 'Unsatisfactory' }, { n: 2, l: 'Needs Improvement' }, { n: 3, l: 'Partially Meets' }, { n: 4, l: 'Meets Expectations' }, { n: 5, l: 'Exceeds Expectations' }, { n: 6, l: 'Strong Performance' }, { n: 7, l: 'Outstanding' }],
  10: Array.from({ length: 10 }, (_, i) => ({ n: i + 1, l: '' })),
};

function getScaleDefaults(points) {
  const n = Math.max(2, Math.min(10, Number(points) || 5));
  const defaults = SCALE_DEFAULTS[n] || Array.from({ length: n }, (_, i) => ({ n: i + 1, l: '' }));
  return defaults.map((item) => ({ ...item, code: String(item.n) }));
}

export function getScaleLevels(config = {}) {
  const points = Math.max(2, Math.min(10, Number(config.scalePoints) || 5));
  const defaults = getScaleDefaults(points);
  const labels = config.scaleLabels || {};
  const codes = config.scaleRankCodes || {};
  return defaults.map((item) => ({
    ...item,
    l: String(labels[item.n] || item.l),
    code: String(codes[item.n] ?? item.n),
  }));
}

export function getMergedRankRanges(scale, stored = {}) {
  const N = scale.length;
  return scale.map((s) => {
    const defFrom = s.n === 1 ? 1 : (s.n - 0.5);
    const defTo = s.n === N ? N : (s.n + 0.49);
    const v = stored[s.n] || {};
    const fromRaw = v.from === undefined || v.from === null || v.from === '' ? defFrom : Number(v.from);
    const toRaw = v.to === undefined || v.to === null || v.to === '' ? defTo : Number(v.to);
    return { n: s.n, from: fromRaw, to: toRaw };
  });
}

export function findRankForDecimal(decimal, ranges, scale) {
  for (let i = 0; i < ranges.length; i++) {
    const r = ranges[i];
    if (decimal >= r.from && decimal <= r.to + 0.005) return scale[i];
  }
  if (decimal < ranges[0]?.from) return scale[0];
  return scale[scale.length - 1];
}

const FINAL_RATING_DISPLAY_OPTIONS = [
  { id: 'code',          format: ({ code }) => String(code) },
  { id: 'code-label',    format: ({ code, l }) => `${code} - ${l}` },
  { id: 'label',         format: ({ l }) => String(l) },
  { id: 'decimal-code',  format: ({ code, decimal }) => `${decimal.toFixed(2)} - ${code}` },
  { id: 'decimal-label', format: ({ l, decimal }) => `${decimal.toFixed(2)} - ${l}` },
];

// Format a decimal score the way the org configured its FINAL rating display.
export function formatFinalRating(config = {}, decimal) {
  if (decimal === null || decimal === undefined || !Number.isFinite(Number(decimal))) return '';
  const d = Number(decimal);
  const scale = getScaleLevels(config);
  const ranges = getMergedRankRanges(scale, config.scaleRankRanges || {});
  const rank = findRankForDecimal(d, ranges, scale) || scale[scale.length - 1];
  const opt = FINAL_RATING_DISPLAY_OPTIONS.find((o) => o.id === (config.finalRatingDisplay || 'code-label'))
    || FINAL_RATING_DISPLAY_OPTIONS[1];
  return rank ? opt.format({ code: rank.code, l: rank.l, decimal: d }) : d.toFixed(2);
}

export function getScalePoints(config = {}) {
  return getScaleLevels(config).length;
}

const num = (v) => (v === null || v === undefined || v === '' ? null : (Number.isFinite(Number(v)) ? Number(v) : null));
const norm = (v) => String(v || '').trim().toLowerCase();
const positiveWeight = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : 0);

const DEFAULT_TARGET_TYPES = [
  { id: 'tt_default_number', name: 'Number', isNumeric: true },
  { id: 'tt_default_percentage', name: 'Percentage', isNumeric: true },
  { id: 'tt_default_currency', name: 'Currency', isNumeric: true },
  { id: 'tt_neg_number', name: 'Negative number', isNumeric: true, lowerIsBetter: true },
  { id: 'tt_neg_currency', name: 'Negative currency', isNumeric: true, lowerIsBetter: true },
  { id: 'tt_default_text', name: 'Free text', isNumeric: false },
];

function normalizeTargetTypeName(value) {
  return String(value || '').trim().toLowerCase().replace(/[_\s-]+/g, ' ');
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

function parseNumber(value) {
  const n = Number(String(value ?? '').replace(/,/g, '').trim());
  return Number.isFinite(n) ? n : null;
}

export function achievementPercentFromTarget(target, achievement, typeId, targetTypes = []) {
  const meta = getTargetTypeMeta(typeId, targetTypes);
  if (!meta?.isNumeric) return null;
  const targetNum = parseNumber(target);
  const achievedNum = parseNumber(achievement);
  if (targetNum === null || achievedNum === null || targetNum <= 0) return null;
  // "Lower is better" targets (negative number / negative currency): coming in
  // UNDER the target is the win, so the ratio is inverted — hitting half the
  // target reads as 200%, hitting the target reads as 100%, and reaching 0 is
  // the best possible outcome. This feeds the same achievement bands as normal.
  if (meta.lowerIsBetter) {
    if (achievedNum <= 0) return 200;
    return Math.round((targetNum / achievedNum) * 100);
  }
  return Math.round((achievedNum / targetNum) * 100);
}

export function autoScoreFromAchievement(achievementPct, bands = []) {
  if (achievementPct === null || achievementPct === undefined || achievementPct === '') return null;
  const pct = Number(achievementPct);
  if (!Number.isFinite(pct)) return null;
  for (const band of (bands || [])) {
    const from = Number(band.from);
    const to = band.to === '' || band.to === undefined ? Infinity : Number(band.to);
    if (Number.isFinite(from) && pct >= from && pct <= to) return Number(band.point);
  }
  return null;
}

function weightedAchievementPercent(rows) {
  const valid = rows.filter((row) => Number.isFinite(Number(row.percent)));
  if (!valid.length) return null;
  const totalWeight = valid.reduce((sum, row) => sum + positiveWeight(row.weight), 0);
  if (totalWeight > 0) {
    return valid.reduce((sum, row) => sum + Number(row.percent) * positiveWeight(row.weight), 0) / totalWeight;
  }
  return valid.reduce((sum, row) => sum + Number(row.percent), 0) / valid.length;
}

// Auto-rating follows the actual rating input level. If targets/achievements
// live below that level (KPI targets, KRA rating), KPI achievement percentages
// roll up using KPI weights before mapping to a score band.
export function computeGoalAutoRatings({
  kra = {},
  achievements = {},
  targetLevel = 'KPI',
  rateAtKpi = false,
  bands = [],
  targetTypes = [],
}) {
  const scores = {};
  const percents = {};
  const targetsAtKra = targetLevel === 'KRA';

  if (targetsAtKra) {
    const pct = achievementPercentFromTarget(kra.target, achievements[kra.id], kra.targetType, targetTypes);
    if (!rateAtKpi) {
      percents[kra.id] = pct;
      scores[kra.id] = autoScoreFromAchievement(pct, bands);
    }
    return { scores, percents };
  }

  const kpis = kra.kpis || [];
  const kpiRows = kpis
    .filter((kpi) => kpi.target !== undefined && kpi.target !== null && String(kpi.target).trim() !== '')
    .map((kpi) => {
      const pct = achievementPercentFromTarget(kpi.target, achievements[kpi.id], kpi.targetType, targetTypes);
      percents[kpi.id] = pct;
      if (rateAtKpi) scores[kpi.id] = autoScoreFromAchievement(pct, bands);
      return { id: kpi.id, percent: pct, weight: kpi.weight };
    });

  if (!rateAtKpi) {
    const pct = weightedAchievementPercent(kpiRows);
    percents[kra.id] = pct;
    scores[kra.id] = autoScoreFromAchievement(pct, bands);
  }

  return { scores, percents };
}

// One goal's score: KPI-weighted average when rated per KPI, else the goal's own score.
function goalScoreOf(kra, scores, rateAtKpi) {
  if (rateAtKpi) {
    const kpis = kra.kpis || [];
    if (!kpis.length) return num(scores[kra.id]);
    const rated = kpis
      .map((k) => ({ w: Number(k.weight) || 0, s: num(scores[k.id]) }))
      .filter((x) => x.s !== null);
    if (!rated.length) return null;
    const totW = rated.reduce((a, b) => a + b.w, 0);
    if (totW > 0) return rated.reduce((a, b) => a + b.s * b.w, 0) / totW;
    return rated.reduce((a, b) => a + b.s, 0) / rated.length;
  }
  return num(scores[kra.id]);
}

function goalCompleteness(kra, scores, rateAtKpi) {
  if (!rateAtKpi) {
    return { complete: num(scores[kra.id]) !== null, ratedItems: num(scores[kra.id]) !== null ? 1 : 0, totalItems: 1 };
  }
  const kpis = kra.kpis || [];
  if (!kpis.length) {
    const scored = num(scores[kra.id]) !== null;
    return { complete: scored, ratedItems: scored ? 1 : 0, totalItems: 1 };
  }
  const ratedItems = kpis.filter((kpi) => num(scores[kpi.id]) !== null).length;
  return { complete: ratedItems === kpis.length, ratedItems, totalItems: kpis.length };
}

function weightedAverage(rows, weightKey = 'weight') {
  const scored = rows.filter((row) => row.score !== null && row.score !== undefined);
  if (!scored.length) return null;
  const totalWeight = scored.reduce((sum, row) => sum + positiveWeight(row[weightKey]), 0);
  if (totalWeight > 0) {
    return scored.reduce((sum, row) => sum + row.score * positiveWeight(row[weightKey]), 0) / totalWeight;
  }
  return scored.reduce((sum, row) => sum + row.score, 0) / scored.length;
}

function computeGoalScore(config, goalRows) {
  const frameworkId = String(config?.frameworkId || '').trim().toLowerCase();
  const configuredPerspectives = (config?.perspectives || [])
    .map((p) => ({
      name: String(p?.name || '').trim(),
      weight: positiveWeight(p?.weight ?? p?.weightage),
    }))
    .filter((p) => p.name && p.weight > 0);

  const perspectiveByName = new Map(configuredPerspectives.map((p) => [norm(p.name), p]));
  const hasBscGoal = goalRows.some((row) => perspectiveByName.has(norm(row.perspectiveName)));
  const usePerspectiveWeighting = frameworkId === 'bsc' && configuredPerspectives.length > 0 && hasBscGoal;

  if (!usePerspectiveWeighting) {
    return {
      goalsScore: weightedAverage(goalRows),
      perspectiveRows: [],
      usesPerspectiveWeighting: false,
    };
  }

  const perspectiveRows = configuredPerspectives
    .map((perspective) => {
      const rows = goalRows.filter((row) => norm(row.perspectiveName) === norm(perspective.name));
      if (!rows.length) return null;
      return {
        name: perspective.name,
        weight: perspective.weight,
        rows,
        score: weightedAverage(rows),
        complete: rows.every((row) => row.complete),
      };
    })
    .filter(Boolean);

  return {
    goalsScore: weightedAverage(perspectiveRows),
    perspectiveRows,
    usesPerspectiveWeighting: true,
  };
}

// Blend goal scores + competency scores into a final, using the org's goal/competency split.
// Returns the full breakdown so the UI can show how it was computed.
export function computeSelfScoreBreakdown({
  config = {},
  goals = [],
  scores = {},
  rateAtKpi = false,
  competencies = [],
  compScores = {},
  competenciesSelfRated = true,
  resolved = {},
}) {
  const goalRows = goals.map((kra) => ({
    id: kra.id,
    name: kra.name || 'Goal',
    perspectiveName: kra.perspName || '',
    weight: Number(kra.weight) || 0,
    score: goalScoreOf(kra, scores, rateAtKpi),
    ...goalCompleteness(kra, scores, rateAtKpi),
  }));
  const { goalsScore, perspectiveRows, usesPerspectiveWeighting } = computeGoalScore(config, goalRows);
  const goalRatingScored = goalRows.reduce((sum, row) => sum + row.ratedItems, 0);
  const goalRatingTotal = goalRows.reduce((sum, row) => sum + row.totalItems, 0);
  const goalsComplete = goalRows.length > 0 && goalRows.every((row) => row.complete);

  const compEnabled = config.competenciesEnabled !== false && competencies.length > 0 && competenciesSelfRated;
  const compRows = competencies.map((name) => ({ name, score: num(compScores[name]) }));
  const scoredComps = compRows.filter((r) => r.score !== null);
  const compScore = scoredComps.length
    ? scoredComps.reduce((a, r) => a + r.score, 0) / scoredComps.length
    : null;
  const compsComplete = compRows.length > 0 && scoredComps.length === compRows.length;

  let compShare = 0;
  if (compEnabled) {
    const rShare = Number(resolved?.compShare);
    const fallback = Number.isFinite(Number(config.competencyWeight)) ? Number(config.competencyWeight) : 20;
    compShare = Math.max(0, Math.min(100, Number.isFinite(rShare) ? rShare : fallback));
  }
  const goalShare = 100 - compShare;

  // Final: blend whatever components are available; complete only when everything is scored.
  let final = null;
  if (compEnabled) {
    if (goalsScore !== null && compScore !== null) {
      final = goalsScore * (goalShare / 100) + compScore * (compShare / 100);
    } else if (goalsScore !== null) {
      final = goalsScore;           // provisional (competencies not scored yet)
    } else if (compScore !== null) {
      final = compScore;            // provisional (goals not scored yet)
    }
  } else {
    final = goalsScore;
  }
  const complete = goalsComplete && (!compEnabled || compsComplete);

  return {
    goalRows, goalsScore, goalsComplete,
    goalRatingScored, goalRatingTotal,
    perspectiveRows, usesPerspectiveWeighting,
    compEnabled, compRows, compScore, compsComplete,
    goalShare, compShare,
    final, complete,
    scalePoints: getScalePoints(config),
  };
}
