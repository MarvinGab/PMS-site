// Employee goal-setting screen — Plan 5b Task 2.
//
// Data layer is `callWorkflow` ONLY (goal.context / goal.ensure-plan / goal.save-items /
// goal.submit). No org-blob, no browser-persisted cache, no legacy data-layer module —
// see src/pages/EmployeePage.jsx's old goals section (search `renderGoalSetting`) for the
// legacy version this replaces.
//
// The visual language (card layout, accent colors, spacing) is ported from that section,
// which itself is almost entirely inline-styled (only `goal-library-carousel` is a real
// CSS class) — so this file continues that pattern rather than inventing new admin.css
// classes it isn't allowed to add in this task.
//
// NOTE on the read<->save shape transform: the task brief sketches `fromPlanItems` reading
// `r.parent_id` / `r.target_type_id` (needing an id->key lookup). The actual schema
// (supabase/migrations/2026070313_pms_workflow.sql, confirmed against
// supabase/functions/pms-workflow/goals.ts) stores `parent_item_id` and `target_type_key`
// directly on `employee_goal_items` / `goal_library_items` rows — no lookup needed. The
// helpers below use the real column names.

import { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import { useApp } from '../AppContext';
import { callWorkflow, PmsError } from '../backend/pmsClient';
import '../admin.css';

// Accent palette for KRA cards — intentionally excludes red/orange/green families,
// which this app reserves for validation/status states (error/approved), not decoration.
const ACCENT_COLORS = [
  '#2563EB', '#EC4899', '#EAB308', '#7C3AED', '#F97316', '#06B6D4',
  '#C026D3', '#F59E0B', '#4F46E5', '#D946EF', '#0891B2', '#8B5CF6',
];

function accentFor(seed, index = 0) {
  const text = String(seed ?? index);
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
  return ACCENT_COLORS[Math.abs(hash) % ACCENT_COLORS.length];
}

const STATUS_LABELS = {
  draft: 'Draft',
  sent_back: 'Sent back for changes',
  reopened: 'Reopened by HR',
  submitted: 'Submitted — awaiting approval',
  approved: 'Approved',
};

// ---- Read (DB rows) -> local editable item shape --------------------------
// `employee_goal_items` / `goal_library_items` rows: { id, item_type, parent_item_id,
// title, description, perspective, weight, target_type_key, target_value, display_order,
// source, ... }. Local shape uses a stable string `key` (KRA<->KPI linked by key/parentKey,
// not ids) so newly-added, unsaved items can be edited before they have a server id.
function fromPlanItems(rows = []) {
  return (rows || []).map((r) => ({
    key: r.id,
    itemType: r.item_type,
    parentKey: r.parent_item_id || null,
    title: r.title || '',
    description: r.description || '',
    perspective: r.perspective || '',
    weight: r.weight === null || r.weight === undefined ? '' : r.weight,
    targetTypeKey: r.target_type_key || null,
    targetValue: r.target_value || '',
    displayOrder: r.display_order ?? 0,
    source: r.source || 'employee',
  }));
}

// Local editable items -> goal.save-items payload shape (caller-local keys; displayOrder
// is always taken from array position — callers pass items in the desired final order).
function toSaveItems(local = []) {
  return local.map((it, i) => {
    const parsedWeight = it.weight === '' || it.weight === null || it.weight === undefined ? NaN : Number(it.weight);
    return {
      key: it.key,
      itemType: it.itemType,
      parentKey: it.parentKey || undefined,
      title: it.title,
      description: it.description || undefined,
      perspective: it.perspective || undefined,
      weight: Number.isFinite(parsedWeight) ? parsedWeight : undefined,
      targetTypeKey: it.targetTypeKey || undefined,
      targetValue: it.targetValue || undefined,
      displayOrder: i,
    };
  });
}

function buildTree(items) {
  const kras = items.filter((it) => it.itemType === 'kra').slice()
    .sort((a, b) => (a.displayOrder ?? 0) - (b.displayOrder ?? 0));
  const kpisByParent = new Map();
  items.filter((it) => it.itemType === 'kpi').forEach((kpi) => {
    const list = kpisByParent.get(kpi.parentKey) || [];
    list.push(kpi);
    kpisByParent.set(kpi.parentKey, list);
  });
  return kras.map((kra) => ({
    kra,
    kpis: (kpisByParent.get(kra.key) || []).slice().sort((a, b) => (a.displayOrder ?? 0) - (b.displayOrder ?? 0)),
  }));
}

// Flattens the tree back into save order (KRA immediately followed by its KPIs) so
// display_order on save reflects what's actually on screen.
function flattenTree(tree) {
  const out = [];
  tree.forEach((node) => {
    out.push(node.kra);
    node.kpis.forEach((kpi) => out.push(kpi));
  });
  return out;
}

function sumWeights(list) {
  return list.reduce((sum, it) => sum + (Number(it.weight) || 0), 0);
}

// ---- Small presentational pieces -------------------------------------------

function WeightInput({ value, disabled, onChange, placeholder = 'Wt %' }) {
  return (
    <input
      type="number"
      min="0"
      step="1"
      value={value === null || value === undefined ? '' : value}
      disabled={disabled}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      style={{ width: 72, padding: '8px 8px', borderRadius: 9, border: '1.5px solid #D9E2EC', fontFamily: 'inherit', fontSize: 13, boxSizing: 'border-box' }}
    />
  );
}

function TargetField({ label, targetTypeKey, targetValue, targetTypes, disabled, onTypeChange, onValueChange }) {
  const options = (targetTypes || []).filter((t) => !t.hidden);
  const selected = options.find((t) => t.target_type_key === targetTypeKey);
  return (
    <div style={{ marginTop: 10 }}>
      {label && (
        <div style={{ fontSize: 11, fontWeight: 700, color: '#64748B', textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 5 }}>
          {label}
        </div>
      )}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
        <select
          value={targetTypeKey || ''}
          disabled={disabled}
          onChange={(e) => onTypeChange(e.target.value || null)}
          style={{ padding: '8px 10px', borderRadius: 9, border: '1.5px solid #D9E2EC', fontFamily: 'inherit', fontSize: 13, background: '#fff' }}
        >
          <option value="">No target</option>
          {options.map((t) => (
            <option key={t.id} value={t.target_type_key}>{t.name}</option>
          ))}
        </select>
        {targetTypeKey && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            {selected?.unit && selected.unit_position === 'prefix' && <span style={{ fontSize: 12.5, color: '#64748B' }}>{selected.unit}</span>}
            <input
              type={selected?.is_numeric ? 'number' : 'text'}
              value={targetValue || ''}
              disabled={disabled}
              placeholder={selected?.is_numeric ? 'Value' : 'Describe the target'}
              onChange={(e) => onValueChange(e.target.value)}
              style={{ width: selected?.is_numeric ? 100 : 220, padding: '8px 10px', borderRadius: 9, border: '1.5px solid #D9E2EC', fontFamily: 'inherit', fontSize: 13, boxSizing: 'border-box' }}
            />
            {selected?.unit && selected.unit_position !== 'prefix' && <span style={{ fontSize: 12.5, color: '#64748B' }}>{selected.unit}</span>}
          </div>
        )}
      </div>
    </div>
  );
}

