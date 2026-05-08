import { useState, useMemo, useEffect } from 'react';
import { useApp } from '../AppContext';
import AdminShell from '../components/AdminShell';
import { DEFAULT_BLOCKS, loadGlobalEmailTemplates, saveGlobalEmailTemplates } from '../backend/globalEmailTemplate';
import { sendHrAdminInviteEmail } from '../backend/emailService';
import { renderAdminInviteEmailHtml } from '../backend/emailRenderer';

const SUBJECT_TOKENS = [
  { key: '{organization_name}', label: 'Company' },
  { key: '{employee_name}', label: 'Admin name' },
  { key: '{first_name}', label: 'First name' },
  { key: '{recipient_email}', label: 'Email' },
  { key: '{temporary_password}', label: 'Password' },
  { key: '{login_url}', label: 'Workspace link' },
];

const COLOR_PRESETS = [
  { label: 'Indigo', value: '#4F46E5' },
  { label: 'Blue', value: '#2563EB' },
  { label: 'Emerald', value: '#059669' },
  { label: 'Rose', value: '#E11D48' },
  { label: 'Graphite', value: '#111827' },
];

function firstName(value) {
  return String(value || '').trim().split(/\s+/).filter(Boolean)[0] || 'there';
}

function replaceTokens(value, tokens) {
  return String(value || '').replace(/\{([a-z_]+)\}/g, (_m, k) => tokens[k] ?? `{${k}}`);
}

function extractBodyHtml(html) {
  const match = String(html || '').match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  return match ? match[1] : String(html || '');
}

function ensureCredentialTokens(text) {
  const value = String(text || '');
  if (value.includes('{recipient_email}') || value.includes('{temporary_password}')) return value;
  return `${value.trim()}\n\nLogin email: {recipient_email}\nTemporary password: {temporary_password}\nWorkspace link: {login_url}`.trim();
}

function makeTemplateCopy(template, name) {
  return {
    ...template,
    name,
    blocks: {
      ...DEFAULT_BLOCKS,
      ...(template?.blocks || {}),
      header: { ...DEFAULT_BLOCKS.header, ...(template?.blocks?.header || {}) },
      bodyStyle: { ...DEFAULT_BLOCKS.bodyStyle, ...(template?.blocks?.bodyStyle || {}) },
      greeting: { ...DEFAULT_BLOCKS.greeting, ...(template?.blocks?.greeting || {}) },
      body: Array.isArray(template?.blocks?.body) && template.blocks.body.length
        ? template.blocks.body.map((item) => ({ ...item }))
        : DEFAULT_BLOCKS.body.map((item) => ({ ...item })),
      credentials: { ...DEFAULT_BLOCKS.credentials, ...(template?.blocks?.credentials || {}) },
      button: { ...DEFAULT_BLOCKS.button, ...(template?.blocks?.button || {}) },
      signature: { ...DEFAULT_BLOCKS.signature, ...(template?.blocks?.signature || {}) },
      footer: { ...DEFAULT_BLOCKS.footer, ...(template?.blocks?.footer || {}) },
    },
  };
}

