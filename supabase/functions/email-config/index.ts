import nodemailer from 'npm:nodemailer@6.10.1'
import { createClient } from 'npm:@supabase/supabase-js@2.57.4'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json',
}

type Provider = 'smtp' | 'microsoft' | 'google'

type OrgRow = { id: string; org_key: string; name: string | null }

type SmtpSettingsRow = {
  organization_id: string
  provider: Provider | null
  is_enabled: boolean
  use_tls: boolean
  smtp_host: string | null
  smtp_port: number | null
  smtp_username: string | null
  smtp_password: string | null
  from_name: string | null
  from_email: string | null
  footer_text: string | null
  ms_tenant_id: string | null
  ms_client_id: string | null
  ms_client_secret: string | null
  google_client_id: string | null
  google_client_secret: string | null
  google_refresh_token: string | null
}

const SMTP_SECRET_PREFIX = 'enc:v1:'

function json(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), { status, headers: corsHeaders })
}

function normalizeEmail(value: unknown) {
  return String(value || '').trim().toLowerCase()
}

function normalizeProvider(value: unknown): Provider {
  const v = String(value || '').trim()
  return v === 'microsoft' || v === 'google' ? v : 'smtp'
}

function textEncoder() { return new TextEncoder() }
function textDecoder() { return new TextDecoder() }

function toBase64(bytes: Uint8Array) {
  let binary = ''
  bytes.forEach((byte) => { binary += String.fromCharCode(byte) })
  return btoa(binary)
}

function fromBase64(value: string) {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}

async function importAesKey(secret: string) {
  const digest = await crypto.subtle.digest('SHA-256', textEncoder().encode(secret))
  return crypto.subtle.importKey('raw', digest, 'AES-GCM', false, ['encrypt', 'decrypt'])
}

async function encryptSecret(value: string, secret: string) {
  if (!value) return ''
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const key = await importAesKey(secret)
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, textEncoder().encode(value))
  return `${SMTP_SECRET_PREFIX}${toBase64(iv)}:${toBase64(new Uint8Array(encrypted))}`
}

async function decryptSecret(value: string | null, secret: string) {
  const raw = String(value || '')
  if (!raw) return ''
  if (!raw.startsWith(SMTP_SECRET_PREFIX)) return raw
  const payload = raw.slice(SMTP_SECRET_PREFIX.length)
  const [ivText, dataText] = payload.split(':')
  if (!ivText || !dataText) throw new Error('Stored secret is malformed.')
  const key = await importAesKey(secret)
  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: fromBase64(ivText) },
    key,
    fromBase64(dataText),
  )
  return textDecoder().decode(decrypted)
}

// Reuse already-stored ciphertext if the new payload doesn't include a fresh
// secret. Returns null when neither source has a value (clear).
async function nextSecret(
  incoming: string,
  current: string | null,
  cryptoSecret: string,
) {
  const fresh = String(incoming || '').trim()
  if (fresh) return await encryptSecret(fresh, cryptoSecret)
  if (current) {
    // Re-encrypt existing decrypted value to keep ciphertext shape consistent.
    const decoded = await decryptSecret(current, cryptoSecret)
    if (!decoded) return null
    return await encryptSecret(decoded, cryptoSecret)
  }
  return null
}

function maskSettings(row: SmtpSettingsRow | null) {
  if (!row) {
    return {
      provider: 'smtp' as Provider,
      isEnabled: false,
      useTls: true,
      smtpHost: '',
      smtpPort: 465,
      smtpUsername: '',
      smtpPassword: '',
      hasPassword: false,
      fromName: '',
      fromEmail: '',
      footerText: '',
      msTenantId: '',
      msClientId: '',
      msClientSecret: '',
      hasMsClientSecret: false,
      googleClientId: '',
      googleClientSecret: '',
      hasGoogleClientSecret: false,
      googleRefreshToken: '',
      hasGoogleRefreshToken: false,
    }
  }
  return {
    provider: normalizeProvider(row.provider),
    isEnabled: !!row.is_enabled,
    useTls: row.use_tls !== false,
    smtpHost: row.smtp_host || '',
    smtpPort: row.smtp_port || 465,
    smtpUsername: row.smtp_username || '',
    smtpPassword: '',
    hasPassword: !!row.smtp_password,
    fromName: row.from_name || '',
    fromEmail: row.from_email || '',
    footerText: row.footer_text || '',
    msTenantId: row.ms_tenant_id || '',
    msClientId: row.ms_client_id || '',
    msClientSecret: '',
    hasMsClientSecret: !!row.ms_client_secret,
    googleClientId: row.google_client_id || '',
    googleClientSecret: '',
    hasGoogleClientSecret: !!row.google_client_secret,
    googleRefreshToken: '',
    hasGoogleRefreshToken: !!row.google_refresh_token,
  }
}

