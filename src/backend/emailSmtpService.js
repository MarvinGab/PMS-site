import { shouldUseSupabase, supabaseEnv } from './config';
import { readAuthSessionSync } from './stateStore';

const DEFAULT_SMTP_SETTINGS = {
  provider: 'smtp', // 'smtp' | 'microsoft' | 'google'
  isEnabled: false,
  // Shared identity
  fromName: '',
  fromEmail: '',
  footerText: '',
  // SMTP
  useTls: true,
  smtpHost: '',
  smtpPort: 465,
  smtpUsername: '',
  smtpPassword: '',
  hasPassword: false,
  // Microsoft 365 / Graph
  msTenantId: '',
  msClientId: '',
  msClientSecret: '',
  hasMsClientSecret: false,
  // Google Workspace / Gmail API
  googleClientId: '',
  googleClientSecret: '',
  hasGoogleClientSecret: false,
  googleRefreshToken: '',
  hasGoogleRefreshToken: false,
};

const ALLOWED_PROVIDERS = new Set(['smtp', 'microsoft', 'google']);

function normalizeSettings(settings = {}) {
  const provider = ALLOWED_PROVIDERS.has(settings.provider) ? settings.provider : 'smtp';
  return {
    ...DEFAULT_SMTP_SETTINGS,
    provider,
    isEnabled: !!settings.isEnabled,
    fromName: String(settings.fromName || '').trim(),
    fromEmail: String(settings.fromEmail || '').trim(),
    footerText: String(settings.footerText || '').trim(),

    useTls: settings.useTls !== false,
    smtpHost: String(settings.smtpHost || '').trim(),
    smtpPort: Number(settings.smtpPort) || 465,
    smtpUsername: String(settings.smtpUsername || '').trim(),
    smtpPassword: String(settings.smtpPassword || ''),
    hasPassword: !!settings.hasPassword,

    msTenantId: String(settings.msTenantId || '').trim(),
    msClientId: String(settings.msClientId || '').trim(),
    msClientSecret: String(settings.msClientSecret || ''),
    hasMsClientSecret: !!settings.hasMsClientSecret,

    googleClientId: String(settings.googleClientId || '').trim(),
    googleClientSecret: String(settings.googleClientSecret || ''),
    hasGoogleClientSecret: !!settings.hasGoogleClientSecret,
    googleRefreshToken: String(settings.googleRefreshToken || ''),
    hasGoogleRefreshToken: !!settings.hasGoogleRefreshToken,
  };
}

async function invoke(action, body) {
  if (!shouldUseSupabase || !supabaseEnv.url || !supabaseEnv.anonKey) {
    return { ok: false, error: 'Supabase email settings backend is not configured.' };
  }
  try {
    const authSession = readAuthSessionSync();
    const response = await fetch(`${supabaseEnv.url}/functions/v1/email-config`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: supabaseEnv.anonKey,
        Authorization: `Bearer ${supabaseEnv.anonKey}`,
      },
      body: JSON.stringify({
        action,
        serverSessionToken: authSession?.serverSessionToken || null,
        ...body,
      }),
    });
    const rawText = await response.text();
    let data = null;
    if (rawText) {
      try {
        data = JSON.parse(rawText);
      } catch {
        return {
          ok: false,
          error: rawText || `Email settings backend returned HTTP ${response.status}.`,
        };
      }
    }
    if (!response.ok) {
      return {
        ok: false,
        error:
          data?.error
          || data?.message
          || `Email settings backend returned HTTP ${response.status}.`,
      };
    }
    return data || { ok: true };
  } catch (error) {
    return { ok: false, error: error?.message || 'Failed to contact email settings backend.' };
  }
}

export async function loadOrgSmtpSettings(orgKey) {
  const result = await invoke('get', { organizationKey: orgKey });
  if (!result?.ok) return result;
  return {
    ok: true,
    settings: normalizeSettings(result.settings),
  };
}

export async function saveOrgSmtpSettings(orgKey, settings) {
  const payload = normalizeSettings(settings);
  const result = await invoke('save', {
    organizationKey: orgKey,
    settings: payload,
  });
  if (!result?.ok) return result;
  return {
    ok: true,
    settings: normalizeSettings(result.settings),
  };
}

export async function verifyOrgSmtpConnection(orgKey, settings) {
  return invoke('verify', {
    organizationKey: orgKey,
    settings: normalizeSettings(settings),
  });
}

export async function sendOrgSmtpTestEmail(orgKey, settings, recipientEmail) {
  return invoke('send-test', {
    organizationKey: orgKey,
    settings: normalizeSettings(settings),
    recipientEmail: String(recipientEmail || '').trim().toLowerCase(),
  });
}

export function getDefaultSmtpSettings() {
  return { ...DEFAULT_SMTP_SETTINGS };
}
