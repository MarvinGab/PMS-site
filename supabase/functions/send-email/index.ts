import nodemailer from 'npm:nodemailer@6.10.1'
import { createClient } from 'npm:@supabase/supabase-js@2.57.4'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json',
}

type OrgRow = {
  id: string
  org_key: string
  name: string | null
  hr_admin_email: string | null
  hr_admin_name: string | null
  domain: string | null
  setup_payload: Record<string, unknown> | null
}

type MessageRequest = {
  type: 'org-admin-invite' | 'employee-invite' | 'manager-summary' | 'custom-broadcast'
  recipientEmail: string
  recipientCode?: string | null
  payload?: Record<string, unknown>
  subjectOverride?: string
  htmlOverride?: string
  textOverride?: string
}

type EmailTemplateRow = {
  owner_key: string
  template_key: string
  name: string
  subject: string
  config: Record<string, unknown> | null
}

type Provider = 'smtp' | 'microsoft' | 'google'

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

type SendArgs = { to: string; subject: string; html: string; text: string }
type SendResult = { messageId: string | null }
type Mailer = {
  provider: 'smtp' | 'org-smtp' | 'org-microsoft' | 'org-google'
  fromEmail: string
  fromName: string
  footerText: string
  send: (args: SendArgs) => Promise<SendResult>
}

const SMTP_SECRET_PREFIX = 'enc:v1:'
const EMAIL_SEND_CONCURRENCY = 5

function json(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), { status, headers: corsHeaders })
}

function normalizeEmail(value: unknown) {
  return String(value || '').trim().toLowerCase()
}

function escapeHtml(value: unknown) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function textEncoder() {
  return new TextEncoder()
}

function textDecoder() {
  return new TextDecoder()
}

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
  return crypto.subtle.importKey('raw', digest, 'AES-GCM', false, ['decrypt'])
}

async function decryptSecret(value: string | null, secret: string) {
  const raw = String(value || '')
  if (!raw) return ''
  if (!raw.startsWith(SMTP_SECRET_PREFIX)) return raw
  const payload = raw.slice(SMTP_SECRET_PREFIX.length)
  const [ivText, dataText] = payload.split(':')
  if (!ivText || !dataText) throw new Error('Stored SMTP secret is malformed.')
  const key = await importAesKey(secret)
  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: fromBase64(ivText) },
    key,
    fromBase64(dataText),
  )
  return textDecoder().decode(decrypted)
}

function resolveTemplateText(template: unknown, tokens: Record<string, unknown>) {
  return String(template || '').replace(/\{([a-z0-9_]+)\}/gi, (_, rawKey) => {
    const key = String(rawKey || '').trim().toLowerCase()
    return tokens[key] != null ? String(tokens[key]) : `{${rawKey}}`
  })
}

function renderLayout(title: string, intro: string, bodyHtml: string, footer = 'Zaro PMS') {
  return `
    <div style="margin:0;padding:24px;background:#f8fafc;font-family:Arial,Helvetica,sans-serif;color:#0f172a;">
      <div style="max-width:640px;margin:0 auto;background:#ffffff;border:1px solid #e2e8f0;border-radius:16px;overflow:hidden;">
        <div style="padding:24px 28px;background:linear-gradient(135deg,#eff6ff 0%,#ffffff 100%);border-bottom:1px solid #dbeafe;">
          <div style="font-size:12px;font-weight:700;letter-spacing:.08em;color:#2563eb;text-transform:uppercase;margin-bottom:8px;">Zaro PMS</div>
          <div style="font-size:28px;line-height:1.2;font-weight:800;color:#0f172a;margin-bottom:10px;">${escapeHtml(title)}</div>
          <div style="font-size:15px;line-height:1.6;color:#475569;">${escapeHtml(intro)}</div>
        </div>
        <div style="padding:28px;">
          ${bodyHtml}
        </div>
        <div style="padding:16px 28px;border-top:1px solid #e2e8f0;font-size:12px;color:#64748b;background:#f8fafc;">
          Sent by ${escapeHtml(footer)}
        </div>
      </div>
    </div>
  `
}

function renderCredentialsBlock(items: Array<{ label: string; value: unknown }>) {
  return `
    <div style="margin:20px 0;padding:16px 18px;border:1px solid #dbeafe;border-radius:12px;background:#f8fbff;">
      ${items.map((item) => `
        <div style="margin-bottom:10px;">
          <div style="font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:#64748b;margin-bottom:3px;">${escapeHtml(item.label)}</div>
          <div style="font-size:15px;font-weight:600;color:#0f172a;">${escapeHtml(item.value)}</div>
        </div>
      `).join('')}
    </div>
  `
}

function renderCta(url: string, label: string) {
  if (!url) return ''
  return `
    <div style="margin-top:24px;">
      <a href="${escapeHtml(url)}" style="display:inline-block;padding:12px 18px;border-radius:10px;background:#2563eb;color:#ffffff;text-decoration:none;font-weight:700;font-size:14px;">${escapeHtml(label)}</a>
    </div>
  `
}

function firstName(value: unknown) {
  return String(value || '').trim().split(/\s+/).filter(Boolean)[0] || 'there'
}

