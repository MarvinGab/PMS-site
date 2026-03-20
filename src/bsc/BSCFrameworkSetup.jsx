import { useEffect, useMemo, useState } from 'react';
import {
  createPerspective,
  GRADE_VISIBILITY_OPTIONS,
  ORG_GRADE_OPTIONS,
  PRESET_PERSPECTIVE_COLORS,
  useBSCConfig,
} from './BSCConfigContext';

const SECTION_META = [
  { id: 'perspectives', label: 'Perspectives setup' },
  { id: 'objectives', label: 'Objectives visibility' },
  { id: 'differentiator', label: 'Goal library differentiator' },
  { id: 'secondary', label: 'Secondary differentiator' },
];

const EMPLOYEE_FIELD_OPTIONS = [
  'Department',
  'Designation',
  'Grade/Band',
  'Cost Center',
  'Location',
  'Employment type',
  'Custom',
];

function reorderByIds(list, draggedId, targetId) {
  const next = [...list];
  const fromIndex = next.findIndex((item) => item.id === draggedId);
  const toIndex = next.findIndex((item) => item.id === targetId);
  if (fromIndex === -1 || toIndex === -1 || fromIndex === toIndex) return list;
  const [moved] = next.splice(fromIndex, 1);
  next.splice(toIndex, 0, moved);
  return next;
}

function validateBSCConfig(config) {
  const errors = {};
  const total = config.perspectives.reduce((sum, item) => sum + (Number(item.weightage) || 0), 0);

  if (!config.perspectives.length) {
    errors.perspectives = 'Add at least one perspective.';
  }

  if (total !== 100) {
    errors.weightageTotal = 'Perspective weightage must total exactly 100%.';
  }

  config.perspectives.forEach((item) => {
    if (!item.name.trim()) {
      errors[`name-${item.id}`] = 'Perspective name is required.';
    }
    if (item.weightage === '' || Number.isNaN(Number(item.weightage))) {
      errors[`weightage-${item.id}`] = 'Enter a valid weightage.';
    }
  });

  if (config.showStrategicObjectives && config.objectiveVisibilityGrade === 'Custom' && !config.customVisibleGrades.length) {
    errors.customVisibleGrades = 'Select at least one grade for custom visibility.';
  }

  if (config.differentiatorEnabled && !config.differentiatorLabel.trim()) {
    errors.differentiatorLabel = 'Attribute name is required when differentiator is enabled.';
  }

  if (config.differentiatorEnabled && config.differentiatorField === 'Custom' && !config.differentiatorCustomField.trim()) {
    errors.differentiatorCustomField = 'Enter the employee data field name.';
  }

  if (config.secondaryDifferentiatorEnabled && !config.secondaryDifferentiatorLabel.trim()) {
    errors.secondaryDifferentiatorLabel = 'Secondary attribute name is required.';
  }

  if (config.secondaryDifferentiatorEnabled && config.secondaryDifferentiatorField === 'Custom' && !config.secondaryDifferentiatorCustomField.trim()) {
    errors.secondaryDifferentiatorCustomField = 'Enter the secondary employee data field name.';
  }

  return errors;
}

