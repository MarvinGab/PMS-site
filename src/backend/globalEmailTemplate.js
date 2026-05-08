// Global, super-admin-owned email templates (currently just the org-admin invite).
// Saved in localStorage so Communications uses one source of truth for preview
// and manual sends.

const KEY = 'zarohr_global_email_templates_v1';

const DEFAULT_THEME = {
  brand:        '#4F46E5',
  ctaLabel:     'Open workspace',
  footerText:   '',
  showFooter:   true,
  showZaroBadge: true,
  logo:         null,
  brandName:    'Zaro HR',
  logoDisplay:  'text',
  logoPosition: 'header-left',
  logoSize:     'medium',
  buttonStyle:  'solid',
  buttonAlign:  'left',
};

export const DEFAULT_BLOCKS = {
  header: {
    brandName:   'Zaro HR',
    logo:        null,
    display:     'text',          // text | logo | both
    alignment:   'left',          // left | center | right
    accentColor: '#4F46E5',
    background:  'tint',          // plain | tint | gradient
  },
  bodyStyle: {
    background: 'plain',           // plain | color | gradient | image
    color:      '#ffffff',
    image:      null,
    gradientTo: '#F1F5F9',
  },
  greeting: {
    text:  'Your {organization_name} workspace is ready',
    color: '#111827',
    align: 'left',
    size:  'large',                // small | medium | large
  },
  body: [
    {
      id:    'b1',
      text:  'Hi {first_name}, your Zaro HR admin workspace has been provisioned and is ready to open.',
      color: '#111827',
      align: 'left',
    },
  ],
  credentials: { enabled: true },
  button: {
    label: 'Open workspace',
    color: '#4F46E5',
    style: 'solid',                // solid | outline | pill | ghost
    align: 'left',
    link:  '{login_url}',
  },
  signature: {
    enabled: false,
    image:   null,
    name:    '',
    title:   '',
  },
  footer: {
    show:      true,
    text:      'Zaro HR, Product Communications',
    showBadge: true,
  },
};

const DEFAULT_TEMPLATES = {
  'admin-invite': {
    subject: 'Your {organization_name} workspace is ready',
    body: `Hi {employee_name},\n\nYour Zaro HR admin workspace for {organization_name} is ready.\n\nLogin email: {recipient_email}\nTemporary password: {temporary_password}\n\nSign in, change your temporary password, and invite your team.\n\nWarm regards,\nZaro HR`,
    blocks: DEFAULT_BLOCKS,
  },
};

function mergeBlocks(saved) {
  // Deep-merge persisted blocks onto defaults so new fields show up cleanly.
  if (!saved || typeof saved !== 'object') return DEFAULT_BLOCKS;
  return {
    header:      { ...DEFAULT_BLOCKS.header,      ...(saved.header || {}) },
    bodyStyle:   { ...DEFAULT_BLOCKS.bodyStyle,   ...(saved.bodyStyle || {}) },
    greeting:    { ...DEFAULT_BLOCKS.greeting,    ...(saved.greeting || {}) },
    body:        Array.isArray(saved.body) && saved.body.length > 0 ? saved.body : DEFAULT_BLOCKS.body,
    credentials: { ...DEFAULT_BLOCKS.credentials, ...(saved.credentials || {}) },
    button:      { ...DEFAULT_BLOCKS.button,      ...(saved.button || {}) },
    signature:   { ...DEFAULT_BLOCKS.signature,   ...(saved.signature || {}) },
    footer:      { ...DEFAULT_BLOCKS.footer,      ...(saved.footer || {}) },
  };
}

export function loadGlobalEmailTemplates() {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(KEY) : null;
    if (!raw) return { theme: DEFAULT_THEME, templates: DEFAULT_TEMPLATES };
    const parsed = JSON.parse(raw);
    const savedTemplates = parsed?.templates || {};
    const mergedTemplates = {};
    Object.keys({ ...DEFAULT_TEMPLATES, ...savedTemplates }).forEach((key) => {
      const def = DEFAULT_TEMPLATES[key] || {};
      const sav = savedTemplates[key] || {};
      mergedTemplates[key] = {
        ...def,
        ...sav,
        blocks: mergeBlocks(sav.blocks || def.blocks),
      };
    });
    return {
      theme:     { ...DEFAULT_THEME, ...(parsed?.theme || {}) },
      templates: mergedTemplates,
    };
  } catch {
    return { theme: DEFAULT_THEME, templates: DEFAULT_TEMPLATES };
  }
}

export function saveGlobalEmailTemplates(data) {
  try {
    localStorage.setItem(KEY, JSON.stringify(data || {}));
  } catch { /* ignore quota */ }
}

export function getAdminInviteTemplate() {
  const { templates } = loadGlobalEmailTemplates();
  return templates['admin-invite'] || DEFAULT_TEMPLATES['admin-invite'];
}

export function getGlobalTheme() {
  const { theme } = loadGlobalEmailTemplates();
  return theme;
}
