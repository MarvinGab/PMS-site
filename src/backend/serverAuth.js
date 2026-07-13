import { shouldUseSupabase } from './config';
import { supabase } from './supabaseClient';
import { readAuthSessionSync, persistAuthSession } from './stateStore';

async function invokeAuthFunction(body) {
  if (!shouldUseSupabase || !supabase) {
    return { ok: false, error: 'Supabase auth backend is not configured.' };
  }
  try {
    const { data, error } = await supabase.functions.invoke('app-auth', { body });
    if (error) throw error;
    return data || { ok: true };
  } catch (error) {
    const message = await describeAuthFunctionError(error);
    return { ok: false, error: message || 'Failed to contact app auth backend.' };
  }
}

async function describeAuthFunctionError(error) {
  const fallback = error?.message || '';
  const response = error?.context;
  if (!response || typeof response.text !== 'function') return fallback;

  try {
    const raw = await response.text();
    let payload = null;
    try {
      payload = raw ? JSON.parse(raw) : null;
    } catch {
      payload = null;
    }
    const serverMessage = String(payload?.message || payload?.error || raw || '').trim();
    if (response.status === 402 && /egress|quota|spend/i.test(serverMessage)) {
      return 'Supabase has blocked this project because the egress quota/spend cap was reached. Restore the project in Supabase, then try again.';
    }
    if (serverMessage) return serverMessage;
  } catch {
    // Keep the original SDK error if the response body cannot be read.
  }
  return fallback;
}

export async function loginWithServerSession(identifier, password, organizationKey = '', rememberMe = false, workspace = '') {
  return invokeAuthFunction({
    action: 'login',
    identifier: String(identifier || '').trim(),
    password: String(password || ''),
    organizationKey: String(organizationKey || '').trim(),
    rememberMe: !!rememberMe,
    workspace: String(workspace || '').trim(),
  });
}

export async function revokeServerSession(serverSessionToken) {
  if (!serverSessionToken) return { ok: true, skipped: true };
  return invokeAuthFunction({
    action: 'logout',
    serverSessionToken: String(serverSessionToken || '').trim(),
  });
}

export async function requestPasswordReset(identifier, organizationKey) {
  return invokeAuthFunction({
    action: 'request-password-reset',
    identifier: String(identifier || '').trim(),
    organizationKey: String(organizationKey || '').trim(),
  });
}

export async function confirmPasswordReset(identifier, organizationKey, code, newPassword) {
  return invokeAuthFunction({
    action: 'confirm-password-reset',
    identifier: String(identifier || '').trim(),
    organizationKey: String(organizationKey || '').trim(),
    code: String(code || ''),
    newPassword: String(newPassword || ''),
  });
}

export async function changePasswordOnServer({ identifier = '', organizationKey = '', credentialKey = '', currentPassword = '', newPassword = '' } = {}) {
  return invokeAuthFunction({
    action: 'change-password',
    identifier: String(identifier || '').trim(),
    organizationKey: String(organizationKey || '').trim(),
    credentialKey: String(credentialKey || '').trim(),
    currentPassword: String(currentPassword || ''),
    newPassword: String(newPassword || ''),
  });
}

export async function suggestOrganizations(query) {
  return invokeAuthFunction({
    action: 'suggest-orgs',
    query: String(query || '').trim(),
  });
}

export async function revokeEmployeeSessions({ organizationKey = '', employees = [] } = {}) {
  const authSession = readAuthSessionSync();
  return invokeAuthFunction({
    action: 'revoke-employee-sessions',
    serverSessionToken: authSession?.serverSessionToken || null,
    organizationKey: String(organizationKey || '').trim(),
    employees: Array.isArray(employees)
      ? employees.map((employee) => ({
          empCode: String(employee?.empCode || '').trim(),
          email: String(employee?.email || '').trim(),
        }))
      : [],
  });
}

// Best-effort re-auth for the local Super Admin when their server session has
// expired in the middle of a 12h day of dev work. Reads credentials from
// VITE_SUPER_ADMIN_EMAIL / VITE_SUPER_ADMIN_PASSWORD; if either is missing the
// helper returns null and the caller falls back to surfacing the error.
// On success it persists the freshly-minted authSession to localStorage so
// the very next readAuthSessionSync() returns the new token.
let refreshSuperAdminInFlight = null;
export async function tryRefreshSuperAdminSession() {
  if (typeof import.meta === 'undefined') return null;
  const email = String(import.meta.env?.VITE_SUPER_ADMIN_EMAIL || '').trim();
  const password = String(import.meta.env?.VITE_SUPER_ADMIN_PASSWORD || '');
  if (!email || !password) return null;

  // Coalesce concurrent callers (e.g. a bulk send firing ten sendOne() at
  // once) onto a single in-flight refresh promise so we don't hammer the
  // app-auth function with N parallel logins.
  if (refreshSuperAdminInFlight) return refreshSuperAdminInFlight;
  refreshSuperAdminInFlight = (async () => {
    try {
      const result = await loginWithServerSession(email, password, '', false, '');
      if (!result?.ok || !result.serverSessionToken) return null;
      const existing = readAuthSessionSync() || {};
      // Only overwrite when the existing session is the super-admin (avoid
      // accidentally wiping an HR-admin who happened to have the env vars
      // present on their dev machine).
      const role = String(existing.role || result.user?.role || '').toLowerCase();
      if (role && role !== 'super-admin') return null;
      persistAuthSession({
        ...existing,
        isLoggedIn: true,
        role: 'super-admin',
        userName: existing.userName || result.user?.userName || 'Super Admin',
        userEmail: existing.userEmail || email.toLowerCase(),
        serverSessionToken: result.serverSessionToken,
      });
      return { token: result.serverSessionToken, user: result.user };
    } catch {
      return null;
    } finally {
      refreshSuperAdminInFlight = null;
    }
  })();
  return refreshSuperAdminInFlight;
}

export async function resetEmployeePmsOnServer({ organizationKey = '', employees = [] } = {}) {
  const authSession = readAuthSessionSync();
  return invokeAuthFunction({
    action: 'reset-employee-pms',
    serverSessionToken: authSession?.serverSessionToken || null,
    organizationKey: String(organizationKey || '').trim(),
    employees: Array.isArray(employees)
      ? employees.map((employee) => ({
          empCode: String(employee?.empCode || '').trim(),
          email: String(employee?.email || '').trim(),
          name: String(employee?.name || '').trim(),
          designation: String(employee?.designation || '').trim(),
          managerCode: String(employee?.managerCode || '').trim(),
        }))
      : [],
  });
}
