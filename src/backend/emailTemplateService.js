import { shouldUseSupabase } from './config';
import { supabase } from './supabaseClient';

const TEMPLATE_CACHE_KEY = 'zarohr_email_templates_v1';
export const HR_ADMIN_INVITE_TEMPLATE_KEY = 'org-admin-invite';

export const DEFAULT_HR_ADMIN_INVITE_TEMPLATE = {
  name: 'HR Admin Invite',
  subject: 'Your {organization_name} workspace is ready',
  config: {
    headerLabel: 'Zaro HR',
    headline: 'Your {organization_name} workspace is ready',
    intro: 'Your Zaro HR admin workspace has been provisioned and is ready to open.',
    ctaLabel: 'Open workspace',
    footerText: 'Zaro HR, Product Communications',
    supportEmail: 'support@zarohr.com',
  },
};

function readTemplateCache() {
  if (typeof window === 'undefined') return {};
  try {
    return JSON.parse(window.localStorage.getItem(TEMPLATE_CACHE_KEY) || '{}');
  } catch {
    return {};
  }
}

function writeTemplateCache(cache) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(TEMPLATE_CACHE_KEY, JSON.stringify(cache || {}));
  } catch {
    // ignore cache write failures
  }
}

function templateCacheId(ownerKey, templateKey) {
  return `${ownerKey}:${templateKey}`;
}

export function resolveTemplateText(template, tokens) {
  return String(template || '').replace(/\{([a-z0-9_]+)\}/gi, (_, rawKey) => {
    const key = String(rawKey || '').trim().toLowerCase();
    return tokens[key] != null ? String(tokens[key]) : `{${rawKey}}`;
  });
}

export async function hydrateEmailTemplate(templateKey, ownerKey = 'global') {
  const cache = readTemplateCache();
  const cacheKey = templateCacheId(ownerKey, templateKey);
  const fallback = cache[cacheKey] || null;

  if (!shouldUseSupabase || !supabase) return fallback;

  try {
    const { data, error } = await supabase
      .from('email_templates')
      .select('owner_key, template_key, name, subject, config')
      .eq('owner_key', ownerKey)
      .eq('template_key', templateKey)
      .maybeSingle();
    if (error) throw error;
    if (data) {
      const template = {
        ownerKey: data.owner_key,
        templateKey: data.template_key,
        name: data.name,
        subject: data.subject,
        config: data.config || {},
      };
      writeTemplateCache({ ...cache, [cacheKey]: template });
      return template;
    }
  } catch {
    // ignore and fall through to cache/default
  }

  return fallback;
}

export async function saveEmailTemplate({
  ownerKey = 'global',
  templateKey,
  name,
  subject,
  config,
  organizationId = null,
} = {}) {
  const payload = {
    owner_key: ownerKey,
    template_key: templateKey,
    name: name || 'Email Template',
    subject: subject || '',
    config: config || {},
    organization_id: organizationId,
    updated_at: new Date().toISOString(),
  };

  const cache = readTemplateCache();
  const cacheKey = templateCacheId(ownerKey, templateKey);
  const nextTemplate = {
    ownerKey,
    templateKey,
    name: payload.name,
    subject: payload.subject,
    config: payload.config,
  };
  writeTemplateCache({ ...cache, [cacheKey]: nextTemplate });

  if (!shouldUseSupabase || !supabase) return { ok: true, template: nextTemplate };

  try {
    const { error } = await supabase
      .from('email_templates')
      .upsert(payload, { onConflict: 'owner_key,template_key' });
    if (error) throw error;
    return { ok: true, template: nextTemplate };
  } catch (error) {
    return { ok: false, error: error?.message || 'Failed to save email template.', template: nextTemplate };
  }
}

export function getDefaultHrAdminInviteTemplate() {
  return {
    ownerKey: 'global',
    templateKey: HR_ADMIN_INVITE_TEMPLATE_KEY,
    ...DEFAULT_HR_ADMIN_INVITE_TEMPLATE,
  };
}
