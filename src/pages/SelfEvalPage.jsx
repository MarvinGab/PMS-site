import { Fragment, useEffect, useMemo, useState } from 'react';
import { readEmployeeSessionSync, readWorkflowSync } from '../backend/stateStore';
import { useApp } from '../AppContext';
import { usePMSData, SUB_PHASE } from '../hooks/usePMSData';
import { RatingWidget } from '../components/RatingWidget';
import { getEmployeeStage, setEmployeeStage, submitEmployeeStage } from '../backend/ratingsStore';
import { resolveCompetenciesForEmployee } from '../backend/competencyResolver';
import { achievementPercentFromTarget, computeGoalAutoRatings, computeSelfScoreBreakdown, formatFinalRating } from '../backend/scoring';

const ACCENT = '#2563EB';
const GOAL_ACCENT = '#7C3AED';     // violet — goals/KRAs
const GOAL_ACCENT_BG = '#F5F3FF';
const RATING_ACCENT = '#0284C7';   // sky — the act of rating
const RATING_BG = '#F0F9FF';
const RATING_BORDER = '#BAE6FD';
const COMP_ACCENT = '#0E7490';     // teal — competencies (distinct from goals + ratings)
const COMP_ACCENT_DARK = '#155E75';
const COMP_BG = '#ECFEFF';
const COMP_BORDER = '#A5F3FC';
const BORDER = '#E2E8F0';
const SOFT_BG = '#F8FAFC';
const FALLBACK_GOAL_COLORS = ['#2563EB', '#EC4899', '#EAB308', '#7C3AED', '#F97316', '#0EA5E9', '#14B8A6'];
const DEFAULT_TARGET_TYPES = [
  { id: 'tt_default_number', name: 'Number', unit: '', unitPosition: 'suffix', isNumeric: true },
  { id: 'tt_default_percentage', name: 'Percentage', unit: '%', unitPosition: 'suffix', isNumeric: true },
  { id: 'tt_default_currency', name: 'Currency', unit: '₹', unitPosition: 'prefix', isNumeric: true },
  { id: 'tt_neg_number', name: 'Negative number', unit: '', unitPosition: 'suffix', isNumeric: true, lowerIsBetter: true },
  { id: 'tt_neg_currency', name: 'Negative currency', unit: '₹', unitPosition: 'prefix', isNumeric: true, lowerIsBetter: true },
  { id: 'tt_default_text', name: 'Free text', unit: '', unitPosition: 'suffix', isNumeric: false },
];

function normalizeTargetTypeName(value) {
  return String(value || '').trim().toLowerCase().replace(/[_\s-]+/g, ' ');
}

function getMergedTargetTypes(config = {}) {
  const stored = Array.isArray(config?.targetTypes) ? config.targetTypes : [];
  const storedById = new Map(stored.map((type) => [type.id, type]));
  const defaults = DEFAULT_TARGET_TYPES.map((type) => ({ ...type, ...(storedById.get(type.id) || {}) }));
  const custom = stored.filter((type) => type?.id && !DEFAULT_TARGET_TYPES.some((item) => item.id === type.id));
  return [...defaults, ...custom].filter((type) => !type.hidden);
}

function getTargetTypeMeta(typeId, targetTypes = []) {
  const raw = String(typeId || '').trim();
  const normalized = normalizeTargetTypeName(raw);
  return (targetTypes || []).find((type) => type.id === raw)
    || (targetTypes || []).find((type) => normalizeTargetTypeName(type.name) === normalized)
    || DEFAULT_TARGET_TYPES.find((type) => type.id === raw)
    || DEFAULT_TARGET_TYPES.find((type) => normalizeTargetTypeName(type.name) === normalized)
    || DEFAULT_TARGET_TYPES.find((type) => type.id === 'tt_default_text');
}

function formatTargetValue(value, typeId, targetTypes = []) {
  const text = String(value || '').trim();
  if (!text) return '';
  const meta = getTargetTypeMeta(typeId, targetTypes);
  const unit = String(meta?.unit || '').trim();
  if (!unit) return text;
  return meta?.unitPosition === 'prefix' ? `${unit} ${text}` : `${text} ${unit}`;
}

function getAchievementPercent(target, achievement, typeId, targetTypes = []) {
  return achievementPercentFromTarget(target, achievement, typeId, targetTypes);
}

function getEmployeeGroup(config, employee) {
  const groupName = String(employee?.['Group Name'] || '').trim().toLowerCase();
  if (!groupName) return null;
  return (config?.goalGroups || []).find(
    (g) => String(g.name || '').trim().toLowerCase() === groupName
  ) || null;
}

function normalizeCode(v) {
  return String(v || '').trim().toUpperCase();
}

function findEmployee(employees, empCode) {
  return employees.find((e) => normalizeCode(e['Employee Code']) === normalizeCode(empCode)) || null;
}

function getGoalColor(kra = {}, config = {}, index = 0) {
  const stored = String(kra.displayColor || '').trim();
  if (stored) return stored;
  const perspectiveName = String(kra.perspName || '').trim();
  const perspective = (config?.perspectives || []).find(
    (p) => String(p?.name || '').trim() === perspectiveName
  );
  if (perspective?.color) return perspective.color;
  return FALLBACK_GOAL_COLORS[index % FALLBACK_GOAL_COLORS.length];
}

function getEmployeeGoals(orgKey, empCode) {
  const wf = readWorkflowSync(orgKey);
  const submission = wf.submissions?.[normalizeCode(empCode)];
  return submission?.goals || [];
}

function getOverrideEmpCode() {
  const hash = window.location.hash || '';
  const qIdx = hash.indexOf('?');
  if (qIdx === -1) return '';
  const params = new URLSearchParams(hash.slice(qIdx + 1));
  return params.get('as') || '';
}

