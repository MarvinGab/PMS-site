import { useState } from 'react';

/* ─── CONSTANTS ──────────────────────────────────────────────────────────── */
const NAV_STEPS = [
  { id: 'framework',    label: 'Performance Framework', desc: 'Structure & model' },
  { id: 'modules',      label: 'Modules & Features',    desc: 'Enable / disable' },
  { id: 'hierarchy',    label: 'Rating Hierarchy',       desc: 'Who rates whom' },
  { id: 'scale',        label: 'Rating Scale',           desc: 'Points & labels' },
  { id: 'goals',        label: 'Goal Setting Rules',     desc: 'KRA / KPI controls' },
  { id: 'targets',      label: 'Target & Auto-Rating',   desc: 'Achievement mapping' },
  { id: 'competencies', label: 'Competencies',           desc: 'Behavioural assessment' },
  { id: 'questionnaire',label: 'Questionnaire',          desc: 'Post-evaluation forms' },
  { id: 'bellcurve',    label: 'Bell Curve',             desc: 'Normalization bands' },
  { id: 'phases',       label: 'Phase Windows',          desc: 'Cycle dates' },
  { id: 'export',       label: 'Export & Launch',        desc: 'Template & go-live' },
];

const FRAMEWORKS = [
  { id: 'bsc',     name: 'BSC — Balanced Scorecard',       desc: 'Perspectives → KRAs → KPIs. Strategy-driven. Rating weighted across perspectives.', tags: ['BFSI', 'PSU', 'Manufacturing', 'Pharma'], color: '#2563EB',
    flow: ['Perspectives', 'KRAs', 'KPIs', 'Targets', 'Rating'] },
  { id: 'kra-kpi', name: 'KRA → KPI (flat)',               desc: 'No perspectives. KRAs directly hold KPIs. Simple and widely adopted.', tags: ['IT/Software', 'Startups', 'Retail'],      color: '#16A34A',
    flow: ['KRAs', 'KPIs', 'Targets', 'Rating'] },
  { id: 'kra',     name: 'KRA only (no KPI)',              desc: 'KRAs rated directly by manager. No sub-KPIs. Fast, qualitative approach.', tags: ['SMBs', 'NGOs', 'Education'],              color: '#D97706',
    flow: ['KRAs', 'Weightage', 'Direct Rating'] },
  { id: 'okr',     name: 'OKR — Objectives & Key Results', desc: 'Objectives → Key results. Quarterly cycles. Aspirational goal-setting.', tags: ['Google', 'Intel', 'LinkedIn'],            color: '#7C3AED',
    flow: ['Objectives', 'Key Results', 'Check-in %', 'Score'] },
  { id: 'mbo',     name: 'MBO — Management by Objectives', desc: 'Manager & employee jointly set goals. Review against agreed targets.', tags: ['GE', 'Consulting', 'Professional Svcs'],  color: '#DB2777',
    flow: ['Agreed Goals', 'Achievement', 'Manager Review'] },
  { id: 'custom',  name: 'Custom Hybrid',                  desc: 'Mix any structure — e.g. BSC perspectives + OKR key results, or KRA + competencies only.', tags: ['Advanced', 'Enterprise'], color: '#DC2626',
    flow: ['Custom Mix', 'Configure Each Layer'] },
];

const MODULES_LIST = [
  { id: 'kra',      label: 'KRAs (Key Result Areas)',        desc: 'Employees set and get rated on key result areas',                          core: true },
  { id: 'kpi',      label: 'KPIs (Key Performance Indicators)', desc: 'Sub-metrics under each KRA with targets and achievement',               core: false },
  { id: 'persp',    label: 'Perspectives (BSC)',             desc: 'Group KRAs under strategic perspectives with perspective-level weightages', core: false },
  { id: 'goals',    label: 'Goals / OKRs',                   desc: 'Employee-level goals separate from KRAs, can cascade from org/dept level', core: false },
  { id: 'comp',     label: 'Competencies',                   desc: 'Behavioural and functional competency assessment alongside KRAs',          core: false },
  { id: 'quest',    label: 'Questionnaire (post-evaluation)','desc': 'Ask employees and managers structured questions after rating',           core: false },
  { id: 'idp',      label: 'Development Plan (IDP)',         desc: 'Post-appraisal individual development plan with learning actions',         core: false },
  { id: 'potential',label: 'Potential Rating',               desc: 'Manager rates employee potential separately from performance',             core: false },
  { id: 'midyear',  label: 'Mid-Year Review',                desc: 'Enable a mid-cycle check-in review phase',                                core: false },
  { id: 'bell',     label: 'Bell Curve / Normalization',     desc: 'HR can normalize final ratings across distribution bands',                 core: false },
  { id: 'showfinal',label: 'Show Final Rating to Employee',  desc: 'Employee sees manager\'s final rating after publish',                      core: false },
  { id: 'showself', label: 'Show Self Rating to Manager',    desc: 'Manager can see employee\'s self rating while rating',                    core: false },
];

const COMPETENCY_CHIPS = ['Communication', 'Problem Solving', 'Teamwork', 'Ownership', 'Technical Expertise', 'Leadership', 'Innovation', 'Customer Focus', 'Adaptability', 'Collaboration', 'Result Orientation', 'Strategic Thinking'];

/* ─── TOGGLE ─────────────────────────────────────────────────────────────── */
function Toggle({ on, onChange }) {
  return (
    <button
      type="button"
      onClick={() => onChange(!on)}
      style={{
        width: 36, height: 20, borderRadius: 10, border: 'none', cursor: 'pointer',
        background: on ? '#16A34A' : '#CBD5E1', position: 'relative', flexShrink: 0,
        transition: 'background .2s',
      }}
    >
      <span style={{
        position: 'absolute', top: 3, left: on ? 18 : 3, width: 14, height: 14,
        borderRadius: '50%', background: '#fff', transition: 'left .2s',
        boxShadow: '0 1px 3px rgba(0,0,0,.2)',
      }} />
    </button>
  );
}

/* ─── SECTION HEADER ─────────────────────────────────────────────────────── */
function SectionHead({ title, sub }) {
  return (
    <div style={{ marginBottom: 20 }}>
      <div style={{ fontSize: 17, fontWeight: 600, color: '#0D1117', marginBottom: 4 }}>{title}</div>
      {sub && <div style={{ fontSize: 13, color: '#6B7280', lineHeight: 1.6 }}>{sub}</div>}
    </div>
  );
}

/* ─── CARD ───────────────────────────────────────────────────────────────── */
function Card({ children, style }) {
  return (
    <div style={{ background: '#fff', border: '1.5px solid #E9EDF2', borderRadius: 12, marginBottom: 16, ...style }}>
      {children}
    </div>
  );
}

function CardBody({ children }) {
  return <div style={{ padding: '20px 22px' }}>{children}</div>;
}