function renderAdminInviteHtml({
  companyName,
  adminName,
  loginEmail,
  tempPassword,
  workspaceUrl,
  supportEmail,
}: {
  companyName: string
  adminName: string
  loginEmail: string
  tempPassword: string
  workspaceUrl: string
  supportEmail: string
}) {
  const company = companyName || 'your company'
  const greetingName = firstName(adminName)
  const password = tempPassword || 'Use the temporary password assigned in setup'
  const workspace = workspaceUrl || 'https://zarohr.com'
  const support = supportEmail || 'support@zarohr.com'
  const preheader = `Your ${company} Zaro HR workspace is ready. Sign in, change your password, and invite your team.`
  const year = new Date().getFullYear()

  return `<!doctype html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta http-equiv="x-ua-compatible" content="ie=edge">
    <title>Your ${escapeHtml(company)} workspace is ready</title>
    <!--[if mso]><xml><o:OfficeDocumentSettings><o:AllowPNG/><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml><![endif]-->
    <style>
      .preheader { display:none !important; visibility:hidden; opacity:0; color:transparent; height:0; width:0; overflow:hidden; mso-hide:all; }
      @media screen and (max-width:600px) {
        .container { width:100% !important; }
        .px { padding-left:20px !important; padding-right:20px !important; }
        .section { padding-top:28px !important; padding-bottom:28px !important; }
        .button { display:block !important; width:100% !important; box-sizing:border-box !important; text-align:center !important; }
      }
    </style>
  </head>
  <body style="margin:0;padding:0;background:#ffffff;">
    <div class="preheader">${escapeHtml(preheader)}</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#ffffff;border-collapse:collapse;">
      <tr><td align="center" style="padding:0;">
        <table role="presentation" class="container" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:600px;border-collapse:collapse;">
          <tr><td class="px" style="height:56px;padding:0 32px;border-bottom:1px solid #e5e7eb;background:#ffffff;font-family:-apple-system,'Segoe UI',Roboto,Arial,sans-serif;font-size:17px;line-height:56px;font-weight:700;color:#111827;">Zaro <span style="color:#4f46e5;">HR</span></td></tr>
          <tr><td class="px section" style="padding:36px 32px 32px;background:#ffffff;font-family:-apple-system,'Segoe UI',Roboto,Arial,sans-serif;">
            <h1 style="margin:0 0 14px;font-size:24px;line-height:1.3;font-weight:600;color:#111827;">Your ${escapeHtml(company)} workspace is ready</h1>
            <p style="margin:0;font-size:16px;line-height:1.6;color:#111827;">Hi ${escapeHtml(greetingName)}, your Zaro HR admin workspace has been provisioned and is ready to open.</p>
          </td></tr>
          <tr><td class="px" style="padding:0 32px 32px;background:#ffffff;font-family:-apple-system,'Segoe UI',Roboto,Arial,sans-serif;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:separate;border-spacing:0;background:#f9fafb;border:1px solid #e5e7eb;border-radius:12px;">
              <tr><td style="padding:22px 24px;">
                <div style="font-size:12px;line-height:1.4;font-weight:600;color:#6b7280;text-transform:uppercase;letter-spacing:.04em;">Login email</div>
                <div style="margin-top:6px;font-family:'SFMono-Regular',Consolas,'Liberation Mono',Menlo,monospace;font-size:15px;line-height:1.5;color:#111827;word-break:break-all;">${escapeHtml(loginEmail)}</div>
                <div style="margin-top:16px;padding-top:16px;border-top:1px solid #e5e7eb;font-size:12px;line-height:1.4;font-weight:600;color:#6b7280;text-transform:uppercase;letter-spacing:.04em;">Temporary password</div>
                <div style="margin-top:6px;font-family:'SFMono-Regular',Consolas,'Liberation Mono',Menlo,monospace;font-size:15px;line-height:1.5;color:#111827;word-break:break-all;">${escapeHtml(password)}</div>
                <div style="margin-top:10px;display:inline-block;padding:4px 9px;border:1px solid #e5e7eb;border-radius:999px;background:#ffffff;font-size:12px;line-height:1.4;color:#6b7280;">Temporary - change on first login</div>
              </td></tr>
            </table>
          </td></tr>
          <tr><td class="px" style="padding:0 32px 32px;background:#ffffff;font-family:-apple-system,'Segoe UI',Roboto,Arial,sans-serif;">
            <!--[if mso]><v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" href="${escapeHtml(workspace)}" style="height:48px;v-text-anchor:middle;width:172px;" arcsize="17%" stroke="f" fillcolor="#4f46e5"><w:anchorlock/><center style="color:#ffffff;font-family:Segoe UI,Arial,sans-serif;font-size:16px;font-weight:600;">Open workspace</center></v:roundrect><![endif]-->
            <!--[if !mso]><!-- --><a href="${escapeHtml(workspace)}" class="button" style="display:inline-block;background:#4f46e5;color:#ffffff;text-decoration:none;font-family:-apple-system,'Segoe UI',Roboto,Arial,sans-serif;font-size:16px;line-height:20px;font-weight:600;padding:14px 28px;border-radius:8px;">Open workspace</a><!--<![endif]-->
          </td></tr>
          <tr><td class="px section" style="padding:32px;background:#ffffff;border-top:1px solid #e5e7eb;font-family:-apple-system,'Segoe UI',Roboto,Arial,sans-serif;">
            <h2 style="margin:0 0 16px;font-size:16px;line-height:1.4;font-weight:600;color:#111827;">What happens next</h2>
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;">
              <tr><td width="28" valign="top" style="font-size:16px;line-height:1.6;color:#6b7280;">1.</td><td style="font-size:16px;line-height:1.6;color:#111827;padding:0 0 10px;">Sign in to your workspace.</td></tr>
              <tr><td width="28" valign="top" style="font-size:16px;line-height:1.6;color:#6b7280;">2.</td><td style="font-size:16px;line-height:1.6;color:#111827;padding:0 0 10px;">Change your temporary password.</td></tr>
              <tr><td width="28" valign="top" style="font-size:16px;line-height:1.6;color:#6b7280;">3.</td><td style="font-size:16px;line-height:1.6;color:#111827;">Invite your team and finish PMS setup.</td></tr>
            </table>
            <p style="margin:24px 0 0;font-size:14px;line-height:1.6;color:#6b7280;">If you didn't expect this email, ignore it or contact <a href="mailto:${escapeHtml(support)}" style="color:#4f46e5;text-decoration:underline;">${escapeHtml(support)}</a>.</p>
          </td></tr>
          <tr><td class="px" style="padding:24px 32px 32px;background:#ffffff;border-top:1px solid #e5e7eb;font-family:-apple-system,'Segoe UI',Roboto,Arial,sans-serif;">
            <p style="margin:0 0 8px;font-size:12px;line-height:1.6;color:#6b7280;">Zaro HR, Product Communications</p>
            <p style="margin:0 0 8px;font-size:12px;line-height:1.6;color:#6b7280;"><a href="mailto:${escapeHtml(support)}" style="color:#6b7280;text-decoration:underline;">Support</a></p>
            <p style="margin:0;font-size:12px;line-height:1.6;color:#6b7280;">&copy; ${year} Zaro HR. All rights reserved.</p>
          </td></tr>
        </table>
      </td></tr>
    </table>
  </body>
</html>`
}

