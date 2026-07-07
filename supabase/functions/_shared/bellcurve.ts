export type BellBand = { rating_point: number; target_percent: number; tolerance_percent: number };
export type BellRow = {
  point: number; count: number; actualPercent: number;
  targetPercent: number; tolerancePercent: number; withinTolerance: boolean;
};

// Nearest scale point to a score; ties round to the higher point.
export function nearestPoint(score: number, points: number[]): number | null {
  if (points.length === 0) return null;
  let best = points[0];
  let bestDist = Infinity;
  for (const p of points) {
    const d = Math.abs(p - score);
    if (d < bestDist || (d === bestDist && p > best)) { bestDist = d; best = p; }
  }
  return best;
}

function round2(n: number): number { return Math.round((n + Number.EPSILON) * 100) / 100; }

export function computeBellCurve(
  scores: number[], points: number[], bands: BellBand[],
): { rows: BellRow[]; withinTolerance: boolean } {
  const total = scores.length;
  const counts = new Map<number, number>();
  for (const s of scores) {
    const p = nearestPoint(s, points);
    if (p != null) counts.set(p, (counts.get(p) ?? 0) + 1);
  }
  // Row set = union of band points and observed points.
  const bandByPoint = new Map(bands.map((b) => [b.rating_point, b]));
  const rowPoints = new Set<number>([...bandByPoint.keys(), ...counts.keys()]);
  const rows: BellRow[] = [];
  let overall = true;
  for (const point of [...rowPoints].sort((a, b) => a - b)) {
    const count = counts.get(point) ?? 0;
    const actualPercent = total === 0 ? 0 : round2((count / total) * 100);
    const band = bandByPoint.get(point);
    const targetPercent = band?.target_percent ?? 0;
    const tolerancePercent = band?.tolerance_percent ?? 0;
    // Only band-constrained points can violate; and empty distributions never violate.
    const withinTolerance = !band || total === 0
      ? true
      : Math.abs(actualPercent - targetPercent) <= tolerancePercent + 1e-9;
    if (!withinTolerance) overall = false;
    rows.push({ point, count, actualPercent, targetPercent, tolerancePercent, withinTolerance });
  }
  return { rows, withinTolerance: overall };
}