type RawInput = Record<string, unknown>

async function buildSettingsPayload(
  organizationId: string,
  input: RawInput,
  current: SmtpSettingsRow | null,
  cryptoSecret: string,
) {
  const provider = normalizeProvider(input.provider)
  return {
    organization_id: organizationId,
    provider,
    is_enabled: !!input.isEnabled,
    use_tls: input.useTls !== false,
    smtp_host: String(input.smtpHost || '').trim() || null,
    smtp_port: Number(input.smtpPort) || 465,
    smtp_username: String(input.smtpUsername || '').trim() || null,
    smtp_password: await nextSecret(String(input.smtpPassword || ''), current?.smtp_password || null, cryptoSecret),
    from_name: String(input.fromName || '').trim() || null,
    from_email: normalizeEmail(input.fromEmail) || null,
    footer_text: String(input.footerText || '').trim() || null,
    ms_tenant_id: String(input.msTenantId || '').trim() || null,
    ms_client_id: String(input.msClientId || '').trim() || null,
    ms_client_secret: await nextSecret(String(input.msClientSecret || ''), current?.ms_client_secret || null, cryptoSecret),
    google_client_id: String(input.googleClientId || '').trim() || null,
    google_client_secret: await nextSecret(String(input.googleClientSecret || ''), current?.google_client_secret || null, cryptoSecret),
    google_refresh_token: await nextSecret(String(input.googleRefreshToken || ''), current?.google_refresh_token || null, cryptoSecret),
    updated_at: new Date().toISOString(),
  }
}

type Payload = Awaited<ReturnType<typeof buildSettingsPayload>>

// ─── SMTP transport ──────────────────────────────────────────────────────
async function createSmtpTransport(payload: Payload, cryptoSecret: string) {
  const port = Number(payload.smtp_port || 465)
  const useStartTls = payload.use_tls !== false
  return nodemailer.createTransport({
    host: payload.smtp_host || '',
    port,
    secure: port === 465,
    requireTLS: useStartTls,
    auth: {
      user: payload.smtp_username || '',
      pass: await decryptSecret(payload.smtp_password || '', cryptoSecret),
    },
  })
}

