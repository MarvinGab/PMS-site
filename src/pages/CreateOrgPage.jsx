import { useState, useEffect } from 'react';
import AdminShell from '../components/AdminShell';
import { useApp } from '../AppContext';
import { callPms, PmsError } from '../backend/pmsClient';
import { buildWorkspaceUrl } from '../orgUtils';
import PhaseSettingsEditor from '../components/PhaseSettingsEditor';
import { defaultWindowsForFiscalYear, validateCycleWindows } from '../backend/cyclePhase';
import '../admin.css';

const PMS_MODULES = ['Performance Management'];

const STEPS = ['Workspace Setup', 'Cycle Calendar', 'Admin Access'];

// Seed range for the cycle calendar editor — Indian fiscal year of the current
// calendar year. The admin then drags windows to whatever real dates they want.
function resolveFiscalRange() {
  const year = new Date().getUTCFullYear();
  return { startsOn: `${year}-04-01`, endsOn: `${year + 1}-03-31` };
}

// Maps the wizard's nested phase-window shape (goalSetting/evaluation + their
// subPhases — see backend/cyclePhase.js) onto the flat WINDOW_KEYS the backend's
// `cycle.set-windows` understands (supabase/functions/pms-admin/cycles.ts). The
// calendar step here only collects these four sub-phases; the remaining backend
// window keys (hod_review, hr_calibration, publishing_prep, acknowledgement) have
// no UI in this wizard yet and are simply left unset — HR configures them later
// from the cycle setup screens. Windows the admin never dated are dropped rather
// than sent as empty/invalid ranges.
const WINDOW_KEY_MAP = [
  ['goal_creation', (w) => w?.goalSetting?.subPhases?.goalCreation],
  ['manager_approval', (w) => w?.goalSetting?.subPhases?.managerApproval],
  ['self_evaluation', (w) => w?.evaluation?.subPhases?.selfEvaluation],
  ['manager_evaluation', (w) => w?.evaluation?.subPhases?.managerEvaluation],
];

function buildWindowsPayload(windows) {
  if (!windows) return [];
  const out = [];
  for (const [key, getWindow] of WINDOW_KEY_MAP) {
    const win = getWindow(windows);
    const startsOn = win?.startsOn;
    const endsOn = win?.endsOn;
    if (!startsOn || !endsOn) continue;
    if (endsOn < startsOn) continue; // already enforced by validateCycleWindows; defensive only
    out.push({ key, startsOn, endsOn });
  }
  return out;
}

// Best-effort fiscal-year label derived from the calendar the admin actually set
// (falls back to the wizard's seed range if they never touched it). Only used to
// give the auto-created first cycle a readable name/period label — HR can rename
// it later from the cycle setup screens.
function buildPeriodLabel(windows) {
  const fallback = resolveFiscalRange();
  const startsOn = windows?.goalSetting?.startsOn || fallback.startsOn;
  const endsOn = windows?.evaluation?.endsOn || fallback.endsOn;
  const startYear = String(startsOn).slice(0, 4);
  const endYear = String(endsOn).slice(0, 4);
  return startYear === endYear ? `FY ${startYear}` : `FY ${startYear}-${endYear.slice(-2)}`;
}