export default function SelfEvalPage({ embedded = false, overrideEmpCode = '', overrideOrgKey = '' } = {}) {
  const empSession = readEmployeeSessionSync();
  const { role, orgKey: adminOrgKey } = useApp();
  const isHRAdmin = role === 'hr-admin' || role === 'super-admin';
  const overrideCode = embedded ? overrideEmpCode : getOverrideEmpCode();
  const orgKey = overrideOrgKey || empSession?.orgKey || (isHRAdmin ? adminOrgKey : '') || '';
  const actingEmpCode = embedded
    ? (overrideEmpCode || empSession?.empCode)
    : (isHRAdmin && overrideCode ? overrideCode : empSession?.empCode);
  const session = empSession || (isHRAdmin && overrideCode ? { orgKey, empCode: overrideCode, name: 'HR preview' } : null);

  const { ready, config, employees, subPhase, activeSubPhases = [], workflow } = usePMSData(orgKey);
  const employee = findEmployee(employees, actingEmpCode);
  const myStatus = workflow?.submissions?.[String(actingEmpCode || '').trim().toUpperCase()]?.status || null;
  const goals = useMemo(() => getEmployeeGoals(orgKey, actingEmpCode), [orgKey, actingEmpCode]);
  const resolved = useMemo(() => resolveCompetenciesForEmployee(config, employee), [config, employee]);
  const competencies = resolved.competencies;
  const targetTypes = useMemo(() => getMergedTargetTypes(config), [config]);

  const initial = getEmployeeStage(orgKey, actingEmpCode, 'self') || {};
  const [scores, setScores] = useState(initial.itemScores || {});
  const [comments] = useState(initial.itemComments || {});
  const [achievements, setAchievements] = useState(initial.achievements || {});
  const [compScores, setCompScores] = useState(initial.competencyScores || {});
  const [overallComment, setOverallComment] = useState(initial.overallComment || '');
  const [overallOpen, setOverallOpen] = useState(!!(initial.overallComment || ''));
  const [saved, setSaved] = useState(!!initial.submittedAt);
  const [savedMsg, setSavedMsg] = useState('');
  const [submitErrors, setSubmitErrors] = useState([]);
  const [errorsOpen, setErrorsOpen] = useState(false);
  const [softArmed, setSoftArmed] = useState(false);
  const [finalOpen, setFinalOpen] = useState(false);

  if (!session?.empCode && !isHRAdmin) {
    return <ShellMessage title="Sign in required" message="Open this page from the employee sign-in flow." />;
  }
  if (!ready) {
    return <ShellMessage title="Loading…" message="Reading cycle data." />;
  }
  if (!employee) {
    return <ShellMessage title="Employee not found" message={`No employee with code "${actingEmpCode || '—'}" exists for this org.${isHRAdmin && !overrideCode ? ' HR admins: append #self-eval?as=EMP_CODE to preview as a specific employee.' : ''}`} />;
  }
  const selfWindowActive = activeSubPhases.includes(SUB_PHASE.SELF_EVALUATION) || subPhase === SUB_PHASE.SELF_EVALUATION;
  const phaseActive = selfWindowActive || myStatus === 'approved';
  const previewMode = !phaseActive && (isHRAdmin || !!overrideCode);
  if (!phaseActive && !previewMode) {
    return <ShellMessage title="Self-evaluation is not open" message={`Current cycle phase: ${subPhase}. Self-evaluation is only editable during the self-evaluation window in the cycle calendar.`} />;
  }

  const bands = config.autoRatingBands || [];
  const autoOn = config.autoRating !== false;
  const actor = isHRAdmin ? `HR (${empSession?.empCode || 'admin'} as ${actingEmpCode})` : actingEmpCode;
  const buildPayload = () => ({
    itemScores: scores,
    itemComments: comments,
    achievements,
    competencyScores: compScores,
    overallComment,
  });

  const onSaveDraft = () => {
    setEmployeeStage(orgKey, actingEmpCode, 'self', { ...buildPayload(), submittedAt: null, submittedBy: null });
    setSaved(false);
    setSavedMsg('Draft saved.');
  };

  const group = getEmployeeGroup(config, employee);
  const rateAtKpi = group?.kpiRatingMode !== 'free-text';
  const configuredTargetLevel = config?.targetLevelMode === 'KRA'
    ? 'KRA'
    : config?.targetLevelMode === 'KPI'
      ? 'KPI'
      : config?.targetLevel === 'KRA'
        ? 'KRA'
        : 'KPI';
  const targetLevel = group?.targetLevel === 'KRA' ? 'KRA' : (group?.targetLevel === 'KPI' ? 'KPI' : configuredTargetLevel);
  const targetsEnabled = config?.targetsEnabled !== false;
  const targetAtKra = targetsEnabled && targetLevel === 'KRA';
  const targetAtKpi = targetsEnabled && targetLevel !== 'KRA';
  const selfRatesCompetencies = config.competencyAllowSelfRate !== false;
  const isMissingScore = (value) => value === null || value === undefined || value === '';
  const isMissingAchievement = (value) => String(value ?? '').trim() === '';
  const isInvalidAchievement = (value, typeId) => {
    if (isMissingAchievement(value)) return true;
    const meta = getTargetTypeMeta(typeId, targetTypes);
    if (!meta?.isNumeric) return false;
    const n = Number(value);
    return !Number.isFinite(n) || n < 0;
  };
  // Ratings block submission. Blank achievements warn once, then can be submitted
  // so managers can review, rate, or request completion.
  const validateSelfEvaluation = () => {
    const errors = [];
    const addError = (key, text, severity = 'hard') => errors.push({ key, text, severity });
    if (goals.length === 0) {
      addError('goals', 'No approved goals are available to submit.');
    }
    goals.forEach((kra) => {
      const kpis = kra.kpis || [];
      if (!rateAtKpi && isMissingScore(scores[kra.id])) {
        addError(`score:${kra.id}`, `Add self score for "${kra.name || 'this goal'}".`);
      }
      if (targetAtKra && kra.target && isInvalidAchievement(achievements[kra.id], kra.targetType)) {
        addError(`achievement:${kra.id}`, `Achievement for "${kra.name || 'this goal'}" is blank.`, 'soft');
      }
      if (rateAtKpi) {
        kpis.forEach((kpi) => {
          if (isMissingScore(scores[kpi.id])) {
            addError(`score:${kpi.id}`, `Add self score for KPI "${kpi.name || 'Unnamed KPI'}".`);
          }
        });
      }
      if (targetAtKpi) {
        kpis.forEach((kpi) => {
          if (kpi.target && isInvalidAchievement(achievements[kpi.id], kpi.targetType)) {
            addError(`achievement:${kpi.id}`, `Achievement for KPI "${kpi.name || 'Unnamed KPI'}" is blank.`, 'soft');
          }
        });
      }
    });
    if (selfRatesCompetencies) {
      competencies.forEach((name) => {
        if (isMissingScore(compScores[name])) {
          addError(`competency:${name}`, `Add self score for competency "${name}".`);
        }
      });
    }
    return errors;
  };
  const onSubmit = () => {
    const all = validateSelfEvaluation();
    const hard = all.filter((e) => e.severity === 'hard');
    const soft = all.filter((e) => e.severity === 'soft');
    if (hard.length > 0) {
      setSubmitErrors(all);
      setSavedMsg('');
      setSaved(false);
      setEmployeeStage(orgKey, actingEmpCode, 'self', { ...buildPayload(), submittedAt: null, submittedBy: null });
      return;
    }
    // First time blank achievements are seen, warn once and let the next click go through.
    if (soft.length > 0 && !softArmed) {
      setSubmitErrors(soft);
      setSoftArmed(true);
      setSavedMsg('');
      setSaved(false);
      return;
    }
    submitEmployeeStage(orgKey, actingEmpCode, 'self', buildPayload(), actor);
    setSaved(true);
    setSubmitErrors([]);
    setSavedMsg('Self-evaluation submitted.');
  };
  const scoreBreakdown = computeSelfScoreBreakdown({
    config, goals, scores, rateAtKpi,
    competencies, compScores,
    competenciesSelfRated: selfRatesCompetencies,
    resolved,
  });
  const autoScores = useMemo(() => {
    if (config.autoRating === false) return {};
    const out = {};
    goals.forEach((kra) => {
      const auto = computeGoalAutoRatings({
        kra,
        achievements,
        targetLevel,
        rateAtKpi,
        bands,
        targetTypes,
      });
      Object.entries(auto.scores || {}).forEach(([id, score]) => {
        if (score !== null && score !== undefined && Number.isFinite(Number(score))) out[id] = score;
      });
    });
    return out;
  }, [config.autoRating, goals, achievements, targetLevel, rateAtKpi, bands, targetTypes]);
  useEffect(() => {
    if (config.autoRating === false || saved) return;
    setScores((prev) => {
      let changed = false;
      const next = { ...prev };
      Object.entries(autoScores).forEach(([id, score]) => {
        if (isMissingScore(next[id])) {
          next[id] = score;
          changed = true;
        }
      });
      return changed ? next : prev;
    });
  }, [autoScores, config.autoRating, saved]);
  const invalidKeys = new Set(submitErrors.map((err) => err.key));
  const hasHardErrors = submitErrors.some((e) => e.severity === 'hard');
  const onlySoftPending = submitErrors.length > 0 && !hasHardErrors;
  const isSubmittedLocked = saved && validateSelfEvaluation().filter((e) => e.severity === 'hard').length === 0;
  const clearSubmitFeedback = () => {
    if (savedMsg) setSavedMsg('');
    if (submitErrors.length) setSubmitErrors([]);
  };
  const setScoreValue = (id, value) => {
    clearSubmitFeedback();
    setScores((prev) => ({ ...prev, [id]: value }));
  };
  const setAchievementValue = (id, value) => {
    clearSubmitFeedback();
    setAchievements((prev) => ({ ...prev, [id]: value }));
  };
  const setCompetencyScoreValue = (name, value) => {
    clearSubmitFeedback();
    setCompScores((prev) => ({ ...prev, [name]: value }));
  };
  const setOverallCommentValue = (value) => {
    clearSubmitFeedback();
    setOverallComment(value);
  };

  return (
    <div style={embedded
      ? { padding: '0' }
      : { minHeight: '100vh', background: SOFT_BG, padding: '32px 16px', fontFamily: "'Geist','Inter','Segoe UI',Arial,sans-serif" }
    }>
      <div style={embedded ? {} : { maxWidth: 1040, margin: '0 auto' }}>
        {previewMode && (
          <NoticeCard tone="warn" title="HR proxy mode">
            Calendar phase is "{subPhase}", not self-evaluation. HR proxy bypass is active, so edits are saved against this employee record. Employees will only see this page when their self-evaluation window is open.
          </NoticeCard>
        )}

        {initial.completionRequested && !initial.submittedAt && (
          <NoticeCard tone="info" title="Your manager asked you to complete a few things">
            {initial.completionRequested.note
              ? `“${initial.completionRequested.note}” — please fill the blanks below and submit again.`
              : 'Please fill the blank fields below and submit your self-evaluation again.'}
          </NoticeCard>
        )}

        {goals.length === 0 && (
          <NoticeCard tone="warn" title="No goals on record">
            You have no goals submitted for this cycle. Self-evaluation needs approved goals to score against.
          </NoticeCard>
        )}

        {/* GOALS SECTION */}
        {goals.length > 0 && (
          <SectionHeader
            accent={GOAL_ACCENT} bg={GOAL_ACCENT_BG}
            kicker="Section 1"
            title="Self goal evaluation"
          />
        )}

        {goals.map((kra, idx) => {
          const goalColor = getGoalColor(kra, config, idx);
          const kraScore = scores[kra.id] ?? null;
          const kraAch = achievements[kra.id] ?? '';
          const hasKpis = (kra.kpis || []).length > 0;
          const kraAchievementPct = getAchievementPercent(kra.target, kraAch, kra.targetType, targetTypes);
          const autoScore = autoOn ? autoScores[kra.id] : null;
          return (
            <GoalCard key={kra.id} accent={goalColor}>
              <GoalHeader idx={idx} kra={kra} accent={goalColor} showInlineTarget={!targetAtKra}>
                {(targetAtKra || !rateAtKpi) && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                    {targetAtKra && kra.target && (
                      <div style={{ minWidth: 150 }}>
                        <TargetDisplayBox target={kra.target} targetType={kra.targetType} targetTypes={targetTypes} />
                      </div>
                    )}
                    {targetAtKra && kra.target && (
                      <div style={{ minWidth: 180 }}>
                        <AchievementInput
                          value={kraAch}
                          onChange={(v) => setAchievementValue(kra.id, v)}
                          disabled={isSubmittedLocked}
                          accent={goalColor}
                          invalid={invalidKeys.has(`achievement:${kra.id}`)}
                          targetType={kra.targetType}
                          targetTypes={targetTypes}
                        />
                      </div>
                    )}
                    {!rateAtKpi && (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'flex-start' }}>
                        <span style={{ ...FIELD_LABEL, color: invalidKeys.has(`score:${kra.id}`) ? '#E11D48' : goalColor, whiteSpace: 'nowrap' }}>Your score</span>
                        <RatingWidget
                          value={kraScore}
                          onChange={(v) => setScoreValue(kra.id, v)}
                          config={config}
                          disabled={isSubmittedLocked}
                          suggestedScore={autoScore}
                        />
                      </div>
                    )}
                  </div>
                )}
              </GoalHeader>
              {rateAtKpi && hasKpis ? (
                <div>
                  {kra.kpis.map((kpi, kpiIdx) => {
                    const kpiAch = achievements[kpi.id] ?? '';
                    const kpiAchievementPct = getAchievementPercent(kpi.target, kpiAch, kpi.targetType, targetTypes);
                    const kpiSuggested = autoOn ? autoScores[kpi.id] : null;
                    return (
                      <KpiWithRating
                        key={kpi.id}
                        kpi={kpi} kpiIdx={kpiIdx}
                        isLast={kpiIdx === kra.kpis.length - 1}
                        achievement={kpiAch}
                        onAchievementChange={(v) => setAchievementValue(kpi.id, v)}
                        achievementInvalid={invalidKeys.has(`achievement:${kpi.id}`)}
                        score={scores[kpi.id] ?? null}
                        onScoreChange={(v) => setScoreValue(kpi.id, v)}
                        scoreInvalid={invalidKeys.has(`score:${kpi.id}`)}
                        config={config}
                        suggested={kpiSuggested}
                        disabled={isSubmittedLocked}
                        accent={goalColor}
                        showAchievement={targetAtKpi && !!kpi.target}
                        targetTypes={targetTypes}
                      />
                    );
                  })}
                </div>
              ) : (
                hasKpis ? (
                  <KpiContextList
                    kpis={kra.kpis}
                    accent={goalColor}
                    showWeights={false}
                    showAchievements={targetAtKpi}
                    achievements={achievements}
                    onAchievementChange={setAchievementValue}
                    invalidKeys={invalidKeys}
                    disabled={isSubmittedLocked}
                    targetTypes={targetTypes}
                  />
                ) : null
              )}
            </GoalCard>
          );
        })}

        {/* COMPETENCIES SECTION */}
        {competencies.length > 0 && (() => {
          const selfRateOn = config.competencyAllowSelfRate !== false;
          return (
            <>
              <SectionHeader
                accent={COMP_ACCENT} bg={COMP_BG}
                kicker="Section 2"
                title="Self competency evaluation"
                subtitle={selfRateOn ? '' : 'Your manager will score these. Listed here for reference.'}
                rightLabel={resolved.sourceLabel}
              />
              <div style={{
                background: '#fff',
                border: `2px solid ${COMP_BORDER}`,
                borderRadius: 14,
                overflow: 'hidden',
                marginBottom: 18,
                boxShadow: '0 1px 2px rgba(14,116,144,0.04)',
              }}>
                <div style={{
                  padding: '12px 20px',
                  background: COMP_BG,
                  borderBottom: `1px solid ${COMP_BORDER}`,
                  display: 'flex', alignItems: 'center', gap: 10,
                }}>
                  <div style={{
                    width: 6, height: 6, borderRadius: 999, background: COMP_ACCENT,
                  }} />
                  <div style={{ fontSize: 11.5, fontWeight: 800, color: COMP_ACCENT_DARK, textTransform: 'uppercase', letterSpacing: '.06em' }}>
                    {competencies.length} {competencies.length === 1 ? 'competency' : 'competencies'} to {selfRateOn ? 'self-assess' : 'reference'}
                  </div>
                </div>
                <div>
                  {competencies.map((name, cIdx) => (
                    <div key={name} style={{
                      padding: '16px 20px',
                      borderBottom: cIdx === competencies.length - 1 ? 'none' : `1px solid ${COMP_BORDER}`,
                      display: 'grid',
                      gridTemplateColumns: selfRateOn ? '1fr 1.4fr' : '1fr',
                      gap: 16,
                      alignItems: 'center',
                    }}>
                      <div>
                        <div style={{ fontSize: 11, fontWeight: 800, color: COMP_ACCENT, textTransform: 'uppercase', letterSpacing: '.04em' }}>Competency {cIdx + 1}</div>
                        <div style={{ fontSize: 14.5, fontWeight: 700, color: '#0F172A', marginTop: 2 }}>{name}</div>
                      </div>
                      {selfRateOn && (
                        <div style={{
                          background: COMP_BG,
                          border: `1px solid ${COMP_BORDER}`,
                          borderRadius: 10,
                          padding: '10px 14px',
                        }}>
                          <div style={{ fontSize: 10.5, fontWeight: 800, color: COMP_ACCENT_DARK, textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 6 }}>Your score</div>
                          <RatingWidget
                            value={compScores[name] ?? null}
                            onChange={(v) => setCompetencyScoreValue(name, v)}
                            config={config}
                            disabled={isSubmittedLocked}
                          />
                          {invalidKeys.has(`competency:${name}`) && (
                            <div style={{ marginTop: 6, fontSize: 11, color: '#E11D48', fontWeight: 700 }}>Needs a score</div>
                          )}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            </>
          );
        })()}

        {/* OVERALL */}
        <button
          type="button"
          onClick={() => setOverallOpen((o) => !o)}
          style={{
            display: 'block', width: '100%', textAlign: 'left', cursor: 'pointer',
            background: 'transparent', border: 'none',
            marginTop: 26, marginBottom: 12, padding: '0 4px', fontFamily: 'inherit',
          }}
        >
          <div style={{
            display: 'inline-block', padding: '3px 10px', borderRadius: 999,
            background: '#F1F5F9', color: '#64748B', fontSize: 10.5, fontWeight: 800,
            textTransform: 'uppercase', letterSpacing: '.06em',
          }}>{competencies.length > 0 ? 'Section 3' : 'Section 2'}</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 6 }}>
            <span style={{ fontSize: 17, fontWeight: 800, color: '#0F172A' }}>Overall comment</span>
            <span style={{
              display: 'inline-flex', alignItems: 'center', gap: 5,
              padding: '3px 10px', borderRadius: 999,
              background: '#EFF6FF', color: '#2563EB', fontSize: 12, fontWeight: 700,
            }}>
              {overallOpen ? 'Hide ▲' : (overallComment ? 'Edit ▼' : 'Add ▼')}
            </span>
          </div>
          <div style={{ fontSize: 12.5, color: '#64748B', marginTop: 2 }}>What went well, what you'd improve, what blocked you.</div>
        </button>
        {overallOpen && (
          <div style={{ background: '#fff', border: `1px solid ${BORDER}`, borderRadius: 14, padding: 18, marginBottom: 18 }}>
            <textarea
              value={overallComment}
              onChange={(e) => setOverallCommentValue(e.target.value)}
              disabled={isSubmittedLocked}
              rows={4}
              style={{ width: '100%', padding: 12, borderRadius: 8, border: `1px solid ${BORDER}`, fontFamily: 'inherit', fontSize: 13, resize: 'vertical', boxSizing: 'border-box' }}
              placeholder="Reflect on this cycle…"
            />
          </div>
        )}

        <SelfScoreSummary
          open={finalOpen}
          onToggle={() => setFinalOpen((o) => !o)}
          config={config}
          breakdown={scoreBreakdown}
        />

        <div style={{ marginTop: 18, padding: '14px 18px', background: '#fff', border: `1px solid ${submitErrors.length ? '#FBC4CB' : BORDER}`, borderRadius: 12, position: 'sticky', bottom: 12, boxShadow: '0 -8px 24px rgba(15,23,42,0.04)' }}>
          {submitErrors.length > 0 && (
            <div style={{ marginBottom: 10, borderRadius: 9, background: '#FFF7F8', border: '1px solid #FBD9DE', color: '#9F1239', overflow: 'hidden' }}>
              <button
                type="button"
                onClick={() => setErrorsOpen((o) => !o)}
                style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10,
                  width: '100%', padding: '9px 11px', background: 'transparent', border: 'none',
                  cursor: 'pointer', fontFamily: 'inherit', color: 'inherit', textAlign: 'left',
                }}
              >
                <span style={{ fontSize: 12.5, fontWeight: 800 }}>
                  {hasHardErrors
                    ? `${submitErrors.length} ${submitErrors.length === 1 ? 'field' : 'fields'} still need a value`
                    : `${submitErrors.length} achievement ${submitErrors.length === 1 ? 'field is' : 'fields are'} blank — submit anyway, or fill them in`}
                </span>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11.5, fontWeight: 700, whiteSpace: 'nowrap' }}>
                  {errorsOpen ? 'Hide ▲' : 'View ▼'}
                </span>
              </button>
              {errorsOpen && (
                <ul style={{ margin: 0, padding: '0 14px 11px 28px', maxHeight: 168, overflowY: 'auto', listStyle: 'disc' }}>
                  {submitErrors.map((err) => (
                    <li key={err.key} style={{ fontSize: 11.5, lineHeight: 1.5, marginTop: 3 }}>{err.text}</li>
                  ))}
                </ul>
              )}
            </div>
          )}
          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            <button
              type="button" onClick={onSaveDraft} disabled={isSubmittedLocked}
              style={btnStyle('ghost', isSubmittedLocked)}>Save draft</button>
            <button
              type="button" onClick={onSubmit} disabled={isSubmittedLocked}
              style={btnStyle('primary', isSubmittedLocked)}>{onlySoftPending ? 'Submit anyway' : 'Submit self-evaluation'}</button>
            {savedMsg && <span style={{ fontSize: 12, color: '#16A34A', fontWeight: 700 }}>{savedMsg}</span>}
            {isSubmittedLocked && <span style={{ fontSize: 12, color: '#16A34A', fontWeight: 700 }}>Submitted — waiting on manager rating.</span>}
          </div>
        </div>
      </div>
    </div>
  );
}

