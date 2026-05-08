import { useState, useEffect, useCallback } from 'react';
import AdminShell from '../components/AdminShell';
import { useApp } from '../AppContext';
import { saveOrganizationRecord } from '../backend/stateStore';
import '../admin.css';

const PMS_MODULES = ['Performance Management'];

const STEPS = ['Workspace Setup', 'Admin Access'];

function buildEditSnapshot(form, modules) {
  const normalizedModules = Array.isArray(modules)
    ? [...modules].filter(Boolean).sort((left, right) => left.localeCompare(right))
    : [];

  return JSON.stringify({
    organization_name: String(form?.organization_name || '').trim(),
    organization_code: normalizeCode(form?.organization_code || ''),
    workspace_slug: normalizeSlug(form?.workspace_slug || ''),
    financial_year: String(form?.financial_year || '').trim(),
    custom_pms_start_date: String(form?.custom_pms_start_date || '').trim(),
    custom_pms_end_date: String(form?.custom_pms_end_date || '').trim(),
    hr_admin_name: String(form?.hr_admin_name || '').trim(),
    hr_admin_email: String(form?.hr_admin_email || '').trim().toLowerCase(),
    temporary_password: String(form?.temporary_password || ''),
    modules: normalizedModules,
  });
}

function slugify(v) {
  return String(v || '').trim().toLowerCase()
    .replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function normalizeCode(v) {
  return String(v || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 16);
}

function normalizeSlug(v) {
  return String(v || '').trim().toLowerCase()
    .replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '');
}

function isEmail(v) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v || '').trim());
}

function generateTempPassword() {
  return `Pass@${Math.random().toString(36).slice(2, 8)}`;
}

function genCodeFromName(name) {
  const stop = new Set(['pvt','ltd','limited','inc','llc','plc','private','company','co','technologies','technology','solutions','services','global','group']);
  const words = String(name || '').toLowerCase().replace(/[^a-z0-9\s]/g,' ').split(/\s+/).filter(Boolean).filter(w => !stop.has(w));
  return words.length ? normalizeCode(words[0]) : '';
}

