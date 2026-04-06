import { useState, useEffect, useCallback } from 'react';
import AdminShell from '../components/AdminShell';
import { useApp } from '../AppContext';
import '../admin.css';

const COUNTRY_OPTIONS = [
  'Afghanistan','Albania','Algeria','Argentina','Australia','Austria','Bangladesh','Belgium','Brazil','Canada',
  'Chile','China','Colombia','Croatia','Czech Republic','Denmark','Egypt','Finland','France','Germany',
  'Greece','Hong Kong','Hungary','India','Indonesia','Ireland','Israel','Italy','Japan','Kenya',
  'Malaysia','Mexico','Morocco','Netherlands','New Zealand','Nigeria','Norway','Pakistan','Philippines','Poland',
  'Portugal','Qatar','Romania','Saudi Arabia','Singapore','South Africa','South Korea','Spain','Sri Lanka','Sweden',
  'Switzerland','Taiwan','Thailand','Turkey','UAE','Ukraine','United Kingdom','United States','Vietnam',
];

const INDUSTRY_OPTIONS = [
  'IT / Software',
  'BFSI (Banking, Financial Services, Insurance)',
  'Healthcare & Pharma',
  'Manufacturing',
  'Retail & E-commerce',
  'Consulting / Professional Services',
  'Education / EdTech',
  'Telecom',
  'Media & Entertainment',
  'Logistics & Supply Chain',
  'Real Estate / Construction',
  'Energy / Utilities',
  'Hospitality / Travel',
  'Government / Public Sector',
  'Non-Profit / NGO',
  'Other',
];

const MODULES = [
  { id: 'Performance Management', name: 'Performance Management', desc: 'Core appraisal cycles and ratings', locked: true, icon: '🎯' },
  { id: 'Goal Management',        name: 'Goal Management',        desc: 'KRA / KPI libraries and goal tracking', locked: false, icon: '📋' },
  { id: '360 Feedback',           name: '360 Feedback',           desc: 'Peer and multi-rater assessments', locked: false, icon: '🔄' },
  { id: 'Compensation Planning',  name: 'Compensation Planning',  desc: 'Pay reviews and salary adjustments', locked: false, icon: '💰' },
  { id: 'Succession Planning',    name: 'Succession Planning',    desc: 'Talent pipeline and career pathing', locked: false, icon: '📈' },
  { id: 'Learning & Development', name: 'Learning & Development', desc: 'Training plans and skill tracking', locked: false, icon: '📚' },
];

const STEPS = ['Organization Details', 'Workspace Settings', 'HR Admin Setup'];

