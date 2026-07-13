// Ratings store. In browser-storage mode this remains local-first; in Supabase
// mode reads/writes go through checked server actions and per-record tables.
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
import { readAuthSessionSync, readEmployeeSessionSync } from './stateStore';
import { isSessionTimeoutMessage, notifySessionTimeout } from './sessionTimeout';

const KEY_PREFIX = 'zarohr_ratings_v1';
const DEFAULT_RATINGS_STATE = { ratings: {}, auditLog: [], publishedAt: null };
export const SEED_MARKER = 'Auto-seeded for demo.';

function key(orgKey) {
  return `${KEY_PREFIX}:${orgKey || 'default'}`;
}

function readServerSessionToken() {
  const authSession = readAuthSessionSync();
  const employeeSession = readEmployeeSessionSync();
  return authSession?.serverSessionToken || employeeSession?.serverSessionToken || '';
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
  const remoteSubmittedAt = Date.parse(remoteStage.submittedAt || '') || 0;
  const localSubmittedAt = Date.parse(localStage.submittedAt || '') || 0;
  const localCompletionAt = Date.parse(localStage.completionRequested?.at || '') || 0;
  const localClearedAt = Date.parse(localStage.clearedAt || '') || 0;

  if (remoteSubmittedAt && !localSubmittedAt) {
    return Math.max(localCompletionAt, localClearedAt) > remoteSubmittedAt ? localStage : remoteStage;
  }
  if (localSubmittedAt && !remoteSubmittedAt) {
    return localStage;
  }
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

function publishStateOf(source = {}) {
  const publishedAt = source?.publishedAt ? Date.parse(source.publishedAt) || 0 : 0;
  const unpublishedAt = source?.unpublishedAt ? Date.parse(source.unpublishedAt) || 0 : 0;
  return { source, publishedAt, unpublishedAt, latestAt: Math.max(publishedAt, unpublishedAt) };
}

function mergePublishState(remote = {}, local = {}) {
  const remoteState = publishStateOf(remote);
  const localState = publishStateOf(local);
  const winner = localState.latestAt >= remoteState.latestAt ? localState : remoteState;
  const revoked = winner.unpublishedAt > winner.publishedAt;
  return {
    publishedAt: revoked ? null : (winner.source?.publishedAt || null),
    publishedBy: revoked ? '' : (winner.source?.publishedBy || ''),
    publishReason: revoked ? '' : (winner.source?.publishReason || ''),
    unpublishedAt: winner.source?.unpublishedAt || null,
    unpublishedBy: winner.source?.unpublishedBy || '',
  };
}

function normalizePublishState(data = DEFAULT_RATINGS_STATE) {
  const state = publishStateOf(data);
  if (state.unpublishedAt <= state.publishedAt) return data || DEFAULT_RATINGS_STATE;
  return {
    ...(data || DEFAULT_RATINGS_STATE),
    publishedAt: null,
    publishedBy: '',
    publishReason: '',
    unpublishedAt: data?.unpublishedAt || null,
    unpublishedBy: data?.unpublishedBy || '',
  };
}

function isSeededStage(stage) {
  return !!stage && (stage._seeded === true || stage.overallComment === SEED_MARKER);
}

function seededTombstone(ts) {
  return { cleared: true, clearedAt: ts, updatedAt: ts };
}

function sanitizeSeededRatingsState(data = DEFAULT_RATINGS_STATE, ts = new Date().toISOString()) {
  const ratings = data?.ratings || {};
  let changed = false;
  const nextRatings = {};
  Object.entries(ratings).forEach(([code, stages]) => {
    if (!stages || typeof stages !== 'object') {
      nextRatings[code] = stages;
      return;
    }
    const nextStages = { ...stages };
    ['self', 'manager', 'hod', 'final'].forEach((stageName) => {
      if (isSeededStage(nextStages[stageName])) {
        nextStages[stageName] = seededTombstone(ts);
        changed = true;
      }
    });
    nextRatings[code] = nextStages;
  });
  return {
    changed,
    data: changed ? { ...data, ratings: nextRatings, updatedAt: ts } : (data || DEFAULT_RATINGS_STATE),
  };
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
      hod: mergeStage(r.hod, l.hod),
      final: mergeStage(r.final, l.final),
    };
  });

  const publishState = mergePublishState(remote, local);

  return {
    ...remote,
    ...local,
    ratings,
    auditLog: mergeAuditLogs(remote?.auditLog || [], local?.auditLog || []),
    ...publishState,
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
    const nextRaw = JSON.stringify(value);
    if (window.localStorage.getItem(k) === nextRaw) return;
    window.localStorage.setItem(k, nextRaw);
    // Fire a hashchange-like event so listeners can refresh on cross-tab edits.
    window.dispatchEvent(new CustomEvent('zarohr-ratings-changed', { detail: { key: k } }));
  } catch {
    // ignore quota errors — surfaces as missing data on next read
  }
}

