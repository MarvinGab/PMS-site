import { resolveCompetenciesForEmployee } from '../backend/competencyResolver';
import { formatConfiguredScore } from '../backend/scoring';

// Read-only manager-evaluation summary for the HR review popup. It follows the
// same goal hierarchy and formatting rules without exposing editable inputs.

const BORDER = '#E2E8F0';
const FIELD_LABEL = { fontSize: 10, fontWeight: 850, textTransform: 'uppercase', letterSpacing: '.04em', color: '#94A3B8' };
const FALLBACK_GOAL_COLORS = ['#2563EB', '#EC4899', '#EAB308', '#7C3AED', '#F97316', '#0EA5E9', '#14B8A6'];

function getEmployeeGroup(config, employee) {
  const groupName = String(employee?.['Group Name'] || '').trim().toLowerCase();
  if (!groupName) return null;
  return (config?.goalGroups || []).find(
    (g) => String(g.name || '').trim().toLowerCase() === groupName
  ) || null;
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

const DEFAULT_TARGET_TYPES = [
  { id: 'tt_default_number', name: 'Number', unit: '', unitPosition: 'suffix' },
  { id: 'tt_default_percentage', name: 'Percentage', unit: '%', unitPosition: 'suffix' },
  { id: 'tt_default_currency', name: 'Currency', unit: '₹', unitPosition: 'prefix' },
  { id: 'tt_neg_number', name: 'Negative number', unit: '', unitPosition: 'suffix' },
  { id: 'tt_neg_currency', name: 'Negative currency', unit: '₹', unitPosition: 'prefix' },
  { id: 'tt_neg_percentage', name: 'Negative percentage', unit: '%', unitPosition: 'suffix' },
  { id: 'tt_default_text', name: 'Free text', unit: '', unitPosition: 'suffix' },
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
  const text = String(value ?? '').trim();
  if (!text) return '';
  const meta = getTargetTypeMeta(typeId, targetTypes);
  const unit = String(meta?.unit || '').trim();
  if (!unit) return text;
  return meta?.unitPosition === 'prefix' ? `${unit} ${text}` : `${text} ${unit}`;
}

// A single read-only box (label + value), styled like the manager page fields.
function Box({ label, value, accent = '#0F172A', faded = false }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 5, minWidth: 0 }}>
      <span style={FIELD_LABEL}>{label}</span>
      <span style={{
        padding: '7px 10px', borderRadius: 8, border: `1px solid ${BORDER}`, background: '#F8FAFC',
        fontSize: 12.5, fontWeight: 800, color: faded ? '#CBD5E1' : accent,
        whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
      }}>{value}</span>
    </div>
  );
}

// Self score + manager score shown side by side, like the manager page's pair.
function ScorePairRO({ config, selfScore, managerScore, accent = '#2563EB' }) {
  const changed = managerScore !== undefined && managerScore !== null && managerScore !== ''
    && selfScore !== undefined && selfScore !== null && selfScore !== ''
    && Number(managerScore) !== Number(selfScore);
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
      <Box label="Self score" value={formatConfiguredScore(config, selfScore)} accent="#0891B2"
        faded={selfScore === undefined || selfScore === null || selfScore === ''} />
      <Box label="Manager score" value={formatConfiguredScore(config, managerScore)} accent={changed ? '#7C3AED' : accent}
        faded={managerScore === undefined || managerScore === null || managerScore === ''} />
    </div>
  );
}

