import { useMemo, useRef, useState } from 'react';
import {
  createKPI,
  createKRA,
  ORG_ATTRIBUTE_VALUES,
  useBSCConfig,
} from './BSCConfigContext';

const PREFILL_OPTIONS = [
  { id: 'kras-only', label: 'KRAs only', copy: 'Employees fill KPIs themselves.' },
  { id: 'kras-kpis', label: 'KRAs + KPIs', copy: 'Employees fill targets.' },
  { id: 'fully-prefilled', label: 'KRAs + KPIs + targets', copy: 'Library pre-fills the full structure.' },
];

const KPI_UNITS = ['number', 'percentage', 'currency', 'yes-no', 'text'];
const KPI_DIRECTIONS = [
  { id: 'higher', label: 'Higher is better' },
  { id: 'lower', label: 'Lower is better' },
  { id: 'exact', label: 'Exact target' },
];

function parseCsv(text) {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length < 2) return [];

  const rows = lines.map((line) => line.split(',').map((cell) => cell.trim()));
  const headers = rows[0];

  return rows.slice(1).map((cells) => headers.reduce((acc, header, index) => {
    acc[header] = cells[index] || '';
    return acc;
  }, {}));
}

function buildImportedKRAs(rows, config) {
  const differentiatorLabel = config.differentiatorLabel || 'Department';
  return rows.map((row) => {
    const perspective = config.perspectives.find((item) => item.name.toLowerCase() === row.Perspective.toLowerCase()) || config.perspectives[0];
    const tagValue = row[differentiatorLabel];
    const kpiNames = row['KPI Names']
      ? row['KPI Names'].split(';').map((item) => item.trim()).filter(Boolean)
      : [];

    return createKRA({
      name: row['KRA Name'] || '',
      perspectiveId: perspective?.id || config.perspectives[0]?.id,
      tags: tagValue ? [tagValue] : [],
      weightage: Number(row.Weightage) || 0,
      includeKPIs: kpiNames.length > 0,
      status: 'draft',
      kpis: kpiNames.map((name) => createKPI({ name })),
    });
  });
}