async function resolveOrganizationId(orgKey = '') {
  if (!shouldUseSupabase || !supabase || !orgKey) return '';
  try {
    const { data, error } = await supabase
      .from('organizations')
      .select('id')
      .eq('org_key', orgKey)
      .maybeSingle();
    if (error) throw error;
    return data?.id || '';
  } catch (error) {
    console.warn('[ratings:org-id]', error);
    return '';
  }
}

export function readRatings(orgKey) {
  const raw = readJson(key(orgKey), DEFAULT_RATINGS_STATE);
  const normalized = normalizePublishState(raw);
  const cleaned = sanitizeSeededRatingsState(normalized);
  if (cleaned.changed || normalized !== raw) writeJson(key(orgKey), cleaned.data);
  return cleaned.data;
}

export function writeRatings(orgKey, data) {
  const payload = data || DEFAULT_RATINGS_STATE;
  writeJson(key(orgKey), payload);
  void persistRatings(orgKey, payload);
}

export async function writeRatingsAndPersist(orgKey, data) {
  const payload = data || DEFAULT_RATINGS_STATE;
  writeJson(key(orgKey), payload);
  return persistRatings(orgKey, payload);
}

async function readRemoteRatings(orgKey = '') {
  if (!shouldUseSupabase || !supabase) return null;
  try {
    const server = await runRatingsAction('read-ratings', { orgKey });
    if (server?.ok && server.ratings) return server.ratings;
    return null;
  } catch (error) {
    console.warn('[ratings:server-read]', error);
    return null;
  }
}

export async function hydrateRatings(orgKey = '') {
  const local = readRatings(orgKey);
  if (!shouldUseSupabase || !supabase) return local;
  const remote = await readRemoteRatings(orgKey);
  if (!remote) return local;
  const mergedRaw = mergeRatingsState(remote, local);
  const { data: merged, changed: cleanedSeeded } = sanitizeSeededRatingsState(mergedRaw);
  writeJson(key(orgKey), merged);
  if (cleanedSeeded) writeJson(key(orgKey), merged);
  return merged;
}

export function persistRatings(orgKey = '', payload = null) {
  if (!shouldUseSupabase || !supabase) return Promise.resolve(true);
  void orgKey;
  void payload;
  /*
   * Supabase-mode blob persistence is intentionally disabled. Ratings are now
   * written by checked pms-actions calls into per-record tables:
   * employee_ratings, rating_publications, and rating_acknowledgements.
   */
  return Promise.resolve(false);
}