function CardHead({ title, badge }) {
  return (
    <div style={{ padding: '13px 20px', borderBottom: '1px solid #E9EDF2', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
      <div style={{ fontSize: 13.5, fontWeight: 600, color: '#0D1117' }}>{title}</div>
      {badge && <span style={{ fontSize: 11, padding: '2px 9px', borderRadius: 20, background: '#EFF4FF', color: '#2563EB', fontWeight: 500 }}>{badge}</span>}
    </div>
  );
}

/* ─── FIELD ──────────────────────────────────────────────────────────────── */
function Field({ label, children, hint }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      {label && <label style={{ fontSize: 12, fontWeight: 600, color: '#374151', textTransform: 'uppercase', letterSpacing: '0.04em' }}>{label}</label>}
      {children}
      {hint && <span style={{ fontSize: 11.5, color: '#9CA3AF' }}>{hint}</span>}
    </div>
  );
}

const inputStyle = {
  padding: '7px 10px', border: '1px solid #E2E8F0', borderRadius: 7,
  fontSize: 13, color: '#0D1117', background: '#fff', width: '100%',
  fontFamily: 'inherit', outline: 'none',
};

const selectStyle = { ...inputStyle, cursor: 'pointer' };

/* ─── GRID ───────────────────────────────────────────────────────────────── */
function Grid2({ children, gap = 14 }) {
  return <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap, marginBottom: 14 }}>{children}</div>;
}
function Grid3({ children, gap = 14 }) {
  return <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap, marginBottom: 14 }}>{children}</div>;
}

/* ─── BANNER ─────────────────────────────────────────────────────────────── */
function Banner({ type = 'blue', children }) {
  const colors = {
    blue:   { bg: '#EFF4FF', border: '#BFCFFE', color: '#1e40af' },
    amber:  { bg: '#FFFBEB', border: '#fde68a', color: '#92400e' },
    green:  { bg: '#F0FDF4', border: '#bbf7d0', color: '#14532d' },
  };
  const c = colors[type];
  return (
    <div style={{ display: 'flex', gap: 10, padding: '11px 14px', borderRadius: 8, background: c.bg, border: `1.5px solid ${c.border}`, color: c.color, fontSize: 13, lineHeight: 1.55, marginBottom: 16 }}>
      {children}
    </div>
  );
}

/* ─── TOG ROW ────────────────────────────────────────────────────────────── */
function TogRow({ label, desc, on, onChange, last }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 0', borderBottom: last ? 'none' : '1px solid #F1F3F5', gap: 16 }}>
      <div>
        <div style={{ fontSize: 13, fontWeight: 500, color: '#0D1117' }}>{label}</div>
        {desc && <div style={{ fontSize: 11.5, color: '#9CA3AF', marginTop: 2 }}>{desc}</div>}
      </div>
      <Toggle on={on} onChange={onChange} />
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
   STEP PANELS
══════════════════════════════════════════════════════════════════════════ */

/* ── STEP 1: FRAMEWORK ─────────────────────────────────────────────────── */
function StepFramework({ config, update }) {
  const selected = FRAMEWORKS.find(f => f.id === config.frameworkId) || FRAMEWORKS[0];
  return (
    <div>
      <SectionHead title="Choose your performance framework" sub="Select the structure that defines how employee performance is measured. This shapes everything — what gets set, how it's weighted, and how ratings are computed." />
      <Banner type="blue">
        <span>ℹ️</span>
        <span>Your industry and org structure determines the best fit. BSC is common in BFSI and manufacturing; KRA-KPI in IT/software; OKR in product-led companies.</span>
      </Banner>
      <Card>
        <CardHead title="Framework model" badge="Choose one" />
        <CardBody>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10, marginBottom: 16 }}>
            {FRAMEWORKS.map(fw => (
              <div key={fw.id}
                onClick={() => update('frameworkId', fw.id)}
                style={{
                  border: `2px solid ${config.frameworkId === fw.id ? fw.color : '#E9EDF2'}`,
                  borderRadius: 10, padding: '13px 14px', cursor: 'pointer',
                  background: config.frameworkId === fw.id ? fw.color + '12' : '#fff',
                  transition: 'all .16s',
                }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: '#0D1117', marginBottom: 4 }}>{fw.name}</div>
                <div style={{ fontSize: 11.5, color: '#6B7280', lineHeight: 1.45, marginBottom: 8 }}>{fw.desc}</div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                  {fw.tags.map(t => <span key={t} style={{ fontSize: 9.5, padding: '1px 7px', borderRadius: 20, background: fw.color + '18', color: fw.color, fontWeight: 600 }}>{t}</span>)}
                </div>
              </div>
            ))}
          </div>
          {/* Flow viz */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px', background: '#F8FAFC', borderRadius: 8, flexWrap: 'wrap', marginBottom: 16 }}>
            {selected.flow.map((s, i) => (
              <span key={s} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ padding: '4px 12px', borderRadius: 7, background: ['#EFF4FF','#F0FDF4','#FFFBEB','#FAF5FF','#FFF1F2'][i % 5], fontSize: 12, fontWeight: 500, color: ['#2563EB','#16A34A','#D97706','#7C3AED','#DC2626'][i % 5] }}>{s}</span>
                {i < selected.flow.length - 1 && <span style={{ color: '#9CA3AF', fontSize: 14 }}>→</span>}
              </span>
            ))}
          </div>
          <div style={{ borderTop: '1px solid #F1F3F5', paddingTop: 16 }}>
            <div style={{ fontSize: 12.5, fontWeight: 600, color: '#374151', marginBottom: 12 }}>Employee identifier — what differentiates KRA / KPI assignment?</div>
            <Grid3>
              <Field label="Primary identifier">
                <select style={selectStyle} value={config.primaryId} onChange={e => update('primaryId', e.target.value)}>
                  {['Department','Designation / Role','Grade / Band','Employee Code','Location','Employment Type','Cost Center'].map(o => <option key={o}>{o}</option>)}
                </select>
              </Field>
              <Field label="Secondary identifier (optional)">
                <select style={selectStyle} value={config.secondaryId} onChange={e => update('secondaryId', e.target.value)}>
                  {['None','Department','Designation / Role','Grade / Band','Location'].map(o => <option key={o}>{o}</option>)}
                </select>
              </Field>
              <Field label="KRA assignment mode">
                <select style={selectStyle} value={config.kraMode} onChange={e => update('kraMode', e.target.value)}>
                  {['Pre-assigned by HR (locked)','Pre-filled, employee can edit','Employee creates own KRAs','Manager assigns to employee'].map(o => <option key={o}>{o}</option>)}
                </select>
              </Field>
            </Grid3>
          </div>
        </CardBody>
      </Card>

      {/* BSC-specific: perspectives setup */}
      {config.frameworkId === 'bsc' && (
        <Card>
          <CardHead title="BSC — Perspectives setup" badge="BSC only" />
          <CardBody>
            <Banner type="blue"><span>📌</span><span>Add your strategic perspectives. Each perspective groups KRAs and carries a weightage. Total must equal 100%.</span></Banner>
            {config.perspectives.map((p, i) => (
              <div key={p.id} style={{ display: 'flex', gap: 10, alignItems: 'center', padding: '10px 0', borderBottom: i < config.perspectives.length - 1 ? '1px solid #F1F3F5' : 'none' }}>
                <div style={{ width: 14, height: 14, borderRadius: '50%', background: p.color || '#2563EB', flexShrink: 0 }} />
                <input style={{ ...inputStyle, flex: 2 }} placeholder="Perspective name" value={p.name} onChange={e => update('perspectives', config.perspectives.map((x, j) => j === i ? { ...x, name: e.target.value } : x))} />
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, flex: 1 }}>
                  <input style={{ ...inputStyle, width: 70 }} type="number" min="0" max="100" placeholder="%" value={p.weight} onChange={e => update('perspectives', config.perspectives.map((x, j) => j === i ? { ...x, weight: e.target.value } : x))} />
                  <span style={{ fontSize: 12, color: '#9CA3AF' }}>%</span>
                </div>
                <input style={{ ...inputStyle, flex: 3 }} placeholder="Strategic objective (optional)" value={p.objective} onChange={e => update('perspectives', config.perspectives.map((x, j) => j === i ? { ...x, objective: e.target.value } : x))} />
                {config.perspectives.length > 1 && (
                  <button onClick={() => update('perspectives', config.perspectives.filter((_, j) => j !== i))} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#DC2626', fontSize: 14 }}>✕</button>
                )}
              </div>
            ))}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 12 }}>
              <button onClick={() => update('perspectives', [...config.perspectives, { id: Date.now(), name: '', weight: '', color: '#6366f1', objective: '' }])}
                style={{ fontSize: 13, color: '#2563EB', background: 'none', border: 'none', cursor: 'pointer', fontWeight: 500 }}>
                + Add perspective
              </button>
              <div style={{ fontSize: 12.5, color: config.perspectives.reduce((s, p) => s + (Number(p.weight) || 0), 0) === 100 ? '#16A34A' : '#DC2626', fontWeight: 600 }}>
                Total: {config.perspectives.reduce((s, p) => s + (Number(p.weight) || 0), 0)}%
                {config.perspectives.reduce((s, p) => s + (Number(p.weight) || 0), 0) === 100 ? ' ✓' : ' (must be 100%)'}
              </div>
            </div>
          </CardBody>
        </Card>
      )}
    </div>
  );
}

