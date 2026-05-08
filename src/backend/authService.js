import {
  readOrganizationsSync,
  hydrateOrganizations,
  readEmployeeCredentialsSync,
  hydrateEmployeeCredentials,
  persistEmployeeCredentials,
} from './stateStore';
import { resolveTenantContext } from './tenantResolver';
import { hashPasswordValue, verifyPasswordValue } from './passwordCrypto';

function normalizeLower(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeCode(value) {
  return String(value || '').trim();
}

function buildTemporaryPassword(prefix = 'Pass') {
  return `${prefix}@${Math.random().toString(36).slice(2, 8)}`;
}

async function persistCredentialUpgrade(existingCredentials, nextEntryKey, nextValue) {
  const nextCredentials = {
    ...(existingCredentials || {}),
    [nextEntryKey]: nextValue,
  };
  persistEmployeeCredentials(nextCredentials);
}

async function materializeCredentialRecord(existingCredentials, entryKey, record, password) {
  if (!record) return { ok: false, record };
  if (record.passwordHash) {
    const ok = await verifyPasswordValue(password, record.passwordHash);
    return { ok, record };
  }
  if (String(record.password || '') !== String(password || '')) {
    return { ok: false, record };
  }
  const passwordHash = await hashPasswordValue(password);
  const upgraded = {
    ...record,
    passwordHash,
  };
  delete upgraded.password;
  await persistCredentialUpgrade(existingCredentials, entryKey, upgraded);
  return { ok: true, record: upgraded };
}

async function resolveHrUser(orgs, credentials, identifier, password) {
  const normalized = normalizeLower(identifier);

  for (const org of orgs) {
    const primaryEmail = normalizeLower(org.hrAdminEmail);
    if (primaryEmail === normalized) {
      const primaryCredential = credentials?.[primaryEmail];
      if (primaryCredential) {
        const match = await materializeCredentialRecord(credentials, primaryEmail, primaryCredential, password);
        if (match.ok) {
          return {
            role: 'hr-admin',
            userName: org.hrAdminName || match.record?.name || 'HR Admin',
            orgKey: org.key,
          };
        }
      } else if (String(org.temporaryPassword || '') === password) {
        const passwordHash = await hashPasswordValue(password);
        persistEmployeeCredentials({
          ...(credentials || {}),
          [primaryEmail]: {
            passwordHash,
            name: org.hrAdminName || 'HR Admin',
            email: primaryEmail,
            orgKey: org.key,
            isTemp: true,
            isPrimaryHR: true,
          },
        });
        return {
          role: 'hr-admin',
          userName: org.hrAdminName || 'HR Admin',
          orgKey: org.key,
        };
      }
    }
  }

  for (const org of orgs) {
    const member = (org.hrTeam || []).find(
      (item) =>
        !item.isInPMS &&
        normalizeLower(item.email) === normalized
    );
    if (member) {
      const credentialKey = normalizeLower(member.email);
      const existingCredential = credentials?.[credentialKey];
      let loginAllowed = false;
      if (existingCredential) {
        const match = await materializeCredentialRecord(credentials, credentialKey, existingCredential, password);
        loginAllowed = match.ok;
      } else if (String(member.password || '') === password) {
        const passwordHash = await hashPasswordValue(password);
        persistEmployeeCredentials({
          ...(credentials || {}),
          [credentialKey]: {
            passwordHash,
            name: member.name,
            email: credentialKey,
            designation: member.type === 'co-admin' ? 'Co-Admin HR' : 'Scoped HR',
            managerCode: '',
            orgKey: org.key,
            isTemp: true,
            isHRTeam: true,
            hrTeamType: member.type,
          },
        });
        loginAllowed = true;
      }
      if (!loginAllowed) continue;
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

async function resolveEmployeeUser(orgs, credentials, identifier, password, scopedOrgKey = '') {
  const code = normalizeCode(identifier);
  const normalized = normalizeLower(identifier);
  let matchedKey = code;

  let match = credentials?.[code] || credentials?.[normalized] || null;
  if (credentials?.[normalized]) matchedKey = normalized;
  if (!match) {
    const entries = Object.entries(credentials || {});
    const found = entries.find(([, value]) => normalizeLower(value?.email) === normalized);
    if (found) {
      matchedKey = found[0];
      match = found[1];
    }
  }
  if (!match) return null;
  const verifyResult = await materializeCredentialRecord(credentials, matchedKey, match, password);
  if (!verifyResult.ok) return null;
  match = verifyResult.record;
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

  const hrUser = await resolveHrUser(orgs, creds, identifier, password);
  if (hrUser) return hrUser;

  return resolveEmployeeUser(orgs, creds, identifier, password, scopedOrgKey);
}

export async function changeEmployeePassword(empCode, currentPassword, newPassword) {
  const credentials = await hydrateEmployeeCredentials();
  const next = { ...(credentials || readEmployeeCredentialsSync() || {}) };
  const code = normalizeCode(empCode);
  const existing = next[code];

  if (!existing) {
    return { ok: false, error: 'Current password is incorrect.' };
  }
  const passwordOk = existing.passwordHash
    ? await verifyPasswordValue(currentPassword, existing.passwordHash)
    : String(existing.password || '') === currentPassword;
  if (!passwordOk) {
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
    passwordHash: await hashPasswordValue(newPassword),
    isTemp: false,
  };
  delete next[code].password;
  persistEmployeeCredentials(next);
  return { ok: true, credentials: next[code] };
}

export async function resetUserPasswordByAdmin({ orgKey = '', credentialKey = '', prefix = 'Pass' } = {}) {
  const credentials = await hydrateEmployeeCredentials();
  const next = { ...(credentials || readEmployeeCredentialsSync() || {}) };
  const targetKey = String(credentialKey || '').trim();
  const normalizedTarget = normalizeLower(targetKey);
  if (!targetKey) {
    return { ok: false, error: 'Credential key is required.' };
  }

  const entryKey = Object.keys(next).find((key) => {
    const cred = next[key];
    if (!cred) return false;
    const keyMatch = normalizeLower(key) === normalizedTarget;
    const emailMatch = normalizeLower(cred.email) === normalizedTarget;
    const orgMatch = !orgKey || String(cred.orgKey || '').trim() === String(orgKey || '').trim();
    return orgMatch && (keyMatch || emailMatch);
  });

  if (!entryKey || !next[entryKey]) {
    return { ok: false, error: 'User credential was not found for this organization.' };
  }

  const tempPassword = buildTemporaryPassword(prefix);
  next[entryKey] = {
    ...next[entryKey],
    passwordHash: await hashPasswordValue(tempPassword),
    isTemp: true,
  };
  delete next[entryKey].password;
  persistEmployeeCredentials(next);
  return {
    ok: true,
    tempPassword,
    credentialKey: entryKey,
    credential: next[entryKey],
  };
}
