import { readOrganizationsSync, readWizardStateSync } from './backend/stateStore';

export const PMS_WIZARD_STATE_KEY = 'zarohr_pms_wizard_state_v1';

// Canonical platform host. Used by buildWorkspaceUrl + tenant resolution.
// Kept here (not in env) so welcome emails and the org directory show a
// consistent, recognizable URL regardless of preview deploys.
export const PLATFORM_HOST = 'pms.zarohr.com';

function normalizeSlug(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// Build a tenant workspace URL using the new path-based scheme:
//   https://pms.zarohr.com/<slug>[#hash]
// Pass `absolute: false` to get the host-relative form ("pms.zarohr.com/slug")
// suitable for inline display in the org directory. Empty slug returns the
// platform root URL.
export function buildWorkspaceUrl(slugOrOrg, { absolute = false, hash = '', protocol = 'https' } = {}) {
  const slugSource = typeof slugOrOrg === 'object'
    ? (slugOrOrg?.workspaceSlug || slugOrOrg?.orgCode || slugOrOrg?.key || '')
    : slugOrOrg;
  const slug = normalizeSlug(slugSource || '');
  const path = slug ? `/${slug}` : '/';
  const fragment = hash ? (hash.startsWith('#') ? hash : `#${hash}`) : '';
  if (absolute) return `${protocol}://${PLATFORM_HOST}${path}${fragment}`;
  return `${PLATFORM_HOST}${path}${fragment}`;
}

export function getWizardStorageKey(orgKey = '') {
  return `${PMS_WIZARD_STATE_KEY}:${orgKey || 'default'}`;
}

export function readWizardState(orgKey) {
  if (!orgKey || typeof window === 'undefined') return null;
  return readWizardStateSync(orgKey);
}

export function getStatusMetaFromPct(pct) {
  if (pct >= 100) return { status: 'Configured', statusBadgeClass: 'badge-green', setupColor: '#16A34A', actionLabel: 'Manage' };
  if (pct >= 50) return { status: 'In Progress', statusBadgeClass: 'badge-blue', setupColor: '#2563EB', actionLabel: 'Continue' };
  if (pct > 0) return { status: 'Setup Started', statusBadgeClass: 'badge-amber', setupColor: '#D97706', actionLabel: 'Continue' };
  return { status: 'Not Started', statusBadgeClass: 'badge-gray', setupColor: '#94A3B8', actionLabel: 'Start Setup' };
}

export function getOrganizationEmployeeCount(org) {
  const wizardState = readWizardState(org?.key);
  const uploadData = wizardState?.config?.employeeUploadData;
  if (!uploadData) return Number(org?.employees) || 0;
  if (Array.isArray(uploadData.employees)) return uploadData.employees.length;
  return Number(uploadData.count) || 0;
}

export function getOrganizationSetupMeta(org) {
  if (org?.launched && !org?.setupReopened) {
    return {
      pct: 100,
      status: 'Launched',
      statusBadgeClass: 'badge-green',
      setupColor: '#16A34A',
      actionLabel: 'Manage',
      source: 'organization',
    };
  }

  if (org?.setupReopened) {
    return {
      pct: Math.max(0, Math.min(100, Math.round(Number(org?.setupPct) || 100))),
      status: 'Setup Reopened',
      statusBadgeClass: 'badge-amber',
      setupColor: '#D97706',
      actionLabel: 'Close Setup',
      source: 'organization',
    };
  }

  const wizardState = readWizardState(org?.key);
  const saved = wizardState?.setupProgress;
  if (saved && Number.isFinite(saved.pct)) {
    const pct = Math.max(0, Math.min(100, Math.round(saved.pct)));
    return { pct, ...getStatusMetaFromPct(pct), source: 'wizard' };
  }
  const legacyPct = Number(org?.setupPct) || 0;
  return { pct: legacyPct, ...getStatusMetaFromPct(legacyPct), source: 'legacy' };
}

export function getOrgNameByKey(orgKey) {
  if (!orgKey || typeof window === 'undefined') return '';
  try {
    const org = readOrganizationsSync().find((item) => item.key === orgKey) || null;
    return org?.name || '';
  } catch (_) {
    return '';
  }
}