/* ── STEP 2: MODULES ───────────────────────────────────────────────────── */
function StepModules({ config, update }) {
  const toggle = (id) => {
    const next = config.enabledModules.includes(id)
      ? config.enabledModules.filter(m => m !== id)
      : [...config.enabledModules, id];
    update('enabledModules', next);
  };
  return (
    <div>
      <SectionHead title="Module toggles" sub="Enable or disable features for this appraisal cycle. Core modules are always on." />
      <Card>
        <CardHead title="Core performance modules" />
        <CardBody>
          {MODULES_LIST.map((m, i) => (
            <TogRow key={m.id} label={m.label} desc={m.desc} last={i === MODULES_LIST.length - 1}
              on={m.core || config.enabledModules.includes(m.id)}
              onChange={() => !m.core && toggle(m.id)}
            />
          ))}
        </CardBody>
      </Card>
    </div>
  );
}

/* ── STEP 3: RATING HIERARCHY ──────────────────────────────────────────── */
function StepHierarchy({ config, update }) {
  const levels = [
    { id: 'self',  label: 'Self rating',               desc: 'Employee rates their own KRAs / KPIs' },
    { id: 'l1',    label: 'L1 Manager rating',         desc: 'Direct reporting manager reviews and rates' },
    { id: 'l2',    label: 'L2 / Skip-level manager',   desc: 'Second-level manager review — can override L1' },
    { id: 'hod',   label: 'HOD / Department head',     desc: 'Department head final sign-off' },
    { id: 'hr',    label: 'HR Normalization',           desc: 'HR reviews and adjusts final ratings' },
    { id: 'peer',  label: 'Peer feedback',             desc: 'Nominated peers rate collaboration and teamwork' },
    { id: 'sub',   label: 'Subordinate feedback',      desc: 'Team members rate manager — managers only' },
  ];
  const toggle = (id) => {
    const next = config.ratingLevels.includes(id)
      ? config.ratingLevels.filter(l => l !== id)
      : [...config.ratingLevels, id];
    update('ratingLevels', next);
  };
  return (
    <div>
      <SectionHead title="Rating hierarchy" sub="Define who rates the employee and in what order. Self and L1 are recommended minimum." />
      <Card>
        <CardHead title="Rating levels" badge="Enable / reorder" />
        <CardBody>
          <div style={{ fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 10, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Active levels</div>
          {levels.map((l, i) => (
            <div key={l.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '9px 0', borderBottom: i < levels.length - 1 ? '1px solid #F1F3F5' : 'none' }}>
              <div style={{ width: 24, height: 24, borderRadius: '50%', background: '#EFF4FF', color: '#2563EB', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 700, flexShrink: 0 }}>
                {i + 1}
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 13, fontWeight: 500 }}>{l.label}</div>
                <div style={{ fontSize: 11.5, color: '#9CA3AF' }}>{l.desc}</div>
              </div>
              <Toggle on={config.ratingLevels.includes(l.id)} onChange={() => toggle(l.id)} />
            </div>
          ))}
        </CardBody>
      </Card>
      <Card>
        <CardHead title="Visibility & override rules" />
        <CardBody>
          <Grid3>
            <Field label="Self rating visible to L1?">
              <select style={selectStyle} value={config.selfVisibility} onChange={e => update('selfVisibility', e.target.value)}>
                <option>Yes — always visible</option>
                <option>Visible after L1 submits</option>
                <option>Hidden from manager</option>
              </select>
            </Field>
            <Field label="L1 rating visible to employee?">
              <select style={selectStyle} value={config.l1Visibility} onChange={e => update('l1Visibility', e.target.value)}>
                <option>After results are published</option>
                <option>Immediately after L1 submits</option>
                <option>Never</option>
              </select>
            </Field>
            <Field label="Can manager override self rating?">
              <select style={selectStyle} value={config.managerOverride} onChange={e => update('managerOverride', e.target.value)}>
                <option>Yes — full override</option>
                <option>Yes — within ±1 band</option>
                <option>No — separate scores</option>
              </select>
            </Field>
          </Grid3>
          <Grid2>
            <Field label="Peer feedback visible to employee?">
              <select style={selectStyle} value={config.peerVisibility} onChange={e => update('peerVisibility', e.target.value)}>
                <option>Anonymous — aggregated only</option>
                <option>Named — visible after review</option>
                <option>Hidden</option>
              </select>
            </Field>
            <Field label="Final rating owner">
              <select style={selectStyle} value={config.finalRatingOwner} onChange={e => update('finalRatingOwner', e.target.value)}>
                <option>Weighted average of all levels</option>
                <option>L1 manager rating</option>
                <option>HR normalized score</option>
                <option>Custom formula</option>
              </select>
            </Field>
          </Grid2>
        </CardBody>
      </Card>
    </div>
  );
}

/* ── STEP 4: RATING SCALE ──────────────────────────────────────────────── */
const SCALE_DEFAULTS = {
  3: [{ n: 1, l: 'Below Expectations' }, { n: 2, l: 'Meets Expectations' }, { n: 3, l: 'Exceeds Expectations' }],
  4: [{ n: 1, l: 'Below Expectations' }, { n: 2, l: 'Meets Expectations' }, { n: 3, l: 'Exceeds Expectations' }, { n: 4, l: 'Outstanding' }],
  5: [{ n: 1, l: 'Needs Improvement' }, { n: 2, l: 'Below Expectations' }, { n: 3, l: 'Meets Expectations' }, { n: 4, l: 'Exceeds Expectations' }, { n: 5, l: 'Outstanding' }],
  10: Array.from({ length: 10 }, (_, i) => ({ n: i + 1, l: `Level ${i + 1}` })),
};
const SCALE_COLORS = ['#DC2626','#F97316','#FBBF24','#84CC16','#22C55E','#10B981','#14B8A6','#3B82F6','#8B5CF6','#EC4899'];