// ────────── GOAL PIECES ──────────

function GoalCard({ children, accent = GOAL_ACCENT }) {
  return (
    <div style={{
      background: '#fff',
      border: `1px solid ${accent}33`,
      borderLeft: `4px solid ${accent}`,
      borderRadius: 14,
      marginBottom: 14,
      overflow: 'hidden',
      boxShadow: '0 1px 2px rgba(15,23,42,0.03)',
    }}>{children}</div>
  );
}

function GoalHeader({ idx, kra, accent = GOAL_ACCENT, children, showInlineTarget = true }) {
  return (
    <div style={{
      padding: '12px 18px',
      borderBottom: `1px solid ${BORDER}`,
      background: `${accent}0D`,
    }}>
      <div style={{
        display: 'flex',
        gap: 18,
        alignItems: 'center',
        justifyContent: 'space-between',
        flexWrap: 'wrap',
      }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 10.5, fontWeight: 800, color: accent, textTransform: 'uppercase', letterSpacing: '.06em' }}>
              {kra.perspName && kra.perspName !== 'All KRAs' ? kra.perspName : `Goal ${idx + 1}`}
            </span>
            <span style={{ padding: '2px 9px', borderRadius: 999, background: '#fff', color: accent, fontSize: 11, fontWeight: 800, border: `1px solid ${accent}33` }}>
              {kra.weight || 0}%
            </span>
          </div>
          <div style={{ fontSize: 16.5, fontWeight: 800, color: '#0F172A', marginTop: 3 }}>{kra.name}</div>
          {showInlineTarget && kra.target && (
            <div style={{ marginTop: 3, fontSize: 12, color: '#64748B' }}>
              Target: {kra.target}{kra.targetType && kra.targetType !== 'none' ? ` (${kra.targetType})` : ''}
            </div>
          )}
        </div>
        {children}
      </div>
    </div>
  );
}

