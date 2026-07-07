import { assertEquals } from 'jsr:@std/assert@1';
import { computeBellCurve, nearestPoint } from './bellcurve.ts';

Deno.test('nearestPoint picks the closest scale point', () => {
  assertEquals(nearestPoint(4.2, [1, 2, 3, 4, 5]), 4);
  assertEquals(nearestPoint(3.5, [1, 2, 3, 4, 5]), 4); // ties round up to the higher point
  assertEquals(nearestPoint(0.9, [2, 3, 5]), 2);
  assertEquals(nearestPoint(5, []), null);
});

Deno.test('computeBellCurve flags within/out of tolerance', () => {
  // 10 people: 2 at point2, 6 at point3, 2 at point5. bands target 20/60/20 ±5.
  const scores = [2, 2, 3, 3, 3, 3, 3, 3, 5, 5];
  const points = [2, 3, 5];
  const bands = [
    { rating_point: 2, target_percent: 20, tolerance_percent: 5 },
    { rating_point: 3, target_percent: 60, tolerance_percent: 5 },
    { rating_point: 5, target_percent: 20, tolerance_percent: 5 },
  ];
  const res = computeBellCurve(scores, points, bands);
  assertEquals(res.withinTolerance, true);
  assertEquals(res.rows.find((r) => r.point === 3)?.actualPercent, 60);
});

Deno.test('computeBellCurve detects a violation outside tolerance', () => {
  // Everyone at point 5 → 100% vs target 20 ±5 → violation.
  const scores = [5, 5, 5, 5];
  const points = [2, 3, 5];
  const bands = [
    { rating_point: 2, target_percent: 20, tolerance_percent: 5 },
    { rating_point: 3, target_percent: 60, tolerance_percent: 5 },
    { rating_point: 5, target_percent: 20, tolerance_percent: 5 },
  ];
  const res = computeBellCurve(scores, points, bands);
  assertEquals(res.withinTolerance, false);
  assertEquals(res.rows.find((r) => r.point === 5)?.withinTolerance, false);
});

Deno.test('no bands means no constraint', () => {
  const res = computeBellCurve([3, 3, 5], [2, 3, 5], []);
  assertEquals(res.withinTolerance, true);
});

Deno.test('empty scores are within tolerance (nothing to distribute)', () => {
  const bands = [{ rating_point: 3, target_percent: 100, tolerance_percent: 0 }];
  const res = computeBellCurve([], [3], bands);
  assertEquals(res.withinTolerance, true);
});