function StepScale({ config, update }) {
  const scale = SCALE_DEFAULTS[config.scalePoints] || SCALE_DEFAULTS[5];
  return (
    <div>
      <SectionHead title="Rating scale & calculation" sub="Define how scores are presented and computed across the appraisal." />
      <Card>
        <CardHead title="Scale configuration" />
        <CardBody>
          <Grid3>
            <Field label="Scale type">
              <select style={selectStyle} value={config.scalePoints} onChange={e => update('scalePoints', Number(e.target.value))}>
                <option value={5}>5-point (1–5)</option>
                <option value={4}>4-point (1–4)</option>
                <option value={10}>10-point (1–10)</option>
                <option value={3}>3-point (1–3)</option>
              </select>
            </Field>
            <Field label="Display format">
              <select style={selectStyle} value={config.scaleDisplay} onChange={e => update('scaleDisplay', e.target.value)}>
                <option>Number + label</option>
                <option>Number only</option>
                <option>Label only</option>
                <option>Star rating</option>
              </select>
            </Field>
            <Field label="Rating applies at">
              <select style={selectStyle} value={config.ratingAppliesAt} onChange={e => update('ratingAppliesAt', e.target.value)}>
                <option>KPI level — rolled up</option>
                <option>KRA level directly</option>
                <option>Perspective level</option>
                <option>Overall only</option>
              </select>
            </Field>
          </Grid3>
          <div style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: '#374151', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 10 }}>Scale preview & labels</div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
              {scale.map((s, i) => (
                <div key={s.n} style={{ width: 42, height: 42, borderRadius: 8, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 14, fontWeight: 700, background: SCALE_COLORS[i] + '20', color: SCALE_COLORS[i], border: `1.5px solid ${SCALE_COLORS[i]}40` }}>
                  {s.n}
                </div>
              ))}
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10 }}>
              {scale.map(s => (
                <Field key={s.n} label={`Label for ${s.n}`}>
                  <input style={inputStyle} type="text" defaultValue={s.l} />
                </Field>
              ))}
            </div>
          </div>
          <div style={{ borderTop: '1px solid #F1F3F5', paddingTop: 16 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: '#374151', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 12 }}>Weightage configuration</div>
            <Grid3>
              <Field label="KRA / Perspective weightage">
                <select style={selectStyle}><option>HR pre-sets fixed weights</option><option>Employee proposes, manager approves</option><option>Equal weight across all</option></select>
              </Field>
              <Field label="KPI weightage within KRA">
                <select style={selectStyle}><option>HR pre-sets fixed weights</option><option>Employee sets, manager approves</option><option>Equal weight</option><option>Not applicable</option></select>
              </Field>
              <Field label="Competency weight in final score" hint="% of final rating">
                <input style={inputStyle} type="number" defaultValue={20} min={0} max={100} />
              </Field>
            </Grid3>
            <Grid3>
              <Field label="Decimal rounding">
                <select style={selectStyle}><option>Round to nearest 0.5</option><option>Round to integer</option><option>2 decimal places</option></select>
              </Field>
              <Field label="Mandatory comment if score ≤">
                <select style={selectStyle}><option>1 (lowest only)</option><option>2</option><option>Always mandatory</option><option>Not required</option></select>
              </Field>
              <Field label="Rating change audit trail">
                <select style={selectStyle}><option>Yes — log all changes</option><option>No</option></select>
              </Field>
            </Grid3>
          </div>
        </CardBody>
      </Card>
    </div>
  );
}

/* ── STEP 5: GOAL SETTING ──────────────────────────────────────────────── */
function StepGoals({ config, update }) {
  return (
    <div>
      <SectionHead title="Goal setting rules" sub="Control how employees set KRAs, KPIs, and goals — and how the phase is locked." />
      <Card>
        <CardHead title="Goal setting & phase control" />
        <CardBody>
          <Grid3>
            <Field label="Who sets goals?">
              <select style={selectStyle} value={config.whoSetsGoals} onChange={e => update('whoSetsGoals', e.target.value)}>
                <option>Employee — from library</option>
                <option>Manager assigns to employee</option>
                <option>HR pre-loads all goals</option>
                <option>Employee creates custom</option>
                <option>Mix — pre-filled + custom</option>
              </select>
            </Field>
            <Field label="Goal library source">
              <select style={selectStyle} value={config.librarySource} onChange={e => update('librarySource', e.target.value)}>
                <option>Org-level library (by role)</option>
                <option>Sector-wise library (pre-filled)</option>
                <option>Department-level library</option>
                <option>No library — fully custom</option>
              </select>
            </Field>
            <Field label="Goal cascading">
              <select style={selectStyle} value={config.cascading} onChange={e => update('cascading', e.target.value)}>
                <option>Org → Dept → Individual</option>
                <option>Dept → Individual only</option>
                <option>No cascading</option>
              </select>
            </Field>
          </Grid3>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: 12, marginBottom: 16 }}>
            <Field label="Max KRAs per employee">
              <input style={inputStyle} type="number" defaultValue={6} min={1} max={20} />
            </Field>
            <Field label="Min KRAs required">
              <input style={inputStyle} type="number" defaultValue={3} min={1} max={10} />
            </Field>
            <Field label="Max KPIs per KRA">
              <input style={inputStyle} type="number" defaultValue={4} min={1} max={10} />
            </Field>
            <Field label="Max goals / OKRs">
              <input style={inputStyle} type="number" defaultValue={5} min={1} max={20} />
            </Field>
          </div>
          <div style={{ borderTop: '1px solid #F1F3F5', paddingTop: 14 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 10, textTransform: 'uppercase', letterSpacing: '0.04em' }}>Phase lock control</div>
            {[
              { label: 'Goal setting phase — freeze after deadline',             desc: 'Once goal setting window closes, employees cannot add/edit KRAs', key: 'freezeGoalSetting' },
              { label: 'Allow manager to unlock goal setting for individuals',   desc: 'Manager can reopen the goal window for a specific employee',       key: 'managerUnlockGoals' },
              { label: 'Self evaluation phase — freeze after deadline',          desc: 'Employee cannot change self ratings after evaluation window closes', key: 'freezeSelfEval' },
              { label: 'Allow HR to reopen self evaluation globally',            desc: 'HR can reopen self rating for all or selected employees',           key: 'hrReopenSelf' },
              { label: 'Manager approval required for employee-set KRAs',        desc: 'KRAs set by employee go through manager approval before going live', key: 'managerApproveKRA' },
              { label: 'Allow mid-year KRA revision',                           desc: 'KRAs can be modified during mid-year window with manager approval',  key: 'midYearRevision' },
            ].map((t, i, arr) => (
              <TogRow key={t.key} label={t.label} desc={t.desc} last={i === arr.length - 1}
                on={config[t.key]} onChange={v => update(t.key, v)} />
            ))}
          </div>
        </CardBody>
      </Card>
    </div>
  );
}

