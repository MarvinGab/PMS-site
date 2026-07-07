import { ApiError, HandlerCtx } from './kernel.ts';
import { isHrOrSuper } from './scope.ts';

type Window = { window_key: string; starts_on: string; ends_on: string };

// Pure: is `windowKey` open on `todayIso` (YYYY-MM-DD, inclusive bounds)?
export function pureWindowOpen(windows: Window[], windowKey: string, todayIso: string): boolean {
  const w = windows.find((x) => x.window_key === windowKey);
  if (!w) return false;
  return w.starts_on <= todayIso && todayIso <= w.ends_on;
}

function todayIso(): string {
  // Edge runtime allows Date; use UTC date. (Cycle windows are date-granular.)
  return new Date().toISOString().slice(0, 10);
}

export async function requireWindowOrHr(
  ctx: HandlerCtx, orgId: string, cycleId: string, windowKey: string,
): Promise<void> {
  if (isHrOrSuper(ctx, orgId)) return;
  const { data, error } = await ctx.admin.from('cycle_phase_windows')
    .select('window_key, starts_on, ends_on').eq('cycle_id', cycleId).eq('organization_id', orgId);
  if (error) { console.error('requireWindow read', error); throw new ApiError('DB_ERROR', 'Database error', 500); }
  if (!pureWindowOpen((data ?? []) as Window[], windowKey, todayIso())) {
    throw new ApiError('WINDOW_CLOSED', `The ${windowKey.replace('_', ' ')} window is not open`, 409);
  }
}

export async function loadActiveCycle(ctx: HandlerCtx, orgId: string, cycleId: string) {
  const { data: cycle, error } = await ctx.admin.from('appraisal_cycles')
    .select().eq('id', cycleId).eq('organization_id', orgId).maybeSingle();
  if (error) { console.error('loadActiveCycle', error); throw new ApiError('DB_ERROR', 'Database error', 500); }
  if (!cycle) throw new ApiError('NOT_FOUND', 'Cycle not found', 404);
  if (cycle.status !== 'active') throw new ApiError('CYCLE_NOT_ACTIVE', `The cycle is ${cycle.status}, not active`, 409);
  return cycle;
}