export default function GoalLibrary({ onBack }) {
  const { bscConfig, setBscConfig } = useBSCConfig();
  const fileInputRef = useRef(null);
  const [selectedKraId, setSelectedKraId] = useState(bscConfig.kras[0]?.id ?? null);
  const [searchQuery, setSearchQuery] = useState('');
  const [filterValue, setFilterValue] = useState('all');
  const [previewRows, setPreviewRows] = useState([]);
  const [showImportModal, setShowImportModal] = useState(false);
  const [fieldErrors, setFieldErrors] = useState({});

  const differentiatorLabel = bscConfig.differentiatorLabel || 'Department';
  const secondaryDifferentiatorLabel = bscConfig.secondaryDifferentiatorLabel || 'Secondary condition';
  const primaryValues = ORG_ATTRIBUTE_VALUES[bscConfig.differentiatorField] || ['General'];
  const secondaryValues = ORG_ATTRIBUTE_VALUES[bscConfig.secondaryDifferentiatorField] || ['General'];
  const maxKPIs = bscConfig.limits?.maxKPIsPerKRA || 5;

  const selectedKra = bscConfig.kras.find((item) => item.id === selectedKraId) || null;

  const groupedKras = useMemo(() => {
    const loweredQuery = searchQuery.trim().toLowerCase();
    return bscConfig.perspectives.map((perspective) => {
      const kras = bscConfig.kras.filter((kra) => {
        if (kra.perspectiveId !== perspective.id) return false;
        if (filterValue !== 'all' && !kra.tags.includes(filterValue)) return false;
        if (!loweredQuery) return true;
        return (
          kra.name.toLowerCase().includes(loweredQuery) ||
          kra.description.toLowerCase().includes(loweredQuery)
        );
      });

      return { perspective, kras };
    }).filter((group) => group.kras.length);
  }, [bscConfig.kras, bscConfig.perspectives, filterValue, searchQuery]);

  function updateConfig(updater) {
    setBscConfig((current) => (typeof updater === 'function' ? updater(current) : updater));
  }

  function updateSelectedKra(field, value) {
    if (!selectedKraId) return;
    updateConfig((current) => ({
      ...current,
      kras: current.kras.map((kra) => (kra.id === selectedKraId ? { ...kra, [field]: value } : kra)),
    }));
  }

  function updateSelectedKpi(kpiId, field, value) {
    if (!selectedKraId) return;
    updateConfig((current) => ({
      ...current,
      kras: current.kras.map((kra) => (
        kra.id === selectedKraId
          ? {
              ...kra,
              kpis: kra.kpis.map((kpi) => (kpi.id === kpiId ? { ...kpi, [field]: value } : kpi)),
            }
          : kra
      )),
    }));
  }

  function addBlankKra() {
    const next = createKRA({
      perspectiveId: bscConfig.perspectives[0]?.id || '',
      status: 'draft',
    });
    updateConfig((current) => ({ ...current, kras: [...current.kras, next] }));
    setSelectedKraId(next.id);
    setFieldErrors({});
  }

  function addKpi() {
    if (!selectedKra || selectedKra.kpis.length >= maxKPIs) return;
    updateSelectedKra('kpis', [...selectedKra.kpis, createKPI()]);
  }

  function removeKpi(kpiId) {
    updateSelectedKra('kpis', selectedKra.kpis.filter((kpi) => kpi.id !== kpiId));
  }

  function toggleMultiValue(field, value) {
    const currentValues = selectedKra?.[field] || [];
    if (value === '__all__') {
      updateSelectedKra(field, []);
      return;
    }
    updateSelectedKra(
      field,
      currentValues.includes(value)
        ? currentValues.filter((item) => item !== value)
        : [...currentValues, value],
    );
  }

  function validateSelectedKra(status) {
    const nextErrors = {};
    if (!selectedKra?.name.trim()) nextErrors.name = 'KRA name is required.';
    if (!selectedKra?.perspectiveId) nextErrors.perspectiveId = 'Assign the KRA to a perspective.';
    if (selectedKra?.includeKPIs && bscConfig.preFillMode !== 'kras-only' && !selectedKra.kpis.length) {
      nextErrors.kpis = 'Add at least one KPI or switch off KPI pre-fill for this KRA.';
    }
    if (selectedKra?.kpis.length > maxKPIs) {
      nextErrors.kpis = `Maximum ${maxKPIs} KPIs allowed per KRA.`;
    }

    setFieldErrors(nextErrors);
    if (Object.keys(nextErrors).length) return false;

    updateSelectedKra('status', status);
    return true;
  }

  function saveKra(status) {
    validateSelectedKra(status);
  }

  function handleCsvUpload(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const text = String(reader.result || '');
      const rows = parseCsv(text);
      setPreviewRows(buildImportedKRAs(rows, bscConfig));
      setShowImportModal(true);
    };
    reader.readAsText(file);
    event.target.value = '';
  }

  function confirmImport() {
    if (!previewRows.length) return;
    updateConfig((current) => ({ ...current, kras: [...current.kras, ...previewRows] }));
    if (!selectedKraId && previewRows[0]) setSelectedKraId(previewRows[0].id);
    setPreviewRows([]);
    setShowImportModal(false);
  }

  const usedWeightage = selectedKra
    ? bscConfig.kras
        .filter((item) => item.id !== selectedKra.id)
        .reduce((sum, item) => sum + (Number(item.weightage) || 0), 0)
    : 0;
  const remainingWeightBudget = Math.max(0, 100 - usedWeightage - (Number(selectedKra?.weightage) || 0));

  return (
    <div className="goal-library-shell">
      <div className="goal-library-toolbar">
        <div>
          <button type="button" className="text-link-btn" onClick={onBack}>
            ← Back to BSC Framework Setup
          </button>
          <div className="goal-library-kicker">PMS configuration wizard</div>
          <h1>Goal Library</h1>
          <p>
            Build the master KRA library employees will pick from during goal setting. Segment the library using {differentiatorLabel} tags and decide how much structure should be pre-filled.
          </p>
        </div>

        <div className="goal-library-toolbar-actions">
          <div className="prefill-mode-card">
            <div className="summary-label">Pre-fill mode</div>
            <div className="prefill-mode-options">
              {PREFILL_OPTIONS.map((option) => (
                <label key={option.id} className={`prefill-option ${bscConfig.preFillMode === option.id ? 'is-active' : ''}`}>
                  <input
                    type="radio"
                    name="prefill-mode"
                    checked={bscConfig.preFillMode === option.id}
                    onChange={() => updateConfig((current) => ({ ...current, preFillMode: option.id }))}
                  />
                  <span>
                    <strong>{option.label}</strong>
                    <small>{option.copy}</small>
                  </span>
                </label>
              ))}
            </div>
          </div>

          <button type="button" className="bsc-ghost-btn goal-import-btn" onClick={() => fileInputRef.current?.click()}>
            Import KRAs from CSV
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".csv,text/csv"
            hidden
            onChange={handleCsvUpload}
          />
        </div>
      </div>

      <div className="goal-library-layout">
        <aside className="goal-library-sidebar">
          <div className="goal-library-sidebar-head">
            <input
              type="search"
              className="goal-library-search"
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              placeholder="Search KRAs"
            />
            <div className="bsc-field">
              <label>{differentiatorLabel}</label>
              <select value={filterValue} onChange={(event) => setFilterValue(event.target.value)}>
                <option value="all">All {differentiatorLabel} values</option>
                {primaryValues.map((value) => (
                  <option key={value} value={value}>{value}</option>
                ))}
              </select>
            </div>
          </div>

          <div className="goal-library-groups">
            {groupedKras.map(({ perspective, kras }) => (
              <div key={perspective.id} className="goal-library-group">
                <div className="goal-library-group-title">
                  <span className="goal-library-perspective-dot" style={{ backgroundColor: perspective.color }} />
                  {perspective.name}
                </div>

                {kras.map((kra) => (
                  <button
                    key={kra.id}
                    type="button"
                    className={`goal-library-kra-row ${selectedKraId === kra.id ? 'is-selected' : ''}`}
                    onClick={() => {
                      setSelectedKraId(kra.id);
                      setFieldErrors({});
                    }}
                  >
                    <div className="goal-library-kra-main">
                      <div className="goal-library-kra-name">{kra.name || 'Untitled KRA'}</div>
                      <div className="goal-library-kra-meta">
                        <span className="goal-tag-badge">{kra.tags.length ? kra.tags.join(', ') : 'All employees'}</span>
                        <span className="goal-weight-chip">{kra.weightage || 0}%</span>
                      </div>
                    </div>
                    <div className="goal-library-kra-controls">
                      <button
                        type="button"
                        className={`mini-status-toggle ${kra.status === 'active' ? 'is-active' : ''}`}
                        onClick={(event) => {
                          event.stopPropagation();
                          updateConfig((current) => ({
                            ...current,
                            kras: current.kras.map((item) => (
                              item.id === kra.id
                                ? { ...item, status: item.status === 'active' ? 'draft' : 'active' }
                                : item
                            )),
                          }));
                        }}
                      >
                        {kra.status === 'active' ? 'Active' : 'Draft'}
                      </button>
                      <span className="goal-library-pencil">✎</span>
                    </div>
                  </button>
                ))}
              </div>
            ))}
          </div>

          <button type="button" className="bsc-ghost-btn" onClick={addBlankKra}>
            + Add KRA
          </button>
        </aside>

        <section className="goal-library-detail">
          {selectedKra ? (
            <div className="goal-detail-card">
              <div className="goal-detail-header">
                <div>
                  <div className="summary-label">KRA configuration</div>
                  <h2>{selectedKra.name || 'New KRA'}</h2>
                  <p>Define the KRA, assign it to a perspective, and decide what structure should be pre-filled from the library.</p>
                </div>
              </div>

              <div className="goal-detail-body">
                <div className="bsc-grid two-up">
                  <div className="bsc-field span-2">
                    <label>KRA name</label>
                    <input
                      type="text"
                      value={selectedKra.name}
                      onChange={(event) => updateSelectedKra('name', event.target.value)}
                      placeholder="e.g. Revenue growth"
                      className={fieldErrors.name ? 'has-error' : ''}
                    />
                    {fieldErrors.name ? <span className="bsc-field-error">{fieldErrors.name}</span> : null}
                  </div>

                  <div className="bsc-field span-2">
                    <label>KRA description</label>
                    <textarea
                      rows={3}
                      value={selectedKra.description}
                      onChange={(event) => updateSelectedKra('description', event.target.value)}
                      placeholder="Optional context shown to employees"
                    />
                  </div>

                  <div className="bsc-field">
                    <label>Assign to perspective</label>
                    <select
                      value={selectedKra.perspectiveId}
                      onChange={(event) => updateSelectedKra('perspectiveId', event.target.value)}
                      className={fieldErrors.perspectiveId ? 'has-error' : ''}
                    >
                      {bscConfig.perspectives.map((perspective) => (
                        <option key={perspective.id} value={perspective.id}>{perspective.name}</option>
                      ))}
                    </select>
                    {fieldErrors.perspectiveId ? <span className="bsc-field-error">{fieldErrors.perspectiveId}</span> : null}
                  </div>

                  <div className="bsc-field">
                    <label>KRA weightage %</label>
                    <input
                      type="number"
                      min="0"
                      max="100"
                      value={selectedKra.weightage}
                      onChange={(event) => updateSelectedKra('weightage', Number(event.target.value) || 0)}
                    />
                    <p className="bsc-field-hint">Remaining weight budget after this KRA: {remainingWeightBudget}%</p>
                  </div>
                </div>

                <div className="goal-multiselect-card">
                  <div className="bsc-field">
                    <label>{differentiatorLabel}</label>
                    <div className="bsc-chip-wrap">
                      <button
                        type="button"
                        className={`bsc-chip ${selectedKra.tags.length === 0 ? 'is-selected' : ''}`}
                        onClick={() => toggleMultiValue('tags', '__all__')}
                      >
                        All employees (no tag)
                      </button>
                      {primaryValues.map((value) => (
                        <button
                          key={value}
                          type="button"
                          className={`bsc-chip ${selectedKra.tags.includes(value) ? 'is-selected' : ''}`}
                          onClick={() => toggleMultiValue('tags', value)}
                        >
                          {value}
                        </button>
                      ))}
                    </div>
                  </div>

                  {bscConfig.secondaryDifferentiatorEnabled ? (
                    <div className="bsc-field">
                      <label>{secondaryDifferentiatorLabel}</label>
                      <div className="bsc-chip-wrap">
                        <button
                          type="button"
                          className={`bsc-chip ${selectedKra.secondaryTags.length === 0 ? 'is-selected' : ''}`}
                          onClick={() => toggleMultiValue('secondaryTags', '__all__')}
                        >
                          All values
                        </button>
                        {secondaryValues.map((value) => (
                          <button
                            key={value}
                            type="button"
                            className={`bsc-chip ${selectedKra.secondaryTags.includes(value) ? 'is-selected' : ''}`}
                            onClick={() => toggleMultiValue('secondaryTags', value)}
                          >
                            {value}
                          </button>
                        ))}
                      </div>
                    </div>
                  ) : null}
                </div>

                {(bscConfig.preFillMode === 'kras-kpis' || bscConfig.preFillMode === 'fully-prefilled') ? (
                  <div className="goal-library-kpi-block">
                    <div className="bsc-toggle-row">
                      <div>
                        <div className="bsc-toggle-title">Pre-fill KPIs for this KRA</div>
                        <div className="bsc-toggle-copy">Turn this on if the master library should also define KPI rows under this KRA.</div>
                      </div>
                      <button
                        type="button"
                        className={`bsc-switch ${selectedKra.includeKPIs ? 'is-on' : ''}`}
                        onClick={() => updateSelectedKra('includeKPIs', !selectedKra.includeKPIs)}
                      >
                        <span />
                      </button>
                    </div>

                    {selectedKra.includeKPIs ? (
                      <div className="goal-library-kpi-list">
                        {fieldErrors.kpis ? <div className="bsc-inline-error">{fieldErrors.kpis}</div> : null}

                        {selectedKra.kpis.map((kpi) => (
                          <div key={kpi.id} className="goal-library-kpi-row">
                            <div className="bsc-grid two-up compact">
                              <div className="bsc-field">
                                <label>KPI name</label>
                                <input
                                  type="text"
                                  value={kpi.name}
                                  onChange={(event) => updateSelectedKpi(kpi.id, 'name', event.target.value)}
                                  placeholder="KPI name"
                                />
                              </div>

                              <div className="bsc-field">
                                <label>Unit of measurement</label>
                                <select value={kpi.unit} onChange={(event) => updateSelectedKpi(kpi.id, 'unit', event.target.value)}>
                                  {KPI_UNITS.map((unit) => (
                                    <option key={unit} value={unit}>{unit}</option>
                                  ))}
                                </select>
                              </div>

                              <div className="bsc-field">
                                <label>Direction</label>
                                <select value={kpi.direction} onChange={(event) => updateSelectedKpi(kpi.id, 'direction', event.target.value)}>
                                  {KPI_DIRECTIONS.map((direction) => (
                                    <option key={direction.id} value={direction.id}>{direction.label}</option>
                                  ))}
                                </select>
                              </div>

                              <div className="bsc-field">
                                <label>Target policy</label>
                                <div className="kpi-target-toggle">
                                  <button
                                    type="button"
                                    className={`bsc-chip ${kpi.preFillTarget ? 'is-selected' : ''}`}
                                    onClick={() => updateSelectedKpi(kpi.id, 'preFillTarget', !kpi.preFillTarget)}
                                  >
                                    {kpi.preFillTarget ? 'Target pre-filled' : 'Target entered later'}
                                  </button>
                                </div>
                              </div>

                              {bscConfig.preFillMode === 'fully-prefilled' && kpi.preFillTarget ? (
                                <div className="bsc-field span-2">
                                  <label>Pre-fill target value</label>
                                  <input
                                    type="text"
                                    value={kpi.targetValue}
                                    onChange={(event) => updateSelectedKpi(kpi.id, 'targetValue', event.target.value)}
                                    placeholder="Enter target value"
                                  />
                                </div>
                              ) : (
                                <div className="goal-library-kpi-note span-2">
                                  {kpi.preFillTarget
                                    ? 'Target value will be stored from the library for this KPI.'
                                    : 'Target will be entered during goal setting phase.'}
                                </div>
                              )}
                            </div>

                            <button type="button" className="bsc-icon-btn danger" onClick={() => removeKpi(kpi.id)}>
                              🗑
                            </button>
                          </div>
                        ))}

                        <button
                          type="button"
                          className="bsc-ghost-btn"
                          onClick={addKpi}
                          disabled={selectedKra.kpis.length >= maxKPIs}
                        >
                          + Add KPI
                        </button>
                        <p className="bsc-field-hint">Maximum KPIs per KRA: {maxKPIs}</p>
                      </div>
                    ) : null}
                  </div>
                ) : null}

                <div className="goal-library-footer-actions">
                  <button type="button" className="bsc-ghost-btn compact" onClick={() => saveKra('draft')}>
                    Save as draft
                  </button>
                  <button type="button" className="bsc-primary-btn" onClick={() => saveKra('active')}>
                    Save KRA
                  </button>
                </div>
              </div>
            </div>
          ) : (
            <div className="goal-library-empty">
              <h2>Select or create a KRA</h2>
              <p>Pick a KRA from the library list or add a new one to start configuring the detail panel.</p>
              <button type="button" className="bsc-primary-btn" onClick={addBlankKra}>
                + Add KRA
              </button>
            </div>
          )}
        </section>
      </div>

      {showImportModal ? (
        <div className="import-modal-backdrop">
          <div className="import-modal">
            <div className="goal-library-kicker">CSV import preview</div>
            <h2>Review imported KRAs</h2>
            <p>Preview the KRAs parsed from your CSV before adding them to the goal library.</p>

            <div className="import-preview-table">
              <div className="import-preview-head">
                <span>KRA Name</span>
                <span>Perspective</span>
                <span>{differentiatorLabel}</span>
                <span>Weightage</span>
                <span>KPI count</span>
              </div>
              {previewRows.map((kra) => {
                const perspective = bscConfig.perspectives.find((item) => item.id === kra.perspectiveId);
                return (
                  <div key={kra.id} className="import-preview-row">
                    <span>{kra.name || 'Untitled KRA'}</span>
                    <span>{perspective?.name || 'Unmapped'}</span>
                    <span>{kra.tags.length ? kra.tags.join(', ') : 'All employees'}</span>
                    <span>{kra.weightage}%</span>
                    <span>{kra.kpis.length}</span>
                  </div>
                );
              })}
            </div>

            <div className="import-modal-actions">
              <button type="button" className="bsc-ghost-btn compact" onClick={() => { setShowImportModal(false); setPreviewRows([]); }}>
                Cancel
              </button>
              <button type="button" className="bsc-primary-btn" onClick={confirmImport}>
                Save imported KRAs
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
