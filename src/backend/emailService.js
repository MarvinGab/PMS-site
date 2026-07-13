import { shouldUseSupabase, supabaseEnv } from './config';
import { readAuthSessionSync, readEmployeeSessionSync } from './stateStore';
import { tryRefreshSuperAdminSession } from './serverAuth';
import {
  renderThemedEmailHtml,
  renderThemedEmailText,
  renderPlainEmailHtml,
  resolveTokens,
} from './emailRenderer';
import { buildWorkspaceUrl } from '../orgUtils';

function getWorkspaceLoginUrl(org, identifier = '') {
  const slug = String(org?.workspaceSlug || '').trim();
  const domain = String(org?.domain || '').trim().toLowerCase();
  const loginIdentifier = String(identifier || '').trim().toLowerCase();
  const loginQuery = loginIdentifier ? `?login=${encodeURIComponent(loginIdentifier)}` : '';

  // Path-based scheme: pms.zarohr.com/<slug>?login=<id>#login
  // Built relative to the current origin during dev/preview so links sent
  // from a Vercel preview deploy point back to that preview, not prod.
  if (typeof window !== 'undefined') {
    const { origin, hostname } = window.location;
    const isLocalhost = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '0.0.0.0';
    const isPlatformHost = hostname === 'zarohr.com' || hostname === 'www.zarohr.com' || hostname === 'pms.zarohr.com';
    const isTenantHost = hostname.endsWith('.zarohr.com') && !isPlatformHost;
    if (isLocalhost || !isTenantHost) {
      const path = slug ? `/${slug}` : '/';
      return `${origin}${path}${loginQuery}#login`;
    }
  }

  if (slug) {
    return `${buildWorkspaceUrl(slug, { absolute: true })}${loginQuery}#login`;
  }
  if (domain) return `https://${domain}/${loginQuery}#login`;
  return `https://zarohr.com/${loginQuery}#login`;
}

function getOrgBrandedTheme(org, theme = {}) {
  const base = theme && typeof theme === 'object' ? theme : {};
  const orgLogo = String(org?.brandEmailLogo || org?.brandLogo || org?.brandLogoUrl || '').trim();
  const themeLogo = String(base.logo || '').trim();
  // Explicit theme choice always wins; only fall back to the org's brand
  // logo when no theme logo is set AND the user has not explicitly cleared it.
  const userCleared = base.logoCleared === true;
  const logo = userCleared ? null : (themeLogo || orgLogo || null);
  const palette = org?.brandPalette && typeof org.brandPalette === 'object' ? org.brandPalette : {};
  const brand = base.brand || palette.primary || palette.brand || palette.accent || '#4F46E5';
  return {
    ...base,
    brand,
    brandName: base.brandName || org?.brandName || org?.name || 'Zaro HR',
    logo,
    logoDisplay: base.logoDisplay || (logo ? 'logo' : 'text'),
    logoPosition: base.logoPosition || 'header-left',
    logoSize: base.logoSize || 'medium',
  };
}

const SESSION_EXPIRED_PATTERN = /session is missing or expired|session has expired/i;

function readServerSessionToken() {
  const authSession = readAuthSessionSync();
  const employeeSession = readEmployeeSessionSync();
  return authSession?.serverSessionToken || employeeSession?.serverSessionToken || null;
}

async function postSendEmail(body, sessionToken) {
  const response = await fetch(`${supabaseEnv.url}/functions/v1/send-email`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: supabaseEnv.anonKey,
      Authorization: `Bearer ${supabaseEnv.anonKey}`,
    },
    body: JSON.stringify({
      serverSessionToken: sessionToken || null,
      ...body,
    }),
  });
  const rawText = await response.text();
  let data = null;
  if (rawText) {
    try { data = JSON.parse(rawText); }
    catch {
      return { httpOk: response.ok, status: response.status, parseFailed: true, raw: rawText };
    }
  }
  return { httpOk: response.ok, status: response.status, data };
}

async function invokeEmailFunction(body) {
  if (!shouldUseSupabase || !supabaseEnv.url || !supabaseEnv.anonKey) {
    return { ok: false, error: 'Supabase email delivery is not configured.' };
  }

  try {
    const initialToken = readServerSessionToken();
    let res = await postSendEmail(body, initialToken);

    // If the server says the session is gone, try a silent re-auth (works
    // for local Super Admin via VITE_SUPER_ADMIN_* env vars) and retry once.
    const errorText = res?.parseFailed
      ? res.raw || ''
      : res?.data?.error || res?.data?.message || '';
    const isSessionExpired = SESSION_EXPIRED_PATTERN.test(String(errorText));
    if (isSessionExpired) {
      const refreshed = await tryRefreshSuperAdminSession();
      if (refreshed?.token) {
        res = await postSendEmail(body, refreshed.token);
      }
    }

    if (res?.parseFailed) {
      return { ok: false, error: res.raw || `Email delivery backend returned HTTP ${res.status}.` };
    }
    if (!res?.httpOk) {
      return {
        ok: false,
        error: res?.data?.error || res?.data?.message || `Email delivery backend returned HTTP ${res?.status}.`,
      };
    }
    return res?.data?.ok === false ? res.data : { ok: true, ...(res?.data || {}) };
  } catch (error) {
    return { ok: false, error: error?.message || 'Failed to invoke email delivery function.' };
  }
}