export function subscribeToRatings(orgKey = '', onChange) {
  if (!shouldUseSupabase || !supabase || typeof onChange !== 'function') return () => {};
  const channels = [];
  let disposed = false;
  const refresh = async () => {
    await hydrateRatings(orgKey);
    onChange();
  };

  void resolveOrganizationId(orgKey).then((organizationId) => {
    if (disposed || !organizationId) return;
    const rowChannel = supabase
      .channel(`employee_ratings:${organizationId}:${Math.random().toString(36).slice(2, 8)}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'employee_ratings', filter: `organization_id=eq.${organizationId}` },
        () => { void refresh(); },
      )
      .subscribe();
    channels.push(rowChannel);
    const publicationChannel = supabase
      .channel(`rating_publications:${organizationId}:${Math.random().toString(36).slice(2, 8)}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'rating_publications', filter: `organization_id=eq.${organizationId}` },
        () => { void refresh(); },
      )
      .subscribe();
    const acknowledgementChannel = supabase
      .channel(`rating_acknowledgements:${organizationId}:${Math.random().toString(36).slice(2, 8)}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'rating_acknowledgements', filter: `organization_id=eq.${organizationId}` },
        () => { void refresh(); },
      )
      .subscribe();
    channels.push(publicationChannel, acknowledgementChannel);
  });

  return () => {
    disposed = true;
    channels.forEach((item) => {
      try { supabase.removeChannel(item); } catch { /* ignore */ }
    });
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

export async function recordFinalAcceptance(orgKey, empCode, decision, reason = '', actor = '') {
  const all = readRatings(orgKey);
  const ts = new Date().toISOString();
  const normalizedDecision = decision === 'rejected' ? 'rejected' : 'accepted';
  const acceptance = {
    decision: normalizedDecision,
    reason: normalizedDecision === 'rejected' ? String(reason || '').trim() : '',
    submittedAt: ts,
    submittedBy: actor || empCode || '',
    updatedAt: ts,
  };
  const next = {
    ...all,
    ratings: {
      ...(all.ratings || {}),
      [empCode]: {
        ...(all.ratings?.[empCode] || {}),
        acceptance,
      },
    },
    auditLog: [
      ...(all.auditLog || []),
      { ts, action: `final-${normalizedDecision}`, actor: actor || empCode || '', empCode, reason: acceptance.reason },
    ],
  };

  // Prefer the checked server path when available…
  if (shouldUseSupabase && supabase) {
    const result = await runRatingsAction('record-final-acceptance', { orgKey, empCode, decision, reason, actor });
    if (result?.ok) {
      if (result.ratings) writeJson(key(orgKey), result.ratings);
      return { ok: true, acceptance: result.acceptance || acceptance };
    }
    return { ok: false, error: result?.error || 'Could not save your response. Please retry.', acceptance };
  }
  // Browser-storage mode only: keep the demo/local path working when Supabase
  // is not configured.
  writeJson(key(orgKey), next);
  void persistRatings(orgKey, next);
  return { ok: true, acceptance };
}

// HR resolves an employee's raised concern. Two paths:
//   - 'explained': HR replies (typically by email) and closes the concern. The
//     employee's decision stays 'rejected' but the concern is marked resolved.
//   - 'recalibrated': HR changed the final rating (done separately via the
//     calibration path); here we RE-OPEN the acceptance so the employee gets a
//     fresh accept / raise-concern round on the new number.
export async function resolveConcern(orgKey, empCode, { type, message = '' } = {}, actor = '') {
  const all = readRatings(orgKey);
  const ts = new Date().toISOString();
  const prev = all.ratings?.[empCode]?.acceptance || {};
  const resolution = { type: type === 'recalibrated' ? 'recalibrated' : 'explained', message: String(message || '').trim(), at: ts, by: actor || '' };
  const acceptance = type === 'recalibrated'
    ? {
        // fresh round — employee must respond to the recalibrated rating
        decision: '',
        reason: '',
        submittedAt: '',
        submittedBy: '',
        resolution,
        round: (Number(prev.round) || 1) + 1,
        updatedAt: ts,
      }
    : {
        ...prev,
        resolution,
        updatedAt: ts,
      };
  const next = {
    ...all,
    ratings: {
      ...(all.ratings || {}),
      [empCode]: {
        ...(all.ratings?.[empCode] || {}),
        acceptance,
      },
    },
    auditLog: [
      ...(all.auditLog || []),
      { ts, action: `concern-${resolution.type}`, actor: actor || '', empCode, reason: resolution.message },
    ],
  };

  // Prefer the checked server path…
  if (shouldUseSupabase && supabase) {
    const result = await runRatingsAction('resolve-concern', { orgKey, empCode, type, message, actor });
    if (result?.ok) {
      if (result.ratings) writeJson(key(orgKey), result.ratings);
      return { ok: true, acceptance: result.acceptance || acceptance };
    }
    return { ok: false, error: result?.error || 'Could not resolve concern.', acceptance };
  }
  // Browser-storage mode only: keep the demo/local path working when Supabase
  // is not configured.
  writeJson(key(orgKey), next);
  void persistRatings(orgKey, next);
  return { ok: true, acceptance };
}

export function submitEmployeeStage(orgKey, empCode, stage, value, actor) {
  const { next, stamped } = buildSubmittedRatingsState(orgKey, empCode, stage, value, actor);
  writeRatings(orgKey, next);
  return stamped;
}

export async function submitEmployeeStageAndPersist(orgKey, empCode, stage, value, actor, options = {}) {
  const { allowFallback = false, optimistic = true } = options || {};
  const { next, stamped } = buildSubmittedRatingsState(orgKey, empCode, stage, value, actor);
  if (shouldUseSupabase && supabase) {
    if (optimistic && allowFallback) writeJson(key(orgKey), next);
    const persistServer = async () => {
      try {
        const { data, error } = await supabase.functions.invoke('pms-actions', {
          body: {
            action: 'submit-rating',
            serverSessionToken: readServerSessionToken(),
            orgKey,
            empCode,
            stage,
            payload: value,
            actor,
          },
        });
        if (error) throw error;
	        if (!data?.ok) {
	          if (isSessionTimeoutMessage(data?.error)) notifySessionTimeout(data?.error);
	          throw new Error(data?.error || 'Could not submit rating.');
	        }
        const serverStamped = data.stage || stamped;
        const serverNext = {
          ...next,
          ratings: {
            ...(next.ratings || {}),
            [empCode]: {
              ...(next.ratings?.[empCode] || {}),
              [stage]: serverStamped,
            },
          },
        };
        writeJson(key(orgKey), serverNext);
        return { ok: true, stamped: serverStamped };
      } catch (error) {
        console.warn('[ratings:submit-action]', error);
        let errorMessage = error?.message || 'Could not submit rating.';
        try {
          const body = error?.context?.clone ? await error.context.clone().json() : null;
          errorMessage = body?.error || body?.message || errorMessage;
        } catch {
          // Keep the original client error when the function response is not JSON.
        }
	        if (!allowFallback) {
	          if (isSessionTimeoutMessage(errorMessage)) notifySessionTimeout(errorMessage);
	          return { ok: false, error: errorMessage, stamped };
	        }
        const fallbackOk = await writeRatingsAndPersist(orgKey, next);
        if (fallbackOk) return { ok: true, stamped, fallback: true };
        const failedAt = new Date().toISOString();
        const current = readRatings(orgKey);
        const failedStage = {
          ...(current.ratings?.[empCode]?.[stage] || stamped),
          syncFailedAt: failedAt,
          syncError: errorMessage,
          updatedAt: failedAt,
        };
        const failedNext = {
          ...current,
          ratings: {
            ...(current.ratings || {}),
            [empCode]: {
              ...(current.ratings?.[empCode] || {}),
              [stage]: failedStage,
            },
          },
          auditLog: [
            ...(current.auditLog || []),
            { ts: failedAt, action: `submit-${stage}-sync-failed`, actor, empCode, reason: errorMessage },
          ],
        };
	        writeJson(key(orgKey), failedNext);
	        if (isSessionTimeoutMessage(errorMessage)) notifySessionTimeout(errorMessage);
	        return { ok: false, error: errorMessage, stamped };
	      }
    };
    if (!optimistic || !allowFallback) return persistServer();
    void persistServer();
    return { ok: true, stamped, pending: true };
  }
  const ok = await writeRatingsAndPersist(orgKey, next);
  return { ok, stamped };
}

export async function clearEmployeeStageAndPersist(orgKey, empCode, stage, actor, options = {}) {
  const { allowFallback = false, optimistic = true } = options || {};
  const { next, cleared } = buildClearedRatingsState(orgKey, empCode, stage, actor);
  if (shouldUseSupabase && supabase) {
    if (optimistic && allowFallback) writeJson(key(orgKey), next);
    const persistServer = async () => {
      try {
        const { data, error } = await supabase.functions.invoke('pms-actions', {
          body: {
            action: 'clear-rating',
            serverSessionToken: readServerSessionToken(),
            orgKey,
            empCode,
            stage,
            actor,
          },
        });
        if (error) throw error;
        if (!data?.ok) throw new Error(data?.error || 'Could not clear rating.');
        const serverCleared = data.stage || cleared;
        const serverNext = {
          ...next,
          ratings: {
            ...(next.ratings || {}),
            [empCode]: {
              ...(next.ratings?.[empCode] || {}),
              [stage]: serverCleared,
            },
          },
        };
        writeJson(key(orgKey), serverNext);
        return { ok: true, stage: serverCleared };
      } catch (error) {
        console.warn('[ratings:clear-action]', error);
        const errorMessage = error?.message || 'Could not clear rating.';
        if (!allowFallback) return { ok: false, error: errorMessage, stage: cleared };
        const fallbackOk = await writeRatingsAndPersist(orgKey, next);
        return fallbackOk ? { ok: true, stage: cleared, fallback: true } : { ok: false, error: errorMessage, stage: cleared };
      }
    };
    if (!optimistic || !allowFallback) return persistServer();
    void persistServer();
    return { ok: true, stage: cleared, pending: true };
  }
  const ok = await writeRatingsAndPersist(orgKey, next);
  return { ok, stage: cleared };
}

function buildSubmittedRatingsState(orgKey, empCode, stage, value, actor) {
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
  return { next, stamped };
}

function buildClearedRatingsState(orgKey, empCode, stage, actor) {
  const all = readRatings(orgKey);
  const clearedAt = new Date().toISOString();
  const currentStage = all.ratings?.[empCode]?.[stage] || {};
  const cleared = {
    ...currentStage,
    submittedAt: null,
    submittedBy: null,
    calibratedScore: undefined,
    calibrationNote: '',
    calibratedBy: '',
    calibratedAt: null,
    updatedAt: clearedAt,
    clearedAt,
    clearedBy: actor || '',
  };
  const next = {
    ...all,
    ratings: {
      ...(all.ratings || {}),
      [empCode]: {
        ...(all.ratings?.[empCode] || {}),
        [stage]: cleared,
      },
    },
    auditLog: [
      ...(all.auditLog || []),
      { ts: clearedAt, action: `clear-${stage}`, actor, empCode },
    ],
  };
  return { next, cleared };
}

function withoutCalibrationFields(stage = {}) {
  const next = { ...(stage || {}) };
  delete next.calibratedScore;
  delete next.calibrationNote;
  delete next.calibratedBy;
  delete next.calibratedAt;
  return next;
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

export function recordHodCalibrationMove(orgKey, empCode, before, after, reason, actor) {
  const all = readRatings(orgKey);
  const ts = new Date().toISOString();
  const next = {
    ...all,
    ratings: {
      ...(all.ratings || {}),
      [empCode]: {
        ...(all.ratings?.[empCode] || {}),
        hod: {
          ...(all.ratings?.[empCode]?.hod || {}),
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
      { ts, action: 'hod-calibrate', actor, empCode, before, after, reason },
    ],
  };
  writeRatings(orgKey, next);
}

export function resetCalibrationMove(orgKey, empCode, before, actor) {
  const all = readRatings(orgKey);
  const ts = new Date().toISOString();
  const prevStage = all.ratings?.[empCode]?.final || {};
  const restFinal = withoutCalibrationFields(prevStage);
  const next = {
    ...all,
    ratings: {
      ...(all.ratings || {}),
      [empCode]: {
        ...(all.ratings?.[empCode] || {}),
        final: {
          ...restFinal,
          updatedAt: ts,
        },
      },
    },
    auditLog: [
      ...(all.auditLog || []),
      { ts, action: 'calibration-reset', actor, empCode, before, after: '', reason: 'Reset calibration' },
    ],
  };
  writeRatings(orgKey, next);
}

export function resetHodCalibrationMove(orgKey, empCode, before, actor) {
  const all = readRatings(orgKey);
  const ts = new Date().toISOString();
  const prevStage = all.ratings?.[empCode]?.hod || {};
  const restHod = withoutCalibrationFields(prevStage);
  const next = {
    ...all,
    ratings: {
      ...(all.ratings || {}),
      [empCode]: {
        ...(all.ratings?.[empCode] || {}),
        hod: {
          ...restHod,
          updatedAt: ts,
        },
      },
    },
    auditLog: [
      ...(all.auditLog || []),
      { ts, action: 'hod-calibration-reset', actor, empCode, before, after: '', reason: 'Reset HOD calibration' },
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
    unpublishedAt: null,
    unpublishedBy: '',
    updatedAt: ts,
    auditLog: [...(all.auditLog || []), { ts, action: 'publish', actor, reason: reason || '' }],
  };
  writeRatings(orgKey, next);
  return ts;
}

export function revokePublishCycle(orgKey, actor, reason = 'Testing revoke publish') {
  const all = readRatings(orgKey);
  const ts = new Date().toISOString();
  const next = {
    ...all,
    publishedAt: null,
    publishedBy: '',
    publishReason: '',
    unpublishedAt: ts,
    unpublishedBy: actor || '',
    updatedAt: ts,
    auditLog: [...(all.auditLog || []), { ts, action: 'revoke-publish', actor, reason: reason || '' }],
  };
  writeRatings(orgKey, next);
  return ts;
}

export function isPublished(orgKey) {
  const ratings = readRatings(orgKey);
  const publishedAt = ratings?.publishedAt ? Date.parse(ratings.publishedAt) || 0 : 0;
  const unpublishedAt = ratings?.unpublishedAt ? Date.parse(ratings.unpublishedAt) || 0 : 0;
  return publishedAt > unpublishedAt;
}

// Never let a server call hang forever — if the edge function / network stalls
// (Supabase incident, over-quota throttling, slow network), reject after `ms` so
// callers fall back to a local write instead of freezing the UI.
function withTimeout(promise, ms, label = 'request') {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out contacting the server (${label}).`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function runRatingsAction(action, body = {}) {
  if (!shouldUseSupabase || !supabase) return { ok: false, error: 'Supabase backend is not configured.' };
  try {
    const { data, error } = await withTimeout(supabase.functions.invoke('pms-actions', {
      body: {
        ...body,
        action,
        serverSessionToken: readServerSessionToken(),
      },
    }), 8000, `pms-actions:${action}`);
    if (error) throw error;
    if (!data?.ok) throw new Error(data?.error || 'Ratings action failed.');
    return data;
  } catch (error) {
    let errorMessage = error?.message || 'Ratings action failed.';
    let status = 0;
    try {
      status = Number(error?.context?.status) || 0;
      const parsed = error?.context?.clone ? await error.context.clone().json() : null;
      errorMessage = parsed?.error || parsed?.message || errorMessage;
    } catch {
      // Keep the original client error when response body is unavailable.
    }
    // A 401 always means the session is gone, even if the body text couldn't be
    // read — always raise the sign-in prompt in that case.
    if (status === 401 || isSessionTimeoutMessage(errorMessage)) {
      notifySessionTimeout(status === 401 && !isSessionTimeoutMessage(errorMessage) ? 'Sign in again to continue.' : errorMessage);
    }
    return { ok: false, error: errorMessage };
  }
}

export async function publishCycleAndPersist(orgKey, actor, reason = '') {
  if (!shouldUseSupabase || !supabase) {
    const ts = publishCycle(orgKey, actor, reason);
    return { ok: true, publishedAt: ts };
  }
  const result = await runRatingsAction('publish-cycle', { orgKey, actor, reason });
  if (!result?.ok) return result;
  if (result.ratings) writeJson(key(orgKey), result.ratings);
  else await hydrateRatings(orgKey);
  return result;
}

export async function revokePublishCycleAndPersist(orgKey, actor, reason = 'Testing revoke publish') {
  if (!shouldUseSupabase || !supabase) {
    const ts = revokePublishCycle(orgKey, actor, reason);
    return { ok: true, unpublishedAt: ts };
  }
  const result = await runRatingsAction('revoke-publish', { orgKey, actor, reason });
  if (!result?.ok) return result;
  if (result.ratings) writeJson(key(orgKey), result.ratings);
  else await hydrateRatings(orgKey);
  return result;
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
export function seedSampleRatings(orgKey, employees, scalePoints, options = {}) {
  // Guard: demo data must never land on a live cycle. Callers have to pass an
  // explicit confirmation, so this can't fire by accident on a launched org.
  if (!options.confirmDemoSeed) {
    console.warn('seedSampleRatings blocked: pass { confirmDemoSeed: true } to seed demo data.');
    return;
  }
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
      self: { overallScore: selfScore, overallComment: SEED_MARKER, _seeded: true, submittedAt: new Date().toISOString() },
      manager: { overallScore: managerScore, overallComment: SEED_MARKER, _seeded: true, submittedAt: new Date().toISOString() },
    };
  });
  writeRatings(orgKey, next);
}

// Clear ONLY the demo-seeded stages (matched by the seed marker / flag),
// leaving every real self/manager/final submission untouched. Returns how many
// employee entries were affected so the UI can confirm what it cleared.
//
// We can't just delete the keys: the cloud sync UNIONS local + remote codes
// (mergeRatingsState), so a deleted employee would re-appear from the server on
// the next merge. Instead each seeded stage is replaced with a tombstone that
// is NEWER than the seed but carries no submittedAt — mergeStage keeps the
// newer record, and "no submittedAt" makes the stage read as not-submitted, so
// the employee correctly drops back to their true stage everywhere.
export function clearSeededRatings(orgKey) {
  const all = readRatings(orgKey);
  const ratings = all.ratings || {};
  const ts = new Date().toISOString();
  let affected = 0;
  const nextRatings = {};
  Object.entries(ratings).forEach(([code, stages]) => {
    if (!stages) { nextRatings[code] = stages; return; }
    let touched = false;
    const next = {};
    Object.entries(stages).forEach(([stageName, stageValue]) => {
      if (isSeededStage(stageValue)) {
        touched = true;
        next[stageName] = seededTombstone(ts);
      } else {
        next[stageName] = stageValue;
      }
    });
    if (touched) affected += 1;
    nextRatings[code] = next;
  });
  writeRatings(orgKey, { ...all, ratings: nextRatings });
  return affected;
}
