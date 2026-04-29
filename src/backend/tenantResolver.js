import { readOrganizationsSync, hydrateOrganizations } from './stateStore';
import { shouldUseSupabase } from './config';
import { supabase } from './supabaseClient';

function normalizeSlug(value) {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '');
}

function normalizeHost(value) {
  return String(value || '').trim().toLowerCase().replace(/:\d+$/, '');
}

function readWorkspaceQueryParam(search = '') {
  try {
    const params = new URLSearchParams(search || '');
    return normalizeSlug(params.get('workspace') || params.get('tenant') || '');
  } catch (_) {
    return '';
  }
}

export function getRequestedWorkspaceSlug({ hostname, search } = {}) {
  const host = normalizeHost(hostname || (typeof window !== 'undefined' ? window.location.hostname : ''));
  const querySlug = readWorkspaceQueryParam(search || (typeof window !== 'undefined' ? window.location.search : ''));

  if (!host || host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0') {
    return querySlug;
  }

  if (host.endsWith('.zarohr.com')) {
    const prefix = host.slice(0, -'.zarohr.com'.length);
    return prefix && prefix !== 'www' ? normalizeSlug(prefix) : querySlug;
  }

  if (querySlug) return querySlug;
  return '';
}

function matchOrgByWorkspace(org, { slug, hostname }) {
  const workspaceSlug = normalizeSlug(org?.workspaceSlug || '');
  const domain = normalizeHost(org?.domain || '');

  if (slug && workspaceSlug && workspaceSlug === slug) return 'workspace_slug';
  if (hostname && domain && domain === hostname) return 'domain';
  if (slug && domain && domain === `${slug}.zarohr.com`) return 'derived_domain';
  return '';
}

function resolveTenantFromOrganizations(organizations = [], { slug, hostname }) {
  for (const org of organizations) {
    const matchedBy = matchOrgByWorkspace(org, { slug, hostname });
    if (!matchedBy) continue;
    return {
      orgKey: org.key,
      orgName: org.name || '',
      workspaceSlug: normalizeSlug(org.workspaceSlug || slug),
      domain: normalizeHost(org.domain || ''),
      matchedBy,
    };
  }
  return null;
}

async function resolveTenantFromSupabase({ slug, hostname }) {
  if (!shouldUseSupabase || !supabase) return null;
  if (!slug && !hostname) return null;

  try {
    let query = supabase
      .from('organizations')
      .select('org_key, name, workspace_slug, domain')
      .limit(1);

    if (slug) query = query.eq('workspace_slug', slug);
    else query = query.eq('domain', hostname);

    const { data, error } = await query.maybeSingle();
    if (error || !data?.org_key) return null;

    return {
      orgKey: data.org_key,
      orgName: data.name || '',
      workspaceSlug: normalizeSlug(data.workspace_slug || slug),
      domain: normalizeHost(data.domain || hostname),
      matchedBy: slug ? 'workspace_slug_remote' : 'domain_remote',
    };
  } catch (_) {
    return null;
  }
}

export async function resolveTenantContext(options = {}) {
  const hostname = normalizeHost(options.hostname || (typeof window !== 'undefined' ? window.location.hostname : ''));
  const slug = getRequestedWorkspaceSlug(options);

  if (!slug && !hostname) return null;

  const hydrated = await hydrateOrganizations();
  const organizations = Array.isArray(hydrated) ? hydrated : readOrganizationsSync();

  const localMatch = resolveTenantFromOrganizations(organizations, { slug, hostname });
  if (localMatch) return localMatch;

  return resolveTenantFromSupabase({ slug, hostname });
}
