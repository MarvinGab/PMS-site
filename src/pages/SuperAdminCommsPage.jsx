import { useState, useMemo, useEffect, useRef } from 'react';
import { useApp } from '../AppContext';
import AdminShell from '../components/AdminShell';
import { sendHrAdminInviteEmail } from '../backend/emailService';
import zaroLogo from '../../images/final zaro logo.png';
import { shouldUseSupabase } from '../backend/config';
import { supabase } from '../backend/supabaseClient';
import { uploadEmailLogoAsset, ensureDefaultZaroLogoUrl, isPublicBrandAssetUrl } from '../backend/brandAssetStorage';
import { readSuperCommsStateSync, hydrateSuperCommsState, persistSuperCommsState } from '../backend/stateStore';
import { buildWorkspaceUrl } from '../orgUtils';

// ─── Constants (mirrored from HR-side ModuleComms) ───────────────────────
const COMMS_CHANNELS = [
  {
    id: 'email', label: 'Email', ready: true,
    accent: '#4F46E5', accentBg: '#EEF2FF', accentBorder: '#C7D2FE',
    icon: (<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2.5" y="5" width="19" height="14" rx="2.2"/><path d="m3.5 7 8.5 6.2L20.5 7"/></svg>),
  },
  {
    id: 'sms', label: 'SMS', ready: false,
    accent: '#0891B2', accentBg: '#ECFEFF', accentBorder: '#A5F3FC',
    icon: (<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>),
  },
  {
    id: 'whatsapp', label: 'WhatsApp', ready: false,
    accent: '#16A34A', accentBg: '#F0FDF4', accentBorder: '#BBF7D0',
    icon: (<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 22a10 10 0 1 0-8.66-5.01L2 22l5.2-1.38A10 10 0 0 0 12 22z"/></svg>),
  },
];

const COMMS_TOKENS = [
  { key: '{organization_name}', label: 'Company' },
  { key: '{admin_name}',        label: 'Admin name' },
  { key: '{first_name}',        label: 'First name' },
  { key: '{recipient_email}',   label: 'Email' },
  { key: '{temporary_password}', label: 'Password' },
  { key: '{login_url}',         label: 'Workspace link' },
];

const COMMS_THEME_PRESETS = [
  { id: 'indigo',   label: 'Indigo',   brand: '#4F46E5' },
  { id: 'ocean',    label: 'Ocean',    brand: '#0EA5E9' },
  { id: 'emerald',  label: 'Emerald',  brand: '#16A34A' },
  { id: 'sunset',   label: 'Sunset',   brand: '#EA580C' },
  { id: 'plum',     label: 'Plum',     brand: '#7C3AED' },
  { id: 'graphite', label: 'Graphite', brand: '#0F172A' },
];

const DEFAULT_EMAIL_THEME = {
  brand:         COMMS_THEME_PRESETS[0].brand,
  ctaLabel:      'Open workspace',
  footerText:    'Zaro HR, Product Communications',
  showFooter:    true,
  showZaroBadge: true,
  logo:          null,
  logoPosition:  'header-left',
  logoSize:      'medium',
  buttonStyle:   'solid',
  buttonAlign:   'left',
  // SuperAdmin's preview header shows only the subject — explicitly suppress
  // the uppercase org-name label so the sent email matches.
  headerLabel:   '',
};

const LOGO_POSITIONS = [
  { id: 'header-left',   label: 'Left' },
  { id: 'header-center', label: 'Center' },
  { id: 'header-right',  label: 'Right' },
  { id: 'hide',          label: 'Hide' },
];
const LOGO_SIZES = ['small', 'medium', 'large'];
const BUTTON_STYLES = [
  { id: 'solid',   label: 'Solid' },
  { id: 'outline', label: 'Outline' },
  { id: 'pill',    label: 'Pill' },
  { id: 'ghost',   label: 'Text link' },
];

const DEFAULT_TEMPLATES = {
  'admin-invite': {
    name: 'Admin invite',
    desc: 'Sent when a workspace is provisioned',
    subject: 'Your {organization_name} workspace is ready',
    body:
      'Hi {first_name},\n\n' +
      'Your Zaro HR admin workspace for {organization_name} has been provisioned and is ready to open.\n\n' +
      'Login email : {recipient_email}\n' +
      'Password    : {temporary_password}\n\n' +
      'After signing in, change your temporary password and invite your team.\n\n' +
      'Warm regards,\nThe Zaro HR Team',
  },
};

// ─── Helpers ─────────────────────────────────────────────────────────────
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
async function uploadLogoToStorage(file) {
  return uploadEmailLogoAsset(file, { orgKey: 'super-admin' });
}
function formatRelativeDate(iso) {
  if (!iso) return '';
  const t = Date.parse(iso); if (Number.isNaN(t)) return '';
  const d = Date.now() - t; const day = 86400000;
  if (d < 60000) return 'just now';
  if (d < 3600000) return `${Math.round(d / 60000)}m ago`;
  if (d < day) return `${Math.round(d / 3600000)}h ago`;
  if (d < 30 * day) return `${Math.round(d / day)}d ago`;
  return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

// React-rendered email body — same logic as HR-side renderEmailBody.
function renderEmailBody(text, theme) {
  const paragraphs = String(text || '').split(/\n\s*\n/);
  const keyValRe = /^\s*([A-Za-z][A-Za-z\s]{0,30}?)\s*:\s*(.+?)\s*$/;
  return paragraphs.map((para, pi) => {
    const lines = para.split('\n');
    const isKvBlock = lines.length >= 2 && lines.every((l) => keyValRe.test(l));
    if (isKvBlock) {
      return (
        <div key={pi} style={{ background: theme.credBg, border: `1px solid ${theme.credBorder}`, borderRadius: 10, padding: '12px 16px', margin: '6px 0 14px' }}>
          {lines.map((l, i) => {
            const [, k, v] = l.match(keyValRe);
            return (
              <div key={i} style={{ display: 'flex', justifyContent: 'space-between', gap: 12, padding: '3px 0', fontSize: 13 }}>
                <span style={{ color: '#64748B', fontWeight: 600 }}>{k.trim()}</span>
                <span style={{ color: theme.accent, fontWeight: 700, fontFamily: "'Geist Mono','SF Mono',Menlo,monospace" }}>{v.trim()}</span>
              </div>
            );
          })}
        </div>
      );
    }
    const looksLikeSignature = pi === paragraphs.length - 1 && /regards|sincerely|thanks/i.test(lines[0] || '');
    return (
      <p key={pi} style={{ margin: '0 0 14px', color: looksLikeSignature ? '#64748B' : '#1E293B', whiteSpace: 'pre-wrap' }}>
        {para}
      </p>
    );
  });
}

function PreviewHotspot({ label, onClick, children, inline = false }) {
  const [hovered, setHovered] = useState(false);
  return (
    <div onClick={onClick} onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}
      style={{
        position: 'relative', display: inline ? 'inline-block' : 'block', cursor: 'pointer',
        outline: hovered ? '2px solid rgba(79,70,229,0.45)' : '2px solid transparent', outlineOffset: -2,
        borderRadius: inline ? 8 : 0, transition: 'outline-color 160ms ease',
      }}>
      {children}
      {hovered && (
        <div style={{ position: 'absolute', top: 6, right: 6, padding: '3px 8px', borderRadius: 999, background: '#4F46E5', color: '#fff', fontSize: 10, fontWeight: 700, boxShadow: '0 4px 10px rgba(79,70,229,.35)', pointerEvents: 'none', display: 'inline-flex', alignItems: 'center', gap: 4, zIndex: 2 }}>
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/></svg>
          {label}
        </div>
      )}
    </div>
  );
}

// loadSaved reads the localStorage cache synchronously for first paint.
// hydrateSuperCommsState (called in a useEffect below) then overwrites with
// the authoritative Supabase row so the same templates show up on any
// browser the Super Admin signs into.
function loadSaved() { return readSuperCommsStateSync(); }
function saveState(state) { persistSuperCommsState(state); }

function themeForOrg(theme, org) {
  const orgLogo = String(org?.brandEmailLogo || org?.brandLogo || org?.brandLogoUrl || '').trim();
  const themeLogo = String(theme?.logo || '').trim();
  // The user's explicit choice always wins. `logoCleared` → render no logo;
  // any non-empty themeLogo (including the platform Zaro asset) → use it as-is;
  // only when the user hasn't picked anything do we fall back to the org's
  // brand logo. The previous "isDefaultPlatformLogo" heuristic silently
  // overrode legitimate Zaro selections with the org's logo — gone.
  const userCleared = theme?.logoCleared === true;
  const logo = userCleared ? null : (themeLogo || orgLogo || null);
  return {
    ...theme,
    brandName: theme?.brandName || org?.brandName || org?.name || 'Zaro HR',
    logo,
  };
}

export default function SuperAdminCommsPage() {
  const { orgs } = useApp();

  const [activeTab, setActiveTab]           = useState('email');
  const [stepTab, setStepTab]               = useState('compose');
  const [activeTemplate, setActiveTemplate] = useState('admin-invite');
  // null = not naming; string = the in-progress name in the inline input that
  // appears when the user clicks "+ Add to Template".
  const [draftTemplateName, setDraftTemplateName] = useState(null);
  const draftTemplateInputRef = useRef(null);
  // null = not confirming; key string = the template the delete button is
  // waiting for a second click on. Auto-reverts via a timer.
  const [pendingDeleteKey, setPendingDeleteKey] = useState(null);
  const pendingDeleteTimerRef = useRef(null);
  const [templates, setTemplates] = useState(() => {
    const saved = loadSaved();
    return saved?.templates || DEFAULT_TEMPLATES;
  });
  const [emailTheme, setEmailTheme] = useState(() => {
    const saved = loadSaved();
    return { ...DEFAULT_EMAIL_THEME, logo: null, ...(saved?.theme || {}) };
  });

  // Lazy-resolve the default Zaro logo to a public Storage URL on first mount.
  // Also self-heals stale saved logos (data: / blob: / localhost / Vite asset
  // paths) so previously-saved themes don't keep sending broken images.
  useEffect(() => {
    let cancelled = false;
    if (isPublicBrandAssetUrl(emailTheme.logo)) return undefined;
    (async () => {
      try {
        const url = await ensureDefaultZaroLogoUrl(zaroLogo);
        if (!cancelled) setEmailTheme((prev) => (isPublicBrandAssetUrl(prev.logo) ? prev : { ...prev, logo: url }));
      } catch { /* ignore — preview just renders without logo */ }
    })();
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Pull the authoritative templates + theme from Supabase on mount so the
  // Super Admin sees the same library on any browser. localStorage above
  // gave us a sync first-paint; this overrides it once the network reply
  // lands. We skip overwrite when local state has diverged (user typed
  // something since mount) to avoid clobbering unsaved edits.
  const supabaseHydratedRef = useRef(false);
  useEffect(() => {
    if (supabaseHydratedRef.current) return;
    let cancelled = false;
    const baselineTemplates = loadSaved()?.templates || DEFAULT_TEMPLATES;
    (async () => {
      const remote = await hydrateSuperCommsState();
      if (cancelled || !remote) return;
      supabaseHydratedRef.current = true;
      if (remote.templates && typeof remote.templates === 'object') {
        setTemplates((current) => {
          const isUntouched = JSON.stringify(current) === JSON.stringify(baselineTemplates);
          return isUntouched ? remote.templates : current;
        });
      }
      if (remote.theme && typeof remote.theme === 'object') {
        setEmailTheme((current) => ({ ...current, ...remote.theme }));
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const [sendState, setSendState]   = useState({ status: 'idle', message: '' });
  const [busy, setBusy]             = useState(null);

  const subject = templates[activeTemplate]?.subject ?? '';
  const body    = templates[activeTemplate]?.body ?? '';
  const setSubject = (v) => setTemplates((p) => ({ ...p, [activeTemplate]: { ...(p[activeTemplate] || {}), subject: typeof v === 'function' ? v(p[activeTemplate]?.subject ?? '') : v } }));
  const setBody    = (v) => setTemplates((p) => ({ ...p, [activeTemplate]: { ...(p[activeTemplate] || {}), body: typeof v === 'function' ? v(p[activeTemplate]?.body ?? '') : v } }));
  const updateTheme = (patch) => setEmailTheme((p) => ({ ...p, ...patch }));
  const applyPreset = (preset) => updateTheme({ brand: preset.brand });
  const uploadLogo = async (file) => {
    if (!file || !file.type?.startsWith('image/')) return;
    try {
      const url = await uploadLogoToStorage(file);
      updateTheme({ logo: url, logoCleared: false });
    } catch (err) {
      console.error('[SuperAdminComms] logo upload failed', err);
    }
  };
  const useDefaultLogo = async () => {
    try {
      const url = await ensureDefaultZaroLogoUrl(zaroLogo);
      updateTheme({ logo: url, logoCleared: false });
    } catch { updateTheme({ logo: zaroLogo, logoCleared: false }); }
  };
  const removeLogo = () => updateTheme({ logo: null, logoCleared: true });

  // Persist
  const initialPersistRef = useRef(true);
  useEffect(() => {
    if (initialPersistRef.current) { initialPersistRef.current = false; return; }
    const id = setTimeout(() => saveState({ theme: emailTheme, templates }), 400);
    return () => clearTimeout(id);
  }, [emailTheme, templates]);

  // Recipients (across all orgs)
  const allRecipients = useMemo(() => {
    const list = [];
    (orgs || []).forEach((org) => {
      const primaryEmail = String(org.hrAdminEmail || '').trim();
      if (primaryEmail) {
        list.push({
          key: `${org.key}::primary`, orgKey: org.key, orgName: org.name,
          name: org.hrAdminName || '', email: primaryEmail,
          password: org.temporaryPassword || '',
          role: 'Primary HR Admin', launched: !!org.launched, org,
        });
      }
      (org.hrTeam || []).forEach((member) => {
        if (member.type !== 'co-admin' && member.type !== 'scoped-hr') return;
        if (member.isInPMS) return;
        const email = String(member.email || '').trim();
        if (!email) return;
        list.push({
          key: `${org.key}::${member.type}::${member.id}`, orgKey: org.key, orgName: org.name,
          name: member.name || '', email, password: member.password || '',
          role: member.type === 'co-admin' ? 'Co-Admin' : 'Scoped HR',
          launched: !!org.launched, org,
        });
      });
    });
    return list;
  }, [orgs]);

  const [recipSearch, setRecipSearch] = useState('');
  const [recipFilter, setRecipFilter] = useState('all'); // all | active | setup
  const [previewIndex, setPreviewIndex] = useState(0);
  const [selectedKeys, setSelectedKeys] = useState(() => new Set());

  useEffect(() => {
    setSelectedKeys((prev) => {
      const valid = new Set(allRecipients.map((r) => r.key));
      return new Set([...prev].filter((k) => valid.has(k)));
    });
  }, [allRecipients]);

  // Last sent (email_deliveries) — keyed by `${orgKey}::${email_lower}`.
  const [inviteHistory, setInviteHistory] = useState({});
  useEffect(() => {
    if (!shouldUseSupabase || !supabase) return;
    if (!allRecipients.length) { setInviteHistory({}); return; }
    let cancelled = false;
    (async () => {
      const orgKeys = [...new Set(allRecipients.map((r) => r.orgKey).filter(Boolean))];
      if (orgKeys.length === 0) return;
      const { data: orgRows, error: orgErr } = await supabase
        .from('organizations').select('id, org_key').in('org_key', orgKeys);
      if (orgErr || cancelled) return;
      const idToKey = new Map((orgRows || []).map((r) => [r.id, r.org_key]));
      const ids = [...idToKey.keys()];
      if (!ids.length) return;
      const { data: rows, error: delErr } = await supabase
        .from('email_deliveries')
        .select('organization_id, recipient_email, status, sent_at, created_at')
        .eq('delivery_type', 'org-admin-invite').in('organization_id', ids)
        .order('created_at', { ascending: false }).limit(2000);
      if (delErr || cancelled) return;
      const next = {};
      (rows || []).forEach((row) => {
        const orgKey = idToKey.get(row.organization_id);
        const email = String(row.recipient_email || '').trim().toLowerCase();
        if (!orgKey || !email) return;
        const key = `${orgKey}::${email}`;
        if (next[key]) return;
        next[key] = { status: row.status, sentAt: row.sent_at || row.created_at };
      });
      setInviteHistory(next);
    })();
    return () => { cancelled = true; };
  }, [allRecipients]);
  const lastSentFor = (item) => inviteHistory[`${item.orgKey}::${(item.email || '').toLowerCase()}`] || null;

  // Filtering
  const filteredRecipients = allRecipients.filter((r) => {
    const text = `${r.orgName || ''} ${r.name || ''} ${r.email || ''} ${r.role || ''}`.toLowerCase();
    const matchQ = !recipSearch || text.includes(recipSearch.trim().toLowerCase());
    const matchS = recipFilter === 'all' || (recipFilter === 'active' ? r.launched : !r.launched);
    return matchQ && matchS;
  });
  const selectedRecipients = allRecipients.filter((r) => selectedKeys.has(r.key));
  const allVisibleSelected = filteredRecipients.length > 0 && filteredRecipients.every((r) => selectedKeys.has(r.key));
  function toggleRecipient(key) { setSelectedKeys((p) => { const n = new Set(p); n.has(key) ? n.delete(key) : n.add(key); return n; }); }
  function toggleVisible() { setSelectedKeys((p) => { const n = new Set(p); if (allVisibleSelected) filteredRecipients.forEach((r) => n.delete(r.key)); else filteredRecipients.forEach((r) => n.add(r.key)); return n; }); }

  // Preview-as
  const previewRecipient = allRecipients[previewIndex] || allRecipients[0] || null;
  const firstName = (n) => String(n || '').trim().split(/\s+/).filter(Boolean)[0] || 'there';
  const workspaceUrl = (org) => {
    const slug = String(org?.workspaceSlug || '').trim();
    return slug ? buildWorkspaceUrl(slug, { absolute: true, hash: 'login' }) : '#';
  };
  const resolve = (text) => {
    if (!text) return text;
    const r = previewRecipient;
    return text
      .replace(/\{organization_name\}/g, r?.orgName || 'Your organization')
      .replace(/\{admin_name\}/g, r?.name || 'Admin')
      .replace(/\{first_name\}/g, firstName(r?.name))
      .replace(/\{recipient_email\}/g, r?.email || 'admin@example.com')
      .replace(/\{temporary_password\}/g, r?.password || 'TempPass123')
      .replace(/\{password\}/g, r?.password || 'TempPass123')
      .replace(/\{login_url\}/g, workspaceUrl(r?.org));
  };
  const previewSubject = resolve(subject);
  const previewBody    = resolve(body);

  // Token insertion
  const subjectRef = useRef(null);
  const bodyRef    = useRef(null);
  function insertToken(target, token) {
    const el = target === 'subject' ? subjectRef.current : bodyRef.current;
    const setter = target === 'subject' ? setSubject : setBody;
    const value  = target === 'subject' ? subject : body;
    if (!el) { setter(value + token); return; }
    const start = el.selectionStart ?? value.length;
    const end   = el.selectionEnd ?? value.length;
    const next  = value.slice(0, start) + token + value.slice(end);
    setter(next);
    requestAnimationFrame(() => { el.focus(); const pos = start + token.length; el.setSelectionRange(pos, pos); });
  }

  // Section flash
  const paletteRef       = useRef(null);
  const logoSectionRef   = useRef(null);
  const buttonSectionRef = useRef(null);
  const footerSectionRef = useRef(null);
  const [flashSection, setFlashSection] = useState(null);
  function focusSection(target) {
    const map = { header: paletteRef, logo: logoSectionRef, cta: buttonSectionRef, footer: footerSectionRef };
    // Hotspots are clickable from the preview pane regardless of which step tab
    // is active. Switch to 'design' first so the target refs exist, then scroll
    // and flash on the next frame.
    setStepTab('design');
    requestAnimationFrame(() => {
      const r = map[target]?.current; if (!r) return;
      r.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      setFlashSection(target); setTimeout(() => setFlashSection(null), 900);
    });
  }
  const flashRing = (key) => (flashSection === key ? '0 0 0 3px rgba(79,70,229,0.25)' : 'none');

  // Open the inline name input on "+ Add to Template". The button morphs
  // into a text field; pressing Enter commits, Esc / empty blur cancels.
  function openAddTemplate() {
    setDraftTemplateName('');
    setTimeout(() => draftTemplateInputRef.current?.focus(), 0);
  }
  function commitDraftTemplate() {
    const name = (draftTemplateName || '').trim();
    if (!name) { setDraftTemplateName(null); return; }
    const key = `tpl_${Date.now().toString(36)}`;
    setTemplates((p) => ({ ...p, [key]: { name, desc: 'Custom template', subject, body } }));
    setActiveTemplate(key);
    setDraftTemplateName(null);
  }
  function cancelDraftTemplate() {
    setDraftTemplateName(null);
  }

  // Two-click delete: first click arms the button (red "Click again to
  // delete"), second click within 3s actually removes. Replaces the ugly
  // native window.confirm dialog.
  function requestDelete() {
    if (activeTemplate === 'admin-invite') return;
    if (pendingDeleteKey === activeTemplate) {
      // Confirm: actually delete.
      clearTimeout(pendingDeleteTimerRef.current);
      pendingDeleteTimerRef.current = null;
      setPendingDeleteKey(null);
      setTemplates((p) => { const n = { ...p }; delete n[activeTemplate]; return n; });
      setActiveTemplate('admin-invite');
      return;
    }
    setPendingDeleteKey(activeTemplate);
    clearTimeout(pendingDeleteTimerRef.current);
    pendingDeleteTimerRef.current = setTimeout(() => {
      setPendingDeleteKey(null);
      pendingDeleteTimerRef.current = null;
    }, 3000);
  }

  // Send
  async function sendOne(recipient) {
    const orgPayload = {
      ...recipient.org,
      hrAdminName: recipient.name,
      hrAdminEmail: recipient.email,
      temporaryPassword: recipient.password || recipient.org?.temporaryPassword || '',
    };
    const tpl = templates[activeTemplate];
    // Guard: the email renderer strips any logo URL that isn't a public
    // HTTPS asset (Vite dev-server paths and localhost would 404 in Gmail).
    // If the current theme.logo isn't public, try to upload it on the fly so
    // the recipient actually sees it.
    let liveTheme = emailTheme;
    if (liveTheme.logo && !isPublicBrandAssetUrl(liveTheme.logo)) {
      try {
        const publicUrl = await ensureDefaultZaroLogoUrl(liveTheme.logo);
        if (isPublicBrandAssetUrl(publicUrl)) {
          liveTheme = { ...liveTheme, logo: publicUrl, logoCleared: false };
          setEmailTheme(liveTheme);
        }
      } catch { /* swallow — render will simply omit the logo */ }
    }
    return sendHrAdminInviteEmail(orgPayload, {
      theme: themeForOrg(liveTheme, orgPayload),
      template: { subject: tpl.subject, body: tpl.body },
      supportEmail: 'support@zarohr.com',
    });
  }
  // Optimistic update so the row's Status + Last sent reflect the new state
  // immediately without waiting for the next email_deliveries query.
  function recordInviteResult(recipient, ok) {
    const key = `${recipient.orgKey}::${String(recipient.email || '').toLowerCase()}`;
    if (!key) return;
    setInviteHistory((prev) => ({
      ...prev,
      [key]: { status: ok ? 'sent' : 'failed', sentAt: new Date().toISOString() },
    }));
  }

  async function handleSendOne(r) {
    setBusy(r.key);
    setSendState({ status: 'sending', message: `Sending to ${r.email}…` });
    try {
      const res = await sendOne(r);
      recordInviteResult(r, !!res?.ok);
      setSendState(res?.ok ? { status: 'sent', message: `Sent to ${r.email}.` } : { status: 'failed', message: res?.error || 'Send failed.' });
    } catch (e) {
      recordInviteResult(r, false);
      setSendState({ status: 'failed', message: e?.message || 'Send failed.' });
    }
    finally { setBusy(null); }
  }
  async function handleSendSelected() {
    if (selectedRecipients.length === 0) return;
    setSendState({ status: 'sending', message: `Sending ${selectedRecipients.length} invite${selectedRecipients.length === 1 ? '' : 's'}…` });
    let sent = 0, failed = 0;
    for (const r of selectedRecipients) {
      try {
        const res = await sendOne(r);
        recordInviteResult(r, !!res?.ok);
        if (res?.ok) sent += 1; else failed += 1;
      }
      catch { recordInviteResult(r, false); failed += 1; }
    }
    setSendState({ status: failed ? 'failed' : 'sent', message: `Sent ${sent}${failed ? ` · ${failed} failed` : ''}.` });
  }
  // Brand visuals
  const previewEmailTheme = useMemo(
    () => themeForOrg(emailTheme, previewRecipient?.org),
    [emailTheme, previewRecipient?.org]
  );
  const brand = previewEmailTheme.brand;
  const brandDark = darkenHex(brand, 0.22);
  const brandTheme = { accent: brand, credBg: withAlpha(brand, 0.08), credBorder: withAlpha(brand, 0.25) };
  const logoHeightPx = previewEmailTheme.logoSize === 'small' ? 26 : previewEmailTheme.logoSize === 'large' ? 48 : 36;
  const showLogo = previewEmailTheme.logo && previewEmailTheme.logoPosition !== 'hide';
  const logoJustify = previewEmailTheme.logoPosition === 'header-center' ? 'center' : previewEmailTheme.logoPosition === 'header-right' ? 'flex-end' : 'flex-start';
  const activeChannel = COMMS_CHANNELS.find((c) => c.id === activeTab) || COMMS_CHANNELS[0];
  function ctaStyle() {
    const base = { display: 'inline-flex', alignItems: 'center', gap: 8, padding: '11px 22px', fontSize: 13.5, fontWeight: 700, fontFamily: 'inherit', transition: 'all 160ms ease' };
    if (emailTheme.buttonStyle === 'outline') return { ...base, background: '#fff', color: brand, border: `2px solid ${brand}`, borderRadius: 10 };
    if (emailTheme.buttonStyle === 'pill')    return { ...base, background: `linear-gradient(135deg, ${brand} 0%, ${brandDark} 100%)`, color: '#fff', border: 'none', borderRadius: 999, boxShadow: `0 6px 14px ${withAlpha(brand, 0.32)}` };
    if (emailTheme.buttonStyle === 'ghost')   return { ...base, background: 'transparent', color: brand, border: 'none', borderRadius: 4, padding: '4px 0', fontWeight: 700, textDecoration: 'underline', textUnderlineOffset: 4 };
    return { ...base, background: `linear-gradient(135deg, ${brand} 0%, ${brandDark} 100%)`, color: '#fff', border: 'none', borderRadius: 10, boxShadow: `0 6px 14px ${withAlpha(brand, 0.32)}` };
  }

  // Layout
  const page = { maxWidth: 'none', margin: 0, padding: '0 32px 48px' };

  return (
    <AdminShell title="Communications" page="comms">
      <div style={page}>
        <style>{`@keyframes flashPulse{0%{box-shadow:0 0 0 0 rgba(79,70,229,0.35)}100%{box-shadow:0 0 0 10px rgba(79,70,229,0)}}`}</style>

        {/* Channel tabs */}
        <div style={{ display: 'flex', gap: 2, marginBottom: 14, borderBottom: '1px solid #E2E8F0' }}>
          {COMMS_CHANNELS.map((c) => {
            const isActive = activeTab === c.id;
            const disabled = !c.ready;
            return (
              <button key={c.id} type="button" disabled={disabled} onClick={() => !disabled && setActiveTab(c.id)}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '8px 14px', border: 'none', borderBottom: `2px solid ${isActive ? c.accent : 'transparent'}`, marginBottom: -1, background: 'transparent', color: isActive ? c.accent : disabled ? '#CBD5E1' : '#64748B', fontWeight: isActive ? 700 : 500, fontSize: 12.5, fontFamily: 'inherit', cursor: disabled ? 'not-allowed' : 'pointer', transition: 'all 160ms ease' }}>
                <span style={{ display: 'inline-flex', opacity: disabled ? 0.55 : 1 }}>{c.icon}</span>
                <span>{c.label}</span>
                {disabled && <span style={{ fontSize: 10, fontWeight: 700, color: '#94A3B8', background: '#F1F5F9', padding: '1px 7px', borderRadius: 999 }}>Soon</span>}
              </button>
            );
          })}
        </div>

        {activeTab === 'email' && (
          <>
            {/* Transient send-state messages (Sending… / Sent / Failed) */}
            {(() => {
              const sending = sendState.status === 'sending';
              const sent    = sendState.status === 'sent';
              const failed  = sendState.status === 'failed';
              const message = sendState.message || (sending ? 'Sending…' : '');
              if (!message) return null;
              return (
                <div style={{ marginBottom: 12, fontSize: 12.5, color: sent ? '#86EFAC' : failed ? '#FCA5A5' : '#94A3B8', fontWeight: sent || failed ? 700 : 500 }}>
                  {message}
                </div>
              );
            })()}

            {/* Template switcher — inline subtitle when there's only one
                template, compact pill row when there are several. The bulky
                "Pick a template" card has been retired in favour of this. */}
            {Object.keys(templates).length === 1 ? (
              <div style={{ marginBottom: 14, display: 'flex', alignItems: 'baseline', gap: 8, fontSize: 12.5, color: '#94A3B8' }}>
                <span>Editing</span>
                <span style={{ fontWeight: 700, color: '#E0E7FF' }}>{templates[activeTemplate]?.name || 'Untitled'}</span>
                <span style={{ color: '#475569' }}>·</span>
                <span>{templates[activeTemplate]?.desc || (activeTemplate === 'admin-invite' ? 'Sent when a workspace is provisioned' : 'Custom template')}</span>
              </div>
            ) : (
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 14, alignItems: 'center' }}>
                <span style={{ fontSize: 11.5, color: '#64748B', textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 700, marginRight: 4 }}>Templates</span>
                {Object.entries(templates).map(([key, t]) => {
                  const active = activeTemplate === key;
                  const deletable = key !== 'admin-invite';
                  const armed = pendingDeleteKey === key;
                  const baseBorder = armed ? '#F87171' : (active ? 'rgba(96,165,250,0.55)' : 'rgba(255,255,255,0.08)');
                  const baseBg = armed ? 'rgba(248,113,113,0.14)' : (active ? 'rgba(59,130,246,0.18)' : 'rgba(255,255,255,0.04)');
                  const baseColor = armed ? '#FCA5A5' : (active ? '#BFDBFE' : '#94A3B8');
                  return (
                    <div key={key} style={{
                      display: 'inline-flex', alignItems: 'center', gap: 4,
                      padding: '6px 6px 6px 12px', borderRadius: 999,
                      border: `1px solid ${baseBorder}`,
                      background: baseBg, color: baseColor,
                      fontFamily: 'inherit', fontSize: 12, fontWeight: 700,
                      transition: 'all 160ms ease', whiteSpace: 'nowrap',
                    }}>
                      <button type="button" onClick={() => setActiveTemplate(key)}
                        style={{ background: 'transparent', border: 'none', padding: 0, margin: 0, color: 'inherit', font: 'inherit', cursor: 'pointer' }}
                      >
                        {t.name || 'Untitled'}
                      </button>
                      {deletable && (
                        <button type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            // First click arms; second click within 3s deletes.
                            if (pendingDeleteKey === key) {
                              clearTimeout(pendingDeleteTimerRef.current);
                              pendingDeleteTimerRef.current = null;
                              setPendingDeleteKey(null);
                              setTemplates((p) => { const n = { ...p }; delete n[key]; return n; });
                              if (activeTemplate === key) setActiveTemplate('admin-invite');
                              return;
                            }
                            setPendingDeleteKey(key);
                            clearTimeout(pendingDeleteTimerRef.current);
                            pendingDeleteTimerRef.current = setTimeout(() => {
                              setPendingDeleteKey(null);
                              pendingDeleteTimerRef.current = null;
                            }, 3000);
                          }}
                          onBlur={() => { if (armed) { setPendingDeleteKey(null); clearTimeout(pendingDeleteTimerRef.current); } }}
                          title={armed ? 'Click again to confirm' : 'Remove template'}
                          aria-label={armed ? 'Click again to confirm' : 'Remove template'}
                          style={{
                            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                            width: 20, height: 20, padding: 0,
                            border: 'none', borderRadius: 999,
                            background: armed ? '#DC2626' : 'rgba(255,255,255,0.06)',
                            color: armed ? '#fff' : '#94A3B8',
                            cursor: 'pointer', fontFamily: 'inherit', fontSize: 12, fontWeight: 700, lineHeight: 1,
                            transition: 'all 160ms ease',
                          }}
                        >
                          ×
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            {/* Step tabs */}
            <div style={{ display: 'inline-flex', gap: 2, padding: 4, background: '#F1F5F9', borderRadius: 11, marginBottom: 16 }}>
              {[
                { k: 'compose', label: 'Compose' },
                { k: 'design',  label: 'Design' },
                { k: 'recipients', label: `Recipients · ${allRecipients.length}` },
              ].map((t) => {
                const active = stepTab === t.k;
                return (
                  <button key={t.k} type="button" onClick={() => setStepTab(t.k)}
                    style={{ padding: '7px 16px', borderRadius: 8, border: 'none', cursor: 'pointer', fontFamily: 'inherit', fontSize: 12.5, fontWeight: active ? 700 : 500, background: active ? '#fff' : 'transparent', color: active ? '#0F172A' : '#64748B', boxShadow: active ? '0 1px 4px rgba(15,23,42,.08)' : 'none', transition: 'all 160ms ease' }}>
                    {t.label}
                  </button>
                );
              })}
            </div>

            {(stepTab === 'compose' || stepTab === 'design') && (
              <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1.05fr) minmax(0,1fr)', gap: 16 }}>

                {/* Editor column */}
                <div style={{ background: '#fff', border: '1px solid #E9EDF2', borderRadius: 14, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
                  <div style={{ padding: '14px 18px', borderBottom: '1px solid #F1F5F9', display: 'flex', alignItems: 'center', gap: 10 }}>
                    <div style={{ width: 30, height: 30, borderRadius: 9, background: activeChannel.accentBg, border: `1px solid ${activeChannel.accentBorder}`, display: 'flex', alignItems: 'center', justifyContent: 'center', color: activeChannel.accent }}>
                      {activeChannel.icon}
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 13.5, fontWeight: 700, color: '#0F172A' }}>{stepTab === 'design' ? 'Brand & design' : 'Email template'}</div>
                      <div style={{ fontSize: 11.5, color: '#94A3B8' }}>{stepTab === 'design' ? 'Pick a colour, drop a logo, choose a button — preview updates live.' : 'Click a token to insert it where your cursor is.'}</div>
                    </div>
                    {activeTemplate !== 'admin-invite' && (() => {
                      const armed = pendingDeleteKey === activeTemplate;
                      return (
                        <button type="button" onClick={requestDelete}
                          onBlur={() => { if (armed) { setPendingDeleteKey(null); clearTimeout(pendingDeleteTimerRef.current); } }}
                          style={{
                            border: armed ? '1px solid #DC2626' : '1px solid #FECACA',
                            background: armed ? '#DC2626' : '#fff',
                            color: armed ? '#fff' : '#B91C1C',
                            borderRadius: 8, padding: '6px 12px', fontSize: 12, fontWeight: 800, cursor: 'pointer', fontFamily: 'inherit',
                            transition: 'background 160ms ease, color 160ms ease, border-color 160ms ease',
                          }}>
                          {armed ? 'Click again to delete' : 'Delete'}
                        </button>
                      );
                    })()}
                  </div>

                  <div style={{ padding: '16px 18px 18px', display: 'flex', flexDirection: 'column', gap: 14 }}>
                    {stepTab === 'compose' && <>
                      {activeTemplate !== 'admin-invite' && (
                        <div>
                          <label style={{ fontSize: 11, fontWeight: 700, color: '#94A3B8', textTransform: 'uppercase', letterSpacing: '0.05em', display: 'block', marginBottom: 6 }}>Template name</label>
                          <input value={templates[activeTemplate]?.name || ''} onChange={(e) => setTemplates((p) => ({ ...p, [activeTemplate]: { ...(p[activeTemplate] || {}), name: e.target.value } }))}
                            style={{ width: '100%', boxSizing: 'border-box', border: '1.5px solid #E2E8F0', borderRadius: 9, padding: '10px 13px', fontSize: 13.5, outline: 'none', fontFamily: 'inherit', color: '#0D1117', background: '#fff' }} />
                        </div>
                      )}
                      <div>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
                          <label style={{ fontSize: 11, fontWeight: 700, color: '#94A3B8', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Subject</label>
                          <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                            {COMMS_TOKENS.map((t) => (
                              <button key={t.key} type="button" onClick={() => insertToken('subject', t.key)}
                                style={{ fontSize: 10.5, fontWeight: 600, color: '#4338CA', background: '#EEF2FF', border: '1px solid #C7D2FE', borderRadius: 999, padding: '2px 9px', cursor: 'pointer', fontFamily: 'inherit' }}>
                                + {t.label}
                              </button>
                            ))}
                          </div>
                        </div>
                        <input ref={subjectRef} value={subject} onChange={(e) => setSubject(e.target.value)}
                          style={{ width: '100%', boxSizing: 'border-box', border: '1.5px solid #E2E8F0', borderRadius: 9, padding: '10px 13px', fontSize: 13.5, outline: 'none', fontFamily: 'inherit', color: '#0D1117', background: '#fff' }} />
                      </div>
                      <div style={{ display: 'flex', flexDirection: 'column', flex: 1 }}>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
                          <label style={{ fontSize: 11, fontWeight: 700, color: '#94A3B8', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Body</label>
                          <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                            {COMMS_TOKENS.map((t) => (
                              <button key={t.key} type="button" onClick={() => insertToken('body', t.key)}
                                style={{ fontSize: 10.5, fontWeight: 600, color: '#4338CA', background: '#EEF2FF', border: '1px solid #C7D2FE', borderRadius: 999, padding: '2px 9px', cursor: 'pointer', fontFamily: 'inherit' }}>
                                + {t.label}
                              </button>
                            ))}
                          </div>
                        </div>
                        <textarea ref={bodyRef} value={body} onChange={(e) => setBody(e.target.value)} rows={14}
                          style={{ width: '100%', boxSizing: 'border-box', border: '1.5px solid #E2E8F0', borderRadius: 9, padding: '12px 14px', fontSize: 13, lineHeight: 1.7, outline: 'none', fontFamily: "'Geist Mono','SF Mono',Menlo,monospace", color: '#0D1117', resize: 'vertical', background: '#fff' }} />
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '6px 2px', gap: 12, flexWrap: 'wrap' }}>
                        <button type="button" onClick={() => setStepTab('design')} style={{ background: 'transparent', border: 'none', color: '#4F46E5', fontWeight: 700, fontSize: 12.5, cursor: 'pointer', fontFamily: 'inherit', padding: 0 }}>
                          Customize design →
                        </button>
                        {draftTemplateName !== null ? (
                          <div style={{
                            display: 'inline-flex', alignItems: 'center', gap: 8,
                            padding: '6px 8px 6px 14px', borderRadius: 999,
                            border: '1.5px solid #818CF8', background: '#EEF2FF',
                            boxShadow: '0 4px 14px rgba(79,70,229,0.18)',
                          }}>
                            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#4338CA" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>
                            <input
                              ref={draftTemplateInputRef}
                              type="text"
                              value={draftTemplateName}
                              placeholder="Name this template…"
                              onChange={(e) => setDraftTemplateName(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); }
                                else if (e.key === 'Escape') { e.preventDefault(); cancelDraftTemplate(); }
                              }}
                              onBlur={commitDraftTemplate}
                              style={{ width: 180, border: 'none', outline: 'none', background: 'transparent', fontSize: 12.5, fontWeight: 700, color: '#312E81', fontFamily: 'inherit', padding: 0 }}
                            />
                            <span style={{ fontSize: 10.5, color: '#6B7280', whiteSpace: 'nowrap' }}>↵ to save</span>
                          </div>
                        ) : (
                          <button
                            type="button"
                            onClick={openAddTemplate}
                            title="Save current draft as a reusable template"
                            style={{
                              display: 'inline-flex', alignItems: 'center', gap: 6,
                              padding: '8px 14px', borderRadius: 999,
                              border: '1.5px solid #C7D2FE',
                              background: '#EEF2FF',
                              color: '#4338CA',
                              fontWeight: 700, fontSize: 12.5, cursor: 'pointer', fontFamily: 'inherit',
                              transition: 'background 160ms ease, border-color 160ms ease, transform 160ms ease',
                            }}
                            onMouseEnter={(e) => { e.currentTarget.style.background = '#E0E7FF'; e.currentTarget.style.transform = 'translateY(-1px)'; }}
                            onMouseLeave={(e) => { e.currentTarget.style.background = '#EEF2FF'; e.currentTarget.style.transform = 'translateY(0)'; }}
                          >
                            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>
                            + Add to Template
                          </button>
                        )}
                      </div>
                    </>}

                    {stepTab === 'design' && <>
                      {/* Palette */}
                      <div ref={paletteRef} style={{ border: `1.5px solid ${flashSection === 'header' ? '#A5B4FC' : '#E2E8F0'}`, borderRadius: 10, background: '#fff', padding: '12px 14px', display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10, boxShadow: flashRing('header'), transition: 'box-shadow 260ms ease, border-color 260ms ease' }}>
                        <div style={{ fontSize: 11, fontWeight: 700, color: '#94A3B8', textTransform: 'uppercase', letterSpacing: '0.05em', minWidth: 80 }}>Palette</div>
                        {COMMS_THEME_PRESETS.map((p) => {
                          const active = brand.toLowerCase() === p.brand.toLowerCase();
                          return (
                            <button key={p.id} type="button" onClick={() => applyPreset(p)} title={p.label}
                              style={{ width: 24, height: 24, borderRadius: 999, padding: 0, cursor: 'pointer', border: `2px solid ${active ? '#0F172A' : 'transparent'}`, background: p.brand, boxShadow: active ? '0 0 0 3px rgba(15,23,42,.08)' : 'inset 0 0 0 1px rgba(15,23,42,.08)' }} />
                          );
                        })}
                        <label style={{ position: 'relative', width: 24, height: 24, borderRadius: 999, cursor: 'pointer', border: '1.5px solid #E2E8F0', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', color: '#64748B', background: '#fff' }} title="Custom">
                          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M12 5v14M5 12h14"/></svg>
                          <input type="color" value={brand} onChange={(e) => updateTheme({ brand: e.target.value })} style={{ position: 'absolute', inset: 0, opacity: 0, cursor: 'pointer' }} />
                        </label>
                      </div>

                      {/* Logo */}
                      <div ref={logoSectionRef} style={{ border: `1.5px solid ${flashSection === 'logo' ? '#A5B4FC' : '#E2E8F0'}`, borderRadius: 10, background: '#fff', padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 10, boxShadow: flashRing('logo'), transition: 'box-shadow 260ms ease, border-color 260ms ease' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                          <div style={{ fontSize: 11, fontWeight: 700, color: '#94A3B8', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Logo</div>
                          {emailTheme.logo ? (
                            <>
                              <img src={emailTheme.logo} alt="Logo" style={{ height: 28, maxWidth: 120, borderRadius: 5, background: '#F1F5F9', border: '1px solid #E2E8F0', padding: 2, objectFit: 'contain' }} />
                              <label style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '5px 10px', border: '1.5px solid #E2E8F0', borderRadius: 7, cursor: 'pointer', fontSize: 11.5, fontWeight: 600, color: '#475569', background: '#fff' }}>
                                Replace
                                <input type="file" accept="image/*" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; uploadLogo(f); }} style={{ display: 'none' }} />
                              </label>
                              <button type="button" onClick={removeLogo} style={{ padding: '5px 10px', background: '#fff', color: '#DC2626', border: '1.5px solid #FECACA', borderRadius: 7, fontSize: 11, cursor: 'pointer', fontFamily: 'inherit', fontWeight: 600 }}>Remove</button>
                            </>
                          ) : (
                            <>
                              <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 12px', border: '1.5px dashed #CBD5E1', borderRadius: 8, cursor: 'pointer', fontSize: 11.5, fontWeight: 600, color: '#475569', background: '#fff' }}>
                                Upload logo
                                <input type="file" accept="image/*" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; uploadLogo(f); }} style={{ display: 'none' }} />
                              </label>
                              <button type="button" onClick={useDefaultLogo} style={{ padding: '6px 12px', background: '#EEF2FF', color: '#4338CA', border: '1.5px solid #C7D2FE', borderRadius: 8, fontSize: 11.5, cursor: 'pointer', fontFamily: 'inherit', fontWeight: 600 }}>Use Zaro logo</button>
                            </>
                          )}
                        </div>
                        {/* Logo URL-safety warning: email clients can't load
                            local Vite asset paths, so we strip them at send
                            time. Surface this clearly so the user can re-upload
                            instead of getting an inbox missing the logo. */}
                        {emailTheme.logo && !isPublicBrandAssetUrl(emailTheme.logo) && (
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', background: '#FFFBEB', border: '1px solid #FDE68A', borderRadius: 7, fontSize: 11.5, color: '#92400E' }}>
                            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
                            <span style={{ flex: 1 }}>This logo lives on your local dev server — email clients can't load it. Click "Fix now" to upload it to public storage.</span>
                            <button type="button" onClick={useDefaultLogo}
                              style={{ padding: '5px 10px', background: '#fff', color: '#92400E', border: '1.5px solid #FDE68A', borderRadius: 7, fontSize: 11.5, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' }}>
                              Fix now
                            </button>
                          </div>
                        )}
                        {emailTheme.logo && (
                          <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', paddingTop: 6, borderTop: '1px dashed #E2E8F0' }}>
                            <div>
                              <div style={{ fontSize: 10.5, fontWeight: 600, color: '#94A3B8', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4 }}>Position</div>
                              <div style={{ display: 'inline-flex', gap: 4, background: '#F1F5F9', padding: 3, borderRadius: 8 }}>
                                {LOGO_POSITIONS.map((p) => {
                                  const active = (emailTheme.logoPosition || 'header-left') === p.id;
                                  return (
                                    <button key={p.id} type="button" onClick={() => updateTheme({ logoPosition: p.id })}
                                      style={{ padding: '5px 11px', borderRadius: 6, border: 'none', background: active ? '#fff' : 'transparent', color: active ? '#0F172A' : '#64748B', fontWeight: active ? 700 : 500, fontSize: 11, cursor: 'pointer', fontFamily: 'inherit', boxShadow: active ? '0 1px 3px rgba(15,23,42,.08)' : 'none' }}>
                                      {p.label}
                                    </button>
                                  );
                                })}
                              </div>
                            </div>
                            <div>
                              <div style={{ fontSize: 10.5, fontWeight: 600, color: '#94A3B8', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4 }}>Size</div>
                              <div style={{ display: 'inline-flex', gap: 4, background: '#F1F5F9', padding: 3, borderRadius: 8 }}>
                                {LOGO_SIZES.map((s) => {
                                  const active = (emailTheme.logoSize || 'medium') === s;
                                  return (
                                    <button key={s} type="button" onClick={() => updateTheme({ logoSize: s })}
                                      style={{ padding: '5px 11px', borderRadius: 6, border: 'none', background: active ? '#fff' : 'transparent', color: active ? '#0F172A' : '#64748B', fontWeight: active ? 700 : 500, fontSize: 11, cursor: 'pointer', fontFamily: 'inherit', textTransform: 'capitalize', boxShadow: active ? '0 1px 3px rgba(15,23,42,.08)' : 'none' }}>
                                      {s}
                                    </button>
                                  );
                                })}
                              </div>
                            </div>
                          </div>
                        )}
                      </div>

                      {/* Button */}
                      <div ref={buttonSectionRef} style={{ border: `1.5px solid ${flashSection === 'cta' ? '#A5B4FC' : '#E2E8F0'}`, borderRadius: 10, background: '#fff', padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 10, boxShadow: flashRing('cta'), transition: 'box-shadow 260ms ease, border-color 260ms ease' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                          <div style={{ fontSize: 11, fontWeight: 700, color: '#94A3B8', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Button</div>
                          <input type="text" value={emailTheme.ctaLabel} onChange={(e) => updateTheme({ ctaLabel: e.target.value })}
                            placeholder="Open workspace"
                            style={{ flex: 1, minWidth: 200, border: '1.5px solid #E2E8F0', borderRadius: 7, padding: '6px 10px', fontSize: 12.5, outline: 'none', fontFamily: 'inherit', color: '#0F172A', background: '#fff' }} />
                        </div>
                        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                          <div>
                            <div style={{ fontSize: 10.5, fontWeight: 600, color: '#94A3B8', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4 }}>Style</div>
                            <div style={{ display: 'inline-flex', gap: 4, background: '#F1F5F9', padding: 3, borderRadius: 8 }}>
                              {BUTTON_STYLES.map((s) => (
                                <button key={s.id} type="button" onClick={() => updateTheme({ buttonStyle: s.id })}
                                  style={{ padding: '5px 10px', borderRadius: 6, border: 'none', background: emailTheme.buttonStyle === s.id ? '#fff' : 'transparent', color: emailTheme.buttonStyle === s.id ? '#0F172A' : '#64748B', fontWeight: emailTheme.buttonStyle === s.id ? 700 : 500, fontSize: 11, cursor: 'pointer', fontFamily: 'inherit', boxShadow: emailTheme.buttonStyle === s.id ? '0 1px 3px rgba(15,23,42,.08)' : 'none' }}>
                                  {s.label}
                                </button>
                              ))}
                            </div>
                          </div>
                          <div>
                            <div style={{ fontSize: 10.5, fontWeight: 600, color: '#94A3B8', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4 }}>Align</div>
                            <div style={{ display: 'inline-flex', gap: 4, background: '#F1F5F9', padding: 3, borderRadius: 8 }}>
                              {['left', 'center', 'right'].map((a) => (
                                <button key={a} type="button" onClick={() => updateTheme({ buttonAlign: a })}
                                  style={{ padding: '5px 11px', borderRadius: 6, border: 'none', background: emailTheme.buttonAlign === a ? '#fff' : 'transparent', color: emailTheme.buttonAlign === a ? '#0F172A' : '#64748B', fontWeight: emailTheme.buttonAlign === a ? 700 : 500, fontSize: 11, cursor: 'pointer', fontFamily: 'inherit', textTransform: 'capitalize', boxShadow: emailTheme.buttonAlign === a ? '0 1px 3px rgba(15,23,42,.08)' : 'none' }}>
                                  {a}
                                </button>
                              ))}
                            </div>
                          </div>
                        </div>
                      </div>

                      {/* Footer */}
                      <div ref={footerSectionRef} style={{ border: `1.5px solid ${flashSection === 'footer' ? '#A5B4FC' : '#E2E8F0'}`, borderRadius: 10, background: '#fff', padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 10, boxShadow: flashRing('footer'), transition: 'box-shadow 260ms ease, border-color 260ms ease' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                          <div style={{ fontSize: 11, fontWeight: 700, color: '#94A3B8', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Footer</div>
                          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: '#475569', cursor: 'pointer', userSelect: 'none' }}>
                            <input type="checkbox" checked={emailTheme.showFooter !== false} onChange={(e) => updateTheme({ showFooter: e.target.checked })} style={{ width: 14, height: 14, accentColor: '#4F46E5' }} />
                            <span>Show footer</span>
                          </label>
                          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: '#475569', cursor: 'pointer', userSelect: 'none' }}>
                            <input type="checkbox" checked={emailTheme.showZaroBadge !== false} onChange={(e) => updateTheme({ showZaroBadge: e.target.checked })} disabled={emailTheme.showFooter === false} style={{ width: 14, height: 14, accentColor: '#4F46E5' }} />
                            <span>Show Zaro HR badge</span>
                          </label>
                          <button type="button" onClick={async () => {
                              try {
                                const url = await ensureDefaultZaroLogoUrl(zaroLogo);
                                setEmailTheme({ ...DEFAULT_EMAIL_THEME, logo: url });
                              } catch {
                                setEmailTheme({ ...DEFAULT_EMAIL_THEME, logo: zaroLogo });
                              }
                            }}
                            style={{ padding: '6px 12px', background: 'transparent', color: '#64748B', border: 'none', borderRadius: 7, fontSize: 11.5, cursor: 'pointer', fontFamily: 'inherit', fontWeight: 600, marginLeft: 'auto' }}>
                            Reset all
                          </button>
                        </div>
                        {emailTheme.showFooter !== false && (
                          <input type="text" value={emailTheme.footerText} onChange={(e) => updateTheme({ footerText: e.target.value })}
                            style={{ width: '100%', boxSizing: 'border-box', border: '1.5px solid #E2E8F0', borderRadius: 7, padding: '7px 10px', fontSize: 12.5, outline: 'none', fontFamily: 'inherit', color: '#0F172A', background: '#fff' }} />
                        )}
                      </div>

                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '6px 2px' }}>
                        <span style={{ fontSize: 11.5, color: '#94A3B8' }}>Tip · click any element in the preview to jump to its control.</span>
                        <button type="button" onClick={() => setStepTab('compose')} style={{ background: 'transparent', border: 'none', color: '#4F46E5', fontWeight: 700, fontSize: 12.5, cursor: 'pointer', fontFamily: 'inherit', padding: 0 }}>
                          ← Back to compose
                        </button>
                      </div>
                    </>}
                  </div>
                </div>

                {/* Preview column */}
                <div style={{ background: '#fff', border: '1px solid #E9EDF2', borderRadius: 14, overflow: 'hidden', display: 'flex', flexDirection: 'column', position: 'relative' }}>
                  {allRecipients.length > 0 && (
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, padding: '10px 14px', borderBottom: '1px solid #F1F5F9', background: '#fff' }}>
                      <div style={{ display: 'inline-flex', alignItems: 'center', gap: 7, fontSize: 11, fontWeight: 700, color: '#94A3B8', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-10 6L2 7"/></svg>
                        Live preview
                      </div>
                      <label style={{ display: 'inline-flex', alignItems: 'center', gap: 7, fontSize: 12, color: '#475569' }}>
                        <span style={{ color: '#94A3B8' }}>Preview as</span>
                        <select value={previewIndex} onChange={(e) => setPreviewIndex(Number(e.target.value))}
                          style={{ border: '1.5px solid #E2E8F0', background: '#fff', padding: '5px 10px', borderRadius: 7, fontSize: 12, fontFamily: 'inherit', color: '#0F172A', fontWeight: 600, outline: 'none', cursor: 'pointer', maxWidth: 220 }}>
                          {allRecipients.map((r, i) => (
                            <option key={r.key} value={i}>{r.orgName} — {r.name || r.email}</option>
                          ))}
                        </select>
                      </label>
                    </div>
                  )}
                  {previewRecipient ? (
                    <div style={{ padding: '20px 18px 22px', flex: 1, overflow: 'auto', background: 'linear-gradient(180deg,#F1F5F9 0%,#FAFBFF 100%)' }}>
                      <div style={{ position: 'relative', background: '#fff', borderRadius: 14, overflow: 'hidden', boxShadow: '0 10px 30px rgba(15,23,42,.08)', border: '1px solid #E2E8F0' }}>
                        {/* Brand header */}
                        <PreviewHotspot label="Edit header" onClick={() => focusSection('header')}>
                          <div style={{ background: `linear-gradient(135deg, ${brand} 0%, ${brandDark} 100%)`, padding: '22px 24px', color: '#fff', position: 'relative', overflow: 'hidden' }}>
                            <div style={{ position: 'absolute', right: -40, top: -40, width: 160, height: 160, borderRadius: '50%', background: 'rgba(255,255,255,.08)' }} />
                            {showLogo && (
                              <div style={{ position: 'relative', display: 'flex', justifyContent: logoJustify, marginBottom: 12 }}>
                                <PreviewHotspot label="Edit logo" onClick={(e) => { e.stopPropagation(); focusSection('logo'); }} inline>
                                  <img src={previewEmailTheme.logo} alt="Logo" draggable={false}
                                    style={{ height: logoHeightPx, width: 'auto', maxWidth: 200, objectFit: 'contain', display: 'block' }} />
                                </PreviewHotspot>
                              </div>
                            )}
                            <div style={{ position: 'relative', minWidth: 0 }}>
                              {previewSubject.trim() && (
                                <div style={{ fontSize: 19, fontWeight: 800, lineHeight: 1.3 }}>{previewSubject}</div>
                              )}
                            </div>
                          </div>
                        </PreviewHotspot>

                        {/* Body */}
                        <div style={{ position: 'relative' }}>
                          <div style={{ position: 'relative', padding: '22px 26px 14px', fontSize: 13.5, lineHeight: 1.7, color: '#1E293B' }}>
                            {renderEmailBody(previewBody, brandTheme)}
                          </div>

                          {/* CTA */}
                          <PreviewHotspot label="Edit button" onClick={() => focusSection('cta')}>
                            <div style={{ padding: '0 26px 22px', display: 'flex', justifyContent: emailTheme.buttonAlign === 'center' ? 'center' : emailTheme.buttonAlign === 'right' ? 'flex-end' : 'flex-start' }}>
                              <div style={ctaStyle()}>
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><polyline points="10 17 15 12 10 7"/><line x1="15" y1="12" x2="3" y2="12"/></svg>
                                {emailTheme.ctaLabel || 'Open workspace'}
                              </div>
                            </div>
                          </PreviewHotspot>
                        </div>

                        {/* Footer */}
                        {emailTheme.showFooter !== false && (
                          <PreviewHotspot label="Edit footer" onClick={() => focusSection('footer')}>
                            <div style={{ borderTop: '1px solid #F1F5F9', background: '#FAFBFF', padding: '12px 26px', fontSize: 11, color: '#94A3B8', display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
                              <span>{emailTheme.footerText || ''}</span>
                              {emailTheme.showZaroBadge !== false && <span>Powered by Zaro HR</span>}
                            </div>
                          </PreviewHotspot>
                        )}
                      </div>
                    </div>
                  ) : (
                    <div style={{ padding: '32px 20px', textAlign: 'center', color: '#94A3B8', fontSize: 13 }}>
                      No admin recipients yet. Create an org with an HR admin email or add a co-admin.
                    </div>
                  )}
                </div>

              </div>
            )}

            {stepTab === 'recipients' && (
              <section style={{ background: '#fff', border: '1px solid #E9EDF2', borderRadius: 14, overflow: 'hidden' }}>
                <div style={{ padding: '18px 22px', borderBottom: '1px solid #E5E7EB' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 14, flexWrap: 'wrap', marginBottom: 14 }}>
                    <div>
                      <h2 style={{ margin: 0, fontSize: 20, color: '#111827' }}>Recipients</h2>
                      <p style={{ margin: '5px 0 0', fontSize: 14, color: '#6B7280' }}>Select admin accounts that should receive this invite.</p>
                    </div>
                    <button type="button" onClick={handleSendSelected} disabled={selectedRecipients.length === 0 || sendState.status === 'sending'}
                      style={{ padding: '8px 16px', background: selectedRecipients.length === 0 ? '#E2E8F0' : '#4F46E5', color: selectedRecipients.length === 0 ? '#94A3B8' : '#fff', border: 'none', borderRadius: 9, fontSize: 12.5, fontWeight: 700, cursor: selectedRecipients.length === 0 ? 'not-allowed' : 'pointer', fontFamily: 'inherit' }}>
                      {sendState.status === 'sending' ? 'Sending...' : `Send selected (${selectedRecipients.length})`}
                    </button>
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 180px', gap: 12 }}>
                    <input value={recipSearch} onChange={(e) => setRecipSearch(e.target.value)} placeholder="Search org, admin, or email"
                      style={{ width: '100%', boxSizing: 'border-box', border: '1.5px solid #E2E8F0', borderRadius: 9, padding: '10px 13px', fontSize: 13.5, outline: 'none', fontFamily: 'inherit', color: '#0D1117', background: '#fff' }} />
                    <select value={recipFilter} onChange={(e) => setRecipFilter(e.target.value)}
                      style={{ width: '100%', boxSizing: 'border-box', border: '1.5px solid #E2E8F0', borderRadius: 9, padding: '10px 13px', fontSize: 13.5, outline: 'none', fontFamily: 'inherit', color: '#0D1117', background: '#fff' }}>
                      <option value="all">All statuses</option>
                      <option value="setup">Setup</option>
                      <option value="active">Active</option>
                    </select>
                  </div>
                  <div style={{ fontSize: 13.5, color: '#6B7280', marginTop: 12 }}>
                    Showing <strong style={{ color: '#111827' }}>{filteredRecipients.length}</strong>, selected <strong style={{ color: '#111827' }}>{selectedRecipients.length}</strong>
                  </div>
                </div>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
                  <thead>
                    <tr style={{ background: '#F9FAFB' }}>
                      <th style={{ width: 44, padding: '13px 18px', textAlign: 'left' }}>
                        <input type="checkbox" checked={allVisibleSelected} onChange={toggleVisible} />
                      </th>
                      {['Organization', 'Recipient', 'Email', 'Role', 'Status', 'Last sent', ''].map((h) => (
                        <th key={h} style={{ padding: '13px 18px', textAlign: 'left', fontSize: 12, fontWeight: 800, color: '#6B7280', textTransform: 'uppercase', letterSpacing: '.04em' }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {filteredRecipients.map((item) => {
                      const roleColor = item.role === 'Co-Admin' ? '#7C3AED' : item.role === 'Scoped HR' ? '#B45309' : '#2563EB';
                      const roleBg    = item.role === 'Co-Admin' ? '#F5F3FF' : item.role === 'Scoped HR' ? '#FFFBEB' : '#EFF6FF';
                      const history   = lastSentFor(item);
                      const ls        = history?.sentAt ? formatRelativeDate(history.sentAt) : '';
                      const lsTitle   = history?.sentAt ? `${new Date(history.sentAt).toLocaleString()} · ${history.status || ''}` : '';
                      const lsColor   = history?.status === 'failed' ? '#B91C1C' : '#374151';
                      return (
                        <tr key={item.key} style={{ borderTop: '1px solid #F3F4F6' }}>
                          <td style={{ padding: '15px 18px' }}>
                            <input type="checkbox" checked={selectedKeys.has(item.key)} onChange={() => toggleRecipient(item.key)} />
                          </td>
                          <td style={{ padding: '15px 18px', fontWeight: 700, color: '#111827' }}>{item.orgName}</td>
                          <td style={{ padding: '15px 18px', color: '#374151' }}>{item.name || '-'}</td>
                          <td style={{ padding: '15px 18px', color: '#374151' }}>{item.email}</td>
                          <td style={{ padding: '15px 18px' }}>
                            <span style={{ fontSize: 12, fontWeight: 700, color: roleColor, background: roleBg, borderRadius: 999, padding: '4px 10px' }}>{item.role}</span>
                          </td>
                          <td style={{ padding: '15px 18px' }}>
                            {(() => {
                              if (history?.status === 'failed') {
                                return <span style={{ fontSize: 12, fontWeight: 800, color: '#B91C1C', background: '#FEF2F2', borderRadius: 999, padding: '5px 10px' }}>Failed</span>;
                              }
                              if (history?.sentAt) {
                                return <span style={{ fontSize: 12, fontWeight: 800, color: '#047857', background: '#ECFDF5', borderRadius: 999, padding: '5px 10px' }}>Sent</span>;
                              }
                              return <span style={{ fontSize: 12, fontWeight: 800, color: '#6B7280', background: '#F1F5F9', borderRadius: 999, padding: '5px 10px' }}>Not sent</span>;
                            })()}
                          </td>
                          <td style={{ padding: '15px 18px', color: lsColor, fontSize: 12.5 }} title={lsTitle}>
                            {ls ? (
                              <>
                                {ls}
                                {history?.status === 'failed' && <span style={{ marginLeft: 6, fontSize: 10, fontWeight: 800, color: '#B91C1C', background: '#FEF2F2', borderRadius: 999, padding: '2px 7px', verticalAlign: 'middle' }}>FAILED</span>}
                              </>
                            ) : <span style={{ color: '#9CA3AF' }}>—</span>}
                          </td>
                          <td style={{ padding: '12px 18px', textAlign: 'right' }}>
                            <button type="button" disabled={busy === item.key} onClick={() => handleSendOne(item)}
                              style={{ padding: '7px 14px', background: busy === item.key ? '#E2E8F0' : '#4F46E5', color: busy === item.key ? '#94A3B8' : '#fff', border: 'none', borderRadius: 8, fontSize: 12.5, fontWeight: 700, cursor: busy === item.key ? 'not-allowed' : 'pointer', fontFamily: 'inherit' }}>
                              {busy === item.key ? 'Sending…' : (ls ? 'Resend' : 'Send')}
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                    {filteredRecipients.length === 0 && (
                      <tr>
                        <td colSpan={8} style={{ padding: 36, textAlign: 'center', color: '#6B7280' }}>
                          {allRecipients.length === 0 ? 'No admin recipients yet. Create an org with an HR admin email or add a co-admin.' : 'No recipients match this filter.'}
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </section>
            )}
          </>
        )}

        {activeTab !== 'email' && (
          <div style={{ background: '#fff', border: '1.5px dashed #E2E8F0', borderRadius: 14, padding: '48px 20px', textAlign: 'center' }}>
            <div style={{ display: 'inline-flex', width: 46, height: 46, borderRadius: 12, background: activeChannel.accentBg, border: `1px solid ${activeChannel.accentBorder}`, alignItems: 'center', justifyContent: 'center', color: activeChannel.accent, marginBottom: 12 }}>
              {activeChannel.icon}
            </div>
            <div style={{ fontSize: 15, fontWeight: 700, color: '#0F172A' }}>{activeChannel.label} — coming soon</div>
            <div style={{ fontSize: 12.5, color: '#94A3B8', marginTop: 4 }}>This channel will unlock once delivery is wired.</div>
          </div>
        )}
      </div>
    </AdminShell>
  );
}