function buildEditSnapshot(form, modules) {
  const normalizedModules = Array.isArray(modules)
    ? [...modules].filter(Boolean).sort((left, right) => left.localeCompare(right))
    : [];

  return JSON.stringify({
    organization_name: String(form?.organization_name || '').trim(),
    organization_code: normalizeCode(form?.organization_code || ''),
    workspace_slug: normalizeSlug(form?.workspace_slug || ''),
    cycle_phase_windows: form?.cycle_phase_windows || null,
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
  catch { return null; }
}

function clearDraft() {
  try { window.sessionStorage.removeItem(DRAFT_KEY); } catch { /* best effort */ }
}

export default function CreateOrgPage() {
  // `orgs` is the legacy local blob (kept alive for other still-unmigrated
  // pages) — used here ONLY as a best-effort source for the client-side
  // duplicate-code/slug hints below. The authoritative check happens on the
  // backend (`org.create` returns `ORG_KEY_TAKEN` if the key is really taken).
  const { orgs } = useApp();

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
  // Set once `org.create` succeeds, so a retry after a downstream failure
  // (e.g. cycle.set-windows) doesn't try to re-create the same org (which
  // would just 409 ORG_KEY_TAKEN) — it navigates to the directory instead.
  const [createdOrgId, setCreatedOrgId] = useState(null);
  // Additional admins added inline at org creation (Step 2, "Co-Admins"). UI-only
  // for now: creating/inviting HR-admin users (including these) is a later
  // sub-slice (5e-4) — see the HR Administrator step below for the deferral note.
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
    } catch { /* best effort */ }
  }, [step, form, slugManual, codeManual, isEdit]);

  function initForm(org) {
    if (!org) return {};
    const s = org.setupFormSnapshot || {};
    return {
      organization_name: s.organization_name || org.name || '',
      organization_code: s.organization_code || normalizeCode(org.orgCode || ''),
      workspace_slug: s.workspace_slug || org.workspaceSlug || '',
      // Live `org.cyclePhaseWindows` wins over `setupFormSnapshot` so that
      // HR-admin edits made via HRCycleDashboard show up here instead of being
      // shadowed by the (now-stale) snapshot captured at create-time.
      cycle_phase_windows: org.cyclePhaseWindows || s.cycle_phase_windows || null,
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
    orgs.forEach(o => {
      if (isEdit && o.key === editKey) return;
      const slug = String(o.workspaceSlug || '').trim().toLowerCase();
      if (slug) set.add(slug);
      const legacySlug = String(o.domain || '').split('.')[0].toLowerCase();
      if (legacySlug && legacySlug !== 'pms') set.add(legacySlug);
    });
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
    if (showErr) {
      if (!nameOk) { setFeedback('Organization name is required.'); return false; }
      if (!codeCheck.ok) { setFeedback(codeCheck.msg); return false; }
      if (!slugCheck.ok) { setFeedback(slugCheck.msg); return false; }
    }
    return nameOk && codeCheck.ok && slugCheck.ok;
  }

  function validateCalendarStep(showErr = false) {
    const windows = form.cycle_phase_windows;
    if (!windows) {
      if (showErr) setFeedback('Set the cycle phase calendar before continuing.');
      return false;
    }
    const check = validateCycleWindows(windows);
    if (!check.ok) {
      if (showErr) setFeedback(check.errors[0] || 'Fix the cycle calendar before continuing.');
      return false;
    }
    return true;
  }

  function validateAdminStep(showErr = false) {
    const adminNameOk = Boolean((form.hr_admin_name || '').trim());
    const adminEmailOk = isEmail(form.hr_admin_email);
    if (showErr) {
      if (!adminNameOk) { setFeedback('HR admin name is required.'); return false; }
      if (!adminEmailOk) { setFeedback('Enter a valid HR admin email address.'); return false; }
    }
    return adminNameOk && adminEmailOk;
  }

  // Auto-seed the calendar with smart defaults the first time the user
  // reaches the calendar step. They drag the windows from there.
  useEffect(() => {
    if (step !== 1) return;
    if (form.cycle_phase_windows) return;
    const defaults = defaultWindowsForFiscalYear(resolveFiscalRange());
    if (defaults) setForm((prev) => ({ ...prev, cycle_phase_windows: defaults }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  function handleBack() {
    setFeedback('');
    if (step > 0) { setStep(s => s - 1); return; }
    if (!isEdit) clearDraft();
    window.location.hash = '#organizations';
  }

  // Creates the org on the backend, then its first (draft) cycle, then the cycle's
  // phase windows if the admin set any on the Calendar step. Branding is skipped
  // entirely — this wizard's Workspace step collects no logo/brand-color/brand-name
  // fields, so there's nothing to send `org.set-branding`. HR-admin invite is
  // deferred (see the comment above the HR Administrator step below) — no backend
  // call is made for it here.
  async function submitCreate() {
    const orgName = (form.organization_name || '').trim() || 'New Organization';
    // The Org Code field is explicitly the backend tenant key (see its `f-hint`
    // copy and the fact it's locked in edit mode "because this is the backend
    // tenant key"). Workspace Slug remains a UI-only cosmetic field for now —
    // the backend has no separate slug column.
    const key = normalizeCode(form.organization_code || genCodeFromName(orgName) || 'org');
    // No framework picker exists in this wizard yet — every org created here
    // starts on the generic custom framework; HR can change it later from the
    // cycle setup screens.
    const frameworkId = 'custom';
    const windows = buildWindowsPayload(form.cycle_phase_windows);
    const periodLabel = buildPeriodLabel(form.cycle_phase_windows);
    const cycleName = `${orgName} ${periodLabel}`.trim();

    let organization;
    try {
      ({ organization } = await callPms('org.create', { key, name: orgName }));
    } catch (err) {
      setSaving(false);
      if (err instanceof PmsError && err.code === 'ORG_KEY_TAKEN') {
        setStep(0);
        setFeedback('That workspace key is already taken. Choose a different Org Code.');
      } else {
        setFeedback(err instanceof PmsError ? err.message : 'Failed to create organization. Please try again.');
      }
      return;
    }

    // The org now exists on the backend. Clear the draft and remember its id so a
    // retry after a downstream failure below doesn't try to re-create it (that
    // would just 409 ORG_KEY_TAKEN since the key is now taken by this very org).
    clearDraft();
    setCreatedOrgId(organization.id);

    try {
      const { cycle } = await callPms('cycle.create-draft', {
        orgId: organization.id, name: cycleName, periodLabel, frameworkId,
      });
      if (windows.length) {
        await callPms('cycle.set-windows', {
          orgId: organization.id, cycleId: cycle.id, cycleVersion: cycle.version, windows,
        });
      }
    } catch (err) {
      setSaving(false);
      const msg = err instanceof PmsError ? err.message : 'Something went wrong.';
      setFeedback(`Organization created, but the cycle calendar couldn't be saved: ${msg}. You can set it up later. Click "Continue to Organizations" to go to the directory.`);
      return;
    }

    setSaving(false);
    window.location.hash = '#organizations';
  }

  function handleNext() {
    setFeedback('');
    if (step === 0 && !validateStep0(true)) return;
    if (step === 1 && !validateCalendarStep(true)) return;
    if (step === 2 && !validateAdminStep(true)) return;
    if (step < STEPS.length - 1) {
      setStep(s => s + 1);
      return;
    }

    if (isEdit) {
      if (!isDirty) {
        window.location.hash = '#organizations';
        return;
      }
      // Editing an existing organization isn't wired to the live backend yet —
      // this task (Plan 5e-1 Task 3) only covers the CREATE path. `existingOrg`
      // still comes from the legacy local blob, not a real backend org/cycle id,
      // so there's nothing safe to write here. Say so plainly instead of
      // silently no-opping or calling the retired blob path.
      setFeedback("Editing organizations isn't connected to the live system yet. This is coming in a later update — create new organizations from the directory instead.");
      return;
    }

    if (createdOrgId) {
      // A previous attempt already created the org on the backend, but a later
      // step failed. Nothing left to retry from here — go see it in the directory.
      window.location.hash = '#organizations';
      return;
    }

    setSaving(true);
    void submitCreate();
  }

  const step0Valid = validateStep0(false);
  const calendarValid = validateCalendarStep(false);
  const adminValid = validateAdminStep(false);
  const nextDisabled = (
    (step === 0 && !step0Valid)
    || (step === 1 && !calendarValid)
    || (step === 2 && !adminValid)
    || saving
  ) && !(isEdit && !isDirty && step === STEPS.length - 1) && !(createdOrgId && step === STEPS.length - 1);

  const codeCheck = validateCode(form.organization_code || '');
  const slugCheck = validateSlug(form.workspace_slug || '');

  const title = isEdit ? 'Edit Organization' : 'Create Organization';

  return (
    <AdminShell title={title} page="organizations">
      <div className="create-org-shell">
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
                codeCheck={codeCheck}
                onSlugInput={handleSlugInput}
                slugCheck={slugCheck}
              />
            )}
            {step === 1 && (
              <StepCalendar
                form={form}
                setField={setField}
                isEdit={isEdit}
              />
            )}
            {step === 2 && (
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
                  ? (isEdit ? (isDirty ? 'Save Changes' : 'Done') : (createdOrgId ? 'Continue to Organizations' : 'Create Organization'))
                  : (isEdit ? 'Next' : 'Continue')}
            </button>
          </div>
        </div>
      </div>
    </AdminShell>
  );
}

function StepWorkspace({ isEdit, form, onNameInput, onCodeInput, codeCheck, onSlugInput, slugCheck }) {
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
        <div className="ws-card-title">Workspace Link</div>
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
            <span className="domain-suffix">on pms.zarohr.com</span>
          </div>
          <div className="domain-preview-box">
            <span className="domain-preview-label">Your workspace URL:</span>
            <span className="domain-preview-url">{form.workspace_slug ? buildWorkspaceUrl(form.workspace_slug) : <span style={{ color: 'var(--ink-4)' }}>pms.zarohr.com/yourorg</span>}</span>
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
            Only lowercase letters, numbers, and hyphens. This identifies the organization inside your PMS site.
          </div>
        </div>
      </div>

    </div>
  );
}

function StepCalendar({ form, setField, isEdit = false }) {
  const fiscalRange = resolveFiscalRange();
  return (
    <div className="step-pane">
      <div className="step-pane-head" style={{ marginBottom: 16 }}>
        <h2 style={{ margin: 0, fontSize: 18, fontWeight: 800, color: '#0F172A' }}>Cycle calendar</h2>
        <p style={{ margin: '6px 0 0', fontSize: 13, color: '#64748B', lineHeight: 1.55 }}>
          Tell the system when goal-setting and evaluation should open. Phases turn on and off automatically based on these dates — no manual flips required.
        </p>
      </div>
      <PhaseSettingsEditor
        value={form.cycle_phase_windows}
        onChange={(next) => setField('cycle_phase_windows', next)}
        fiscalYearStartsOn={fiscalRange.startsOn}
        fiscalYearEndsOn={fiscalRange.endsOn}
        skipLiveNotices={!isEdit}
      />
    </div>
  );
}

// "Admin Access" step — collects the HR admin's name/email (and optional inline
// Co-Admins), but does NOT create or invite any of these users yet. Creating/
// inviting HR-admin accounts is a later sub-slice (Plan 5e-4); the org is created
// without an invite. The "send the invite from Communications when ready" copy
// below stays as the interim signpost — nothing here calls a backend action, and
// none of `hr_admin_name`/`hr_admin_email`/`additionalAdmins` is sent anywhere by
// `submitCreate` above.
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
        <div className="banner banner-blue" style={{ marginTop: 12, marginBottom: 16 }}>
          <span>ℹ️</span>
          <span>A temporary password is auto-generated. Send the invite (and password) from <strong>Communications</strong> when ready.</span>
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