/* ── STEP 6: TARGETS ───────────────────────────────────────────────────── */
function StepTargets({ config, update }) {
  const exampleKPIs = [
    { name: 'Revenue generated',   direction: '↑ Higher is better', target: '₹50L',  achievement: '₹58L', score: '5 — Outstanding (116%)' },
    { name: 'Customer complaints', direction: '↓ Lower is better',  target: '≤5',    achievement: '3',    score: '5 — Outstanding (40% below)' },
    { name: 'Code defect rate',    direction: '↓ Lower is better',  target: '≤2%',   achievement: '4%',   score: '2 — Below Expectations' },
  ];
  return (
    <div>
      <SectionHead title="Target setting & auto-rating" sub="Define how targets work and how achievement maps to ratings." />
      <Card>
        <CardHead title="Target configuration" />
        <CardBody>
          <Grid3>
            <Field label="Target entry by">
              <select style={selectStyle}><option>Manager sets targets</option><option>Employee proposes, manager approves</option><option>HR pre-loads targets</option><option>Auto-fetched from system</option></select>
            </Field>
            <Field label="Target type allowed">
              <select style={selectStyle}><option>Numeric only</option><option>Percentage only</option><option>Numeric + Percentage</option><option>All — numeric, %, currency, text</option></select>
            </Field>
            <Field label="Achievement entry by">
              <select style={selectStyle}><option>Employee enters achievement</option><option>Manager enters achievement</option><option>Auto-fetched from system</option><option>Both — employee + manager verify</option></select>
            </Field>
          </Grid3>
          <Banner type="blue"><span>ℹ️</span><span>For each KPI, define whether higher achievement = better (revenue) or lower = better (error rate, attrition). This drives auto-rating calculation.</span></Banner>
          <div style={{ overflowX: 'auto', marginBottom: 16 }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
              <thead>
                <tr style={{ color: '#9CA3AF', textTransform: 'uppercase', fontSize: 10.5, letterSpacing: '0.05em' }}>
                  {['KPI Example', 'Direction', 'Target', 'Achievement', 'Auto-rating'].map(h => (
                    <td key={h} style={{ padding: '6px 10px', borderBottom: '1px solid #F1F3F5', fontWeight: 600 }}>{h}</td>
                  ))}
                </tr>
              </thead>
              <tbody>
                {exampleKPIs.map((k, i) => (
                  <tr key={i}>
                    <td style={{ padding: '8px 10px', borderBottom: '1px solid #F1F3F5', fontWeight: 500 }}>{k.name}</td>
                    <td style={{ padding: '8px 10px', borderBottom: '1px solid #F1F3F5' }}>
                      <select style={{ ...selectStyle, width: 'auto', fontSize: 11.5, padding: '3px 7px' }} defaultValue={k.direction}>
                        <option>↑ Higher is better</option><option>↓ Lower is better</option><option>= Exact target</option>
                      </select>
                    </td>
                    <td style={{ padding: '8px 10px', borderBottom: '1px solid #F1F3F5' }}><input style={{ ...inputStyle, width: 70 }} defaultValue={k.target} /></td>
                    <td style={{ padding: '8px 10px', borderBottom: '1px solid #F1F3F5' }}><input style={{ ...inputStyle, width: 70 }} defaultValue={k.achievement} /></td>
                    <td style={{ padding: '8px 10px', borderBottom: '1px solid #F1F3F5' }}>
                      <span style={{ fontSize: 11, padding: '2px 8px', borderRadius: 20, background: '#F0FDF4', color: '#16A34A', fontWeight: 500 }}>{k.score}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div style={{ borderTop: '1px solid #F1F3F5', paddingTop: 14 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: '#374151', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 12 }}>Auto-rating thresholds (achievement % → score mapping)</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: 12, marginBottom: 14 }}>
              {[{ label: 'Score 5 — Outstanding', val: '≥ 110%' }, { label: 'Score 4 — Exceeds', val: '90–109%' }, { label: 'Score 3 — Meets', val: '70–89%' }, { label: 'Score 2 — Below', val: '50–69%' }].map(t => (
                <Field key={t.label} label={t.label}><input style={inputStyle} defaultValue={t.val} /></Field>
              ))}
            </div>
            <TogRow label="Enable auto-rating from achievement" desc="System auto-suggests rating based on achievement %. Manager can override." on={config.autoRating} onChange={v => update('autoRating', v)} />
            <TogRow label="Allow manager to override auto-rating" desc="Manager can change the system-suggested score with a mandatory comment." last on={config.managerOverrideAuto} onChange={v => update('managerOverrideAuto', v)} />
          </div>
        </CardBody>
      </Card>
    </div>
  );
}

/* ── STEP 7: COMPETENCIES ──────────────────────────────────────────────── */
function StepCompetencies({ config, update }) {
  const toggle = (c) => {
    const next = config.selectedCompetencies.includes(c)
      ? config.selectedCompetencies.filter(x => x !== c)
      : [...config.selectedCompetencies, c];
    update('selectedCompetencies', next);
  };
  return (
    <div>
      <SectionHead title="Competency configuration" sub="Set which competencies are assessed and how they're weighted in the final score." />
      <Card>
        <CardHead title="Competency settings" />
        <CardBody>
          <TogRow label="Enable competency assessment" desc="Competencies are rated as part of the appraisal" on={config.competenciesEnabled} onChange={v => update('competenciesEnabled', v)} />
          {config.competenciesEnabled && (
            <div style={{ marginTop: 14 }}>
              <div style={{ height: 1, background: '#F1F3F5', margin: '10px 0 14px' }} />
              <Grid3>
                <Field label="Competency types included">
                  <select style={selectStyle}><option>Behavioural only</option><option>Functional / technical only</option><option>Both behavioural + functional</option><option>Core values only</option></select>
                </Field>
                <Field label="Competency assignment by">
                  <select style={selectStyle}><option>Role / designation</option><option>Grade / band</option><option>Department</option><option>HR manually assigns</option></select>
                </Field>
                <Field label="Max competencies per employee">
                  <input style={inputStyle} type="number" defaultValue={5} min={1} max={15} />
                </Field>
              </Grid3>
              <Grid2>
                <Field label="Competency weight in final rating" hint="% — KRA weight = remaining %">
                  <input style={inputStyle} type="number" defaultValue={20} min={0} max={100} />
                </Field>
                <Field label="Competency rated by">
                  <select style={selectStyle}><option>Manager only</option><option>Self + manager</option><option>Self + manager + peers</option></select>
                </Field>
              </Grid2>
              <div style={{ fontSize: 12, fontWeight: 600, color: '#374151', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 10 }}>Select competencies (org library)</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 7 }}>
                {COMPETENCY_CHIPS.map(c => (
                  <button key={c} onClick={() => toggle(c)}
                    style={{
                      padding: '5px 13px', borderRadius: 20, fontSize: 12.5, fontWeight: 500, cursor: 'pointer', transition: 'all .15s',
                      border: `1px solid ${config.selectedCompetencies.includes(c) ? '#2563EB' : '#E2E8F0'}`,
                      background: config.selectedCompetencies.includes(c) ? '#EFF4FF' : '#fff',
                      color: config.selectedCompetencies.includes(c) ? '#2563EB' : '#6B7280',
                    }}>
                    {c}
                  </button>
                ))}
              </div>
            </div>
          )}
        </CardBody>
      </Card>
    </div>
  );
}

/* ── STEP 8: QUESTIONNAIRE ─────────────────────────────────────────────── */
function QTab({ label, active, onClick }) {
  return (
    <button onClick={onClick} style={{ padding: '9px 16px', fontSize: 13, fontWeight: 500, cursor: 'pointer', background: 'none', border: 'none', borderBottom: `2px solid ${active ? '#2563EB' : 'transparent'}`, color: active ? '#2563EB' : '#9CA3AF', transition: 'all .15s' }}>
      {label}
    </button>
  );
}