// ─── Microsoft Graph ────────────────────────────────────────────────────
async function getMicrosoftAccessToken(payload: Payload, cryptoSecret: string) {
  const tenantId = payload.ms_tenant_id || ''
  const clientId = payload.ms_client_id || ''
  const clientSecret = await decryptSecret(payload.ms_client_secret || '', cryptoSecret)
  if (!tenantId || !clientId || !clientSecret) {
    throw new Error('Microsoft tenant ID, client ID, and client secret are required.')
  }
  const tokenRes = await fetch(
    `https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        scope: 'https://graph.microsoft.com/.default',
        grant_type: 'client_credentials',
      }),
    },
  )
  const tokenText = await tokenRes.text()
  let tokenJson: Record<string, unknown> = {}
  try { tokenJson = tokenText ? JSON.parse(tokenText) : {} } catch { /* ignore */ }
  if (!tokenRes.ok || !tokenJson.access_token) {
    const description = String(tokenJson.error_description || tokenJson.error || tokenText || `HTTP ${tokenRes.status}`)
    throw new Error(`Microsoft token request failed: ${description}`)
  }
  return String(tokenJson.access_token)
}

async function verifyMicrosoft(payload: Payload, cryptoSecret: string) {
  const senderEmail = payload.from_email || ''
  if (!senderEmail) throw new Error('Sender email (from email) is required for Microsoft.')
  const token = await getMicrosoftAccessToken(payload, cryptoSecret)
  const probe = await fetch(
    `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(senderEmail)}?$select=id,mail,userPrincipalName`,
    { headers: { Authorization: `Bearer ${token}` } },
  )
  if (!probe.ok) {
    const detail = await probe.text()
    if (probe.status === 404) {
      throw new Error(`Mailbox "${senderEmail}" was not found in this Microsoft tenant.`)
    }
    if (probe.status === 401 || probe.status === 403) {
      throw new Error(`Microsoft denied access (${probe.status}). Ensure the app has Mail.Send application permission with admin consent. Detail: ${detail}`)
    }
    throw new Error(`Microsoft Graph probe failed (HTTP ${probe.status}): ${detail}`)
  }
}

async function sendMicrosoftTestEmail(
  payload: Payload,
  cryptoSecret: string,
  recipientEmail: string,
  orgName: string,
) {
  const senderEmail = payload.from_email || ''
  if (!senderEmail) throw new Error('Sender email (from email) is required for Microsoft.')
  const token = await getMicrosoftAccessToken(payload, cryptoSecret)
  const subject = `Microsoft 365 test email for ${orgName}`
  const html = buildTestHtml(orgName, payload.footer_text || '', 'Microsoft 365')
  const send = await fetch(
    `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(senderEmail)}/sendMail`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        message: {
          subject,
          body: { contentType: 'HTML', content: html },
          toRecipients: [{ emailAddress: { address: recipientEmail } }],
        },
        saveToSentItems: true,
      }),
    },
  )
  if (!send.ok) {
    const detail = await send.text()
    throw new Error(`Microsoft Graph sendMail failed (HTTP ${send.status}): ${detail}`)
  }
}

// ─── Google Gmail API ────────────────────────────────────────────────────
async function getGoogleAccessToken(payload: Payload, cryptoSecret: string) {
  const clientId = payload.google_client_id || ''
  const clientSecret = await decryptSecret(payload.google_client_secret || '', cryptoSecret)
  const refreshToken = await decryptSecret(payload.google_refresh_token || '', cryptoSecret)
  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error('Google client ID, client secret, and refresh token are required.')
  }
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  })
  const tokenText = await tokenRes.text()
  let tokenJson: Record<string, unknown> = {}
  try { tokenJson = tokenText ? JSON.parse(tokenText) : {} } catch { /* ignore */ }
  if (!tokenRes.ok || !tokenJson.access_token) {
    const description = String(tokenJson.error_description || tokenJson.error || tokenText || `HTTP ${tokenRes.status}`)
    throw new Error(`Google token refresh failed: ${description}`)
  }
  return String(tokenJson.access_token)
}

async function verifyGoogle(payload: Payload, cryptoSecret: string) {
  const senderEmail = payload.from_email || ''
  if (!senderEmail) throw new Error('Sender email (from email) is required for Google.')
  const token = await getGoogleAccessToken(payload, cryptoSecret)
  const probe = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/${encodeURIComponent(senderEmail)}/profile`,
    { headers: { Authorization: `Bearer ${token}` } },
  )
  if (!probe.ok) {
    const detail = await probe.text()
    if (probe.status === 401 || probe.status === 403) {
      throw new Error(`Google denied access (${probe.status}). Ensure the OAuth client has gmail.send scope and the refresh token is for ${senderEmail}. Detail: ${detail}`)
    }
    if (probe.status === 404) {
      throw new Error(`Gmail mailbox "${senderEmail}" was not found.`)
    }
    throw new Error(`Gmail probe failed (HTTP ${probe.status}): ${detail}`)
  }
}

function buildRawGmailMessage(senderEmail: string, to: string, subject: string, html: string) {
  const lines = [
    `From: ${senderEmail}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    'MIME-Version: 1.0',
    'Content-Type: text/html; charset=UTF-8',
    '',
    html,
  ].join('\r\n')
  const bytes = textEncoder().encode(lines)
  return toBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

async function sendGoogleTestEmail(
  payload: Payload,
  cryptoSecret: string,
  recipientEmail: string,
  orgName: string,
) {
  const senderEmail = payload.from_email || ''
  if (!senderEmail) throw new Error('Sender email (from email) is required for Google.')
  const token = await getGoogleAccessToken(payload, cryptoSecret)
  const subject = `Google Workspace test email for ${orgName}`
  const html = buildTestHtml(orgName, payload.footer_text || '', 'Google Workspace')
  const raw = buildRawGmailMessage(senderEmail, recipientEmail, subject, html)
  const send = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/${encodeURIComponent(senderEmail)}/messages/send`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ raw }),
    },
  )
  if (!send.ok) {
    const detail = await send.text()
    throw new Error(`Gmail send failed (HTTP ${send.status}): ${detail}`)
  }
  const result = await send.json().catch(() => ({}))
  return { messageId: typeof result?.id === 'string' ? result.id : null }
}

function buildTestHtml(orgName: string, footerText: string, providerLabel: string) {
  const safeOrg = String(orgName || 'your organization').replace(/[<>]/g, '')
  const safeFooter = String(footerText || `Sent from your ${providerLabel} email settings.`).replace(/[<>]/g, '')
  return `<div style="font-family:Arial,Helvetica,sans-serif;padding:24px;background:#f8fafc;color:#0f172a;"><div style="max-width:640px;margin:0 auto;background:#fff;border:1px solid #e2e8f0;border-radius:14px;padding:24px;"><div style="font-size:20px;font-weight:800;margin-bottom:12px;">${providerLabel} test successful</div><div style="font-size:14px;line-height:1.7;color:#475569;">This is a test email for <strong>${safeOrg}</strong>. Your ${providerLabel} email settings are working.</div><div style="margin-top:18px;font-size:12px;color:#94a3b8;">${safeFooter}</div></div></div>`
}

