export type RenderedEmail = { subject: string; html: string; text: string };

function esc(v: unknown): string {
  return String(v ?? '')
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

function layout(title: string, bodyHtml: string): string {
  return `<div style="font-family:system-ui,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#0f172a">`
    + `<div style="font-size:12px;font-weight:700;letter-spacing:.08em;color:#2563eb;text-transform:uppercase">PMS</div>`
    + `<h1 style="font-size:22px;margin:8px 0 16px">${esc(title)}</h1>${bodyHtml}</div>`;
}

export function renderEmail(
  templateKey: string,
  payload: Record<string, unknown>,
  fallbackSubject = 'Notification',
): RenderedEmail {
  const org = esc(payload.orgName ?? 'your organization');
  const cycle = esc(payload.cycleName ?? 'the current cycle');
  switch (templateKey) {
    case 'invite': {
      const link = esc(payload.actionLink ?? '');
      const subject = 'You have been invited to the appraisal system';
      const html = layout('You have been invited', link
        ? `<p>${org} has invited you. Set your password to get started:</p><p><a href="${link}">Set your password</a></p><p style="color:#64748b;font-size:13px">If the link doesn't work, paste this into your browser:<br>${link}</p>`
        : `<p>${org} has invited you to the appraisal system. Please contact HR for your sign-in link.</p>`);
      const text = link ? `You have been invited by ${payload.orgName ?? 'your organization'}. Set your password: ${payload.actionLink}` : `You have been invited by ${payload.orgName ?? 'your organization'}.`;
      return { subject, html, text };
    }
    case 'publish': {
      const subject = 'Your appraisal results are published';
      const html = layout('Results published', `<p>Your appraisal results for <strong>${cycle}</strong> at ${org} are now available. Sign in to review them.</p>`);
      const text = `Your appraisal results for ${payload.cycleName ?? 'the current cycle'} are now available. Sign in to review them.`;
      return { subject, html, text };
    }
    case 'reminder': {
      const stage = esc(payload.stage ?? 'your appraisal task');
      const subject = `Reminder: ${String(payload.stage ?? 'appraisal task')}`;
      const html = layout('Reminder', `<p>This is a reminder to complete <strong>${stage}</strong> for ${cycle}.</p>`);
      const text = `Reminder: please complete ${payload.stage ?? 'your appraisal task'} for ${payload.cycleName ?? 'the current cycle'}.`;
      return { subject, html, text };
    }
    default: {
      const subject = esc(payload.subject ?? fallbackSubject);
      const bodyText = String(payload.body ?? payload.message ?? '');
      const html = layout(String(payload.subject ?? fallbackSubject), `<p>${esc(bodyText)}</p>`);
      return { subject: String(payload.subject ?? fallbackSubject), html, text: bodyText || String(payload.subject ?? fallbackSubject) };
    }
  }
}