export function ManagerEvalReadOnly({ config, emp, goals = [], submission = null, selfStage = {}, managerStage = {} }) {
  const group = getEmployeeGroup(config, emp);
  const rateAtKpi = group?.kpiRatingMode !== 'free-text';
  const configuredTargetLevel = config?.targetLevelMode === 'KRA'
    ? 'KRA'
    : config?.targetLevelMode === 'KPI'
      ? 'KPI'
      : config?.targetLevel === 'KRA' ? 'KRA' : 'KPI';
  const targetLevel = group?.targetLevel === 'KRA' ? 'KRA' : (group?.targetLevel === 'KPI' ? 'KPI' : configuredTargetLevel);
  const targetsEnabled = config?.targetsEnabled !== false;
  const targetAtKra = targetsEnabled && targetLevel === 'KRA';
  const targetAtKpi = targetsEnabled && targetLevel !== 'KRA';
  const targetTypes = getMergedTargetTypes(config);
  const commentMode = config?.managerCommentMode || 'overall';

  const empAch = selfStage.achievements || {};
  const mgrAch = { ...empAch, ...(managerStage.achievements || {}) };
  const resolved = resolveCompetenciesForEmployee(config, emp, submission);
  const competencies = resolved.competencies || [];

  const achRow = (id, color) => {
    const item = goalItem(id);
    if (!targetsEnabled || !item || !String(item.target ?? '').trim()) return null;
    return (
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginTop: 10 }}>
        <Box label="Employee achievement" value={formatTargetValue(empAch[id], item.targetType, targetTypes) || '—'}
          faded={!String(empAch[id] ?? '').trim()} />
        <Box label="Manager achievement" value={formatTargetValue(mgrAch[id], item.targetType, targetTypes) || '—'}
          accent={color} faded={!String(mgrAch[id] ?? '').trim()} />
      </div>
    );
  };

  function goalItem(id) {
    for (const kra of goals) {
      if (kra.id === id) return kra;
      for (const kpi of (kra.kpis || [])) if (kpi.id === id) return kpi;
    }
    return null;
  }

  if (!goals.length) {
    return <div style={{ padding: 16, fontSize: 13, color: '#64748B' }}>No goal details found for this employee.</div>;
  }

  return (
    <div>
      {goals.map((kra, idx) => {
        const goalColor = getGoalColor(kra, config, idx);
        const hasKpis = (kra.kpis || []).length > 0;
        return (
          <div key={kra.id} style={{ background: '#fff', border: `1px solid ${goalColor}33`, borderLeft: `4px solid ${goalColor}`, borderRadius: 12, marginBottom: 12, overflow: 'hidden' }}>
            {/* Goal header */}
            <div style={{ padding: '12px 16px', borderBottom: `1px solid ${BORDER}`, background: `${goalColor}0D` }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 10.5, fontWeight: 800, color: goalColor, textTransform: 'uppercase', letterSpacing: '.06em' }}>{kra.perspName && kra.perspName !== 'All KRAs' ? kra.perspName : `Goal ${idx + 1}`}</span>
                <span style={{ padding: '2px 9px', borderRadius: 999, background: '#fff', color: goalColor, fontSize: 11, fontWeight: 800, border: `1px solid ${goalColor}33` }}>{kra.weight || 0}%</span>
              </div>
              <div style={{ fontSize: 15.5, fontWeight: 800, color: '#0F172A', marginTop: 3 }}>{kra.name}</div>
              {targetAtKra && kra.target && (
                <div style={{ marginTop: 6 }}>
                  <Box label="Target" value={formatTargetValue(kra.target, kra.targetType, targetTypes) || '—'} />
                </div>
              )}
              {!rateAtKpi && (
                <div style={{ marginTop: 10 }}>
                  <ScorePairRO config={config} selfScore={selfStage.itemScores?.[kra.id]} managerScore={managerStage.itemScores?.[kra.id]} accent={goalColor} />
                  {achRow(kra.id, goalColor)}
                  {commentMode === 'per-goal' && (
                    <ManagerComment text={managerStage.itemComments?.[kra.id]} />
                  )}
                </div>
              )}
            </div>

            {/* KPIs */}
            {hasKpis && (
              <div style={{ padding: '8px 16px 12px' }}>
                <div style={{ fontSize: 10, fontWeight: 850, color: '#94A3B8', textTransform: 'uppercase', letterSpacing: '.04em', padding: '4px 0 6px' }}>Key Performance Indicators</div>
                {kra.kpis.map((kpi) => (
                  <div key={kpi.id} style={{ padding: '10px 0', borderTop: '1px solid #F1F5F9' }}>
                    <div style={{ display: 'flex', gap: 9, alignItems: 'center', minWidth: 0 }}>
                      <span style={{ color: goalColor, fontWeight: 800, fontSize: 13 }}>•</span>
                      <span style={{ fontSize: 13.5, fontWeight: 700, color: '#0F172A' }}>{kpi.name}</span>
                    </div>
                    {targetAtKpi && kpi.target && (
                      <div style={{ marginTop: 8 }}>
                        <Box label="Target" value={formatTargetValue(kpi.target, kpi.targetType, targetTypes) || '—'} />
                        {achRow(kpi.id, goalColor)}
                      </div>
                    )}
                    {rateAtKpi && (
                      <div style={{ marginTop: 8 }}>
                        <ScorePairRO config={config} selfScore={selfStage.itemScores?.[kpi.id]} managerScore={managerStage.itemScores?.[kpi.id]} accent={goalColor} />
                      </div>
                    )}
                    {commentMode === 'per-item' && <ManagerComment text={managerStage.itemComments?.[kpi.id]} />}
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}

      {/* Competencies */}
      {competencies.length > 0 && (
        <div style={{ background: '#fff', border: `1px solid ${BORDER}`, borderLeft: '4px solid #0E7490', borderRadius: 12, marginBottom: 12, overflow: 'hidden' }}>
          <div style={{ padding: '12px 16px', borderBottom: `1px solid ${BORDER}`, background: '#0E74900D', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
            <div style={{ fontSize: 14, fontWeight: 800, color: '#0F172A' }}>Competencies</div>
            {resolved.sourceLabel && <span style={{ padding: '4px 10px', borderRadius: 999, background: '#ECFEFF', color: '#0E7490', fontSize: 11, fontWeight: 700 }}>{resolved.sourceLabel}</span>}
          </div>
          <div style={{ padding: '4px 16px 12px' }}>
            {competencies.map((name) => (
              <div key={name} style={{ padding: '12px 0', borderTop: '1px solid #F1F5F9' }}>
                <div style={{ fontSize: 13.5, fontWeight: 700, color: '#0F172A', marginBottom: 8 }}>{name}</div>
                <ScorePairRO config={config} selfScore={selfStage.competencyScores?.[name]} managerScore={managerStage.competencyScores?.[name]} accent="#0E7490" />
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function ManagerComment({ text }) {
  if (!String(text || '').trim()) return null;
  return (
    <div style={{ marginTop: 8, padding: '8px 10px', borderRadius: 8, background: '#F8FAFC', border: `1px solid ${BORDER}`, fontSize: 12.5, color: '#475569' }}>
      <span style={{ ...FIELD_LABEL, display: 'block', marginBottom: 3 }}>Manager comment</span>
      {text}
    </div>
  );
}
