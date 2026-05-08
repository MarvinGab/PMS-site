// Renders the email-design preview to email-safe inline-styled HTML.
// Used by Communications to ship a themed email. The resulting HTML is passed
// to the Edge Function as `htmlOverride`.

const DEFAULT_BRAND = '#4F46E5';

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function withAlpha(hex, alpha) {
  const m = /^#?([a-fA-F0-9]{6})$/.exec(String(hex || ''));
  if (!m) return hex;
  const r = parseInt(m[1].slice(0, 2), 16);
  const g = parseInt(m[1].slice(2, 4), 16);
  const b = parseInt(m[1].slice(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

function darkenHex(hex, pct = 0.22) {
  const m = /^#?([a-fA-F0-9]{6})$/.exec(String(hex || ''));
  if (!m) return hex;
  const clamp = (v) => Math.max(0, Math.min(255, Math.round(v)));
  const r = clamp(parseInt(m[1].slice(0, 2), 16) * (1 - pct));
  const g = clamp(parseInt(m[1].slice(2, 4), 16) * (1 - pct));
  const b = clamp(parseInt(m[1].slice(4, 6), 16) * (1 - pct));
  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
}

export function resolveTokens(text, tokens = {}) {
  return String(text || '').replace(/\{([a-z0-9_]+)\}/gi, (_m, key) => {
    const v = tokens[String(key).trim().toLowerCase()];
    return v != null ? String(v) : `{${key}}`;
  });
}

// Resolve {tokens} inside HTML, escaping each token value to prevent injection.
// The surrounding HTML structure (which came from a sanitizer) is preserved.
export function resolveTokensInHtml(html, tokens = {}) {
  return String(html || '').replace(/\{([a-z0-9_]+)\}/gi, (_m, key) => {
    const v = tokens[String(key).trim().toLowerCase()];
    return v != null ? escapeHtml(String(v)) : `{${key}}`;
  });
}

function firstName(value) {
  return String(value || '').trim().split(/\s+/).filter(Boolean)[0] || 'there';
}

function currentYear() {
  return new Date().getFullYear();
}

export function renderAdminInviteEmailHtml({
  companyName = '',
  firstName: firstNameValue = '',
  loginEmail = '',
  tempPassword = '',
  workspaceUrl = '',
  supportEmail = 'support@zarohr.com',
  theme = {},
  blocks = null,
} = {}) {
  // New block-model path — used by the WYSIWYG designer. When blocks are
  // present they fully describe the email; the legacy `theme` path below is a
  // fallback for existing saved theme-only templates.
  if (blocks) {
    return renderBlocksToHtml({
      blocks,
      tokens: {
        organization_name: companyName || 'your company',
        company:           companyName || 'your company',
        first_name:        firstNameValue || 'there',
        recipient_email:   loginEmail || '',
        temporary_password: tempPassword || '',
        login_email:       loginEmail || '',
        workspace_url:     workspaceUrl || '',
        login_url:         workspaceUrl || '',
        support_email:     supportEmail || '',
        year:              String(currentYear()),
      },
      supportEmail,
    });
  }
  const company = companyName || 'your company';
  const greetingName = firstNameValue || 'there';
  const password = tempPassword || 'Use the temporary password assigned in setup';
  const workspace = workspaceUrl || 'https://zarohr.com';
  const support = supportEmail || 'support@zarohr.com';
  const preheader = `Your ${company} Zaro HR workspace is ready. Sign in, change your password, and invite your team.`;
  const addressLine = 'Zaro HR, Product Communications';
  const year = currentYear();

  // Theme-derived values: brand color, optional logo, button style/label/align,
  // footer toggles. The structured layout (credentials block, "what happens next")
  // stays fixed so the transactional content reads consistently — only branding
  // chrome is configurable.
  const brand = theme.brand || '#4f46e5';
  const brandDark = darkenHex(brand, 0.22);
  const ctaLabel = theme.ctaLabel || 'Open workspace';
  const buttonAlign = theme.buttonAlign === 'center' ? 'center' : theme.buttonAlign === 'right' ? 'right' : 'left';
  const buttonStyle = theme.buttonStyle || 'solid';
  const showFooter = theme.showFooter !== false;
  const showZaroBadge = theme.showZaroBadge !== false;
  const logoSrc = theme.logo || '';
  const brandName = String(theme.brandName || 'Zaro HR').trim() || 'Zaro HR';
  const brandNameParts = brandName.split(/\s+/);
  const lastBrandWord = brandNameParts.length > 1 ? brandNameParts.pop() : '';
  const firstBrandWords = brandNameParts.join(' ') || brandName;
  const brandNameHtml = lastBrandWord
    ? `${escapeHtml(firstBrandWords)} <span style="color:${brand};">${escapeHtml(lastBrandWord)}</span>`
    : `<span style="color:${brand};">${escapeHtml(brandName)}</span>`;
  const logoPos = theme.logoPosition || 'header-left';
  const logoSize = theme.logoSize || 'medium';
  const logoH = logoSize === 'small' ? 28 : logoSize === 'large' ? 48 : 36;
  const displayMode = theme.logoDisplay || (logoSrc ? 'logo' : 'text');
  const showLogo = !!logoSrc && logoPos !== 'hide' && displayMode !== 'text';
  const showBrandText = logoPos !== 'hide' && displayMode !== 'logo';
  const logoAlign = logoPos === 'header-center' ? 'center' : logoPos === 'header-right' ? 'right' : 'left';
  const logoBackdrop = theme.logoBackdrop !== false;
  // Logo image itself stays clean in both states — no hard card around it.
  const logoStyle = `display:inline-block;height:${logoH}px;width:auto;max-width:200px;border:0;outline:none;text-decoration:none;vertical-align:middle;`;
  // The header *row* gets a subtle brand-tinted fade when "backdrop" is on, so
  // the logo reads as part of a soft brand band rather than a floating mark on
  // pure white. Off = plain white.
  const headerBg = logoBackdrop
    ? `background:linear-gradient(180deg, ${withAlpha(brand, 0.08)} 0%, #ffffff 100%);`
    : `background:#ffffff;`;
  const logoCell = showLogo
    ? `<img src="${escapeHtml(logoSrc)}" alt="${escapeHtml(brandName)}" style="${logoStyle}" />`
    : '';
  const textCell = showBrandText
    ? `<span style="display:inline-block;font-size:17px;line-height:1;font-weight:700;color:#111827;letter-spacing:0;vertical-align:middle;">${brandNameHtml}</span>`
    : '';
  const brandContentHtml = displayMode === 'both' && showLogo && showBrandText
    ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;display:inline-table;"><tr><td style="padding:0 10px 0 0;vertical-align:middle;">${logoCell}</td><td style="vertical-align:middle;">${textCell}</td></tr></table>`
    : `${logoCell}${textCell}`;

  const headerHtml = brandContentHtml
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;">
        <tr><td align="${logoAlign}" valign="middle" style="height:56px;">
          ${brandContentHtml}
        </td></tr>
      </table>`
    : `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;">
        <tr><td valign="middle" style="height:56px;"></td></tr>
      </table>`;

  // CTA — solid / outline / pill / ghost. MSO fallback only used for solid.
  let ctaInline = '';
  if (buttonStyle === 'outline') {
    ctaInline = `display:inline-block;background:#ffffff;border:2px solid ${brand};color:${brand};text-decoration:none;font-family:-apple-system,'Segoe UI',Roboto,Arial,sans-serif;font-size:16px;line-height:20px;font-weight:600;padding:12px 26px;border-radius:8px;`;
  } else if (buttonStyle === 'pill') {
    ctaInline = `display:inline-block;background:${brand};color:#ffffff;text-decoration:none;font-family:-apple-system,'Segoe UI',Roboto,Arial,sans-serif;font-size:16px;line-height:20px;font-weight:600;padding:14px 28px;border-radius:999px;`;
  } else if (buttonStyle === 'ghost') {
    ctaInline = `display:inline-block;background:transparent;color:${brand};text-decoration:underline;font-family:-apple-system,'Segoe UI',Roboto,Arial,sans-serif;font-size:16px;line-height:20px;font-weight:600;padding:6px 0;border-radius:0;`;
  } else {
    ctaInline = `display:inline-block;background:${brand};color:#ffffff;text-decoration:none;font-family:-apple-system,'Segoe UI',Roboto,Arial,sans-serif;font-size:16px;line-height:20px;font-weight:600;padding:14px 28px;border-radius:8px;`;
  }

  const customFooterText = theme.footerText ? escapeHtml(theme.footerText) : '';

  return `<!doctype html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta http-equiv="x-ua-compatible" content="ie=edge">
    <title>Your ${escapeHtml(company)} workspace is ready</title>
    <!--[if mso]>
    <xml>
      <o:OfficeDocumentSettings>
        <o:AllowPNG/>
        <o:PixelsPerInch>96</o:PixelsPerInch>
      </o:OfficeDocumentSettings>
    </xml>
    <![endif]-->
    <style>
      .preheader { display:none !important; visibility:hidden; opacity:0; color:transparent; height:0; width:0; overflow:hidden; mso-hide:all; }
      @media screen and (max-width: 600px) {
        .container { width:100% !important; }
        .px { padding-left:20px !important; padding-right:20px !important; }
        .section { padding-top:28px !important; padding-bottom:28px !important; }
        .button-wrap { text-align:left !important; }
        .button { display:block !important; width:100% !important; box-sizing:border-box !important; text-align:center !important; }
      }
    </style>
  </head>
  <body style="margin:0;padding:0;background:#ffffff;">
    <div class="preheader">${escapeHtml(preheader)}</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#ffffff;border-collapse:collapse;">
      <tr>
        <td align="center" style="padding:0;">
          <table role="presentation" class="container" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:600px;border-collapse:collapse;">
            <tr>
              <td class="px" style="height:56px;padding:0 32px;border-bottom:1px solid #e5e7eb;${headerBg}font-family:-apple-system,'Segoe UI',Roboto,Arial,sans-serif;">
                ${headerHtml}
              </td>
            </tr>
            <tr>
              <td class="px section" style="padding:36px 32px 32px;background:#ffffff;font-family:-apple-system,'Segoe UI',Roboto,Arial,sans-serif;">
                <h1 style="margin:0 0 14px;font-size:24px;line-height:1.3;font-weight:600;color:#111827;">Your ${escapeHtml(company)} workspace is ready</h1>
                <p style="margin:0;font-size:16px;line-height:1.6;color:#111827;">Hi ${escapeHtml(greetingName)}, your Zaro HR admin workspace has been provisioned and is ready to open.</p>
              </td>
            </tr>
            <tr>
              <td class="px" style="padding:0 32px 32px;background:#ffffff;font-family:-apple-system,'Segoe UI',Roboto,Arial,sans-serif;">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:separate;border-spacing:0;background:#f9fafb;border:1px solid #e5e7eb;border-radius:12px;">
                  <tr>
                    <td style="padding:22px 24px;">
                      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;">
                        <tr>
                          <td style="padding:0 0 16px;">
                            <div style="font-size:12px;line-height:1.4;font-weight:600;color:#6b7280;text-transform:uppercase;letter-spacing:.04em;">Login email</div>
                            <div style="margin-top:6px;font-family:'SFMono-Regular',Consolas,'Liberation Mono',Menlo,monospace;font-size:15px;line-height:1.5;color:#111827;word-break:break-all;">${escapeHtml(loginEmail)}</div>
                          </td>
                        </tr>
                        <tr>
                          <td style="padding:16px 0 0;border-top:1px solid #e5e7eb;">
                            <div style="font-size:12px;line-height:1.4;font-weight:600;color:#6b7280;text-transform:uppercase;letter-spacing:.04em;">Temporary password</div>
                            <div style="margin-top:6px;font-family:'SFMono-Regular',Consolas,'Liberation Mono',Menlo,monospace;font-size:15px;line-height:1.5;color:#111827;word-break:break-all;">${escapeHtml(password)}</div>
                            <div style="margin-top:10px;display:inline-block;padding:4px 9px;border:1px solid #e5e7eb;border-radius:999px;background:#ffffff;font-size:12px;line-height:1.4;color:#6b7280;">Temporary - change on first login</div>
                          </td>
                        </tr>
                      </table>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
            <tr>
              <td class="px" style="padding:0 32px 32px;background:#ffffff;font-family:-apple-system,'Segoe UI',Roboto,Arial,sans-serif;">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="button-wrap" style="border-collapse:collapse;">
                  <tr>
                    <td align="${buttonAlign}">
                      <a href="${escapeHtml(workspace)}" class="button" style="${ctaInline}">${escapeHtml(ctaLabel)}</a>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
            <tr>
              <td class="px section" style="padding:32px;background:#ffffff;border-top:1px solid #e5e7eb;font-family:-apple-system,'Segoe UI',Roboto,Arial,sans-serif;">
                <h2 style="margin:0 0 16px;font-size:16px;line-height:1.4;font-weight:600;color:#111827;">What happens next</h2>
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;">
                  <tr>
                    <td width="28" valign="top" style="font-size:16px;line-height:1.6;color:#6b7280;">1.</td>
                    <td style="font-size:16px;line-height:1.6;color:#111827;padding:0 0 10px;">Sign in to your workspace.</td>
                  </tr>
                  <tr>
                    <td width="28" valign="top" style="font-size:16px;line-height:1.6;color:#6b7280;">2.</td>
                    <td style="font-size:16px;line-height:1.6;color:#111827;padding:0 0 10px;">Change your temporary password.</td>
                  </tr>
                  <tr>
                    <td width="28" valign="top" style="font-size:16px;line-height:1.6;color:#6b7280;">3.</td>
                    <td style="font-size:16px;line-height:1.6;color:#111827;">Invite your team and finish PMS setup.</td>
                  </tr>
                </table>
                <p style="margin:24px 0 0;font-size:14px;line-height:1.6;color:#6b7280;">If you didn't expect this email, ignore it or contact <a href="mailto:${escapeHtml(support)}" style="color:${brand};text-decoration:underline;">${escapeHtml(support)}</a>.</p>
              </td>
            </tr>
            ${showFooter ? `<tr>
              <td class="px" style="padding:24px 32px 32px;background:#ffffff;border-top:1px solid #e5e7eb;font-family:-apple-system,'Segoe UI',Roboto,Arial,sans-serif;">
                ${customFooterText ? `<p style="margin:0 0 8px;font-size:12px;line-height:1.6;color:#6b7280;">${customFooterText}</p>` : `<p style="margin:0 0 8px;font-size:12px;line-height:1.6;color:#6b7280;">${escapeHtml(addressLine)}</p>`}
                <p style="margin:0 0 8px;font-size:12px;line-height:1.6;color:#6b7280;">
                  <a href="mailto:${escapeHtml(support)}" style="color:#6b7280;text-decoration:underline;">Support</a>
                </p>
                ${showZaroBadge ? `<p style="margin:0;font-size:12px;line-height:1.6;color:#6b7280;">&copy; ${year} Zaro HR. All rights reserved.</p>` : ''}
              </td>
            </tr>` : ''}
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

// Block-model renderer — driven by the WYSIWYG designer. Produces email-safe
// inline-styled HTML with the same look as the in-app preview.
function renderBlocksToHtml({ blocks, tokens, supportEmail = 'support@zarohr.com' }) {
  const resolve = (text) => resolveTokens(text, tokens);
  const h = blocks.header || {};
  const accent = h.accentColor || '#4f46e5';
  const accentDark = darkenHex(accent, 0.22);
  const headerBg = h.background === 'gradient'
    ? `background:linear-gradient(135deg, ${accent} 0%, ${accentDark} 100%);`
    : h.background === 'tint'
    ? `background:linear-gradient(180deg, ${withAlpha(accent, 0.08)} 0%, #ffffff 100%);`
    : 'background:#ffffff;';
  const fg = h.background === 'gradient' ? '#ffffff' : '#111827';
  const headerAlign = h.alignment === 'center' ? 'center' : h.alignment === 'right' ? 'right' : 'left';
  const showLogo = !!h.logo && (h.display === 'logo' || h.display === 'both');
  const showText = h.display === 'text' || h.display === 'both';
  const brandName = String(h.brandName || 'Zaro HR').trim() || 'Zaro HR';
  const parts = brandName.split(/\s+/).filter(Boolean);
  const lastWord = parts.length > 1 ? parts.pop() : '';
  const firstWords = parts.join(' ') || brandName;
  const accentForText = h.background === 'gradient' ? '#ffffff' : accent;
  const brandHtml = lastWord
    ? `${escapeHtml(firstWords)} <span style="color:${accentForText};">${escapeHtml(lastWord)}</span>`
    : `<span style="color:${accentForText};">${escapeHtml(brandName)}</span>`;
  const logoImg = showLogo
    ? `<img src="${escapeHtml(h.logo)}" alt="${escapeHtml(brandName)}" style="display:inline-block;height:36px;width:auto;max-width:200px;vertical-align:middle;border:0;" />`
    : '';
  const textSpan = showText
    ? `<span style="display:inline-block;font-size:17px;line-height:1;font-weight:700;color:${fg};vertical-align:middle;">${brandHtml}</span>`
    : '';
  const headerInner = (showLogo && showText)
    ? `${logoImg}<span style="display:inline-block;width:10px;"></span>${textSpan}`
    : `${logoImg}${textSpan}`;
  const headerHtml = `<tr><td align="${headerAlign}" style="padding:20px 28px;${headerBg}border-bottom:1px solid #e5e7eb;font-family:-apple-system,'Segoe UI',Roboto,Arial,sans-serif;">${headerInner}</td></tr>`;

  // Body background — wraps greeting/body/credentials/button/signature so a user-
  // chosen color, gradient, or image paints the canvas behind everything.
  const bs = blocks.bodyStyle || {};
  const bodyBg =
    bs.background === 'image'    && bs.image    ? `background:#ffffff url(${bs.image}) center/cover no-repeat;`
  : bs.background === 'gradient'                ? `background:linear-gradient(180deg, ${bs.color || '#ffffff'} 0%, ${bs.gradientTo || '#F1F5F9'} 100%);`
  : bs.background === 'color'                   ? `background:${bs.color || '#ffffff'};`
  :                                                'background:#ffffff;';

  // Greeting
  const g = blocks.greeting || {};
  const gSize = g.size === 'small' ? 18 : g.size === 'medium' ? 22 : 26;
  const greetingHtml = g.text
    ? `<tr><td style="padding:30px 32px 6px;font-family:-apple-system,'Segoe UI',Roboto,Arial,sans-serif;">
        <div style="margin:0;font-size:${gSize}px;line-height:1.3;font-weight:700;color:${g.color || '#111827'};text-align:${g.align || 'left'};">${escapeHtml(resolve(g.text))}</div>
      </td></tr>`
    : '';

  // Body paragraphs — `p.text` is already sanitized rich HTML from the designer
  // (only b/i/u/span[style="color:..."] survive). We resolve {tokens} inside
  // the HTML; token values themselves are escaped to prevent injection.
  const bodyHtml = (blocks.body || []).map((p) => {
    const html = resolveTokensInHtml(p.text || '', tokens).replace(/\r\n|\r|\n/g, '<br />');
    return `<tr><td style="padding:8px 32px;font-family:-apple-system,'Segoe UI',Roboto,Arial,sans-serif;">
      <p style="margin:0;font-size:15px;line-height:1.6;color:${p.color || '#111827'};text-align:${p.align || 'left'};">${html}</p>
    </td></tr>`;
  }).join('');

  // Credentials
  const credentialsEnabled = blocks.credentials?.enabled !== false;
  const credentialsHtml = credentialsEnabled
    ? `<tr><td style="padding:18px 32px 0;font-family:-apple-system,'Segoe UI',Roboto,Arial,sans-serif;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:separate;background:#f9fafb;border:1px solid #e5e7eb;border-radius:12px;">
          <tr><td style="padding:18px 20px;">
            <div style="font-size:11.5px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:#6b7280;margin-bottom:4px;">Login email</div>
            <div style="font-family:'SFMono-Regular',Consolas,Menlo,monospace;font-size:14px;color:#111827;word-break:break-all;">${escapeHtml(tokens.recipient_email || '')}</div>
            <div style="border-top:1px solid #e5e7eb;margin:14px 0 0;padding-top:14px;">
              <div style="font-size:11.5px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:#6b7280;margin-bottom:4px;">Temporary password</div>
              <div style="font-family:'SFMono-Regular',Consolas,Menlo,monospace;font-size:14px;color:#111827;">${escapeHtml(tokens.temporary_password || '')}</div>
              <div style="display:inline-block;margin-top:8px;padding:2px 8px;font-size:11px;color:#6b7280;border:1px solid #e5e7eb;border-radius:999px;background:#ffffff;">Temporary - change on first login</div>
            </div>
          </td></tr>
        </table>
      </td></tr>`
    : '';

  // Button
  const btn = blocks.button || {};
  const btnLabel = btn.label || 'Open workspace';
  const btnLink  = resolve(btn.link || tokens.login_url || '#');
  const btnAlign = btn.align === 'center' ? 'center' : btn.align === 'right' ? 'right' : 'left';
  const btnStyle = btn.style || 'solid';
  const btnColor = btn.color || accent;
  let btnInline = '';
  if (btnStyle === 'outline') btnInline = `display:inline-block;background:#ffffff;border:2px solid ${btnColor};color:${btnColor};text-decoration:none;font-size:16px;line-height:20px;font-weight:600;padding:12px 26px;border-radius:8px;`;
  else if (btnStyle === 'pill') btnInline = `display:inline-block;background:${btnColor};color:#ffffff;text-decoration:none;font-size:16px;line-height:20px;font-weight:600;padding:14px 28px;border-radius:999px;`;
  else if (btnStyle === 'ghost') btnInline = `display:inline-block;background:transparent;color:${btnColor};text-decoration:underline;font-size:16px;line-height:20px;font-weight:600;padding:6px 0;`;
  else btnInline = `display:inline-block;background:${btnColor};color:#ffffff;text-decoration:none;font-size:16px;line-height:20px;font-weight:600;padding:14px 28px;border-radius:8px;`;
  const buttonHtml = `<tr><td align="${btnAlign}" style="padding:20px 32px 28px;font-family:-apple-system,'Segoe UI',Roboto,Arial,sans-serif;">
      <a href="${escapeHtml(btnLink)}" style="${btnInline}">${escapeHtml(btnLabel)}</a>
    </td></tr>`;

  // Signature
  const sig = blocks.signature || {};
  const signatureHtml = sig.enabled
    ? `<tr><td style="padding:0 32px 22px;border-top:1px solid #e5e7eb;font-family:-apple-system,'Segoe UI',Roboto,Arial,sans-serif;">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin-top:14px;">
          <tr>
            ${sig.image ? `<td style="padding:0 12px 0 0;vertical-align:middle;"><img src="${escapeHtml(sig.image)}" alt="" style="width:44px;height:44px;border-radius:50%;border:0;display:block;object-fit:cover;" /></td>` : ''}
            <td style="vertical-align:middle;">
              <div style="font-size:13px;font-weight:700;color:#111827;">${escapeHtml(sig.name || '')}</div>
              ${sig.title ? `<div style="font-size:12.5px;color:#6b7280;margin-top:2px;">${escapeHtml(sig.title)}</div>` : ''}
            </td>
          </tr>
        </table>
      </td></tr>`
    : '';

  // Footer
  const f = blocks.footer || {};
  const footerHtml = f.show !== false
    ? `<tr><td style="padding:18px 32px 24px;border-top:1px solid #e5e7eb;font-family:-apple-system,'Segoe UI',Roboto,Arial,sans-serif;font-size:12px;line-height:1.6;color:#6b7280;">
        ${f.text ? `<div>${escapeHtml(f.text)}</div>` : ''}
        <div style="margin-top:6px;"><a href="mailto:${escapeHtml(supportEmail)}" style="color:#6b7280;text-decoration:underline;">Support</a></div>
        ${f.showBadge !== false ? `<div style="margin-top:6px;">&copy; ${tokens.year || currentYear()} Zaro HR. All rights reserved.</div>` : ''}
      </td></tr>`
    : '';

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(resolve(blocks.greeting?.text || 'Email'))}</title>
</head>
<body style="margin:0;padding:0;background:#f1f5f9;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f1f5f9;border-collapse:collapse;">
    <tr><td align="center" style="padding:24px 12px;">
      <table role="presentation" width="640" cellpadding="0" cellspacing="0" border="0" style="width:640px;max-width:640px;background:#ffffff;border:1px solid #e5e7eb;border-radius:14px;overflow:hidden;border-collapse:collapse;">
        ${headerHtml}
        <tr><td style="${bodyBg}padding:0;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;">
          ${greetingHtml}
          ${bodyHtml}
          ${credentialsHtml}
          ${buttonHtml}
          ${signatureHtml}
        </table></td></tr>
        ${footerHtml}
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

export function renderAdminInviteEmailText({
  companyName = '',
  firstName: firstNameValue = '',
  loginEmail = '',
  tempPassword = '',
  workspaceUrl = '',
  supportEmail = 'support@zarohr.com',
} = {}) {
  const company = companyName || 'your company';
  return [
    `Hi ${firstNameValue || 'there'},`,
    '',
    `Your ${company} Zaro HR workspace is ready.`,
    '',
    `Login email: ${loginEmail}`,
    `Temporary password: ${tempPassword || 'Use the temporary password assigned in setup'}`,
    workspaceUrl ? `Workspace: ${workspaceUrl}` : '',
    '',
    'What happens next:',
    '1. Sign in to your workspace.',
    '2. Change your temporary password.',
    '3. Invite your team and finish PMS setup.',
    '',
    `If you didn't expect this email, ignore it or contact ${supportEmail || 'support@zarohr.com'}.`,
  ].filter(Boolean).join('\n');
}

function bodyToHtml(body) {
  // Mirror the email-body rendering used in the React preview: paragraphs separated
  // by blank lines, line breaks within paragraphs preserved.
  return String(body || '')
    .split(/\n{2,}/)
    .map((para) => {
      const escaped = escapeHtml(para).replace(/\n/g, '<br />');
      return `<p style="margin:0 0 14px;font-size:15px;line-height:1.7;color:#1E293B;">${escaped}</p>`;
    })
    .join('');
}

function buildCtaHtml(theme, brand, brandDark, loginUrl) {
  const label = theme.ctaLabel || '';
  if (!label) return '';
  if (!loginUrl) return '';
  const align = theme.buttonAlign === 'center' ? 'center' : theme.buttonAlign === 'right' ? 'right' : 'left';
  const style = theme.buttonStyle || 'solid';
  let inner = '';
  if (style === 'outline') {
    inner = `border:2px solid ${brand};color:${brand};background:#fff;border-radius:10px;padding:11px 22px;`;
  } else if (style === 'pill') {
    inner = `background:linear-gradient(135deg,${brand} 0%,${brandDark} 100%);color:#fff;border-radius:999px;padding:11px 22px;`;
  } else if (style === 'ghost') {
    inner = `color:${brand};text-decoration:underline;padding:4px 0;`;
  } else {
    inner = `background:linear-gradient(135deg,${brand} 0%,${brandDark} 100%);color:#fff;border-radius:10px;padding:11px 22px;`;
  }
  return `
    <div style="margin:8px 0 24px;text-align:${align};">
      <a href="${escapeHtml(loginUrl)}" style="display:inline-block;font-family:Arial,Helvetica,sans-serif;font-size:13.5px;font-weight:700;text-decoration:none;${inner}">${escapeHtml(label)}</a>
    </div>
  `;
}

function buildHeaderHtml(theme, brand, brandDark, headlineText, headerLabelText) {
  const showLabel = !!String(headerLabelText || '').trim();
  const showHeadline = !!String(headlineText || '').trim();
  const logoPos = theme?.logoPosition || 'header-left';
  const logoSize = theme?.logoSize || 'medium';
  const logoH = logoSize === 'small' ? 26 : logoSize === 'large' ? 48 : 36;
  const showLogo = !!theme?.logo && logoPos !== 'hide';
  const justify = logoPos === 'header-center' ? 'center' : logoPos === 'header-right' ? 'right' : 'left';
  if (!showLabel && !showHeadline && !showLogo) {
    return `<div style="background:linear-gradient(135deg,${brand} 0%,${brandDark} 100%);height:24px;"></div>`;
  }
  const logoHtml = showLogo
    ? `<div style="text-align:${justify};margin-bottom:12px;">
        <img src="${escapeHtml(theme.logo)}" alt="" style="display:inline-block;height:${logoH}px;width:auto;max-width:200px;border-radius:6px;background:rgba(255,255,255,0.95);padding:4px;" />
      </div>`
    : '';
  return `
    <div style="background:linear-gradient(135deg,${brand} 0%,${brandDark} 100%);padding:22px 24px;color:#ffffff;">
      ${logoHtml}
      ${showLabel ? `<div style="font-size:11.5px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;opacity:.78;margin-bottom:6px;">${escapeHtml(headerLabelText)}</div>` : ''}
      ${showHeadline ? `<div style="font-size:22px;line-height:1.3;font-weight:800;">${escapeHtml(headlineText)}</div>` : ''}
    </div>
  `;
}

function buildFooterHtml(theme, orgName, hrAdminName) {
  if (theme?.showFooter === false) return '';
  const text = theme?.footerText || '';
  const showBadge = theme?.showZaroBadge !== false;
  if (!text && !showBadge) return '';
  return `
    <div style="border-top:1px solid #F1F5F9;background:#FAFBFF;padding:12px 26px;font-size:11px;color:#94A3B8;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
        <td align="left" style="font-size:11px;color:#94A3B8;">${escapeHtml(text)}</td>
        ${showBadge ? `<td align="right" style="font-size:11px;color:#94A3B8;">Powered by Zaro HR</td>` : ''}
      </tr></table>
    </div>
  `;
}

// Build a complete inline-styled HTML email from the theme + subject/body.
// `tokens` is a map for {placeholder} replacement (employee_name, employee_code, password, etc.)
// `extras` lets callers inject extra rendered blocks (e.g. credentials block, reportee list)
// before the body.
export function renderThemedEmailHtml({
  theme = {},
  subject = '',
  body = '',
  orgName = '',
  hrAdminName = '',
  tokens = {},
  loginUrl = '',
  extrasHtml = '',
} = {}) {
  const brand = theme.brand || DEFAULT_BRAND;
  const brandDark = darkenHex(brand, 0.22);
  const resolvedSubject = resolveTokens(subject, tokens);
  const headerLabel = orgName || '';
  const resolvedBody = resolveTokens(body, tokens);

  const headerHtml = buildHeaderHtml(theme, brand, brandDark, resolvedSubject, headerLabel);
  const ctaHtml = buildCtaHtml(theme, brand, brandDark, loginUrl);
  const footerHtml = buildFooterHtml(theme, orgName, hrAdminName);

  // Guarantee every email has a clickable link back to the workspace. If the
  // CTA button is suppressed (label cleared) and the body doesn't already
  // contain the login URL, append a subtle text link.
  const fallbackLinkHtml = (!ctaHtml && loginUrl && !String(resolvedBody).includes(loginUrl))
    ? `<div style="padding:0 26px 18px;font-size:12.5px;line-height:1.6;color:#475569;">Open your workspace: <a href="${loginUrl}" style="color:${brand};text-decoration:underline;">${loginUrl}</a></div>`
    : '';

  return `
    <div style="margin:0;padding:24px;background:#F1F5F9;font-family:Arial,Helvetica,sans-serif;color:#0F172A;">
      <div style="max-width:640px;margin:0 auto;background:#ffffff;border:1px solid #E2E8F0;border-radius:14px;overflow:hidden;position:relative;box-shadow:0 10px 30px ${withAlpha('#0f172a', 0.06)};">
        ${headerHtml}
        <div style="padding:22px 26px 8px;font-size:13.5px;line-height:1.7;color:#1E293B;">
          ${bodyToHtml(resolvedBody)}
          ${extrasHtml || ''}
        </div>
        ${ctaHtml}
        ${fallbackLinkHtml}
        ${footerHtml}
      </div>
    </div>
  `;
}

export function renderThemedEmailText({ subject = '', body = '', tokens = {} } = {}) {
  const lines = [
    resolveTokens(subject, tokens),
    '',
    resolveTokens(body, tokens),
  ];
  return lines.filter((s) => s !== undefined).join('\n');
}
