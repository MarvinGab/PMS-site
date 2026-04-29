import { readOrganizationsSync, readWizardStateSync } from './backend/stateStore';

export const PMS_WIZARD_STATE_KEY = 'zarohr_pms_wizard_state_v1';

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