export async function sendHrAdminInviteEmail(org, options = {}) {
  if (!org?.key || !org?.hrAdminEmail) {
    return { ok: false, error: 'Missing organization key or HR admin email.' };
  }

  const recipientEmail = String(org.hrAdminEmail || '').trim().toLowerCase();
  const loginUrl = getWorkspaceLoginUrl(org, recipientEmail);
  const adminName = org.hrAdminName || 'HR Admin';
  const supportEmail = options.supportEmail || 'support@zarohr.com';

  const message = {
    type: 'org-admin-invite',
    recipientEmail,
    payload: {
      organizationName: org.name || 'Your organization',
      adminName,
      workspaceSlug: org.workspaceSlug || '',
      workspaceDomain: loginUrl,
      loginUrl,
      temporaryPassword: org.temporaryPassword || '',
      supportEmail,
    },
  };

  // WYSIWYG: render the SuperAdmin's edited subject + body through the same
  // themed renderer used for every other Communications template, so what they
  // see in the preview is exactly what lands in the inbox. The old hardcoded
  // "What happens next / If you didn't expect" layout was overriding their
  // edits — gone.
  if (options.theme && options.template) {
    // SuperAdmin's preview header shows only the subject — no uppercase
    // label band. Force-empty headerLabel here so saved local state from
    // earlier sessions can't reintroduce it on send.
    const themeWithSuppressedLabel = { ...options.theme, headerLabel: '' };
    const theme = getOrgBrandedTheme(org, themeWithSuppressedLabel);
    const tokens = {
      organization_name: org.name || 'Your organization',
      company: org.name || 'Your organization',
      admin_name: adminName,
      first_name: String(adminName || '').trim().split(/\s+/).filter(Boolean)[0] || 'there',
      workspace_domain: loginUrl,
      recipient_email: recipientEmail,
      temporary_password: org.temporaryPassword || '',
      password: org.temporaryPassword || '',
      login_url: loginUrl,
      workspace_url: loginUrl,
      support_email: supportEmail,
      // Re-export under HR-side token names so existing composer drafts using
      // {employee_name} / {hr_admin_name} continue to resolve.
      employee_name: adminName,
      hr_admin_name: adminName,
    };
    message.subjectOverride = resolveTokens(options.template.subject || '', tokens);
    message.htmlOverride = renderThemedEmailHtml({
      theme,
      subject: options.template.subject || '',
      body: options.template.body || '',
      orgName: org.name || '',
      tokens,
      loginUrl,
    });
    message.textOverride = renderThemedEmailText({
      subject: options.template.subject || '',
      body: options.template.body || '',
      tokens,
    });
  }

  return invokeEmailFunction({
    organizationKey: org.key,
    messages: [message],
  });
}

export async function sendEmployeeInviteEmails({ org, employees = [], theme, template } = {}) {
  const temporaryPassword = String(org?.temporaryPassword || '');
  const useOverride = !!(theme && template);
  const effectiveTheme = useOverride ? getOrgBrandedTheme(org, theme) : null;

  const messages = (Array.isArray(employees) ? employees : [])
    .map((employee) => {
      const employeeCode = String(employee?.['Employee Code'] || '').trim();
      const recipientEmail = String(
        employee?.['Email ID']
          || employee?.Email
          || employee?.email
          || employee?.['Work Email']
          || employee?.['Official Email']
          || ''
      ).trim().toLowerCase();

      if (!recipientEmail || !employeeCode) return null;

      const loginUrl = getWorkspaceLoginUrl(org, recipientEmail);
      const employeeName = String(employee?.['Employee Name'] || '').trim() || employeeCode;
      const managerName = String(employee?.['Reporting Manager Name'] || '').trim();

      const message = {
        type: 'employee-invite',
        recipientEmail,
        recipientCode: employeeCode,
        payload: {
          organizationName: org?.name || 'Your organization',
          employeeName,
          employeeCode,
          loginUrl,
          temporaryPassword,
          managerName,
        },
      };

      if (useOverride) {
        const tokens = {
          organization_name: org?.name || 'Your organization',
          employee_name: employeeName,
          employee_code: employeeCode,
          password: temporaryPassword,
          temporary_password: temporaryPassword,
          login_url: loginUrl,
          manager_name: managerName,
          recipient_email: recipientEmail,
        };
        message.subjectOverride = resolveTokens(template.subject || '', tokens);
        message.htmlOverride = renderThemedEmailHtml({
          theme: effectiveTheme,
          subject: template.subject || '',
          body: template.body || '',
          orgName: org?.name || '',
          tokens,
          loginUrl,
        });
        message.textOverride = renderThemedEmailText({
          subject: template.subject || '',
          body: template.body || '',
          tokens,
        });
      }

      return message;
    })
    .filter(Boolean);

  if (!org?.key || !temporaryPassword) {
    return { ok: false, error: 'Organization key or temporary password is missing.' };
  }
  if (messages.length === 0) {
    return { ok: true, skipped: true, sent: 0, failed: 0 };
  }

  return invokeEmailFunction({
    organizationKey: org.key,
    messages,
  });
}

