// Ratings store — local-first, mirrors the workflow store pattern.
//
// Shape per org:
//   {
//     ratings: {
//       [empCode]: {
//         self:    { kraScores: {kraId: { score, comment }}, kpiScores: {kpiId: { score, comment }},
//                    competencyScores: {name: { score, comment }}, overallComment, submittedAt },
//         manager: { ...same shape..., overrideReasons: {targetId: text}, submittedAt },
//         final:   { ...same shape..., movedBy, movedAt, calibrationNote },
//       }
//     },
//     auditLog: [
//       { ts, action, actor, empCode, before, after, reason }
//     ],
//     publishedAt: <ISO> | null,
//   }
//
// Stage progression: self → manager → final (HR review locks via publish).

import { shouldUseSupabase } from './config';
import { supabase } from './supabaseClient';

const KEY_PREFIX = 'zarohr_ratings_v1';
const REMOTE_RECORD_KEY = 'ratings';
const DEFAULT_RATINGS_STATE = { ratings: {}, auditLog: [], publishedAt: null };
const remoteWriteQueues = new Map();

function key(orgKey) {
  return `${KEY_PREFIX}:${orgKey || 'default'}`;
}

function normCode(value) {
  return String(value || '').trim().toUpperCase();
}

function timestampOf(value) {
  const candidates = [
    value?.updatedAt,
    value?.submittedAt,
    value?.calibratedAt,
    value?.completionRequested?.at,
  ].filter(Boolean);
  const ms = candidates
    .map((v) => Date.parse(v))
    .filter((n) => Number.isFinite(n));
  return ms.length ? Math.max(...ms) : 0;
}

function mergeStage(remoteStage, localStage) {
  if (!remoteStage) return localStage || null;
  if (!localStage) return remoteStage || null;
  return timestampOf(localStage) >= timestampOf(remoteStage) ? localStage : remoteStage;
}

function mergeAuditLogs(remoteLogs = [], localLogs = []) {
  const out = [];
  const seen = new Set();
  [...remoteLogs, ...localLogs].forEach((row) => {
    if (!row) return;
    const id = [row.ts, row.action, row.actor, row.empCode, row.reason].map((v) => String(v ?? '')).join('|');
    if (seen.has(id)) return;
    seen.add(id);
    out.push(row);
  });
  return out.sort((a, b) => (Date.parse(a?.ts || 0) || 0) - (Date.parse(b?.ts || 0) || 0));
}

function mergeRatingsState(remote = DEFAULT_RATINGS_STATE, local = DEFAULT_RATINGS_STATE) {
  const remoteRatings = remote?.ratings || {};
  const localRatings = local?.ratings || {};
  const codeMap = new Map();
  Object.keys(remoteRatings).forEach((code) => codeMap.set(normCode(code), code));
  Object.keys(localRatings).forEach((code) => {
    const normalized = normCode(code);
    if (!codeMap.has(normalized)) codeMap.set(normalized, code);
  });

  const ratings = {};
  codeMap.forEach((storeCode, normalized) => {
    const remoteKey = Object.keys(remoteRatings).find((code) => normCode(code) === normalized);
    const localKey = Object.keys(localRatings).find((code) => normCode(code) === normalized);
    const r = remoteKey ? remoteRatings[remoteKey] || {} : {};
    const l = localKey ? localRatings[localKey] || {} : {};
    ratings[storeCode] = {
      ...r,
      ...l,
      self: mergeStage(r.self, l.self),
      manager: mergeStage(r.manager, l.manager),
      final: mergeStage(r.final, l.final),
    };
  });

  const remotePublished = remote?.publishedAt ? Date.parse(remote.publishedAt) || 0 : 0;
  const localPublished = local?.publishedAt ? Date.parse(local.publishedAt) || 0 : 0;
  const publishedFrom = localPublished >= remotePublished ? local : remote;

  return {
    ...remote,
    ...local,
    ratings,
    auditLog: mergeAuditLogs(remote?.auditLog || [], local?.auditLog || []),
    publishedAt: publishedFrom?.publishedAt || null,
    publishedBy: publishedFrom?.publishedBy || '',
    publishReason: publishedFrom?.publishReason || '',
  };
}

function readJson(k, fallback) {
  if (typeof window === 'undefined') return fallback;
  try {
    const raw = window.localStorage.getItem(k);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(k, value) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(k, JSON.stringify(value));
    // Fire a hashchange-like event so listeners can refresh on cross-tab edits.
    window.dispatchEvent(new CustomEvent('zarohr-ratings-changed', { detail: { key: k } }));
  } catch {
    // ignore quota errors — surfaces as missing data on next read
  }
}

export function readRatings(orgKey) {
  return readJson(key(orgKey), DEFAULT_RATINGS_STATE);
}

export function writeRatings(orgKey, data) {
  const payload = data || DEFAULT_RATINGS_STATE;
  writeJson(key(orgKey), payload);
  void persistRatings(orgKey, payload);
}

