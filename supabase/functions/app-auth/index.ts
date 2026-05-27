import nodemailer from 'npm:nodemailer@6.10.1'
import { createClient } from 'npm:@supabase/supabase-js@2.57.4'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json',
}

const SESSION_TTL_MS = 1000 * 60 * 60 * 12
// Longer "stay signed in" lifetime — used when the user ticked Remember me
// on the login screen. Matches the auto-sign-in feel of Gmail / Amazon
// without leaving sessions live indefinitely.
const SESSION_TTL_REMEMBER_MS = 1000 * 60 * 60 * 24 * 30
const SUPER_ADMIN_EMAIL = 'admin@zarohr.com'
const SUPER_ADMIN_PASSWORD = 'admin123'

type OrgRow = {
  id: string
  org_key: string
  name: string | null
  hr_admin_name: string | null
  hr_admin_email: string | null
  setup_payload: Record<string, unknown> | null
}

function json(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), { status, headers: corsHeaders })
}

function normalizeLower(value: unknown) {
  return String(value || '').trim().toLowerCase()
}

function normalizeCode(value: unknown) {
  return String(value || '').trim()
}

function normalizeWorkspace(value: unknown) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^pms\.zarohr\.com\//, '')
    .replace(/^www\./, '')
    .replace(/[#?].*$/, '')
    .replace(/\/+$/, '')
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function textEncoder() {
  return new TextEncoder()
}

function fromBase64(value: string) {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}

function toBase64(bytes: Uint8Array) {
  let binary = ''
  bytes.forEach((byte) => { binary += String.fromCharCode(byte) })
  return btoa(binary)
}

async function deriveBits(password: string, saltBytes: Uint8Array, iterations: number) {
  const key = await crypto.subtle.importKey(
    'raw',
    textEncoder().encode(password),
    { name: 'PBKDF2' },
    false,
    ['deriveBits'],
  )
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: saltBytes, iterations },
    key,
    256,
  )
  return new Uint8Array(bits)
}

async function verifyPasswordValue(password: string, storedHash: string) {
  const rawHash = String(storedHash || '')
  if (!rawHash) return false
  if (!rawHash.startsWith('pbkdf2$')) {
    return password === rawHash
  }
  const [, iterationsText, saltText, digestText] = rawHash.split('$')
  const iterations = Number(iterationsText) || 120000
  const saltBytes = fromBase64(saltText)
  const expectedDigest = fromBase64(digestText)
  const actualDigest = await deriveBits(password, saltBytes, iterations)
  if (actualDigest.length !== expectedDigest.length) return false
  let mismatch = 0
  for (let index = 0; index < actualDigest.length; index += 1) mismatch |= actualDigest[index] ^ expectedDigest[index]
  return mismatch === 0
}

async function matchesSuperAdminCredentials(identifier: string, password: string) {
  const envEmail = normalizeLower(Deno.env.get('APP_AUTH_SUPER_ADMIN_EMAIL') || '')
  const envPassword = String(Deno.env.get('APP_AUTH_SUPER_ADMIN_PASSWORD') || '')
  const envPasswordHash = String(Deno.env.get('APP_AUTH_SUPER_ADMIN_PASSWORD_HASH') || '')
  const normalized = normalizeLower(identifier)

  if (envEmail) {
    if (normalized !== envEmail) return false
    if (envPasswordHash) return await verifyPasswordValue(password, envPasswordHash)
    if (envPassword) return password === envPassword
    return false
  }

  return normalized === SUPER_ADMIN_EMAIL && password === SUPER_ADMIN_PASSWORD
}

async function getOrganizations(client: ReturnType<typeof createClient>) {
  const { data, error } = await client
    .from('organizations')
    .select('id, org_key, name, hr_admin_name, hr_admin_email, setup_payload')
  if (error) throw error
  return (data || []) as OrgRow[]
}

async function resolveOrganizationKeyFromWorkspace(
  client: ReturnType<typeof createClient>,
  organizationKey = '',
  workspace = '',
) {
  const explicitKey = String(organizationKey || '').trim()
  if (explicitKey) return explicitKey

  const token = normalizeWorkspace(workspace)
  if (!token) return ''

  // Avoid `.maybeSingle()` after `.or()` — when more than one row happens to
  // match (e.g. a slug that also collides with an org_code on a different
  // org), `maybeSingle` throws "PGRST116" and the whole edge function 500s.
  // Fetching `.limit(1)` and reading `data[0]` is bulletproof regardless of
  // how many rows the OR filter would have returned.
  const { data, error } = await client
    .from('organizations')
    .select('org_key, org_code, workspace_slug')
    .or(`workspace_slug.eq.${token},org_code.eq.${token},org_key.eq.${token}`)
    .limit(1)
  if (error) return ''
  const row = Array.isArray(data) ? data[0] : null
  if (!row?.org_key) return ''
  return String(row.org_key || '').trim()
}

async function getCredentialBlob(client: ReturnType<typeof createClient>) {
  const { data, error } = await client
    .from('app_state')
    .select('payload')
    .eq('state_key', 'employee_credentials')
    .eq('org_key', '')
    .maybeSingle()
  if (error) throw error
  return (data?.payload && typeof data.payload === 'object') ? data.payload as Record<string, Record<string, unknown>> : {}
}

async function deleteServerSession(client: ReturnType<typeof createClient>, token: string) {
  await client
    .from('app_state')
    .delete()
    .eq('state_key', `server_session:${token}`)
    .eq('org_key', '')
}