// ─── Validation per provider ─────────────────────────────────────────────
function validateProviderForSend(payload: Payload): string | null {
  if (!payload.from_email) return 'From email is required.'
  if (payload.provider === 'smtp') {
    if (!payload.smtp_host) return 'SMTP host is required.'
    if (!payload.smtp_username) return 'SMTP username is required.'
    if (!payload.smtp_password) return 'SMTP password is required.'
    return null
  }
  if (payload.provider === 'microsoft') {
    if (!payload.ms_tenant_id) return 'Microsoft tenant ID is required.'
    if (!payload.ms_client_id) return 'Microsoft client ID is required.'
    if (!payload.ms_client_secret) return 'Microsoft client secret is required.'
    return null
  }
  if (payload.provider === 'google') {
    if (!payload.google_client_id) return 'Google client ID is required.'
    if (!payload.google_client_secret) return 'Google client secret is required.'
    if (!payload.google_refresh_token) return 'Google refresh token is required.'
    return null
  }
  return 'Unknown email provider.'
}

// ─── Supabase data access ────────────────────────────────────────────────
async function getOrganization(client: ReturnType<typeof createClient>, organizationKey: string) {
  const { data, error } = await client
    .from('organizations')
    .select('id, org_key, name')
    .eq('org_key', organizationKey)
    .maybeSingle()
  if (error) throw error
  return data as OrgRow | null
}

async function getServerSession(client: ReturnType<typeof createClient>, token: string) {
  const { data, error } = await client
    .from('app_state')
    .select('payload')
    .eq('state_key', `server_session:${token}`)
    .eq('org_key', '')
    .maybeSingle()
  if (error) throw error
  const payload = data?.payload && typeof data.payload === 'object' ? data.payload as Record<string, unknown> : null
  return payload
}

async function requireAuthorizedSession(
  client: ReturnType<typeof createClient>,
  token: string,
  organizationKey: string,
) {
  const payload = await getServerSession(client, token)
  if (!payload) return { ok: false, error: 'Server session is missing or expired.' }
  const expiresAt = String(payload.expiresAt || '')
  if (expiresAt && Date.now() > Date.parse(expiresAt)) {
    return { ok: false, error: 'Server session has expired.' }
  }
  const role = String(payload.role || '')
  if (role !== 'super-admin' && role !== 'hr-admin') {
    return { ok: false, error: 'This session is not allowed to manage email settings.' }
  }
  if (role !== 'super-admin' && String(payload.orgKey || '') !== organizationKey) {
    return { ok: false, error: 'This session is not allowed to manage another organization.' }
  }
  return { ok: true, payload }
}

const SETTINGS_COLUMNS = [
  'organization_id', 'provider', 'is_enabled', 'use_tls',
  'smtp_host', 'smtp_port', 'smtp_username', 'smtp_password',
  'from_name', 'from_email', 'footer_text',
  'ms_tenant_id', 'ms_client_id', 'ms_client_secret',
  'google_client_id', 'google_client_secret', 'google_refresh_token',
].join(', ')

async function getSettings(client: ReturnType<typeof createClient>, organizationId: string) {
  const { data, error } = await client
    .from('email_smtp_settings')
    .select(SETTINGS_COLUMNS)
    .eq('organization_id', organizationId)
    .maybeSingle()
  if (error) throw error
  return data as SmtpSettingsRow | null
}

