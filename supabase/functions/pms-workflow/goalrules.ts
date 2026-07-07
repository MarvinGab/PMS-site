import { ApiError } from '../_shared/kernel.ts';

export type GoalNode = {
  key: string; itemType: string; parentKey: string | null; weight: number | null;
};
export type GoalRules = {
  min_kras: number | null; max_kras: number | null;
  min_kpis_per_kra: number | null; max_kpis_per_kra: number | null;
  min_kra_weight: number | null; max_kra_weight: number | null; min_kpi_weight: number | null;
};

const EPS = 0.01;
function bad(msg: string): never { throw new ApiError('GOAL_RULES', msg, 422); }
function sum(ns: number[]): number { return ns.reduce((a, b) => a + b, 0); }

export function validateGoalTree(items: GoalNode[], rules: GoalRules): void {
  const kras = items.filter((i) => i.itemType === 'kra');
  const kpis = items.filter((i) => i.itemType === 'kpi');

  if (rules.min_kras != null && kras.length < rules.min_kras) bad(`At least ${rules.min_kras} KRA(s) required`);
  if (rules.max_kras != null && kras.length > rules.max_kras) bad(`At most ${rules.max_kras} KRA(s) allowed`);

  const kraKeys = new Set(kras.map((k) => k.key));
  for (const kpi of kpis) {
    if (!kpi.parentKey || !kraKeys.has(kpi.parentKey)) bad(`KPI "${kpi.key}" must belong to a KRA in this plan`);
  }

  for (const kra of kras) {
    const children = kpis.filter((k) => k.parentKey === kra.key);
    if (rules.min_kpis_per_kra != null && children.length < rules.min_kpis_per_kra) {
      bad(`KRA "${kra.key}" needs at least ${rules.min_kpis_per_kra} KPI(s)`);
    }
    if (rules.max_kpis_per_kra != null && children.length > rules.max_kpis_per_kra) {
      bad(`KRA "${kra.key}" allows at most ${rules.max_kpis_per_kra} KPI(s)`);
    }
    if (rules.min_kra_weight != null && kra.weight != null && kra.weight < rules.min_kra_weight) {
      bad(`KRA "${kra.key}" weight is below the minimum ${rules.min_kra_weight}`);
    }
    if (rules.max_kra_weight != null && kra.weight != null && kra.weight > rules.max_kra_weight) {
      bad(`KRA "${kra.key}" weight is above the maximum ${rules.max_kra_weight}`);
    }
    const childWeights = children.map((c) => c.weight).filter((w): w is number => w != null);
    if (childWeights.length > 0) {
      if (rules.min_kpi_weight != null && childWeights.some((w) => w < rules.min_kpi_weight!)) {
        bad(`A KPI under "${kra.key}" is below the minimum weight ${rules.min_kpi_weight}`);
      }
      if (Math.abs(sum(childWeights) - 100) > EPS) bad(`KPI weights under "${kra.key}" must sum to 100`);
    }
  }

  const kraWeights = kras.map((k) => k.weight).filter((w): w is number => w != null);
  if (kraWeights.length > 0 && Math.abs(sum(kraWeights) - 100) > EPS) {
    bad('KRA weights must sum to 100');
  }
}