function getHrTeam(org: OrgRow) {
  const setupPayload = org.setup_payload && typeof org.setup_payload === 'object' ? org.setup_payload : null
  const orgData = setupPayload?.orgData
  if (!orgData || typeof orgData !== 'object') return []
  return Array.isArray((orgData as Record<string, unknown>).hrTeam)
    ? (orgData as Record<string, unknown>).hrTeam as Array<Record<string, unknown>>
    : []
}

async function resolveServerLogin(client: ReturnType<typeof createClient>, identifier: string, password: string, organizationKey = '', workspace = '') {
  const normalized = normalizeLower(identifier)
  const scopedOrgKey = await resolveOrganizationKeyFromWorkspace(client, organizationKey, workspace)

  if (await matchesSuperAdminCredentials(normalized, password)) {
    return { role: 'super-admin', userName: 'Super Admin' }
  }

  // Tenant users (HR admin, co-admin, scoped HR, employees) must come in via
  // their workspace URL — never the base URL. Without a workspace, we can't
  // even tell which org's branding to render.
  if (!scopedOrgKey) {
    return { __scopeError: workspace ? 'workspace-not-found' : 'org-user-needs-workspace-url' }
  }

  const [orgs, credentials] = await Promise.all([
    getOrganizations(client),
    getCredentialBlob(client),
  ])

  const candidateOrgs = scopedOrgKey
    ? orgs.filter((org) => org.org_key === scopedOrgKey)
    : orgs

  for (const org of candidateOrgs) {
    if (normalizeLower(org.hr_admin_email) === normalized) {
      const primaryCredential = credentials?.[normalized]
      const primaryStoredSecret = String(primaryCredential?.passwordHash || primaryCredential?.password || '')
      if (primaryStoredSecret && await verifyPasswordValue(password, primaryStoredSecret)) {
        return {
          role: 'hr-admin',
          orgKey: org.org_key,
          userName: org.hr_admin_name || 'HR Admin',
          isTemp: !!primaryCredential?.isTemp,
          credentialKey: normalized,
        }
      }
      // Only allow the org's seeded OTP to authenticate if there is no
      // credential record yet — otherwise the OTP could keep re-opening
      // the forced-reset flow after the admin already set a permanent
      // password.
      if (!primaryCredential) {
        const setupPayload = org.setup_payload && typeof org.setup_payload === 'object' ? org.setup_payload : null
        const tempPassword = String((setupPayload?.orgData as Record<string, unknown> | undefined)?.temporaryPassword || '')
        if (tempPassword && tempPassword === password) {
          return {
            role: 'hr-admin',
            orgKey: org.org_key,
            userName: org.hr_admin_name || 'HR Admin',
            isTemp: true,
            credentialKey: normalized,
          }
        }
      }
    }

    for (const member of getHrTeam(org)) {
      if (member.isInPMS) continue
      const email = normalizeLower(member.email)
      if (!email || email !== normalized) continue
      const credential = credentials?.[email]
      const storedSecret = String(credential?.passwordHash || credential?.password || '')
      if (storedSecret && await verifyPasswordValue(password, storedSecret)) {
        return {
          role: 'hr-admin',
          orgKey: org.org_key,
          userName: String(member.name || ''),
          isCoAdmin: member.type === 'co-admin',
          isScopedHR: member.type === 'scoped-hr',
          hrTeamId: String(member.id || ''),
          allowedModules: Array.isArray(member.allowedModules) ? member.allowedModules : null,
          isTemp: !!credential?.isTemp,
          credentialKey: email,
        }
      }
      // Same guard as the primary admin: only let the seeded OTP through
      // when no credential record exists yet for this team member.
      const tempPassword = String(member.password || '')
      if (!credential && tempPassword && tempPassword === password) {
        return {
          role: 'hr-admin',
          orgKey: org.org_key,
          userName: String(member.name || ''),
          isCoAdmin: member.type === 'co-admin',
          isScopedHR: member.type === 'scoped-hr',
          hrTeamId: String(member.id || ''),
          allowedModules: Array.isArray(member.allowedModules) ? member.allowedModules : null,
          isTemp: true,
          credentialKey: email,
        }
      }
    }
  }

  let matchKey = normalizeCode(identifier)
  let credential = credentials?.[matchKey] || credentials?.[normalized] || null
  if (!credential) {
    const found = Object.entries(credentials).find(([, value]) => normalizeLower(value?.email) === normalized)
    if (found) {
      matchKey = found[0]
      credential = found[1]
    }
  }
  if (!credential && matchKey) {
    const found = Object.entries(credentials).find(([key, value]) =>
      normalizeCode(value?.empCode || key) === matchKey
    )
    if (found) {
      matchKey = found[0]
      credential = found[1]
    }
  }
  const storedSecret = String(credential?.passwordHash || credential?.password || '')
  if (!storedSecret || !(await verifyPasswordValue(password, storedSecret))) {
    return null
  }

  const empCode = normalizeCode(credential.empCode || matchKey)
  if (scopedOrgKey && String(credential.orgKey || '') && String(credential.orgKey || '') !== scopedOrgKey) {
    return null
  }

  for (const org of candidateOrgs) {
    const hrMember = getHrTeam(org).find((member) => member.isInPMS && normalizeCode(member.empCode) === empCode)
    if (hrMember) {
      return {
        role: 'hr-admin',
        orgKey: org.org_key,
        userName: String(credential.name || hrMember.name || ''),
        isCoAdmin: hrMember.type === 'co-admin',
        isScopedHR: hrMember.type === 'scoped-hr',
        hrTeamId: String(hrMember.id || ''),
        empCode,
        allowedModules: Array.isArray(hrMember.allowedModules) ? hrMember.allowedModules : null,
      }
    }
  }

  return {
    role: 'employee',
    empCode,
    userName: String(credential.name || ''),
    designation: String(credential.designation || ''),
    managerCode: String(credential.managerCode || ''),
    orgKey: String(credential.orgKey || scopedOrgKey || ''),
    isTemp: !!credential.isTemp,
    email: String(credential.email || ''),
  }
}

