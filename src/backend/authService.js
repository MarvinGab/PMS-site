import {
  readOrganizationsSync,
  hydrateOrganizations,
  readEmployeeCredentialsSync,
  hydrateEmployeeCredentials,
  persistEmployeeCredentials,
} from './stateStore';
import { resolveTenantContext } from './tenantResolver';

function normalizeLower(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeCode(value) {
  return String(value || '').trim();
}

function resolveHrUser(orgs, identifier, password) {
  const normalized = normalizeLower(identifier);

  const primaryOrg = orgs.find(
    (org) =>
      normalizeLower(org.hrAdminEmail) === normalized &&
      String(org.temporaryPassword || '') === password
  );
  if (primaryOrg) {
    return {
      role: 'hr-admin',
      userName: primaryOrg.hrAdminName || 'HR Admin',
      orgKey: primaryOrg.key,
    };
  }

  for (const org of orgs) {
    const member = (org.hrTeam || []).find(
      (item) =>
        !item.isInPMS &&
        normalizeLower(item.email) === normalized &&
        String(item.password || '') === password
    );
    if (member) {
      return {
        role: 'hr-admin',
        userName: member.name,
        orgKey: org.key,
        isCoAdmin: member.type === 'co-admin',
        isScopedHR: member.type === 'scoped-hr',
        hrTeamId: member.id,
        allowedModules: member.allowedModules || null,
      };
    }
  }

  return null;
}

function resolveEmployeeUser(orgs, credentials, identifier, password, scopedOrgKey = '') {
  const code = normalizeCode(identifier);
  const normalized = normalizeLower(identifier);

  let match = credentials?.[code] || credentials?.[normalized] || null;
  if (!match) {
    const entries = Object.entries(credentials || {});
    const found = entries.find(([, value]) => normalizeLower(value?.email) === normalized);
    if (found) match = found[1];
  }
  if (!match || String(match.password || '') !== password) return null;
  if (scopedOrgKey && match.orgKey && match.orgKey !== scopedOrgKey) return null;

  for (const org of orgs) {
    const member = (org.hrTeam || []).find(
      (item) => item.isInPMS && normalizeCode(item.empCode) === normalizeCode(match.empCode || code)
    );
    if (member) {
      return {
        role: 'hr-admin',
        userName: match.name || member.name,
        orgKey: org.key,
        isCoAdmin: member.type === 'co-admin',
        isScopedHR: member.type === 'scoped-hr',
        hrTeamId: member.id,
        empCode: normalizeCode(match.empCode || code),
        allowedModules: member.allowedModules || null,
      };
    }
  }

  return {
    role: 'employee',
    empCode: normalizeCode(match.empCode || code),
    userName: match.name || '',
    designation: match.designation || '',
    managerCode: match.managerCode || '',
    orgKey: match.orgKey || scopedOrgKey || '',
    isTemp: !!match.isTemp,
    email: match.email || '',
  };
}

export async function resolveLoginUser(identifier, password, superAdmin) {
  const normalized = normalizeLower(identifier);
  if (
    normalized === normalizeLower(superAdmin?.email) &&
    password === String(superAdmin?.password || '')
  ) {
    return { role: 'super-admin', userName: 'Super Admin' };
  }

  const [orgsData, credentials] = await Promise.all([
    hydrateOrganizations(),
    hydrateEmployeeCredentials(),
  ]);
  const tenantContext = await resolveTenantContext();
  const allOrgs = orgsData || readOrganizationsSync() || [];
  const scopedOrgKey = tenantContext?.orgKey || '';
  const orgs = scopedOrgKey
    ? allOrgs.filter((org) => org.key === scopedOrgKey)
    : allOrgs;
  const creds = credentials || readEmployeeCredentialsSync() || {};

  const hrUser = resolveHrUser(orgs, identifier, password);
  if (hrUser) return hrUser;

  return resolveEmployeeUser(orgs, creds, identifier, password, scopedOrgKey);
}

export async function changeEmployeePassword(empCode, currentPassword, newPassword) {
  const credentials = await hydrateEmployeeCredentials();
  const next = { ...(credentials || readEmployeeCredentialsSync() || {}) };
  const code = normalizeCode(empCode);
  const existing = next[code];

  if (!existing || String(existing.password || '') !== currentPassword) {
    return { ok: false, error: 'Current password is incorrect.' };
  }
  if (String(newPassword || '').length < 6) {
    return { ok: false, error: 'New password must be at least 6 characters.' };
  }
  if (String(newPassword) === String(currentPassword)) {
    return { ok: false, error: 'New password must differ from the temporary password.' };
  }

  next[code] = {
    ...existing,
    password: newPassword,
    isTemp: false,
  };
  persistEmployeeCredentials(next);
  return { ok: true, credentials: next[code] };
}