export default function SuperAdminCommsPage() {
  const { orgs } = useApp();
  const initial = useMemo(() => loadGlobalEmailTemplates(), []);
  const [theme, setTheme] = useState(initial.theme);
  const [allTemplates, setAllTemplates] = useState(initial.templates);
  const [activeTemplateKey, setActiveTemplateKey] = useState('admin-invite');
  const [sendState, setSendState] = useState({ status: 'idle', message: '' });
  const [busy, setBusy] = useState(null);
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [previewRecipientKey, setPreviewRecipientKey] = useState('');
  const [selectedKeys, setSelectedKeys] = useState(() => new Set());
  const [stepTab, setStepTab] = useState('compose');

  const template = allTemplates[activeTemplateKey] || allTemplates['admin-invite'];
  const blocks = template?.blocks || DEFAULT_BLOCKS;
  const bodyText = ensureCredentialTokens(blocks.body?.[0]?.text || '');
  const blocksForEmail = {
    ...blocks,
    credentials: { ...(blocks.credentials || {}), enabled: false },
    body: [
      { ...((Array.isArray(blocks.body) && blocks.body[0]) || DEFAULT_BLOCKS.body[0]), text: bodyText },
      ...((Array.isArray(blocks.body) ? blocks.body.slice(1) : [])),
    ],
  };
  const sampleOrg = orgs?.[0];
  const supportEmail = theme.supportEmail || 'support@zarohr.com';

  const recipients = useMemo(() => {
    const list = [];
    (orgs || []).forEach((org) => {
      const orgKey = org.key;
      const primaryEmail = String(org.hrAdminEmail || '').trim();
      if (primaryEmail) {
        list.push({
          key: `${orgKey}::primary`,
          orgKey,
          orgName: org.name,
          name: org.hrAdminName || '',
          email: primaryEmail,
          password: org.temporaryPassword || '',
          role: 'Primary HR Admin',
          launched: !!org.launched,
          org,
        });
      }
      (org.hrTeam || []).forEach((member) => {
        if (member.type !== 'co-admin' && member.type !== 'scoped-hr') return;
        if (member.isInPMS) return;
        const email = String(member.email || '').trim();
        if (!email) return;
        list.push({
          key: `${orgKey}::${member.type}::${member.id}`,
          orgKey,
          orgName: org.name,
          name: member.name || '',
          email,
          password: member.password || '',
          role: member.type === 'co-admin' ? 'Co-Admin' : 'Scoped HR',
          launched: !!org.launched,
          org,
        });
      });
    });
    return list;
  }, [orgs]);

  useEffect(() => {
    setSelectedKeys((prev) => {
      const valid = new Set(recipients.map((item) => item.key));
      return new Set([...prev].filter((key) => valid.has(key)));
    });
  }, [recipients]);

  useEffect(() => {
    const id = setTimeout(() => {
      saveGlobalEmailTemplates({
        theme: { ...theme, supportEmail },
        templates: allTemplates,
      });
    }, 300);
    return () => clearTimeout(id);
  }, [theme, allTemplates, supportEmail]);

  function updateTemplate(patch) {
    setAllTemplates((prev) => ({
      ...prev,
      [activeTemplateKey]: { ...(prev[activeTemplateKey] || prev['admin-invite']), ...patch },
    }));
  }

  function updateBlocks(patch) {
    updateTemplate({ blocks: { ...blocks, ...patch } });
  }

  function updateGreeting(text) {
    updateBlocks({ greeting: { ...blocks.greeting, text } });
  }

  function updateBodyText(text) {
    const current = Array.isArray(blocks.body) && blocks.body.length ? blocks.body : DEFAULT_BLOCKS.body;
    updateBlocks({
      body: [
        { ...current[0], text },
        ...current.slice(1),
      ],
    });
  }

  function updateButtonLabel(label) {
    updateBlocks({ button: { ...blocks.button, label } });
  }

  function updateFooterText(text) {
    updateBlocks({ footer: { ...blocks.footer, text } });
  }

  function applyColor(value) {
    updateBlocks({
      header: { ...blocks.header, accentColor: value },
      button: { ...blocks.button, color: value },
    });
  }

  function insertBodyToken(token) {
    if (!token) return;
    const current = bodyText || '';
    updateBodyText(`${current}${token}`);
  }

  function addTemplate() {
    const name = window.prompt('Template name');
    if (!name?.trim()) return;
    const key = `template_${Date.now().toString(36)}`;
    setAllTemplates((prev) => ({
      ...prev,
      [key]: makeTemplateCopy(template, name.trim()),
    }));
    setActiveTemplateKey(key);
  }

  function deleteCurrentTemplate() {
    if (activeTemplateKey === 'admin-invite') return;
    if (!window.confirm('Delete this template?')) return;
    setAllTemplates((prev) => {
      const next = { ...prev };
      delete next[activeTemplateKey];
      return next;
    });
    setActiveTemplateKey('admin-invite');
  }

  const filteredRecipients = recipients.filter((item) => {
    const text = `${item.orgName || ''} ${item.name || ''} ${item.email || ''} ${item.role || ''}`.toLowerCase();
    const statusOk = statusFilter === 'all' || (statusFilter === 'active' ? item.launched : !item.launched);
    return statusOk && text.includes(query.trim().toLowerCase());
  });
  const selectedRecipients = recipients.filter((item) => selectedKeys.has(item.key));
  const allVisibleSelected = filteredRecipients.length > 0 && filteredRecipients.every((item) => selectedKeys.has(item.key));
  const pickedRecipient = previewRecipientKey ? recipients.find((item) => item.key === previewRecipientKey) : null;
  const previewRecipient = pickedRecipient || selectedRecipients[0] || recipients[0] || null;

  const previewTokens = previewRecipient
    ? {
        organization_name: previewRecipient.orgName || sampleOrg?.name || 'Your organization',
        employee_name: previewRecipient.name || 'Admin',
        first_name: firstName(previewRecipient.name || 'Admin'),
        recipient_email: previewRecipient.email || '',
        temporary_password: previewRecipient.password || '',
        login_url: previewRecipient.org?.domain ? `https://${previewRecipient.org.domain}/#login` : '',
        support_email: supportEmail,
      }
    : {
        organization_name: sampleOrg?.name || 'Your organization',
        employee_name: sampleOrg?.hrAdminName || 'Admin',
        first_name: firstName(sampleOrg?.hrAdminName || 'Admin'),
        recipient_email: sampleOrg?.hrAdminEmail || '',
        temporary_password: sampleOrg?.temporaryPassword || '',
        login_url: sampleOrg?.domain ? `https://${sampleOrg.domain}/#login` : '',
        support_email: supportEmail,
      };

  const resolvedSubject = replaceTokens(template.subject || '', previewTokens);
  const previewHtml = renderAdminInviteEmailHtml({
    companyName: previewTokens.organization_name,
    firstName: previewTokens.first_name,
    loginEmail: previewTokens.recipient_email,
    tempPassword: previewTokens.temporary_password,
    workspaceUrl: previewTokens.login_url,
    supportEmail,
    theme,
    blocks: blocksForEmail,
  });
  const previewBodyHtml = extractBodyHtml(previewHtml);

  function toggleRecipient(key) {
    setSelectedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function toggleVisible() {
    setSelectedKeys((prev) => {
      const next = new Set(prev);
      if (allVisibleSelected) filteredRecipients.forEach((item) => next.delete(item.key));
      else filteredRecipients.forEach((item) => next.add(item.key));
      return next;
    });
  }

  function recipientToOrgPayload(recipient) {
    return {
      ...recipient.org,
      hrAdminName: recipient.name,
      hrAdminEmail: recipient.email,
      temporaryPassword: recipient.password || recipient.org?.temporaryPassword || '',
    };
  }

  async function sendToRecipient(recipient) {
    setBusy(recipient.key);
    setSendState({ status: 'sending', message: `Sending invite to ${recipient.email}...` });
    try {
      const orgPayload = recipientToOrgPayload(recipient);
      const result = await sendHrAdminInviteEmail(orgPayload, {
        theme: { ...theme, supportEmail },
        template: { ...template, blocks: blocksForEmail },
        supportEmail,
      });
      setSendState(result?.ok
        ? { status: 'sent', message: `Sent invite to ${recipient.email}.` }
        : { status: 'failed', message: result?.error || 'Send failed.' });
    } catch (error) {
      setSendState({ status: 'failed', message: error?.message || 'Send failed.' });
    } finally {
      setBusy(null);
    }
  }

  async function sendSelected() {
    if (selectedRecipients.length === 0) return;
    setSendState({ status: 'sending', message: `Sending ${selectedRecipients.length} invite${selectedRecipients.length === 1 ? '' : 's'}...` });
    let sent = 0;
    let failed = 0;
    for (const recipient of selectedRecipients) {
      try {
        const result = await sendHrAdminInviteEmail(recipientToOrgPayload(recipient), {
          theme: { ...theme, supportEmail },
          template: { ...template, blocks: blocksForEmail },
          supportEmail,
        });
        if (result?.ok) sent += 1;
        else failed += 1;
      } catch {
        failed += 1;
      }
    }
    setSendState({
      status: failed ? 'failed' : 'sent',
      message: `Sent ${sent}${failed ? `, ${failed} failed` : ''}.`,
    });
  }

  const sendBanner = sendState.status === 'sent'
    ? { bg: '#ECFDF5', bd: '#A7F3D0', tx: '#065F46' }
    : sendState.status === 'failed'
    ? { bg: '#FEF2F2', bd: '#FECACA', tx: '#991B1B' }
    : { bg: '#EEF2FF', bd: '#C7D2FE', tx: '#3730A3' };

  const page = { maxWidth: 'none', margin: 0, padding: '28px 40px 48px' };
  const card = { background: '#fff', border: '1px solid #E9EDF2', borderRadius: 14, boxShadow: '0 10px 28px rgba(15,23,42,.04)' };
  const input = { width: '100%', boxSizing: 'border-box', border: '1.5px solid #E2E8F0', borderRadius: 9, padding: '10px 13px', fontSize: 13.5, lineHeight: 1.45, outline: 'none', fontFamily: 'inherit', color: '#0D1117', background: '#fff' };
  const label = { display: 'block', fontSize: 11, fontWeight: 700, color: '#94A3B8', textTransform: 'uppercase', letterSpacing: '.05em', marginBottom: 7 };
  const action = (enabled = true) => ({ padding: '8px 16px', background: enabled ? '#4F46E5' : '#E2E8F0', color: enabled ? '#fff' : '#94A3B8', border: 'none', borderRadius: 9, fontSize: 12.5, fontWeight: 700, cursor: enabled ? 'pointer' : 'not-allowed', fontFamily: 'inherit', boxShadow: enabled ? '0 4px 12px rgba(79,70,229,.25)' : 'none' });
  const emailIcon = (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="m3 7 9 6 9-6" />
    </svg>
  );

  return (
    <AdminShell title="Communications" page="comms">
      <div style={page}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 16, marginBottom: 18, flexWrap: 'wrap' }}>
          <div>
            <div style={{ fontSize: 12, fontWeight: 800, color: '#94A3B8', textTransform: 'uppercase', letterSpacing: '.06em' }}>Admin invite emails</div>
            <div style={{ fontSize: 14, color: '#64748B', marginTop: 3 }}>Choose a template, review recipients, then send manually.</div>
          </div>
          <button type="button" onClick={sendSelected} disabled={selectedRecipients.length === 0 || sendState.status === 'sending'} style={action(selectedRecipients.length > 0 && sendState.status !== 'sending')}>
            {sendState.status === 'sending' ? 'Sending...' : `Send selected (${selectedRecipients.length})`}
          </button>
        </div>

        {sendState.message && (
          <div style={{ padding: '11px 14px', background: sendBanner.bg, border: `1px solid ${sendBanner.bd}`, borderRadius: 10, color: sendBanner.tx, fontSize: 13.5, fontWeight: 700, marginBottom: 16 }}>
            {sendState.message}
          </div>
        )}

        <section style={{ marginBottom: 18 }}>
          <div style={{ ...label, marginBottom: 10 }}>Templates</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 10 }}>
            {Object.entries(allTemplates).map(([key, item]) => {
              const active = key === activeTemplateKey;
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => setActiveTemplateKey(key)}
                  style={{
                    textAlign: 'left',
                    minHeight: 76,
                    padding: '12px 14px',
                    border: `1.5px solid ${active ? '#4F46E5' : '#E2E8F0'}`,
                    borderRadius: 12,
                    background: active ? '#EEF2FF' : '#fff',
                    cursor: 'pointer',
                    fontFamily: 'inherit',
                    boxShadow: active ? '0 6px 14px rgba(79,70,229,.14)' : 'none',
                  }}
                >
                  <div style={{ fontSize: 13.5, fontWeight: 800, color: active ? '#312E81' : '#111827' }}>
                    {key === 'admin-invite' ? 'Admin invite' : item.name || 'Untitled'}
                  </div>
                  <div style={{ fontSize: 11.5, color: '#64748B', marginTop: 5 }}>
                    {key === 'admin-invite' ? 'Default template' : 'Custom template'}
                  </div>
                </button>
              );
            })}
            <button type="button" onClick={addTemplate}
              style={{ minHeight: 76, padding: '12px 14px', border: '1.5px dashed #CBD5E1', borderRadius: 12, background: '#fff', color: '#475569', cursor: 'pointer', fontFamily: 'inherit', fontSize: 13.5, fontWeight: 800 }}>
              + Add template
            </button>
          </div>
        </section>

        <div style={{ display: 'inline-flex', gap: 2, padding: 4, background: '#F1F5F9', borderRadius: 11, marginBottom: 16 }}>
          {[
            { k: 'compose', label: 'Compose' },
            { k: 'design', label: 'Design' },
            { k: 'recipients', label: `Recipients · ${recipients.length}` },
          ].map((item) => {
            const active = stepTab === item.k;
            return (
              <button key={item.k} type="button" onClick={() => setStepTab(item.k)}
                style={{ padding: '7px 16px', borderRadius: 8, border: 'none', cursor: 'pointer', fontFamily: 'inherit', fontSize: 12.5, fontWeight: active ? 700 : 500, background: active ? '#fff' : 'transparent', color: active ? '#0F172A' : '#64748B', boxShadow: active ? '0 1px 4px rgba(15,23,42,.08)' : 'none' }}>
                {item.label}
              </button>
            );
          })}
        </div>

        {stepTab === 'compose' && (
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1.05fr) minmax(0,1fr)', gap: 16, marginBottom: 18 }}>
        <section style={{ ...card, marginBottom: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
          <div style={{ padding: '14px 18px', borderBottom: '1px solid #F1F5F9', display: 'flex', alignItems: 'center', gap: 10 }}>
            <div style={{ width: 30, height: 30, borderRadius: 9, background: '#EEF2FF', border: '1px solid #C7D2FE', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#4F46E5' }}>
              {emailIcon}
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13.5, fontWeight: 700, color: '#0F172A' }}>Email template</div>
              <div style={{ fontSize: 11.5, color: '#94A3B8' }}>Click a token to insert it where your cursor is.</div>
            </div>
              {activeTemplateKey !== 'admin-invite' && (
                <button type="button" onClick={deleteCurrentTemplate}
                  style={{ border: '1px solid #FECACA', background: '#fff', color: '#B91C1C', borderRadius: 8, padding: '6px 10px', fontSize: 12, fontWeight: 800, cursor: 'pointer', fontFamily: 'inherit' }}>
                  Delete
                </button>
              )}
          </div>

          <div style={{ padding: '16px 18px 18px', display: 'flex', flexDirection: 'column', gap: 14 }}>

            {activeTemplateKey !== 'admin-invite' && (
              <div>
                <label style={label}>Template name</label>
                <input value={template.name || ''} onChange={(event) => updateTemplate({ name: event.target.value })} style={input} />
              </div>
            )}

            <div>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginBottom: 6 }}>
                <label style={label}>Subject</label>
                <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                  {SUBJECT_TOKENS.map((token) => (
                    <button key={token.key} type="button" onClick={() => updateTemplate({ subject: `${template.subject || ''}${token.key}` })}
                      style={{ fontSize: 10.5, fontWeight: 600, color: '#4338CA', background: '#EEF2FF', border: '1px solid #C7D2FE', borderRadius: 999, padding: '2px 9px', cursor: 'pointer', fontFamily: 'inherit' }}>
                      + {token.label}
                    </button>
                  ))}
                </div>
              </div>
              <input value={template.subject || ''} onChange={(event) => updateTemplate({ subject: event.target.value })} style={input} />
            </div>

            <div>
              <label style={label}>Headline</label>
              <input value={blocks.greeting?.text || ''} onChange={(event) => updateGreeting(event.target.value)} style={input} />
            </div>

            <div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10 }}>
                <label style={label}>Message</label>
                <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                  {SUBJECT_TOKENS.map((token) => (
                    <button key={token.key} type="button" onClick={() => insertBodyToken(token.key)}
                      style={{ fontSize: 10.5, fontWeight: 600, color: '#4338CA', background: '#EEF2FF', border: '1px solid #C7D2FE', borderRadius: 999, padding: '2px 9px', cursor: 'pointer', fontFamily: 'inherit' }}>
                      + {token.label}
                    </button>
                  ))}
                </div>
              </div>
              <textarea
                value={bodyText}
                onChange={(event) => updateBodyText(event.target.value)}
                rows={14}
                style={{ ...input, resize: 'vertical', lineHeight: 1.7, fontFamily: "'Geist Mono','SF Mono',Menlo,monospace" }}
              />
            </div>

            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginTop: 14, padding: '6px 2px' }}>
              <span style={{ fontSize: 12, color: '#64748B' }}>Want a different look or logo?</span>
              <button type="button" onClick={() => setStepTab('design')} style={{ background: 'transparent', border: 'none', color: '#4F46E5', fontWeight: 700, fontSize: 12.5, cursor: 'pointer', fontFamily: 'inherit', padding: 0 }}>
                Customize design →
              </button>
            </div>
          </div>
        </section>

        <section style={{ ...card, overflow: 'hidden', marginBottom: 0, display: 'flex', flexDirection: 'column' }}>
            <div style={{ padding: '10px 14px', borderBottom: '1px solid #F1F5F9', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap', background: '#fff' }}>
              <div>
                <div style={{ display: 'inline-flex', alignItems: 'center', gap: 7, fontSize: 11, fontWeight: 700, color: '#94A3B8', textTransform: 'uppercase', letterSpacing: '.05em' }}>
                  {emailIcon}
                  Live preview
                </div>
                <div style={{ fontSize: 12.5, color: '#64748B', marginTop: 2 }}>Subject: <strong style={{ color: '#374151' }}>{resolvedSubject}</strong></div>
              </div>
              {recipients.length > 0 && (
                <select value={previewRecipientKey} onChange={(event) => setPreviewRecipientKey(event.target.value)} style={{ ...input, maxWidth: 300 }}>
                  <option value="">First selected recipient</option>
                  {recipients.map((item) => (
                    <option key={item.key} value={item.key}>{item.orgName} - {item.name || item.email}</option>
                  ))}
                </select>
              )}
            </div>
            <div style={{ flex: 1, minHeight: 520, maxHeight: 760, overflow: 'auto', background: 'linear-gradient(180deg,#F1F5F9 0%,#FAFBFF 100%)', padding: '20px 18px 22px' }}>
              <div dangerouslySetInnerHTML={{ __html: previewBodyHtml }} />
            </div>
        </section>
        </div>
        )}

        {stepTab === 'design' && (
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1.05fr) minmax(0,1fr)', gap: 16, marginBottom: 18 }}>
          <section style={{ ...card, marginBottom: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
            <div style={{ padding: '14px 18px', borderBottom: '1px solid #F1F5F9', display: 'flex', alignItems: 'center', gap: 10 }}>
              <div style={{ width: 30, height: 30, borderRadius: 9, background: '#EEF2FF', border: '1px solid #C7D2FE', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#4F46E5' }}>
                {emailIcon}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13.5, fontWeight: 700, color: '#0F172A' }}>Brand & design</div>
                <div style={{ fontSize: 11.5, color: '#94A3B8' }}>Pick a colour, choose a button, and preview updates live.</div>
              </div>
            </div>

            <div style={{ padding: '16px 18px 18px', display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div style={{ border: '1.5px solid #E2E8F0', borderRadius: 10, background: '#fff', padding: '12px 14px', display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10 }}>
              <div style={{ ...label, minWidth: 80, marginBottom: 0 }}>Palette</div>
                {COLOR_PRESETS.map((preset) => {
                  const active = (blocks.button?.color || blocks.header?.accentColor || '').toLowerCase() === preset.value.toLowerCase();
                  return (
                    <button
                      key={preset.value}
                      type="button"
                      onClick={() => applyColor(preset.value)}
                      title={preset.label}
                      style={{ width: 30, height: 30, borderRadius: 999, border: `2px solid ${active ? '#111827' : '#E2E8F0'}`, background: preset.value, cursor: 'pointer', boxShadow: active ? '0 0 0 3px rgba(15,23,42,.08)' : 'none' }}
                    />
                  );
                })}
            </div>

            <div style={{ border: '1.5px solid #E2E8F0', borderRadius: 10, background: '#fff', padding: '12px 14px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <div style={{ ...label, minWidth: 80, marginBottom: 0 }}>Button</div>
                <input value={blocks.button?.label || ''} onChange={(event) => updateButtonLabel(event.target.value)} style={{ ...input, flex: 1 }} />
              </div>
            </div>

            <div style={{ border: '1.5px solid #E2E8F0', borderRadius: 10, background: '#fff', padding: '12px 14px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <div style={{ ...label, minWidth: 80, marginBottom: 0 }}>Footer</div>
                <input value={blocks.footer?.text || ''} onChange={(event) => updateFooterText(event.target.value)} style={{ ...input, flex: 1 }} />
              </div>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginTop: 14, padding: '6px 2px' }}>
              <span style={{ fontSize: 12, color: '#64748B' }}>Content lives in Compose.</span>
              <button type="button" onClick={() => setStepTab('compose')} style={{ background: 'transparent', border: 'none', color: '#4F46E5', fontWeight: 700, fontSize: 12.5, cursor: 'pointer', fontFamily: 'inherit', padding: 0 }}>
                ← Back to compose
              </button>
            </div>
            </div>
          </section>

          <section style={{ ...card, overflow: 'hidden', marginBottom: 0, display: 'flex', flexDirection: 'column' }}>
            <div style={{ padding: '10px 14px', borderBottom: '1px solid #F1F5F9', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap', background: '#fff' }}>
              <div>
                <div style={{ display: 'inline-flex', alignItems: 'center', gap: 7, fontSize: 11, fontWeight: 700, color: '#94A3B8', textTransform: 'uppercase', letterSpacing: '.05em' }}>
                  {emailIcon}
                  Live preview
                </div>
                <div style={{ fontSize: 12.5, color: '#64748B', marginTop: 2 }}>Subject: <strong style={{ color: '#374151' }}>{resolvedSubject}</strong></div>
              </div>
              {recipients.length > 0 && (
                <select value={previewRecipientKey} onChange={(event) => setPreviewRecipientKey(event.target.value)} style={{ ...input, maxWidth: 300 }}>
                  <option value="">First selected recipient</option>
                  {recipients.map((item) => (
                    <option key={item.key} value={item.key}>{item.orgName} - {item.name || item.email}</option>
                  ))}
                </select>
              )}
            </div>
            <div style={{ flex: 1, minHeight: 520, maxHeight: 760, overflow: 'auto', background: 'linear-gradient(180deg,#F1F5F9 0%,#FAFBFF 100%)', padding: '20px 18px 22px' }}>
              <div dangerouslySetInnerHTML={{ __html: previewBodyHtml }} />
            </div>
          </section>
        </div>
        )}

        {stepTab === 'recipients' && (
        <section style={{ ...card, overflow: 'hidden' }}>
          <div style={{ padding: '18px 22px', borderBottom: '1px solid #E5E7EB' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 14, flexWrap: 'wrap', marginBottom: 14 }}>
              <div>
                <h2 style={{ margin: 0, fontSize: 20, color: '#111827' }}>Recipients</h2>
                <p style={{ margin: '5px 0 0', fontSize: 14, color: '#6B7280' }}>Select the admin accounts that should receive this invite.</p>
              </div>
              <button type="button" onClick={sendSelected} disabled={selectedRecipients.length === 0 || sendState.status === 'sending'} style={action(selectedRecipients.length > 0 && sendState.status !== 'sending')}>Send selected ({selectedRecipients.length})</button>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 180px', gap: 12 }}>
              <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search org, admin, or email" style={input} />
              <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)} style={input}>
                <option value="all">All statuses</option>
                <option value="setup">Setup</option>
                <option value="active">Active</option>
              </select>
            </div>
            <div style={{ fontSize: 13.5, color: '#6B7280', marginTop: 12 }}>Showing <strong style={{ color: '#111827' }}>{filteredRecipients.length}</strong>, selected <strong style={{ color: '#111827' }}>{selectedRecipients.length}</strong></div>
          </div>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
            <thead>
              <tr style={{ background: '#F9FAFB' }}>
                <th style={{ width: 44, padding: '13px 18px', textAlign: 'left' }}><input type="checkbox" checked={allVisibleSelected} onChange={toggleVisible} /></th>
                {['Organization', 'Recipient', 'Email', 'Role', 'Status', ''].map((head) => (
                  <th key={head} style={{ padding: '13px 18px', textAlign: 'left', fontSize: 12, fontWeight: 800, color: '#6B7280', textTransform: 'uppercase', letterSpacing: '.04em' }}>{head}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filteredRecipients.map((item) => {
                const roleColor = item.role === 'Co-Admin' ? '#7C3AED' : item.role === 'Scoped HR' ? '#B45309' : '#2563EB';
                const roleBg = item.role === 'Co-Admin' ? '#F5F3FF' : item.role === 'Scoped HR' ? '#FFFBEB' : '#EFF6FF';
                return (
                  <tr key={item.key} style={{ borderTop: '1px solid #F3F4F6' }}>
                    <td style={{ padding: '15px 18px' }}><input type="checkbox" checked={selectedKeys.has(item.key)} onChange={() => toggleRecipient(item.key)} /></td>
                    <td style={{ padding: '15px 18px', fontWeight: 700, color: '#111827' }}>{item.orgName}</td>
                    <td style={{ padding: '15px 18px', color: '#374151' }}>{item.name || '-'}</td>
                    <td style={{ padding: '15px 18px', color: '#374151' }}>{item.email}</td>
                    <td style={{ padding: '15px 18px' }}><span style={{ fontSize: 12, fontWeight: 700, color: roleColor, background: roleBg, borderRadius: 999, padding: '4px 10px' }}>{item.role}</span></td>
                    <td style={{ padding: '15px 18px' }}><span style={{ fontSize: 12, fontWeight: 800, color: item.launched ? '#047857' : '#92400E', background: item.launched ? '#ECFDF5' : '#FFFBEB', borderRadius: 999, padding: '5px 10px' }}>{item.launched ? 'Active' : 'Setup'}</span></td>
                    <td style={{ padding: '12px 18px', textAlign: 'right' }}><button type="button" disabled={busy === item.key} onClick={() => sendToRecipient(item)} style={action(busy !== item.key)}>{busy === item.key ? 'Sending...' : 'Send'}</button></td>
                  </tr>
                );
              })}
              {filteredRecipients.length === 0 && (
                <tr>
                  <td colSpan={7} style={{ padding: 36, textAlign: 'center', color: '#6B7280' }}>
                    {recipients.length === 0 ? 'No admin recipients yet. Create an org with an HR admin email or add a co-admin.' : 'No recipients match this filter.'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </section>
        )}
      </div>
    </AdminShell>
  );
}