async function issueSession(client: ReturnType<typeof createClient>, user: Record<string, unknown>, rememberMe = false) {
  const token = crypto.randomUUID()
  const now = new Date()
  const ttl = rememberMe ? SESSION_TTL_REMEMBER_MS : SESSION_TTL_MS
  const expiresAt = new Date(now.getTime() + ttl).toISOString()
  await client.from('app_state').upsert({
    state_key: `server_session:${token}`,
    org_key: '',
    payload: {
      ...user,
      expiresAt,
      issuedAt: now.toISOString(),
      rememberMe: !!rememberMe,
    },
  }, { onConflict: 'state_key,org_key' })
  return { token, expiresAt }
}

async function revokeSession(client: ReturnType<typeof createClient>, token: string) {
  await deleteServerSession(client, token)
}

async function inspectSession(client: ReturnType<typeof createClient>, token: string) {
  const { data, error } = await client
    .from('app_state')
    .select('payload')
    .eq('state_key', `server_session:${token}`)
    .eq('org_key', '')
    .maybeSingle()
  if (error) throw error
  const payload = data?.payload && typeof data.payload === 'object' ? data.payload as Record<string, unknown> : null
  if (!payload) return { ok: false, error: 'Server session is missing or expired.' }
  const expiresAt = String(payload.expiresAt || '')
  if (expiresAt && Date.now() > Date.parse(expiresAt)) {
    await deleteServerSession(client, token)
    return { ok: false, error: 'Server session has expired.' }
  }
  return { ok: true, payload }
}

async function hashPasswordValue(password: string) {
  const iterations = 120000
  const saltBytes = crypto.getRandomValues(new Uint8Array(16))
  const digest = await deriveBits(password, saltBytes, iterations)
  return `pbkdf2$${iterations}$${toBase64(saltBytes)}$${toBase64(digest)}`
}

// ─── Password reset (OTP) helpers ────────────────────────────────────────
const RESET_CODE_TTL_MS = 1000 * 60 * 15
const RESET_PREFIX = 'password_reset:'
const RESET_REQUEST_COOLDOWN_MS = 1000 * 60

function normalizeIdentifierForKey(value: string) {
  return normalizeLower(value)
}

function generateSixDigitCode() {
  // Crypto-secure random 6-digit number, padded.
  const buf = crypto.getRandomValues(new Uint32Array(1))
  const n = buf[0] % 1_000_000
  return n.toString().padStart(6, '0')
}

function formatCodeWithHyphen(code: string) {
  return `${code.slice(0, 3)}-${code.slice(3)}`
}

function constantTimeEqual(a: string, b: string) {
  if (a.length !== b.length) return false
  let mismatch = 0
  for (let i = 0; i < a.length; i += 1) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return mismatch === 0
}

type CredentialLookup = {
  credentialKey: string
  recipientEmail: string
  displayName: string
  kind: 'employee' | 'hr-admin'
  orgKey: string
  employeeCode?: string
  missingEmail?: boolean
}

async function locateCredentialByIdentifier(
  client: ReturnType<typeof createClient>,
  identifier: string,
  organizationKey: string,
): Promise<CredentialLookup | null> {
  const normalized = normalizeLower(identifier)
  if (!normalized || !organizationKey) return null

  const [orgs, credentials] = await Promise.all([
    getOrganizations(client),
    getCredentialBlob(client),
  ])

  const targetOrg = orgs.find((o) => o.org_key === organizationKey)
  if (!targetOrg) return null

  // 1) HR admin: identifier matches the org's hr_admin_email
  if (normalizeLower(targetOrg.hr_admin_email) === normalized) {
    return {
      credentialKey: normalized,
      recipientEmail: normalized,
      displayName: targetOrg.hr_admin_name || 'HR Admin',
      kind: 'hr-admin',
      orgKey: targetOrg.org_key,
    }
  }
  // 2) HR co-admin / scoped HR within this org
  for (const member of getHrTeam(targetOrg)) {
    if (member.isInPMS) continue
    const email = normalizeLower(member.email)
    if (email && email === normalized) {
      return {
        credentialKey: email,
        recipientEmail: email,
        displayName: String(member.name || 'HR'),
        kind: 'hr-admin',
        orgKey: targetOrg.org_key,
      }
    }
  }

  // 3) Employee in this org: identifier may be empCode OR email
  const codeKey = normalizeCode(identifier)
  const candidateByCode = credentials[codeKey]
  if (candidateByCode && String(candidateByCode.orgKey || '') === targetOrg.org_key) {
    const email = normalizeLower(candidateByCode.email)
    return {
      credentialKey: codeKey,
      recipientEmail: email,
      displayName: String(candidateByCode.name || codeKey),
      kind: 'employee',
      orgKey: targetOrg.org_key,
      employeeCode: codeKey,
      missingEmail: !email,
    }
  }
  const found = Object.entries(credentials).find(([, value]) =>
    normalizeLower(value?.email) === normalized
    && String(value?.orgKey || '') === targetOrg.org_key,
  )
  if (found) {
    const [key, c] = found
    const email = normalizeLower(c?.email)
    if (email) {
      return {
        credentialKey: key,
        recipientEmail: email,
        displayName: String(c?.name || key),
        kind: 'employee',
        orgKey: targetOrg.org_key,
        employeeCode: normalizeCode(c?.empCode || key),
      }
    }
  }

  const { data: employeeRow, error: employeeErr } = await client
    .from('employees')
    .select('employee_code, employee_name, email')
    .eq('organization_id', targetOrg.id)
    .or(`employee_code.eq.${codeKey},email.eq.${normalized}`)
    .maybeSingle()
  if (employeeErr) throw employeeErr
  if (employeeRow) {
    const employeeCode = normalizeCode(employeeRow.employee_code)
    const email = normalizeLower(employeeRow.email)
    return {
      credentialKey: employeeCode || normalized,
      recipientEmail: email,
      displayName: String(employeeRow.employee_name || employeeCode || normalized),
      kind: 'employee',
      orgKey: targetOrg.org_key,
      employeeCode,
      missingEmail: !email,
    }
  }

  return null
}

