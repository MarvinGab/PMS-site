import { useState, useMemo } from 'react';
import { useApp } from '../AppContext';
import { LaunchOverview } from '../PMSWizard';
import zaroLogo from '../../images/final zaro logo.png';

const WIZARD_STATE_KEY = 'zarohr_pms_wizard_state_v1';

const PHASES = [
  { id: 'goal-setting',       label: 'Goal Setting',      icon: '🎯', desc: 'Employees set KRAs / KPIs' },
  { id: 'mid-year-review',    label: 'Mid-Year Review',   icon: '📊', desc: 'Progress check-in' },
  { id: 'self-evaluation',    label: 'Self Evaluation',   icon: '✍️',  desc: 'Employee self-rating' },
  { id: 'manager-rating',     label: 'Manager Rating',    icon: '👤', desc: 'L1 / L2 manager scores' },
  { id: 'hr-review',          label: 'HR Review',         icon: '🔍', desc: 'Normalization & sign-off' },
  { id: 'results-published',  label: 'Results Published', icon: '🏆', desc: 'Final scores visible' },
];

function loadWizardConfig(orgKey) {
  try {
    const raw = localStorage.getItem(`${WIZARD_STATE_KEY}:${orgKey}`);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed?.config) return parsed.config;
    }
  } catch {}
  return null;
}

