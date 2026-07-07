import { assertThrows } from 'jsr:@std/assert@1';
import { ApiError } from '../_shared/kernel.ts';
import { validateGoalTree } from './goalrules.ts';

const rules = {
  min_kras: 1, max_kras: 3, min_kpis_per_kra: 1, max_kpis_per_kra: 3,
  min_kra_weight: null, max_kra_weight: null, min_kpi_weight: null,
};
const kra = (key: string, weight: number) => ({ key, itemType: 'kra', parentKey: null, weight });
const kpi = (key: string, parentKey: string, weight: number) => ({ key, itemType: 'kpi', parentKey, weight });

Deno.test('a valid tree passes', () => {
  validateGoalTree([kra('a', 100), kpi('a1', 'a', 100)], rules); // no throw
});

Deno.test('too few KRAs fails', () => {
  assertThrows(() => validateGoalTree([], rules), ApiError);
});

Deno.test('too many KRAs fails', () => {
  assertThrows(() => validateGoalTree([kra('a', 25), kra('b', 25), kra('c', 25), kra('d', 25)]
    .flatMap((k) => [k, kpi(`${k.key}1`, k.key, 100)]), rules), ApiError);
});

Deno.test('KRA weights not summing to 100 fails', () => {
  assertThrows(() => validateGoalTree([kra('a', 60), kpi('a1', 'a', 100)], rules), ApiError);
});

Deno.test('KPI weights within a KRA not summing to 100 fails', () => {
  assertThrows(() => validateGoalTree([kra('a', 100), kpi('a1', 'a', 60), kpi('a2', 'a', 30)], rules), ApiError);
});

Deno.test('a KRA with no KPIs fails min_kpis_per_kra', () => {
  assertThrows(() => validateGoalTree([kra('a', 100)], rules), ApiError);
});

Deno.test('a mix of weighted and null-weight KRAs fails', () => {
  assertThrows(() => validateGoalTree(
    [kra('a', 100), kpi('a1', 'a', 100), kra('b', null as unknown as number), kpi('b1', 'b', 100)], rules), ApiError);
});