async function suggestOrgsByQuery(
  client: ReturnType<typeof createClient>,
  query: string,
) {
  const trimmed = String(query || '').trim()
  if (trimmed.length < 2) return []
  const pattern = `%${trimmed.replace(/[%_]/g, (m) => `\\${m}`)}%`
  const { data, error } = await client
    .from('organizations')
    .select('org_key, org_code, name, workspace_slug')
    .or(`name.ilike.${pattern},org_code.ilike.${pattern},org_key.ilike.${pattern},workspace_slug.ilike.${pattern}`)
    .order('name', { ascending: true })
    .limit(8)
  if (error) throw error
  return (data || []).map((row) => ({
    key: String(row.org_key || ''),
    code: String(row.org_code || ''),
    name: String(row.name || ''),
    workspaceSlug: String(row.workspace_slug || ''),
  }))
}

async function updateCredentialPassword(
  client: ReturnType<typeof createClient>,
  credentialKey: string,
  newPasswordHash: string,
  patch: Record<string, unknown> = {},
) {
  const credentials = await getCredentialBlob(client)
  const existing = credentials[credentialKey] || {}
  const next = {
    ...credentials,
    [credentialKey]: {
      ...existing,
      ...patch,
      passwordHash: newPasswordHash,
      isTemp: false,
    },
  }
  // Strip any plaintext password if it was lingering
  if (next[credentialKey] && 'password' in (next[credentialKey] as Record<string, unknown>)) {
    delete (next[credentialKey] as Record<string, unknown>).password
  }
  const { error } = await client
    .from('app_state')
    .upsert(
      { state_key: 'employee_credentials', org_key: '', payload: next },
      { onConflict: 'state_key,org_key' },
    )
  if (error) throw error
  return next[credentialKey] as Record<string, unknown>
}

// Once an HR admin has set a permanent password, strip the original OTP
// from the org's setup_payload (and for HR team members, from their
// hrTeam entry). Leaving it there means anyone who still has the welcome
// email could keep logging in via the temp-password fallback in
// `resolveServerLogin`, which also forces a fresh password reset every
// time and effectively wipes the new password.
async function clearOrgTempPasswordForCredential(
  client: ReturnType<typeof createClient>,
  org: OrgRow,
  credentialKey: string,
) {
  if (!org?.org_key) return
  const setupPayload = (org.setup_payload && typeof org.setup_payload === 'object')
    ? { ...org.setup_payload as Record<string, unknown> }
    : null
  if (!setupPayload) return
  const orgData = setupPayload.orgData && typeof setupPayload.orgData === 'object'
    ? { ...(setupPayload.orgData as Record<string, unknown>) }
    : null
  if (!orgData) return

  const primaryEmail = normalizeLower(org.hr_admin_email)
  const normalizedKey = normalizeLower(credentialKey)
  let changed = false

  if (primaryEmail && primaryEmail === normalizedKey && orgData.temporaryPassword) {
    orgData.temporaryPassword = ''
    changed = true
  }

  if (Array.isArray(orgData.hrTeam)) {
    const nextTeam = (orgData.hrTeam as Array<Record<string, unknown>>).map((member) => {
      if (member?.isInPMS) return member
      const memberEmail = normalizeLower(member?.email)
      if (memberEmail && memberEmail === normalizedKey && member?.password) {
        changed = true
        const copy = { ...member }
        copy.password = ''
        return copy
      }
      return member
    })
    if (changed) orgData.hrTeam = nextTeam
  }

  if (!changed) return
  setupPayload.orgData = orgData
  const { error } = await client
    .from('organizations')
    .update({ setup_payload: setupPayload })
    .eq('org_key', org.org_key)
  if (error) throw error
}