export async function sendManagerSummaryEmails({ org, employees = [], theme, template, recipientFilter = null } = {}) {
  if (!org?.key) return { ok: false, error: 'Organization key is missing.' };
  const effectiveTheme = theme && template ? getOrgBrandedTheme(org, theme) : null;

  const list = Array.isArray(employees) ? employees : [];

  // Index roster by code so managers who are also uploaded employees use their
  // OWN Email ID, not whatever was stamped on a reportee's row.
  const rosterByCode = new Map();
  list.forEach((emp) => {
    const code = String(emp?.['Employee Code'] || '').trim().toLowerCase();
    if (code) rosterByCode.set(code, emp);
  });

  // Dedupe by manager CODE so two managers with the same email don't collapse.
  const managers = new Map();
  list.forEach((employee) => {
    const rawCode = String(employee?.['Reporting Manager Code'] || '').trim();
    const code = rawCode.toLowerCase();
    const stampedEmail = String(employee?.['Reporting Manager Email'] || '').trim().toLowerCase();
    const managerEmp = code ? rosterByCode.get(code) : null;
    const ownEmail = String(managerEmp?.['Email ID'] || managerEmp?.Email || '').trim().toLowerCase();
    const email = ownEmail || stampedEmail;
    if (!email) return; // Can't send without an address.

    const key = code || `email:${email}`;
    const entry = managers.get(key) || {
      recipientEmail: email,
      managerName:
        String(managerEmp?.['Employee Name'] || '').trim()
        || String(employee?.['Reporting Manager Name'] || '').trim()
        || email,
      reportees: [],
    };
    entry.reportees.push({
      employeeCode: String(employee?.['Employee Code'] || '').trim(),
      employeeName: String(employee?.['Employee Name'] || '').trim(),
      designation: String(employee?.Designation || employee?.Role || '').trim(),
    });
    managers.set(key, entry);
  });

  const useOverride = !!(theme && template);
  const filterSet = recipientFilter instanceof Set
    ? recipientFilter
    : Array.isArray(recipientFilter)
    ? new Set(recipientFilter.map((e) => String(e || '').trim().toLowerCase()).filter(Boolean))
    : null;
  const messages = [...managers.values()]
    .filter((value) => !filterSet || filterSet.has(value.recipientEmail))
    .map((value) => {
    const recipientEmail = value.recipientEmail;
    const loginUrl = getWorkspaceLoginUrl(org, recipientEmail);
    const message = {
      type: 'manager-summary',
      recipientEmail,
      payload: {
        organizationName: org?.name || 'Your organization',
        managerName: value.managerName,
        reportees: value.reportees,
        loginUrl,
      },
    };
    if (useOverride) {
      const reporteeLines = value.reportees
        .map((r) => `• ${r.employeeName || r.employeeCode}${r.designation ? ` — ${r.designation}` : ''}${r.employeeCode ? ` (${r.employeeCode})` : ''}`)
        .join('\n');
      const reporteeListHtml = value.reportees.length > 0
        ? `<ul style="padding-left:18px;margin:8px 0 16px;color:#334155;font-size:14px;line-height:1.8;">${value.reportees.map((r) => `<li><strong>${escapeHtml(r.employeeName || r.employeeCode || 'Employee')}</strong>${r.designation ? ` — ${escapeHtml(r.designation)}` : ''}${r.employeeCode ? ` (${escapeHtml(r.employeeCode)})` : ''}</li>`).join('')}</ul>`
        : '';
      const tokens = {
        organization_name: org?.name || 'Your organization',
        manager_name: value.managerName,
        reportee_count: String(value.reportees.length),
        reportee_list: reporteeLines,
        login_url: loginUrl,
        recipient_email: recipientEmail,
        employee_name: value.managerName,
      };
      // Only append the formatted list as an extra block when the template
      // body doesn't already include {reportee_list} — otherwise the list
      // would render twice (once inline as bullets, once again as extras).
      const bodyHasReporteeToken = /\{reportee_list\}/.test(template.body || '');
      message.subjectOverride = resolveTokens(template.subject || '', tokens);
      message.htmlOverride = renderThemedEmailHtml({
        theme: effectiveTheme,
        subject: template.subject || '',
        body: template.body || '',
        orgName: org?.name || '',
        tokens,
        loginUrl,
        extrasHtml: bodyHasReporteeToken ? '' : reporteeListHtml,
      });
      message.textOverride = renderThemedEmailText({
        subject: template.subject || '',
        body: template.body || '',
        tokens,
      });
    }
    return message;
  });

  if (messages.length === 0) {
    return { ok: true, skipped: true, sent: 0, failed: 0 };
  }

  return invokeEmailFunction({
    organizationKey: org.key,
    messages,
  });
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Custom broadcast — used by the Communications page Send button. Renders the
// chosen template (subject + body + theme) per recipient, resolving employee
// tokens, and delegates to the Edge Function with htmlOverride.
// `plain: true` switches to a no-chrome renderer (no header banner, no logo,
// no CTA button, no footer) so manager-to-report reminders read like normal
// person-to-person email instead of branded marketing chrome.
export async function sendCustomBroadcast({ org, recipients = [], theme, template, tokensFor, plain = false } = {}) {
  if (!org?.key) return { ok: false, error: 'Organization key is missing.' };
  if (!plain && (!theme || !template)) return { ok: false, error: 'Theme and template are required.' };
  if (plain && !template) return { ok: false, error: 'Template is required.' };
  if (!template.subject || !template.body) return { ok: false, error: 'Subject and body are required.' };

  const temporaryPassword = String(org?.temporaryPassword || '');
  const effectiveTheme = plain ? null : getOrgBrandedTheme(org, theme);

  const messages = (Array.isArray(recipients) ? recipients : [])
    .map((rcpt) => {
      const recipientEmail = String(
        rcpt?.['Email ID']
          || rcpt?.Email
          || rcpt?.email
          || rcpt?.['Work Email']
          || rcpt?.['Official Email']
          || rcpt?.['Email Address']
          || ''
      ).trim().toLowerCase();
      if (!recipientEmail) return null;
      const employeeCode = String(rcpt?.['Employee Code'] || '').trim();
      const loginUrl = getWorkspaceLoginUrl(org, recipientEmail);
      const employeeName = String(rcpt?.['Employee Name'] || '').trim() || employeeCode || recipientEmail;
      const baseTokens = {
        organization_name: org?.name || 'Your organization',
        employee_name: employeeName,
        employee_code: employeeCode,
        password: temporaryPassword,
        temporary_password: temporaryPassword,
        login_url: loginUrl,
        recipient_email: recipientEmail,
        manager_name: String(rcpt?.['Reporting Manager Name'] || '').trim(),
      };
      const extra = typeof tokensFor === 'function' ? (tokensFor(rcpt) || {}) : {};
      const tokens = { ...baseTokens, ...extra };
      const html = plain
        ? renderPlainEmailHtml({
            subject: template.subject,
            body: template.body,
            tokens,
            // Footer carries ONLY the org name. The manager's name already
            // appears in the body signature ("Thanks, {manager_name}"); we
            // don't want to repeat it under the divider as well.
            signature: org?.name || '',
            // CTA button picks up the org's brand primary so the button color
            // matches the rest of the app subtly. Falls back to renderer's
            // default indigo if the org hasn't configured a palette.
            accent: (org?.brandPalette && typeof org.brandPalette === 'object'
              && (org.brandPalette.primary || org.brandPalette.brand || org.brandPalette.accent)) || undefined,
          })
        : renderThemedEmailHtml({
            theme: effectiveTheme,
            subject: template.subject,
            body: template.body,
            orgName: org?.name || '',
            tokens,
            loginUrl,
          });
      return {
        type: 'custom-broadcast',
        recipientEmail,
        recipientCode: employeeCode || null,
        payload: { organizationName: org?.name || 'Your organization' },
        subjectOverride: resolveTokens(template.subject, tokens),
        htmlOverride: html,
        textOverride: renderThemedEmailText({
          subject: template.subject,
          body: template.body,
          tokens,
        }),
      };
    })
    .filter(Boolean);

  if (messages.length === 0) {
    return { ok: true, skipped: true, sent: 0, failed: 0 };
  }

  return invokeEmailFunction({
    organizationKey: org.key,
    messages,
  });
}