export default function BSCFrameworkSetup({ onContinue }) {
  const { bscConfig, setBscConfig } = useBSCConfig();
  const [expandedRows, setExpandedRows] = useState(() => new Set(bscConfig.perspectives.map((item) => item.id)));
  const [activeSection, setActiveSection] = useState('perspectives');
  const [draggedPerspectiveId, setDraggedPerspectiveId] = useState(null);
  const [errors, setErrors] = useState({});

  const totalWeightage = useMemo(
    () => bscConfig.perspectives.reduce((sum, item) => sum + (Number(item.weightage) || 0), 0),
    [bscConfig.perspectives],
  );

  useEffect(() => {
    const handleScroll = () => {
      const sections = SECTION_META
        .map((section) => ({ id: section.id, node: document.getElementById(section.id) }))
        .filter((section) => section.node);
      const current = sections.find((section) => {
        const rect = section.node.getBoundingClientRect();
        return rect.top <= 180 && rect.bottom >= 180;
      });
      if (current) setActiveSection(current.id);
    };

    window.addEventListener('scroll', handleScroll, { passive: true });
    handleScroll();
    return () => window.removeEventListener('scroll', handleScroll);
  }, []);

  function updateConfig(updater) {
    setBscConfig((current) => {
      const next = typeof updater === 'function' ? updater(current) : updater;
      return next;
    });
  }

  function updatePerspective(perspectiveId, field, value) {
    updateConfig((current) => ({
      ...current,
      perspectives: current.perspectives.map((item) => (
        item.id === perspectiveId ? { ...item, [field]: value } : item
      )),
    }));
  }

  function addPerspective() {
    const fresh = createPerspective();
    setExpandedRows((current) => new Set(current).add(fresh.id));
    updateConfig((current) => ({
      ...current,
      perspectives: [...current.perspectives, fresh],
    }));
  }

  function removePerspective(perspectiveId) {
    updateConfig((current) => ({
      ...current,
      perspectives: current.perspectives.filter((item) => item.id !== perspectiveId),
    }));
    setExpandedRows((current) => {
      const next = new Set(current);
      next.delete(perspectiveId);
      return next;
    });
  }

  function toggleExpanded(perspectiveId) {
    setExpandedRows((current) => {
      const next = new Set(current);
      if (next.has(perspectiveId)) next.delete(perspectiveId);
      else next.add(perspectiveId);
      return next;
    });
  }

  function scrollToSection(sectionId) {
    const node = document.getElementById(sectionId);
    if (!node) return;
    node.scrollIntoView({ behavior: 'smooth', block: 'start' });
    setActiveSection(sectionId);
  }

  function toggleCustomGrade(grade) {
    updateConfig((current) => ({
      ...current,
      customVisibleGrades: current.customVisibleGrades.includes(grade)
        ? current.customVisibleGrades.filter((item) => item !== grade)
        : [...current.customVisibleGrades, grade],
    }));
  }

  function handleSave() {
    const nextErrors = validateBSCConfig(bscConfig);
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length) return;
    onContinue();
  }

  return (
    <div className="bsc-page-shell">
      <aside className="bsc-mini-nav">
        <div className="bsc-mini-nav-sticky">
          <div className="bsc-mini-nav-eyebrow">BSC Setup</div>
          <h3 className="bsc-mini-nav-title">Balanced Scorecard configuration</h3>
          <p className="bsc-mini-nav-copy">
            Configure perspectives, objective visibility, and the goal-library segmentation logic before moving into the goal library.
          </p>

          <nav className="bsc-anchor-list">
            {SECTION_META.map((section) => (
              <button
                key={section.id}
                type="button"
                className={`bsc-anchor-link ${activeSection === section.id ? 'is-active' : ''}`}
                onClick={() => scrollToSection(section.id)}
              >
                {section.label}
              </button>
            ))}
          </nav>
        </div>
      </aside>

      <div className="bsc-main-column">
        <div className="bsc-sticky-hero">
          <div>
            <div className="bsc-hero-eyebrow">PMS configuration wizard</div>
            <h1 className="bsc-hero-title">BSC Framework Setup</h1>
            <p className="bsc-hero-copy">
              Define your Balanced Scorecard structure, how strategic objectives are exposed, and how the goal library should be segmented for employees.
            </p>
          </div>
          <div className={`bsc-total-badge ${totalWeightage === 100 ? 'is-balanced' : totalWeightage > 100 ? 'is-over' : ''}`}>
            Total weightage: {totalWeightage}%
          </div>
        </div>

        <section id="perspectives" className="bsc-section">
          <div className="bsc-section-header">
            <div>
              <div className="bsc-section-kicker">Section 1</div>
              <h2>Perspectives setup</h2>
              <p>Create, reorder, and weight the strategic perspectives employees will see in the PMS flow.</p>
            </div>
            {errors.weightageTotal ? <div className="bsc-inline-error">{errors.weightageTotal}</div> : null}
          </div>

          <div className="bsc-card">
            <div className="bsc-card-header">
              <div>
                <h3>Perspective stack</h3>
                <p>Each perspective can carry an optional description and a strategic objective shown as context to employees.</p>
              </div>
              <div className={`bsc-weight-pill ${totalWeightage === 100 ? 'is-balanced' : totalWeightage > 100 ? 'is-over' : ''}`}>
                {totalWeightage === 100 ? 'Balanced at 100%' : `${totalWeightage}% total`}
              </div>
            </div>

            <div className="bsc-card-body">
              {errors.perspectives ? <div className="bsc-inline-error">{errors.perspectives}</div> : null}

              {bscConfig.perspectives.map((perspective) => {
                const expanded = expandedRows.has(perspective.id);
                return (
                  <div
                    key={perspective.id}
                    className="bsc-perspective-row"
                    draggable
                    onDragStart={() => setDraggedPerspectiveId(perspective.id)}
                    onDragOver={(event) => event.preventDefault()}
                    onDrop={() => {
                      if (!draggedPerspectiveId) return;
                      updateConfig((current) => ({
                        ...current,
                        perspectives: reorderByIds(current.perspectives, draggedPerspectiveId, perspective.id),
                      }));
                      setDraggedPerspectiveId(null);
                    }}
                  >
                    <div className="bsc-perspective-main">
                      <button type="button" className="bsc-icon-btn bsc-drag-handle" aria-label="Reorder perspective">
                        ⋮⋮
                      </button>

                      <div className="bsc-swatch-group">
                        {PRESET_PERSPECTIVE_COLORS.map((color) => (
                          <button
                            key={color}
                            type="button"
                            className={`bsc-swatch ${perspective.color === color ? 'is-selected' : ''}`}
                            style={{ backgroundColor: color }}
                            onClick={() => updatePerspective(perspective.id, 'color', color)}
                            aria-label={`Set color ${color}`}
                          />
                        ))}
                      </div>

                      <div className="bsc-field grow">
                        <label>Perspective name</label>
                        <input
                          type="text"
                          value={perspective.name}
                          onChange={(event) => updatePerspective(perspective.id, 'name', event.target.value)}
                          placeholder="Perspective name"
                          className={errors[`name-${perspective.id}`] ? 'has-error' : ''}
                        />
                        {errors[`name-${perspective.id}`] ? <span className="bsc-field-error">{errors[`name-${perspective.id}`]}</span> : null}
                      </div>

                      <div className="bsc-field bsc-weight-field">
                        <label>Weightage %</label>
                        <input
                          type="number"
                          min="0"
                          max="100"
                          value={perspective.weightage}
                          onChange={(event) => updatePerspective(perspective.id, 'weightage', event.target.value === '' ? '' : Number(event.target.value))}
                          className={errors[`weightage-${perspective.id}`] ? 'has-error' : ''}
                        />
                        {errors[`weightage-${perspective.id}`] ? <span className="bsc-field-error">{errors[`weightage-${perspective.id}`]}</span> : null}
                      </div>

                      <div className="bsc-field grow">
                        <label>Description</label>
                        <input
                          type="text"
                          value={perspective.description}
                          onChange={(event) => updatePerspective(perspective.id, 'description', event.target.value)}
                          placeholder="Optional description for HR context"
                        />
                      </div>

                      <button type="button" className="bsc-icon-btn" onClick={() => toggleExpanded(perspective.id)} aria-label="Toggle strategic objective">
                        {expanded ? '⌄' : '›'}
                      </button>
                      <button
                        type="button"
                        className="bsc-icon-btn danger"
                        onClick={() => removePerspective(perspective.id)}
                        aria-label="Delete perspective"
                      >
                        🗑
                      </button>
                    </div>

                    {expanded ? (
                      <div className="bsc-perspective-detail">
                        <div className="bsc-field">
                          <label>Strategic objective</label>
                          <textarea
                            value={perspective.strategicObjective}
                            onChange={(event) => updatePerspective(perspective.id, 'strategicObjective', event.target.value)}
                            rows={3}
                            placeholder="Write the strategic objective employees should see as context under this perspective."
                          />
                          <p className="bsc-field-hint">
                            Display-only context shown under the perspective when employees fill their KRAs. This is not a rateable field.
                          </p>
                        </div>
                      </div>
                    ) : null}
                  </div>
                );
              })}

              <button type="button" className="bsc-ghost-btn" onClick={addPerspective}>
                + Add perspective
              </button>
            </div>
          </div>
        </section>

        <section id="objectives" className="bsc-section">
          <div className="bsc-section-header">
            <div>
              <div className="bsc-section-kicker">Section 2</div>
              <h2>Objectives visibility</h2>
              <p>Decide whether employees see strategic objective text or only the perspective name.</p>
            </div>
          </div>

          <div className="bsc-card">
            <div className="bsc-card-body">
              <div className="bsc-toggle-row">
                <div>
                  <div className="bsc-toggle-title">Show strategic objectives to employees</div>
                  <div className="bsc-toggle-copy">Employees see the objective statement beneath each perspective while filling KRAs.</div>
                </div>
                <button
                  type="button"
                  className={`bsc-switch ${bscConfig.showStrategicObjectives ? 'is-on' : ''}`}
                  onClick={() => updateConfig((current) => ({ ...current, showStrategicObjectives: !current.showStrategicObjectives }))}
                  aria-label="Toggle strategic objective visibility"
                >
                  <span />
                </button>
              </div>

              {bscConfig.showStrategicObjectives ? (
                <div className="bsc-subpanel">
                  <div className="bsc-field">
                    <label>Visible to employees at grade level</label>
                    <select
                      value={bscConfig.objectiveVisibilityGrade}
                      onChange={(event) => updateConfig((current) => ({ ...current, objectiveVisibilityGrade: event.target.value }))}
                    >
                      {GRADE_VISIBILITY_OPTIONS.map((option) => (
                        <option key={option} value={option}>{option}</option>
                      ))}
                    </select>
                  </div>

                  {bscConfig.objectiveVisibilityGrade === 'Custom' ? (
                    <div className="bsc-field">
                      <label>Custom grade visibility</label>
                      <div className="bsc-chip-wrap">
                        {ORG_GRADE_OPTIONS.map((grade) => (
                          <button
                            key={grade}
                            type="button"
                            className={`bsc-chip ${bscConfig.customVisibleGrades.includes(grade) ? 'is-selected' : ''}`}
                            onClick={() => toggleCustomGrade(grade)}
                          >
                            {grade}
                          </button>
                        ))}
                      </div>
                      {errors.customVisibleGrades ? <span className="bsc-field-error">{errors.customVisibleGrades}</span> : null}
                    </div>
                  ) : null}

                  <div className="bsc-callout info">
                    Employees below the selected grade see the perspective name only, not the objective text.
                  </div>
                </div>
              ) : null}
            </div>
          </div>
        </section>

        <section id="differentiator" className="bsc-section">
          <div className="bsc-section-header">
            <div>
              <div className="bsc-section-kicker">Section 3</div>
              <h2>Goal library differentiator</h2>
              <p>Set the attribute that controls which KRAs from the goal library are visible to each employee.</p>
            </div>
          </div>

          <div className="bsc-card">
            <div className="bsc-card-header">
              <div>
                <h3>Goal library differentiator</h3>
                <p>This label will be reused in the Excel template and the Goal Library tagging experience.</p>
              </div>
            </div>
            <div className="bsc-card-body">
              <div className="bsc-toggle-row">
                <div>
                  <div className="bsc-toggle-title">Use a differentiator to segment the goal library</div>
                  <div className="bsc-toggle-copy">Restrict which KRAs appear based on a selected employee profile attribute.</div>
                </div>
                <button
                  type="button"
                  className={`bsc-switch ${bscConfig.differentiatorEnabled ? 'is-on' : ''}`}
                  onClick={() => updateConfig((current) => ({ ...current, differentiatorEnabled: !current.differentiatorEnabled }))}
                  aria-label="Toggle goal library differentiator"
                >
                  <span />
                </button>
              </div>

              {bscConfig.differentiatorEnabled ? (
                <div className="bsc-grid two-up">
                  <div className="bsc-field">
                    <label>Attribute name</label>
                    <input
                      type="text"
                      placeholder="e.g. Department, Function, Business unit, Role cluster"
                      value={bscConfig.differentiatorLabel}
                      onChange={(event) => updateConfig((current) => ({ ...current, differentiatorLabel: event.target.value }))}
                      className={errors.differentiatorLabel ? 'has-error' : ''}
                    />
                    {errors.differentiatorLabel ? <span className="bsc-field-error">{errors.differentiatorLabel}</span> : null}
                  </div>

                  <div className="bsc-field">
                    <label>Map attribute to employee data field</label>
                    <select
                      value={bscConfig.differentiatorField}
                      onChange={(event) => updateConfig((current) => ({ ...current, differentiatorField: event.target.value }))}
                    >
                      {EMPLOYEE_FIELD_OPTIONS.map((option) => (
                        <option key={option} value={option}>{option}</option>
                      ))}
                    </select>
                  </div>

                  {bscConfig.differentiatorField === 'Custom' ? (
                    <div className="bsc-field span-2">
                      <label>Custom employee data field</label>
                      <input
                        type="text"
                        placeholder="Enter the employee profile field name"
                        value={bscConfig.differentiatorCustomField}
                        onChange={(event) => updateConfig((current) => ({ ...current, differentiatorCustomField: event.target.value }))}
                        className={errors.differentiatorCustomField ? 'has-error' : ''}
                      />
                      {errors.differentiatorCustomField ? <span className="bsc-field-error">{errors.differentiatorCustomField}</span> : null}
                    </div>
                  ) : null}
                </div>
              ) : (
                <div className="bsc-callout neutral">
                  All KRAs in the goal library will be visible to all employees regardless of their profile.
                </div>
              )}

              {bscConfig.differentiatorEnabled ? (
                <div className="bsc-callout neutral">
                  Employees whose profile matches a KRA&apos;s attribute tag will see only those KRAs. KRAs with no attribute tag are visible to all employees.
                </div>
              ) : null}
            </div>
          </div>
        </section>

        <section id="secondary" className="bsc-section">
          <div className="bsc-section-header">
            <div>
              <div className="bsc-section-kicker">Section 4</div>
              <h2>Secondary differentiator</h2>
              <p>Optionally add a second attribute so goal library visibility works as an AND condition.</p>
            </div>
          </div>

          <div className="bsc-card">
            <div className="bsc-card-body">
              <div className="bsc-toggle-row">
                <div>
                  <div className="bsc-toggle-title">Add a secondary differentiator condition</div>
                  <div className="bsc-toggle-copy">Both primary and secondary attributes must match for a tagged KRA to appear.</div>
                </div>
                <button
                  type="button"
                  className={`bsc-switch ${bscConfig.secondaryDifferentiatorEnabled ? 'is-on' : ''}`}
                  onClick={() => updateConfig((current) => ({ ...current, secondaryDifferentiatorEnabled: !current.secondaryDifferentiatorEnabled }))}
                  aria-label="Toggle secondary differentiator"
                >
                  <span />
                </button>
              </div>

              {bscConfig.secondaryDifferentiatorEnabled ? (
                <div className="bsc-grid two-up">
                  <div className="bsc-field">
                    <label>Attribute name</label>
                    <input
                      type="text"
                      placeholder="e.g. Region, Product line, Role family"
                      value={bscConfig.secondaryDifferentiatorLabel}
                      onChange={(event) => updateConfig((current) => ({ ...current, secondaryDifferentiatorLabel: event.target.value }))}
                      className={errors.secondaryDifferentiatorLabel ? 'has-error' : ''}
                    />
                    {errors.secondaryDifferentiatorLabel ? <span className="bsc-field-error">{errors.secondaryDifferentiatorLabel}</span> : null}
                  </div>

                  <div className="bsc-field">
                    <label>Map attribute to employee data field</label>
                    <select
                      value={bscConfig.secondaryDifferentiatorField}
                      onChange={(event) => updateConfig((current) => ({ ...current, secondaryDifferentiatorField: event.target.value }))}
                    >
                      {EMPLOYEE_FIELD_OPTIONS.map((option) => (
                        <option key={option} value={option}>{option}</option>
                      ))}
                    </select>
                  </div>

                  {bscConfig.secondaryDifferentiatorField === 'Custom' ? (
                    <div className="bsc-field span-2">
                      <label>Custom employee data field</label>
                      <input
                        type="text"
                        placeholder="Enter the employee profile field name"
                        value={bscConfig.secondaryDifferentiatorCustomField}
                        onChange={(event) => updateConfig((current) => ({ ...current, secondaryDifferentiatorCustomField: event.target.value }))}
                        className={errors.secondaryDifferentiatorCustomField ? 'has-error' : ''}
                      />
                      {errors.secondaryDifferentiatorCustomField ? <span className="bsc-field-error">{errors.secondaryDifferentiatorCustomField}</span> : null}
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
          </div>
        </section>

        <div className="bsc-sticky-footer">
          <div>
            <div className="bsc-footer-title">Next step: Goal Library</div>
            <div className="bsc-footer-copy">Save the framework configuration and carry the BSC setup into the goal-library page.</div>
          </div>
          <button type="button" className="bsc-primary-btn" onClick={handleSave}>
            Save &amp; continue to Goal Library →
          </button>
        </div>
      </div>
    </div>
  );
}