async function locateCredentialForPasswordChange(
  client: ReturnType<typeof createClient>,
  { identifier, organizationKey, credentialKey }: { identifier: string; organizationKey: string; credentialKey: string },
) {
  const normalizedCredentialKey = normalizeLower(credentialKey)
  const codeCredentialKey = normalizeCode(credentialKey)
  const normalizedIdentifier = normalizeLower(identifier)
  const codeIdentifier = normalizeCode(identifier)
  const [orgs, credentials] = await Promise.all([
    getOrganizations(client),
    getCredentialBlob(client),
  ])
  const targetOrg = orgs.find((org) => org.org_key === organizationKey)
  if (!targetOrg) return null

  const primaryEmail = normalizeLower(targetOrg.hr_admin_email)
  if (
    primaryEmail
    && (
      normalizedCredentialKey === primaryEmail
      || normalizedIdentifier === primaryEmail
    )
  ) {
    return {
      credentialKey: primaryEmail,
      credential: credentials[primaryEmail] || null,
      org: targetOrg,
      kind: 'hr-admin',
      patch: {
        email: primaryEmail,
        name: targetOrg.hr_admin_name || 'HR Admin',
        orgKey: targetOrg.org_key,
        isPrimaryHR: true,
      },
      fallbackTempPassword: String((targetOrg.setup_payload?.orgData as Record<string, unknown> | undefined)?.temporaryPassword || ''),
    }
  }

  for (const member of getHrTeam(targetOrg)) {
    if (member.isInPMS) continue
    const email = normalizeLower(member.email)
    if (!email) continue
    if (normalizedCredentialKey === email || normalizedIdentifier === email) {
      return {
        credentialKey: email,
        credential: credentials[email] || null,
        org: targetOrg,
        kind: 'hr-admin',
        patch: {
          email,
          name: String(member.name || ''),
          designation: member.type === 'co-admin' ? 'Co-Admin HR' : 'Scoped HR',
          orgKey: targetOrg.org_key,
          isHRTeam: true,
          hrTeamType: member.type,
        },
        fallbackTempPassword: String(member.password || ''),
      }
    }
  }

  const directKeys = [codeCredentialKey, normalizedCredentialKey, codeIdentifier, normalizedIdentifier].filter(Boolean)
  for (const key of directKeys) {
    const credential = credentials[key]
    if (credential && String(credential.orgKey || '') === targetOrg.org_key) {
      return {
        credentialKey: key,
        credential,
        org: targetOrg,
        kind: 'employee',
        patch: {
          orgKey: targetOrg.org_key,
          empCode: normalizeCode(credential.empCode || key),
          email: normalizeLower(credential.email),
          name: String(credential.name || ''),
        },
        fallbackTempPassword: '',
      }
    }
  }

  const found = Object.entries(credentials).find(([key, value]) => {
    if (String(value?.orgKey || '') !== targetOrg.org_key) return false
    return normalizeLower(value?.email) === normalizedIdentifier
      || normalizeCode(value?.empCode || key) === codeIdentifier
      || normalizeCode(value?.empCode || key) === codeCredentialKey
  })
  if (found) {
    const [key, credential] = found
    return {
      credentialKey: key,
      credential,
      org: targetOrg,
      kind: 'employee',
      patch: {
        orgKey: targetOrg.org_key,
        empCode: normalizeCode(credential.empCode || key),
        email: normalizeLower(credential.email),
        name: String(credential.name || ''),
      },
      fallbackTempPassword: '',
    }
  }

  return null
}

async function storeResetCode(
  client: ReturnType<typeof createClient>,
  identifierKey: string,
  payload: Record<string, unknown>,
) {
  const { error } = await client
    .from('app_state')
    .upsert(
      { state_key: `${RESET_PREFIX}${identifierKey}`, org_key: '', payload },
      { onConflict: 'state_key,org_key' },
    )
  if (error) throw error
}

async function readResetCode(
  client: ReturnType<typeof createClient>,
  identifierKey: string,
) {
  const { data, error } = await client
    .from('app_state')
    .select('payload')
    .eq('state_key', `${RESET_PREFIX}${identifierKey}`)
    .eq('org_key', '')
    .maybeSingle()
  if (error) throw error
  return data?.payload && typeof data.payload === 'object'
    ? data.payload as Record<string, unknown>
    : null
}

async function deleteResetCode(
  client: ReturnType<typeof createClient>,
  identifierKey: string,
) {
  await client
    .from('app_state')
    .delete()
    .eq('state_key', `${RESET_PREFIX}${identifierKey}`)
    .eq('org_key', '')
}

async function revokeUserSessions(
  client: ReturnType<typeof createClient>,
  { orgKey, email, empCode }: { orgKey: string; email?: string; empCode?: string },
) {
  const { data, error } = await client
    .from('app_state')
    .select('state_key, payload')
    .ilike('state_key', 'server_session:%')
    .eq('org_key', '')
  if (error) throw error
  const normalizedEmail = normalizeLower(email)
  const normalizedEmpCode = normalizeCode(empCode)
  const stateKeys = (Array.isArray(data) ? data : [])
    .filter((row) => {
      const payload = row?.payload && typeof row.payload === 'object' ? row.payload as Record<string, unknown> : null
      if (!payload) return false
      if (String(payload.orgKey || '') !== orgKey) return false
      if (normalizedEmpCode && normalizeCode(payload.empCode) === normalizedEmpCode) return true
      if (normalizedEmail && normalizeLower(payload.email) === normalizedEmail) return true
      return false
    })
    .map((row) => String(row.state_key || ''))
    .filter(Boolean)
  if (stateKeys.length === 0) return 0
  const { error: deleteError } = await client
    .from('app_state')
    .delete()
    .in('state_key', stateKeys)
    .eq('org_key', '')
  if (deleteError) throw deleteError
  return stateKeys.length
}