function TypeChip({ children, color = '#64748B' }) {
  if (!children) return null;
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', maxWidth: 120, padding: '2px 7px', borderRadius: 999, background: '#EEF2F7', color, fontSize: 10, fontWeight: 850, textTransform: 'none', letterSpacing: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
      {children}
    </span>
  );
}

// Shared shell so Target and Achievement render as a matched pair (same size, same look).
const FIELD_BOX = {
  display: 'flex', flexDirection: 'column', gap: 4,
  border: '1px solid #E2E8F0', borderRadius: 8, background: '#fff',
  padding: '7px 10px', minWidth: 0, boxSizing: 'border-box', minHeight: 50,
};
const FIELD_HEAD = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 };
const FIELD_LABEL = { fontSize: 10.5, fontWeight: 850, textTransform: 'uppercase', letterSpacing: '.04em' };
const FIELD_VALUE = { fontSize: 14, fontWeight: 800, color: '#0F172A' };

function TargetDisplayBox({ target, targetType, targetTypes = [], label = 'Target' }) {
  if (!target) return null;
  const meta = getTargetTypeMeta(targetType, targetTypes);
  const displayValue = formatTargetValue(target, targetType, targetTypes);
  return (
    <div style={FIELD_BOX}>
      <div style={FIELD_HEAD}>
        <span style={{ ...FIELD_LABEL, color: '#64748B' }}>{label}</span>
        <TypeChip>{meta?.name}</TypeChip>
      </div>
      <div style={{ ...FIELD_VALUE, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {displayValue}
      </div>
    </div>
  );
}

const COL_HEAD = { fontSize: 10, fontWeight: 850, color: '#94A3B8', textTransform: 'uppercase', letterSpacing: '.04em', paddingBottom: 7 };

function AchievementCell({ value, onChange, disabled, invalid = false, targetType = null, targetTypes = [] }) {
  const meta = getTargetTypeMeta(targetType, targetTypes);
  const unit = String(meta?.unit || '').trim();
  const inputType = normalizeTargetTypeName(meta?.name) === 'date' ? 'date' : 'text';
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 6, width: '100%', boxSizing: 'border-box',
      padding: '9px 12px', borderRadius: 8,
      border: `1px solid ${invalid ? '#FBC4CB' : '#E2E8F0'}`,
      background: invalid ? '#FFF7F8' : '#fff',
      cursor: disabled ? 'not-allowed' : 'text',
      transition: 'border-color 150ms ease, background 150ms ease',
    }}>
      {unit && meta?.unitPosition === 'prefix' ? <span style={{ color: '#94A3B8', fontWeight: 800, fontSize: 13 }}>{unit}</span> : null}
      <input
        type={inputType}
        inputMode={meta?.isNumeric ? 'decimal' : undefined}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Enter achieved"
        style={{ width: '100%', minWidth: 0, border: 'none', outline: 'none', padding: 0, fontSize: 13.5, fontWeight: 700, color: '#0F172A', background: 'transparent', fontFamily: 'inherit' }}
      />
      {unit && meta?.unitPosition !== 'prefix' ? <span style={{ color: '#94A3B8', fontWeight: 800, fontSize: 12.5 }}>{unit}</span> : null}
    </span>
  );
}