function buildOverrideContent(message: MessageRequest) {
  // Caller-supplied HTML/subject — used by the Communications composer and any
  // auto-trigger that wants to ship a themed email rendered on the client.
  return {
    subject: String(message.subjectOverride || '').trim() || '(no subject)',
    html: String(message.htmlOverride || ''),
    text: String(message.textOverride || ''),
  }
}

function buildEmailContent(message: MessageRequest, org: OrgRow, footerOverride?: string) {
  const payload = message.payload || {}

  if (message.type === 'custom-broadcast') {
    return buildOverrideContent(message)
  }

  if (message.type === 'org-admin-invite') {
    const adminName = String(payload.adminName || org.hr_admin_name || 'HR Admin')
    const organizationName = String(payload.organizationName || org.name || 'your organization')
    const loginUrl = String(payload.loginUrl || '')
    const workspaceDomain = String(payload.workspaceDomain || org.domain || '')
    const temporaryPassword = String(payload.temporaryPassword || '')
    const supportEmail = String(payload.supportEmail || 'support@zarohr.com')
    const subject = `Your ${organizationName} workspace is ready`
    const html = renderAdminInviteHtml({
      companyName: organizationName,
      adminName,
      loginEmail: normalizeEmail(message.recipientEmail),
      tempPassword: temporaryPassword,
      workspaceUrl: loginUrl || (workspaceDomain ? `https://${workspaceDomain}/#login` : ''),
      supportEmail,
    })
    const text = [
      `Hi ${firstName(adminName)},`,
      `Your ${organizationName} Zaro HR workspace is ready.`,
      `Email: ${normalizeEmail(message.recipientEmail)}`,
      `Temporary Password: ${temporaryPassword || 'Use the password assigned in setup'}`,
      loginUrl ? `Login: ${loginUrl}` : '',
      `Support: ${supportEmail}`,
    ].filter(Boolean).join('\n')
    return { subject, html, text }
  }

  if (message.type === 'employee-invite') {
    const employeeName = String(payload.employeeName || message.recipientCode || 'Employee')
    const organizationName = String(payload.organizationName || org.name || 'your organization')
    const employeeCode = String(payload.employeeCode || message.recipientCode || '')
    const temporaryPassword = String(payload.temporaryPassword || '')
    const loginUrl = String(payload.loginUrl || '')
    const managerName = String(payload.managerName || '')
    const subject = `${organizationName}: your PMS login details`
    const html = renderLayout(
      `Hello, ${employeeName}`,
      `Your performance workspace access for ${organizationName} is ready.`,
      `
        <p style="margin:0 0 14px;font-size:15px;line-height:1.7;color:#334155;">Use the following credentials to sign in and begin goal setting.</p>
        ${renderCredentialsBlock([
          { label: 'Employee Code', value: employeeCode },
          { label: 'Email', value: message.recipientEmail },
          { label: 'Temporary Password', value: temporaryPassword || 'Use the temporary password shared by HR' },
          ...(managerName ? [{ label: 'Reporting Manager', value: managerName }] : []),
        ])}
        <p style="margin:0;font-size:14px;line-height:1.7;color:#475569;">You will be prompted to change the temporary password after first login.</p>
        ${renderCta(loginUrl, 'Log in to PMS')}
      `,
      footerOverride || organizationName,
    )
    const text = [
      `Hello, ${employeeName}.`,
      `Your performance workspace access for ${organizationName} is ready.`,
      `Employee Code: ${employeeCode}`,
      `Email: ${message.recipientEmail}`,
      `Temporary Password: ${temporaryPassword || 'Use the temporary password shared by HR'}`,
      managerName ? `Reporting Manager: ${managerName}` : '',
      loginUrl ? `Login: ${loginUrl}` : '',
    ].filter(Boolean).join('\n')
    return { subject, html, text }
  }

  const managerName = String(payload.managerName || 'Manager')
  const organizationName = String(payload.organizationName || org.name || 'your organization')
  const reportees = Array.isArray(payload.reportees) ? payload.reportees as Array<Record<string, unknown>> : []
  const loginUrl = String(payload.loginUrl || '')
  const subject = `${organizationName}: your reportee setup summary`
  const reporteeListHtml = reportees.length > 0
    ? `<ul style="padding-left:18px;margin:16px 0 0;color:#334155;font-size:14px;line-height:1.8;">
        ${reportees.map((reportee) => `
          <li><strong>${escapeHtml(reportee.employeeName || reportee.employeeCode || 'Employee')}</strong>${reportee.designation ? ` — ${escapeHtml(reportee.designation)}` : ''}${reportee.employeeCode ? ` (${escapeHtml(reportee.employeeCode)})` : ''}</li>
        `).join('')}
      </ul>`
    : '<p style="margin:16px 0 0;font-size:14px;color:#475569;">No reportees were included in this cycle upload.</p>'
  const html = renderLayout(
    `Hello, ${managerName}`,
    `Your team setup summary for ${organizationName} is ready.`,
    `
      <p style="margin:0 0 14px;font-size:15px;line-height:1.7;color:#334155;">The following reportees are mapped to you for this cycle.</p>
      ${reporteeListHtml}
      ${renderCta(loginUrl, 'Open workspace')}
    `,
    footerOverride || organizationName,
  )
  const text = [
    `Hello, ${managerName}.`,
    `Your team setup summary for ${organizationName} is ready.`,
    ...reportees.map((reportee) => `- ${String(reportee.employeeName || reportee.employeeCode || 'Employee')}${reportee.employeeCode ? ` (${String(reportee.employeeCode)})` : ''}`),
    loginUrl ? `Workspace: ${loginUrl}` : '',
  ].filter(Boolean).join('\n')
  return { subject, html, text }
}