const EMP_QUESTIONS = [
  { q: 'Q1 — How satisfied are you with your appraisal process?', type: 'Star' },
  { q: 'Q2 — Do you feel your goals were clearly communicated?',  type: 'MCQ',  options: ['Strongly agree', 'Agree', 'Neutral', 'Disagree', 'Strongly disagree'] },
  { q: 'Q3 — What would help you perform better next year?',      type: 'Text' },
];
const MGR_QUESTIONS = [
  { q: 'Q1 — Rate this employee\'s overall potential',            type: 'Star' },
  { q: 'Q2 — Is this employee ready for a promotion?',           type: 'MCQ',  options: ['Ready now', 'Ready in 1 year', 'Not yet', 'Needs development'] },
  { q: 'Q3 — Describe this employee\'s key strength',            type: 'Text' },
];

function QuestionCard({ q }) {
  const [type, setType] = useState(q.type);
  return (
    <div style={{ border: '1px solid #E9EDF2', borderRadius: 9, padding: '12px 14px', marginBottom: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
        <div style={{ fontSize: 13, fontWeight: 500, color: '#0D1117' }}>{q.q}</div>
        <div style={{ display: 'flex', gap: 5 }}>
          {['Star', 'MCQ', 'Text'].map(t => (
            <button key={t} onClick={() => setType(t)}
              style={{ fontSize: 11, padding: '3px 9px', borderRadius: 20, cursor: 'pointer', border: `1px solid ${type === t ? '#2563EB' : '#E2E8F0'}`, background: type === t ? '#EFF4FF' : '#fff', color: type === t ? '#2563EB' : '#6B7280' }}>
              {t === 'Star' ? '⭐ Star' : t}
            </button>
          ))}
        </div>
      </div>
      {type === 'MCQ' && q.options && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {q.options.map(o => <span key={o} style={{ padding: '3px 10px', borderRadius: 20, border: '1px solid #E2E8F0', fontSize: 12, color: '#374151', background: '#F8FAFC' }}>{o}</span>)}
        </div>
      )}
      {type === 'Text' && <div style={{ fontSize: 11.5, color: '#9CA3AF' }}>Response: open-ended descriptive</div>}
      {type === 'Star' && <div style={{ fontSize: 11.5, color: '#9CA3AF' }}>Response: 1–{5} star rating</div>}
    </div>
  );
}

function StepQuestionnaire() {
  const [activeTab, setActiveTab] = useState('emp');
  const questions = activeTab === 'emp' ? EMP_QUESTIONS : MGR_QUESTIONS;
  return (
    <div>
      <SectionHead title="Post-evaluation questionnaire" sub="Configure questions asked to employees and managers after rating. Mix question types freely." />
      <Card>
        <div style={{ display: 'flex', borderBottom: '1px solid #E9EDF2', padding: '0 4px' }}>
          <QTab label="Employee questions" active={activeTab === 'emp'} onClick={() => setActiveTab('emp')} />
          <QTab label="Manager questions"  active={activeTab === 'mgr'} onClick={() => setActiveTab('mgr')} />
        </div>
        <CardBody>
          <Grid3 gap={12}>
            <Field label="Questions asked to">
              <select style={selectStyle}><option>All employees</option><option>By grade</option><option>By department</option></select>
            </Field>
            <Field label="Response mandatory?">
              <select style={selectStyle}><option>Yes — all questions</option><option>At least 50% mandatory</option><option>All optional</option></select>
            </Field>
            <Field label="Anonymity">
              <select style={selectStyle}><option>Not anonymous</option><option>Anonymous — HR sees only</option></select>
            </Field>
          </Grid3>
          <div style={{ marginTop: 4 }}>
            {questions.map((q, i) => <QuestionCard key={i} q={q} />)}
          </div>
          <div style={{ marginTop: 10, display: 'flex', gap: 8 }}>
            <button style={{ padding: '7px 14px', border: '1px solid #E2E8F0', borderRadius: 8, fontSize: 12.5, cursor: 'pointer', background: '#fff' }}>+ Add from question bank</button>
            <button style={{ padding: '7px 14px', border: '1px solid #E2E8F0', borderRadius: 8, fontSize: 12.5, cursor: 'pointer', background: '#fff' }}>+ Create new question</button>
          </div>
        </CardBody>
      </Card>
    </div>
  );
}

/* ── STEP 9: BELL CURVE ────────────────────────────────────────────────── */
const BELL_COLORS = ['#F0FDF4','#EFF4FF','#FFFBEB','#FEF2F2','#FEF3C7'];
const BELL_TEXT   = ['#16A34A','#2563EB','#D97706','#DC2626','#92400e'];
const BELL_LABELS = ['Outstanding','Exceeds','Meets','Below','Needs Improv.'];

function StepBellCurve({ config, update }) {
  const bands = config.bellBands;
  const max   = Math.max(...bands.map(Number), 1);
  return (
    <div>
      <SectionHead title="Bell curve / normalization" sub="Define rating distribution bands and how HR normalizes final ratings." />
      <Card>
        <CardHead title="Distribution configuration" />
        <CardBody>
          <TogRow label="Enable bell curve normalization" desc="HR reviews final distribution and can adjust ratings to fit bell curve" on={config.bellEnabled} onChange={v => update('bellEnabled', v)} />
          <TogRow label="Apply per department (not org-wide)" desc="Normalization done independently within each department" on={config.bellPerDept} onChange={v => update('bellPerDept', v)} />
          <TogRow label="Notify employee if rating was normalized" desc="Employee sees a note if final rating differs from manager rating" last on={config.bellNotify} onChange={v => update('bellNotify', v)} />
          <div style={{ height: 1, background: '#F1F3F5', margin: '14px 0' }} />
          <div style={{ fontSize: 12, fontWeight: 600, color: '#374151', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 14 }}>Distribution bands</div>
          {/* Bar chart */}
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: 6, height: 90, marginBottom: 14 }}>
            {bands.map((b, i) => (
              <div key={i} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'flex-end' }}>
                <div style={{ fontSize: 11, fontWeight: 600, color: BELL_TEXT[i], marginBottom: 4 }}>{b}%</div>
                <div style={{ width: '100%', height: Math.max((Number(b) / max) * 70, 6), background: BELL_COLORS[i], borderRadius: '4px 4px 0 0', transition: 'height .3s' }} />
                <div style={{ fontSize: 10, color: '#9CA3AF', marginTop: 5, textAlign: 'center' }}>{BELL_LABELS[i]}</div>
              </div>
            ))}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: 12, marginBottom: 12 }}>
            {['Outstanding (5) — max %', 'Exceeds (4) — max %', 'Meets (3) — target %', 'Below (2) — max %'].map((l, i) => (
              <Field key={l} label={l}>
                <input style={inputStyle} type="number" value={bands[i]} min={0} max={100}
                  onChange={e => { const next = [...bands]; next[i] = e.target.value; update('bellBands', next); }} />
              </Field>
            ))}
          </div>
          <Field label="Needs improvement (1) — max %" >
            <input style={{ ...inputStyle, maxWidth: 120 }} type="number" value={bands[4]} min={0} max={100}
              onChange={e => { const next = [...bands]; next[4] = e.target.value; update('bellBands', next); }} />
          </Field>
        </CardBody>
      </Card>
    </div>
  );
}

