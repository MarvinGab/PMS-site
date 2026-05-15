import { readOrganizationsSync, hydrateOrganizations } from './stateStore';
import { shouldUseSupabase } from './config';
import { supabase } from './supabaseClient';

function normalizeSlug(value) {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '');
}

function normalizeHost(value) {
  return String(value || '').trim().toLowerCase().replace(/:\d+$/, '');
}

function isPlatformHost(host) {
  return host === 'zarohr.com' || host === 'www.zarohr.com' || host === 'pms.zarohr.com';
}

function isLocalHost(host) {
  return host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0';
}

// Reserved path prefixes that are NOT tenant slugs. These are platform-level
// routes / static assets, so the first path segment shouldn't be treated as a
// workspace slug when it matches one of these.
const RESERVED_PATH_PREFIXES = new Set([
  '', 'assets', 'api', 'static', 'public', 'favicon.ico', 'robots.txt',
  'sitemap.xml', 'images', 'manifest.json',
]);

function readWorkspacePathSegment(pathname = '') {
  const raw = String(pathname || '').split('/').filter(Boolean)[0] || '';
  const candidate = normalizeSlug(raw);
  if (!candidate || RESERVED_PATH_PREFIXES.has(candidate)) return '';
  return candidate;
}

// Tenant slug now lives entirely in the URL path (e.g. /trio-infrastructure)
// or in the subdomain (e.g. trio.zarohr.com). The legacy `?workspace=` query
// param is intentionally not consulted — removed during the setup-phase
// touchups so the URL scheme stays single-form and unambiguous.
export function getRequestedWorkspaceSlug({ hostname, pathname } = {}) {
  const host = normalizeHost(hostname || (typeof window !== 'undefined' ? window.location.hostname : ''));
  const path = pathname || (typeof window !== 'undefined' ? window.location.pathname : '');
  const pathSlug = readWorkspacePathSegment(path);

  if (!host || isLocalHost(host)) {
    return pathSlug;
  }

  if (isPlatformHost(host)) {
    return pathSlug;
  }

  if (host.endsWith('.zarohr.com')) {
    const prefix = host.slice(0, -'.zarohr.com'.length);
    if (prefix && prefix !== 'www') return normalizeSlug(prefix);
    return pathSlug;
  }

  return pathSlug;
}

function matchOrgByWorkspace(org, { slug, hostname }) {
  const workspaceSlug = normalizeSlug(org?.workspaceSlug || '');
  const domain = normalizeHost(org?.domain || '');
  const canMatchDomain = !!hostname && !isPlatformHost(hostname) && !isLocalHost(hostname);

  if (slug && workspaceSlug && workspaceSlug === slug) return 'workspace_slug';
  if (canMatchDomain && domain && domain === hostname) return 'domain';
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
  const canMatchDomain = !!hostname && !isPlatformHost(hostname) && !isLocalHost(hostname);
  if (!slug && !canMatchDomain) return null;

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

  if (!slug && (!hostname || isPlatformHost(hostname) || isLocalHost(hostname))) return null;

  const hydrated = await hydrateOrganizations();
  const organizations = Array.isArray(hydrated) ? hydrated : readOrganizationsSync();

  const localMatch = resolveTenantFromOrganizations(organizations, { slug, hostname });
  if (localMatch) return localMatch;

  return resolveTenantFromSupabase({ slug, hostname });
}