function KpiContextList({ kpis, accent = GOAL_ACCENT, showWeights = true, showAchievements = false, achievements = {}, onAchievementChange, invalidKeys = new Set(), disabled = false, targetTypes = [] }) {
  if (!showAchievements) {
    return (
      <div style={{ padding: '10px 18px', background: '#fff' }}>
        <div style={{ ...COL_HEAD, paddingBottom: 6 }}>Key Performance Indicators</div>
        {kpis.map((kpi) => (
          <div key={kpi.id} style={{ display: 'flex', gap: 9, alignItems: 'center', padding: '6px 0', borderTop: '1px solid #F1F5F9' }}>
            <span style={{ color: accent, fontWeight: 800, fontSize: 13 }}>•</span>
            <span style={{ fontSize: 13.5, fontWeight: 700, color: '#0F172A' }}>{kpi.name}</span>
            {showWeights && Number(kpi.weight) > 0 ? <span style={{ marginLeft: 'auto', fontSize: 11.5, color: '#64748B', fontWeight: 700 }}>{kpi.weight}%</span> : null}
          </div>
        ))}
      </div>
    );
  }
  const cellBase = { padding: '7px 0', borderTop: '1px solid #F1F5F9', display: 'flex', alignItems: 'center', minWidth: 0 };
  return (
    <div style={{ padding: '10px 18px', background: '#fff' }}>
      <div style={{
        display: 'grid',
        gridTemplateColumns: '1fr minmax(110px, 150px) minmax(180px, 240px)',
        columnGap: 20,
        alignItems: 'center',
      }}>
        <div style={COL_HEAD}>Key Performance Indicators</div>
        <div style={COL_HEAD}>Target</div>
        <div style={COL_HEAD}>Achievement</div>
        {kpis.map((kpi) => (
          <Fragment key={kpi.id}>
            <div style={{ ...cellBase, gap: 9 }}>
              <span style={{ color: accent, fontWeight: 800, fontSize: 13 }}>•</span>
              <span style={{ fontSize: 13.5, fontWeight: 700, color: '#0F172A' }}>{kpi.name}</span>
            </div>
            <div style={{ ...cellBase, fontSize: 14, fontWeight: 800, color: kpi.target ? '#0F172A' : '#CBD5E1', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {kpi.target ? formatTargetValue(kpi.target, kpi.targetType, targetTypes) : '—'}
            </div>
            <div style={cellBase}>
              {kpi.target ? (
                <AchievementCell
                  value={achievements[kpi.id] ?? ''}
                  onChange={(value) => onAchievementChange?.(kpi.id, value)}
                  disabled={disabled}
                  invalid={invalidKeys.has(`achievement:${kpi.id}`)}
                  targetType={kpi.targetType}
                  targetTypes={targetTypes}
                />
              ) : <span style={{ fontSize: 12, color: '#CBD5E1' }}>—</span>}
            </div>
          </Fragment>
        ))}
      </div>
    </div>
  );
}

function AchievementInput({ label = 'Achievement', value, onChange, disabled, accent = RATING_ACCENT, invalid = false, targetType = null, targetTypes = [] }) {
  const meta = getTargetTypeMeta(targetType, targetTypes);
  const unit = String(meta?.unit || '').trim();
  const inputType = normalizeTargetTypeName(meta?.name) === 'date' ? 'date' : 'text';
  return (
    <label style={{
      ...FIELD_BOX,
      borderColor: invalid ? '#FBC4CB' : '#E2E8F0',
      background: invalid ? '#FFF7F8' : '#fff',
      boxShadow: invalid ? '0 0 0 3px rgba(244,63,94,0.06)' : 'none',
      transition: 'border-color 150ms ease, background 150ms ease, box-shadow 150ms ease',
      cursor: disabled ? 'not-allowed' : 'text',
    }}>
      <span style={FIELD_HEAD}>
        <span style={{ ...FIELD_LABEL, color: invalid ? '#E11D48' : accent }}>{label}</span>
        <TypeChip color={accent}>{meta?.name}</TypeChip>
      </span>
      <span style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
        {unit && meta?.unitPosition === 'prefix' ? <span style={{ ...FIELD_VALUE, color: '#94A3B8' }}>{unit}</span> : null}
        <input
          type={inputType}
          inputMode={meta?.isNumeric ? 'decimal' : undefined}
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
          placeholder={unit ? 'Enter achieved' : 'e.g. achieved'}
          style={{ ...FIELD_VALUE, minWidth: 0, width: '100%', border: 'none', outline: 'none', padding: 0, background: 'transparent', fontFamily: 'inherit' }}
        />
        {unit && meta?.unitPosition !== 'prefix' ? <span style={{ ...FIELD_VALUE, color: '#94A3B8' }}>{unit}</span> : null}
      </span>
    </label>
  );
}

function KpiWithRating({ kpi, kpiIdx, isLast, achievement, onAchievementChange, achievementInvalid = false, score, onScoreChange, scoreInvalid = false, config, suggested, disabled, accent = GOAL_ACCENT, showAchievement = true, targetTypes = [] }) {
  return (
    <div style={{ borderBottom: isLast ? 'none' : `1px solid ${BORDER}` }}>
      {/* KPI info block */}
      <div style={{ padding: '14px 20px', background: '#fff', display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'flex-start' }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 10.5, fontWeight: 800, color: '#64748B', textTransform: 'uppercase', letterSpacing: '.06em' }}>KPI {kpiIdx + 1}</div>
          <div style={{ fontSize: 14.5, fontWeight: 700, color: '#0F172A', marginTop: 2 }}>{kpi.name}</div>
        </div>
        {kpi.weight ? (
          <span style={{ padding: '4px 10px', borderRadius: 999, background: `${accent}12`, color: accent, fontSize: 11.5, fontWeight: 800 }}>
            {kpi.weight}%
          </span>
        ) : null}
      </div>
      {/* Rating block */}
      <RatingBlock
        label="Self-rate this KPI"
        achievement={achievement} onAchievementChange={onAchievementChange}
        target={kpi.target}
        targetType={kpi.targetType}
        targetLabel="KPI target"
        targetTypes={targetTypes}
        showAchievement={showAchievement}
        achievementInvalid={achievementInvalid}
        score={score} onScoreChange={onScoreChange}
        scoreInvalid={scoreInvalid}
        config={config} suggested={suggested} disabled={disabled} accent={accent}
      />
    </div>
  );
}

function RatingBlock({ label, achievement, onAchievementChange, target = null, targetType = null, targetLabel = 'Target', targetTypes = [], showAchievement = true, achievementInvalid = false, score, onScoreChange, scoreInvalid = false, config, suggested, disabled, accent = RATING_ACCENT, compact = false }) {
  return (
    <div style={{
      background: compact ? '#fff' : RATING_BG,
      border: compact ? `1px solid ${accent}33` : 'none',
      borderTop: compact ? `1px solid ${accent}33` : `1px solid ${RATING_BORDER}`,
      borderRadius: compact ? 12 : 0,
      padding: compact ? '12px' : '14px 20px',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <div style={{ width: 6, height: 6, borderRadius: 999, background: accent }} />
        <div style={{ fontSize: 11, fontWeight: 800, color: accent, textTransform: 'uppercase', letterSpacing: '.06em' }}>{label}</div>
      </div>
      <div style={{
        display: 'grid',
        gridTemplateColumns: showAchievement
          ? (target ? 'minmax(150px, 220px) minmax(150px, 220px) minmax(220px, 1fr)' : (compact ? 'minmax(150px, 0.85fr) minmax(220px, 1.4fr)' : 'minmax(200px, 280px) 1fr'))
          : 'minmax(220px, 1fr)',
        gap: compact ? 12 : 18,
        alignItems: 'center',
      }}>
        {showAchievement && target && (
          <TargetDisplayBox target={target} targetType={targetType} targetTypes={targetTypes} label={targetLabel} />
        )}
        {showAchievement && (
          <AchievementInput
            value={achievement}
            onChange={onAchievementChange}
            disabled={disabled}
            accent={accent}
            invalid={achievementInvalid}
            targetType={targetType}
            targetTypes={targetTypes}
          />
        )}
        <div style={{ padding: scoreInvalid ? 8 : 0, borderRadius: 10, border: scoreInvalid ? '1px solid #FBC4CB' : 'none', background: scoreInvalid ? '#FFF7F8' : 'transparent', transition: 'border-color 150ms ease, background 150ms ease' }}>
          {showAchievement && (
            <div style={{ fontSize: 10.5, fontWeight: 800, color: scoreInvalid ? '#E11D48' : accent, textTransform: 'uppercase', letterSpacing: '.04em', marginBottom: 6 }}>Your score</div>
          )}
          <RatingWidget value={score} onChange={onScoreChange} config={config} disabled={disabled} suggestedScore={suggested} />
          {scoreInvalid && <div style={{ marginTop: 6, fontSize: 11, color: '#E11D48', fontWeight: 700 }}>Needs a score</div>}
        </div>
      </div>
    </div>
  );
}

function fmtScore(v, points) {
  if (v === null || v === undefined) return '—';
  const r = Math.round(v * 100) / 100;
  const txt = (r % 1 === 0) ? String(r) : r.toFixed(2);
  return points ? `${txt} / ${points}` : txt;
}

function SelfScoreSummary({ open, onToggle, config, breakdown }) {
  const { goalRows, goalsScore, goalsComplete, compEnabled, compRows, compScore, compsComplete, goalShare, compShare, final, complete, scalePoints } = breakdown;
  const FINAL_ACCENT = '#2563EB';
  // Only reveal real numbers when fully scored — no misleading partial averages.
  const goalsScoredCount = breakdown.goalRatingScored ?? goalRows.filter((g) => g.score !== null && g.score !== undefined).length;
  const goalTotalCount = breakdown.goalRatingTotal ?? goalRows.length;
  const compsScoredCount = compRows.filter((c) => c.score !== null && c.score !== undefined).length;
  const totalItems = goalTotalCount + (compEnabled ? compRows.length : 0);
  const scoredItems = goalsScoredCount + (compEnabled ? compsScoredCount : 0);
  const finalText = (complete && final !== null && final !== undefined) ? formatFinalRating(config, final) : null;
  const Row = ({ label, value, weight, accent }) => (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '6px 0', borderTop: '1px solid #F1F5F9' }}>
      <span style={{ fontSize: 13, color: '#334155', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
      <span style={{ display: 'flex', alignItems: 'center', gap: 10, whiteSpace: 'nowrap' }}>
        {weight !== undefined && <span style={{ fontSize: 11.5, color: '#94A3B8', fontWeight: 700 }}>weight {weight}%</span>}
        <span style={{ fontSize: 13, fontWeight: 800, color: value === '—' ? '#CBD5E1' : (accent || '#0F172A') }}>{value}</span>
      </span>
    </div>
  );
  return (
    <div style={{ marginTop: 18, border: `1px solid ${BORDER}`, borderRadius: 14, background: '#fff', overflow: 'hidden' }}>
      <button
        type="button"
        onClick={onToggle}
        style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 14,
          width: '100%', padding: '14px 18px', background: `${FINAL_ACCENT}08`, border: 'none',
          cursor: 'pointer', fontFamily: 'inherit', textAlign: 'left',
        }}
      >
        <span>
          <span style={{ fontSize: 10.5, fontWeight: 800, color: FINAL_ACCENT, textTransform: 'uppercase', letterSpacing: '.06em' }}>Your final self score</span>
          <span style={{ display: 'block', fontSize: 12, color: '#64748B', marginTop: 2 }}>
            {complete ? 'How it adds up — tap to see the breakdown' : `Finish scoring to see your final · ${scoredItems} of ${totalItems} done`}
          </span>
        </span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 12, whiteSpace: 'nowrap' }}>
          {complete
            ? <span style={{ fontSize: 18, fontWeight: 900, color: FINAL_ACCENT }}>{finalText}</span>
            : <span style={{ fontSize: 13, fontWeight: 800, color: '#94A3B8' }}>{scoredItems} / {totalItems} scored</span>}
          <span style={{ fontSize: 12, fontWeight: 700, color: '#64748B' }}>{open ? 'Hide ▲' : 'View ▼'}</span>
        </span>
      </button>
      {open && (
        <div style={{ padding: '14px 18px' }}>
          {/* Goals */}
          <div style={{ fontSize: 11, fontWeight: 800, color: GOAL_ACCENT, textTransform: 'uppercase', letterSpacing: '.05em', marginBottom: 2 }}>Goals</div>
          {goalRows.length === 0 && <div style={{ fontSize: 12.5, color: '#94A3B8', padding: '6px 0' }}>No goals on record.</div>}
          {goalRows.map((g) => (
            <Row key={g.id} label={g.name} weight={g.weight} value={fmtScore(g.score)} accent={GOAL_ACCENT} />
          ))}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '8px 0 0', marginTop: 4, borderTop: `2px solid ${GOAL_ACCENT}22` }}>
            <span style={{ fontSize: 12.5, fontWeight: 800, color: '#0F172A' }}>Goals score {compEnabled ? `· counts for ${goalShare}%` : ''}</span>
            {goalsComplete
              ? <span style={{ fontSize: 14, fontWeight: 900, color: GOAL_ACCENT }}>{fmtScore(goalsScore, scalePoints)}</span>
              : <span style={{ fontSize: 12, fontWeight: 700, color: '#94A3B8' }}>{goalsScoredCount} of {goalTotalCount} scored</span>}
          </div>

          {/* Competencies */}
          {compEnabled && (
            <div style={{ marginTop: 16 }}>
              <div style={{ fontSize: 11, fontWeight: 800, color: COMP_ACCENT, textTransform: 'uppercase', letterSpacing: '.05em', marginBottom: 2 }}>Competencies</div>
              {compRows.map((c) => (
                <Row key={c.name} label={c.name} value={fmtScore(c.score)} accent={COMP_ACCENT} />
              ))}
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '8px 0 0', marginTop: 4, borderTop: `2px solid ${COMP_ACCENT}22` }}>
                <span style={{ fontSize: 12.5, fontWeight: 800, color: '#0F172A' }}>Competency score · counts for {compShare}%</span>
                {compsComplete
                  ? <span style={{ fontSize: 14, fontWeight: 900, color: COMP_ACCENT }}>{fmtScore(compScore, scalePoints)}</span>
                  : <span style={{ fontSize: 12, fontWeight: 700, color: '#94A3B8' }}>{compsScoredCount} of {compRows.length} scored</span>}
              </div>
            </div>
          )}

          {/* Final formula — only once everything is scored, so no partial math is shown */}
          <div style={{ marginTop: 16, padding: '12px 14px', borderRadius: 10, background: `${FINAL_ACCENT}0A`, border: `1px solid ${FINAL_ACCENT}22` }}>
            {complete ? (
              <>
                {compEnabled ? (
                  <div style={{ fontSize: 12.5, color: '#334155', lineHeight: 1.6 }}>
                    <strong>{fmtScore(goalsScore)}</strong> × {goalShare}% + <strong>{fmtScore(compScore)}</strong> × {compShare}% =
                    <strong style={{ color: FINAL_ACCENT, fontSize: 15, marginLeft: 6 }}>{fmtScore(final, scalePoints)}</strong>
                  </div>
                ) : (
                  <div style={{ fontSize: 12.5, color: '#334155' }}>
                    Goals score = <strong style={{ color: FINAL_ACCENT, fontSize: 15, marginLeft: 4 }}>{fmtScore(final, scalePoints)}</strong>
                  </div>
                )}
                <div style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontSize: 11.5, fontWeight: 800, color: '#64748B', textTransform: 'uppercase', letterSpacing: '.04em' }}>Final rating</span>
                  <span style={{ fontSize: 14, fontWeight: 900, color: FINAL_ACCENT }}>{finalText}</span>
                </div>
              </>
            ) : (
              <div style={{ fontSize: 12.5, color: '#475569', lineHeight: 1.5 }}>
                Your final rating appears once everything is scored — <strong>{scoredItems} of {totalItems}</strong> done.
                {compEnabled ? ` Goals count for ${goalShare}%, competencies ${compShare}%.` : ''}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ────────── SHARED CHROME ──────────

function SectionHeader({ accent, bg, kicker, title, subtitle, rightLabel }) {
  return (
    <div style={{
      display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', gap: 16,
      marginTop: 26, marginBottom: 12, padding: '0 4px',
    }}>
      <div>
        <div style={{
          display: 'inline-block', padding: '3px 10px', borderRadius: 999,
          background: bg, color: accent, fontSize: 10.5, fontWeight: 800,
          textTransform: 'uppercase', letterSpacing: '.06em',
        }}>{kicker}</div>
        <div style={{ fontSize: 17, fontWeight: 800, color: '#0F172A', marginTop: 6 }}>{title}</div>
        {subtitle && <div style={{ fontSize: 12.5, color: '#64748B', marginTop: 2 }}>{subtitle}</div>}
      </div>
      {rightLabel && (
        <span title={rightLabel} style={{ padding: '4px 10px', borderRadius: 999, background: bg, color: accent, fontSize: 11, fontWeight: 800 }}>
          {rightLabel}
        </span>
      )}
    </div>
  );
}

function Header({ title, subtitle, right }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10, padding: '4px 0' }}>
      <div>
        <div style={{ fontSize: 24, fontWeight: 800, color: '#0F172A' }}>{title}</div>
        {subtitle && <div style={{ fontSize: 13, color: '#64748B', marginTop: 4 }}>{subtitle}</div>}
      </div>
      {right}
    </div>
  );
}
function PillStatus({ label, color }) {
  return <span style={{ padding: '5px 11px', borderRadius: 999, background: `${color}1A`, color, fontSize: 12, fontWeight: 700 }}>{label}</span>;
}
function NoticeCard({ tone, title, children }) {
  const bg = tone === 'warn' ? '#FEF3C7' : '#EFF6FF';
  const border = tone === 'warn' ? '#FDE68A' : '#BFDBFE';
  const color = tone === 'warn' ? '#92400E' : '#1E40AF';
  return (
    <div style={{ background: bg, border: `1px solid ${border}`, borderRadius: 12, padding: 16, marginBottom: 14 }}>
      <div style={{ fontSize: 13, fontWeight: 800, color }}>{title}</div>
      <div style={{ fontSize: 12, color, marginTop: 4 }}>{children}</div>
    </div>
  );
}
function ShellMessage({ title, message }) {
  return (
    <div style={{ minHeight: '100vh', background: SOFT_BG, padding: 40, fontFamily: "'Geist','Inter','Segoe UI',Arial,sans-serif" }}>
      <div style={{ maxWidth: 540, margin: '60px auto', background: '#fff', border: `1px solid ${BORDER}`, borderRadius: 12, padding: 32, textAlign: 'center' }}>
        <div style={{ fontSize: 18, fontWeight: 800, color: '#0F172A' }}>{title}</div>
        <div style={{ fontSize: 13, color: '#64748B', marginTop: 8 }}>{message}</div>
      </div>
    </div>
  );
}
function btnStyle(kind, disabled) {
  if (kind === 'primary') {
    return {
      padding: '8px 16px', borderRadius: 8, fontSize: 13, fontWeight: 700,
      border: '1px solid #2563EB',
      background: disabled ? '#94A3B8' : '#2563EB',
      color: '#fff',
      cursor: disabled ? 'not-allowed' : 'pointer', fontFamily: 'inherit',
    };
  }
  return {
    padding: '8px 16px', borderRadius: 8, fontSize: 13, fontWeight: 700,
    border: `1px solid ${BORDER}`,
    background: '#fff', color: disabled ? '#94A3B8' : '#334155',
    cursor: disabled ? 'not-allowed' : 'pointer', fontFamily: 'inherit',
  };
}