function buildTemplatedOrgInviteContent(
  org: OrgRow,
  message: MessageRequest,
  template: EmailTemplateRow | null,
  footerOverride?: string,
) {
  const payload = message.payload || {}
  const tokens = {
    organization_name: String(payload.organizationName || org.name || 'your organization'),
    admin_name: String(payload.adminName || org.hr_admin_name || 'HR Admin'),
    workspace_domain: String(payload.workspaceDomain || org.domain || ''),
    recipient_email: normalizeEmail(message.recipientEmail),
    temporary_password: String(payload.temporaryPassword || ''),
    login_url: String(payload.loginUrl || ''),
  }

  const config = template?.config || {}
  const subject = resolveTemplateText(
    template?.subject || 'Your {organization_name} workspace is ready',
    tokens,
  )
  const supportEmail = String(config.supportEmail || 'support@zarohr.com')
  const html = renderAdminInviteHtml({
    companyName: String(tokens.organization_name || ''),
    adminName: String(tokens.admin_name || ''),
    loginEmail: String(tokens.recipient_email || ''),
    tempPassword: String(tokens.temporary_password || ''),
    workspaceUrl: String(tokens.login_url || ''),
    supportEmail,
  })
  const text = [
    `Hi ${firstName(tokens.admin_name)},`,
    `Your ${tokens.organization_name} Zaro HR workspace is ready.`,
    `Email: ${tokens.recipient_email}`,
    `Temporary Password: ${tokens.temporary_password || 'Use the password assigned in setup'}`,
    tokens.login_url ? `Login: ${tokens.login_url}` : '',
    `Support: ${supportEmail}`,
  ].filter(Boolean).join('\n')

  return { subject, html, text }
}

async function getOrganization(client: ReturnType<typeof createClient>, organizationKey: string) {
  const { data, error } = await client
    .from('organizations')
    .select('id, org_key, name, hr_admin_email, hr_admin_name, domain, setup_payload')
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
  return data?.payload && typeof data.payload === 'object' ? data.payload as Record<string, unknown> : null
}

async function deleteServerSession(client: ReturnType<typeof createClient>, token: string) {
  await client
    .from('app_state')
    .delete()
    .eq('state_key', `server_session:${token}`)
    .eq('org_key', '')
}

