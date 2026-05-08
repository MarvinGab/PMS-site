import { createClient } from 'npm:@supabase/supabase-js@2.57.4'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json',
}

const SESSION_TTL_MS = 1000 * 60 * 60 * 12
const SUPER_ADMIN_EMAIL = 'admin@zarohr.com'
const SUPER_ADMIN_PASSWORD = 'admin123'

type OrgRow = {
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

function textEncoder() {
  return new TextEncoder()
}

function fromBase64(value: string) {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
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

async function getOrganizations(client: ReturnType<typeof createClient>) {
  const { data, error } = await client
    .from('organizations')
    .select('org_key, name, hr_admin_name, hr_admin_email, setup_payload')
  if (error) throw error
  return (data || []) as OrgRow[]
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

function getHrTeam(org: OrgRow) {
  const setupPayload = org.setup_payload && typeof org.setup_payload === 'object' ? org.setup_payload : null
  const orgData = setupPayload?.orgData
  if (!orgData || typeof orgData !== 'object') return []
  return Array.isArray((orgData as Record<string, unknown>).hrTeam)
    ? (orgData as Record<string, unknown>).hrTeam as Array<Record<string, unknown>>
    : []
}

async function resolveServerLogin(client: ReturnType<typeof createClient>, identifier: string, password: string) {
  const normalized = normalizeLower(identifier)

  if (normalized === SUPER_ADMIN_EMAIL && password === SUPER_ADMIN_PASSWORD) {
    return { role: 'super-admin', userName: 'Super Admin' }
  }

  const [orgs, credentials] = await Promise.all([
    getOrganizations(client),
    getCredentialBlob(client),
  ])

  for (const org of orgs) {
    if (normalizeLower(org.hr_admin_email) === normalized) {
      const primaryCredential = credentials?.[normalized]
      const primaryStoredSecret = String(primaryCredential?.passwordHash || primaryCredential?.password || '')
      if (primaryStoredSecret && await verifyPasswordValue(password, primaryStoredSecret)) {
        return { role: 'hr-admin', orgKey: org.org_key, userName: org.hr_admin_name || 'HR Admin' }
      }
      const setupPayload = org.setup_payload && typeof org.setup_payload === 'object' ? org.setup_payload : null
      const tempPassword = String((setupPayload?.orgData as Record<string, unknown> | undefined)?.temporaryPassword || '')
      if (tempPassword && tempPassword === password) {
        return { role: 'hr-admin', orgKey: org.org_key, userName: org.hr_admin_name || 'HR Admin' }
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
  const storedSecret = String(credential?.passwordHash || credential?.password || '')
  if (!storedSecret || !(await verifyPasswordValue(password, storedSecret))) {
    return null
  }

  const empCode = normalizeCode(credential.empCode || matchKey)
  for (const org of orgs) {
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
    orgKey: String(credential.orgKey || ''),
    isTemp: !!credential.isTemp,
    email: String(credential.email || ''),
  }
}

async function issueSession(client: ReturnType<typeof createClient>, user: Record<string, unknown>) {
  const token = crypto.randomUUID()
  const now = new Date()
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS).toISOString()
  await client.from('app_state').upsert({
    state_key: `server_session:${token}`,
    org_key: '',
    payload: {
      ...user,
      expiresAt,
      issuedAt: now.toISOString(),
    },
  }, { onConflict: 'state_key,org_key' })
  return { token, expiresAt }
}

async function revokeSession(client: ReturnType<typeof createClient>, token: string) {
  await client
    .from('app_state')
    .delete()
    .eq('state_key', `server_session:${token}`)
    .eq('org_key', '')
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
    if (!identifier || !password) return json(400, { ok: false, error: 'identifier and password are required.' })
    const user = await resolveServerLogin(adminClient, identifier, password)
    if (!user) return json(200, { ok: false, error: 'Invalid credentials.' })
    const session = await issueSession(adminClient, user)
    return json(200, { ok: true, user, serverSessionToken: session.token, expiresAt: session.expiresAt })
  }

  if (action === 'logout') {
    const token = String(body.serverSessionToken || '').trim()
    if (!token) return json(200, { ok: true, skipped: true })
    await revokeSession(adminClient, token)
    return json(200, { ok: true })
  }

  return json(400, { ok: false, error: 'Unsupported action.' })
})
