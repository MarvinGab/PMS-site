export type Band = { from_percent: number; to_percent: number; score: number };
export type ScoredItem = {
  itemId: string; itemType: 'kra' | 'kpi'; parentId: string | null;
  weight: number | null; score: number | null;
};

export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

export function achievementPercent(actual: number | null, target: number | null, lowerIsBetter: boolean): number | null {
  if (actual == null || target == null) return null;
  let pct: number;
  if (lowerIsBetter) {
    if (actual === 0) return 200;
    pct = (target / actual) * 100;
  } else {
    if (target === 0) return null;
    pct = (actual / target) * 100;
  }
  pct = Math.max(0, Math.min(200, pct));
  return round2(pct);
}

export function ratingFromBands(pct: number | null, bands: Band[]): number | null {
  if (pct == null || bands.length === 0) return null;
  const containing = bands.find((b) => pct >= b.from_percent && pct <= b.to_percent);
  if (containing) return containing.score;
  // nearest by distance to the band range
  let best: Band | null = null;
  let bestDist = Infinity;
  for (const b of bands) {
    const dist = pct < b.from_percent ? b.from_percent - pct : pct - b.to_percent;
    if (dist < bestDist) { bestDist = dist; best = b; }
  }
  return best ? best.score : null;
}

// Weight-average a set of {weight, score}; null weights count as equal (1).
function weightedAverage(entries: { weight: number | null; score: number | null }[]): number | null {
  const scored = entries.filter((e) => e.score != null);
  if (scored.length === 0) return null;
  const anyWeight = scored.some((e) => e.weight != null && e.weight > 0);
  let num = 0, den = 0;
  for (const e of scored) {
    const w = anyWeight ? (e.weight ?? 0) : 1;
    num += w * (e.score as number);
    den += w;
  }
  return den === 0 ? null : num / den;
}

export function computeGoalScore(items: ScoredItem[], ratingLevel: 'kra' | 'kpi'): number | null {
  const kras = items.filter((i) => i.itemType === 'kra');
  if (ratingLevel === 'kra') {
    const avg = weightedAverage(kras.map((k) => ({ weight: k.weight, score: k.score })));
    return avg == null ? null : round2(avg);
  }
  // kpi level: roll each KRA's KPIs up, then average the KRA rollups
  const kraScores: { weight: number | null; score: number | null }[] = kras.map((kra) => {
    const kpis = items.filter((i) => i.itemType === 'kpi' && i.parentId === kra.itemId);
    const rolled = weightedAverage(kpis.map((k) => ({ weight: k.weight, score: k.score })));
    return { weight: kra.weight, score: rolled };
  });
  const avg = weightedAverage(kraScores);
  return avg == null ? null : round2(avg);
}

export function computeOverall(
  goalScore: number | null, competencyScore: number | null,
  competenciesEnabled: boolean, competencyWeight: number | null,
): number | null {
  if (!competenciesEnabled) {
    return goalScore == null ? null : round2(goalScore);
  }
  if (goalScore == null && competencyScore == null) return null;
  const cw = (competencyWeight ?? 0) / 100;
  const g = goalScore ?? 0;
  const c = competencyScore ?? 0; // no competency score → treat as 0, not goal-only
  return round2(g * (1 - cw) + c * cw);
}