function buildEditSnapshot(form, modules) {
  const normalizedCountries = Array.isArray(form?.operating_countries)
    ? [...form.operating_countries].filter(Boolean).sort((left, right) => left.localeCompare(right))
    : [];
  const normalizedModules = Array.isArray(modules)
    ? [...modules].filter(Boolean).sort((left, right) => left.localeCompare(right))
    : [];

  return JSON.stringify({
    organization_name: String(form?.organization_name || '').trim(),
    organization_code: normalizeCode(form?.organization_code || ''),
    industry: String(form?.industry || '').trim(),
    legal_entity_type: String(form?.legal_entity_type || '').trim(),
    headquarters_country: String(form?.headquarters_country || '').trim(),
    operating_countries: normalizedCountries,
    company_website: String(form?.company_website || '').trim(),
    workspace_slug: normalizeSlug(form?.workspace_slug || ''),
    financial_year: String(form?.financial_year || '').trim(),
    custom_pms_start_date: String(form?.custom_pms_start_date || '').trim(),
    custom_pms_end_date: String(form?.custom_pms_end_date || '').trim(),
    estimated_company_size: String(form?.estimated_company_size || '').trim(),
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

function genCodeFromName(name) {
  const stop = new Set(['pvt','ltd','limited','inc','llc','plc','private','company','co','technologies','technology','solutions','services','global','group']);
  const words = String(name || '').toLowerCase().replace(/[^a-z0-9\s]/g,' ').split(/\s+/).filter(Boolean).filter(w => !stop.has(w));
  return words.length ? normalizeCode(words[0]) : '';
}

function industryBadgeClass(industry) {
  if (!industry) return 'badge-gray';
  if (industry.startsWith('IT')) return 'badge-blue';
  if (industry.startsWith('Healthcare')) return 'badge-green';
  if (industry.startsWith('BFSI')) return 'badge-amber';
  return 'badge-gray';
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
  const { orgs, setOrgs } = useApp();

  const editKey = getHashParam('key');
  const isEdit  = Boolean(editKey);
  const existingOrg = isEdit ? orgs.find(o => o.key === editKey) : null;

  // For create mode: restore any in-progress draft from sessionStorage
  const _d = !isEdit ? readDraft() : null;

  const [step, setStep]     = useState(() => _d?.step ?? 0);
  const [form, setForm]     = useState(() => _d?.form ?? initForm(existingOrg));
  const [modules, setModules] = useState(() => _d?.modules ?? initModules(existingOrg));
  const [slugManual, setSlugManual]   = useState(() => _d?.slugManual ?? isEdit);
  const [codeManual, setCodeManual]   = useState(() => _d?.codeManual ?? isEdit);
  const [feedback, setFeedback]       = useState('');
  const [saving, setSaving]           = useState(false);
  const initialSnapshot = buildEditSnapshot(initForm(existingOrg), initModules(existingOrg));
  const currentSnapshot = buildEditSnapshot(form, modules);
  const isDirty = !isEdit || currentSnapshot !== initialSnapshot;

  // Auto-save draft to sessionStorage whenever form state changes (create mode only)
  useEffect(() => {
    if (isEdit) return;
    try {
      window.sessionStorage.setItem(DRAFT_KEY, JSON.stringify({ step, form, modules, slugManual, codeManual }));
    } catch (_) {}
  }, [step, form, modules, slugManual, codeManual, isEdit]);

  function initForm(org) {
    if (!org) return { headquarters_country: 'India', operating_countries: [] };
    const s = org.setupFormSnapshot || {};
    return {
      organization_name: s.organization_name || org.name || '',
      organization_code: s.organization_code || normalizeCode(org.orgCode || ''),
      industry: s.industry || org.industry || '',
      legal_entity_type: s.legal_entity_type || org.legalEntityType || '',
      headquarters_country: s.headquarters_country || org.headquartersCountry || 'India',
      operating_countries: Array.isArray(s.operating_countries) ? [...s.operating_countries] : Array.isArray(org.operatingCountries) ? [...org.operatingCountries] : [],
      company_website: s.company_website || org.companyWebsite || '',
      workspace_slug: s.workspace_slug || org.workspaceSlug || '',
      financial_year: s.financial_year || org.pmsCalendar || '',
      custom_pms_start_date: s.custom_pms_start_date || org.customPmsStartDate || '',
      custom_pms_end_date: s.custom_pms_end_date || org.customPmsEndDate || '',
      estimated_company_size: s.estimated_company_size || org.estimatedCompanySize || '',
      hr_admin_name: s.hr_admin_name || org.hrAdminName || '',
      hr_admin_email: s.hr_admin_email || org.hrAdminEmail || '',
      temporary_password: s.temporary_password || org.temporaryPassword || '',
    };
  }

  function initModules(org) {
    if (!org || !Array.isArray(org.selectedModules)) return ['Performance Management'];
    const has = org.selectedModules.includes('Performance Management') ? org.selectedModules : ['Performance Management', ...org.selectedModules];
    return has;
  }

  function setField(key, value) {
    setForm(prev => ({ ...prev, [key]: value }));
    setFeedback('');
  }

  // Code helpers
  function getExistingCodes() {
    const set = new Set();
    orgs.forEach(o => { if (isEdit && o.key === editKey) return; set.add(normalizeCode(o.orgCode || o.key || '')); });
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

  function addCountry(value) {
    if (!value) return;
    const list = Array.isArray(form.operating_countries) ? form.operating_countries : [];
    if (list.includes(value)) return;
    setField('operating_countries', [...list, value]);
  }

  function removeCountry(c) {
    setField('operating_countries', (form.operating_countries || []).filter(x => x !== c));
  }

  function toggleModule(id) {
    if (id === 'Performance Management') return; // locked
    setModules(prev => prev.includes(id) ? prev.filter(m => m !== id) : [...prev, id]);
  }

  function validateStep0(showErr = false) {
    const nameOk = Boolean((form.organization_name || '').trim());
    const codeCheck = validateCode(form.organization_code || '');
    if (showErr && !nameOk) { setFeedback('Organization name is required.'); return false; }
    if (showErr && !codeCheck.ok) { setFeedback(codeCheck.msg); return false; }
    return nameOk && codeCheck.ok;
  }

  function validateStep1(showErr = false) {
    const slugCheck = validateSlug(form.workspace_slug || '');
    const fyOk = Boolean((form.financial_year || '').trim());
    const isCustom = form.financial_year === 'Custom';
    const customOk = !isCustom || (form.custom_pms_start_date && form.custom_pms_end_date);
    const rangeOk  = !isCustom || (form.custom_pms_end_date >= form.custom_pms_start_date);
    if (showErr) {
      if (!slugCheck.ok) { setFeedback(slugCheck.msg); return false; }
      if (!fyOk) { setFeedback('Select a PMS calendar option.'); return false; }
      if (!customOk) { setFeedback('Custom calendar requires both start and end dates.'); return false; }
      if (!rangeOk)  { setFeedback('End date must be on or after start date.'); return false; }
    }
    return slugCheck.ok && fyOk && customOk && rangeOk;
  }

  function buildOrg() {
    const orgName = (form.organization_name || '').trim() || 'New Organization';
    const orgCode = normalizeCode(form.organization_code || genCodeFromName(orgName) || 'ORG');
    const slugRaw = (form.workspace_slug || orgCode).toLowerCase().replace(/[^a-z0-9-]/g,'').replace(/-+/g,'-').replace(/^-|-$/g,'') || `org-${Date.now().toString().slice(-4)}`;
    const industry = form.industry || 'Other';
    const logoText = (orgName[0] || 'N').toUpperCase();
    const hrAdminName  = (form.hr_admin_name || '').trim();
    const hrAdminEmail = (form.hr_admin_email || '').trim().toLowerCase();
    const temporaryPassword = form.temporary_password || '';
    const snapshot = { ...form, workspace_slug: slugRaw };

    return {
      ...(existingOrg || {}),
      key: existingOrg ? existingOrg.key : `org-${Date.now()}`,
      orgCode,
      name: orgName,
      domain: `${slugRaw}.zarohr.com`,
      industry,
      industryBadgeClass: industryBadgeClass(industry),
      employees: existingOrg ? existingOrg.employees : 0,
      seats: existingOrg ? existingOrg.seats : 200,
      setupPct: existingOrg ? existingOrg.setupPct : 5,
      setupColor: existingOrg ? existingOrg.setupColor : '#2563EB',
      status: existingOrg ? existingOrg.status : 'Setup',
      statusBadgeClass: existingOrg ? existingOrg.statusBadgeClass : 'badge-amber',
      actionLabel: existingOrg ? existingOrg.actionLabel : 'Continue',
      legalEntityType: form.legal_entity_type || '',
      headquartersCountry: form.headquarters_country || 'India',
      operatingCountries: Array.isArray(form.operating_countries) ? [...form.operating_countries] : [],
      companyWebsite: form.company_website || '',
      workspaceSlug: slugRaw,
      pmsCalendar: form.financial_year || '',
      customPmsStartDate: form.custom_pms_start_date || '',
      customPmsEndDate: form.custom_pms_end_date || '',
      estimatedCompanySize: form.estimated_company_size || '',
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
    setTimeout(() => {
      const nextOrg = buildOrg();
      if (existingOrg) {
        setOrgs(orgs.map(o => o.key === editKey ? nextOrg : o));
      } else {
        setOrgs([nextOrg, ...orgs]);
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
    ? 'Update organization details, workspace settings, and assigned HR administrator.'
    : 'Set up a new company workspace and assign its HR administrator.';

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
              <Step0
                form={form}
                onNameInput={handleNameInput}
                onCodeInput={handleCodeInput}
                setField={setField}
                codeCheck={codeCheck}
                addCountry={addCountry}
                removeCountry={removeCountry}
              />
            )}
            {step === 1 && (
              <Step1
                form={form}
                setField={setField}
                onSlugInput={handleSlugInput}
                slugCheck={slugCheck}
              />
            )}
            {step === 2 && (
              <Step2
                form={form}
                setField={setField}
                modules={modules}
                toggleModule={toggleModule}
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

function Step0({ form, onNameInput, onCodeInput, setField, codeCheck, addCountry, removeCountry }) {
  return (
    <div>
      <div className="wiz-grid">
        <div className="form-group">
          <label className="lbl">Organization Name <span className="req">*</span></label>
          <input type="text" value={form.organization_name || ''} placeholder="e.g. Acme Technologies Pvt. Ltd."
            onChange={e => onNameInput(e.target.value)} />
        </div>
        <div className="form-group">
          <label className="lbl">Org Code (Tenant Identifier) <span className="req">*</span></label>
          <input type="text" value={form.organization_code || ''} placeholder="Auto from name"
            onChange={e => onCodeInput(e.target.value)} />
          {form.organization_code && (
            <div className={`f-hint ${codeCheck.ok ? 'hint-ok' : 'hint-err'}`}>{codeCheck.msg}</div>
          )}
        </div>
      </div>

      <div className="wiz-grid">
        <div className="form-group">
          <label className="lbl">Industry</label>
          <select value={form.industry || ''} onChange={e => setField('industry', e.target.value)}>
            <option value="">Select industry</option>
            {INDUSTRY_OPTIONS.map(opt => <option key={opt} value={opt}>{opt}</option>)}
          </select>
        </div>
        <div className="form-group">
          <label className="lbl">Legal Entity Type</label>
          <select value={form.legal_entity_type || ''} onChange={e => setField('legal_entity_type', e.target.value)}>
            <option value="">Select legal entity</option>
            {['Private Limited','Public Limited','LLP','Partnership','Proprietorship'].map(opt => <option key={opt} value={opt}>{opt}</option>)}
          </select>
        </div>
      </div>

      <div className="wiz-grid">
        <div className="form-group">
          <label className="lbl">Headquarters Country</label>
          <select value={form.headquarters_country || 'India'} onChange={e => setField('headquarters_country', e.target.value)}>
            {COUNTRY_OPTIONS.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
        <div className="form-group">
          <label className="lbl">Company Website</label>
          <input type="url" value={form.company_website || ''} placeholder="https://company.com"
            onChange={e => setField('company_website', e.target.value)} />
        </div>
      </div>

      <div className="wiz-full">
        <div className="form-group">
          <label className="lbl">Operating Countries</label>
          <select onChange={e => { addCountry(e.target.value); e.target.value = ''; }}>
            <option value="">Add a country…</option>
            {COUNTRY_OPTIONS.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
        {Array.isArray(form.operating_countries) && form.operating_countries.length > 0 && (
          <div className="selected-countries">
            {form.operating_countries.map(c => (
              <span key={c} className="country-pill">
                {c}
                <button type="button" onClick={() => removeCountry(c)}>×</button>
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function Step1({ form, setField, onSlugInput, slugCheck }) {
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

      <div className="ws-card">
        <div className="ws-card-title">Company Size</div>
        <div className="form-group">
          <label className="lbl">Estimated Company Size</label>
          <select value={form.estimated_company_size || ''} onChange={e => setField('estimated_company_size', e.target.value)}>
            <option value="">Select size range</option>
            {['1-50','51-100','101-200','201-500','501-1000','1001-5000','5000+'].map(s => <option key={s} value={s}>{s} employees</option>)}
          </select>
        </div>
      </div>
    </div>
  );
}

function Step2({ form, setField, modules, toggleModule }) {
  return (
    <div>
      <div className="ws-card">
        <div className="ws-card-title">Module Selection</div>
        <div className="create-mod-grid">
          {MODULES.map(mod => {
            const isSel = modules.includes(mod.id);
            const isLocked = mod.locked;
            let cls = 'create-mod-card';
            if (isLocked) cls += ' locked';
            else if (isSel) cls += ' sel';
            return (
              <div key={mod.id} className={cls} onClick={() => !isLocked && toggleModule(mod.id)}>
                <div className="create-mod-check">{(isLocked || isSel) ? '✓' : ''}</div>
                <div>
                  <div className="create-mod-name">{mod.icon} {mod.name}</div>
                  <div className="create-mod-desc">{mod.desc}{isLocked ? ' — included by default' : ''}</div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <div className="ws-card">
        <div className="ws-card-title">HR Administrator</div>
        <div className="wiz-grid">
          <div className="form-group">
            <label className="lbl">Full Name</label>
            <input type="text" value={form.hr_admin_name || ''} placeholder="e.g. Priya Sharma"
              onChange={e => setField('hr_admin_name', e.target.value)} />
          </div>
          <div className="form-group">
            <label className="lbl">Email Address</label>
            <input type="email" value={form.hr_admin_email || ''} placeholder="hr@company.com"
              onChange={e => setField('hr_admin_email', e.target.value)} />
          </div>
        </div>
        <div className="wiz-full">
          <div className="form-group">
            <label className="lbl">Temporary Password</label>
            <input type="text" value={form.temporary_password || ''} placeholder="e.g. Acme@2024"
              onChange={e => setField('temporary_password', e.target.value)} />
          </div>
        </div>
        <div className="banner banner-blue" style={{ marginTop: 12, marginBottom: 0 }}>
          <span>ℹ️</span>
          <span>An invitation email with login credentials will be sent to the HR Admin once the organization is created.</span>
        </div>
      </div>
    </div>
  );
}