async function logAudit(
  client: ReturnType<typeof createClient>,
  orgKey: string,
  actionType: string,
  details: Record<string, unknown> = {},
) {
  await client.from('app_audit_logs').insert({
    org_key: orgKey,
    actor_role: 'anonymous',
    actor_name: 'login-reset-flow',
    action_type: actionType,
    target_type: 'password-reset',
    details,
  })
}

function buildResetEmailHtml(displayName: string, code: string) {
  const formatted = formatCodeWithHyphen(code)
  return `<!doctype html>
<html><body style="margin:0;padding:0;background:#f8fafc;font-family:-apple-system,'Segoe UI',Roboto,Arial,sans-serif;color:#0f172a;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f8fafc;padding:32px 0;">
    <tr><td align="center">
      <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="background:#ffffff;border:1px solid #e5e7eb;border-radius:14px;">
        <tr><td style="padding:28px 32px;">
          <div style="font-size:12px;font-weight:700;letter-spacing:.06em;color:#4f46e5;text-transform:uppercase;margin-bottom:8px;">Zaro HR</div>
          <h1 style="margin:0 0 8px;font-size:22px;font-weight:700;color:#0f172a;">Your password reset code</h1>
          <p style="margin:0 0 22px;font-size:14px;line-height:1.6;color:#475569;">Hi ${displayName || 'there'}, use the code below to reset your password. This code expires in 15 minutes.</p>
          <div style="margin:0 0 22px;padding:18px 22px;background:#eef2ff;border:1px solid #c7d2fe;border-radius:12px;text-align:center;">
            <div style="font-family:'SFMono-Regular',Consolas,Menlo,monospace;font-size:34px;font-weight:700;letter-spacing:0.18em;color:#312e81;">${formatted}</div>
          </div>
          <p style="margin:0 0 6px;font-size:13px;color:#64748b;">If you didn't request a reset, you can safely ignore this email.</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`
}

function buildResetEmailText(displayName: string, code: string) {
  return [
    `Hi ${displayName || 'there'},`,
    '',
    `Your Zaro HR password reset code is: ${formatCodeWithHyphen(code)}`,
    'This code expires in 15 minutes.',
    '',
    "If you didn't request a reset, ignore this email.",
  ].join('\n')
}