// Get hash param
function getHashParam(name) {
  const hash = window.location.hash.replace(/^#/, '');
  const parts = hash.split('?');
  if (parts.length < 2) return null;
  const params = new URLSearchParams(parts[1]);
  return params.get(name);
}

const DRAFT_KEY = 'zarohr_create_org_draft';

function readDraft() {
  try { return JSON.parse(window.sessionStorage.getItem(DRAFT_KEY) || 'null'); }
  catch (_) { return null; }
}

function clearDraft() {
  try { window.sessionStorage.removeItem(DRAFT_KEY); } catch (_) {}
}

export default function CreateOrgPage() {
  const { orgs, applyAppData } = useApp();

  const editKey = getHashParam('key');
  const isEdit  = Boolean(editKey);
  const existingOrg = isEdit ? orgs.find(o => o.key === editKey) : null;

  // For create mode: restore any in-progress draft from sessionStorage
  const _d = !isEdit ? readDraft() : null;

  const [step, setStep]     = useState(() => _d?.step ?? 0);
  const [form, setForm]     = useState(() => _d?.form ?? initForm(existingOrg));
  const modules = PMS_MODULES;
  const [slugManual, setSlugManual]   = useState(() => _d?.slugManual ?? isEdit);
  const [codeManual, setCodeManual]   = useState(() => _d?.codeManual ?? isEdit);
  const [feedback, setFeedback]       = useState('');
  const [saving, setSaving]           = useState(false);
  // Additional admins added inline at org creation. The first admin is the
  // primary HR admin (saved on the org); these go into org.hrTeam[] as Co-Admins.
  const [additionalAdmins, setAdditionalAdmins] = useState(() =>
    Array.isArray(existingOrg?.hrTeam) ? existingOrg.hrTeam.filter((m) => m.type === 'co-admin' && !m.isInPMS).map((m) => ({
      id: m.id || `co_${Date.now()}`, name: m.name || '', email: m.email || '', password: m.password || '',
    })) : []
  );
  const initialSnapshot = buildEditSnapshot(initForm(existingOrg), PMS_MODULES);
  const currentSnapshot = buildEditSnapshot(form, modules);
  const isDirty = !isEdit || currentSnapshot !== initialSnapshot;

  // Auto-save draft to sessionStorage whenever form state changes (create mode only)
  useEffect(() => {
    if (isEdit) return;
    try {
      window.sessionStorage.setItem(DRAFT_KEY, JSON.stringify({ step, form, slugManual, codeManual }));
    } catch (_) {}
  }, [step, form, slugManual, codeManual, isEdit]);

  function initForm(org) {
    if (!org) return { financial_year: 'April–March' };
    const s = org.setupFormSnapshot || {};
    return {
      organization_name: s.organization_name || org.name || '',
      organization_code: s.organization_code || normalizeCode(org.orgCode || ''),
      workspace_slug: s.workspace_slug || org.workspaceSlug || '',
      financial_year: s.financial_year || org.pmsCalendar || 'April–March',
      custom_pms_start_date: s.custom_pms_start_date || org.customPmsStartDate || '',
      custom_pms_end_date: s.custom_pms_end_date || org.customPmsEndDate || '',
      hr_admin_name: s.hr_admin_name || org.hrAdminName || '',
      hr_admin_email: s.hr_admin_email || org.hrAdminEmail || '',
      temporary_password: s.temporary_password || org.temporaryPassword || '',
    };
  }

  function setField(key, value) {
    setForm(prev => ({ ...prev, [key]: value }));
    setFeedback('');
  }

  // Code helpers
  function getExistingCodes() {
    const set = new Set();
    orgs.forEach((o) => {
      if (isEdit && o.key === editKey) return;
      const tenantKey = normalizeCode(o.key || '');
      const orgCode = normalizeCode(o.orgCode || '');
      if (tenantKey) set.add(tenantKey);
      if (orgCode) set.add(orgCode);
    });
    return set;
  }

  function getExistingSlugs() {
    const set = new Set();
    orgs.forEach(o => { if (isEdit && o.key === editKey) return; set.add(String(o.domain || '').split('.')[0].toLowerCase()); });
    return set;
  }

  function validateCode(code) {
    const v = normalizeCode(code);
    if (!v) return { ok: false, msg: 'Org Code is required.' };
    if (v.length < 2) return { ok: false, msg: 'Org Code must be at least 2 characters.' };
    if (getExistingCodes().has(v)) return { ok: false, msg: 'This Org Code is already in use.' };
    return { ok: true, msg: 'Org Code is available.' };
  }

  function validateSlug(slug) {
    const v = String(slug || '').trim();
    if (!v) return { ok: false, msg: 'Workspace slug is required.' };
    if (!/^[a-z0-9-]+$/.test(v)) return { ok: false, msg: 'Use lowercase letters, numbers, and hyphens only.' };
    if (/--/.test(v) || v.startsWith('-') || v.endsWith('-')) return { ok: false, msg: 'Slug cannot start/end with hyphen or have repeated hyphens.' };
    if (getExistingSlugs().has(v)) return { ok: false, msg: 'This slug is already in use.' };
    return { ok: true, msg: 'Slug is available.' };
  }

  function handleNameInput(value) {
    setFeedback('');
    if (!codeManual) {
      const code = genCodeFromName(value);
      setForm(prev => ({ ...prev, organization_name: value, organization_code: code, ...(!slugManual ? { workspace_slug: slugify(value) } : {}) }));
    } else if (!slugManual) {
      // code is manual but slug still follows name
      setForm(prev => ({ ...prev, organization_name: value, workspace_slug: slugify(value) }));
    } else {
      setForm(prev => ({ ...prev, organization_name: value }));
    }
  }

  function handleCodeInput(value) {
    setCodeManual(true);
    const code = normalizeCode(value);
    setForm(prev => ({ ...prev, organization_code: code, ...(!slugManual ? { workspace_slug: slugify(code) } : {}) }));
  }

  function handleSlugInput(value) {
    setSlugManual(true);
    setField('workspace_slug', normalizeSlug(value));
  }

  function validateStep0(showErr = false) {
    const nameOk = Boolean((form.organization_name || '').trim());
    const codeCheck = validateCode(form.organization_code || '');
    const slugCheck = validateSlug(form.workspace_slug || '');
    const fyOk = Boolean((form.financial_year || '').trim());
    const isCustom = form.financial_year === 'Custom';
    const customOk = !isCustom || (form.custom_pms_start_date && form.custom_pms_end_date);
    const rangeOk  = !isCustom || (form.custom_pms_end_date >= form.custom_pms_start_date);
    if (showErr) {
      if (!nameOk) { setFeedback('Organization name is required.'); return false; }
      if (!codeCheck.ok) { setFeedback(codeCheck.msg); return false; }
      if (!slugCheck.ok) { setFeedback(slugCheck.msg); return false; }
      if (!fyOk) { setFeedback('Select a PMS calendar option.'); return false; }
      if (!customOk) { setFeedback('Custom calendar requires both start and end dates.'); return false; }
      if (!rangeOk)  { setFeedback('End date must be on or after start date.'); return false; }
    }
    return nameOk && codeCheck.ok && slugCheck.ok && fyOk && customOk && rangeOk;
  }

  function validateStep1(showErr = false) {
    const adminNameOk = Boolean((form.hr_admin_name || '').trim());
    const adminEmailOk = isEmail(form.hr_admin_email);
    if (showErr) {
      if (!adminNameOk) { setFeedback('HR admin name is required.'); return false; }
      if (!adminEmailOk) { setFeedback('Enter a valid HR admin email address.'); return false; }
    }
    return adminNameOk && adminEmailOk;
  }

  function buildOrg() {
    const orgName = (form.organization_name || '').trim() || 'New Organization';
    const requestedOrgCode = normalizeCode(form.organization_code || genCodeFromName(orgName) || 'org');
    const tenantKey = existingOrg ? normalizeCode(existingOrg.key || existingOrg.orgCode || '') : requestedOrgCode;
    const orgCode = existingOrg ? normalizeCode(existingOrg.orgCode || existingOrg.key || '') : requestedOrgCode;
    const slugRaw = (form.workspace_slug || tenantKey).toLowerCase().replace(/[^a-z0-9-]/g,'').replace(/-+/g,'-').replace(/^-|-$/g,'') || `org-${Date.now().toString().slice(-4)}`;
    const industry = existingOrg?.industry || 'Other';
    const logoText = (orgName[0] || 'N').toUpperCase();
    const hrAdminName  = (form.hr_admin_name || '').trim();
    const hrAdminEmail = (form.hr_admin_email || '').trim().toLowerCase();
    const temporaryPassword = form.temporary_password || generateTempPassword();
    const snapshot = { ...form, workspace_slug: slugRaw };

    return {
      ...(existingOrg || {}),
      key: tenantKey,
      orgCode,
      name: orgName,
      domain: `${slugRaw}.zarohr.com`,
      industry,
      industryBadgeClass: existingOrg?.industryBadgeClass || 'badge-gray',
      employees: existingOrg ? existingOrg.employees : 0,
      setupPct: existingOrg ? existingOrg.setupPct : 5,
      setupColor: existingOrg ? existingOrg.setupColor : '#2563EB',
      status: existingOrg ? existingOrg.status : 'Setup',
      statusBadgeClass: existingOrg ? existingOrg.statusBadgeClass : 'badge-amber',
      actionLabel: existingOrg ? existingOrg.actionLabel : 'Continue',
      workspaceSlug: slugRaw,
      pmsCalendar: form.financial_year || '',
      customPmsStartDate: form.custom_pms_start_date || '',
      customPmsEndDate: form.custom_pms_end_date || '',
      selectedModules: [...modules],
      setupFormSnapshot: snapshot,
      hrAdminName,
      hrAdminEmail,
      temporaryPassword,
      logoText,
      logoBg: existingOrg ? existingOrg.logoBg : 'linear-gradient(135deg,#3B82F6,#2563EB)',
    };
  }

  function handleBack() {
    setFeedback('');
    if (step > 0) { setStep(s => s - 1); return; }
    if (!isEdit) clearDraft();
    window.location.hash = '#organizations';
  }

  function handleNext() {
    setFeedback('');
    if (step === 0 && !validateStep0(true)) return;
    if (step === 1 && !validateStep1(true)) return;
    if (step < STEPS.length - 1) {
      setStep(s => s + 1);
      return;
    }

    if (isEdit && !isDirty) {
      window.location.hash = '#organizations';
      return;
    }

    setSaving(true);
    setTimeout(async () => {
      const nextOrg = buildOrg();

      // Merge additional admins as Co-Admins on org.hrTeam, preserving any
      // pre-existing entries (e.g. PMS-employee co-admins from edit mode).
      const existingHrTeam = Array.isArray(nextOrg.hrTeam) ? nextOrg.hrTeam : [];
      const additionalEntries = additionalAdmins
        .filter((a) => String(a.email || '').trim() && String(a.name || '').trim())
        .map((a) => ({
          id: a.id || `co_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          type: 'co-admin',
          name: a.name.trim(),
          email: a.email.trim().toLowerCase(),
          empCode: null,
          isInPMS: false,
          password: a.password || generateTempPassword(),
          isTemp: true,
        }));
      // Drop any inline-co-admins (non-PMS) we previously stored, so re-edits replace cleanly.
      const preserved = existingHrTeam.filter((m) => !(m.type === 'co-admin' && !m.isInPMS));
      nextOrg.hrTeam = [...preserved, ...additionalEntries];

      const persisted = await saveOrganizationRecord(nextOrg);
      if (!persisted.ok) {
        setSaving(false);
        setFeedback(persisted.error || 'Failed to save organization in backend.');
        return;
      }

      if (existingOrg) {
        applyAppData((current) => ({
          orgs: current.orgs.map((o) => (o.key === editKey ? nextOrg : o)),
          feedData: current.feedData,
          pendingActions: current.pendingActions,
          dashboardFlags: current.dashboardFlags,
        }));
      } else {
        applyAppData((current) => ({ orgs: [nextOrg, ...current.orgs] }));
      }

      clearDraft();
      setSaving(false);
      window.location.hash = '#organizations';
    }, 900);
  }

  const step0Valid = validateStep0(false);
  const step1Valid = validateStep1(false);
  const nextDisabled = ((step === 0 && !step0Valid) || (step === 1 && !step1Valid) || saving)
    && !(isEdit && !isDirty && step === STEPS.length - 1);

  const codeCheck = validateCode(form.organization_code || '');
  const slugCheck = validateSlug(form.workspace_slug || '');

  const title = isEdit ? 'Edit Organization' : 'Create Organization';
  const subtitle = isEdit
    ? 'Update workspace settings and admin access.'
    : 'Create the PMS workspace and send admin access.';

  return (
    <AdminShell title={title} page="organizations">
      <div className="create-org-shell">
        <h1 className="create-org-title">{title}</h1>
        <p className="create-org-sub">{subtitle}</p>

        {/* Step indicators */}
        <div className="create-org-steps">
          {STEPS.map((label, i) => {
            let cls = 'create-org-step';
            if (i === step) cls += ' active';
            else if (i < step) cls += ' done';
            const canClick = isEdit || i < step;
            return (
              <div
                key={i}
                className={cls}
                onClick={() => { if (canClick) { setFeedback(''); setStep(i); } }}
                style={{ cursor: canClick ? 'pointer' : 'default' }}
              >
                <span className="num">{i < step ? '✓' : i + 1}</span>
                <span>{label}</span>
              </div>
            );
          })}
        </div>

        {/* Feedback */}
        <div className="create-org-feedback">{feedback}</div>

        <div className="card create-org-card">
          <div className="create-org-body">
            {step === 0 && (
              <StepWorkspace
                isEdit={isEdit}
                form={form}
                onNameInput={handleNameInput}
                onCodeInput={handleCodeInput}
                setField={setField}
                codeCheck={codeCheck}
                onSlugInput={handleSlugInput}
                slugCheck={slugCheck}
              />
            )}
            {step === 1 && (
              <Step2
                form={form}
                setField={setField}
                additionalAdmins={additionalAdmins}
                setAdditionalAdmins={setAdditionalAdmins}
              />
            )}
          </div>
          <div className="create-org-actions">
            <button className="btn btn-secondary" onClick={handleBack} disabled={saving}>
              {step === 0 ? 'Cancel' : 'Back'}
            </button>
            <button className="btn btn-primary" onClick={handleNext} disabled={nextDisabled}>
              {saving
                ? 'Saving…'
                : step === STEPS.length - 1
                  ? (isEdit ? (isDirty ? 'Save Changes' : 'Done') : 'Create Organization')
                  : (isEdit ? 'Next' : 'Continue')}
            </button>
          </div>
        </div>
      </div>
    </AdminShell>
  );
}

function StepWorkspace({ isEdit, form, onNameInput, onCodeInput, setField, codeCheck, onSlugInput, slugCheck }) {
  const isCustom = form.financial_year === 'Custom';

  function formatDatePreview(v) {
    if (!v) return '';
    const d = new Date(`${v}T00:00:00`);
    if (isNaN(d.getTime())) return v;
    return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
  }

  const calendarOptions = [
    { id: 'April–March',       icon: '📅', title: 'April – March', desc: 'Indian financial year (Apr 1 – Mar 31)' },
    { id: 'January–December',  icon: '🗓', title: 'January – December', desc: 'Calendar year (Jan 1 – Dec 31)' },
    { id: 'Custom',            icon: '⚙️', title: 'Custom', desc: 'Define a custom start and end date' },
  ];

  return (
    <div>
      <div className="ws-card">
        <div className="ws-card-title">Organization</div>
        <div className="wiz-grid">
          <div className="form-group">
            <label className="lbl">Organization Name <span className="req">*</span></label>
            <input type="text" value={form.organization_name || ''} placeholder="e.g. Acme Technologies"
              onChange={e => onNameInput(e.target.value)} />
          </div>
          <div className="form-group">
            <label className="lbl">Org Code <span className="req">*</span></label>
            <input type="text" value={form.organization_code || ''} placeholder="Auto from name"
              disabled={isEdit}
              onChange={e => onCodeInput(e.target.value)} />
            {form.organization_code && (
              <div className={`f-hint ${codeCheck.ok ? 'hint-ok' : 'hint-err'}`}>{codeCheck.msg}</div>
            )}
            <div className="f-hint" style={{ marginTop: 4, color: 'var(--ink-4)' }}>
              {isEdit
                ? 'Locked after creation because this is the backend tenant key.'
                : 'Used as the tenant key for this PMS workspace.'}
            </div>
          </div>
        </div>
      </div>

      <div className="ws-card">
        <div className="ws-card-title">Workspace Domain</div>
        <div className="form-group">
          <label className="lbl">Workspace Slug <span className="req">*</span></label>
          <div className="domain-input-wrap">
            <input
              type="text"
              className="domain-slug-input"
              value={form.workspace_slug || ''}
              placeholder="your-org"
              onChange={e => onSlugInput(e.target.value)}
            />
            <span className="domain-suffix">.zarohr.com</span>
          </div>
          <div className="domain-preview-box">
            <span className="domain-preview-label">Your workspace URL:</span>
            <span className="domain-preview-url">{form.workspace_slug ? `${form.workspace_slug}.zarohr.com` : <span style={{ color: 'var(--ink-4)' }}>yourorg.zarohr.com</span>}</span>
            {form.workspace_slug && (
              <span className={`domain-avail-badge ${slugCheck.ok ? 'avail-ok' : 'avail-err'}`}>
                {slugCheck.ok ? '✓ Available' : '✗ Unavailable'}
              </span>
            )}
          </div>
          {form.workspace_slug && !slugCheck.ok && (
            <div className="f-hint hint-err" style={{ marginTop: 4 }}>{slugCheck.msg}</div>
          )}
          <div className="f-hint" style={{ marginTop: 4, color: 'var(--ink-4)' }}>
            Only lowercase letters, numbers, and hyphens. This will be your organization's unique workspace address.
          </div>
        </div>
      </div>

      <div className="ws-card">
        <div className="ws-card-title">PMS Calendar</div>
        <div className="calendar-choice-grid">
          {calendarOptions.map(opt => (
            <div
              key={opt.id}
              className={`calendar-choice${form.financial_year === opt.id ? ' selected' : ''}`}
              onClick={() => setField('financial_year', opt.id)}
            >
              <div className="calendar-choice-badge">{opt.icon}</div>
              <div className="calendar-choice-title">{opt.title}</div>
              <div className="calendar-choice-desc">{opt.desc}</div>
              <div className="calendar-choice-check">✓</div>
            </div>
          ))}
        </div>

        {isCustom && (
          <div className="calendar-custom-panel">
            <div className="calendar-custom-head">Custom Date Range</div>
            <div className="calendar-custom-sub">Set your organization's fiscal year start and end dates.</div>
            <div className="wiz-grid">
              <div className="form-group">
                <label className="lbl">Start Date</label>
                <input type="date" value={form.custom_pms_start_date || ''}
                  onChange={e => setField('custom_pms_start_date', e.target.value)} />
              </div>
              <div className="form-group">
                <label className="lbl">End Date</label>
                <input type="date" value={form.custom_pms_end_date || ''}
                  onChange={e => setField('custom_pms_end_date', e.target.value)} />
              </div>
            </div>
            {form.custom_pms_start_date && form.custom_pms_end_date && (
              <div className="calendar-range-preview">
                📆 {formatDatePreview(form.custom_pms_start_date)} → {formatDatePreview(form.custom_pms_end_date)}
              </div>
            )}
          </div>
        )}
      </div>

    </div>
  );
}

function Step2({ form, setField, additionalAdmins, setAdditionalAdmins }) {
  function addAdmin() {
    setAdditionalAdmins((prev) => [...prev, { id: `co_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`, name: '', email: '', password: '' }]);
  }
  function updateAdmin(id, patch) {
    setAdditionalAdmins((prev) => prev.map((a) => (a.id === id ? { ...a, ...patch } : a)));
  }
  function removeAdmin(id) {
    setAdditionalAdmins((prev) => prev.filter((a) => a.id !== id));
  }

  return (
    <div>
      <div className="ws-card">
        <div className="ws-card-title">HR Administrator</div>
        <div className="wiz-grid">
          <div className="form-group">
            <label className="lbl">Full Name <span className="req">*</span></label>
            <input type="text" value={form.hr_admin_name || ''} placeholder="e.g. Priya Sharma"
              onChange={e => setField('hr_admin_name', e.target.value)} />
          </div>
          <div className="form-group">
            <label className="lbl">Email Address <span className="req">*</span></label>
            <input type="email" value={form.hr_admin_email || ''} placeholder="hr@company.com"
              onChange={e => setField('hr_admin_email', e.target.value)} />
          </div>
        </div>
        <div className="wiz-full">
          <div className="form-group">
            <label className="lbl">Temporary Password <span style={{ fontWeight: 400, color: '#94A3B8' }}>(auto-generated if blank)</span></label>
            <input type="text" value={form.temporary_password || ''} placeholder="leave blank to auto-generate"
              onChange={e => setField('temporary_password', e.target.value)} />
          </div>
        </div>
        <div className="banner banner-blue" style={{ marginTop: 12, marginBottom: 16 }}>
          <span>ℹ️</span>
          <span>Invite emails are not sent automatically. Use <strong>Communications</strong> to review and send admin access emails manually.</span>
        </div>
      </div>

      <div className="ws-card">
        <div className="ws-card-title">Additional admins (Co-Admins)</div>
        <div style={{ fontSize: 12.5, color: '#64748B', marginTop: -6, marginBottom: 14 }}>
          Optional. Add as many Co-Admins as you like. Each can receive an invite manually from Communications and gets full HR-admin access.
        </div>
        {additionalAdmins.length === 0 && (
          <div style={{ border: '1.5px dashed #E2E8F0', borderRadius: 10, padding: 16, textAlign: 'center', color: '#94A3B8', fontSize: 13, marginBottom: 12 }}>
            No additional admins. Just the primary HR Admin will receive the invite.
          </div>
        )}
        {additionalAdmins.map((a, idx) => (
          <div key={a.id} style={{ border: '1.5px solid #E2E8F0', borderRadius: 10, padding: '12px 14px', marginBottom: 10, background: '#FAFBFF' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
              <div style={{ fontSize: 12.5, fontWeight: 700, color: '#475569' }}>Co-Admin #{idx + 1}</div>
              <button type="button" onClick={() => removeAdmin(a.id)}
                style={{ padding: '4px 10px', background: '#fff', color: '#DC2626', border: '1.5px solid #FECACA', borderRadius: 7, fontSize: 11.5, cursor: 'pointer', fontFamily: 'inherit', fontWeight: 600 }}>Remove</button>
            </div>
            <div className="wiz-grid">
              <div className="form-group">
                <label className="lbl">Full Name</label>
                <input type="text" value={a.name} placeholder="e.g. Aman Verma"
                  onChange={(e) => updateAdmin(a.id, { name: e.target.value })} />
              </div>
              <div className="form-group">
                <label className="lbl">Email Address</label>
                <input type="email" value={a.email} placeholder="coadmin@company.com"
                  onChange={(e) => updateAdmin(a.id, { email: e.target.value.toLowerCase() })} />
              </div>
            </div>
            <div className="wiz-full">
              <div className="form-group">
                <label className="lbl">Temporary Password <span style={{ fontWeight: 400, color: '#94A3B8' }}>(auto-generated if blank)</span></label>
                <input type="text" value={a.password} placeholder="leave blank to auto-generate"
                  onChange={(e) => updateAdmin(a.id, { password: e.target.value })} />
              </div>
            </div>
          </div>
        ))}
        <button type="button" onClick={addAdmin}
          style={{ padding: '8px 14px', background: '#EEF2FF', color: '#4338CA', border: '1.5px solid #C7D2FE', borderRadius: 8, fontSize: 12.5, cursor: 'pointer', fontFamily: 'inherit', fontWeight: 700 }}>
          + Add Co-Admin
        </button>
      </div>
    </div>
  );
}