async function readRemoteRatings(orgKey = '') {
  if (!shouldUseSupabase || !supabase) return null;
  try {
    const { data, error } = await supabase
      .from('app_state')
      .select('payload')
      .eq('state_key', REMOTE_RECORD_KEY)
      .eq('org_key', orgKey || '')
      .maybeSingle();
    if (error) throw error;
    return data?.payload || null;
  } catch (error) {
    console.warn('[ratings:remote-read]', error);
    return null;
  }
}

export async function hydrateRatings(orgKey = '') {
  const local = readRatings(orgKey);
  if (!shouldUseSupabase || !supabase) return local;
  const remote = await readRemoteRatings(orgKey);
  if (!remote) {
    if (Object.keys(local?.ratings || {}).length > 0) await persistRatings(orgKey, local);
    return local;
  }
  const merged = mergeRatingsState(remote, local);
  writeJson(key(orgKey), merged);
  if (JSON.stringify(merged) !== JSON.stringify(remote)) await persistRatings(orgKey, merged);
  return merged;
}

export function persistRatings(orgKey = '', payload = null) {
  if (!shouldUseSupabase || !supabase) return Promise.resolve(true);
  const queueKey = orgKey || 'default';
  const writePayload = payload || readRatings(orgKey);
  const run = async () => {
    try {
      const remote = await readRemoteRatings(orgKey);
      const merged = remote ? mergeRatingsState(remote, writePayload) : writePayload;
      const { error } = await supabase
        .from('app_state')
        .upsert({
          state_key: REMOTE_RECORD_KEY,
          org_key: orgKey || '',
          payload: merged,
          updated_at: new Date().toISOString(),
        }, { onConflict: 'state_key,org_key' });
      if (error) throw error;
      writeJson(key(orgKey), merged);
      return true;
    } catch (error) {
      console.warn('[ratings:remote-write]', error);
      return false;
    }
  };
  const previous = remoteWriteQueues.get(queueKey) || Promise.resolve();
  const queued = previous.catch(() => undefined).then(run);
  remoteWriteQueues.set(queueKey, queued);
  queued.finally(() => {
    if (remoteWriteQueues.get(queueKey) === queued) remoteWriteQueues.delete(queueKey);
  });
  return queued;
}

export function subscribeToRatings(orgKey = '', onChange) {
  if (!shouldUseSupabase || !supabase || typeof onChange !== 'function') return () => {};
  const orgFilter = orgKey || '';
  const channel = supabase
    .channel(`ratings:${orgFilter || 'global'}:${Math.random().toString(36).slice(2, 8)}`)
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'app_state', filter: `state_key=eq.${REMOTE_RECORD_KEY}` },
      async (payload) => {
        const row = (payload?.new && Object.keys(payload.new || {}).length > 0) ? payload.new : payload?.old;
        if (!row || (row.org_key || '') !== orgFilter) return;
        await hydrateRatings(orgKey);
        onChange();
      },
    )
    .subscribe();
  return () => {
    try { supabase.removeChannel(channel); } catch { /* ignore */ }
  };
}

export function getEmployeeStage(orgKey, empCode, stage) {
  const all = readRatings(orgKey);
  return all.ratings?.[empCode]?.[stage] || null;
}

export function setEmployeeStage(orgKey, empCode, stage, value) {
  const all = readRatings(orgKey);
  const updatedAt = new Date().toISOString();
  const next = {
    ...all,
    ratings: {
      ...(all.ratings || {}),
      [empCode]: {
        ...(all.ratings?.[empCode] || {}),
        [stage]: { ...(all.ratings?.[empCode]?.[stage] || {}), ...value, updatedAt },
      },
    },
  };
  writeRatings(orgKey, next);
  return next.ratings[empCode][stage];
}

export function submitEmployeeStage(orgKey, empCode, stage, value, actor) {
  const all = readRatings(orgKey);
  const submittedAt = new Date().toISOString();
  const stamped = { ...value, submittedAt, updatedAt: submittedAt, submittedBy: actor || '' };
  const next = {
    ...all,
    ratings: {
      ...(all.ratings || {}),
      [empCode]: {
        ...(all.ratings?.[empCode] || {}),
        [stage]: stamped,
      },
    },
    auditLog: [
      ...(all.auditLog || []),
      { ts: stamped.submittedAt, action: `submit-${stage}`, actor, empCode },
    ],
  };
  writeRatings(orgKey, next);
  return stamped;
}

// Manager asks the employee to complete blank fields: reopens the self-eval
// (clears submittedAt) and records the manager's note. Cleared when the
// employee resubmits (submitEmployeeStage replaces the whole self stage).
export function requestSelfCompletion(orgKey, empCode, note, actor) {
  const all = readRatings(orgKey);
  const ts = new Date().toISOString();
  const prevSelf = all.ratings?.[empCode]?.self || {};
  const next = {
    ...all,
    ratings: {
      ...(all.ratings || {}),
      [empCode]: {
        ...(all.ratings?.[empCode] || {}),
        self: { ...prevSelf, submittedAt: null, updatedAt: ts, completionRequested: { at: ts, by: actor || '', note: note || '' } },
      },
    },
    auditLog: [...(all.auditLog || []), { ts, action: 'request-completion', actor, empCode, reason: note || '' }],
  };
  writeRatings(orgKey, next);
  return next.ratings[empCode].self;
}