function sourceBadgeLabel(source) {
  if (source === 'library') return 'From library';
  if (source === 'prefill') return 'Prefilled';
  if (source === 'manager') return 'From manager';
  return null;
}

function KpiRow({ kpi, color, editable, showWeight, showTarget, targetTypes, onChange, onDelete }) {
  const badge = sourceBadgeLabel(kpi.source);
  return (
    <div style={{ padding: '10px 12px', borderRadius: 10, background: '#fff', border: '1px solid #E9EDF2', marginBottom: 8, display: 'flex', gap: 10, alignItems: 'flex-start', flexWrap: 'wrap' }}>
      <div style={{ flex: 1, minWidth: 200 }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
          <textarea
            value={kpi.title}
            disabled={!editable}
            onChange={(e) => onChange('title', e.target.value)}
            placeholder="KPI name"
            rows={2}
            style={{ flex: 1, padding: '8px 10px', borderRadius: 9, border: '1.5px solid #D9E2EC', fontFamily: 'inherit', fontSize: 13, lineHeight: 1.35, resize: 'none', minHeight: 40, boxSizing: 'border-box' }}
          />
          {showWeight && <WeightInput value={kpi.weight} disabled={!editable} onChange={(v) => onChange('weight', v)} />}
        </div>
        {showTarget && (
          <TargetField
            targetTypeKey={kpi.targetTypeKey}
            targetValue={kpi.targetValue}
            targetTypes={targetTypes}
            disabled={!editable}
            onTypeChange={(t) => onChange('targetTypeKey', t)}
            onValueChange={(v) => onChange('targetValue', v)}
          />
        )}
        {badge && (
          <span style={{ display: 'inline-block', marginTop: 6, fontSize: 10.5, fontWeight: 700, color, background: `${color}14`, padding: '2px 8px', borderRadius: 999 }}>
            {badge}
          </span>
        )}
      </div>
      {editable && (
        <button
          type="button"
          onClick={onDelete}
          title="Remove KPI"
          style={{ padding: '7px 9px', borderRadius: 8, border: '1px solid #E2E8F0', background: '#fff', color: '#64748B', cursor: 'pointer', fontFamily: 'inherit', fontSize: 12 }}
        >
          ✕
        </button>
      )}
    </div>
  );
}

function KraCard({
  node, index, color, editable, showKpis, showKraTarget, showKpiTarget, kpiWeightEnabled,
  targetTypes, onChangeKra, onDeleteKra, onAddKpi, onChangeKpi, onDeleteKpi,
}) {
  const { kra, kpis } = node;
  const badge = sourceBadgeLabel(kra.source);
  const kpiWeightTotal = sumWeights(kpis);
  const kpiWeightOff = kpiWeightEnabled && kpis.length > 0
    && kpis.some((k) => k.weight !== '' && k.weight !== null && k.weight !== undefined)
    && Math.abs(kpiWeightTotal - 100) > 0.5;

  return (
    <div style={{ marginBottom: 16, borderRadius: 14, border: `1.5px solid ${color}33`, background: '#fff', boxShadow: '0 2px 10px rgba(15,23,42,.05)', overflow: 'hidden' }}>
      <div style={{ padding: '14px 16px', background: `linear-gradient(135deg, ${color}12, transparent 70%)`, borderBottom: `1px solid ${color}22` }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'flex-start', flexWrap: 'wrap' }}>
          <div style={{ fontSize: 10.5, fontWeight: 800, color, textTransform: 'uppercase', letterSpacing: '.08em' }}>
            Goal {index + 1}{badge ? ` · ${badge}` : ''}
          </div>
          {editable && (
            <button
              type="button"
              onClick={onDeleteKra}
              style={{ padding: '5px 10px', borderRadius: 8, border: '1px solid #E2E8F0', background: '#fff', color: '#64748B', cursor: 'pointer', fontFamily: 'inherit', fontSize: 11.5, fontWeight: 700 }}
            >
              Delete
            </button>
          )}
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) 90px', gap: 8, marginTop: 8 }}>
          <input
            value={kra.title}
            disabled={!editable}
            onChange={(e) => onChangeKra('title', e.target.value)}
            placeholder={`Goal ${index + 1} name`}
            style={{ padding: '10px 12px', borderRadius: 10, border: '1.5px solid #D9E2EC', fontFamily: 'inherit', fontSize: 14, fontWeight: 700, boxSizing: 'border-box' }}
          />
          <WeightInput value={kra.weight} disabled={!editable} onChange={(v) => onChangeKra('weight', v)} />
        </div>
        <input
          value={kra.perspective}
          disabled={!editable}
          onChange={(e) => onChangeKra('perspective', e.target.value)}
          placeholder="Perspective (optional)"
          style={{ marginTop: 8, width: '100%', boxSizing: 'border-box', padding: '8px 10px', borderRadius: 9, border: '1.5px solid #D9E2EC', fontFamily: 'inherit', fontSize: 12.5 }}
        />
        <textarea
          value={kra.description}
          disabled={!editable}
          onChange={(e) => onChangeKra('description', e.target.value)}
          placeholder="Description (optional)"
          rows={2}
          style={{ marginTop: 8, width: '100%', boxSizing: 'border-box', padding: '8px 10px', borderRadius: 9, border: '1.5px solid #D9E2EC', fontFamily: 'inherit', fontSize: 12.5, resize: 'none' }}
        />
        {showKraTarget && (
          <TargetField
            label="Target"
            targetTypeKey={kra.targetTypeKey}
            targetValue={kra.targetValue}
            targetTypes={targetTypes}
            disabled={!editable}
            onTypeChange={(t) => onChangeKra('targetTypeKey', t)}
            onValueChange={(v) => onChangeKra('targetValue', v)}
          />
        )}
      </div>

      {showKpis && (
        <div style={{ padding: '12px 16px 14px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: '#64748B', textTransform: 'uppercase', letterSpacing: '.07em' }}>KPIs</div>
            {kpiWeightEnabled && kpis.length > 0 && (
              <span style={{ fontSize: 11, fontWeight: 700, color: kpiWeightOff ? '#B91C1C' : '#64748B' }}>
                {kpiWeightTotal}%{kpiWeightOff ? ' — must sum to 100%' : ''}
              </span>
            )}
          </div>
          {kpis.map((kpi) => (
            <KpiRow
              key={kpi.key}
              kpi={kpi}
              color={color}
              editable={editable}
              showWeight={kpiWeightEnabled}
              showTarget={showKpiTarget}
              targetTypes={targetTypes}
              onChange={(field, value) => onChangeKpi(kpi.key, field, value)}
              onDelete={() => onDeleteKpi(kpi.key)}
            />
          ))}
          {kpis.length === 0 && <div style={{ fontSize: 12.5, color: '#94A3B8', marginBottom: 8 }}>No KPIs yet.</div>}
          {editable && (
            <button
              type="button"
              onClick={onAddKpi}
              style={{ padding: '8px 12px', borderRadius: 9, border: `1px dashed ${color}66`, background: `${color}08`, color, cursor: 'pointer', fontFamily: 'inherit', fontSize: 12.5, fontWeight: 700 }}
            >
              + Add KPI
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function LibraryPicker({ items, usedIds, goalKpiMode, disabled, onAdd }) {
  const kras = (items || []).filter((it) => it.item_type === 'kra');
  const kpisByParent = new Map();
  (items || []).filter((it) => it.item_type === 'kpi').forEach((kpi) => {
    const list = kpisByParent.get(kpi.parent_item_id) || [];
    list.push(kpi);
    kpisByParent.set(kpi.parent_item_id, list);
  });
  if (kras.length === 0) return null;
  const available = kras.filter((k) => !usedIds.has(k.id));

  return (
    <div style={{ marginBottom: 18, background: '#F6F8FF', border: '1.5px solid #C7D2FE', borderRadius: 14, padding: '12px 16px' }}>
      <div style={{ fontSize: 12.5, fontWeight: 800, color: '#0F172A', marginBottom: 8 }}>Goal library</div>
      {available.length === 0 ? (
        <div style={{ fontSize: 12.5, color: '#4F46E5', fontWeight: 600 }}>All library goals have been added to your plan.</div>
      ) : (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
          {available.map((kra, i) => {
            const color = accentFor(kra.id, i);
            const kids = kpisByParent.get(kra.id) || [];
            return (
              <div key={kra.id} style={{ width: 220, padding: '10px 12px', borderRadius: 10, border: `1.5px solid ${color}44`, background: '#fff' }}>
                <div style={{ fontSize: 12.5, fontWeight: 800, color: '#0F172A', marginBottom: 4 }}>{kra.title}</div>
                {kra.description && (
                  <div style={{ fontSize: 11, color: '#64748B', marginBottom: 6, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
                    {kra.description}
                  </div>
                )}
                <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 8, flexWrap: 'wrap' }}>
                  {kra.weight != null && (
                    <span style={{ fontSize: 10.5, fontWeight: 800, color, background: `${color}14`, padding: '2px 7px', borderRadius: 999 }}>{kra.weight}%</span>
                  )}
                  {goalKpiMode !== 'kra-only' && kids.length > 0 && (
                    <span style={{ fontSize: 10.5, color: '#64748B' }}>{kids.length} KPI{kids.length !== 1 ? 's' : ''}</span>
                  )}
                </div>
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => onAdd(kra, kids)}
                  style={{ width: '100%', padding: '6px 10px', borderRadius: 8, border: 'none', background: color, color: '#fff', cursor: disabled ? 'not-allowed' : 'pointer', fontFamily: 'inherit', fontSize: 12, fontWeight: 700, opacity: disabled ? 0.6 : 1 }}
                >
                  + Add to plan
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ---- Main component ---------------------------------------------------------

export default function EmployeeGoals() {
  const { orgId } = useApp();
  const [ctx, setCtx] = useState(null);     // goal.context result (source of truth)
  const [items, setItems] = useState([]);   // editable goal tree (local mirror of ctx.items)
  const [status, setStatus] = useState('loading'); // loading | ready | error
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const keyCounter = useRef(0);
  const nextKey = () => `k${Date.now()}_${keyCounter.current += 1}`;

  const load = useCallback(async () => {
    setStatus('loading'); setError('');
    try {
      const data = await callWorkflow('goal.context', { orgId });
      setCtx(data);
      setItems(fromPlanItems(data.items));
      setStatus('ready');
    } catch (e) {
      setError(e instanceof PmsError ? e.message : 'Could not load your goals.');
      setStatus('error');
    }
  }, [orgId]);

  useEffect(() => { if (orgId) load(); }, [orgId, load]);

  const plan = ctx?.plan || null;
  const config = ctx?.config || {};
  const windowOpen = !!ctx?.window?.goalOpen;
  const planStatus = plan?.status || null; // draft | sent_back | reopened | submitted | approved
  const readOnly = !windowOpen || planStatus === 'submitted' || planStatus === 'approved' || (config.canEditOwnGoals === false && config.goalCreationMode !== 'employee-self');
  const canEdit = !readOnly;

  async function ensurePlan() {
    setBusy(true); setError('');
    try {
      const data = await callWorkflow('goal.ensure-plan', { orgId, cycleId: ctx.cycle.id });
      setCtx((c) => ({ ...c, plan: data.plan, items: data.items }));
      setItems(fromPlanItems(data.items));
    } catch (e) {
      setError(e instanceof PmsError ? e.message : 'Could not start your goal plan.');
    } finally { setBusy(false); }
  }

  async function save() {
    setBusy(true); setError('');
    try {
      const data = await callWorkflow('goal.save-items', { orgId, cycleId: ctx.cycle.id, planVersion: plan?.version, items: toSaveItems(flattenTree(buildTree(items))) });
      setCtx((c) => ({ ...c, plan: data.plan, items: data.items }));
      setItems(fromPlanItems(data.items));
    } catch (e) {
      if (e instanceof PmsError && e.code === 'CONFLICT') { setError('Someone else changed this — reloading.'); await load(); }
      else if (e instanceof PmsError && e.code === 'WINDOW_CLOSED') { setError('The goal-setting window is closed.'); await load(); }
      else setError(e instanceof PmsError ? e.message : 'Could not save your goals.');
    } finally { setBusy(false); }
  }

  async function submit() {
    setBusy(true); setError('');
    try {
      const data = await callWorkflow('goal.submit', { orgId, cycleId: ctx.cycle.id, planVersion: plan?.version });
      setCtx((c) => ({ ...c, plan: data.plan }));
      await load();
    } catch (e) {
      if (e instanceof PmsError && e.code === 'CONFLICT') { await load(); }
      setError(e instanceof PmsError ? e.message : 'Could not submit your goals.');
    } finally { setBusy(false); }
  }

  // ---- Local (in-memory) tree edits — no network calls until Save ----
  function addKra() {
    setItems((cur) => [...cur, {
      key: nextKey(), itemType: 'kra', parentKey: null, title: '', description: '', perspective: '',
      weight: '', targetTypeKey: null, targetValue: '', displayOrder: cur.length, source: 'employee',
    }]);
  }
  function addKpi(parentKey) {
    setItems((cur) => [...cur, {
      key: nextKey(), itemType: 'kpi', parentKey, title: '', description: '', perspective: '',
      weight: '', targetTypeKey: null, targetValue: '', displayOrder: cur.length, source: 'employee',
    }]);
  }
  function changeItem(key, field, value) {
    setItems((cur) => cur.map((it) => (it.key === key ? { ...it, [field]: value } : it)));
  }
  // Delete = remove from local items (no trash/soft-delete). Deleting a KRA also drops its KPIs.
  function deleteItem(key) {
    setItems((cur) => cur.filter((it) => it.key !== key && it.parentKey !== key));
  }
  function addFromLibrary(libKra, libKpis) {
    const kraKey = nextKey();
    const includeKpis = config.goalKpiMode !== 'kra-only';
    setItems((cur) => {
      const next = [...cur, {
        key: kraKey, itemType: 'kra', parentKey: null, title: libKra.title || '', description: libKra.description || '',
        perspective: libKra.perspective || '', weight: libKra.weight ?? '', targetTypeKey: libKra.target_type_key || null,
        targetValue: libKra.target_value || '', displayOrder: cur.length, source: 'library', libraryItemId: libKra.id,
      }];
      if (includeKpis) {
        (libKpis || []).forEach((kpi, i) => {
          next.push({
            key: nextKey(), itemType: 'kpi', parentKey: kraKey, title: kpi.title || '', description: kpi.description || '',
            perspective: kpi.perspective || '', weight: kpi.weight ?? '', targetTypeKey: kpi.target_type_key || null,
            targetValue: kpi.target_value || '', displayOrder: next.length + i, source: 'library', libraryItemId: kpi.id,
          });
        });
      }
      return next;
    });
  }

  const tree = useMemo(() => buildTree(items), [items]);
  const usedLibraryIds = useMemo(() => new Set(items.map((it) => it.libraryItemId).filter(Boolean)), [items]);
  const kraWeightTotal = useMemo(() => sumWeights(tree.map((n) => n.kra)), [tree]);

  if (status === 'loading') return <div className="emp-goals-shell">Loading your goals…</div>;
  if (status === 'error') return <div className="emp-goals-shell"><div className="login-error">{error}</div><button className="btn" onClick={load}>Retry</button></div>;
  if (ctx && !ctx.cycle) return <div className="emp-goals-shell">No active appraisal cycle yet.</div>;
  if (ctx && !ctx.participant) return <div className="emp-goals-shell">You're not a participant in the current cycle — contact HR.</div>;

  const showKpis = config.goalKpiMode !== 'kra-only';
  const showKraTarget = config.targetLevelMode === 'KRA';
  const showKpiTarget = showKpis && config.targetLevelMode !== 'KRA';
  const kpiWeightEnabled = config.kpiRatingMode !== 'free-text';
  const kraOverAllocated = kraWeightTotal > 0 && Math.abs(kraWeightTotal - 100) > 0.5;

  return (
    <div className="emp-goals-shell">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
        <div>
          <div style={{ fontSize: 17, fontWeight: 800, color: '#0F172A' }}>{ctx.cycle.name}</div>
          <div style={{ fontSize: 12.5, color: '#64748B', marginTop: 2 }}>
            {windowOpen ? 'Goal-setting window is open' : 'Goal-setting window is closed'}
          </div>
        </div>
        {plan && (
          <span style={{ fontSize: 12, fontWeight: 700, color: '#334155', background: '#F1F5F9', border: '1px solid #E2E8F0', padding: '5px 12px', borderRadius: 999 }}>
            {STATUS_LABELS[planStatus] || planStatus}
          </span>
        )}
      </div>

      {error && <div className="login-error" style={{ marginBottom: 14 }}>{error}</div>}

      {!plan && canEdit && (
        <div style={{ padding: '18px 20px', borderRadius: 14, border: '1.5px dashed #C7D2FE', background: '#F6F8FF', textAlign: 'center' }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: '#0F172A', marginBottom: 4 }}>You haven't started your goal plan yet.</div>
          <div style={{ fontSize: 12.5, color: '#64748B', marginBottom: 12 }}>We'll pull in any goals already assigned to you.</div>
          <button className="btn btn-primary" disabled={busy} onClick={ensurePlan}>Start my goals</button>
        </div>
      )}

      {!plan && !canEdit && (
        <div style={{ padding: '18px 20px', borderRadius: 14, border: '1px solid #E2E8F0', background: '#F8FAFC', textAlign: 'center', color: '#64748B', fontSize: 13 }}>
          {windowOpen ? "Goal-setting isn't enabled for your account — contact HR." : 'The goal-setting window is closed and no plan was created.'}
        </div>
      )}

      {plan && (
        <>
          {readOnly && (
            <div className="emp-goals-readonly" style={{ marginBottom: 14, padding: '10px 14px', borderRadius: 10, background: '#F8FAFC', border: '1px solid #E2E8F0', color: '#475569', fontSize: 12.5, fontWeight: 600 }}>
              Status: {STATUS_LABELS[planStatus] || planStatus || 'read-only'}{!windowOpen ? ' · window closed' : ''}
            </div>
          )}

          {config.goalCreationMode === 'admin-library' && (
            <LibraryPicker
              items={ctx.library?.items}
              usedIds={usedLibraryIds}
              goalKpiMode={config.goalKpiMode}
              disabled={!canEdit}
              onAdd={addFromLibrary}
            />
          )}

          {tree.length > 0 && (
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 8 }}>
              <span style={{ fontSize: 11.5, fontWeight: 700, color: kraOverAllocated ? '#B91C1C' : '#64748B' }}>
                Goal weight total: {kraWeightTotal}%{kraOverAllocated ? ' — must sum to 100%' : ''}
              </span>
            </div>
          )}

          <div>
            {tree.map((node, i) => (
              <KraCard
                key={node.kra.key}
                node={node}
                index={i}
                color={accentFor(node.kra.key, i)}
                editable={canEdit}
                showKpis={showKpis}
                showKraTarget={showKraTarget}
                showKpiTarget={showKpiTarget}
                kpiWeightEnabled={kpiWeightEnabled}
                targetTypes={config.targetTypes}
                onChangeKra={(field, value) => changeItem(node.kra.key, field, value)}
                onDeleteKra={() => deleteItem(node.kra.key)}
                onAddKpi={() => addKpi(node.kra.key)}
                onChangeKpi={(key, field, value) => changeItem(key, field, value)}
                onDeleteKpi={(key) => deleteItem(key)}
              />
            ))}
            {tree.length === 0 && (
              <div style={{ padding: 16, borderRadius: 12, border: '1px dashed #E2E8F0', color: '#94A3B8', fontSize: 13, textAlign: 'center', marginBottom: 14 }}>
                No goals yet{config.goalCreationMode === 'admin-library' ? ' — add one from your library above.' : ' — add your first KRA below.'}
              </div>
            )}
          </div>

          {canEdit && config.goalCreationMode === 'employee-self' && (
            <button type="button" className="btn btn-secondary" onClick={addKra} style={{ marginBottom: 16 }}>+ Add KRA</button>
          )}

          {canEdit && (
            <div style={{ display: 'flex', gap: 10, marginTop: 8 }}>
              <button className="btn" disabled={busy} onClick={save}>Save</button>
              <button className="btn btn-primary" disabled={busy} onClick={submit}>Submit for approval</button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