async function logAudit(
  client: ReturnType<typeof createClient>,
  orgKey: string,
  actionType: string,
  details: Record<string, unknown> = {},
) {
  await client.from('app_audit_logs').insert({
    org_key: orgKey,
    actor_role: 'system-function',
    actor_name: 'email-config',
    action_type: actionType,
    target_type: 'email-smtp-settings',
    details,
  })
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return json(405, { ok: false, error: 'Method not allowed.' })

  const supabaseUrl = Deno.env.get('SUPABASE_URL') || ''
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || ''
  const cryptoSecret = Deno.env.get('SMTP_CONFIG_SECRET') || ''
  if (!supabaseUrl || !serviceRoleKey) {
    return json(500, { ok: false, error: 'Supabase service role configuration is missing.' })
  }
  if (!cryptoSecret) {
    return json(500, { ok: false, error: 'Email config encryption secret is missing.' })
  }

  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return json(400, { ok: false, error: 'Invalid JSON request body.' })
  }

  const action = String(body.action || '').trim()
  const organizationKey = String(body.organizationKey || '').trim()
  const serverSessionToken = String(body.serverSessionToken || '').trim()
  if (!action || !organizationKey) {
    return json(400, { ok: false, error: 'action and organizationKey are required.' })
  }
  if (!serverSessionToken) {
    return json(401, { ok: false, error: 'serverSessionToken is required.' })
  }

  const adminClient = createClient(supabaseUrl, serviceRoleKey)
  const sessionCheck = await requireAuthorizedSession(adminClient, serverSessionToken, organizationKey)
  if (!sessionCheck.ok) {
    return json(403, { ok: false, error: sessionCheck.error })
  }
  const org = await getOrganization(adminClient, organizationKey)
  if (!org?.id) return json(404, { ok: false, error: 'Organization not found.' })

  const current = await getSettings(adminClient, org.id)

  if (action === 'get') {
    return json(200, { ok: true, settings: maskSettings(current) })
  }

  const rawSettings = (body.settings && typeof body.settings === 'object') ? body.settings as Record<string, unknown> : {}
  const payload = await buildSettingsPayload(org.id, rawSettings, current, cryptoSecret)

  if (action === 'save') {
    const { error } = await adminClient
      .from('email_smtp_settings')
      .upsert(payload, { onConflict: 'organization_id' })
    if (error) return json(500, { ok: false, error: error.message })
    await logAudit(adminClient, organizationKey, 'email-settings-save', {
      provider: payload.provider,
      isEnabled: payload.is_enabled,
      fromEmail: payload.from_email,
    })
    return json(200, { ok: true, settings: maskSettings(payload as unknown as SmtpSettingsRow) })
  }

  // verify + send-test require complete credentials
  const validationError = validateProviderForSend(payload)
  if (validationError) return json(400, { ok: false, error: validationError })

  if (action === 'verify') {
    try {
      if (payload.provider === 'smtp') {
        const transporter = await createSmtpTransport(payload, cryptoSecret)
        await transporter.verify()
      } else if (payload.provider === 'microsoft') {
        await verifyMicrosoft(payload, cryptoSecret)
      } else if (payload.provider === 'google') {
        await verifyGoogle(payload, cryptoSecret)
      }
      await logAudit(adminClient, organizationKey, 'email-settings-verify', {
        provider: payload.provider,
        fromEmail: payload.from_email,
      })
      return json(200, { ok: true, message: `${providerLabel(payload.provider)} connection verified successfully.` })
    } catch (error) {
      return json(200, { ok: false, error: error instanceof Error ? error.message : 'Verification failed.' })
    }
  }

  if (action === 'send-test') {
    const recipientEmail = normalizeEmail(body.recipientEmail)
    if (!recipientEmail) return json(400, { ok: false, error: 'recipientEmail is required.' })
    try {
      let messageId: string | null = null
      if (payload.provider === 'smtp') {
        const transporter = await createSmtpTransport(payload, cryptoSecret)
        const info = await transporter.sendMail({
          from: `${payload.from_name || org.name || 'Organization HR'} <${payload.from_email}>`,
          to: recipientEmail,
          subject: `SMTP test email for ${org.name || organizationKey}`,
          html: buildTestHtml(org.name || organizationKey, payload.footer_text || '', 'SMTP'),
          text: `SMTP test successful for ${org.name || organizationKey}.`,
          replyTo: payload.from_email || undefined,
        })
        messageId = info?.messageId || null
      } else if (payload.provider === 'microsoft') {
        await sendMicrosoftTestEmail(payload, cryptoSecret, recipientEmail, org.name || organizationKey)
      } else if (payload.provider === 'google') {
        const out = await sendGoogleTestEmail(payload, cryptoSecret, recipientEmail, org.name || organizationKey)
        messageId = out.messageId
      }
      await logAudit(adminClient, organizationKey, 'email-test-send', {
        provider: payload.provider,
        recipientEmail,
        messageId,
      })
      return json(200, {
        ok: true,
        message: 'Test email sent successfully.',
        messageId,
      })
    } catch (error) {
      return json(200, { ok: false, error: error instanceof Error ? error.message : 'Test email failed.' })
    }
  }

  return json(400, { ok: false, error: 'Unsupported action.' })
})

function providerLabel(provider: Provider) {
  if (provider === 'microsoft') return 'Microsoft 365'
  if (provider === 'google') return 'Google Workspace'
  return 'SMTP'
}