async function requireAuthorizedSession(
  client: ReturnType<typeof createClient>,
  token: string,
  organizationKey: string,
  messages: MessageRequest[],
) {
  const payload = await getServerSession(client, token)
  if (!payload) return { ok: false, error: 'Server session is missing or expired.' }
  const expiresAt = String(payload.expiresAt || '')
  if (expiresAt && Date.now() > Date.parse(expiresAt)) {
    await deleteServerSession(client, token)
    return { ok: false, error: 'Server session has expired.' }
  }
  const role = String(payload.role || '')
  const isEmployeeSession = role === 'employee' || role === 'manager'
  if (role !== 'super-admin' && role !== 'hr-admin' && !isEmployeeSession) {
    return { ok: false, error: 'This session is not allowed to send email.' }
  }
  if (isEmployeeSession) {
    if (String(payload.orgKey || '') !== organizationKey) {
      return { ok: false, error: 'This session is not allowed to send mail for another organization.' }
    }
    const onlyManagerMessages = messages.every((message) => message.type === 'custom-broadcast')
    if (!onlyManagerMessages) {
      return { ok: false, error: 'Employee sessions can only send manager reminder emails.' }
    }
  }
  if (role !== 'super-admin' && String(payload.orgKey || '') !== organizationKey) {
    return { ok: false, error: 'This session is not allowed to send mail for another organization.' }
  }
  if (payload.isScopedHR === true) {
    const allowed = new Set(Array.isArray(payload.allowedModules) ? payload.allowedModules.map((item) => String(item || '').trim()) : [])
    if (!allowed.has('comms')) {
      return { ok: false, error: 'This scoped HR session is not allowed to use Communications.' }
    }
    const onlyEmployeeInvites = messages.every((message) => message.type === 'employee-invite' || message.type === 'manager-summary')
    if (!onlyEmployeeInvites) {
      return { ok: false, error: 'Scoped HR sessions can only send employee and manager communications.' }
    }
  }
  return { ok: true, payload }
}

function getOrgAdminEmails(org: OrgRow) {
  const emails = new Set<string>()
  const primaryEmail = normalizeEmail(org.hr_admin_email)
  if (primaryEmail) emails.add(primaryEmail)

  const setupPayload = org.setup_payload && typeof org.setup_payload === 'object' ? org.setup_payload : null
  const orgData = setupPayload?.orgData
  const hrTeam = orgData && typeof orgData === 'object' && Array.isArray((orgData as Record<string, unknown>).hrTeam)
    ? (orgData as Record<string, unknown>).hrTeam as Array<Record<string, unknown>>
    : []

  hrTeam.forEach((member) => {
    if (!member || typeof member !== 'object') return
    if (member.isInPMS) return
    const email = normalizeEmail(member.email)
    if (email) emails.add(email)
  })

  return emails
}

async function getEmailTemplate(
  client: ReturnType<typeof createClient>,
  ownerKey: string,
  templateKey: string,
) {
  const { data, error } = await client
    .from('email_templates')
    .select('owner_key, template_key, name, subject, config')
    .eq('owner_key', ownerKey)
    .eq('template_key', templateKey)
    .maybeSingle()
  if (error) throw error
  return data as EmailTemplateRow | null
}

async function getOrgSmtpSettings(
  client: ReturnType<typeof createClient>,
  organizationId: string,
) {
  const { data, error } = await client
    .from('email_smtp_settings')
    .select('organization_id, provider, is_enabled, use_tls, smtp_host, smtp_port, smtp_username, smtp_password, from_name, from_email, footer_text, ms_tenant_id, ms_client_id, ms_client_secret, google_client_id, google_client_secret, google_refresh_token')
    .eq('organization_id', organizationId)
    .maybeSingle()
  if (error) throw error
  return data as SmtpSettingsRow | null
}

function normalizeProvider(value: unknown): Provider {
  const v = String(value || '').trim()
  return v === 'microsoft' || v === 'google' ? v : 'smtp'
}

// Org settings are usable when the toggle is on AND the credentials for the
// chosen provider are complete. If incomplete, the platform default sender is
// used instead — this matches the existing fall-back behavior.
function orgSettingsAreUsable(orgSettings: SmtpSettingsRow | null): boolean {
  if (!orgSettings?.is_enabled || !orgSettings.from_email) return false
  const provider = normalizeProvider(orgSettings.provider)
  if (provider === 'smtp') {
    return !!(orgSettings.smtp_host && orgSettings.smtp_username && orgSettings.smtp_password)
  }
  if (provider === 'microsoft') {
    return !!(orgSettings.ms_tenant_id && orgSettings.ms_client_id && orgSettings.ms_client_secret)
  }
  if (provider === 'google') {
    return !!(orgSettings.google_client_id && orgSettings.google_client_secret && orgSettings.google_refresh_token)
  }
  return false
}

async function buildSmtpMailer(
  host: string,
  port: number,
  user: string,
  pass: string,
  fromEmail: string,
  fromName: string,
  footerText: string,
  requireTLS: boolean,
  providerLabel: Mailer['provider'],
): Promise<Mailer> {
  const transporter = nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    requireTLS,
    auth: { user, pass },
  })
  return {
    provider: providerLabel,
    fromEmail,
    fromName,
    footerText,
    async send({ to, subject, html, text }) {
      const info = await transporter.sendMail({
        from: `${fromName} <${fromEmail}>`,
        to,
        subject,
        html,
        text,
        replyTo: fromEmail,
      })
      return { messageId: info?.messageId || null }
    },
  }
}

