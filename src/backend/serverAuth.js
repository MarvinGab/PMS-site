import { shouldUseSupabase } from './config';
import { supabase } from './supabaseClient';

async function invokeAuthFunction(body) {
  if (!shouldUseSupabase || !supabase) {
    return { ok: false, error: 'Supabase auth backend is not configured.' };
  }
  try {
    const { data, error } = await supabase.functions.invoke('app-auth', { body });
    if (error) throw error;
    return data || { ok: true };
  } catch (error) {
    return { ok: false, error: error?.message || 'Failed to contact app auth backend.' };
  }
}

export async function loginWithServerSession(identifier, password) {
  return invokeAuthFunction({
    action: 'login',
    identifier: String(identifier || '').trim(),
    password: String(password || ''),
  });
}

export async function revokeServerSession(serverSessionToken) {
  if (!serverSessionToken) return { ok: true, skipped: true };
  return invokeAuthFunction({
    action: 'logout',
    serverSessionToken: String(serverSessionToken || '').trim(),
  });
}
