import { shouldUseSupabase, supabaseEnv } from './config';
import { readAuthSessionSync } from './stateStore';
import {
  renderAdminInviteEmailHtml,
  renderAdminInviteEmailText,
  renderThemedEmailHtml,
  renderThemedEmailText,
  resolveTokens,
} from './emailRenderer';

function getWorkspaceLoginUrl(org) {
  const slug = String(org?.workspaceSlug || '').trim();
  const domain = String(org?.domain || '').trim().toLowerCase();

  if (typeof window !== 'undefined') {
    const { origin, hostname } = window.location;
    const isLocalhost = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '0.0.0.0';
    if (isLocalhost) {
      const workspaceParam = slug ? `?workspace=${encodeURIComponent(slug)}` : '';
      return `${origin}/${workspaceParam}#login`;
    }
  }

  if (domain) return `https://${domain}/#login`;
  if (slug)   return `https://${slug}.zarohr.com/#login`;
  return 'https://zarohr.com/#login';
}

async function invokeEmailFunction(body) {
  if (!shouldUseSupabase || !supabaseEnv.url || !supabaseEnv.anonKey) {
    return { ok: false, error: 'Supabase email delivery is not configured.' };
  }

  try {
    const authSession = readAuthSessionSync();
    const response = await fetch(`${supabaseEnv.url}/functions/v1/send-email`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: supabaseEnv.anonKey,
        Authorization: `Bearer ${supabaseEnv.anonKey}`,
      },
      body: JSON.stringify({
        serverSessionToken: authSession?.serverSessionToken || null,
        ...body,
      }),
    });
    const rawText = await response.text();
    let data = null;
    if (rawText) {
      try {
        data = JSON.parse(rawText);
      } catch {
        return {
          ok: false,
          error: rawText || `Email delivery backend returned HTTP ${response.status}.`,
        };
      }
    }
    if (!response.ok) {
      return {
        ok: false,
        error:
          data?.error
          || data?.message
          || `Email delivery backend returned HTTP ${response.status}.`,
      };
    }
    return data?.ok === false ? data : { ok: true, ...(data || {}) };
  } catch (error) {
    return { ok: false, error: error?.message || 'Failed to invoke email delivery function.' };
  }
}

export async function sendHrAdminInviteEmail(org, options = {}) {
  if (!org?.key || !org?.hrAdminEmail) {
    return { ok: false, error: 'Missing organization key or HR admin email.' };
  }

  const loginUrl = getWorkspaceLoginUrl(org);
  const recipientEmail = String(org.hrAdminEmail || '').trim().toLowerCase();
  const adminName = org.hrAdminName || 'HR Admin';
  const supportEmail = options.supportEmail || 'support@zarohr.com';

  const message = {
    type: 'org-admin-invite',
    recipientEmail,
    payload: {
      organizationName: org.name || 'Your organization',
      adminName,
      workspaceSlug: org.workspaceSlug || '',
      workspaceDomain: org.domain || '',
      loginUrl,
      temporaryPassword: org.temporaryPassword || '',
      supportEmail,
    },
  };

  // If a theme + draft (subject/body) was passed in, render it client-side and
  // ship it as an override so the same designed look reaches the inbox.
  if (options.theme && options.template) {
    const tokens = {
      organization_name: org.name || 'Your organization',
      admin_name: adminName,
      first_name: String(adminName || '').trim().split(/\s+/).filter(Boolean)[0] || 'there',
      workspace_domain: org.domain || '',
      recipient_email: recipientEmail,
      temporary_password: org.temporaryPassword || '',
      login_url: loginUrl,
      // Re-export with hr_admin_name so the existing tokens defined in the
      // Communications composer keep working.
      employee_name: adminName,
      hr_admin_name: adminName,
    };
    message.subjectOverride = resolveTokens(options.template.subject || '', tokens);
    message.htmlOverride = renderAdminInviteEmailHtml({
      companyName: org.name || 'Your organization',
      firstName: tokens.first_name || adminName,
      loginEmail: recipientEmail,
      tempPassword: org.temporaryPassword || '',
      workspaceUrl: loginUrl,
      supportEmail,
      theme: options.theme,
      blocks: options.template.blocks || null,
    });
    message.textOverride = renderAdminInviteEmailText({
      companyName: org.name || 'Your organization',
      firstName: tokens.first_name || adminName,
      loginEmail: recipientEmail,
      tempPassword: org.temporaryPassword || '',
      workspaceUrl: loginUrl,
      supportEmail,
    });
  }

  return invokeEmailFunction({
    organizationKey: org.key,
    messages: [message],
  });
}

export async function sendEmployeeInviteEmails({ org, employees = [], theme, template } = {}) {
  const loginUrl = getWorkspaceLoginUrl(org);
  const temporaryPassword = String(org?.temporaryPassword || '');
  const useOverride = !!(theme && template);

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
          theme,
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

export async function sendManagerSummaryEmails({ org, employees = [], theme, template } = {}) {
  if (!org?.key) return { ok: false, error: 'Organization key is missing.' };

  const managers = new Map();
  (Array.isArray(employees) ? employees : []).forEach((employee) => {
    const managerEmail = String(employee?.['Reporting Manager Email'] || '').trim().toLowerCase();
    if (!managerEmail) return;

    const entry = managers.get(managerEmail) || {
      managerName: String(employee?.['Reporting Manager Name'] || '').trim() || managerEmail,
      reportees: [],
    };
    entry.reportees.push({
      employeeCode: String(employee?.['Employee Code'] || '').trim(),
      employeeName: String(employee?.['Employee Name'] || '').trim(),
      designation: String(employee?.Designation || employee?.Role || '').trim(),
    });
    managers.set(managerEmail, entry);
  });

  const loginUrl = getWorkspaceLoginUrl(org);
  const useOverride = !!(theme && template);
  const messages = [...managers.entries()].map(([recipientEmail, value]) => {
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
      message.subjectOverride = resolveTokens(template.subject || '', tokens);
      message.htmlOverride = renderThemedEmailHtml({
        theme,
        subject: template.subject || '',
        body: template.body || '',
        orgName: org?.name || '',
        tokens,
        loginUrl,
        extrasHtml: reporteeListHtml,
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
export async function sendCustomBroadcast({ org, recipients = [], theme, template, tokensFor } = {}) {
  if (!org?.key) return { ok: false, error: 'Organization key is missing.' };
  if (!theme || !template) return { ok: false, error: 'Theme and template are required.' };
  if (!template.subject || !template.body) return { ok: false, error: 'Subject and body are required.' };

  const loginUrl = getWorkspaceLoginUrl(org);
  const temporaryPassword = String(org?.temporaryPassword || '');

  const messages = (Array.isArray(recipients) ? recipients : [])
    .map((rcpt) => {
      const recipientEmail = String(
        rcpt?.['Email ID'] || rcpt?.Email || rcpt?.email || ''
      ).trim().toLowerCase();
      if (!recipientEmail) return null;
      const employeeCode = String(rcpt?.['Employee Code'] || '').trim();
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
      return {
        type: 'custom-broadcast',
        recipientEmail,
        recipientCode: employeeCode || null,
        payload: { organizationName: org?.name || 'Your organization' },
        subjectOverride: resolveTokens(template.subject, tokens),
        htmlOverride: renderThemedEmailHtml({
          theme,
          subject: template.subject,
          body: template.body,
          orgName: org?.name || '',
          tokens,
          loginUrl,
        }),
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