export default function HRCycleDashboard() {
  const { orgKey, orgs, setOrgs, logout } = useApp();
  const [showOverview, setShowOverview] = useState(false);

  const org = orgs.find((o) => o.key === orgKey) || {};
  const currentPhase = org.currentPhase || 'goal-setting';
  const phaseIdx = PHASES.findIndex((p) => p.id === currentPhase);

  const config = useMemo(() => loadWizardConfig(orgKey), [orgKey]);
  const workspace = useMemo(() => ({ orgKey, orgName: org.name || 'Organization' }), [orgKey, org.name]);

  const employees = config?.employeeUploadData?.employees || [];
  const totalKras = useMemo(() => {
    const lib = config?.goalLibraryData;
    if (!lib) return 0;
    const groups = lib.byAttr ? Object.values(lib.data || {}) : [lib.data || []];
    return groups.reduce((s, kras) => s + (kras || []).length, 0);
  }, [config]);

  function advancePhase() {
    if (phaseIdx >= PHASES.length - 1) return;
    const next = PHASES[phaseIdx + 1].id;
    setOrgs(orgs.map((o) => (o.key === orgKey ? { ...o, currentPhase: next } : o)));
  }

  function goBackToSetup() {
    setOrgs(orgs.map((o) => (o.key === orgKey ? { ...o, launched: false } : o)));
  }

  const isLastPhase = phaseIdx === PHASES.length - 1;

  return (
    <div style={{ minHeight: '100vh', background: '#F8FAFC', fontFamily: "'Geist','Inter','Segoe UI',Arial,sans-serif", fontSize: 14, color: '#0D1117' }}>

      {/* LAUNCH OVERVIEW MODAL */}
      {showOverview && config && (
        <LaunchOverview config={config} workspace={workspace} onClose={() => setShowOverview(false)} />
      )}

      {/* TOP BAR */}
      <div style={{ background: '#fff', borderBottom: '1.5px solid #E9EDF2', padding: '0 28px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', height: 56, position: 'sticky', top: 0, zIndex: 100 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <img src={zaroLogo} alt="Zaro HR" style={{ width: 30, height: 30, borderRadius: 8, objectFit: 'cover' }} />
          <div style={{ fontSize: 14, fontWeight: 700, color: '#0D1117' }}>
            Zaro <span style={{ color: '#FFBF00' }}>HR</span>
          </div>
          <div style={{ width: 1, height: 18, background: '#E2E8F0', margin: '0 6px' }} />
          <div style={{ fontSize: 13, color: '#6B7280' }}>Cycle Dashboard</div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 12px', background: '#F0FDF4', border: '1px solid #BBF7D0', borderRadius: 20 }}>
            <span style={{ width: 7, height: 7, borderRadius: '50%', background: '#22C55E', display: 'inline-block' }} />
            <span style={{ fontSize: 12, fontWeight: 600, color: '#16A34A' }}>Live</span>
          </div>
          <div style={{ fontSize: 13, fontWeight: 600, color: '#374151' }}>{org.name}</div>
          <button
            onClick={logout}
            style={{ padding: '6px 13px', border: '1.5px solid #E2E8F0', borderRadius: 7, fontSize: 12, cursor: 'pointer', background: '#fff', color: '#6B7280', fontFamily: 'inherit' }}
          >
            Sign out
          </button>
        </div>
      </div>

      <div style={{ maxWidth: 1060, margin: '0 auto', padding: '32px 20px 60px' }}>

        {/* HEADER CARD */}
        <div style={{ background: 'linear-gradient(135deg,#1E293B 0%,#0F172A 100%)', borderRadius: 16, padding: '28px 32px', marginBottom: 28, color: '#fff', display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 20, flexWrap: 'wrap' }}>
          <div>
            <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.1em', textTransform: 'uppercase', color: '#94A3B8', marginBottom: 8 }}>Appraisal Cycle · {org.pmsCalendar || 'Active'}</div>
            <div style={{ fontSize: 26, fontWeight: 800, marginBottom: 10, letterSpacing: '-.02em' }}>{org.name}</div>
            <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
              {[
                { label: `${employees.length} Employees`, icon: '👥' },
                { label: `${totalKras} KRAs`, icon: '📋' },
                { label: PHASES[phaseIdx]?.label, icon: PHASES[phaseIdx]?.icon },
              ].map((item) => (
                <div key={item.label} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: '#CBD5E1' }}>
                  <span>{item.icon}</span>
                  <span>{item.label}</span>
                </div>
              ))}
            </div>
          </div>
          <div style={{ display: 'flex', gap: 10, flexShrink: 0, flexWrap: 'wrap' }}>
            <button
              onClick={() => setShowOverview(true)}
              style={{ padding: '9px 18px', background: 'rgba(255,255,255,.1)', color: '#fff', border: '1px solid rgba(255,255,255,.2)', borderRadius: 9, fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' }}
            >
              📋 View Config Overview
            </button>
            <button
              onClick={goBackToSetup}
              style={{ padding: '9px 18px', background: 'rgba(255,255,255,.06)', color: '#94A3B8', border: '1px solid rgba(255,255,255,.12)', borderRadius: 9, fontSize: 13, fontWeight: 500, cursor: 'pointer', fontFamily: 'inherit' }}
            >
              ← Edit Setup
            </button>
          </div>
        </div>

        {/* PHASE TIMELINE */}
        <div style={{ background: '#fff', border: '1.5px solid #E9EDF2', borderRadius: 14, padding: '24px 28px', marginBottom: 24 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20, flexWrap: 'wrap', gap: 10 }}>
            <div>
              <div style={{ fontSize: 13, fontWeight: 700, color: '#0D1117', marginBottom: 2 }}>Appraisal Phases</div>
              <div style={{ fontSize: 12, color: '#9CA3AF' }}>Current phase: <strong style={{ color: '#2563EB' }}>{PHASES[phaseIdx]?.label}</strong></div>
            </div>
            {!isLastPhase && (
              <button
                onClick={advancePhase}
                style={{ padding: '9px 20px', background: '#2563EB', color: '#fff', border: 'none', borderRadius: 9, fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' }}
              >
                Advance to {PHASES[phaseIdx + 1]?.label} →
              </button>
            )}
            {isLastPhase && (
              <div style={{ padding: '8px 16px', background: '#F0FDF4', border: '1px solid #BBF7D0', borderRadius: 9, fontSize: 13, fontWeight: 600, color: '#16A34A' }}>
                🏆 Cycle Complete
              </div>
            )}
          </div>

          {/* Phase steps */}
          <div style={{ display: 'flex', gap: 0, overflowX: 'auto', paddingBottom: 4 }}>
            {PHASES.map((phase, i) => {
              const isDone    = i < phaseIdx;
              const isActive  = i === phaseIdx;
              const isPending = i > phaseIdx;
              return (
                <div key={phase.id} style={{ display: 'flex', alignItems: 'center', flex: 1, minWidth: 120 }}>
                  <div style={{ flex: 1, textAlign: 'center' }}>
                    <div style={{
                      width: 42, height: 42, borderRadius: '50%', margin: '0 auto 8px',
                      display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 18,
                      background: isDone ? '#16A34A' : isActive ? '#2563EB' : '#F1F5F9',
                      border: isActive ? '3px solid #BFDBFE' : isDone ? '3px solid #BBF7D0' : '2px solid #E2E8F0',
                      boxShadow: isActive ? '0 0 0 4px rgba(37,99,235,.12)' : 'none',
                      transition: 'all .2s',
                    }}>
                      {isDone ? <span style={{ color: '#fff', fontSize: 16, fontWeight: 700 }}>✓</span> : <span>{phase.icon}</span>}
                    </div>
                    <div style={{ fontSize: 12, fontWeight: isActive ? 700 : 500, color: isActive ? '#2563EB' : isDone ? '#16A34A' : '#9CA3AF', lineHeight: 1.3, marginBottom: 3 }}>
                      {phase.label}
                    </div>
                    <div style={{ fontSize: 11, color: '#CBD5E1' }}>{phase.desc}</div>
                  </div>
                  {i < PHASES.length - 1 && (
                    <div style={{ width: 32, height: 2, background: isDone ? '#16A34A' : '#E2E8F0', flexShrink: 0, margin: '0 -2px', marginBottom: 28, transition: 'background .2s' }} />
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* STATS GRID */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 16, marginBottom: 24 }}>
          {[
            { label: 'Total Employees', value: employees.length, icon: '👥', color: '#2563EB', bg: '#EFF4FF' },
            { label: 'KRAs Configured', value: totalKras, icon: '📋', color: '#7C3AED', bg: '#F5F3FF' },
            { label: 'Active Phase', value: phaseIdx + 1, sub: `of ${PHASES.length}`, icon: '🔄', color: '#D97706', bg: '#FFFBEB' },
            { label: 'Cycle Progress', value: `${Math.round(((phaseIdx) / (PHASES.length - 1)) * 100)}%`, icon: '📈', color: '#16A34A', bg: '#F0FDF4' },
          ].map((stat) => (
            <div key={stat.label} style={{ background: '#fff', border: '1.5px solid #E9EDF2', borderRadius: 12, padding: '18px 20px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
                <div style={{ width: 36, height: 36, borderRadius: 9, background: stat.bg, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 18 }}>{stat.icon}</div>
                <div style={{ fontSize: 12, color: '#9CA3AF', fontWeight: 500 }}>{stat.label}</div>
              </div>
              <div style={{ fontSize: 28, fontWeight: 800, color: stat.color, lineHeight: 1 }}>
                {stat.value}
                {stat.sub && <span style={{ fontSize: 13, fontWeight: 500, color: '#9CA3AF', marginLeft: 4 }}>{stat.sub}</span>}
              </div>
            </div>
          ))}
        </div>

        {/* PHASE GUIDE */}
        <div style={{ background: '#fff', border: '1.5px solid #E9EDF2', borderRadius: 14, padding: '20px 24px' }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: '#0D1117', marginBottom: 14 }}>What happens in <span style={{ color: '#2563EB' }}>{PHASES[phaseIdx]?.label}</span></div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 12 }}>
            {[
              phaseIdx === 0 && { who: 'Employees', action: 'Review assigned KRAs and set personal targets for the cycle.' },
              phaseIdx === 0 && { who: 'HR Admin', action: 'Monitor goal-setting completion. Nudge employees who haven\'t started.' },
              phaseIdx === 1 && { who: 'Employees', action: 'Update progress on each KRA mid-cycle.' },
              phaseIdx === 1 && { who: 'Managers', action: 'Review and comment on employee mid-year progress.' },
              phaseIdx === 2 && { who: 'Employees', action: 'Rate themselves on each KRA/KPI.' },
              phaseIdx === 2 && { who: 'HR Admin', action: 'Ensure all employees complete self-evaluation before deadline.' },
              phaseIdx === 3 && { who: 'L1 Managers', action: 'Rate each direct report and approve their KRA scores.' },
              phaseIdx === 3 && { who: 'L2 Managers', action: 'Review and finalize manager ratings where applicable.' },
              phaseIdx === 4 && { who: 'HR Admin', action: 'Review all ratings, apply normalization if configured, and finalize.' },
              phaseIdx === 4 && { who: 'HR Admin', action: 'Flag any outliers or disputes before publishing.' },
              phaseIdx === 5 && { who: 'Employees', action: 'Final scores are visible. Cycle is complete.' },
              phaseIdx === 5 && { who: 'HR Admin', action: 'Export results and archive the cycle data.' },
            ].filter(Boolean).map((item, i) => (
              <div key={i} style={{ padding: '12px 16px', background: '#F8FAFC', borderRadius: 9, border: '1px solid #E9EDF2' }}>
                <div style={{ fontSize: 11.5, fontWeight: 700, color: '#2563EB', marginBottom: 4, textTransform: 'uppercase', letterSpacing: '.05em' }}>{item.who}</div>
                <div style={{ fontSize: 13, color: '#374151', lineHeight: 1.5 }}>{item.action}</div>
              </div>
            ))}
          </div>
        </div>

      </div>
    </div>
  );
}