async function buildMicrosoftMailer(
  orgSettings: SmtpSettingsRow,
  cryptoSecret: string,
  fromName: string,
  footerText: string,
): Promise<Mailer> {
  const tenantId = String(orgSettings.ms_tenant_id || '')
  const clientId = String(orgSettings.ms_client_id || '')
  const clientSecret = await decryptSecret(orgSettings.ms_client_secret || '', cryptoSecret)
  const senderEmail = String(orgSettings.from_email || '')

  // Token cache for the duration of this invocation (~1 hour validity).
  let cachedToken: string | null = null
  async function getToken() {
    if (cachedToken) return cachedToken
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
    const txt = await tokenRes.text()
    let payload: Record<string, unknown> = {}
    try { payload = txt ? JSON.parse(txt) : {} } catch { /* ignore */ }
    if (!tokenRes.ok || !payload.access_token) {
      const description = String(payload.error_description || payload.error || txt || `HTTP ${tokenRes.status}`)
      throw new Error(`Microsoft token request failed: ${description}`)
    }
    cachedToken = String(payload.access_token)
    return cachedToken
  }

  return {
    provider: 'org-microsoft',
    fromEmail: senderEmail,
    fromName,
    footerText,
    async send({ to, subject, html }) {
      const token = await getToken()
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
              toRecipients: [{ emailAddress: { address: to } }],
            },
            saveToSentItems: true,
          }),
        },
      )
      if (!send.ok) {
        const detail = await send.text()
        throw new Error(`Microsoft Graph sendMail failed (HTTP ${send.status}): ${detail}`)
      }
      // Graph sendMail returns 202 Accepted with empty body — no message id.
      return { messageId: null }
    },
  }
}

async function buildGoogleMailer(
  orgSettings: SmtpSettingsRow,
  cryptoSecret: string,
  fromName: string,
  footerText: string,
): Promise<Mailer> {
  const clientId = String(orgSettings.google_client_id || '')
  const clientSecret = await decryptSecret(orgSettings.google_client_secret || '', cryptoSecret)
  const refreshToken = await decryptSecret(orgSettings.google_refresh_token || '', cryptoSecret)
  const senderEmail = String(orgSettings.from_email || '')

  let cachedToken: string | null = null
  async function getToken() {
    if (cachedToken) return cachedToken
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
    const txt = await tokenRes.text()
    let payload: Record<string, unknown> = {}
    try { payload = txt ? JSON.parse(txt) : {} } catch { /* ignore */ }
    if (!tokenRes.ok || !payload.access_token) {
      const description = String(payload.error_description || payload.error || txt || `HTTP ${tokenRes.status}`)
      throw new Error(`Google token refresh failed: ${description}`)
    }
    cachedToken = String(payload.access_token)
    return cachedToken
  }

  return {
    provider: 'org-google',
    fromEmail: senderEmail,
    fromName,
    footerText,
    async send({ to, subject, html }) {
      const token = await getToken()
      const lines = [
        `From: ${fromName ? `${fromName} <${senderEmail}>` : senderEmail}`,
        `To: ${to}`,
        `Subject: ${subject}`,
        'MIME-Version: 1.0',
        'Content-Type: text/html; charset=UTF-8',
        '',
        html,
      ].join('\r\n')
      const raw = toBase64(textEncoder().encode(lines))
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/g, '')
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
    },
  }
}

async function buildMailer(
  defaults: {
    smtpHost: string
    smtpPort: number
    smtpUser: string
    smtpPass: string
    smtpFrom: string
    fromName: string
  },
  orgSettings: SmtpSettingsRow | null,
  cryptoSecret: string,
): Promise<Mailer> {
  if (orgSettingsAreUsable(orgSettings) && orgSettings) {
    const provider = normalizeProvider(orgSettings.provider)
    const fromName = orgSettings.from_name || defaults.fromName
    const footerText = orgSettings.footer_text || orgSettings.from_name || orgSettings.from_email || defaults.fromName

    if (provider === 'smtp') {
      const port = Number(orgSettings.smtp_port || 465)
      const useStartTls = orgSettings.use_tls !== false
      const pass = await decryptSecret(orgSettings.smtp_password || '', cryptoSecret)
      return await buildSmtpMailer(
        String(orgSettings.smtp_host || ''),
        port,
        String(orgSettings.smtp_username || ''),
        pass,
        String(orgSettings.from_email || ''),
        fromName,
        footerText,
        useStartTls,
        'org-smtp',
      )
    }
    if (provider === 'microsoft') {
      return await buildMicrosoftMailer(orgSettings, cryptoSecret, fromName, footerText)
    }
    if (provider === 'google') {
      return await buildGoogleMailer(orgSettings, cryptoSecret, fromName, footerText)
    }
  }

  // Default platform SMTP fall-back.
  return await buildSmtpMailer(
    defaults.smtpHost,
    defaults.smtpPort,
    defaults.smtpUser,
    defaults.smtpPass,
    defaults.smtpFrom,
    defaults.fromName,
    defaults.fromName,
    defaults.smtpPort !== 465,
    'smtp',
  )
}