/* ── STEP 10: PHASES ───────────────────────────────────────────────────── */
function StepPhases() {
  const phases = [
    { label: 'Phase 1 — Goal setting',     open: '2025-04-01', close: '2025-04-30', note: 'Employees set KRAs' },
    { label: 'Phase 2 — Mid-year review',  open: '2025-10-01', close: '2025-10-15', note: 'Optional check-in' },
    { label: 'Phase 3 — Self evaluation',  open: '2026-03-01', close: '2026-03-15', note: 'Employee rates self' },
    { label: 'Phase 4 — Manager rating',   open: '2026-03-16', close: '2026-03-25', note: 'L1 rates employee' },
    { label: 'Phase 5 — HR normalization', open: '2026-03-26', close: '2026-03-31', note: 'Bell curve review' },
    { label: 'Phase 6 — Results publish',  open: '2026-04-05', close: '2026-04-15', note: 'Employee acknowledgement' },
  ];
  return (
    <div>
      <SectionHead title="Phase windows & cycle dates" sub="Set all date windows for each phase of the appraisal cycle." />
      <Card>
        <CardHead title="Appraisal cycle timeline" />
        <CardBody>
          <Grid2 gap={16}>
            <Field label="Cycle name">
              <input style={inputStyle} defaultValue="Annual appraisal FY 2025–26" />
            </Field>
            <Field label="Cycle type">
              <select style={selectStyle}><option>Annual</option><option>Half-yearly</option><option>Quarterly</option><option>Project-based</option></select>
            </Field>
          </Grid2>
          <div style={{ height: 1, background: '#F1F3F5', marginBottom: 18 }} />
          {phases.map((p, i) => (
            <div key={i} style={{ marginBottom: 18 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                <div style={{ width: 22, height: 22, borderRadius: '50%', background: '#EFF4FF', color: '#2563EB', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 700, flexShrink: 0 }}>{i + 1}</div>
                <div style={{ fontSize: 13.5, fontWeight: 600, color: '#0D1117' }}>{p.label}</div>
                <span style={{ fontSize: 11.5, color: '#9CA3AF' }}>— {p.note}</span>
              </div>
              <Grid2 gap={14}>
                <Field label="Opens"><input style={inputStyle} type="date" defaultValue={p.open} /></Field>
                <Field label={i === 5 ? 'Acknowledgement deadline' : 'Closes (auto-freeze)'}><input style={inputStyle} type="date" defaultValue={p.close} /></Field>
              </Grid2>
            </div>
          ))}
        </CardBody>
      </Card>
    </div>
  );
}

/* ── STEP 11: EXPORT ───────────────────────────────────────────────────── */
function StepExport() {
  const cols = ['Employee code', 'Employee name', 'Email ID', 'Department', 'Designation', 'Grade', 'Reporting manager code', 'Template assigned', 'KRA 1 name', 'KRA 1 weight %', 'KPI 1.1 name', 'KPI 1.1 target', 'KPI 1.1 direction', 'KRA 2 name', '… up to max KRAs', 'Perspective (if BSC)'];
  return (
    <div>
      <SectionHead title="Export & launch" sub="Download the employee upload template, then launch the appraisal cycle." />
      <Card>
        <CardHead title="Employee onboarding template" />
        <CardBody>
          <Banner type="blue">
            <span>📋</span>
            <span>Once configuration is complete, download this Excel template. Managers fill in employee details, KRA assignments, and targets. Upload the filled sheet to auto-create employee records and trigger invite emails.</span>
          </Banner>
          <div style={{ fontSize: 12, fontWeight: 600, color: '#374151', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 10 }}>Columns in the generated template</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 20 }}>
            {cols.map(c => <span key={c} style={{ padding: '3px 10px', borderRadius: 20, fontSize: 12, background: '#F0FDF4', color: '#16A34A', border: '1px solid #bbf7d0', fontWeight: 500 }}>{c}</span>)}
          </div>
          <div style={{ border: '2px dashed #E2E8F0', borderRadius: 12, padding: 28, textAlign: 'center' }}>
            <div style={{ width: 56, height: 56, borderRadius: 12, background: '#F0FDF4', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 26, margin: '0 auto 12px' }}>📊</div>
            <div style={{ fontSize: 14.5, fontWeight: 600, color: '#0D1117', marginBottom: 5 }}>Employee appraisal upload template</div>
            <div style={{ fontSize: 12.5, color: '#9CA3AF', marginBottom: 18 }}>Generated based on your PMS configuration · Includes all enabled columns</div>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'center' }}>
              <button style={{ padding: '9px 20px', background: '#2563EB', color: '#fff', border: 'none', borderRadius: 9, fontSize: 13.5, fontWeight: 500, cursor: 'pointer' }}>Download Excel Template</button>
              <button style={{ padding: '9px 20px', border: '1.5px solid #E2E8F0', borderRadius: 9, fontSize: 13.5, cursor: 'pointer', background: '#fff' }}>Preview Template</button>
            </div>
          </div>
        </CardBody>
      </Card>
      <Card>
        <CardHead title="Post-upload actions" />
        <CardBody>
          {[
            { label: 'Auto-send invite email to employees on upload', desc: 'Each employee gets login link and goal setting instructions' },
            { label: 'Send manager summary email', desc: 'Each manager gets a list of their reportees and pending actions' },
            { label: 'Pre-populate employee portal with assigned KRAs', desc: 'Employees see pre-loaded KRAs as soon as they log in' },
          ].map((t, i, arr) => (
            <TogRow key={t.label} label={t.label} desc={t.desc} last={i === arr.length - 1} on={true} onChange={() => {}} />
          ))}
        </CardBody>
      </Card>
      <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 8 }}>
        <button style={{ padding: '10px 22px', border: '1.5px solid #E2E8F0', borderRadius: 9, fontSize: 13.5, cursor: 'pointer', background: '#fff' }}>Save as Draft</button>
        <button style={{ padding: '10px 22px', background: '#16A34A', color: '#fff', border: 'none', borderRadius: 9, fontSize: 13.5, fontWeight: 600, cursor: 'pointer' }}>🚀 Launch Appraisal Cycle</button>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
   MAIN WIZARD
══════════════════════════════════════════════════════════════════════════ */
const INITIAL = {
  // Framework
  frameworkId: 'bsc', primaryId: 'Department', secondaryId: 'None', kraMode: 'Pre-assigned by HR (locked)',
  perspectives: [
    { id: 1, name: 'Financial',          weight: 25, color: '#2563EB', objective: '' },
    { id: 2, name: 'Customer',           weight: 25, color: '#16A34A', objective: '' },
    { id: 3, name: 'Internal Processes', weight: 25, color: '#D97706', objective: '' },
    { id: 4, name: 'Learning & Growth',  weight: 25, color: '#7C3AED', objective: '' },
  ],
  // Modules
  enabledModules: ['kpi', 'goals', 'comp', 'quest', 'bell', 'showfinal', 'showself'],
  // Hierarchy
  ratingLevels: ['self', 'l1', 'hr'],
  selfVisibility: 'Yes — always visible', l1Visibility: 'After results are published',
  managerOverride: 'Yes — full override', peerVisibility: 'Anonymous — aggregated only',
  finalRatingOwner: 'Weighted average of all levels',
  // Scale
  scalePoints: 5, scaleDisplay: 'Number + label', ratingAppliesAt: 'KPI level — rolled up',
  // Goals
  whoSetsGoals: 'Employee — from library', librarySource: 'Org-level library (by role)', cascading: 'Org → Dept → Individual',
  freezeGoalSetting: true, managerUnlockGoals: true, freezeSelfEval: true,
  hrReopenSelf: true, managerApproveKRA: true, midYearRevision: false,
  // Targets
  autoRating: true, managerOverrideAuto: true,
  // Competencies
  competenciesEnabled: true,
  selectedCompetencies: ['Communication', 'Problem Solving', 'Teamwork', 'Ownership', 'Technical Expertise'],
  // Bell curve
  bellEnabled: true, bellPerDept: true, bellNotify: false,
  bellBands: [10, 20, 50, 15, 5],
};