async function sendResetCodeEmail(recipientEmail: string, displayName: string, code: string) {
  const smtpHost = Deno.env.get('SMTP_HOST') || ''
  const smtpPort = Number(Deno.env.get('SMTP_PORT') || '465')
  const smtpUser = Deno.env.get('SMTP_USER') || ''
  const smtpPass = Deno.env.get('SMTP_PASS') || ''
  const smtpFrom = Deno.env.get('SMTP_FROM') || smtpUser
  const fromName = Deno.env.get('FROM_NAME') || 'Zaro HR'
  if (!smtpHost || !smtpPort || !smtpUser || !smtpPass || !smtpFrom) {
    throw new Error('Reset email cannot be sent: platform SMTP is not configured.')
  }
  const transporter = nodemailer.createTransport({
    host: smtpHost,
    port: smtpPort,
    secure: smtpPort === 465,
    requireTLS: smtpPort !== 465,
    auth: { user: smtpUser, pass: smtpPass },
  })
  await transporter.sendMail({
    from: `${fromName} <${smtpFrom}>`,
    to: recipientEmail,
    subject: 'Your Zaro HR password reset code',
    html: buildResetEmailHtml(displayName, code),
    text: buildResetEmailText(displayName, code),
    replyTo: smtpFrom,
  })
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return json(405, { ok: false, error: 'Method not allowed.' })

  const supabaseUrl = Deno.env.get('SUPABASE_URL') || ''
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || ''
  if (!supabaseUrl || !serviceRoleKey) {
    return json(500, { ok: false, error: 'Supabase service role configuration is missing.' })
  }

  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return json(400, { ok: false, error: 'Invalid JSON request body.' })
  }

  const action = String(body.action || '').trim()
  const adminClient = createClient(supabaseUrl, serviceRoleKey)

  if (action === 'login') {
    const identifier = String(body.identifier || '').trim()
    const password = String(body.password || '')
    const organizationKey = String(body.organizationKey || '').trim()
    const workspace = String(body.workspace || '').trim()
    const rememberMe = !!body.rememberMe
    if (!identifier || !password) return json(400, { ok: false, error: 'identifier and password are required.' })
    const user = await resolveServerLogin(adminClient, identifier, password, organizationKey, workspace)
    if (!user) return json(200, { ok: false, error: 'Invalid credentials.' })
    const scopeError = (user as Record<string, unknown>).__scopeError
    if (scopeError === 'workspace-not-found') {
      return json(200, { ok: false, code: 'workspace-not-found', error: 'Workspace not found. Check the company slug or code from your HR invite.' })
    }
    if (scopeError === 'org-user-needs-workspace-url') {
      // The `code` field lets the client recognize this case without
      // regex-matching the human-readable message, so tweaking the copy
      // later won't silently break the workspace-step escalation.
      return json(200, { ok: false, code: 'org-user-needs-workspace-url', error: 'Please sign in from your workspace URL. Ask your HR admin if you need it.' })
    }
    const session = await issueSession(adminClient, user, rememberMe)
    return json(200, { ok: true, user, serverSessionToken: session.token, expiresAt: session.expiresAt })
  }

  if (action === 'logout') {
    const token = String(body.serverSessionToken || '').trim()
    if (!token) return json(200, { ok: true, skipped: true })
    await revokeSession(adminClient, token)
    return json(200, { ok: true })
  }

  if (action === 'change-password') {
    const identifier = String(body.identifier || '').trim()
    const organizationKey = String(body.organizationKey || '').trim()
    const credentialKey = String(body.credentialKey || '').trim()
    const currentPassword = String(body.currentPassword || '')
    const newPassword = String(body.newPassword || '')
    if (!organizationKey) {
      return json(400, { ok: false, error: 'Company is required.' })
    }
    if (!identifier && !credentialKey) {
      return json(400, { ok: false, error: 'User identifier is required.' })
    }
    if (!currentPassword) {
      return json(400, { ok: false, error: 'Current password is required.' })
    }
    if (newPassword.length < 6) {
      return json(400, { ok: false, error: 'New password must be at least 6 characters.' })
    }
    if (newPassword === currentPassword) {
      return json(200, { ok: false, error: 'New password must differ from the temporary password.' })
    }

    const target = await locateCredentialForPasswordChange(adminClient, {
      identifier,
      organizationKey,
      credentialKey,
    })
    if (!target) {
      return json(200, { ok: false, error: 'Could not identify user to update.' })
    }

    const storedSecret = String(target.credential?.passwordHash || target.credential?.password || '')
    let passwordOk = false
    if (storedSecret) {
      passwordOk = await verifyPasswordValue(currentPassword, storedSecret)
    } else if (target.fallbackTempPassword) {
      passwordOk = currentPassword === target.fallbackTempPassword
    }
    if (!passwordOk) {
      return json(200, { ok: false, error: 'Current password is incorrect.' })
    }

    const newHash = await hashPasswordValue(newPassword)
    const revokedSessions = await revokeUserSessions(adminClient, {
      orgKey: organizationKey,
      email: String(target.credential?.email || target.patch?.email || ''),
      empCode: String(target.credential?.empCode || target.patch?.empCode || ''),
    })
    const updated = await updateCredentialPassword(adminClient, target.credentialKey, newHash, target.patch)
    if (target.kind === 'hr-admin' && target.org) {
      // Nuke the OTP from the org row so it can't be re-used as a login.
      await clearOrgTempPasswordForCredential(adminClient, target.org, target.credentialKey)
    }
    const nextUser = await resolveServerLogin(adminClient, identifier || credentialKey || target.credentialKey, newPassword, organizationKey)
    const nextSession = nextUser ? await issueSession(adminClient, nextUser) : null
    await logAudit(adminClient, organizationKey, 'password-change-completed', {
      credentialKey: target.credentialKey,
      kind: target.kind,
      revokedSessions,
    })
    return json(200, {
      ok: true,
      credentialKey: target.credentialKey,
      credential: updated,
      user: nextUser || undefined,
      serverSessionToken: nextSession?.token || undefined,
      expiresAt: nextSession?.expiresAt || undefined,
    })
  }

  if (action === 'inspect') {
    const token = String(body.serverSessionToken || '').trim()
    if (!token) return json(401, { ok: false, error: 'serverSessionToken is required.' })
    const session = await inspectSession(adminClient, token)
    if (!session.ok) return json(403, { ok: false, error: session.error })
    return json(200, { ok: true, session: session.payload })
  }

  if (action === 'revoke-employee-sessions') {
    const token = String(body.serverSessionToken || '').trim()
    const organizationKey = String(body.organizationKey || '').trim()
    const employees = Array.isArray(body.employees) ? body.employees as Array<Record<string, unknown>> : []
    if (!token) return json(401, { ok: false, error: 'serverSessionToken is required.' })
    if (!organizationKey) return json(400, { ok: false, error: 'organizationKey is required.' })
    const session = await inspectSession(adminClient, token)
    if (!session.ok) return json(403, { ok: false, error: session.error })
    const actor = session.payload as Record<string, unknown>
    const actorRole = String(actor.role || '')
    if (actorRole !== 'super-admin' && actorRole !== 'hr-admin') {
      return json(403, { ok: false, error: 'This session is not allowed to reset employee sessions.' })
    }
    if (actorRole !== 'super-admin' && String(actor.orgKey || '') !== organizationKey) {
      return json(403, { ok: false, error: 'This session is not allowed to reset another organization.' })
    }

    let revoked = 0
    for (const employee of employees) {
      const empCode = normalizeCode(employee?.empCode)
      const email = normalizeLower(employee?.email)
      if (!empCode && !email) continue
      revoked += await revokeUserSessions(adminClient, { orgKey: organizationKey, empCode, email })
    }
    await logAudit(adminClient, organizationKey, 'employee-sessions-revoked', {
      count: employees.length,
      revoked,
    })
    return json(200, { ok: true, revoked })
  }

  if (action === 'suggest-orgs') {
    const query = String(body.query || '').trim()
    if (query.length < 2) return json(200, { ok: true, results: [] })
    try {
      const results = await suggestOrgsByQuery(adminClient, query)
      return json(200, { ok: true, results })
    } catch (error) {
      return json(200, { ok: false, error: error instanceof Error ? error.message : 'Lookup failed.' })
    }
  }

  if (action === 'request-password-reset') {
    const identifier = String(body.identifier || '').trim()
    const organizationKey = String(body.organizationKey || '').trim()
    if (!identifier) return json(400, { ok: false, error: 'Identifier is required.' })
    if (!organizationKey) return json(400, { ok: false, error: 'Company is required.' })
    const lookup = await locateCredentialByIdentifier(adminClient, identifier, organizationKey)
    if (!lookup) {
      return json(200, { ok: true, message: 'If an account exists, a code has been sent.' })
    }
    if (lookup.missingEmail || !lookup.recipientEmail) {
      await logAudit(adminClient, organizationKey, 'password-reset-missing-email', {
        identifier: normalizeIdentifierForKey(identifier),
        kind: lookup.kind,
        employeeCode: lookup.employeeCode || null,
      })
      return json(200, {
        ok: false,
        error: 'No email is configured for this account. Please contact your HR Admin to reset your password.',
      })
    }
    const code = generateSixDigitCode()
    const identifierKey = `${organizationKey}::${normalizeIdentifierForKey(identifier)}`
    const existing = await readResetCode(adminClient, identifierKey)
    const requestedAt = String(existing?.requestedAt || '')
    if (requestedAt) {
      const elapsed = Date.now() - Date.parse(requestedAt)
      if (Number.isFinite(elapsed) && elapsed >= 0 && elapsed < RESET_REQUEST_COOLDOWN_MS) {
        return json(200, {
          ok: false,
          error: 'A reset code was sent recently. Please wait a minute before trying again.',
        })
      }
    }
    const expiresAt = new Date(Date.now() + RESET_CODE_TTL_MS).toISOString()
    await storeResetCode(adminClient, identifierKey, {
      code,
      credentialKey: lookup.credentialKey,
      identifier: normalizeIdentifierForKey(identifier),
      organizationKey,
      recipientEmail: lookup.recipientEmail,
      kind: lookup.kind,
      employeeCode: lookup.employeeCode || null,
      expiresAt,
      requestedAt: new Date().toISOString(),
      attempts: 0,
    })
    await logAudit(adminClient, organizationKey, 'password-reset-requested', {
      identifier: normalizeIdentifierForKey(identifier),
      kind: lookup.kind,
      employeeCode: lookup.employeeCode || null,
    })
    try {
      await sendResetCodeEmail(lookup.recipientEmail, lookup.displayName, code)
    } catch (error) {
      // Email failed — surface a real error so the user knows to retry / contact admin.
      return json(200, {
        ok: false,
        error: error instanceof Error ? error.message : 'Could not send reset email.',
      })
    }
    await logAudit(adminClient, organizationKey, 'password-reset-code-sent', {
      identifier: normalizeIdentifierForKey(identifier),
      recipientEmail: lookup.recipientEmail,
      kind: lookup.kind,
    })
    return json(200, {
      ok: true,
      message: 'If an account exists, a code has been sent.',
      maskedEmail: lookup.recipientEmail.replace(/^(.{2}).*(@.*)$/, '$1•••$2'),
    })
  }

  if (action === 'confirm-password-reset') {
    const identifier = String(body.identifier || '').trim()
    const organizationKey = String(body.organizationKey || '').trim()
    const code = String(body.code || '').replace(/[^0-9]/g, '')
    const newPassword = String(body.newPassword || '')
    if (!identifier || !code) {
      return json(400, { ok: false, error: 'Identifier and code are required.' })
    }
    if (!organizationKey) {
      return json(400, { ok: false, error: 'Company is required.' })
    }
    if (code.length !== 6) {
      return json(400, { ok: false, error: 'Reset code must be 6 digits.' })
    }
    if (newPassword.length < 6) {
      return json(400, { ok: false, error: 'New password must be at least 6 characters.' })
    }
    const identifierKey = `${organizationKey}::${normalizeIdentifierForKey(identifier)}`
    const stored = await readResetCode(adminClient, identifierKey)
    if (!stored) {
      return json(200, { ok: false, error: 'Invalid or expired code. Request a new one.' })
    }
    const expiresAt = String(stored.expiresAt || '')
    if (!expiresAt || Date.now() > Date.parse(expiresAt)) {
      await deleteResetCode(adminClient, identifierKey)
      return json(200, { ok: false, error: 'Code has expired. Request a new one.' })
    }
    const attempts = Number(stored.attempts || 0)
    if (attempts >= 5) {
      await deleteResetCode(adminClient, identifierKey)
      return json(200, { ok: false, error: 'Too many failed attempts. Request a new code.' })
    }
    if (!constantTimeEqual(String(stored.code || ''), code)) {
      await storeResetCode(adminClient, identifierKey, { ...stored, attempts: attempts + 1 })
      return json(200, { ok: false, error: 'Code is incorrect.' })
    }
    const credentialKey = String(stored.credentialKey || '')
    if (!credentialKey) {
      return json(500, { ok: false, error: 'Reset record is corrupted. Request a new code.' })
    }
    const newHash = await hashPasswordValue(newPassword)
    const updated = await updateCredentialPassword(adminClient, credentialKey, newHash)
    const revokedSessions = await revokeUserSessions(adminClient, {
      orgKey: organizationKey,
      email: String(updated?.email || stored.recipientEmail || ''),
      empCode: String(updated?.empCode || stored.employeeCode || ''),
    })
    await deleteResetCode(adminClient, identifierKey)
    await logAudit(adminClient, organizationKey, 'password-reset-completed', {
      identifier: normalizeIdentifierForKey(identifier),
      credentialKey,
      revokedSessions,
    })
    return json(200, { ok: true, message: 'Password updated. Sign in with the new password.' })
  }

  return json(400, { ok: false, error: 'Unsupported action.' })
})