async function isAllowedRecipient(
  client: ReturnType<typeof createClient>,
  org: OrgRow,
  message: MessageRequest,
) {
  const recipientEmail = normalizeEmail(message.recipientEmail)
  if (!recipientEmail) return false
  const adminEmails = getOrgAdminEmails(org)

  if (message.type === 'org-admin-invite') {
    return adminEmails.has(recipientEmail)
  }

  if (message.type === 'employee-invite') {
    const recipientCode = String(message.recipientCode || '').trim()
    if (!recipientCode) return false
    const { data, error } = await client
      .from('employees')
      .select('employee_code, email')
      .eq('organization_id', org.id)
      .eq('employee_code', recipientCode)
      .maybeSingle()
    if (error) throw error
    return normalizeEmail(data?.email) === recipientEmail
  }

  if (message.type === 'custom-broadcast') {
    // Recipient must be either an employee in this org OR a referenced manager_email.
    const { data: empRows, error: empErr } = await client
      .from('employees')
      .select('employee_code')
      .eq('organization_id', org.id)
      .eq('email', recipientEmail)
      .limit(1)
    if (empErr) throw empErr
    if (Array.isArray(empRows) && empRows.length > 0) return true
    const { data: mgrRows, error: mgrErr } = await client
      .from('employees')
      .select('manager_email')
      .eq('organization_id', org.id)
      .eq('manager_email', recipientEmail)
      .limit(1)
    if (mgrErr) throw mgrErr
    if (Array.isArray(mgrRows) && mgrRows.length > 0) return true
    return adminEmails.has(recipientEmail)
  }

  if (message.type === 'manager-summary') {
    // Recipient is a manager. emailService prefers the manager's own employee
    // Email ID when they exist in the roster; falls back to the stamped
    // manager_email on a reportee row. Accept either match.
    const { data: empRows, error: empErr } = await client
      .from('employees')
      .select('employee_code')
      .eq('organization_id', org.id)
      .eq('email', recipientEmail)
      .limit(1)
    if (empErr) throw empErr
    if (Array.isArray(empRows) && empRows.length > 0) return true
    const { data: mgrRows, error: mgrErr } = await client
      .from('employees')
      .select('manager_email')
      .eq('organization_id', org.id)
      .eq('manager_email', recipientEmail)
      .limit(1)
    if (mgrErr) throw mgrErr
    return Array.isArray(mgrRows) && mgrRows.length > 0
  }

  const { data, error } = await client
    .from('employees')
    .select('manager_email')
    .eq('organization_id', org.id)
    .eq('manager_email', recipientEmail)
    .limit(1)
  if (error) throw error
  return Array.isArray(data) && data.length > 0
}

async function isAllowedRecipientForActor(
  client: ReturnType<typeof createClient>,
  org: OrgRow,
  message: MessageRequest,
  actor: Record<string, unknown> | null,
) {
  const role = String(actor?.role || '')
  if (role !== 'employee' && role !== 'manager') return await isAllowedRecipient(client, org, message)

  if (message.type !== 'custom-broadcast') return false
  const recipientEmail = normalizeEmail(message.recipientEmail)
  const managerCode = String(actor?.empCode || '').trim()
  if (!recipientEmail || !managerCode) return false

  const { data, error } = await client
    .from('employees')
    .select('employee_code')
    .eq('organization_id', org.id)
    .eq('email', recipientEmail)
    .eq('manager_code', managerCode)
    .limit(1)
  if (error) throw error
  return Array.isArray(data) && data.length > 0
}

async function logDelivery(
  client: ReturnType<typeof createClient>,
  org: OrgRow,
  message: MessageRequest,
  content: { subject: string },
  status: 'sent' | 'failed',
  details: { providerMessageId?: string | null; errorMessage?: string | null; provider?: string | null } = {},
) {
  await client.from('email_deliveries').insert({
    organization_id: org.id,
    recipient_email: normalizeEmail(message.recipientEmail),
    recipient_code: message.recipientCode || null,
    delivery_type: message.type,
    subject: content.subject,
    status,
    provider: details.provider || 'smtp',
    provider_message_id: details.providerMessageId || null,
    error_message: details.errorMessage || null,
    payload: message.payload || {},
    sent_at: status === 'sent' ? new Date().toISOString() : null,
  })
}