// Manager sends the self-eval back to the employee. Saves the manager's
// in-progress draft AND reopens the self stage in a SINGLE write, so the
// two changes can't race each other's async cloud-sync (a split write let the
// manager save's lagging sync overwrite the self clear, restoring "submitted").
export function sendBackForCompletion(orgKey, empCode, managerValue, note, actor) {
  const all = readRatings(orgKey);
  const ts = new Date().toISOString();
  const prev = all.ratings?.[empCode] || {};
  const next = {
    ...all,
    ratings: {
      ...(all.ratings || {}),
      [empCode]: {
        ...prev,
        manager: { ...(prev.manager || {}), ...(managerValue || {}), submittedAt: null, submittedBy: null, updatedAt: ts },
        self: { ...(prev.self || {}), submittedAt: null, updatedAt: ts, completionRequested: { at: ts, by: actor || '', note: note || '' } },
      },
    },
    auditLog: [...(all.auditLog || []), { ts, action: 'request-completion', actor, empCode, reason: note || '' }],
  };
  writeRatings(orgKey, next);
  return next.ratings[empCode];
}

export function recordCalibrationMove(orgKey, empCode, before, after, reason, actor) {
  const all = readRatings(orgKey);
  const ts = new Date().toISOString();
  const next = {
    ...all,
    ratings: {
      ...(all.ratings || {}),
      [empCode]: {
        ...(all.ratings?.[empCode] || {}),
        final: {
          ...(all.ratings?.[empCode]?.final || {}),
          calibratedScore: after,
          calibrationNote: reason,
          calibratedBy: actor,
          calibratedAt: ts,
          updatedAt: ts,
        },
      },
    },
    auditLog: [
      ...(all.auditLog || []),
      { ts, action: 'calibrate', actor, empCode, before, after, reason },
    ],
  };
  writeRatings(orgKey, next);
}

export function publishCycle(orgKey, actor, reason = '') {
  const all = readRatings(orgKey);
  const ts = new Date().toISOString();
  const next = {
    ...all,
    publishedAt: ts,
    publishedBy: actor || '',
    publishReason: reason || '',
    updatedAt: ts,
    auditLog: [...(all.auditLog || []), { ts, action: 'publish', actor, reason: reason || '' }],
  };
  writeRatings(orgKey, next);
  return ts;
}

export function isPublished(orgKey) {
  return !!readRatings(orgKey).publishedAt;
}

// Distribution computation — counts each employee's final (or manager) score
// into rating-point buckets. Used by HR review.
export function computeDistribution(orgKey, scalePoints) {
  const all = readRatings(orgKey);
  const counts = Array.from({ length: scalePoints || 5 }, () => 0);
  Object.values(all.ratings || {}).forEach((stages) => {
    const finalScore = stages?.final?.calibratedScore ?? stages?.manager?.overallScore ?? null;
    if (finalScore === null || finalScore === undefined) return;
    const idx = Math.max(0, Math.min((scalePoints || 5) - 1, Math.round(Number(finalScore)) - 1));
    counts[idx] += 1;
  });
  const total = counts.reduce((s, n) => s + n, 0);
  const pct = counts.map((n) => (total > 0 ? Math.round((n / total) * 100) : 0));
  return { counts, pct, total };
}

// Sample data — seeds fake self+manager ratings across all employees so HR
// review can be exercised end-to-end during development. Idempotent: skips
// employees who already have ratings recorded.
export function seedSampleRatings(orgKey, employees, scalePoints) {
  const all = readRatings(orgKey);
  const N = scalePoints || 5;
  const next = { ...all, ratings: { ...(all.ratings || {}) } };
  const pseudoRandom = (seed) => {
    let h = 2166136261;
    for (let i = 0; i < seed.length; i++) {
      h ^= seed.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return Math.abs(h) % 10000;
  };
  employees.forEach((emp, i) => {
    const code = String(emp['Employee Code'] || emp.empCode || `EMP_${i}`).trim();
    if (!code) return;
    if (next.ratings[code]) return;
    const r = pseudoRandom(code);
    // Bell-ish distribution: middle ranks get higher probability.
    const middle = Math.floor(N / 2);
    const candidate = middle + ((r % 5) - 2);
    const selfScore = Math.max(1, Math.min(N, candidate + (r % 2)));
    const managerScore = Math.max(1, Math.min(N, candidate));
    next.ratings[code] = {
      self: { overallScore: selfScore, overallComment: 'Auto-seeded for demo.', submittedAt: new Date().toISOString() },
      manager: { overallScore: managerScore, overallComment: 'Auto-seeded for demo.', submittedAt: new Date().toISOString() },
    };
  });
  writeRatings(orgKey, next);
}
