import { assertEquals } from 'jsr:@std/assert@1';
import {
  achievementPercent, computeGoalScore, computeOverall, ratingFromBands, round2,
} from './scoring.ts';

Deno.test('achievementPercent upper-is-better', () => {
  assertEquals(achievementPercent(80, 100, false), 80);
  assertEquals(achievementPercent(120, 100, false), 120);
  assertEquals(achievementPercent(250, 100, false), 200); // clamp
});

Deno.test('achievementPercent lower-is-better', () => {
  assertEquals(achievementPercent(5, 10, true), 200);   // target/actual capped
  assertEquals(achievementPercent(10, 10, true), 100);
  assertEquals(achievementPercent(20, 10, true), 50);
  assertEquals(achievementPercent(0, 10, true), 200);   // actual 0 → best
});

Deno.test('achievementPercent null cases', () => {
  assertEquals(achievementPercent(null, 100, false), null);
  assertEquals(achievementPercent(80, null, false), null);
  assertEquals(achievementPercent(80, 0, false), null);  // divide by zero, upper
});

Deno.test('ratingFromBands picks the containing band, then nearest', () => {
  const bands = [
    { from_percent: 0, to_percent: 59, score: 2 },
    { from_percent: 60, to_percent: 89, score: 3 },
    { from_percent: 90, to_percent: 200, score: 5 },
  ];
  assertEquals(ratingFromBands(75, bands), 3);
  assertEquals(ratingFromBands(90, bands), 5);
  assertEquals(ratingFromBands(59, bands), 2);
  assertEquals(ratingFromBands(null, bands), null);
  assertEquals(ratingFromBands(75, []), null);
});

Deno.test('computeGoalScore rolls KPIs into KRAs into overall (kpi level)', () => {
  // KRA a (weight 60): kpi a1(w100,score4). KRA b (weight 40): kpi b1(w100,score2).
  const items = [
    { itemId: 'a', itemType: 'kra' as const, parentId: null, weight: 60, score: null },
    { itemId: 'a1', itemType: 'kpi' as const, parentId: 'a', weight: 100, score: 4 },
    { itemId: 'b', itemType: 'kra' as const, parentId: null, weight: 40, score: null },
    { itemId: 'b1', itemType: 'kpi' as const, parentId: 'b', weight: 100, score: 2 },
  ];
  // a=4, b=2 → 4*0.6 + 2*0.4 = 3.2
  assertEquals(computeGoalScore(items, 'kpi'), 3.2);
});

Deno.test('computeGoalScore at kra level uses KRA scores directly', () => {
  const items = [
    { itemId: 'a', itemType: 'kra' as const, parentId: null, weight: 50, score: 4 },
    { itemId: 'b', itemType: 'kra' as const, parentId: null, weight: 50, score: 3 },
  ];
  assertEquals(computeGoalScore(items, 'kra'), 3.5);
});

Deno.test('computeGoalScore null when nothing scored', () => {
  assertEquals(computeGoalScore([{ itemId: 'a', itemType: 'kra', parentId: null, weight: 100, score: null }], 'kra'), null);
});

Deno.test('computeOverall blends competencies', () => {
  assertEquals(computeOverall(4, 2, true, 25), 3.5);   // 4*0.75 + 2*0.25
  assertEquals(computeOverall(4, 2, false, 25), 4);    // disabled → goal
  assertEquals(computeOverall(4, null, true, 25), 4);  // enabled but no competency score yet → goal-only
});

Deno.test('round2', () => {
  assertEquals(round2(3.14159), 3.14);
  assertEquals(round2(3.2), 3.2);
});