async function logAudit(
  client: ReturnType<typeof createClient>,
  orgKey: string,
  actor: Record<string, unknown> | null,
  actionType: string,
  details: Record<string, unknown> = {},
) {
  await client.from('app_audit_logs').insert({
    org_key: orgKey,
    actor_role: String(actor?.role || 'system-function'),
    actor_code: String(actor?.empCode || actor?.hrTeamId || ''),
    actor_name: String(actor?.userName || 'send-email'),
    action_type: actionType,
    target_type: 'email-delivery',
    details,
  })
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return json(405, { ok: false, error: 'Method not allowed.' })

  const smtpHost = Deno.env.get('SMTP_HOST') || ''
  const smtpPort = Number(Deno.env.get('SMTP_PORT') || '465')
  const smtpUser = Deno.env.get('SMTP_USER') || ''
  const smtpPass = Deno.env.get('SMTP_PASS') || ''
  const smtpFrom = Deno.env.get('SMTP_FROM') || smtpUser
  const fromName = Deno.env.get('FROM_NAME') || 'Zaro PMS'
  const cryptoSecret = Deno.env.get('SMTP_CONFIG_SECRET') || ''
  const supabaseUrl = Deno.env.get('SUPABASE_URL') || ''
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || ''

  if (!smtpHost || !smtpPort || !smtpUser || !smtpPass || !smtpFrom) {
    return json(500, { ok: false, error: 'SMTP secrets are not configured on the server.' })
  }
  if (!supabaseUrl || !serviceRoleKey) {
    return json(500, { ok: false, error: 'Supabase service role configuration is missing.' })
  }
  if (!cryptoSecret) {
    return json(500, { ok: false, error: 'SMTP config encryption secret is missing.' })
  }

  let body: { organizationKey?: string; messages?: MessageRequest[]; serverSessionToken?: string }
  try {
    body = await req.json()
  } catch {
    return json(400, { ok: false, error: 'Invalid JSON request body.' })
  }

  const organizationKey = String(body.organizationKey || '').trim()
  const serverSessionToken = String(body.serverSessionToken || '').trim()
  const messages = Array.isArray(body.messages) ? body.messages : []
  if (!organizationKey || messages.length === 0) {
    return json(400, { ok: false, error: 'organizationKey and messages are required.' })
  }
  if (!serverSessionToken) {
    return json(401, { ok: false, error: 'serverSessionToken is required.' })
  }

  const adminClient = createClient(supabaseUrl, serviceRoleKey)
  const sessionCheck = await requireAuthorizedSession(adminClient, serverSessionToken, organizationKey, messages)
  if (!sessionCheck.ok) {
    return json(403, { ok: false, error: sessionCheck.error })
  }
  const sessionPayload = sessionCheck.payload || null
  const org = await getOrganization(adminClient, organizationKey)
  if (!org?.id) return json(404, { ok: false, error: 'Organization not found.' })
  const orgAdminInviteTemplate = await getEmailTemplate(adminClient, 'global', 'org-admin-invite')
  const orgSmtpSettings = await getOrgSmtpSettings(adminClient, org.id)

  let mailer: Mailer
  try {
    mailer = await buildMailer(
      { smtpHost, smtpPort, smtpUser, smtpPass, smtpFrom, fromName },
      orgSmtpSettings,
      cryptoSecret,
    )
  } catch (error) {
    return json(500, {
      ok: false,
      error: error instanceof Error ? error.message : 'Failed to initialise email transport.',
    })
  }

  const results: Array<Record<string, unknown>> = []

  function buildContent(message: MessageRequest) {
    // Caller-supplied HTML wins for every type — that's how Communications and
    // any auto-trigger ship a theme-rendered email. Fall back to templates when
    // no override is provided.
    if (message.htmlOverride) {
      return buildOverrideContent(message)
    }
    if (message.type === 'org-admin-invite') {
      return buildTemplatedOrgInviteContent(org!, message, orgAdminInviteTemplate, mailer.footerText)
    }
    return buildEmailContent(message, org!, mailer.footerText)
  }

  async function processMessage(message: MessageRequest) {
    const allowed = await isAllowedRecipientForActor(adminClient, org, message, sessionPayload)
    if (!allowed) {
      const content = buildContent(message)
      await logDelivery(adminClient, org, message, content, 'failed', {
        errorMessage: 'Recipient is not recognized for this organization.',
        provider: mailer.provider,
      })
      await logAudit(adminClient, organizationKey, sessionPayload, 'email-send-denied', {
        provider: mailer.provider,
        recipientEmail: normalizeEmail(message.recipientEmail),
        messageType: message.type,
        error: 'Recipient is not recognized for this organization.',
      })
      results.push({
        recipientEmail: normalizeEmail(message.recipientEmail),
        type: message.type,
        ok: false,
        error: 'Recipient is not recognized for this organization.',
      })
      return
    }

    const content = buildContent(message)
    try {
      const info = await mailer.send({
        to: normalizeEmail(message.recipientEmail),
        subject: content.subject,
        html: content.html,
        text: content.text,
      })
      await logDelivery(adminClient, org, message, content, 'sent', {
        providerMessageId: info.messageId,
        provider: mailer.provider,
      })
      await logAudit(adminClient, organizationKey, sessionPayload, 'email-send', {
        provider: mailer.provider,
        recipientEmail: normalizeEmail(message.recipientEmail),
        messageType: message.type,
        messageId: info.messageId,
      })
      results.push({
        recipientEmail: normalizeEmail(message.recipientEmail),
        type: message.type,
        ok: true,
        messageId: info.messageId,
      })
    } catch (error) {
      await logDelivery(adminClient, org, message, content, 'failed', {
        errorMessage: error instanceof Error ? error.message : 'Email send failed.',
        provider: mailer.provider,
      })
      await logAudit(adminClient, organizationKey, sessionPayload, 'email-send-failed', {
        provider: mailer.provider,
        recipientEmail: normalizeEmail(message.recipientEmail),
        messageType: message.type,
        error: error instanceof Error ? error.message : 'Email send failed.',
      })
      results.push({
        recipientEmail: normalizeEmail(message.recipientEmail),
        type: message.type,
        ok: false,
        error: error instanceof Error ? error.message : 'Email send failed.',
      })
    }
  }

  for (let index = 0; index < messages.length; index += EMAIL_SEND_CONCURRENCY) {
    await Promise.all(messages.slice(index, index + EMAIL_SEND_CONCURRENCY).map(processMessage))
  }

  const sent = results.filter((item) => item.ok).length
  const failed = results.length - sent
  return json(200, {
    ok: failed === 0,
    sent,
    failed,
    results,
  })
})
