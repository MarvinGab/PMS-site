import { shouldUseSupabase } from './config';
import { supabase } from './supabaseClient';

const LOCAL_AUDIT_KEY = 'zarohr_audit_log_v1';

function readLocalAuditLog() {
  if (typeof window === 'undefined') return [];
  try {
    return JSON.parse(window.localStorage.getItem(LOCAL_AUDIT_KEY) || '[]');
  } catch {
    return [];
  }
}

function writeLocalAuditLog(entries) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(LOCAL_AUDIT_KEY, JSON.stringify(entries));
  } catch (_) {
    // Best-effort only.
  }
}

export async function logAuditEvent({
  orgKey = '',
  actorRole = '',
  actorCode = '',
  actorName = '',
  actionType = '',
  targetType = '',
  targetCode = '',
  details = {},
} = {}) {
  const payload = {
    org_key: String(orgKey || '').trim() || null,
    actor_role: String(actorRole || '').trim() || null,
    actor_code: String(actorCode || '').trim() || null,
    actor_name: String(actorName || '').trim() || null,
    action_type: String(actionType || '').trim() || 'unknown',
    target_type: String(targetType || '').trim() || null,
    target_code: String(targetCode || '').trim() || null,
    details: details && typeof details === 'object' ? details : {},
  };

  const localEntries = readLocalAuditLog();
  writeLocalAuditLog([
    {
      id: `audit_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      created_at: new Date().toISOString(),
      ...payload,
    },
    ...localEntries,
  ].slice(0, 200));

  if (!shouldUseSupabase || !supabase) return { ok: true, localOnly: true };

  try {
    const { error } = await supabase.from('app_audit_logs').insert(payload);
    if (error) throw error;
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error?.message || 'Failed to persist audit log.' };
  }
}