export default function PMSWizard() {
  const [step, setStep]     = useState(0);
  const [config, setConfig] = useState(INITIAL);
  const [done, setDone]     = useState(new Set());

  function update(key, val) {
    setConfig(prev => ({ ...prev, [key]: val }));
  }

  function goTo(n) {
    setDone(prev => { const s = new Set(prev); s.add(step); return s; });
    setStep(n);
  }

  function next() { if (step < 10) goTo(step + 1); }
  function back() { if (step > 0)  setStep(step - 1); }

  const stepComponents = [
    <StepFramework     config={config} update={update} />,
    <StepModules       config={config} update={update} />,
    <StepHierarchy     config={config} update={update} />,
    <StepScale         config={config} update={update} />,
    <StepGoals         config={config} update={update} />,
    <StepTargets       config={config} update={update} />,
    <StepCompetencies  config={config} update={update} />,
    <StepQuestionnaire />,
    <StepBellCurve     config={config} update={update} />,
    <StepPhases />,
    <StepExport />,
  ];

  const pct = Math.round(((done.size) / 11) * 100);

  return (
    <div style={{ display: 'flex', minHeight: '100vh', fontFamily: "'Geist','Segoe UI','Inter',Arial,sans-serif", fontSize: 14, color: '#0D1117', background: '#F8FAFC' }}>

      {/* SIDEBAR */}
      <aside style={{ width: 230, minWidth: 230, background: '#fff', borderRight: '1.5px solid #E9EDF2', display: 'flex', flexDirection: 'column', position: 'sticky', top: 0, height: '100vh', overflowY: 'auto' }}>
        <div style={{ padding: '20px 18px', borderBottom: '1px solid #E9EDF2' }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: '#0D1117' }}>PMS Configuration</div>
          <div style={{ fontSize: 11, color: '#9CA3AF', marginTop: 2 }}>HR Admin setup wizard</div>
          <div style={{ marginTop: 12 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11.5, color: '#9CA3AF', marginBottom: 5 }}>
              <span>Setup progress</span><span style={{ color: '#2563EB', fontWeight: 600 }}>{pct}%</span>
            </div>
            <div style={{ height: 4, background: '#F1F3F5', borderRadius: 4 }}>
              <div style={{ height: '100%', width: `${pct}%`, background: 'linear-gradient(90deg,#2563EB,#6366f1)', borderRadius: 4, transition: 'width .4s' }} />
            </div>
          </div>
        </div>
        <div style={{ padding: '10px 0', flex: 1 }}>
          {NAV_STEPS.map((s, i) => {
            const isActive = i === step;
            const isDone   = done.has(i);
            return (
              <div key={s.id}>
                <div onClick={() => goTo(i)} style={{
                  display: 'flex', alignItems: 'flex-start', gap: 10, padding: '8px 16px',
                  cursor: 'pointer', borderLeft: `2.5px solid ${isActive ? '#2563EB' : 'transparent'}`,
                  background: isActive ? '#EFF4FF' : 'transparent', transition: 'all .15s',
                }}>
                  <div style={{
                    width: 22, height: 22, borderRadius: '50%', flexShrink: 0, marginTop: 1,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontSize: 10, fontWeight: 700,
                    background: isActive ? '#2563EB' : isDone ? '#16A34A' : '#F1F3F5',
                    color:      isActive ? '#fff'    : isDone ? '#fff'    : '#9CA3AF',
                  }}>
                    {isDone && !isActive ? '✓' : i + 1}
                  </div>
                  <div>
                    <div style={{ fontSize: 12.5, fontWeight: isActive ? 600 : 500, color: isActive ? '#2563EB' : isDone ? '#16A34A' : '#374151', lineHeight: 1.3 }}>{s.label}</div>
                    <div style={{ fontSize: 11, color: '#9CA3AF', marginTop: 1 }}>{s.desc}</div>
                  </div>
                </div>
                {i < NAV_STEPS.length - 1 && <div style={{ width: 1.5, height: 8, background: isDone ? '#16A34A' : '#E9EDF2', marginLeft: 27 }} />}
              </div>
            );
          })}
        </div>
        <div style={{ padding: '14px 16px', borderTop: '1px solid #E9EDF2', fontSize: 11.5, color: '#9CA3AF' }}>
          <div style={{ fontWeight: 600, color: '#374151', marginBottom: 1 }}>HR Admin</div>
          <div>TechCorp India</div>
        </div>
      </aside>

      {/* MAIN */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        {/* TOPBAR */}
        <div style={{ background: '#fff', borderBottom: '1.5px solid #E9EDF2', padding: '12px 28px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', position: 'sticky', top: 0, zIndex: 20 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div style={{ display: 'flex', gap: 0, background: '#F8FAFC', border: '1px solid #E9EDF2', borderRadius: 9, padding: 3, overflowX: 'auto' }}>
              {NAV_STEPS.map((s, i) => (
                <div key={s.id} onClick={() => goTo(i)} style={{
                  padding: '5px 11px', borderRadius: 6, cursor: 'pointer',
                  fontSize: 11.5, fontWeight: i === step ? 600 : 400,
                  color:      i === step ? '#2563EB' : done.has(i) ? '#16A34A' : '#9CA3AF',
                  background: i === step ? '#fff' : 'transparent',
                  boxShadow:  i === step ? '0 1px 3px rgba(0,0,0,.07)' : 'none',
                  whiteSpace: 'nowrap', transition: 'all .15s',
                }}>
                  <span style={{ display: 'block', fontSize: 13, fontWeight: 700 }}>{done.has(i) && i !== step ? '✓' : i + 1}</span>
                  {s.label.split(' ')[0]}
                </div>
              ))}
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ fontSize: 13, color: '#9CA3AF' }}>PMS Setup</span>
            <div style={{ width: 32, height: 32, borderRadius: '50%', background: 'linear-gradient(135deg,#2563EB,#6366f1)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontSize: 12.5, fontWeight: 600 }}>HR</div>
          </div>
        </div>

        {/* CONTENT */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '28px 32px 100px' }}>
          <div style={{ marginBottom: 6, fontSize: 11, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: '#2563EB' }}>
            Step {step + 1} of 11
          </div>
          {stepComponents[step]}
        </div>

        {/* FOOTER NAV */}
        <div style={{ padding: '14px 32px', background: '#fff', borderTop: '1.5px solid #E9EDF2', display: 'flex', alignItems: 'center', justifyContent: 'space-between', position: 'sticky', bottom: 0 }}>
          <div style={{ fontSize: 13, color: '#9CA3AF' }}>
            Step <strong style={{ color: '#2563EB' }}>{step + 1}</strong> of 11 — {NAV_STEPS[step].label}
          </div>
          <div style={{ display: 'flex', gap: 10 }}>
            {step > 0 && (
              <button onClick={back} style={{ padding: '9px 20px', border: '1.5px solid #E2E8F0', borderRadius: 9, fontSize: 13.5, cursor: 'pointer', background: '#fff', fontFamily: 'inherit' }}>
                ← Back
              </button>
            )}
            <button onClick={next} style={{ padding: '9px 22px', background: step === 10 ? '#16A34A' : '#2563EB', color: '#fff', border: 'none', borderRadius: 9, fontSize: 13.5, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' }}>
              {step === 10 ? '🚀 Launch' : `Next: ${NAV_STEPS[step + 1]?.label || ''} →`}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
