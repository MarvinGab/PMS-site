import { useEffect, useMemo, useRef, useState } from 'react';
import zaroLogo from '../images/final zaro logo.png';
import { downloadGoalLibraryTemplate, parseGoalLibraryXlsx, downloadEmployeeTemplate, parseEmployeeXlsx, validateGoalLibraryData, downloadErrorReport, goalLibraryTemplateMeta, employeeTemplateMeta, validateEmployeeData, downloadAttributeValuesTemplate, parseAttributeValuesXlsx, downloadGoalLibraryBulkTemplate, downloadPrefillBulkTemplate, parseGoalLibraryBulkXlsx, getEmployeeRoutingColumns } from './templateUtils';

/* ─── CONSTANTS ──────────────────────────────────────────────────────────── */
function getNavSteps(config) {
  const frameworkId = typeof config === 'string' ? config : config?.frameworkId;
  const hasLibrary  = typeof config === 'object' && (
    config.goalGroups?.length > 0
      ? groupsNeedingDataUpload(config).length > 0
      : config?.goalCreationMode === 'admin-library'
  );
  const hasBscPrefill = typeof config === 'object' && (config.goalGroups || []).some(group => !!group.prefillType);
  const hasBscLibraries = typeof config === 'object' && (config.goalGroups || []).some(group => !!group.hasLibrary);
  if (frameworkId === 'bsc') {
    const steps = [
      { id: 'framework',      label: 'Performance Framework', desc: 'Choose framework' },
      { id: 'perspectives',   label: 'BSC Perspectives',      desc: 'Strategy layers & weights' },
      { id: 'groups',         label: 'Groups & Strategy',     desc: 'Who gets what goal approach' },
      ...(hasBscPrefill ? [{ id: 'prefill_data', label: 'Pre-fill Data', desc: 'Upload pre-assigned KRAs/KPIs' }] : []),
      ...(hasBscLibraries ? [{ id: 'goal_libraries', label: 'Goal Libraries', desc: 'Build or upload KRA libraries' }] : []),
      { id: 'limits',         label: 'Goal Limits',           desc: 'KRA/KPI count & weight rules' },
      { id: 'emp_settings',   label: 'Employee Settings',     desc: 'Manager hierarchy & email rules' },
      { id: 'upload',         label: 'Employee Upload',       desc: 'Upload employees, managers & routing' },
      { id: 'summary',        label: 'Summary & Launch',      desc: 'Review & go live' },
    ];
    return steps;
  }
  const steps = [
    { id: 'framework',    label: 'Performance Framework', desc: 'Structure & model' },
    { id: 'goals',        label: 'Goal Library',           desc: 'Flat KRA / KPI structure' },
  ];
  if (hasLibrary) steps.push({ id: 'kra_library', label: 'KRA Library', desc: 'Build & upload goal library' });
  steps.push(
    { id: 'limits',       label: 'Limits & Rules',          desc: 'Counts, weights & permissions' },
    { id: 'hierarchy',    label: 'Rating Hierarchy',        desc: 'Who rates whom' },
    { id: 'scale',        label: 'Rating Scale',            desc: 'Points & labels' },
  );
  if (frameworkId !== 'kra') {
    steps.push({ id: 'targets', label: 'Targets & Auto-Rating', desc: 'Achievement mapping' });
  }
  steps.push(
    { id: 'competencies', label: 'Competencies',            desc: 'Behavioural assessment' },
    { id: 'bellcurve',    label: 'Bell Curve',              desc: 'Normalization bands' },
    { id: 'phases',       label: 'Phase Windows',           desc: 'Cycle dates' },
    { id: 'export',       label: 'Export & Launch',         desc: 'Template & go-live' },
  );
  return steps;
}

const FRAMEWORKS = [
  { id: 'bsc',     name: 'BSC — Balanced Scorecard',       desc: 'Perspectives → KRAs → KPIs. Strategy-driven. Rating weighted across perspectives.', tags: ['BFSI', 'PSU', 'Manufacturing', 'Pharma'], color: '#2563EB',
    flow: ['Perspectives', 'KRAs', 'KPIs', 'Targets', 'Rating'] },
  { id: 'kra-kpi', name: 'KRA → KPI (flat)',               desc: 'No perspectives. KRAs directly hold KPIs. Simple and widely adopted.', tags: ['IT/Software', 'Startups', 'Retail'],      color: '#16A34A',
    flow: ['KRAs', 'KPIs', 'Targets', 'Rating'] },
  { id: 'kra',     name: 'KRA only (no KPI)',              desc: 'KRAs rated directly by manager. No sub-KPIs. Fast, qualitative approach.', tags: ['SMBs', 'NGOs', 'Education'],              color: '#D97706',
    flow: ['KRAs', 'Weightage', 'Direct Rating'] },
  { id: 'custom',  name: 'Custom Hybrid',                  desc: 'Mix any structure — e.g. BSC perspectives + KRAs only, or KRA + competencies only.', tags: ['Advanced', 'Enterprise'], color: '#DC2626',
    flow: ['Custom Mix', 'Configure Each Layer'] },
];

const MODULES_LIST = [
  { id: 'kra',      label: 'KRAs (Key Result Areas)',        desc: 'Employees set and get rated on key result areas',                          core: true },
  { id: 'kpi',      label: 'KPIs (Key Performance Indicators)', desc: 'Sub-metrics under each KRA with targets and achievement',               core: false },
  { id: 'persp',    label: 'Perspectives (BSC)',             desc: 'Group KRAs under strategic perspectives with perspective-level weightages', core: false },
  { id: 'goals',    label: 'Goals',                          desc: 'Employee-level goals separate from KRAs, can cascade from org/dept level', core: false },
  { id: 'comp',     label: 'Competencies',                   desc: 'Behavioural and functional competency assessment alongside KRAs',          core: false },
  { id: 'quest',    label: 'Questionnaire (post-evaluation)','desc': 'Ask employees and managers structured questions after rating',           core: false },
  { id: 'idp',      label: 'Development Plan (IDP)',         desc: 'Post-appraisal individual development plan with learning actions',         core: false },
  { id: 'potential',label: 'Potential Rating',               desc: 'Manager rates employee potential separately from performance',             core: false },
  { id: 'midyear',  label: 'Mid-Year Review',                desc: 'Enable a mid-cycle check-in review phase',                                core: false },
  { id: 'bell',     label: 'Bell Curve / Normalization',     desc: 'HR can normalize final ratings across distribution bands',                 core: false },
  { id: 'showfinal',label: 'Show Final Rating to Employee',  desc: 'Employee sees manager\'s final rating after publish',                      core: false },
  { id: 'showself', label: 'Show Self Rating to Manager',    desc: 'Manager can see employee\'s self rating while rating',                    core: false },
];

const PRIMARY_ID_OPTIONS = ['Department', 'Designation / Role', 'Grade / Band', 'Location', 'Employment Type', 'Cost Center', 'Employee Code'];

const KRA_ASSIGNMENT_MODES = [
  {
    id: 'Pre-assigned by HR (locked)',
    icon: '🔒',
    title: 'Pre-assigned by HR (locked)',
    desc: 'HR assigns KRAs per segment. Employees cannot change the list.',
    impact: { goalLibrary: 'Required — must build per segment', preFill: 'Fully pre-filled', employeeControl: 'None — view only' },
    syncConfig: { goalPreFillDepth: 'fully-prefilled', employeeCanAddGoals: false },
  },
  {
    id: 'Pre-filled, employee can edit',
    icon: '✏️',
    title: 'Pre-filled, employee can edit',
    desc: 'HR provides a starting set. Employees adjust within set limits.',
    impact: { goalLibrary: 'Recommended as starting point', preFill: 'KRAs only', employeeControl: 'Partial — within limits' },
    syncConfig: { goalPreFillDepth: 'kras-only', employeeCanAddGoals: true },
  },
  {
    id: 'Employee creates own KRAs',
    icon: '🧑',
    title: 'Employee creates own KRAs',
    desc: 'Employees write their own KRAs from scratch, manager approves.',
    impact: { goalLibrary: 'Optional suggested library', preFill: 'None — blank start', employeeControl: 'Full — employee-driven' },
    syncConfig: { goalPreFillDepth: 'kras-only', employeeCanAddGoals: true },
  },
  {
    id: 'Manager assigns to employee',
    icon: '👔',
    title: 'Manager assigns to employee',
    desc: 'Manager assigns KRAs directly to each reportee from the library.',
    impact: { goalLibrary: 'For manager to pick from', preFill: 'Manager-driven', employeeControl: 'None — manager controls' },
    syncConfig: { goalPreFillDepth: 'kras-only', employeeCanAddGoals: false, managerCanAddGoals: true },
  },
];

const COMPETENCY_CHIPS = ['Communication', 'Problem Solving', 'Teamwork', 'Ownership', 'Technical Expertise', 'Leadership', 'Innovation', 'Customer Focus', 'Adaptability', 'Collaboration', 'Result Orientation', 'Strategic Thinking'];
const APP_DATA_KEY = 'zarohr_app_data_v1';
const SESSION_KEY = 'zarohr_auth_session';
const WIZARD_STATE_KEY = 'zarohr_pms_wizard_state_v1';

const FRAMEWORK_MODULE_RULES = {
  bsc: {
    forcedOn: ['kra', 'kpi', 'persp'],
    forcedOff: [],
  },
  'kra-kpi': {
    forcedOn: ['kra', 'kpi'],
    forcedOff: ['persp'],
  },
  kra: {
    forcedOn: ['kra'],
    forcedOff: ['kpi', 'persp'],
  },
  custom: {
    forcedOn: ['kra'],
    forcedOff: [],
  },
};

function getFrameworkModuleState(frameworkId, moduleId) {
  const rules = FRAMEWORK_MODULE_RULES[frameworkId] || FRAMEWORK_MODULE_RULES.custom;
  if (moduleId === 'kra') {
    return { forcedOn: true, forcedOff: false };
  }
  return {
    forcedOn: rules.forcedOn.includes(moduleId),
    forcedOff: rules.forcedOff.includes(moduleId),
  };
}

function syncEnabledModules(frameworkId, enabledModules) {
  const rules = FRAMEWORK_MODULE_RULES[frameworkId] || FRAMEWORK_MODULE_RULES.custom;
  const next = new Set(enabledModules.filter((moduleId) => !rules.forcedOff.includes(moduleId)));
  rules.forcedOn.forEach((moduleId) => next.add(moduleId));
  next.add('kra');
  return [...next];
}

function getWorkspaceContext() {
  if (typeof window === 'undefined') {
    return { orgKey: '', orgName: 'Assigned Organization' };
  }

  const params = new URLSearchParams(window.location.search);
  const orgKey = params.get('orgKey') || '';

  try {
    const raw = window.localStorage.getItem(APP_DATA_KEY);
    if (raw) {
      const data = JSON.parse(raw);
      const org = Array.isArray(data.organizationsData)
        ? data.organizationsData.find((item) => item.key === orgKey)
        : null;
      if (org?.name) {
        return { orgKey, orgName: org.name };
      }
    }
  } catch {
    // Silently ignore parsing errors
  }

  return { orgKey, orgName: orgKey ? orgKey.replace(/-/g, ' ') : 'Assigned Organization' };
}

function getWizardStorageKey(orgKey = '') {
  return `${WIZARD_STATE_KEY}:${orgKey || 'default'}`;
}

function loadWizardState(orgKeyArg) {
  if (typeof window === 'undefined') {
    return null;
  }

  const orgKey = orgKeyArg !== undefined
    ? orgKeyArg
    : (new URLSearchParams(window.location.search).get('orgKey') || '');
  const storageKey = getWizardStorageKey(orgKey);

  try {
    const raw = window.sessionStorage.getItem(storageKey) || window.localStorage.getItem(storageKey);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (_) {
    return null;
  }
}

function saveWizardState(orgKey, payload) {
  if (typeof window === 'undefined') return;
  const storageKey = getWizardStorageKey(orgKey);
  try {
    const serialized = JSON.stringify(payload);
    window.sessionStorage.setItem(storageKey, serialized);
    window.localStorage.setItem(storageKey, serialized);
  } catch (_) {}
}

function normalizeEmployeeFieldKey(value) {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
}

function getEmployeeFieldValue(employee, fieldName) {
  if (!employee || !fieldName) return '';
  const directValue = employee[fieldName];
  if (directValue !== undefined && directValue !== null && String(directValue).trim()) {
    return String(directValue).trim();
  }

  const normalizedField = normalizeEmployeeFieldKey(fieldName);
  const matchedKey = Object.keys(employee).find((key) => normalizeEmployeeFieldKey(key) === normalizedField);
  return matchedKey ? String(employee[matchedKey] || '').trim() : '';
}

function isCatchAllGoalGroup(group) {
  if (!group) return false;
  const attr = String(group.segmentAttr || '').trim();
  const values = (group.segmentValues || []).map(value => String(value || '').trim()).filter(Boolean);
  return !attr || values.length === 0;
}

function employeeMatchesGoalGroup(employee, group) {
  if (!group) return false;
  if (isCatchAllGoalGroup(group)) return true;

  const attr = String(group.segmentAttr || '').trim();
  const employeeValue = getEmployeeFieldValue(employee, attr);
  if (!employeeValue) return false;

  return (group.segmentValues || [])
    .map(value => String(value || '').trim())
    .filter(Boolean)
    .some(value => value.toLowerCase() === employeeValue.toLowerCase());
}

function getGoalGroupMatchForEmployee(employee, config) {
  const groups = config.goalGroups || [];

  const groupNameVal = (employee['Group Name'] || '').trim();
  if (groupNameVal) {
    const namedGroup = groups.find(g => String(g.name || '').trim().toLowerCase() === groupNameVal.toLowerCase());
    if (namedGroup) {
      return {
        group: namedGroup,
        specificMatches: [namedGroup],
        routeAttr: !isCatchAllGoalGroup(namedGroup) ? (namedGroup.segmentAttr || null) : null,
        routeValue: !isCatchAllGoalGroup(namedGroup) && namedGroup.segmentAttr
          ? getEmployeeFieldValue(employee, namedGroup.segmentAttr) : '',
      };
    }

    return {
      group: null,
      specificMatches: [],
      routeAttr: null,
      routeValue: '',
    };
  }

  return {
    group: null,
    specificMatches: [],
    routeAttr: null,
    routeValue: '',
  };
}

function getLibraryKraCount(library) {
  return (library?.perspectives || []).reduce((sum, perspective) => sum + (perspective.kras || []).length, 0);
}

function getAssignedLibraryForGroup(employee, group, config) {
  if (!group || !isGroupLibraryEnabled(group)) {
    return { assignment: null, library: null, kraCount: 0 };
  }

  const assignments = getGroupLibraryAssignments(group);
  const libraries = config.goalLibraries || [];
  const routeValue = group.segmentAttr ? getEmployeeFieldValue(employee, group.segmentAttr) : '';
  const hasTaggedSlots = (group.segmentValues || []).some(value => String(value || '').trim());

  let assignment = null;
  if (hasTaggedSlots && routeValue) {
    assignment = assignments.find(item => String(item.slotKey || '').trim().toLowerCase() === routeValue.toLowerCase()) || null;
  }
  if (!assignment && !hasTaggedSlots && assignments.length === 1) {
    assignment = assignments[0];
  }

  const library = libraries.find(item => item.id === assignment?.libraryId) || null;
  return {
    assignment,
    library,
    kraCount: getLibraryKraCount(library),
  };
}

function getAssignedGoalLibraryForEmployee(employee, config) {
  const goalLibraryData = config.goalLibraryData;
  if (!goalLibraryData) {
    return { groupKey: null, kras: [] };
  }

  if (!goalLibraryData.byAttr) {
    return { groupKey: 'All Employees', kras: goalLibraryData.data || [] };
  }

  const attrLabel = goalLibraryData.attrLabel || config.goalSegmentAttr || 'Department';
  const employeeAttrValue = getEmployeeFieldValue(employee, attrLabel);
  if (!employeeAttrValue) {
    return { groupKey: null, kras: [] };
  }

  const matchedGroupKey = Object.keys(goalLibraryData.data || {}).find(
    (key) => key.trim().toLowerCase() === employeeAttrValue.toLowerCase()
  );

  return matchedGroupKey
    ? { groupKey: matchedGroupKey, kras: goalLibraryData.data[matchedGroupKey] || [] }
    : { groupKey: null, kras: [] };
}

function attachGoalLibraryToEmployees(employeeResult, config) {
  const sourceEmployees = employeeResult.employees || [];
  const totalEmployees = employeeResult.count ?? sourceEmployees.length;
  const goalGroups = config.goalGroups || [];
  const deferredGoalGroupNames = normalizeDeferredGoalGroups(config.deferredGoalGroupNames || []);
  const deferredGoalGroupSet = new Set(deferredGoalGroupNames.map((name) => name.toLowerCase()));

  if (goalGroups.length > 0) {
    const routingColumns = getEmployeeRoutingColumns(config);
    const hasGroupLibraries = goalGroups.some(group => isGroupLibraryEnabled(group));
    const mappingWarnings = [];
    const groupCounts = new Map(
      goalGroups
        .map(group => String(group.name || '').trim())
        .filter(Boolean)
        .map(name => [name.toLowerCase(), 0])
    );

    const employees = sourceEmployees.map((employee, index) => {
      const groupMatch = getGoalGroupMatchForEmployee(employee, config);
      const libraryMatch = getAssignedLibraryForGroup(employee, groupMatch.group, config);

      if (groupMatch.group?.name) {
        const groupKey = String(groupMatch.group.name).trim().toLowerCase();
        groupCounts.set(groupKey, (groupCounts.get(groupKey) || 0) + 1);
      }

      if (!groupMatch.group) {
        mappingWarnings.push({
          row: index + 2,
          code: employee['Employee Code'] || '—',
          field: 'group_match',
          category: 'group_unmatched',
          message: 'Does not match any configured employee group.',
        });
      } else if (isGroupLibraryEnabled(groupMatch.group) && !libraryMatch.library) {
        const valueLabel = groupMatch.routeValue ? ` for ${groupMatch.routeAttr} "${groupMatch.routeValue}"` : '';
        mappingWarnings.push({
          row: index + 2,
          code: employee['Employee Code'] || '—',
          field: 'library_match',
          category: 'library_unmatched',
          message: `Matched group "${groupMatch.group.name}"${valueLabel}, but no goal library is assigned there yet.`,
        });
      }

      return {
        ...employee,
        assignedGoalGroupName: groupMatch.group?.name || null,
        assignedGoalGroupAttr: groupMatch.routeAttr,
        assignedGoalGroupValue: groupMatch.routeValue || null,
        assignedGoalLibraryKey: libraryMatch.library?.name || libraryMatch.assignment?.label || null,
        assignedGoalLibraryName: libraryMatch.library?.name || null,
        assignedGoalLibraryCount: libraryMatch.kraCount,
      };
    });

    const assignedGroupCount = employees.filter(employee => !!employee.assignedGoalGroupName).length;
    const assignedLibraryCount = employees.filter(employee => !!employee.assignedGoalLibraryName).length;
    const missingGoalGroupNames = goalGroups
      .map(group => String(group.name || '').trim())
      .filter(name => name && (groupCounts.get(name.toLowerCase()) || 0) === 0 && !deferredGoalGroupSet.has(name.toLowerCase()));

    if (missingGoalGroupNames.length > 0) {
      mappingWarnings.push({
        row: 'Summary',
        code: 'GROUPS',
        field: 'group_coverage',
        category: 'group_missing',
        message: `No employees were uploaded for ${missingGoalGroupNames.join(', ')}. Defer them for later if this rollout is intentionally partial.`,
      });
    }

    return {
      ...employeeResult,
      employees,
      groupLinked: true,
      libraryLinked: hasGroupLibraries,
      assignedGroupCount,
      unassignedGroupCount: totalEmployees - assignedGroupCount,
      assignedCount: assignedLibraryCount,
      unassignedCount: totalEmployees - assignedLibraryCount,
      goalRoutingColumns: routingColumns.map(column => column.label),
      missingGoalGroupNames,
      deferredGoalGroupNames,
      mappingWarnings,
    };
  }

  if (!config.goalLibraryData) {
    return employeeResult;
  }

  const employees = sourceEmployees.map((employee) => {
    const match = getAssignedGoalLibraryForEmployee(employee, config);
    return {
      ...employee,
      assignedGoalLibraryKey: match.groupKey,
      assignedGoalLibraryCount: match.kras.length,
    };
  });

  const assignedCount = employees.filter((employee) => employee.assignedGoalLibraryCount > 0).length;
  return {
    ...employeeResult,
    employees,
    groupLinked: false,
    libraryLinked: true,
    assignedCount,
    unassignedCount: totalEmployees - assignedCount,
    goalLibraryAttrLabel: config.goalLibraryData.byAttr
      ? (config.goalLibraryData.attrLabel || config.goalSegmentAttr || 'Department')
      : null,
  };
}

function getEmployeeUploadMessage(result) {
  const count = result?.count ?? result?.employees?.length ?? 0;
  const base = `${count} employee${count !== 1 ? 's' : ''} found in the file.`;
  const deferredSuffix = result?.deferredGoalGroupNames?.length
    ? ` Deferred groups: ${result.deferredGoalGroupNames.join(', ')}.`
    : '';

  if (result?.groupLinked && result?.libraryLinked) {
    return `${base} Group mapping: ${result.assignedGroupCount || 0}/${count}. Library mapping: ${result.assignedCount || 0}/${count}.${deferredSuffix}`;
  }

  if (result?.groupLinked) {
    return `${base} Group mapping: ${result.assignedGroupCount || 0}/${count}.${deferredSuffix}`;
  }

  if (!result?.libraryLinked) return `${base}${deferredSuffix}`;
  if (result.assignedCount === count) {
    return `${base} Goal library mapped locally for all employees.${deferredSuffix}`;
  }
  return `${base} Goal library mapped locally for ${result.assignedCount}/${count} employees.${deferredSuffix}`;
}

function isIntentionalOutsideManagerWarning(warning) {
  return warning?.category === 'manager_outside_pms' || warning?.category === 'l2_manager_outside_pms';
}

function getVisibleEmployeeUploadWarnings(result) {
  return [
    ...(result?.validationWarnings || []),
    ...(result?.mappingWarnings || []),
  ].filter((warning) => !isIntentionalOutsideManagerWarning(warning));
}

function isGoalLibraryValid(config) {
  if (!config.goalLibraryData) return false;
  return validateGoalLibraryData(config.goalLibraryData, config).length === 0;
}

/* ─── NEW GOAL GROUPS VALIDATION ─────────────────────────────────────────── */

function isGoalGroupsValid(config) {
  const groups = config.goalGroups;
  if (!groups || groups.length === 0) return false;
  // Each group must have at least one of prefill or edit-own enabled
  if (!groups.every(g => g.prefillType || g.canEditOwn !== false)) return false;
  return true;
}

function getGoalGroupsSnapshot(config) {
  return JSON.stringify({
    strategy: config.goalGroupStrategy || 'uniform',
    groupAttr: config.goalGroupAttr || 'Department',
    groups: (config.goalGroups || []).map(g => ({
      id: g.id,
      name: g.name,
      segmentValues: [...(g.segmentValues || [])].sort(),
      modes: [...(g.modes || [])].sort(),
      prefillEditability: g.modes?.includes('prefill') ? (g.prefillEditability || 'add-kpis') : null,
      goalLimitsEnabled: !!g.goalLimitsEnabled,
      goalMin: g.goalLimitsEnabled ? (g.goalMin || 3) : null,
      goalMax: g.goalLimitsEnabled ? (g.goalMax || 8) : null,
      kraWeightsEnabled: g.kraWeightsEnabled !== false,
      kpiWeightsEnabled: !!g.kpiWeightsEnabled,
    })),
  });
}

function getNewGroupsSnapshot(config) {
  return JSON.stringify({
    groups: (config.goalGroups || []).map(g => ({
      id: g.id,
      name: g.name,
      segmentAttr: g.segmentAttr || null,
      segmentValues: [...(g.segmentValues || [])].sort(),
      canEditOwn: g.canEditOwn !== false,
      prefillType: g.prefillType || null,
      hasLibrary: !!g.hasLibrary,
      libraryType: g.hasLibrary ? (g.libraryType || 'kra-only') : null,
    })),
  });
}

function canUseGroupLibrary(group) {
  // Library is always available regardless of prefill/edit settings
  return !!group;
}

function isGroupLibraryEnabled(group) {
  return !!group?.hasLibrary;
}

function normalizeSimpleGoalGroup(group) {
  return group;
}

function groupsNeedingDataUpload(config) {
  return (config.goalGroups || []).filter(g =>
    g.modes?.includes('prefill') || g.modes?.includes('library')
  );
}

function groupsNeedingPrefillData(config) {
  return (config.goalGroups || []).filter(group => !!group.prefillType);
}

function groupsNeedingLibraryData(config) {
  return (config.goalGroups || []).filter(group => !!group.hasLibrary);
}

function isGoalGroupDataValid(config) {
  const needsData = groupsNeedingDataUpload(config);
  if (needsData.length === 0) return true;
  return needsData.every(g => {
    if (g.modes?.includes('prefill') && !getGroupPrefillAssignments(g).every(assignment => Array.isArray(assignment.data) && assignment.data.length > 0)) return false;
    if (g.modes?.includes('library') && (!g.libraryData || g.libraryData.length === 0)) return false;
    return true;
  });
}

function isPrefillDataValid(config) {
  const groups = groupsNeedingPrefillData(config);
  if (groups.length === 0) return true;
  return groups.every(group => getGroupPrefillAssignments(group).every(assignment => Array.isArray(assignment.data) && assignment.data.length > 0));
}

function getFrameworkSnapshot(config) {
  return JSON.stringify({ frameworkId: config.frameworkId || null });
}

function getPerspectivesSnapshotFromList(perspectives = []) {
  return JSON.stringify(
    perspectives
      .filter((perspective) => !isPerspectiveRowEmpty(perspective))
      .map((perspective) => ({
        name: sanitizeGoalName(getPerspectiveDisplayName(perspective)),
        weight: String(perspective.weight ?? '').trim(),
        color: perspective.color || '',
      }))
  );
}

function getPerspectivesSnapshot(config) {
  return getPerspectivesSnapshotFromList(config.perspectives || []);
}

function getNormalizedNamedValues(values = []) {
  return values
    .map((value) => sanitizeGoalName(value?.name))
    .filter(Boolean);
}

function areNormalizedValuesUnique(values = []) {
  return new Set(values.map((value) => value.toLowerCase())).size === values.length;
}

function isGoalSettingsValid(config) {
  if (!config.goalCreationMode) return false;

  if (config.goalCreationMode === 'admin-library') {
    if (!config.goalLibraryScope) return false;
    if (config.goalLibraryScope === 'by-attribute') {
      const segmentValues = getNormalizedNamedValues(config.goalSegmentValues || []);
      if (segmentValues.length === 0 || !areNormalizedValuesUnique(segmentValues)) return false;
    }
    return !!config.goalKpiMode && !!config.goalEmployeeEdit;
  }

  if (config.goalLimitEnabled == null) return false;
  if (config.goalLimitEnabled === false) return true;
  if (!config.goalLimitScope) return false;
  if (config.goalLimitScope === 'common') {
    return Number(config.goalLimitMin) > 0 && Number(config.goalLimitMax) >= Number(config.goalLimitMin);
  }
  const limitValues = (config.goalLimitValues || [])
    .map((value) => ({
      name: sanitizeGoalName(value?.name),
      min: Number(value?.min),
      max: Number(value?.max),
    }))
    .filter((value) => value.name);
  return (
    limitValues.length > 0 &&
    areNormalizedValuesUnique(limitValues.map((value) => value.name)) &&
    limitValues.every((value) => value.min > 0 && value.max >= value.min)
  );
}

function getGoalsSnapshot(config) {
  if (config.goalCreationMode === 'admin-library') {
    return JSON.stringify({
      goalCreationMode: config.goalCreationMode || null,
      goalLibraryScope: config.goalLibraryScope || null,
      goalSegmentAttr: config.goalLibraryScope === 'by-attribute' ? (config.goalSegmentAttr || 'Department') : null,
      goalSegmentValues: config.goalLibraryScope === 'by-attribute'
        ? getNormalizedNamedValues(config.goalSegmentValues || [])
        : [],
      goalKpiMode: config.goalKpiMode || null,
      goalEmployeeEdit: config.goalEmployeeEdit || null,
    });
  }

  return JSON.stringify({
    goalCreationMode: config.goalCreationMode || null,
    goalLimitEnabled: config.goalLimitEnabled === true,
    goalLimitScope: config.goalLimitEnabled ? (config.goalLimitScope || null) : null,
    goalLimitAttr: config.goalLimitEnabled && config.goalLimitScope === 'by-attribute'
      ? (config.goalLimitAttr || 'Department')
      : null,
    goalLimitMin: config.goalLimitEnabled && config.goalLimitScope === 'common' ? Number(config.goalLimitMin) : null,
    goalLimitMax: config.goalLimitEnabled && config.goalLimitScope === 'common' ? Number(config.goalLimitMax) : null,
    goalLimitValues: config.goalLimitEnabled && config.goalLimitScope === 'by-attribute'
      ? (config.goalLimitValues || [])
          .map((value) => ({
            name: sanitizeGoalName(value?.name),
            min: Number(value?.min),
            max: Number(value?.max),
          }))
          .filter((value) => value.name)
          .sort((a, b) => a.name.localeCompare(b.name))
      : [],
  });
}

function getGoalLibraryDataSnapshot(goalLibraryData) {
  if (!goalLibraryData) return null;

  const normalizeKpi = (kpi) => ({
    name: sanitizeGoalName(kpi?.name),
    weight: String(kpi?.weight ?? '').trim(),
  });
  const normalizeKra = (kra) => ({
    name: sanitizeGoalName(kra?.name),
    weight: String(kra?.weight ?? '').trim(),
    perspName: sanitizeGoalName(kra?.perspName),
    kpis: (kra?.kpis || []).map(normalizeKpi),
  });

  if (!goalLibraryData.byAttr) {
    return JSON.stringify({
      byAttr: false,
      attrLabel: null,
      data: (goalLibraryData.data || []).map(normalizeKra),
    });
  }

  return JSON.stringify({
    byAttr: true,
    attrLabel: goalLibraryData.attrLabel || null,
    data: Object.entries(goalLibraryData.data || {})
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([group, kras]) => [group, (kras || []).map(normalizeKra)]),
  });
}

function isEmployeeSettingsValid(config) {
  return config.managerLevels === 1 || config.managerLevels === 2;
}

function getEmployeeSettingsSnapshot(config) {
  return JSON.stringify({
    managerLevels: config.managerLevels,
    requireEmail: config.requireEmail !== false,
  });
}

function StepStatusBar({ applied, valid = true, appliedMessage, pendingMessage, invalidMessage, buttonLabel, onApply }) {
  const background = applied ? '#F0FDF4' : valid ? '#EFF6FF' : '#FFF7ED';
  const border = applied ? '#86EFAC' : valid ? '#BFDBFE' : '#FED7AA';
  const text = applied ? '#15803D' : valid ? '#1E40AF' : '#92400E';

  return (
    <div style={{ marginTop: 18, padding: '14px 16px', borderRadius: 10, background, border: `1.5px solid ${border}`, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16 }}>
      <div style={{ fontSize: 13, color: text }}>
        {applied ? appliedMessage : valid ? pendingMessage : invalidMessage}
      </div>
      {!applied && onApply ? (
        <button
          type="button"
          disabled={!valid}
          onClick={onApply}
          style={{
            padding: '9px 20px',
            border: 'none',
            borderRadius: 8,
            fontSize: 13,
            fontWeight: 600,
            flexShrink: 0,
            cursor: !valid ? 'not-allowed' : 'pointer',
            background: !valid ? '#CBD5E1' : '#2563EB',
            color: '#fff',
            fontFamily: 'inherit',
          }}
        >
          {buttonLabel}
        </button>
      ) : null}
    </div>
  );
}

function sanitizeGoalName(value) {
  return String(value || '').trim().replace(/\s+/g, ' ');
}

function sanitizeWeightInput(value) {
  const nextValue = String(value ?? '').replace(/[^\d.]/g, '');
  const firstDot = nextValue.indexOf('.');
  if (firstDot === -1) return nextValue;
  return `${nextValue.slice(0, firstDot + 1)}${nextValue.slice(firstDot + 1).replace(/\./g, '')}`;
}

function isNonNegativeNumeric(value) {
  return /^\d+(\.\d+)?$/.test(String(value ?? '').trim());
}

function toNonNegativeWeight(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : 0;
}

function normalizeGoalLibraryRecord(library) {
  if (!library || typeof library !== 'object') return library;
  return {
    ...library,
    perspectives: Array.isArray(library.perspectives)
      ? library.perspectives.map((perspective) => ({
          ...perspective,
          weight: toNonNegativeWeight(perspective.weight),
          kras: Array.isArray(perspective.kras)
            ? perspective.kras.map((kra) => ({
                ...kra,
                suggestedWeight: toNonNegativeWeight(kra.suggestedWeight ?? kra.weight),
                kpis: Array.isArray(kra.kpis)
                  ? kra.kpis.map((kpi) => ({
                      ...kpi,
                      weight: toNonNegativeWeight(kpi.weight),
                    }))
                  : [],
              }))
            : [],
        }))
      : [],
  };
}

function normalizeGoalLibraries(libraries) {
  return Array.isArray(libraries) ? libraries.map(normalizeGoalLibraryRecord) : [];
}

function buildManualGoalLibraryData(krasBySegment, segments, perspectives, scope, attrLabel) {
  const mapPerspectiveName = (perspId) => perspectives.find((perspective) => String(perspective.id) === String(perspId))?.name || '';
  const normalizeKpi = (kpi) => ({
    ...kpi,
    name: sanitizeGoalName(kpi.name),
    weight: String(kpi.weight ?? '').trim(),
  });
  const normalizeKra = (kra) => ({
    ...kra,
    name: sanitizeGoalName(kra.name),
    weight: String(kra.weight ?? '').trim(),
    perspName: mapPerspectiveName(kra.perspId),
    kpis: (kra.kpis || []).map(normalizeKpi),
  });

  if (scope === 'by-attribute') {
    const data = {};
    segments.forEach((segment) => {
      data[segment.name] = (krasBySegment[segment.id] || []).map(normalizeKra);
    });
    return { byAttr: true, attrLabel, data };
  }

  return {
    byAttr: false,
    data: (krasBySegment.common || []).map(normalizeKra),
  };
}

function exitToLogin() {
  try {
    window.localStorage.removeItem(SESSION_KEY);
    window.sessionStorage.removeItem(SESSION_KEY);
  } catch (_) {}

  try {
    if (window.parent && window.parent !== window && typeof window.parent.logout === 'function') {
      window.parent.logout();
      return;
    }
  } catch (_) {}

  window.location.href = '/';
}

function normalizeDeferredGoalGroups(groupNames = []) {
  const seen = new Set();
  return (groupNames || [])
    .map((name) => String(name || '').trim())
    .filter((name) => {
      if (!name) return false;
      const key = name.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

/* ─── TOGGLE ─────────────────────────────────────────────────────────────── */
function Toggle({ on, onChange, disabled = false }) {
  return (
    <button
      type="button"
      onClick={() => !disabled && onChange(!on)}
      aria-pressed={on}
      disabled={disabled}
      style={{
        width: 36, height: 20, borderRadius: 10, border: 'none',
        background: on ? '#16A34A' : '#CBD5E1', position: 'relative', flexShrink: 0,
        transition: 'background .2s',
        opacity: disabled ? 0.7 : 1,
        cursor: disabled ? 'not-allowed' : 'pointer',
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

function FrameworkProcessGraphic({ framework }) {
  const stageMeta = {
    Perspectives: {
      icon: '◔',
      title: 'Strategic lenses',
      copy: 'Split performance into business perspectives so goals roll up to strategy.',
    },
    KRAs: {
      icon: '▣',
      title: 'Outcome areas',
      copy: 'Define the key result areas for the role.',
    },
    KPIs: {
      icon: '◫',
      title: 'Measure points',
      copy: 'Add measurable indicators under each KRA.',
    },
    Targets: {
      icon: '◎',
      title: 'Success thresholds',
      copy: 'Set expected numbers or milestone targets.',
    },
    Rating: {
      icon: '★',
      title: 'Final evaluation',
      copy: 'Roll up achievement into the final score.',
    },
    Weightage: {
      icon: '◌',
      title: 'Weight split',
      copy: 'Distribute contribution across KRAs before direct assessment.',
    },
    'Direct Rating': {
      icon: '✦',
      title: 'Manager scoring',
      copy: 'Rate KRAs directly without KPI-level scoring.',
    },
    'Custom Mix': {
      icon: '◇',
      title: 'Custom structure',
      copy: 'Choose the layers that fit your appraisal design.',
    },
    'Configure Each Layer': {
      icon: '⬢',
      title: 'Layer setup',
      copy: 'Tune visibility, depth, scoring, and ownership per layer.',
    },
  };

  return (
    <div className="framework-process-graphic">
      <div className="framework-process-grid">
        {framework.flow.map((stage, index) => {
          const meta = stageMeta[stage] || {
            icon: '•',
            title: stage,
            copy: 'Configured as part of the selected framework.',
          };
          return (
            <div
              key={stage}
              className="framework-stage-card"
              style={{ '--stage-color': framework.color, '--stage-delay': `${index * 90}ms` }}
            >
              <div className="framework-stage-top">
                <div className="framework-stage-index">0{index + 1}</div>
                <div className="framework-stage-icon">{meta.icon}</div>
              </div>
              <div className="framework-stage-name">{stage}</div>
              <div className="framework-stage-title">{meta.title}</div>
              <p className="framework-stage-copy">{meta.copy}</p>
              {index < framework.flow.length - 1 ? (
                <div className="framework-stage-connector" aria-hidden="true">
                  <span className="framework-stage-connector-line" />
                  <span className="framework-stage-connector-dot" />
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
      <div className="framework-process-footer">
        <span className="framework-process-badge">
          {framework.id === 'bsc'
            ? 'Strategy to score'
            : 'Framework flow'}
        </span>
      </div>
    </div>
  );
}

/* ─── TOG ROW ────────────────────────────────────────────────────────────── */
function TogRow({ label, desc, on, onChange, last, disabled = false }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 0', borderBottom: last ? 'none' : '1px solid #F1F3F5', gap: 16 }}>
      <div>
        <div style={{ fontSize: 13, fontWeight: 500, color: '#0D1117' }}>{label}</div>
        {desc && <div style={{ fontSize: 11.5, color: '#9CA3AF', marginTop: 2 }}>{desc}</div>}
      </div>
      <Toggle on={on} onChange={onChange} disabled={disabled} />
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
   STEP PANELS
══════════════════════════════════════════════════════════════════════════ */

/* ── STEP 1: FRAMEWORK ─────────────────────────────────────────────────── */
function StepFramework({ config, update }) {
  const selected = FRAMEWORKS.find(f => f.id === config.frameworkId) || FRAMEWORKS[0];
  const modulePreview = MODULES_LIST.map((module) => ({
    ...module,
    ...getFrameworkModuleState(config.frameworkId, module.id),
  }));
  const frameworkApplied = config.frameworkAppliedSnapshot === getFrameworkSnapshot(config);
  return (
    <div>
      <SectionHead title="Choose your performance framework" sub="Select the structure that defines how employee performance is measured. This shapes everything — what gets set, how it's weighted, and how ratings are computed." />
      <Banner type="blue">
        <span>ℹ️</span>
        <span>Your industry and org structure determines the best fit. BSC is common in BFSI and manufacturing; KRA-KPI in IT/software; KRA-only suits leaner qualitative cycles.</span>
      </Banner>
      <Card>
        <CardHead title="Framework model" badge="Choose one" />
        <CardBody>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 12, marginBottom: 16 }}>
            {FRAMEWORKS.map(fw => (
              <button
                type="button"
                key={fw.id}
                onClick={() => update('frameworkId', fw.id)}
                style={{
                  textAlign: 'left',
                  width: '100%',
                  border: `2px solid ${config.frameworkId === fw.id ? fw.color : '#E9EDF2'}`,
                  borderRadius: 10, padding: '13px 14px', cursor: 'pointer',
                  background: config.frameworkId === fw.id ? fw.color + '12' : '#fff',
                  boxShadow: config.frameworkId === fw.id ? `0 0 0 1px ${fw.color}20` : 'none',
                  transition: 'all .16s',
                  appearance: 'none',
                }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: '#0D1117', marginBottom: 4 }}>{fw.name}</div>
                <div style={{ fontSize: 11.5, color: '#6B7280', lineHeight: 1.45, marginBottom: 8 }}>{fw.desc}</div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                  {fw.tags.map(t => <span key={t} style={{ fontSize: 9.5, padding: '1px 7px', borderRadius: 20, background: fw.color + '18', color: fw.color, fontWeight: 600 }}>{t}</span>)}
                </div>
              </button>
            ))}
          </div>
          {/* Flow viz */}
          <FrameworkProcessGraphic framework={selected} />
          {false && <div style={{ borderTop: '1px solid #F1F3F5', paddingTop: 16 }}>
            <div style={{ fontSize: 12.5, fontWeight: 600, color: '#374151', marginBottom: 12 }}>Framework-driven modules</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 16 }}>
              {modulePreview.map((module) => {
                const isEnabled = module.forcedOn || config.enabledModules.includes(module.id);
                const isGreyed = module.forcedOff;
                return (
                  <span
                    key={module.id}
                    style={{
                      padding: '5px 10px',
                      borderRadius: 999,
                      border: `1px solid ${isGreyed ? '#E5E7EB' : isEnabled ? selected.color + '33' : '#D1D5DB'}`,
                      background: isGreyed ? '#F3F4F6' : isEnabled ? selected.color + '12' : '#fff',
                      color: isGreyed ? '#9CA3AF' : isEnabled ? selected.color : '#6B7280',
                      fontSize: 11.5,
                      fontWeight: 600,
                    }}
                  >
                    {module.label}
                    {module.forcedOn ? ' · required' : module.forcedOff ? ' · unused' : ''}
                  </span>
                );
              })}
            </div>
            <div style={{ fontSize: 12.5, fontWeight: 600, color: '#374151', marginBottom: 4 }}>Employee identifier — how are employees grouped for goal assignment?</div>
            <div style={{ fontSize: 12, color: '#6B7280', marginBottom: 12, lineHeight: 1.5 }}>
              The primary identifier segments your goal library — e.g. each <strong>Department</strong> gets its own KRA set. Secondary adds a second dimension (e.g. Department + Grade).
            </div>
            <Grid2>
              <Field label="Primary identifier" hint="Main dimension for KRA library segmentation">
                <select style={selectStyle} value={config.primaryId} onChange={e => update('primaryId', e.target.value)}>
                  {PRIMARY_ID_OPTIONS.map(o => <option key={o}>{o}</option>)}
                </select>
              </Field>
              <Field
                label="Secondary identifier (optional)"
                hint={config.secondaryId !== 'None' ? `Goals will be matched by ${config.primaryId} + ${config.secondaryId}` : 'Leave as None to use primary only'}
              >
                <select style={selectStyle} value={config.secondaryId} onChange={e => update('secondaryId', e.target.value)}>
                  {['None', ...PRIMARY_ID_OPTIONS.filter(o => o !== config.primaryId)].map(o => <option key={o}>{o}</option>)}
                </select>
              </Field>
            </Grid2>
            <div style={{ fontSize: 12.5, fontWeight: 600, color: '#374151', marginBottom: 10, marginTop: 6 }}>KRA assignment mode — who builds the employee's goal sheet?</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              {KRA_ASSIGNMENT_MODES.map(mode => {
                const isSelected = config.kraMode === mode.id;
                return (
                  <button key={mode.id} type="button" onClick={() => update('kraMode', mode.id)}
                    style={{
                      textAlign: 'left', border: `2px solid ${isSelected ? '#2563EB' : '#E9EDF2'}`,
                      borderRadius: 10, padding: '12px 14px', cursor: 'pointer',
                      background: isSelected ? '#EFF4FF' : '#F8FAFC', transition: 'all .16s', appearance: 'none',
                      position: 'relative',
                    }}>
                    {isSelected && <div style={{ position: 'absolute', top: 8, right: 8, width: 16, height: 16, borderRadius: '50%', background: '#2563EB', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontSize: 8, fontWeight: 700 }}>✓</div>}
                    <div style={{ fontSize: 16, marginBottom: 6 }}>{mode.icon}</div>
                    <div style={{ fontSize: 12.5, fontWeight: 600, color: '#0D1117', marginBottom: 3 }}>{mode.title}</div>
                    <div style={{ fontSize: 11.5, color: '#6B7280', lineHeight: 1.5 }}>{mode.desc}</div>
                  </button>
                );
              })}
            </div>
            {(() => {
              const mode = KRA_ASSIGNMENT_MODES.find(m => m.id === config.kraMode);
              if (!mode) return null;
              return (
                <div style={{ marginTop: 12, padding: '12px 14px', background: '#F8FAFC', borderRadius: 9, border: '1px solid #E2E8F0' }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: '#6B7280', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.06em' }}>How this shapes the rest of your setup</div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10 }}>
                    {[
                      { label: 'Goal library', value: mode.impact.goalLibrary },
                      { label: 'Pre-fill depth', value: mode.impact.preFill },
                      { label: 'Employee control', value: mode.impact.employeeControl },
                    ].map(item => (
                      <div key={item.label} style={{ padding: '8px 10px', background: '#fff', borderRadius: 7, border: '1px solid #E9EDF2' }}>
                        <div style={{ fontSize: 10, fontWeight: 700, color: '#9CA3AF', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 3 }}>{item.label}</div>
                        <div style={{ fontSize: 12, color: '#374151', fontWeight: 500 }}>{item.value}</div>
                      </div>
                    ))}
                  </div>
                  <div style={{ marginTop: 8, fontSize: 11.5, color: '#6B7280' }}>
                    These defaults are pre-applied to the <strong>Goal Library</strong> and <strong>Limits & Rules</strong> steps — you can still adjust them there.
                  </div>
                </div>
              );
            })()}
          </div>}
        </CardBody>
      </Card>
      <StepStatusBar
        applied={frameworkApplied}
        appliedMessage="Framework applied — make changes above to reconfigure."
        pendingMessage="Review the selected framework above, then apply changes to continue."
        buttonLabel="Apply framework"
        onApply={() => update('frameworkAppliedSnapshot', getFrameworkSnapshot(config))}
      />
    </div>
  );
}

/* ── BSC PERSPECTIVES (dynamic step — BSC only) ─────────────────────── */
// Same safe palette used elsewhere — excludes red / orange / green so perspective stripes
// never collide with status semantics (rejected / pending / approved).
const PERSPECTIVE_COLORS = ['#2563EB', '#0891B2', '#4F46E5', '#7C3AED', '#DB2777', '#0EA5E9', '#6366F1'];
const PERSPECTIVE_NAME_OPTIONS = [
  'Financial',
  'Customer',
  'Internal Process',
  'Learning & Growth',
  'People',
  'Innovation',
  'Risk / Compliance',
  'Sustainability / ESG',
  'Operational Excellence',
  'Digital Transformation',
  'Stakeholder / Community',
];

function getPerspectiveNameMode(perspective) {
  if (perspective.nameOption === 'custom') return 'custom';
  if (perspective.nameOption && PERSPECTIVE_NAME_OPTIONS.includes(perspective.nameOption)) return perspective.nameOption;
  if (PERSPECTIVE_NAME_OPTIONS.includes(perspective.name)) return perspective.name;
  return 'custom';
}

function getPerspectiveDisplayName(perspective) {
  const mode = getPerspectiveNameMode(perspective);
  return mode === 'custom' ? (perspective.customName ?? perspective.name ?? '') : mode;
}

function normalizePerspectiveName(name) {
  return String(name || '').trim().toLowerCase();
}

function isPerspectiveRowComplete(perspective) {
  return getPerspectiveDisplayName(perspective).trim() !== '' && perspective.weight !== '' && !Number.isNaN(Number(perspective.weight));
}

function isPerspectiveRowEmpty(perspective) {
  return getPerspectiveDisplayName(perspective).trim() === '' && (perspective.weight === '' || Number(perspective.weight) === 0);
}

function StepPerspectives({ config, update }) {
  const [reviewOpen, setReviewOpen] = useState(false);
  const [reviewMessage, setReviewMessage] = useState('');
  const [cleanupMessage, setCleanupMessage] = useState('');
  const isLocked = !!config.perspectivesConfirmed;
  const deletedPerspective = config.lastDeletedPerspective;
  const activePerspectives = (config.perspectives || []).filter((perspective) => !isPerspectiveRowEmpty(perspective));
  const incompletePerspective = activePerspectives.find((perspective) => !isPerspectiveRowComplete(perspective));
  const total = activePerspectives.reduce((s, p) => s + (Number(p.weight) || 0), 0);
  const isValid = activePerspectives.length > 0 && total === 100 && !incompletePerspective;
  const perspectivesApplied = isValid && config.perspectivesAppliedSnapshot === getPerspectivesSnapshot(config);
  const canAddPerspective = !isLocked && !incompletePerspective;

  function updatePerspective(index, field, value) {
    setReviewOpen(false);
    setReviewMessage('');
    setCleanupMessage('');
    update('perspectives', (config.perspectives || []).map((x, j) => {
      if (j !== index) return x;
      const next = { ...x, [field]: value };
      if (field === 'nameOption') {
        if (value === 'custom') {
          next.name = next.customName || '';
        } else {
          next.name = value;
          next.customName = '';
        }
      }
      if (field === 'customName') {
        next.name = value;
      }
      return next;
    }));
  }

  function isOptionTakenByOtherSelectedPerspective(index, option) {
    const normalizedOption = normalizePerspectiveName(option);
    return (config.perspectives || []).some((perspective, perspectiveIndex) => (
      perspectiveIndex !== index &&
      normalizePerspectiveName(getPerspectiveDisplayName(perspective)) === normalizedOption
    ));
  }

  function deletePerspective(index) {
    if (config.perspectives.length <= 1 || isLocked) return;
    const removed = config.perspectives[index];
    setReviewOpen(false);
    setReviewMessage('');
    setCleanupMessage('');
    update('lastDeletedPerspective', { perspective: removed, index });
    update('perspectives', config.perspectives.filter((_, j) => j !== index));
  }

  function addPerspective() {
    if (!canAddPerspective) return;
    const restored = deletedPerspective?.perspective;
    const nextPerspective = restored
      ? { ...restored, id: Date.now() }
      : {
          id: Date.now(),
          name: '',
          nameOption: 'custom',
          customName: '',
          weight: '',
          color: PERSPECTIVE_COLORS[config.perspectives.length % PERSPECTIVE_COLORS.length],
          objective: '',
        };
    setReviewOpen(false);
    setReviewMessage('');
    setCleanupMessage('');
    update('perspectives', [...config.perspectives, nextPerspective]);
    if (restored) update('lastDeletedPerspective', null);
  }

  function undoDelete() {
    if (!deletedPerspective || isLocked) return;
    const next = [...config.perspectives];
    next.splice(Math.min(deletedPerspective.index, next.length), 0, deletedPerspective.perspective);
    setReviewOpen(false);
    setReviewMessage('');
    setCleanupMessage('');
    update('perspectives', next);
    update('lastDeletedPerspective', null);
  }

  function confirmStructure() {
    if (isLocked) return;
    const cleanedPerspectives = config.perspectives.filter((perspective) => !isPerspectiveRowEmpty(perspective));
    const removedCount = config.perspectives.length - cleanedPerspectives.length;
    const cleanedActive = cleanedPerspectives.filter((perspective) => !isPerspectiveRowEmpty(perspective));
    const hasIncomplete = cleanedActive.some((perspective) => !isPerspectiveRowComplete(perspective));
    const cleanedTotal = cleanedActive.reduce((sum, perspective) => sum + (Number(perspective.weight) || 0), 0);
    const selectedNameSet = new Set();
    const hasDuplicateSelectedNames = cleanedActive.some((perspective) => {
      const normalized = normalizePerspectiveName(getPerspectiveDisplayName(perspective));
      if (selectedNameSet.has(normalized)) return true;
      selectedNameSet.add(normalized);
      return false;
    });

    if (removedCount > 0) {
      update('perspectives', cleanedPerspectives);
      setCleanupMessage(`${removedCount} empty perspective ${removedCount === 1 ? 'draft was' : 'drafts were'} removed from the final set.`);
    } else {
      setCleanupMessage('');
    }

    if (!cleanedActive.length) {
      setReviewOpen(false);
      setReviewMessage('Add at least one perspective before continuing.');
      return;
    }
    if (hasIncomplete) {
      setReviewOpen(false);
      setReviewMessage('Complete the unfinished perspective row before continuing.');
      return;
    }
    if (cleanedTotal !== 100) {
      setReviewOpen(false);
      setReviewMessage('The final perspective set must total exactly 100% before it can be fixed.');
      return;
    }
    if (hasDuplicateSelectedNames) {
      setReviewOpen(false);
      setReviewMessage('The final perspective set cannot contain the same perspective more than once.');
      return;
    }

    setReviewMessage('');
    setReviewOpen(true);
  }

  function finalizeStructure() {
    const finalPerspectives = config.perspectives
      .filter((perspective) => !isPerspectiveRowEmpty(perspective))
      .map((perspective) => ({ ...perspective }));
    if (!finalPerspectives.length) return;
    update('perspectives', finalPerspectives);
    update('perspectivesConfirmed', true);
    update('perspectivesAppliedSnapshot', getPerspectivesSnapshotFromList(finalPerspectives));
    update('lastDeletedPerspective', null);
    setReviewOpen(false);
    setReviewMessage('');
  }

  function unlockStructure() {
    setReviewOpen(false);
    setReviewMessage('');
    update('perspectivesConfirmed', false);
  }

  return (
    <div>
      <SectionHead
        title="BSC Perspectives"
        sub="The Balanced Scorecard organises KRAs into strategic perspectives. The classic 4 are pre-loaded — rename, reweight, or add your own. Total must equal 100%."
      />
      <Banner type="blue">
        <span>💡</span>
        <span>Most organisations use the 4 classic perspectives. You can rename them to match your language — e.g. <strong>"People & Culture"</strong> instead of "Learning & Growth".</span>
      </Banner>
      <Card>
        <CardHead
          title="Perspectives"
          badge={isLocked ? 'Confirmed' : isValid ? 'Ready to confirm' : `Total: ${total}% — must be 100%`}
        />
        <CardBody>
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 14 }}>
            <div style={{ fontSize: 13.5, fontWeight: 700, color: isValid ? '#16A34A' : '#DC2626', display: 'flex', alignItems: 'center', gap: 6 }}>
              <div style={{ width: 10, height: 10, borderRadius: '50%', background: isValid ? '#16A34A' : '#DC2626' }} />
              Final set total: {total}% {isValid ? '— ready' : '— must equal 100%'}
            </div>
          </div>
          {isLocked ? (
            <div style={{ marginBottom: 14, padding: '10px 12px', borderRadius: 9, background: '#F0FDF4', border: '1px solid #BBF7D0', fontSize: 12.5, color: '#166534', lineHeight: 1.55 }}>
              Editing is locked. Unlock only if you intentionally want to change the BSC master structure and review downstream setup again.
            </div>
          ) : null}
          {cleanupMessage ? (
            <div style={{ marginBottom: 14, padding: '10px 12px', borderRadius: 9, background: '#EFF6FF', border: '1px solid #BFDBFE', fontSize: 12.5, color: '#1D4ED8', lineHeight: 1.55 }}>
              {cleanupMessage}
            </div>
          ) : null}
          {reviewMessage ? (
            <div style={{ marginBottom: 14, padding: '10px 12px', borderRadius: 9, background: '#FEF2F2', border: '1px solid #FECACA', fontSize: 12.5, color: '#B91C1C', lineHeight: 1.55 }}>
              {reviewMessage}
            </div>
          ) : null}
          {!isLocked && incompletePerspective ? (
            <div style={{ marginBottom: 14, padding: '10px 12px', borderRadius: 9, background: '#FFF7ED', border: '1px solid #FED7AA', fontSize: 12.5, color: '#9A3412', lineHeight: 1.55 }}>
              Complete the current perspective first, then add another one. This step only allows one unfinished perspective at a time to prevent dummy entries in the final master.
            </div>
          ) : null}
          <div style={{ display: 'grid', gridTemplateColumns: '14px 1fr 90px 28px', gap: '8px 12px', alignItems: 'center', marginBottom: 8 }}>
            <div />
            <div style={{ fontSize: 10.5, fontWeight: 700, color: '#9CA3AF', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Perspective name</div>
            <div style={{ fontSize: 10.5, fontWeight: 700, color: '#9CA3AF', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Weight</div>
            <div />
          </div>
          {(config.perspectives || []).map((p, i) => (
            <div key={p.id} style={{ display: 'grid', gridTemplateColumns: '14px 1fr 90px 28px', gap: '8px 12px', alignItems: 'center', padding: '10px 0', borderBottom: i < (config.perspectives || []).length - 1 ? '1px solid #F1F3F5' : 'none' }}>
              <div style={{ width: 14, height: 14, borderRadius: '50%', background: p.color || PERSPECTIVE_COLORS[i % PERSPECTIVE_COLORS.length], flexShrink: 0 }} />
              <div style={{ display: 'grid', gap: 8 }}>
                <select
                  style={{ ...selectStyle, background: isLocked ? '#F8FAFC' : '#fff', color: isLocked ? '#64748B' : '#0D1117' }}
                  value={getPerspectiveNameMode(p)}
                  onChange={e => updatePerspective(i, 'nameOption', e.target.value)}
                  disabled={isLocked}
                >
                  <option value="">Select perspective</option>
                  {PERSPECTIVE_NAME_OPTIONS.map((option) => (
                    <option
                      key={option}
                      value={option}
                      disabled={getPerspectiveNameMode(p) !== option && isOptionTakenByOtherSelectedPerspective(i, option)}
                    >
                      {option}{getPerspectiveNameMode(p) !== option && isOptionTakenByOtherSelectedPerspective(i, option) ? ' (already used)' : ''}
                    </option>
                  ))}
                  <option value="custom">Custom...</option>
                </select>
                {getPerspectiveNameMode(p) === 'custom' ? (
                  <input
                    style={{ ...inputStyle, background: isLocked ? '#F8FAFC' : '#fff', color: isLocked ? '#64748B' : '#0D1117' }}
                    placeholder="Enter custom perspective name"
                    value={p.customName ?? p.name ?? ''}
                    onChange={e => updatePerspective(i, 'customName', e.target.value)}
                    disabled={isLocked}
                  />
                ) : null}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                <input
                  style={{ ...inputStyle, width: 58, background: isLocked ? '#F8FAFC' : '#fff', color: isLocked ? '#64748B' : '#0D1117' }}
                  type="number" min="0" max="100" placeholder="%"
                  value={p.weight}
                  onChange={e => updatePerspective(i, 'weight', e.target.value)}
                  disabled={isLocked}
                />
                <span style={{ fontSize: 12, color: '#9CA3AF', flexShrink: 0 }}>%</span>
              </div>
              {(config.perspectives || []).length > 1 ? (
                <button
                  onClick={() => deletePerspective(i)}
                  disabled={isLocked}
                  style={{ background: 'none', border: 'none', cursor: isLocked ? 'not-allowed' : 'pointer', color: isLocked ? '#CBD5E1' : '#DC2626', fontSize: 15, padding: 0, lineHeight: 1 }}>
                  ✕
                </button>
              ) : <div />}
            </div>
          ))}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 16, paddingTop: 14, borderTop: '1px solid #F1F3F5' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <button
                onClick={addPerspective}
                disabled={!canAddPerspective}
                style={{ fontSize: 13, color: !canAddPerspective ? '#94A3B8' : '#2563EB', background: 'none', border: `1.5px dashed ${!canAddPerspective ? '#CBD5E1' : '#BFCFFE'}`, borderRadius: 8, padding: '7px 14px', cursor: !canAddPerspective ? 'not-allowed' : 'pointer', fontWeight: 500 }}>
                + Add custom perspective
              </button>
              {deletedPerspective ? (
                <button
                  onClick={undoDelete}
                  disabled={isLocked}
                  style={{ fontSize: 13, color: isLocked ? '#94A3B8' : '#0F766E', background: '#fff', border: `1px solid ${isLocked ? '#CBD5E1' : '#99F6E4'}`, borderRadius: 8, padding: '7px 14px', cursor: isLocked ? 'not-allowed' : 'pointer', fontWeight: 500 }}>
                  Undo delete
                </button>
              ) : null}
              {deletedPerspective && canAddPerspective ? (
                <div style={{ fontSize: 11.5, color: '#6B7280' }}>
                  Next added perspective will reuse <strong>{deletedPerspective.perspective.name || 'the deleted draft'}</strong>.
                </div>
              ) : null}
              {!isLocked && incompletePerspective ? (
                <div style={{ fontSize: 11.5, color: '#9A3412' }}>
                  Finish the unfinished perspective before adding another.
                </div>
              ) : null}
            </div>
          </div>
          {reviewOpen ? (
            <div style={{ marginTop: 16, padding: '16px 18px', borderRadius: 12, background: '#F8FAFC', border: '1px solid #DCE5F1' }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: '#2563EB', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 8 }}>
                Final fixed set
              </div>
              <div style={{ fontSize: 14.5, fontWeight: 600, color: '#0D1117', marginBottom: 6 }}>
                These perspectives will be used further in Goal Library and the master Excel template.
              </div>
              <div style={{ fontSize: 12.5, color: '#64748B', lineHeight: 1.55, marginBottom: 14 }}>
                Changing them later will cause rework in downstream mapping. Review the final set once and lock it only when you are sure.
              </div>
              <div style={{ display: 'grid', gap: 8, marginBottom: 14 }}>
                {activePerspectives.map((perspective) => (
                  <div key={perspective.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '10px 12px', borderRadius: 10, background: '#fff', border: '1px solid #E2E8F0' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      <div style={{ width: 12, height: 12, borderRadius: '50%', background: perspective.color }} />
                      <div style={{ fontSize: 13.5, fontWeight: 600, color: '#0F172A' }}>{getPerspectiveDisplayName(perspective)}</div>
                    </div>
                    <div style={{ fontSize: 12.5, fontWeight: 700, color: '#2563EB' }}>{perspective.weight}%</div>
                  </div>
                ))}
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                <div style={{ fontSize: 13, color: '#475569' }}>
                  {activePerspectives.length} perspective{activePerspectives.length === 1 ? '' : 's'} · Total {total}%
                </div>
                <button
                  type="button"
                  onClick={finalizeStructure}
                  style={{ padding: '9px 16px', background: '#16A34A', color: '#fff', border: 'none', borderRadius: 9, fontSize: 13, fontWeight: 700, cursor: 'pointer' }}
                >
                  Lock final perspective set
                </button>
              </div>
            </div>
          ) : null}
          {!isLocked ? (
            <div style={{ marginTop: 16, padding: '10px 12px', borderRadius: 9, background: '#F8FAFC', border: '1px solid #E2E8F0', fontSize: 12.5, color: '#475569', lineHeight: 1.55 }}>
              Every completed perspective row is included in the final set. When you continue, the full perspective list will be reviewed and then fixed for downstream goal mapping and master Excel generation.
            </div>
          ) : null}
        </CardBody>
      </Card>
      <div style={{ marginTop: 18, padding: '14px 16px', borderRadius: 10, background: perspectivesApplied ? '#F0FDF4' : reviewOpen ? '#EFF6FF' : isValid ? '#EFF6FF' : '#FFF7ED', border: `1.5px solid ${perspectivesApplied ? '#86EFAC' : reviewOpen ? '#BFDBFE' : isValid ? '#BFDBFE' : '#FED7AA'}`, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16 }}>
        <div style={{ fontSize: 13, color: perspectivesApplied ? '#15803D' : reviewOpen ? '#1E40AF' : isValid ? '#1E40AF' : '#92400E' }}>
          {perspectivesApplied
            ? 'Perspective structure confirmed — make changes above to reconfigure.'
            : reviewOpen
              ? 'Final perspective set is ready. Lock it above to continue.'
            : isValid
              ? 'Review the perspective structure above, then apply changes to continue.'
              : 'Complete and balance the perspective structure above before applying changes.'}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          {perspectivesApplied && isLocked ? (
            <button
              type="button"
              onClick={unlockStructure}
              style={{ padding: '9px 18px', border: '1.5px solid #FECACA', borderRadius: 8, fontSize: 13, cursor: 'pointer', background: '#FFF7F7', color: '#B91C1C', fontWeight: 600, fontFamily: 'inherit' }}
            >
              Unlock structure
            </button>
          ) : null}
          {!perspectivesApplied && !reviewOpen ? (
            <button
              type="button"
              disabled={!isValid || isLocked}
              onClick={confirmStructure}
              style={{
                padding: '9px 18px',
                border: 'none',
                borderRadius: 8,
                fontSize: 13,
                fontWeight: 600,
                cursor: !isValid || isLocked ? 'not-allowed' : 'pointer',
                background: !isValid || isLocked ? '#CBD5E1' : '#2563EB',
                color: '#fff',
                fontFamily: 'inherit',
              }}
            >
              Review final perspective set
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/* ── STEP 2: MODULES ───────────────────────────────────────────────────── */
function StepModules({ config, update }) {
  const toggle = (id) => {
    const moduleState = getFrameworkModuleState(config.frameworkId, id);
    if (moduleState.forcedOn || moduleState.forcedOff) return;
    const next = (config.enabledModules || []).includes(id)
      ? (config.enabledModules || []).filter(m => m !== id)
      : [...(config.enabledModules || []), id];
    update('enabledModules', next);
  };
  return (
    <div>
      <SectionHead title="Module toggles" sub="Enable or disable features for this appraisal cycle. Core modules are always on." />
      <Banner type="blue">
        <span>ℹ️</span>
        <span>
          Modules that do not apply to the selected framework are greyed out. Required structure modules stay locked on so the appraisal flow remains consistent.
        </span>
      </Banner>
      <Card>
        <CardHead title="Core performance modules" />
        <CardBody>
          {MODULES_LIST.map((m, i) => {
            const moduleState = getFrameworkModuleState(config.frameworkId, m.id);
            const isOn = m.core || moduleState.forcedOn || (config.enabledModules || []).includes(m.id);
            const isDisabled = m.core || moduleState.forcedOn || moduleState.forcedOff;
            return (
              <div
                key={m.id}
                style={{
                  opacity: moduleState.forcedOff ? 0.48 : 1,
                  filter: moduleState.forcedOff ? 'grayscale(0.35)' : 'none',
                }}
              >
                <TogRow
                  label={`${m.label}${moduleState.forcedOn ? ' (required)' : moduleState.forcedOff ? ' (unused)' : ''}`}
                  desc={moduleState.forcedOff ? 'Not used in the selected framework.' : m.desc}
                  last={i === MODULES_LIST.length - 1}
                  on={isOn}
                  onChange={() => !isDisabled && toggle(m.id)}
                  disabled={isDisabled}
                />
              </div>
            );
          })}
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
    const next = (config.ratingLevels || []).includes(id)
      ? (config.ratingLevels || []).filter(l => l !== id)
      : [...(config.ratingLevels || []), id];
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
              <Toggle on={(config.ratingLevels || []).includes(l.id)} onChange={() => toggle(l.id)} />
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

/* ── STEP 3: GOAL LIBRARY ──────────────────────────────────────────────── */

const GOAL_LIBRARY_MODES = [
  {
    id: 'shared',
    icon: '🌐',
    title: 'Shared library — same for everyone',
    desc: 'One master KRA library that all employees pick from. Simple to maintain. Best when goals are broadly similar across the org.',
  },
  {
    id: 'segmented',
    icon: '🗂',
    title: 'Segmented library — by attribute',
    desc: 'Different KRA sets for different groups (e.g. each department gets its own goals). Best when teams have distinct objectives.',
  },
];

const PREFILL_DEPTH_OPTIONS = [
  {
    id: 'kras-only',
    step: '①',
    label: 'KRAs only',
    desc: 'HR defines KRA names. Employees fill in their own KPIs and targets during goal setting.',
  },
  {
    id: 'kras-kpis',
    step: '②',
    label: 'KRAs + KPIs',
    desc: 'HR defines KRAs and the KPIs beneath each one. Employees only need to set their individual targets.',
  },
  {
    id: 'fully-prefilled',
    step: '③',
    label: 'KRAs + KPIs + Targets',
    desc: 'Fully pre-loaded structure and targets. Employees review and acknowledge — nothing left blank.',
  },
];

const WEIGHTAGE_OWNERSHIP_OPTIONS = [
  { id: 'hr-fixed',           label: 'HR pre-sets fixed weights',                  desc: 'Employees cannot change KRA weightages.' },
  { id: 'employee-proposes',  label: 'Employee proposes, manager approves',         desc: 'Employee suggests weights; manager approves before the window closes.' },
  { id: 'equal',              label: 'Equal weight across all KRAs (auto-split)',   desc: 'System divides 100% equally across all KRAs automatically.' },
];

const GOAL_SEGMENT_SUGGESTIONS = [
  'Department',
  'Designation',
  'Role',
  'Grade',
  'Band',
  'Location',
  'Region',
  'Zone',
  'Branch',
  'Business Unit',
  'Function',
  'Vertical',
  'Division',
  'Cost Center',
  'Employment Type',
  'Project',
  'Role Family',
  'Job Level',
  'Team',
  'Cluster',
];

// Suggestions per attribute — used in the "Add value" chip input
const SEGMENT_VALUE_SUGGESTIONS = {
  'Department':       ['Finance', 'HR', 'Engineering', 'Marketing', 'Sales', 'Operations', 'Legal', 'Product', 'Design', 'Customer Success', 'IT', 'Procurement', 'Admin', 'Strategy'],
  'Function':         ['Finance', 'HR', 'Technology', 'Operations', 'Commercial', 'Strategy', 'Compliance', 'Analytics', 'Supply Chain'],
  'Division':         ['Corporate', 'Retail', 'Wholesale', 'B2B', 'B2C', 'Enterprise', 'SMB', 'International'],
  'Business Unit':    ['Corporate', 'Retail', 'Wholesale', 'B2B', 'Enterprise', 'SMB', 'Digital', 'Exports'],
  'Vertical':         ['Banking', 'Insurance', 'Healthcare', 'Telecom', 'FMCG', 'Automotive', 'Pharma', 'Real Estate'],
  'Grade':            ['Grade 1', 'Grade 2', 'Grade 3', 'Grade 4', 'Grade 5', 'Grade 6', 'Grade 7', 'Grade 8'],
  'Band':             ['Band A', 'Band B', 'Band C', 'Band D', 'Band E', 'Band F'],
  'Job Level':        ['L1', 'L2', 'L3', 'L4', 'L5', 'L6', 'L7', 'L8'],
  'Role':             ['Individual Contributor', 'Team Lead', 'Manager', 'Senior Manager', 'Director', 'VP', 'SVP', 'C-Suite'],
  'Designation':      ['Analyst', 'Senior Analyst', 'Associate', 'Senior Associate', 'Manager', 'Senior Manager', 'Director', 'VP'],
  'Role Family':      ['Engineering', 'Sales', 'Operations', 'Finance', 'HR', 'Product', 'Marketing', 'Legal'],
  'Team':             ['Frontend', 'Backend', 'Data Engineering', 'Platform', 'Infrastructure', 'Mobile', 'QA', 'DevOps'],
  'Location':         ['HQ', 'Remote', 'Mumbai', 'Delhi', 'Bangalore', 'Hyderabad', 'Chennai', 'Pune', 'New York', 'London', 'Singapore'],
  'Region':           ['North', 'South', 'East', 'West', 'Central', 'APAC', 'EMEA', 'Americas'],
  'Zone':             ['Zone A', 'Zone B', 'Zone C', 'Zone D', 'North Zone', 'South Zone', 'East Zone', 'West Zone'],
  'Branch':           ['Head Office', 'Branch 1', 'Branch 2', 'Branch 3', 'Regional Office'],
  'Cluster':          ['Cluster 1', 'Cluster 2', 'Cluster 3', 'Metro', 'Tier 1', 'Tier 2', 'Tier 3'],
  'Cost Center':      ['CC-001', 'CC-002', 'CC-003', 'CC-004', 'CC-005'],
  'Employment Type':  ['Full-Time', 'Part-Time', 'Contract', 'Intern', 'Consultant'],
  'Project':          ['Project Alpha', 'Project Beta', 'Project Gamma'],
};

/* ── GOAL DECISION TREE COMPONENTS ──────────────────────────────────────── */
const TREE_BLUE  = '#2563EB';
const TREE_AMBER = '#D97706';

function GoalPathSummary({ config }) {
  const c = config;
  const crumbs = [];
  if (c.goalCreationMode) {
    crumbs.push({ label: c.goalCreationMode === 'admin-library' ? '🏛️ Admin Library' : '✍️ Self-Create', color: c.goalCreationMode === 'admin-library' ? TREE_BLUE : TREE_AMBER });
  }
  if (c.goalCreationMode === 'admin-library' && c.goalLibraryScope) {
    const aLabel = c.goalSegmentAttr || 'Department';
    crumbs.push({ label: c.goalLibraryScope === 'common' ? '🌐 Common' : `🗂️ By ${aLabel}`, color: TREE_BLUE });
    if (c.goalLibraryScope === 'by-attribute') {
      const vals = (c.goalSegmentValues || []).filter(v => v.name.trim());
      if (vals.length > 0) crumbs.push({ label: vals.map(v => v.name).join(', '), color: TREE_BLUE });
    }
  }
  if (c.goalCreationMode === 'employee-self' && c.goalLimitEnabled != null) {
    crumbs.push({ label: c.goalLimitEnabled ? '🔢 Limits on' : '∞ No limits', color: TREE_AMBER });
    if (c.goalLimitEnabled && c.goalLimitScope) {
      crumbs.push({ label: c.goalLimitScope === 'common' ? `Min ${c.goalLimitMin}–Max ${c.goalLimitMax}` : `By ${c.goalLimitAttr || 'Dept'}`, color: TREE_AMBER });
    }
  }
  if (crumbs.length === 0) return null;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginBottom: 28, padding: '10px 16px', background: '#F8FAFC', borderRadius: 10, border: '1px solid #E9EDF2' }}>
      <span style={{ fontSize: 10, fontWeight: 700, color: '#9CA3AF', textTransform: 'uppercase', letterSpacing: '0.07em', marginRight: 4 }}>Path</span>
      {crumbs.map((cr, i) => (
        <span key={i} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontSize: 12, fontWeight: 600, padding: '3px 10px', borderRadius: 20, background: cr.color + '12', color: cr.color, border: `1px solid ${cr.color}30` }}>{cr.label}</span>
          {i < crumbs.length - 1 && <span style={{ color: '#CBD5E1', fontSize: 13 }}>›</span>}
        </span>
      ))}
    </div>
  );
}

function SegmentAttributeInput({ value, onChange }) {
  const [draft, setDraft] = useState(value || '');
  const [open, setOpen]   = useState(false);
  const ref = useRef(null);

  useEffect(() => { setDraft(value || ''); }, [value]);
  useEffect(() => {
    const handler = e => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const filtered = GOAL_SEGMENT_SUGGESTIONS.filter(s =>
    s.toLowerCase().includes(draft.toLowerCase())
  );

  function commit(val) {
    const v = String(val || '').trim();
    if (!v) return;
    onChange(v);
    setDraft(v);
    setOpen(false);
  }

  return (
    <div ref={ref} style={{ position: 'relative', maxWidth: 300 }}>
      <input
        style={{ ...inputStyle, cursor: 'text' }}
        value={draft}
        placeholder="e.g. Department"
        onChange={e => { setDraft(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onKeyDown={e => {
          if (e.key === 'Enter')  { e.preventDefault(); commit(draft); }
          if (e.key === 'Escape') setOpen(false);
        }}
        onBlur={() => setTimeout(() => { if (draft.trim()) commit(draft); setOpen(false); }, 150)}
      />
      {open && (
        <div
          ref={el => {
            if (!el || !ref.current) return;
            const r = ref.current.getBoundingClientRect();
            el.style.top   = `${r.bottom + 4}px`;
            el.style.left  = `${r.left}px`;
            el.style.width = `${r.width}px`;
          }}
          style={{ position: 'fixed', zIndex: 9999, background: '#fff', border: '1px solid #E2E8F0', borderRadius: 10, boxShadow: '0 8px 24px rgba(0,0,0,.13)', maxHeight: 220, overflowY: 'auto', minWidth: 220 }}
        >
          {draft.trim() && !GOAL_SEGMENT_SUGGESTIONS.includes(draft.trim()) && (
            <button type="button" onMouseDown={() => commit(draft)}
              style={{ display:'block', width:'100%', textAlign:'left', padding:'10px 14px', border:'none', borderBottom:'1px solid #F1F5F9', background:'#F8FBFF', color:'#1D4ED8', fontSize:13, fontWeight:600, cursor:'pointer', fontFamily:'inherit' }}>
              Use "{draft.trim()}"
            </button>
          )}
          {filtered.map(opt => (
            <button key={opt} type="button" onMouseDown={() => commit(opt)}
              style={{ display:'block', width:'100%', textAlign:'left', padding:'9px 14px', border:'none', background: opt === value ? '#EFF4FF' : 'transparent', color: opt === value ? '#2563EB' : '#0D1117', fontSize:13, fontWeight: opt === value ? 600 : 400, cursor:'pointer', fontFamily:'inherit' }}>
              {opt}{opt === value ? ' ✓' : ''}
            </button>
          ))}
          {filtered.length === 0 && !draft.trim() && (
            <div style={{ padding:'12px 14px', fontSize:12, color:'#94A3B8' }}>Type to search or enter a custom name</div>
          )}
        </div>
      )}
    </div>
  );
}

function SegmentValueInput({ attrKey, existingValues, onAdd }) {
  const [draft, setDraft] = useState('');
  const [open, setOpen]   = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    const handler = e => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const pool = SEGMENT_VALUE_SUGGESTIONS[attrKey] || [];
  const existing = new Set(existingValues.map(v => v.toLowerCase()));

  const filtered = (draft.trim()
    ? pool.filter(s => s.toLowerCase().includes(draft.toLowerCase()))
    : pool
  ).filter(s => !existing.has(s.toLowerCase()));

  function commit(val) {
    const v = String(val || '').trim();
    if (!v || existing.has(v.toLowerCase())) return;
    onAdd(v);
    setDraft('');
    setOpen(false);
  }

  return (
    <div ref={ref} style={{ position: 'relative', display: 'inline-block' }}>
      <input
        style={{ fontSize: 12.5, color: TREE_BLUE, background: 'none', border: `1.5px dashed ${TREE_BLUE}50`, borderRadius: 8, padding: '4px 12px', cursor: 'text', fontWeight: 500, outline: 'none', fontFamily: 'inherit', minWidth: 90 }}
        value={draft}
        placeholder="+ Add value"
        onChange={e => { setDraft(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onKeyDown={e => {
          if (e.key === 'Enter')  { e.preventDefault(); commit(draft); }
          if (e.key === 'Escape') setOpen(false);
        }}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
      />
      {open && (filtered.length > 0 || draft.trim()) && (
        <div
          ref={el => {
            if (!el || !ref.current) return;
            const r = ref.current.getBoundingClientRect();
            el.style.top   = `${r.bottom + 4}px`;
            el.style.left  = `${r.left}px`;
            el.style.minWidth = `${Math.max(r.width, 160)}px`;
          }}
          style={{ position: 'fixed', zIndex: 9999, background: '#fff', border: '1px solid #E2E8F0', borderRadius: 10, boxShadow: '0 8px 24px rgba(0,0,0,.13)', maxHeight: 200, overflowY: 'auto' }}
        >
          {draft.trim() && !pool.map(s => s.toLowerCase()).includes(draft.trim().toLowerCase()) && (
            <button type="button" onMouseDown={() => commit(draft)}
              style={{ display:'block', width:'100%', textAlign:'left', padding:'9px 14px', border:'none', borderBottom:'1px solid #F1F5F9', background:'#F8FBFF', color:'#1D4ED8', fontSize:13, fontWeight:600, cursor:'pointer', fontFamily:'inherit' }}>
              Add "{draft.trim()}"
            </button>
          )}
          {filtered.map(opt => (
            <button key={opt} type="button" onMouseDown={() => commit(opt)}
              style={{ display:'block', width:'100%', textAlign:'left', padding:'8px 14px', border:'none', background:'transparent', color:'#0D1117', fontSize:13, cursor:'pointer', fontFamily:'inherit' }}>
              {opt}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function AttributeSheetControls({ attrLabel, values, onImported }) {
  const fileRef = useRef(null);
  const wrapRef = useRef(null);
  const [phase, setPhase] = useState('idle');
  const [message, setMessage] = useState('');
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;

    function handlePointerDown(event) {
      if (wrapRef.current && !wrapRef.current.contains(event.target)) {
        setOpen(false);
      }
    }

    document.addEventListener('mousedown', handlePointerDown);
    return () => document.removeEventListener('mousedown', handlePointerDown);
  }, [open]);

  async function handleDownload() {
    setMessage('');
    setPhase('idle');
    await downloadAttributeValuesTemplate(attrLabel, values);
  }

  async function handleUpload(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    setPhase('parsing');
    setMessage('');
    try {
      const result = await parseAttributeValuesXlsx(file, attrLabel);
      onImported(result.values);
      setPhase('done');
      setMessage(`${result.count} ${attrLabel.toLowerCase()} values imported.`);
      setOpen(false);
    } catch (err) {
      setPhase('error');
      setMessage(err?.message || 'Could not import values from the uploaded sheet.');
    } finally {
      event.target.value = '';
    }
  }

  return (
    <div ref={wrapRef} style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 6 }}>
      <input
        ref={fileRef}
        type="file"
        accept=".xlsx,.xls"
        onChange={handleUpload}
        style={{ display: 'none' }}
      />
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <button
          type="button"
          onClick={() => setOpen(prev => !prev)}
          style={{
            fontSize: 12.5,
            color: phase === 'parsing' ? '#94A3B8' : '#2563EB',
            background: open ? '#FFFFFF' : '#F8FAFC',
            border: '1px solid #D7E3F4',
            borderRadius: 12,
            padding: '7px 13px',
            minWidth: 108,
            cursor: 'pointer',
            fontWeight: 700,
            fontFamily: 'inherit',
            transform: `translateX(${open ? -8 : 0}px)`,
            transition: 'all .18s ease',
            boxShadow: open ? '0 10px 24px rgba(15,23,42,.08)' : 'none',
          }}
        >
          {phase === 'parsing' ? 'Uploading…' : 'Upload Sheet'}
        </button>
        <button
          type="button"
          onClick={handleDownload}
          title="Download sheet"
          aria-label="Download sheet"
          style={{
            width: open ? 34 : 0,
            opacity: open ? 1 : 0,
            overflow: 'hidden',
            padding: open ? '7px 0' : '7px 0',
            border: open ? '1px solid #D6E4FF' : '1px solid transparent',
            background: '#FFFFFF',
            color: '#2563EB',
            borderRadius: 10,
            cursor: open ? 'pointer' : 'default',
            fontSize: 17,
            lineHeight: 1,
            transform: `translateX(${open ? 0 : -8}px)`,
            transition: 'all .18s ease',
            pointerEvents: open ? 'auto' : 'none',
            boxShadow: open ? '0 4px 12px rgba(37,99,235,.10)' : 'none',
            fontFamily: 'inherit',
          }}
        >
          ⬇
        </button>
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          title="Upload sheet"
          aria-label="Upload sheet"
          disabled={!open || phase === 'parsing'}
          style={{
            width: open ? 34 : 0,
            opacity: open ? 1 : 0,
            overflow: 'hidden',
            padding: open ? '7px 0' : '7px 0',
            border: open ? '1px solid #D6E4FF' : '1px solid transparent',
            background: '#F8FBFF',
            color: phase === 'parsing' ? '#94A3B8' : '#2563EB',
            borderRadius: 10,
            cursor: !open || phase === 'parsing' ? 'default' : 'pointer',
            fontSize: 17,
            lineHeight: 1,
            transform: `translateX(${open ? 0 : -8}px)`,
            transition: 'all .18s ease',
            pointerEvents: open ? 'auto' : 'none',
            boxShadow: open ? '0 4px 12px rgba(37,99,235,.10)' : 'none',
            fontFamily: 'inherit',
          }}
        >
          ⬆
        </button>
      </div>
      {message ? (
        <div style={{ fontSize: 11.5, color: phase === 'error' ? '#B91C1C' : '#64748B' }}>
          {message}
        </div>
      ) : null}
    </div>
  );
}

function GoalLibrarySheetControls({ config, downloadConfig = null, existingLibraries, onImported }) {
  const fileRef = useRef(null);
  const wrapRef = useRef(null);
  const [phase, setPhase] = useState('idle');
  const [message, setMessage] = useState('');
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;

    function handlePointerDown(event) {
      if (wrapRef.current && !wrapRef.current.contains(event.target)) {
        setOpen(false);
      }
    }

    document.addEventListener('mousedown', handlePointerDown);
    return () => document.removeEventListener('mousedown', handlePointerDown);
  }, [open]);

  async function handleDownload() {
    setMessage('');
    setPhase('idle');
    await downloadGoalLibraryBulkTemplate(downloadConfig || config);
  }

  async function handleUpload(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    setPhase('parsing');
    setMessage('');
    try {
      const result = await parseGoalLibraryBulkXlsx(file, config?.goalGroups || []);
      // Normalize spaces around parentheses so "Name( X)" and "Name ( X)" match
      const normalizeLibName = s => String(s || '').trim().toLowerCase()
        .replace(/\s*\(\s*/g, ' (').replace(/\s*\)\s*/g, ')').replace(/\s+/g, ' ').trim();
      // When re-uploading, drop ALL existing libraries that belong to any group present in the file.
      // This ensures a full replace — no stale entries survive from previous uploads.
      const importedGroupNames = new Set(
        (result.libraries || []).map(lib => normalizeLibName(lib.groupName || '')).filter(Boolean)
      );
      const importedNames = new Set(
        (result.libraries || []).map(library => normalizeLibName(library.name)).filter(Boolean)
      );
      const retained = (existingLibraries || []).filter(library => {
        const libGroup = normalizeLibName(library.groupName || '');
        // Drop if this library belongs to a group being re-uploaded
        if (libGroup && importedGroupNames.has(libGroup)) return false;
        // Drop if name matches directly (backward compat for libraries without groupName)
        if (importedNames.has(normalizeLibName(library.name))) return false;
        return true;
      });
      const importedLibraries = result.libraries || [];
      const importSummary = onImported([...retained, ...importedLibraries], importedLibraries) || {};
      setPhase('done');
      const warningText = (result.warnings || []).length > 0 ? ` ⚠ ${result.warnings.join(' ')}` : '';
      const unmatchedText = importSummary.unassignedImportCount > 0
        ? ` ${importSummary.unassignedImportCount} imported librar${importSummary.unassignedImportCount === 1 ? 'y was' : 'ies were'} not linked to a visible card automatically.${importSummary.unassignedImportNames?.length ? ` Unmatched: ${importSummary.unassignedImportNames.join(', ')}.` : ''} Check Group Name / Library Name in the sheet.`
        : '';
      setMessage(`${result.count} librar${result.count === 1 ? 'y' : 'ies'} imported.${warningText}${unmatchedText}`);
      setOpen(false);
    } catch (err) {
      setPhase('error');
      setMessage(err?.message || 'Could not import libraries from the uploaded sheet.');
    } finally {
      event.target.value = '';
    }
  }

  return (
    <div ref={wrapRef} style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 6 }}>
      <input
        ref={fileRef}
        type="file"
        accept=".xlsx,.xls"
        onChange={handleUpload}
        style={{ display: 'none' }}
      />
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <button
          type="button"
          onClick={() => setOpen(prev => !prev)}
          style={{
            fontSize: 12.5,
            color: phase === 'parsing' ? '#94A3B8' : '#2563EB',
            background: open ? '#FFFFFF' : '#F8FBFF',
            border: '1px solid #BFDBFE',
            borderRadius: 10,
            padding: '6px 12px',
            minWidth: 108,
            cursor: 'pointer',
            fontWeight: 600,
            fontFamily: 'inherit',
            transform: `translateX(${open ? -8 : 0}px)`,
            transition: 'all .18s ease',
            boxShadow: open ? '0 6px 16px rgba(37,99,235,.10)' : 'none',
          }}
        >
          {phase === 'parsing' ? 'Uploading…' : 'Upload Sheet'}
        </button>
        <button
          type="button"
          onClick={handleDownload}
          title="Download sheet"
          aria-label="Download sheet"
          style={{
            width: open ? 34 : 0,
            opacity: open ? 1 : 0,
            overflow: 'hidden',
            padding: '7px 0',
            border: open ? '1px solid #D7E3F4' : '1px solid transparent',
            background: '#F8FAFC',
            borderRadius: 12,
            color: '#2563EB',
            cursor: open ? 'pointer' : 'default',
            transition: 'all .18s ease',
            fontSize: 16,
            fontWeight: 700,
            lineHeight: 1,
            boxShadow: open ? '0 8px 18px rgba(15,23,42,.08)' : 'none',
          }}
        >
          ⬇
        </button>
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          title="Upload sheet"
          aria-label="Upload sheet"
          style={{
            width: open ? 34 : 0,
            opacity: open ? 1 : 0,
            overflow: 'hidden',
            padding: '7px 0',
            border: open ? '1px solid #D7E3F4' : '1px solid transparent',
            background: '#F8FAFC',
            borderRadius: 12,
            color: '#2563EB',
            cursor: open ? 'pointer' : 'default',
            transition: 'all .18s ease',
            fontSize: 16,
            fontWeight: 700,
            lineHeight: 1,
            boxShadow: open ? '0 8px 18px rgba(15,23,42,.08)' : 'none',
          }}
        >
          ⬆
        </button>
      </div>
      {message ? (
        <div style={{ fontSize: 12, color: phase === 'error' ? '#DC2626' : '#16A34A' }}>
          {message}
        </div>
      ) : null}
    </div>
  );
}

function flattenLibraryPerspectivesForValidation(perspectives = []) {
  return (perspectives || []).flatMap((perspective) =>
    (perspective.kras || []).map((kra) => ({
      id: kra.id,
      name: kra.name,
      desc: kra.desc,
      weight: kra.suggestedWeight ?? kra.weight ?? '',
      perspName: perspective.name,
      kpis: (kra.kpis || []).map((kpi) => ({
        id: kpi.id,
        name: kpi.name,
        weight: kpi.weight ?? '',
      })),
    }))
  );
}

function PrefillSheetControls({ config, selectedGroup, onImported, phase, setPhase, errors, setErrors }) {
  const fileRef = useRef(null);
  const wrapRef = useRef(null);
  const [message, setMessage] = useState('');
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;

    function handlePointerDown(event) {
      if (wrapRef.current && !wrapRef.current.contains(event.target)) {
        setOpen(false);
      }
    }

    document.addEventListener('mousedown', handlePointerDown);
    return () => document.removeEventListener('mousedown', handlePointerDown);
  }, [open]);

  useEffect(() => {
    if (phase !== 'error') return;
    if (errors?.length > 0) {
      setMessage(errors.map(error => error.message).join(' '));
    }
  }, [errors, phase]);

  async function handleDownload() {
    if (!selectedGroup) return;
    setMessage('');
    setErrors([]);
    setPhase('idle');
    await downloadPrefillBulkTemplate({
      ...config,
      goalGroups: [selectedGroup],
    });
  }

  async function handleUpload(event) {
    const file = event.target.files?.[0];
    if (!file || !selectedGroup) return;
    event.target.value = '';
    setPhase('parsing');
    setErrors([]);
    setMessage('');
    try {
      const parserGroup = {
        ...selectedGroup,
        hasLibrary: true,
        libraryType: selectedGroup.prefillType === 'kra-kpi' ? 'kra-kpi' : 'kra-only',
      };
      const result = await parseGoalLibraryBulkXlsx(file, [parserGroup]);
      const validationConfig = getGroupPrefillUploadConfig(config, selectedGroup);
      const validationErrors = (result.libraries || []).flatMap((library) => (
        validateGoalLibraryData(
          { byAttr: false, data: flattenLibraryPerspectivesForValidation(library.perspectives || []) },
          validationConfig
        ).map((error) => ({
          ...error,
          message: `${library.name}: ${error.message}`,
        }))
      )).filter(item => item.field === 'perspective' || item.field === 'kra_weight' || item.field === 'kpi_weight');

      if (validationErrors.length > 0) {
        setErrors(validationErrors);
        setPhase('error');
        return;
      }

      onImported(result.libraries || []);
      setPhase('done');
      setMessage(`${result.count || 0} pre-fill card${(result.count || 0) === 1 ? '' : 's'} imported.`);
      setOpen(false);
    } catch (error) {
      const nextErrors = [{ field: 'parse', message: error.message }];
      setErrors(nextErrors);
      setPhase('error');
      setMessage(error.message || 'Could not import pre-fill data from the uploaded sheet.');
    }
  }

  return (
    <div ref={wrapRef} style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 6 }}>
      <input
        ref={fileRef}
        type="file"
        accept=".xlsx,.xls,.csv"
        onChange={handleUpload}
        style={{ display: 'none' }}
      />
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <button
          type="button"
          onClick={() => setOpen(prev => !prev)}
          style={{
            fontSize: 12.5,
            color: phase === 'parsing' ? '#94A3B8' : '#2563EB',
            background: open ? '#FFFFFF' : '#F8FBFF',
            border: '1px solid #BFDBFE',
            borderRadius: 10,
            padding: '6px 12px',
            minWidth: 108,
            cursor: 'pointer',
            fontWeight: 600,
            fontFamily: 'inherit',
            transform: `translateX(${open ? -8 : 0}px)`,
            transition: 'all .18s ease',
            boxShadow: open ? '0 6px 16px rgba(37,99,235,.10)' : 'none',
          }}
        >
          {phase === 'parsing' ? 'Uploading…' : 'Upload Sheet'}
        </button>
        <button
          type="button"
          onClick={handleDownload}
          title="Download sheet"
          aria-label="Download sheet"
          style={{
            width: open ? 34 : 0,
            opacity: open ? 1 : 0,
            overflow: 'hidden',
            padding: '7px 0',
            border: open ? '1px solid #D7E3F4' : '1px solid transparent',
            background: '#F8FAFC',
            borderRadius: 12,
            color: '#2563EB',
            cursor: open ? 'pointer' : 'default',
            transition: 'all .18s ease',
            fontSize: 16,
            fontWeight: 700,
            lineHeight: 1,
            boxShadow: open ? '0 8px 18px rgba(15,23,42,.08)' : 'none',
          }}
        >
          ⬇
        </button>
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          title="Upload sheet"
          aria-label="Upload sheet"
          style={{
            width: open ? 34 : 0,
            opacity: open ? 1 : 0,
            overflow: 'hidden',
            padding: '7px 0',
            border: open ? '1px solid #D7E3F4' : '1px solid transparent',
            background: '#F8FAFC',
            borderRadius: 12,
            color: '#2563EB',
            cursor: open ? 'pointer' : 'default',
            transition: 'all .18s ease',
            fontSize: 16,
            fontWeight: 700,
            lineHeight: 1,
            boxShadow: open ? '0 8px 18px rgba(15,23,42,.08)' : 'none',
          }}
        >
          ⬆
        </button>
      </div>
      {message ? (
        <div style={{ fontSize: 12, color: phase === 'error' ? '#DC2626' : '#16A34A' }}>
          {message}
        </div>
      ) : null}
    </div>
  );
}

function MagicText({ text }) {
  return (
    <span
      key={text}
      style={{
        display: 'inline-block',
        animation: 'magicLabelIn .34s cubic-bezier(.2,.8,.2,1)',
      }}
    >
      {text}
    </span>
  );
}

function TreeConnector({ color }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', margin: '0 auto', width: '100%', maxWidth: 760 }}>
      <div style={{ width: 2, height: 18, background: `${color}40` }} />
      <div style={{ width: 2, height: 18, background: `${color}40` }} />
      <div style={{ width: 10, height: 10, borderRadius: '50%', background: color, boxShadow: `0 0 0 4px ${color}20` }} />
    </div>
  );
}

function CompletedNode({ question, summary, color, onOpen }) {
  return (
    <div
      onClick={onOpen}
      title="Click to reopen this step"
      style={{ display: 'flex', alignItems: 'center', gap: 12, background: '#fff', border: `1.5px solid ${color}22`, borderRadius: 12, padding: '11px 16px', width: '100%', maxWidth: 760, boxShadow: '0 1px 4px rgba(0,0,0,.05)', animation: 'treeNodeIn .25s ease', cursor: 'pointer' }}
    >
      <div style={{ width: 24, height: 24, borderRadius: '50%', background: color, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
        <span style={{ color: '#fff', fontSize: 9, fontWeight: 800 }}>✓</span>
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 11, color: '#9CA3AF', fontWeight: 500, marginBottom: 1 }}>{question}</div>
        <div style={{ fontSize: 13, color: '#0D1117', fontWeight: 600, lineHeight: 1.45 }}>{summary}</div>
      </div>
    </div>
  );
}

function ActiveNode({ question, color, hint, children }) {
  return (
    <div style={{ width: '100%', maxWidth: 760, background: '#fff', border: `1.5px solid ${color}35`, borderRadius: 14, overflow: 'hidden', boxShadow: `0 6px 20px ${color}10, 0 1px 4px rgba(0,0,0,.06)`, animation: 'treeNodeIn .3s ease' }}>
      <div style={{ padding: '14px 20px', background: `linear-gradient(to right, ${color}0A, transparent)`, borderBottom: '1px solid #F1F3F5', display: 'flex', alignItems: 'center', gap: 10 }}>
        <div style={{ width: 9, height: 9, borderRadius: '50%', background: color, boxShadow: `0 0 0 4px ${color}25`, flexShrink: 0 }} />
        <div style={{ fontSize: 14, fontWeight: 700, color: '#0D1117' }}>{question}</div>
      </div>
      {hint && <div style={{ padding: '8px 20px 0', fontSize: 12, color: '#6B7280' }}>{hint}</div>}
      <div style={{ padding: '16px 20px' }}>{children}</div>
    </div>
  );
}

function ChoiceGrid({ choices, selectedId, onSelect, color }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
      {choices.map(c => {
        const sel = selectedId === c.id;
        return (
          <button key={c.id} type="button" onClick={() => onSelect(c.id)}
            style={{ textAlign: 'left', border: `2px solid ${sel ? color : '#E9EDF2'}`, borderRadius: 10, padding: '14px', cursor: 'pointer', background: sel ? color + '0C' : '#F8FAFC', transition: 'all .15s', appearance: 'none', position: 'relative' }}>
            {sel && <div style={{ position: 'absolute', top: 9, right: 9, width: 17, height: 17, borderRadius: '50%', background: color, display: 'flex', alignItems: 'center', justifyContent: 'center' }}><span style={{ color: '#fff', fontSize: 8, fontWeight: 800 }}>✓</span></div>}
            <div style={{ fontSize: 20, marginBottom: 7 }}>{c.icon}</div>
            <div style={{ fontSize: 12.5, fontWeight: 700, color: '#0D1117', marginBottom: 3 }}>{c.title}</div>
            <div style={{ fontSize: 11.5, color: '#6B7280', lineHeight: 1.45 }}>{c.desc}</div>
          </button>
        );
      })}
    </div>
  );
}

/* ── MANUAL GOAL ENTRY ───────────────────────────────────────────────────── */
function ManualGoalEntry({ config, perspectives, update }) {
  const scope = config.goalLibraryScope;
  const rawSegments = config.goalSegmentValues || [];
  const segments = scope === 'by-attribute' ? rawSegments.filter(v => v.name.trim()) : [{ id: 'common', name: 'All Employees' }];
  const [activeTab, setActiveTab] = useState(segments[0]?.id || 'common');
  const [kras, setKras] = useState({});
  const [manualError, setManualError] = useState('');

  if (scope === 'by-attribute' && segments.length === 0) {
    return (
      <Banner type="amber">
        <span>⚠️</span>
        <span>Add at least one {config.goalSegmentAttr || 'attribute'} value above to start entering goals.</span>
      </Banner>
    );
  }

  const currentKras = kras[activeTab] || [];
  const totalWeight = currentKras.reduce((s, k) => s + (Number(k.weight) || 0), 0);
  const activeSegmentName = segments.find((segment) => segment.id === activeTab)?.name || 'All Employees';

  const showKpis = config.goalKpiMode === 'kra-kpi';

  function addKra() {
    setKras(prev => ({
      ...prev,
      [activeTab]: [...(prev[activeTab] || []), { id: Date.now(), name: '', weight: '', perspId: perspectives[0]?.id || '', kpis: [] }],
    }));
  }

  function removeKra(id) {
    setKras(prev => ({ ...prev, [activeTab]: (prev[activeTab] || []).filter(k => k.id !== id) }));
  }

  function updateKra(id, field, val) {
    setManualError('');
    setKras(prev => ({ ...prev, [activeTab]: (prev[activeTab] || []).map(k => k.id === id ? { ...k, [field]: field === 'weight' ? sanitizeWeightInput(val) : val } : k) }));
  }

  function addKpi(kraId) {
    setKras(prev => ({
      ...prev,
      [activeTab]: (prev[activeTab] || []).map(k => k.id === kraId
        ? { ...k, kpis: [...(k.kpis || []), { id: Date.now(), name: '', weight: '' }] }
        : k),
    }));
  }

  function removeKpi(kraId, kpiId) {
    setKras(prev => ({
      ...prev,
      [activeTab]: (prev[activeTab] || []).map(k => k.id === kraId
        ? { ...k, kpis: (k.kpis || []).filter(p => p.id !== kpiId) }
        : k),
    }));
  }

  function updateKpi(kraId, kpiId, field, val) {
    setManualError('');
    setKras(prev => ({
      ...prev,
      [activeTab]: (prev[activeTab] || []).map(k => k.id === kraId
        ? { ...k, kpis: (k.kpis || []).map(p => p.id === kpiId ? { ...p, [field]: field === 'weight' ? sanitizeWeightInput(val) : val } : p) }
        : k),
    }));
  }

  function validateManualLibrary() {
    const parsedData = buildManualGoalLibraryData(kras, segments, perspectives, scope, config.goalSegmentAttr || 'Department');
    const errors = validateGoalLibraryData(parsedData, config);
    return { parsedData, errors };
  }

  return (
    <div>
      {segments.length > 1 && (
        <div style={{ display: 'flex', gap: 0, background: '#F8FAFC', border: '1px solid #E9EDF2', borderRadius: 8, padding: 3, marginBottom: 16, flexWrap: 'wrap' }}>
          {segments.map(t => (
            <button key={t.id} type="button" onClick={() => setActiveTab(t.id)}
              style={{ padding: '5px 12px', borderRadius: 6, border: 'none', fontSize: 12, fontWeight: activeTab === t.id ? 600 : 400, color: activeTab === t.id ? '#2563EB' : '#9CA3AF', background: activeTab === t.id ? '#fff' : 'transparent', cursor: 'pointer', boxShadow: activeTab === t.id ? '0 1px 3px rgba(0,0,0,.07)' : 'none', transition: 'all .15s' }}>
              {t.name}
              {(kras[t.id] || []).length > 0 && <span style={{ marginLeft: 5, background: '#EFF4FF', color: '#2563EB', borderRadius: 10, fontSize: 10, padding: '1px 6px', fontWeight: 600 }}>{(kras[t.id] || []).length}</span>}
            </button>
          ))}
        </div>
      )}
      <div style={{ border: '1px solid #E2E8F0', borderRadius: 14, overflow: 'hidden', background: '#fff' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '14px 16px', borderBottom: '1px solid #E2E8F0', background: 'linear-gradient(180deg, #F8FBFF 0%, #FFFFFF 100%)', flexWrap: 'wrap' }}>
          <div>
            <div style={{ fontSize: 15, fontWeight: 700, color: '#0D1117', marginBottom: 3 }}>Manual KRA workspace</div>
            <div style={{ fontSize: 12.5, color: '#64748B', lineHeight: 1.5 }}>
              Build KRAs for <strong>{activeSegmentName}</strong> row by row.
            </div>
          </div>
        </div>

        <div style={{ padding: 16 }}>
            {manualError && (
              <div style={{ marginBottom: 12, padding: '10px 12px', background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: 10, fontSize: 12.5, color: '#B91C1C' }}>
                {manualError}
              </div>
            )}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 10, marginBottom: 16 }}>
              <div style={{ border: '1px solid #E2E8F0', borderRadius: 12, padding: '12px 14px', background: '#fff' }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: '#64748B', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 6 }}>Current set</div>
                <div style={{ fontSize: 16, fontWeight: 700, color: '#0F172A' }}>{activeSegmentName}</div>
              </div>
              <div style={{ border: '1px solid #E2E8F0', borderRadius: 12, padding: '12px 14px', background: '#fff' }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: '#64748B', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 6 }}>KRA count</div>
                <div style={{ fontSize: 16, fontWeight: 700, color: '#0F172A' }}>{currentKras.length}</div>
              </div>
              <div style={{ border: '1px solid #E2E8F0', borderRadius: 12, padding: '12px 14px', background: '#fff' }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: '#64748B', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 6 }}>Weight total</div>
                <div style={{ fontSize: 16, fontWeight: 700, color: totalWeight === 100 ? '#16A34A' : '#DC2626' }}>{totalWeight}%</div>
              </div>
            </div>

            {!showKpis && (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 160px 90px 36px', gap: '8px 12px', alignItems: 'center', marginBottom: 8, padding: '0 4px' }}>
                <div style={{ fontSize: 10.5, fontWeight: 700, color: '#94A3B8', textTransform: 'uppercase', letterSpacing: '0.06em' }}>KRA name</div>
                <div style={{ fontSize: 10.5, fontWeight: 700, color: '#94A3B8', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Perspective</div>
                <div style={{ fontSize: 10.5, fontWeight: 700, color: '#94A3B8', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Weight %</div>
                <div />
              </div>
            )}
            {currentKras.length === 0 && (
              <div style={{ padding: '30px 20px', textAlign: 'center', color: '#64748B', fontSize: 13, border: '1.5px dashed #CBD5E1', borderRadius: 12, marginBottom: 12, background: '#F8FAFC' }}>
                No KRAs added yet. Start with + Add KRA to build the library.
              </div>
            )}
            {currentKras.map(kra => !showKpis ? (
              <div key={kra.id} style={{ display: 'grid', gridTemplateColumns: '1fr 160px 90px 36px', gap: '8px 12px', alignItems: 'center', padding: '10px 12px', border: '1px solid #E2E8F0', borderRadius: 12, marginBottom: 10, background: '#fff' }}>
                <input style={inputStyle} placeholder="e.g. Revenue Growth" value={kra.name} onChange={e => updateKra(kra.id, 'name', e.target.value)} onBlur={e => updateKra(kra.id, 'name', sanitizeGoalName(e.target.value))} />
                <select style={selectStyle} value={kra.perspId} onChange={e => updateKra(kra.id, 'perspId', e.target.value)}>
                  {perspectives.map(p => <option key={p.id} value={p.id}>{p.name || `Perspective ${p.id}`}</option>)}
                </select>
                <input style={{ ...inputStyle, textAlign: 'center' }} inputMode="decimal" placeholder="%" value={kra.weight} onChange={e => updateKra(kra.id, 'weight', e.target.value)} />
                <button onClick={() => removeKra(kra.id)} style={{ width: 34, height: 34, borderRadius: 10, background: '#FFF1F2', border: '1px solid #FECDD3', cursor: 'pointer', color: '#DC2626', fontSize: 15, lineHeight: 1, fontFamily: 'inherit' }}>✕</button>
              </div>
            ) : (
              /* KRA card with KPI sub-rows */
              <div key={kra.id} style={{ border: '1px solid #E2E8F0', borderRadius: 12, marginBottom: 12, background: '#fff', overflow: 'hidden' }}>
                {/* KRA header */}
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 160px 90px 36px', gap: '8px 12px', alignItems: 'center', padding: '10px 12px', background: '#F8FBFF', borderBottom: '1px solid #E9EEF5' }}>
                  <div>
                    <div style={{ fontSize: 9.5, fontWeight: 700, color: '#94A3B8', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 4 }}>KRA</div>
                    <input style={inputStyle} placeholder="e.g. Revenue Growth" value={kra.name} onChange={e => updateKra(kra.id, 'name', e.target.value)} onBlur={e => updateKra(kra.id, 'name', sanitizeGoalName(e.target.value))} />
                  </div>
                  <div>
                    <div style={{ fontSize: 9.5, fontWeight: 700, color: '#94A3B8', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 4 }}>Perspective</div>
                    <select style={selectStyle} value={kra.perspId} onChange={e => updateKra(kra.id, 'perspId', e.target.value)}>
                      {perspectives.map(p => <option key={p.id} value={p.id}>{p.name || `Perspective ${p.id}`}</option>)}
                    </select>
                  </div>
                  <div>
                    <div style={{ fontSize: 9.5, fontWeight: 700, color: '#94A3B8', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 4 }}>KRA Weight</div>
                    <input style={{ ...inputStyle, textAlign: 'center' }} inputMode="decimal" placeholder="%" value={kra.weight} onChange={e => updateKra(kra.id, 'weight', e.target.value)} />
                  </div>
                  <button onClick={() => removeKra(kra.id)} style={{ width: 34, height: 34, borderRadius: 10, background: '#FFF1F2', border: '1px solid #FECDD3', cursor: 'pointer', color: '#DC2626', fontSize: 15, lineHeight: 1, fontFamily: 'inherit', alignSelf: 'flex-end' }}>✕</button>
                </div>
                {/* KPI sub-rows */}
                <div style={{ padding: '8px 12px 10px 24px', borderLeft: '3px solid #EFF4FF' }}>
                  {(kra.kpis || []).length > 0 && (
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 80px 28px', gap: '4px 8px', marginBottom: 4, padding: '0 2px' }}>
                      <div style={{ fontSize: 9.5, fontWeight: 700, color: '#CBD5E1', textTransform: 'uppercase', letterSpacing: '0.06em' }}>KPI name</div>
                      <div style={{ fontSize: 9.5, fontWeight: 700, color: '#CBD5E1', textTransform: 'uppercase', letterSpacing: '0.06em', textAlign: 'center' }}>Weight %</div>
                      <div />
                    </div>
                  )}
                  {(kra.kpis || []).map(kpi => (
                    <div key={kpi.id} style={{ display: 'grid', gridTemplateColumns: '1fr 80px 28px', gap: '4px 8px', alignItems: 'center', marginBottom: 6 }}>
                      <input style={{ ...inputStyle, fontSize: 12 }} placeholder="e.g. % Revenue vs Target" value={kpi.name} onChange={e => updateKpi(kra.id, kpi.id, 'name', e.target.value)} onBlur={e => updateKpi(kra.id, kpi.id, 'name', sanitizeGoalName(e.target.value))} />
                      <input style={{ ...inputStyle, textAlign: 'center', fontSize: 12 }} inputMode="decimal" placeholder="%" value={kpi.weight} onChange={e => updateKpi(kra.id, kpi.id, 'weight', e.target.value)} />
                      <button onClick={() => removeKpi(kra.id, kpi.id)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#DC2626', fontSize: 13, padding: 0, lineHeight: 1, fontFamily: 'inherit' }}>✕</button>
                    </div>
                  ))}
                  <button onClick={() => addKpi(kra.id)} style={{ fontSize: 12, color: TREE_BLUE, background: 'none', border: `1px dashed ${TREE_BLUE}40`, borderRadius: 6, padding: '3px 10px', cursor: 'pointer', fontWeight: 500, fontFamily: 'inherit' }}>
                    + Add KPI
                  </button>
                </div>
              </div>
            ))}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 12, gap: 12, flexWrap: 'wrap' }}>
              <button onClick={addKra} style={{ fontSize: 13, color: '#2563EB', background: '#EFF6FF', border: '1px solid #BFDBFE', borderRadius: 10, padding: '8px 14px', cursor: 'pointer', fontWeight: 600, fontFamily: 'inherit' }}>
                + Add KRA
              </button>
              {currentKras.length > 0 && (
                <div style={{ fontSize: 13, fontWeight: 700, color: totalWeight === 100 ? '#16A34A' : '#DC2626' }}>
                  Total: {totalWeight}% {totalWeight === 100 ? '✓ ready' : '— should equal 100%'}
                </div>
              )}
            </div>
        </div>
      </div>

      {/* Confirm library button — only shown when update is available (StepKRALibrary context) */}
      {update && (() => {
        const totalKras = segments.reduce((sum, seg) => sum + (kras[seg.id]?.length || 0), 0);
        const { parsedData, errors } = validateManualLibrary();
        const isValid = totalKras > 0 && errors.length === 0;
        return (
          <div style={{ marginTop: 20, display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 12 }}>
            <button
              type="button"
              disabled={!isValid}
              onClick={() => {
                if (!isValid) {
                  setManualError(errors[0]?.message || 'Fix the manual KRA library issues before confirming.');
                  return;
                }
                update('goalLibraryData', parsedData);
                update('employeeUploadData', null);
                setManualError('');
              }}
              style={{
                padding: '10px 22px', border: 'none', borderRadius: 9, fontSize: 13.5, fontWeight: 700,
                cursor: !isValid ? 'not-allowed' : 'pointer',
                background: isGoalLibraryValid(config) ? '#16A34A' : !isValid ? '#CBD5E1' : '#2563EB',
                color: '#fff', fontFamily: 'inherit',
                boxShadow: isValid ? '0 4px 12px rgba(37,99,235,.25)' : 'none',
              }}
            >
              {isGoalLibraryValid(config) ? '✓ Library Confirmed' : 'Confirm Library →'}
            </button>
          </div>
        );
      })()}
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────────────
   GOAL CREATION STRATEGY STEP
   New 3-mode system: prefill | library | free (can combine, per group)
───────────────────────────────────────────────────────────────────────────── */

const GOAL_MODES = [
  {
    id: 'free',
    icon: '✏️',
    title: 'Free Creation',
    desc: 'Employee creates all goals from a blank canvas. No library or pre-fill.',
    color: '#2563EB',
    bg: '#EFF6FF',
    border: '#BFDBFE',
  },
  {
    id: 'library',
    icon: '📚',
    title: 'Reference Library',
    desc: 'A browsable panel on the employee page. They drag-drop KRAs into their goal plan.',
    color: '#2563EB',
    bg: '#EFF6FF',
    border: '#BFDBFE',
  },
  {
    id: 'prefill',
    icon: '📋',
    title: 'Pre-fill Goals',
    desc: 'Admin assigns KRAs/KPIs that appear ready-made in the employee workspace.',
    color: '#2563EB',
    bg: '#EFF6FF',
    border: '#BFDBFE',
  },
];

const SEG_ATTRS = ['Company', 'Department', 'Grade', 'Band', 'Role', 'Location', 'Division', 'Business Unit'];

function makeDefaultGroup(overrides = {}) {
  return {
    id: `grp_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    name: 'All Employees',
    segmentAttr: null,
    segmentValues: [],
    libraryAssignments: [],
    canEditOwn: true,
    prefillType: null,
    hasLibrary: false,
    libraryId: null,
    ...overrides,
  };
}

function GoalGroupCard({ group, index, isDefault, isOnlyGroup, segAttr, onUpdate, onDelete }) {
  const hasPrefill = group.modes?.includes('prefill');
  const hasLibrary = group.modes?.includes('library');
  const needsDataUpload = hasPrefill || hasLibrary;

  function toggleMode(modeId) {
    const current = group.modes || [];
    const next = current.includes(modeId) ? current.filter(m => m !== modeId) : [...current, modeId];
    if (next.length === 0) return; // at least one mode required
    onUpdate({ modes: next });
  }

  const S = { // shared styles
    sectionTitle: { fontSize: 11, fontWeight: 700, color: '#64748B', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 10 },
    input: { width: '100%', border: '1px solid #D1D5DB', borderRadius: 6, padding: '7px 10px', fontSize: 13, outline: 'none', boxSizing: 'border-box' },
    row: { display: 'flex', gap: 10, alignItems: 'center' },
    chip: (active, color) => ({
      display: 'inline-flex', alignItems: 'center', gap: 5,
      padding: '4px 10px', borderRadius: 20, fontSize: 11.5, fontWeight: 600, cursor: 'pointer', userSelect: 'none',
      border: `1.5px solid ${active ? color : '#D1D5DB'}`,
      background: active ? '#EFF6FF' : '#F9FAFB',
      color: active ? color : '#6B7280',
    }),
    select: { border: '1px solid #D1D5DB', borderRadius: 6, padding: '7px 10px', fontSize: 13, outline: 'none', background: '#fff' },
  };

  return (
    <div style={{ background: '#fff', border: '1.5px solid #E2E8F0', borderRadius: 12, marginBottom: 10, overflow: 'hidden' }}>
      {/* Card header */}
      <div style={{ padding: '14px 20px', borderBottom: '1px solid #F1F5F9', display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: isDefault ? '#FAFBFF' : '#fff' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ width: 28, height: 28, borderRadius: 8, background: isDefault ? '#EFF6FF' : '#F1F5F9', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 14, fontWeight: 700, color: '#2563EB' }}>
            {isDefault ? '★' : String(index + 1)}
          </div>
          <input
            value={group.name}
            onChange={e => onUpdate({ name: e.target.value })}
            style={{ fontSize: 14, fontWeight: 700, color: '#111827', border: 'none', outline: 'none', background: 'transparent', padding: '2px 0', minWidth: 120 }}
            placeholder="Group name"
          />
          {isDefault && <span style={{ fontSize: 11, color: '#9CA3AF', background: '#F1F5F9', padding: '2px 8px', borderRadius: 10 }}>Default — catches unmatched employees</span>}
        </div>
        {!isDefault && !isOnlyGroup && (
          <button
            type="button" onClick={onDelete}
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#DC2626', fontSize: 13, padding: '4px 8px', borderRadius: 6, lineHeight: 1 }}
          >✕ Remove</button>
        )}
      </div>

      <div style={{ padding: '16px 20px' }}>
        {/* Segment filter — shown for non-catch-all groups when multiple groups exist */}
        {!isDefault && !isOnlyGroup && (
          <div style={{ marginBottom: 16, padding: '12px 16px', background: '#F8FAFC', borderRadius: 8, border: '1px solid #E9EEF5' }}>
            <div style={S.sectionTitle}>Select Employees By</div>
            <div style={{ marginBottom: 10 }}>
              <div style={{ fontSize: 11.5, color: '#6B7280', marginBottom: 6 }}>Attribute</div>
              <SegmentAttributeInput
                value={group.segmentAttr || ''}
                onChange={v => onUpdate({ segmentAttr: v })}
              />
            </div>
            <div>
              <div style={{ fontSize: 11.5, color: '#6B7280', marginBottom: 6 }}>Values</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
                {(group.segmentValues || []).map((v, i) => (
                  <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 5, background: '#EFF4FF', border: '1.5px solid #BFCFFE', borderRadius: 8, padding: '4px 10px' }}>
                    <span style={{ fontSize: 13, color: '#1e40af', fontWeight: 500 }}>{v}</span>
                    <button
                      type="button"
                      onClick={() => onUpdate({ segmentValues: (group.segmentValues || []).filter((_, j) => j !== i) })}
                      style={{ border: 'none', background: 'transparent', color: '#94A3B8', cursor: 'pointer', padding: 0, fontSize: 13, lineHeight: 1 }}
                    >×</button>
                  </div>
                ))}
                <SegmentValueInput
                  attrKey={group.segmentAttr || 'Department'}
                  existingValues={group.segmentValues || []}
                  onAdd={v => onUpdate({ segmentValues: [...(group.segmentValues || []), v] })}
                />
              </div>
            </div>
            <div style={{ fontSize: 11.5, color: '#6B7280', marginTop: 8 }}>
              Employees whose <strong>{group.segmentAttr || 'attribute'}</strong> matches these values will follow this group's configuration.
            </div>
          </div>
        )}

        {/* Mode selection */}
        <div style={{ marginBottom: 16 }}>
          <div style={S.sectionTitle}>Goal Creation Modes</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10 }}>
            {GOAL_MODES.map(mode => {
              const active = group.modes?.includes(mode.id);
              return (
                <div
                  key={mode.id}
                  onClick={() => toggleMode(mode.id)}
                  style={{
                    padding: '12px 14px', borderRadius: 10, cursor: 'pointer', userSelect: 'none',
                    border: `2px solid ${active ? '#2563EB' : '#E2E8F0'}`,
                    background: active ? '#EFF6FF' : '#fff',
                    boxShadow: active ? '0 0 0 1px rgba(37,99,235,0.08)' : 'none',
                    transition: 'border-color .14s ease, background .14s ease, box-shadow .14s ease',
                  }}
                >
                  <div style={{ fontSize: 20, marginBottom: 4, opacity: active ? 1 : 0.72 }}>{mode.icon}</div>
                  <div style={{ fontWeight: 700, fontSize: 13, color: active ? '#1D4ED8' : '#374151', marginBottom: 3 }}>{mode.title}</div>
                  <div style={{ fontSize: 11, color: '#6B7280', lineHeight: 1.4 }}>{mode.desc}</div>
                  <div style={{ marginTop: 8 }}>
                    <span style={S.chip(active, '#2563EB')}>{active ? '✓ Enabled' : '+ Enable'}</span>
                  </div>
                </div>
              );
            })}
          </div>
          {group.modes?.length === 0 && (
            <div style={{ fontSize: 12, color: '#DC2626', marginTop: 6 }}>Select at least one mode.</div>
          )}
        </div>

        {/* Data upload notice */}
        {needsDataUpload && (
          <div style={{ padding: '10px 14px', background: '#EFF6FF', border: '1px solid #BFDBFE', borderRadius: 8, marginBottom: 14, fontSize: 12.5, color: '#1E40AF' }}>
            <strong>{hasPrefill && hasLibrary ? 'Pre-fill data + library data' : hasPrefill ? 'Pre-fill data' : 'Library data'}</strong> will be uploaded in the next step as a flat KRA/KPI list. No perspective mapping is required.
          </div>
        )}

        {/* Pre-fill settings */}
        {hasPrefill && (
          <div style={{ padding: '12px 16px', background: '#EFF6FF', borderRadius: 8, marginBottom: 12, border: '1px solid #BFDBFE' }}>
            <div style={S.sectionTitle}>Pre-fill Settings</div>
            <div style={{ ...S.row, marginBottom: 10 }}>
              <label style={{ fontSize: 13, color: '#374151', minWidth: 200 }}>Employees can edit pre-filled goals?</label>
              <select
                value={group.prefillEditability || 'add-kpis'}
                onChange={e => onUpdate({ prefillEditability: e.target.value })}
                style={S.select}
              >
                <option value="locked">🔒 Frozen — view and submit as-is</option>
                <option value="add-kpis">✏️ Can add extra KPIs to existing KRAs</option>
                <option value="edit-freely">🔓 Can freely edit and add anything</option>
              </select>
            </div>
            {/* Library-as-reference note when goals are frozen */}
            {(group.prefillEditability === 'locked' || !group.prefillEditability) && hasLibrary && (
              <div style={{ padding: '8px 12px', background: '#F5F3FF', border: '1px solid #DDD6FE', borderRadius: 6, marginBottom: 10, fontSize: 12, color: '#6D28D9' }}>
                📚 <strong>Goal Library will appear as a read-only reference panel</strong> — employees can browse and view KRAs from the library for context, but since goals are frozen, they cannot add from it.
              </div>
            )}
            {(group.prefillEditability === 'add-kpis' || group.prefillEditability === 'edit-freely') && hasLibrary && (
              <div style={{ padding: '8px 12px', background: '#F5F3FF', border: '1px solid #DDD6FE', borderRadius: 6, marginBottom: 10, fontSize: 12, color: '#6D28D9' }}>
                📚 <strong>Goal Library will appear as an interactive panel</strong> — employees can browse and pull KRAs from it in addition to their pre-filled goals.
              </div>
            )}
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: '#374151', cursor: 'pointer' }}>
              <input type="checkbox" checked={!!group.kpiWeightsEnabled} onChange={e => onUpdate({ kpiWeightsEnabled: e.target.checked })} />
              Include KPI weights in pre-filled data
            </label>
          </div>
        )}

        {/* Goal limits + weights */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          {/* Goal limits */}
          <div style={{ padding: '12px 16px', background: '#F8FAFC', borderRadius: 8, border: '1px solid #E9EEF5' }}>
            <div style={S.sectionTitle}>Goal Count Limits</div>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: 'pointer', marginBottom: 8 }}>
              <input type="checkbox" checked={!!group.goalLimitsEnabled} onChange={e => onUpdate({ goalLimitsEnabled: e.target.checked })} />
              Set min / max KRA limits
            </label>
            {group.goalLimitsEnabled && (
              <div style={{ ...S.row, gap: 16 }}>
                <div>
                  <div style={{ fontSize: 11.5, color: '#6B7280', marginBottom: 3 }}>Min KRAs</div>
                  <input type="number" min={1} value={group.goalMin || 3} onChange={e => onUpdate({ goalMin: Math.max(1, Number(e.target.value)) })}
                    style={{ ...S.input, width: 70 }} />
                </div>
                <div>
                  <div style={{ fontSize: 11.5, color: '#6B7280', marginBottom: 3 }}>Max KRAs</div>
                  <input type="number" min={1} value={group.goalMax || 8} onChange={e => onUpdate({ goalMax: Math.max(1, Number(e.target.value)) })}
                    style={{ ...S.input, width: 70 }} />
                </div>
              </div>
            )}
          </div>

          {/* Weights */}
          <div style={{ padding: '12px 16px', background: '#F8FAFC', borderRadius: 8, border: '1px solid #E9EEF5' }}>
            <div style={S.sectionTitle}>Weightage</div>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: 'pointer', marginBottom: 8 }}>
              <input type="checkbox" checked={group.kraWeightsEnabled !== false} onChange={e => onUpdate({ kraWeightsEnabled: e.target.checked })} />
              KRA weights required
            </label>
            {!hasPrefill && (
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: 'pointer' }}>
                <input type="checkbox" checked={!!group.kpiWeightsEnabled} onChange={e => onUpdate({ kpiWeightsEnabled: e.target.checked })} />
                KPI weights required
              </label>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ─── STEP GROUPS ────────────────────────────────────────────────────────── */

function getGroupResult(group) {
  const prefill = group.prefillType || null;
  const edit    = group.canEditOwn !== false;
  const lib     = !!group.hasLibrary;
  if (!prefill && !edit) return null;
  if (!prefill && edit && !lib)  return { title: 'Open Canvas',            desc: 'Employees start from a blank page and build their own KRAs and KPIs freely within each perspective.', chips: ['✏️ Edit Own'],                              color: '#16A34A', bg: '#F0FDF4', border: '#86EFAC' };
  if (!prefill && edit &&  lib)  return { title: 'Guided Scratch',          desc: 'Employees build freely from scratch with a curated goal library available as reference and inspiration.', chips: ['✏️ Edit Own', '📚 Library'],                color: '#2563EB', bg: '#EFF6FF', border: '#93C5FD' };
  if (prefill === 'kra-kpi' && !edit && !lib) return { title: 'Fully Locked Prefill', desc: 'Admin pre-assigns the complete KRA + KPI structure. Employees view their goals — no edits allowed.', chips: ['📋 Prefill (KRA+KPI)', '🔒 Locked'],   color: '#DC2626', bg: '#FEF2F2', border: '#FCA5A5' };
  if (prefill === 'kra-only' && !edit && !lib) return { title: 'Prefill — KRAs Locked', desc: 'KRAs are pre-assigned. Employees create their own KPIs under each locked KRA.', chips: ['📋 Prefill (KRAs only)', '🔒 KRAs locked'],             color: '#D97706', bg: '#FFFBEB', border: '#FCD34D' };
  if (prefill === 'kra-only' && !edit &&  lib) return { title: 'Locked Prefill + Library', desc: 'KRAs are locked by admin. Employees pull KPIs from the goal library to complete their goals.', chips: ['📋 Prefill (KRAs only)', '🔒 Locked', '📚 Library'], color: '#7C3AED', bg: '#F5F3FF', border: '#C4B5FD' };
  if (prefill && edit && !lib) return { title: 'Partial Prefill + Edit',   desc: 'Admin sets the foundation. Employees can adjust pre-filled goals and add their own on top.', chips: ['📋 Prefill', '✏️ Edit Own'],                         color: '#0891B2', bg: '#ECFEFF', border: '#67E8F9' };
  if (prefill && edit &&  lib) return { title: 'Full Flexibility',          desc: 'Admin sets a foundation. Employees can edit, add their own goals, and browse the library for inspiration.', chips: ['📋 Prefill', '✏️ Edit Own', '📚 Library'], color: '#2563EB', bg: '#EFF6FF', border: '#93C5FD' };
  return null;
}

function GroupStrategyCard({ group, index, totalGroups, onUpdate, onDelete, libraries = [] }) {
  const isOnly = totalGroups === 1;
  const hasNoFilter = !group.segmentAttr && !(group.segmentValues || []).length;
  const canUseGoalLibrary = canUseGroupLibrary(group);
  const goalLibraryEnabled = isGroupLibraryEnabled(group);
  const result = getGroupResult(group);
  const comboKey = `${group.prefillType || 'none'}-${group.canEditOwn !== false}-${group.hasLibrary}`;
  const currentLibType = group.libraryType || 'kra-only';

  const S = {
    sectionLabel: { fontSize: 11, fontWeight: 700, color: '#64748B', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 8 },
  };

  return (
    <div style={{ background: '#fff', border: '1.5px solid #E2E8F0', borderRadius: 14, marginBottom: 12, overflow: 'hidden' }}>
      {/* Header */}
      <div style={{ padding: '14px 20px', borderBottom: '1px solid #F1F5F9', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ width: 30, height: 30, borderRadius: 9, background: '#F1F5F9', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, fontWeight: 700, color: '#2563EB' }}>
            {index + 1}
          </div>
          <input
            value={group.name}
            onChange={e => onUpdate({ name: e.target.value })}
            style={{ fontSize: 14, fontWeight: 700, color: '#111827', border: 'none', outline: 'none', background: 'transparent', padding: '2px 0', minWidth: 120, fontFamily: 'inherit' }}
            placeholder="Group name"
          />
          {!isOnly && hasNoFilter && (
            <span style={{ fontSize: 11, color: '#9CA3AF', background: '#F8FAFC', border: '1px solid #E2E8F0', padding: '2px 8px', borderRadius: 10 }}>Matches all unassigned employees</span>
          )}
        </div>
        {!isOnly && (
          <button type="button" onClick={onDelete} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#DC2626', fontSize: 12.5, padding: '4px 8px', borderRadius: 6, fontFamily: 'inherit' }}>
            ✕ Remove
          </button>
        )}
      </div>

      <div style={{ padding: '16px 20px' }}>
        {/* Segment filter — always visible, optional to fill */}
        <div style={{ marginBottom: 16, padding: '12px 16px', background: '#F8FAFC', borderRadius: 8, border: '1px solid #E9EEF5' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
            <div style={S.sectionLabel}>Select Employees By</div>
            {hasNoFilter && <span style={{ fontSize: 11, color: '#9CA3AF', fontStyle: 'italic' }}>Leave blank to match all employees</span>}
          </div>
          <div style={{ marginBottom: 8 }}>
            <SegmentAttributeInput value={group.segmentAttr || ''} onChange={v => onUpdate({ segmentAttr: v })} />
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
            {(group.segmentValues || []).map((v, i) => (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 4, background: '#EFF4FF', border: '1.5px solid #BFCFFE', borderRadius: 8, padding: '3px 10px' }}>
                <span style={{ fontSize: 12.5, color: '#1e40af', fontWeight: 500 }}>{v}</span>
                <button type="button" onClick={() => onUpdate({ segmentValues: group.segmentValues.filter((_, j) => j !== i) })} style={{ border: 'none', background: 'transparent', color: '#94A3B8', cursor: 'pointer', padding: 0, fontSize: 13, lineHeight: 1, marginLeft: 2 }}>×</button>
              </div>
            ))}
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', gap: 12, marginTop: 10, flexWrap: 'wrap' }}>
            <SegmentValueInput
              attrKey={group.segmentAttr || 'Department'}
              existingValues={group.segmentValues || []}
              onAdd={v => onUpdate({ segmentValues: [...(group.segmentValues || []), v] })}
            />
            <AttributeSheetControls
              attrLabel={group.segmentAttr || 'Department'}
              values={group.segmentValues || []}
              onImported={(importedValues) => onUpdate({ segmentValues: importedValues })}
            />
          </div>
          {group.segmentAttr && (group.segmentValues || []).length > 0 && (
            <div style={{ fontSize: 11.5, color: '#9CA3AF', marginTop: 6 }}>
              Employees where <strong style={{ color: '#374151' }}>{group.segmentAttr}</strong> = {group.segmentValues.join(', ')} land in this group.
            </div>
          )}
        </div>

        {/* Goal Approach — 3 independent toggles */}
        <div style={{ marginBottom: 16 }}>
          <div style={S.sectionLabel}>Goal Approach</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>

            {/* 1. Pre-fill */}
            <div style={{ borderRadius: 10, border: `1.5px solid ${group.prefillType ? '#2563EB' : '#E2E8F0'}`, background: group.prefillType ? '#EFF6FF' : '#FAFAFA', overflow: 'hidden' }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px', cursor: 'pointer', userSelect: 'none' }}>
                <input
                  type="checkbox"
                  checked={!!group.prefillType}
                  onChange={e => onUpdate({ prefillType: e.target.checked ? 'kra-only' : null })}
                  style={{ width: 16, height: 16, accentColor: '#2563EB', cursor: 'pointer', flexShrink: 0 }}
                />
                <div>
                  <div style={{ fontWeight: 700, fontSize: 13, color: group.prefillType ? '#1D4ED8' : '#374151' }}>📋 Pre-fill Goals</div>
                  <div style={{ fontSize: 12, color: '#6B7280', marginTop: 1 }}>Admin assigns KRAs (and optionally KPIs) that appear ready-made for employees.</div>
                </div>
              </label>
              {group.prefillType && (
                <div style={{ borderTop: '1px solid #DBEAFE', padding: '10px 16px', display: 'flex', gap: 8 }}>
                  {[
                    { id: 'kra-only', label: 'KRAs only', sub: 'Employees create their own KPIs' },
                    { id: 'kra-kpi',  label: 'KRAs + KPIs', sub: 'Full goal structure pre-filled' },
                  ].map(opt => (
                    <button key={opt.id} type="button" onClick={() => onUpdate({ prefillType: opt.id })} style={{
                      flex: 1, padding: '8px 12px', borderRadius: 8, cursor: 'pointer', textAlign: 'left', fontFamily: 'inherit',
                      border: `1.5px solid ${group.prefillType === opt.id ? '#2563EB' : '#D1D5DB'}`,
                      background: group.prefillType === opt.id ? '#fff' : '#F9FAFB',
                    }}>
                      <div style={{ fontSize: 12.5, fontWeight: 600, color: group.prefillType === opt.id ? '#1D4ED8' : '#374151' }}>{opt.label}</div>
                      <div style={{ fontSize: 11, color: '#9CA3AF', marginTop: 2 }}>{opt.sub}</div>
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* 2. Edit own */}
            <label style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px', cursor: 'pointer', userSelect: 'none', borderRadius: 10, border: `1.5px solid ${group.canEditOwn !== false ? '#16A34A' : '#E2E8F0'}`, background: group.canEditOwn !== false ? '#F0FDF4' : '#FAFAFA' }}>
              <input
                type="checkbox"
                checked={group.canEditOwn !== false}
                onChange={e => onUpdate({ canEditOwn: e.target.checked })}
                style={{ width: 16, height: 16, accentColor: '#16A34A', cursor: 'pointer', flexShrink: 0 }}
              />
              <div>
                <div style={{ fontWeight: 700, fontSize: 13, color: group.canEditOwn !== false ? '#15803D' : '#374151' }}>✏️ Employees can add / edit their own goals</div>
                <div style={{ fontSize: 12, color: '#6B7280', marginTop: 1 }}>
                  {group.prefillType
                    ? 'Pre-filled KRAs can be supplemented or adjusted by the employee.'
                    : 'Employees start from a blank canvas and build their own KRAs/KPIs.'}
                </div>
              </div>
            </label>

            {/* 3. Goal Library */}
            <div style={{ borderRadius: 10, border: `1.5px solid ${goalLibraryEnabled ? '#7C3AED' : '#E2E8F0'}`, background: goalLibraryEnabled ? '#F5F3FF' : '#FAFAFA', overflow: 'hidden' }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px', cursor: 'pointer', userSelect: 'none' }}>
                <input
                  type="checkbox"
                  checked={goalLibraryEnabled}
                  onChange={e => onUpdate({ hasLibrary: e.target.checked, libraryType: e.target.checked ? (group.libraryType || 'kra-only') : undefined })}
                  style={{ width: 16, height: 16, accentColor: '#7C3AED', cursor: 'pointer', flexShrink: 0 }}
                />
                <div>
                  <div style={{ fontWeight: 700, fontSize: 13, color: goalLibraryEnabled ? '#6D28D9' : '#374151' }}>📚 Attach Goal Library</div>
                  <div style={{ fontSize: 12, color: '#6B7280', marginTop: 1 }}>A curated library that employees can browse and pull goals from as a reference.</div>
                </div>
              </label>
              {goalLibraryEnabled && (
                <div style={{ borderTop: '1px solid #DDD6FE', padding: '12px 16px' }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: '#7C3AED', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 8 }}>What will this library contain?</div>
                  <div style={{ display: 'flex', gap: 8 }}>
                    {[
                      { id: 'kra-only', icon: '📌', label: 'KRAs only',   sub: 'Employees create their own KPIs' },
                      { id: 'kra-kpi',  icon: '📊', label: 'KRAs + KPIs', sub: 'Full goal structure provided' },
                    ].map(opt => (
                      <button key={opt.id} type="button" onClick={() => onUpdate({ libraryType: opt.id })} style={{
                        flex: 1, padding: '9px 12px', borderRadius: 8, cursor: 'pointer', textAlign: 'left', fontFamily: 'inherit',
                        border: `1.5px solid ${currentLibType === opt.id ? '#7C3AED' : '#DDD6FE'}`,
                        background: currentLibType === opt.id ? '#EDE9FE' : '#fff',
                      }}>
                        <div style={{ fontSize: 13, marginBottom: 2 }}>{opt.icon}</div>
                        <div style={{ fontSize: 12.5, fontWeight: 700, color: currentLibType === opt.id ? '#6D28D9' : '#374151' }}>{opt.label}</div>
                        <div style={{ fontSize: 11, color: '#9CA3AF', marginTop: 1 }}>{opt.sub}</div>
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* Warning if both unchecked */}
            {!group.prefillType && group.canEditOwn === false && (
              <div style={{ padding: '8px 12px', background: '#FEF2F2', border: '1px solid #FCA5A5', borderRadius: 8, fontSize: 12, color: '#DC2626' }}>
                ⚠️ Enable at least one of Pre-fill or Edit Own — otherwise employees have no way to create goals.
              </div>
            )}
          </div>
        </div>

        {/* ── Animated Result Strip ── */}
        <style>{`@keyframes grpResultIn{from{opacity:0;transform:translateY(5px)}to{opacity:1;transform:translateY(0)}}`}</style>
        {result && (
          <div
            key={comboKey}
            style={{
              margin: '0 16px 16px',
              borderRadius: 10,
              border: `1.5px solid ${result.border}`,
              background: result.bg,
              padding: '12px 16px',
              animation: 'grpResultIn 0.22s ease',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, flexWrap: 'wrap' }}>
              {result.chips.map(chip => (
                <span key={chip} style={{ fontSize: 11.5, fontWeight: 600, color: result.color, background: '#fff', border: `1px solid ${result.border}`, borderRadius: 20, padding: '2px 10px' }}>{chip}</span>
              ))}
            </div>
            <div style={{ fontSize: 13, fontWeight: 700, color: result.color, marginBottom: 3 }}>{result.title}</div>
            <div style={{ fontSize: 12, color: '#4B5563', lineHeight: 1.55 }}>{result.desc}</div>
          </div>
        )}
      </div>
    </div>
  );
}

function StepGroups({ config, update }) {
  const groups = config.goalGroups || [];
  const libraries = config.goalLibraries || [];

  const isValid = groups.length > 0 && groups.every(g => g.prefillType || g.canEditOwn !== false);
  const isApplied = isValid && config.goalGroupsAppliedSnapshot === getNewGroupsSnapshot(config);

  function updateGroup(id, changes) {
    update('goalGroups', groups.map(g => g.id === id ? normalizeSimpleGoalGroup({ ...g, ...changes }) : g));
    update('goalGroupsAppliedSnapshot', null);
    update('prefillDataAppliedSnapshot', null);
    update('goalLibrariesAppliedSnapshot', null);
  }

  function removeGroup(id) {
    update('goalGroups', groups.filter(g => g.id !== id));
    update('goalGroupsAppliedSnapshot', null);
    update('prefillDataAppliedSnapshot', null);
    update('goalLibrariesAppliedSnapshot', null);
  }

  function addGroup() {
    const newGroup = {
      id: `grp_${Date.now()}_${Math.random().toString(36).slice(2, 5)}`,
      name: `Group ${groups.length + 1}`,
      segmentAttr: '',
      segmentValues: [],
      libraryAssignments: [],
      canEditOwn: true,
      prefillType: null,
      hasLibrary: false,
      libraryId: null,
    };
    update('goalGroups', [...groups, newGroup]);
    update('goalGroupsAppliedSnapshot', null);
    update('prefillDataAppliedSnapshot', null);
    update('goalLibrariesAppliedSnapshot', null);
  }

  return (
    <div style={{ maxWidth: 1080, margin: '0 auto', paddingBottom: 40 }}>
      <div style={{ marginBottom: 28 }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: '#94A3B8', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 6 }}>Groups & Strategy</div>
        <h2 style={{ margin: 0, fontSize: 22, fontWeight: 800, color: '#0F172A' }}>Who gets what goal approach?</h2>
        <p style={{ margin: '8px 0 0', fontSize: 14, color: '#64748B', lineHeight: 1.6 }}>
          Define employee groups and choose how each group will create goals. Use <strong>Company</strong> as the attribute if everyone follows the same approach.
        </p>
      </div>

      {groups.map((group, idx) => (
        <GroupStrategyCard
          key={group.id}
          group={group}
          index={idx}
          totalGroups={groups.length}
          onUpdate={changes => updateGroup(group.id, changes)}
          onDelete={() => removeGroup(group.id)}
          libraries={libraries}
        />
      ))}

      <button type="button" onClick={addGroup} style={{
        display: 'flex', alignItems: 'center', gap: 8,
        padding: '11px 18px', border: '1.5px dashed #93C5FD', borderRadius: 10,
        background: '#F0F7FF', color: '#2563EB', fontWeight: 600, fontSize: 13,
        cursor: 'pointer', marginBottom: 24, width: '100%', justifyContent: 'center', fontFamily: 'inherit',
      }}>
        + Add Employee Group
      </button>

      {/* Groups Summary Table — shown when all groups are configured */}
      {isValid && groups.length > 0 && (
        <div style={{ background: '#fff', border: '1.5px solid #E2E8F0', borderRadius: 12, marginBottom: 16, overflow: 'hidden' }}>
          <div style={{ padding: '12px 18px', borderBottom: '1px solid #F1F5F9', fontSize: 12, fontWeight: 700, color: '#64748B', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
            Configuration Summary
          </div>
          <div style={{ padding: '4px 0' }}>
            {groups.map((g, i) => {
              const r = getGroupResult(g);
              const ck = `${g.prefillType || 'none'}-${g.canEditOwn !== false}-${g.hasLibrary}`;
              return (
                <div key={g.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 18px', borderBottom: i < groups.length - 1 ? '1px solid #F8FAFC' : 'none' }}>
                  <div style={{ width: 24, height: 24, borderRadius: 7, background: '#F1F5F9', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 700, color: '#2563EB', flexShrink: 0 }}>{i + 1}</div>
                  <div style={{ fontWeight: 600, fontSize: 13, color: '#111827', minWidth: 140, flexShrink: 0 }}>{g.name}</div>
                  {r ? (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', flex: 1 }}>
                      {r.chips.map(chip => (
                        <span key={chip} style={{ fontSize: 11, fontWeight: 600, color: r.color, background: r.bg, border: `1px solid ${r.border}`, borderRadius: 20, padding: '2px 9px' }}>{chip}</span>
                      ))}
                      <span style={{ fontSize: 12, color: '#6B7280', marginLeft: 4 }}>— {r.title}</span>
                    </div>
                  ) : (
                    <span style={{ fontSize: 12, color: '#DC2626' }}>⚠️ Incomplete setup</span>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      <StepStatusBar
        applied={isApplied}
        valid={isValid}
        appliedMessage="Groups confirmed — configure Goal Libraries next."
        pendingMessage={groups.length === 0 ? 'Add at least one group.' : !groups.every(g => g.prefillType || g.canEditOwn !== false) ? 'Each group needs at least Pre-fill or Edit Own enabled.' : 'Review your groups above and confirm to proceed.'}
        buttonLabel="Confirm Groups"
        onApply={() => update('goalGroupsAppliedSnapshot', getNewGroupsSnapshot(config))}
      />
    </div>
  );
}

/* ─── STEP GOAL LIBRARIES ────────────────────────────────────────────────── */
const LIBRARY_BOARD_COLORS = [
  { bar: '#2563EB', soft: '#EFF6FF', text: '#1D4ED8' },
  { bar: '#7C3AED', soft: '#F5F3FF', text: '#6D28D9' },
  { bar: '#16A34A', soft: '#F0FDF4', text: '#15803D' },
  { bar: '#EA580C', soft: '#FFF7ED', text: '#C2410C' },
  { bar: '#DC2626', soft: '#FEF2F2', text: '#B91C1C' },
];

const DEFAULT_LIBRARY_SLOT_KEY = '__default__';

function getExpectedLibrarySlots(group) {
  const values = [...new Set((group?.segmentValues || []).map(v => String(v || '').trim()).filter(Boolean))];
  if (values.length === 0) {
    return [{ slotKey: DEFAULT_LIBRARY_SLOT_KEY, label: group?.name || 'All Employees' }];
  }
  return values.map(value => ({ slotKey: value, label: value }));
}

function getGroupLibraryAssignments(group) {
  const expected = getExpectedLibrarySlots(group);
  const existing = group?.libraryAssignments || [];
  return expected.map(slot => {
    const match = existing.find(assignment => assignment.slotKey === slot.slotKey);
    const fallbackLibraryId = expected.length === 1 ? (group?.libraryId || null) : null;
    return {
      ...slot,
      libraryId: match?.libraryId ?? fallbackLibraryId,
    };
  });
}

function getGroupPrefillAssignments(group) {
  const expected = getExpectedLibrarySlots(group);
  const existing = group?.prefillAssignments || [];
  const fallbackData = expected.length === 1 ? (group?.prefillData || []) : [];
  return expected.map(slot => {
    const match = existing.find(assignment => String(assignment?.slotKey || '').trim().toLowerCase() === slot.slotKey.toLowerCase());
    return {
      ...slot,
      data: Array.isArray(match?.data) ? match.data : fallbackData,
    };
  });
}

function setGroupLibraryAssignments(groups, groupId, nextAssignments) {
  return groups.map(group => {
    if (group.id !== groupId) return group;
    return {
      ...group,
      libraryAssignments: nextAssignments,
      libraryId: nextAssignments.find(assignment => assignment.libraryId)?.libraryId || null,
    };
  });
}

function setGroupPrefillAssignments(groups, groupId, nextAssignments) {
  return groups.map(group => {
    if (group.id !== groupId) return group;
    return {
      ...group,
      prefillAssignments: nextAssignments.map(assignment => ({
        slotKey: assignment.slotKey,
        label: assignment.label,
        data: assignment.data || [],
      })),
      prefillData: nextAssignments.length === 1 ? (nextAssignments[0]?.data || []) : [],
    };
  });
}

function getGroupLibraryLabel(group) {
  if (!group) return 'All groups';
  const attr = group.segmentAttr || 'Company';
  const values = (group.segmentValues || []).filter(Boolean);
  if (values.length === 0) return group.name || 'All employees';
  if (values.length === 1) return values[0];
  return `${attr}: ${values[0]} +${values.length - 1}`;
}

function LibraryCard({ library, groupLabel, assignedText, accent, active = false, onSelect, onEdit, onDelete, selectionHint, empty = false, warning = null }) {
  const kraCount = (library.perspectives || []).reduce((sum, perspective) => sum + (perspective.kras || []).length, 0);
  const kpiCount = (library.perspectives || []).reduce((sum, perspective) => (
    sum + (perspective.kras || []).reduce((nested, kra) => nested + (kra.kpis || []).length, 0)
  ), 0);

  return (
    <div style={{
      background: '#fff',
      border: `1px solid ${warning ? '#FCA5A5' : active ? accent.bar : '#E5E7EB'}`,
      borderRadius: 28,
      overflow: 'hidden',
      boxShadow: warning ? '0 12px 28px rgba(220,38,38,.08)' : active ? '0 18px 34px rgba(15,23,42,.08)' : '0 10px 24px rgba(15,23,42,.04)',
      transition: 'all .18s ease',
      cursor: onSelect ? 'pointer' : 'default',
      minHeight: 250,
      display: 'flex',
      flexDirection: 'column',
    }}>
      {warning && (
        <div onClick={onSelect} style={{ background: '#FEF2F2', color: '#991B1B', padding: '6px 14px', fontSize: 11.5, fontWeight: 700, borderBottom: '1px solid #FECACA', display: 'flex', alignItems: 'center', gap: 6 }}>
          <span aria-hidden="true">⚠</span>
          <span>{warning}</span>
        </div>
      )}
      <div onClick={onSelect} style={{ background: accent.soft, color: accent.text, padding: '14px 16px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, borderBottom: `1px solid ${active ? accent.bar : '#EEF2F7'}` }}>
        <div title={groupLabel} style={{ fontSize: 13, fontWeight: 800, letterSpacing: '0.01em', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0, flex: 1 }}>
          {groupLabel}
        </div>
        {assignedText ? (
          <span
            title={assignedText}
            style={{
              fontSize: 10,
              fontWeight: 600,
              padding: '0 8px',
              borderRadius: 6,
              background: 'rgba(148,163,184,.08)',
              color: accent.text,
              border: '1px solid rgba(148,163,184,.2)',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              height: 24,
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              flexShrink: 0,
            }}
          >
            {assignedText}
          </span>
        ) : null}
      </div>

      <div onClick={onSelect} style={{ padding: '20px 20px 16px', display: 'flex', flex: 1, flexDirection: 'column', justifyContent: 'space-between' }}>
        {empty ? (
          <>
            <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', flex: 1 }}>
              <div style={{ width: 98, height: 98, borderRadius: '50%', border: '1.5px solid #D7E3F4', background: '#FFFFFF', display: 'flex', alignItems: 'center', justifyContent: 'center', color: accent.text, fontSize: 54, lineHeight: 1 }}>
                +
              </div>
            </div>
            <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 10 }}>
              <div />
              <button
                type="button"
                onClick={(event) => { event.stopPropagation(); onEdit?.(); }}
                style={{
                  padding: '8px 16px',
                  borderRadius: 14,
                  border: '1px solid #D6E4FF',
                  background: '#F8FAFC',
                  color: '#2563EB',
                  fontWeight: 700,
                  fontSize: 13,
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                }}
              >
                Create
              </button>
            </div>
          </>
        ) : (
          <>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, marginBottom: 16 }}>
          <div>
            <div style={{ fontSize: 15, fontWeight: 800, color: '#111827', marginBottom: 6 }}>{library.name}</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 11, color: '#9CA3AF' }}>{kraCount} KRAs · {kpiCount} KPIs</span>
              <span style={{ fontSize: 10.5, color: '#94A3B8', background: '#F1F5F9', border: '1px solid #E2E8F0', borderRadius: 20, padding: '1px 8px', fontWeight: 500 }}>
                {library.type === 'kra-kpi' ? '📊 KRA + KPI' : '📌 KRA only'}
              </span>
            </div>
          </div>
          {onDelete ? (
            <button
              type="button"
              onClick={(event) => { event.stopPropagation(); onDelete?.(); }}
              style={{ border: 'none', background: 'transparent', color: '#DC2626', fontSize: 18, lineHeight: 1, cursor: 'pointer', padding: '2px 4px', fontFamily: 'inherit' }}
            >
              ×
            </button>
          ) : null}
        </div>

        <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 10, marginTop: 'auto' }}>
          <div style={{ fontSize: 11.5, color: active ? accent.text : '#9CA3AF', lineHeight: 1.5, maxWidth: 150 }}>
            {selectionHint || (active ? 'Currently assigned' : 'Click card to use it')}
          </div>
          <button
            type="button"
            onClick={(event) => { event.stopPropagation(); onEdit?.(); }}
            style={{
              padding: '8px 16px',
              borderRadius: 14,
              border: `1px solid ${active ? accent.bar : '#D6E4FF'}`,
              background: active ? accent.soft : '#F8FAFC',
              color: active ? accent.text : '#2563EB',
              fontWeight: 700,
              fontSize: 13,
              cursor: 'pointer',
              fontFamily: 'inherit',
            }}
          >
            Edit
          </button>
        </div>
          </>
        )}
      </div>
    </div>
  );
}

function getGroupPrefillUploadConfig(config, group) {
  return {
    ...config,
    goalGroups: [group],
    goalKpiMode: group?.prefillType === 'kra-kpi' ? 'kra-kpi' : 'kra-only',
    goalEmployeeEdit: group?.prefillEditability || 'add-kpis',
    goalLibraryScope: 'common',
    goalSegmentValues: [],
  };
}

function buildLegacyPrefillData(config, groupsOverride = null) {
  const groups = groupsOverride || config.goalGroups || [];
  const slotAssignments = groups
    .filter(group => !!group.prefillType)
    .flatMap(group => getGroupPrefillAssignments(group).map(assignment => ({
      group,
      assignment,
    })))
    .filter(({ assignment }) => Array.isArray(assignment.data) && assignment.data.length > 0);

  if (slotAssignments.length === 0) return null;

  const onlyAssignment = slotAssignments[0];
  const onlyGroup = onlyAssignment?.group;
  const onlyGroupHasSegments = ((onlyGroup?.segmentValues || []).map(value => String(value || '').trim()).filter(Boolean)).length > 0;
  if (slotAssignments.length === 1 && !onlyGroupHasSegments) {
    return { byAttr: false, attrLabel: null, data: flattenLibraryPerspectivesForValidation(onlyAssignment.assignment.data || []) };
  }

  const data = {};
  slotAssignments.forEach(({ group, assignment }) => {
    const key = String(assignment.label || group.name || 'All Employees').trim();
    if (!key) return;
    data[key] = flattenLibraryPerspectivesForValidation(assignment.data || []);
  });

  const attrLabel = slotAssignments.find(({ group }) => String(group?.segmentAttr || '').trim())?.group?.segmentAttr
    || config.goalSegmentAttr
    || 'Group';

  return {
    byAttr: true,
    attrLabel,
    data,
  };
}

function StepPrefillData({ config, update }) {
  const groups = config.goalGroups || [];
  const groupsNeedingPrefill = groupsNeedingPrefillData(config);
  const canShowAllGroups = groupsNeedingPrefill.length > 1;
  const [selectedGroupId, setSelectedGroupId] = useState(groupsNeedingPrefill[0]?.id || '');
  const [showAllGroups, setShowAllGroups] = useState(false);
  const [editingPrefillTarget, setEditingPrefillTarget] = useState(null);
  const [phase, setPhase] = useState('idle');
  const [errors, setErrors] = useState([]);
  const canShowGroupSwitcher = groupsNeedingPrefill.length > 1;

  const isValid = isPrefillDataValid(config);
  const isApplied = !!config.prefillDataAppliedSnapshot && isValid;

  useEffect(() => {
    if (showAllGroups && canShowAllGroups) return;
    if (!groupsNeedingPrefill.some(group => group.id === selectedGroupId)) {
      setSelectedGroupId(groupsNeedingPrefill[0]?.id || '');
    }
  }, [groupsNeedingPrefill, selectedGroupId, showAllGroups, canShowAllGroups]);

  const selectedGroup = groupsNeedingPrefill.find(group => group.id === selectedGroupId) || groupsNeedingPrefill[0] || null;
  const editingPrefillGroup = groupsNeedingPrefill.find(group => group.id === editingPrefillTarget?.groupId) || null;
  const editingPrefillAssignment = editingPrefillGroup
    ? getGroupPrefillAssignments(editingPrefillGroup).find(assignment => assignment.slotKey === editingPrefillTarget?.slotKey) || null
    : null;
  const boardSlots = ((showAllGroups && canShowAllGroups) ? groupsNeedingPrefill : (selectedGroup ? [selectedGroup] : []))
    .flatMap((group, groupIndex) =>
      getGroupPrefillAssignments(group).map((assignment, assignmentIndex) => ({
        group,
        assignment,
        accent: LIBRARY_BOARD_COLORS[(groupIndex + assignmentIndex) % LIBRARY_BOARD_COLORS.length],
      }))
    );

  function updatePrefillAssignments(groupId, nextAssignments) {
    const nextGroups = setGroupPrefillAssignments(groups, groupId, nextAssignments);
    update('goalGroups', nextGroups);
    update('goalLibraryData', buildLegacyPrefillData(config, nextGroups));
    update('prefillDataAppliedSnapshot', null);
  }

  function updatePrefillAssignmentData(groupId, slotKey, nextData) {
    const group = groups.find(item => item.id === groupId);
    if (!group) return;
    const nextAssignments = getGroupPrefillAssignments(group).map(assignment => (
      assignment.slotKey === slotKey ? { ...assignment, data: nextData } : assignment
    ));
    updatePrefillAssignments(groupId, nextAssignments);
  }

  function importPrefillLibraries(importedLibraries) {
    if (!selectedGroup) return;
    const normalizeLookup = value => String(value || '').trim().toLowerCase();
    const importedMap = new Map(
      (importedLibraries || []).map(library => [normalizeLookup(library.name), library])
    );
    const nextAssignments = getGroupPrefillAssignments(selectedGroup).map(assignment => {
      const match = importedMap.get(normalizeLookup(assignment.label));
      return {
        ...assignment,
        data: match?.perspectives || [],
      };
    });
    updatePrefillAssignments(selectedGroup.id, nextAssignments);
  }

  return (
    <div style={{ maxWidth: 1180, margin: '0 auto', paddingBottom: 40 }}>
      {editingPrefillGroup && editingPrefillAssignment && (
        <AddLibraryModal
          config={getGroupPrefillUploadConfig(config, editingPrefillGroup)}
          initialLibrary={{
            id: `${editingPrefillGroup.id}_${editingPrefillAssignment.slotKey}`,
            name: editingPrefillAssignment.label,
            type: editingPrefillGroup.prefillType === 'kra-kpi' ? 'kra-kpi' : 'kra-only',
            weightType: 'suggested',
            perspectives: editingPrefillAssignment.data || [],
          }}
          fixedName={editingPrefillAssignment.label}
          suggestedType={editingPrefillGroup.prefillType}
          lockType
          onSave={(library) => {
            updatePrefillAssignmentData(editingPrefillGroup.id, editingPrefillAssignment.slotKey, library.perspectives || []);
            setEditingPrefillTarget(null);
          }}
          onClose={() => setEditingPrefillTarget(null)}
        />
      )}

      <div style={{ marginBottom: 28 }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: '#94A3B8', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 6 }}>Pre-fill Data</div>
        <h2 style={{ margin: 0, fontSize: 22, fontWeight: 800, color: '#0F172A' }}>Upload pre-filled goals</h2>
        <p style={{ margin: '8px 0 0', fontSize: 14, color: '#64748B', lineHeight: 1.6, maxWidth: 820 }}>
          Each configured employee value becomes its own pre-fill card here. Upload or edit the KRAs or KRAs + KPIs that should appear ready-made for every card inside the selected group.
        </p>
      </div>

      <div style={{ background: 'linear-gradient(180deg, #FFFFFF 0%, #FCFDFE 100%)', border: '1px solid #E2E8F0', borderRadius: 34, padding: 30, marginBottom: 22, boxShadow: '0 20px 45px rgba(15,23,42,.05)' }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 220px', gap: 24, alignItems: 'stretch' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
            {(() => {
              const groupedSlots = [];
              const groupIdToIndex = {};
              boardSlots.forEach(slot => {
                if (groupIdToIndex[slot.group.id] === undefined) {
                  groupIdToIndex[slot.group.id] = groupedSlots.length;
                  groupedSlots.push({ group: slot.group, slots: [] });
                }
                groupedSlots[groupIdToIndex[slot.group.id]].slots.push(slot);
              });
              return groupedSlots.map(({ group, slots }) => (
                <div key={group.id}>
                  {(group.segmentAttr || ((showAllGroups && canShowAllGroups) && group.name)) && (
                    <div style={{ marginBottom: 10, display: 'flex', alignItems: 'center', gap: 6 }}>
                      {(showAllGroups && canShowAllGroups) && group.name && (
                        <span style={{ fontSize: 12, fontWeight: 700, color: '#374151' }}>{group.name}</span>
                      )}
                      {group.segmentAttr && (
                        <span style={{ background: '#F1F5F9', border: '1px solid #E2E8F0', borderRadius: 6, padding: '2px 8px', fontSize: 11, fontWeight: 600, color: '#64748B' }}>{group.segmentAttr}</span>
                      )}
                    </div>
                  )}
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(250px, 1fr))', gap: 18 }}>
                    {slots.map((slot) => {
                      const { group, assignment, accent } = slot;
                      const uploadedCount = (assignment.data || []).length;
                      const prefillKraCount = flattenLibraryPerspectivesForValidation(assignment.data || []).length;
                      const prefillLabel = group.prefillType === 'kra-kpi' ? '📊 KRAs + KPIs' : '📌 KRAs only';
                      const editabilityLabel = group.prefillEditability === 'locked'
                        ? '🔒 Locked'
                        : group.prefillEditability === 'edit-freely'
                          ? '✏️ Free edit'
                          : '✏️ Add KPIs';
                      return (
                        <LibraryCard
                          key={`${group.id}:${assignment.slotKey}`}
                          library={{
                            name: assignment.label,
                            type: group.prefillType === 'kra-kpi' ? 'kra-kpi' : 'kra-only',
                            perspectives: assignment.data || [],
                          }}
                          groupLabel={assignment.label}
                          assignedText={null}
                          accent={accent}
                          active={uploadedCount > 0}
                          empty={uploadedCount === 0}
                          onSelect={() => {
                            setSelectedGroupId(group.id);
                            setEditingPrefillTarget({ groupId: group.id, slotKey: assignment.slotKey });
                          }}
                          onEdit={() => {
                            setSelectedGroupId(group.id);
                            setEditingPrefillTarget({ groupId: group.id, slotKey: assignment.slotKey });
                          }}
                          onDelete={uploadedCount > 0 ? () => updatePrefillAssignmentData(group.id, assignment.slotKey, []) : null}
                          selectionHint={uploadedCount > 0
                            ? `${prefillKraCount} pre-filled KRA${prefillKraCount !== 1 ? 's' : ''} · ${prefillLabel} · ${editabilityLabel}`
                            : `Create or upload ${prefillLabel.toLowerCase()} for ${assignment.label}`}
                        />
                      );
                    })}
                  </div>
                </div>
              ));
            })()}
            {boardSlots.length === 0 && (
              <div style={{ minHeight: 220, borderRadius: 24, border: '1px dashed #D7E3F4', background: '#FAFCFF', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '24px 28px', textAlign: 'center' }}>
                <div>
                  <div style={{ fontSize: 15.5, fontWeight: 700, color: '#374151', marginBottom: 6 }}>No pre-fill cards available</div>
                  <div style={{ fontSize: 13.5, color: '#94A3B8', lineHeight: 1.6 }}>
                    Go back to Groups & Strategy and add employee values under the selected attribute. Each value appears here as its own pre-fill card.
                  </div>
                </div>
              </div>
            )}
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'space-between', gap: 18 }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              {groupsNeedingPrefill.map((group, index) => {
                const active = selectedGroup?.id === group.id && !(showAllGroups && canShowAllGroups);
                return (
                  <button
                    key={group.id}
                    type="button"
                    onClick={() => { setShowAllGroups(false); setSelectedGroupId(group.id); }}
                    style={{
                      borderRadius: 16,
                      border: `1px solid ${active ? '#93C5FD' : '#E2E8F0'}`,
                      background: active ? '#EFF6FF' : '#FFFFFF',
                      color: active ? '#2563EB' : '#334155',
                      padding: '12px 16px',
                      fontSize: 14,
                      fontWeight: 700,
                      cursor: 'pointer',
                      fontFamily: 'inherit',
                      boxShadow: active ? '0 10px 22px rgba(37,99,235,.08)' : 'none',
                    }}
                  >
                    {group.name || `Group ${index + 1}`}
                  </button>
                );
              })}

              {canShowAllGroups && (
                <button
                  type="button"
                  onClick={() => setShowAllGroups(true)}
                  style={{
                    borderRadius: 16,
                    border: `1px solid ${showAllGroups ? '#93C5FD' : '#E2E8F0'}`,
                    background: showAllGroups ? '#EFF6FF' : '#FFFFFF',
                    color: showAllGroups ? '#2563EB' : '#334155',
                    padding: '12px 16px',
                    fontSize: 14,
                    fontWeight: 700,
                    cursor: 'pointer',
                    fontFamily: 'inherit',
                    boxShadow: showAllGroups ? '0 10px 22px rgba(37,99,235,.08)' : 'none',
                  }}
                >
                  All Employees
                </button>
              )}
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 10, alignItems: 'stretch' }}>
              {selectedGroup && (
                <>
                  <PrefillSheetControls
                    config={config}
                    selectedGroup={selectedGroup}
                    onImported={importPrefillLibraries}
                    phase={phase}
                    setPhase={setPhase}
                    errors={errors}
                    setErrors={setErrors}
                  />
                  {phase === 'error' && errors.length > 0 && (
                    <div style={{ padding: '12px 14px', background: '#FEF2F2', borderRadius: 16, border: '1px solid #FECACA' }}>
                      {errors.map((error, index) => (
                        <div key={`${error.field}_${index}`} style={{ fontSize: 12, color: '#DC2626', lineHeight: 1.5 }}>
                          {error.message}
                        </div>
                      ))}
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        </div>
      </div>

      <StepStatusBar
        applied={isApplied}
        valid={isValid}
        appliedMessage="Pre-fill data confirmed — proceed to Goal Libraries."
        pendingMessage={groupsNeedingPrefill.length > 0 && !isValid ? 'Upload pre-fill data for every pre-fill-enabled group.' : 'Click confirm to proceed.'}
        buttonLabel="Confirm Pre-fill Data"
        onApply={() => update('prefillDataAppliedSnapshot', `confirmed_${Date.now()}`)}
      />
    </div>
  );
}

// Tokenize a perspective name for fuzzy matching: lowercase, split on common separators,
// drop short noise tokens like "of", "to".
function tokenizePerspectiveName(name) {
  return new Set(
    String(name || '')
      .toLowerCase()
      .split(/[\s/,&()\-–—]+/)
      .filter((t) => t.length > 2)
  );
}

// Find the configured-perspective index that best matches a library perspective name.
// Tries exact match, then substring containment, then significant-token overlap.
// Returns -1 if no reasonable match exists.
function findBestPerspectiveMatch(libName, configList) {
  const libRaw = String(libName || '').trim();
  if (!libRaw) return -1;
  const libLower = libRaw.toLowerCase();

  let idx = configList.findIndex((c) => String(c.name || '').trim().toLowerCase() === libLower);
  if (idx >= 0) return idx;

  idx = configList.findIndex((c) => {
    const cLower = String(c.name || '').trim().toLowerCase();
    if (!cLower) return false;
    return cLower.includes(libLower) || libLower.includes(cLower);
  });
  if (idx >= 0) return idx;

  const libTokens = tokenizePerspectiveName(libName);
  if (libTokens.size === 0) return -1;
  let bestScore = 0;
  let bestIdx = -1;
  configList.forEach((c, i) => {
    const cTokens = tokenizePerspectiveName(c.name);
    let score = 0;
    libTokens.forEach((t) => { if (cTokens.has(t)) score += 1; });
    if (score > bestScore) { bestScore = score; bestIdx = i; }
  });
  return bestScore > 0 ? bestIdx : -1;
}

// True if any of the library's perspective names doesn't match a configured perspective name (exact, lowercased).
function libraryHasPerspectiveMismatch(library, configPerspNamesLower) {
  if (!library || !configPerspNamesLower || configPerspNamesLower.length === 0) return false;
  return (library.perspectives || []).some((p) => {
    const n = String(p?.name || '').trim().toLowerCase();
    return n && !configPerspNamesLower.includes(n);
  });
}

function AddLibraryModal({ config, initialLibrary = null, fixedName = '', suggestedType = null, lockType = false, onSave, onClose }) {
  const normalizedInitialLibrary = initialLibrary ? normalizeGoalLibraryRecord(initialLibrary) : null;

  // Configured perspectives for this org — source of truth
  const configPerspectives = (config.perspectives || []).filter(p => p.name);
  const configPerspNames = configPerspectives.map(p => String(p.name).trim());

  const defaultPersp = configPerspectives.map((p, i) => ({
    id: `lp_${Date.now()}_${i}_${Math.random().toString(36).slice(2,5)}`,
    name: p.name,
    weight: Number(p.weight || p.weightage) || 0,
    kras: [],
  }));

  // When editing, seed from saved library but flag any perspective name mismatches vs current config
  const seedPerspectives = normalizedInitialLibrary?.perspectives?.length
    ? normalizedInitialLibrary.perspectives.map(perspective => ({
        ...perspective,
        kras: (perspective.kras || []).map(kra => ({
          ...kra,
          suggestedWeight: toNonNegativeWeight(kra.suggestedWeight),
          kpis: (kra.kpis || []).map(kpi => ({ ...kpi, weight: toNonNegativeWeight(kpi.weight) })),
        })),
      }))
    : defaultPersp;

  // Detect if saved library perspectives don't match configured ones
  const savedPerspNames = seedPerspectives.map(p => String(p.name || '').trim().toLowerCase());
  const configPerspNamesLower = configPerspNames.map(n => n.toLowerCase());
  const hasPerspMismatch = configPerspNames.length > 0 && !!initialLibrary && savedPerspNames.some(
    n => !configPerspNamesLower.includes(n)
  );

  const [name, setName] = useState(normalizedInitialLibrary?.name || fixedName || '');
  const [type, setType] = useState(normalizedInitialLibrary?.type || suggestedType || 'kra-only');
  const [weightType, setWeightType] = useState(normalizedInitialLibrary?.weightType || 'suggested');
  const [perspectives, setPerspectives] = useState(seedPerspectives);
  const [openKraDescriptions, setOpenKraDescriptions] = useState({});
  const [showPerspSyncBanner, setShowPerspSyncBanner] = useState(hasPerspMismatch);
  const [perspSaveError, setPerspSaveError] = useState('');

  // Sync perspectives to current config. Match library perspectives to configured ones by:
  // 1) exact (case-insensitive) name; 2) substring containment either direction; 3) shared
  // significant-token overlap (best score wins). Only truly unrelated KRAs fall back to the
  // first configured perspective so abbreviated/expanded names like "Internal Process" vs
  // "Internal Process / Operations" merge correctly.
  function syncPerspectivesToConfig() {
    const next = configPerspectives.map((cp, i) => ({
      id: `lp_sync_${Date.now()}_${i}`,
      name: cp.name,
      weight: Number(cp.weight || cp.weightage) || 0,
      kras: [],
    }));
    const orphanKras = [];
    perspectives.forEach(p => {
      const matchIdx = findBestPerspectiveMatch(p.name, configPerspectives);
      if (matchIdx >= 0) {
        next[matchIdx] = { ...next[matchIdx], kras: [...(next[matchIdx].kras || []), ...(p.kras || [])] };
      } else {
        orphanKras.push(...(p.kras || []));
      }
    });
    if (orphanKras.length > 0 && next.length > 0) {
      next[0] = { ...next[0], kras: [...(next[0].kras || []), ...orphanKras] };
    }
    setPerspectives(next);
    setShowPerspSyncBanner(false);
    setPerspSaveError('');
  }

  // Clamp any stale negative weights that may have been stored before validation was added
  useEffect(() => {
    setPerspectives(prev => prev.map(p => ({
      ...p,
      kras: (p.kras || []).map(k => ({
        ...k,
        suggestedWeight: toNonNegativeWeight(k.suggestedWeight),
        kpis: (k.kpis || []).map(kpi => ({ ...kpi, weight: toNonNegativeWeight(kpi.weight) })),
      })),
    })));
  }, []);

  function changeType(newType) {
    if (newType === type) return;
    const hasKpis = perspectives.some(p => (p.kras || []).some(k => (k.kpis || []).length > 0));
    if (newType === 'kra-only' && hasKpis) {
      if (!window.confirm('Switching to KRAs only will remove all KPI entries. Continue?')) return;
      setPerspectives(current => current.map(p => ({
        ...p,
        kras: (p.kras || []).map(k => ({ ...k, kpis: [] })),
      })));
    }
    setType(newType);
  }

  function updatePerspKras(perspId, updater) {
    setPerspectives(current => current.map(p =>
      p.id !== perspId ? p : { ...p, kras: updater(p.kras || []) }
    ));
  }

  function addKRA(perspId) {
    updatePerspKras(perspId, kras => [
      ...kras,
      { id: `kra_${Date.now()}_${Math.random().toString(36).slice(2, 5)}`, name: '', desc: '', suggestedWeight: 0, kpis: [] },
    ]);
  }

  function updateKRA(perspId, kraId, changes) {
    updatePerspKras(perspId, kras => kras.map(k => k.id === kraId ? { ...k, ...changes } : k));
  }

  function removeKRA(perspId, kraId) {
    updatePerspKras(perspId, kras => kras.filter(k => k.id !== kraId));
    setOpenKraDescriptions(current => {
      const next = { ...current };
      delete next[kraId];
      return next;
    });
  }

  function updateKraWeight(perspId, kraId, rawValue) {
    const sanitized = sanitizeWeightInput(rawValue);
    updatePerspKras(perspId, kras => kras.map(k => k.id === kraId ? { ...k, suggestedWeight: sanitized === '' ? 0 : Number(sanitized) || 0 } : k));
  }

  function addKPI(perspId, kraId) {
    updatePerspKras(perspId, kras => kras.map(k => k.id !== kraId ? k : {
      ...k,
      kpis: [...(k.kpis || []), { id: `kpi_${Date.now()}_${Math.random().toString(36).slice(2, 5)}`, name: '', weight: 0 }],
    }));
  }

  function updateKPI(perspId, kraId, kpiId, changes) {
    updatePerspKras(perspId, kras => kras.map(k => k.id !== kraId ? k : {
      ...k,
      kpis: (k.kpis || []).map(kp => kp.id === kpiId ? { ...kp, ...changes } : kp),
    }));
  }

  function removeKPI(perspId, kraId, kpiId) {
    updatePerspKras(perspId, kras => kras.map(k => k.id !== kraId ? k : {
      ...k,
      kpis: (k.kpis || []).filter(kp => kp.id !== kpiId),
    }));
  }

  function updateKpiWeight(perspId, kraId, kpiId, rawValue) {
    const sanitized = sanitizeWeightInput(rawValue);
    updatePerspKras(perspId, kras => kras.map(k => k.id !== kraId ? k : {
      ...k,
      kpis: (k.kpis || []).map(kp => kp.id === kpiId ? { ...kp, weight: sanitized === '' ? 0 : Number(sanitized) || 0 } : kp),
    }));
  }

  function getPerspKraTotal(perspId) {
    return (perspectives.find(p => p.id === perspId)?.kras || [])
      .reduce((s, k) => s + toNonNegativeWeight(k.suggestedWeight), 0);
  }

  const globalKraTotal = perspectives.reduce((s, p) =>
    s + (p.kras || []).reduce((ps, k) => ps + toNonNegativeWeight(k.suggestedWeight), 0), 0
  );

  function stripWeightsFromPerspectives(nextPerspectives) {
    return (nextPerspectives || []).map(perspective => ({
      ...perspective,
      weight: 0,
      kras: (perspective.kras || []).map(kra => ({
        ...kra,
        suggestedWeight: 0,
        kpis: (kra.kpis || []).map(kpi => ({ ...kpi, weight: 0 })),
      })),
    }));
  }

  const resolvedName = fixedName || name;
  const canSave = resolvedName.trim() && (initialLibrary
    ? true
    : perspectives.some(p => (p.kras || []).some(k => k.name.trim())));

  const inputStyle = { border: '1px solid #E2E8F0', borderRadius: 6, padding: '6px 10px', fontSize: 13, outline: 'none', fontFamily: 'inherit', background: '#fff' };
  const textareaStyle = { ...inputStyle, width: '100%', boxSizing: 'border-box', resize: 'vertical', minHeight: 64, lineHeight: 1.45 };

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 2000, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: '40px 20px', overflowY: 'auto' }}>
      <div style={{ background: '#fff', borderRadius: 16, width: '100%', maxWidth: 760, boxShadow: '0 20px 60px rgba(0,0,0,.18)', overflow: 'hidden' }}>
        {/* Modal header */}
        <div style={{ padding: '20px 24px', borderBottom: '1px solid #E9EDF2', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ fontSize: 16, fontWeight: 700, color: '#0F172A' }}>{initialLibrary ? 'Edit Goal Library' : 'New Goal Library'}</div>
          <button type="button" onClick={onClose} style={{ background: 'none', border: 'none', fontSize: 20, cursor: 'pointer', color: '#94A3B8', lineHeight: 1 }}>×</button>
        </div>

        <div style={{ padding: '24px', maxHeight: '70vh', overflowY: 'auto' }}>
          {/* Library Name */}
          <div style={{ marginBottom: 20 }}>
            <label style={{ fontSize: 11.5, fontWeight: 600, color: '#64748B', display: 'block', marginBottom: 5 }}>Library Name *</label>
            {fixedName ? (
              <div style={{ ...inputStyle, width: '100%', boxSizing: 'border-box', background: '#F8FAFC', color: '#334155', fontWeight: 700 }}>
                {fixedName}
              </div>
            ) : (
              <input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Engineering Goals 2025" style={{ ...inputStyle, width: '100%', boxSizing: 'border-box' }} />
            )}
          </div>

          {/* Compact meta row: type + weight */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 20 }}>
            <div>
              <label style={{ fontSize: 11.5, fontWeight: 600, color: '#64748B', display: 'block', marginBottom: 5 }}>
                Library Type
                {suggestedType && !initialLibrary && <span style={{ marginLeft: 6, fontSize: 10.5, color: '#7C3AED', background: '#F5F3FF', border: '1px solid #DDD6FE', borderRadius: 20, padding: '1px 7px', fontWeight: 600 }}>from group</span>}
              </label>
              {lockType ? (
                <div style={{ ...inputStyle, width: '100%', boxSizing: 'border-box', background: '#F8FAFC', color: '#334155', fontWeight: 700 }}>
                  {type === 'kra-kpi' ? '📊 KRAs + KPIs' : '📌 KRAs only'}
                </div>
              ) : (
                <select value={type} onChange={e => changeType(e.target.value)} style={{ ...inputStyle, width: '100%' }}>
                  <option value="kra-only">📌 KRAs only</option>
                  <option value="kra-kpi">📊 KRAs + KPIs</option>
                </select>
              )}
            </div>
            <div>
              <label style={{ fontSize: 11.5, fontWeight: 600, color: '#64748B', display: 'block', marginBottom: 5 }}>KRA Weight Behaviour</label>
              <select value={weightType} onChange={e => setWeightType(e.target.value)} style={{ ...inputStyle, width: '100%' }}>
                <option value="suggested">💡 Suggested — employees can adjust</option>
                <option value="fixed">🔒 Fixed — weights locked</option>
                <option value="none">— None — employees set own weights</option>
              </select>
            </div>
          </div>

          {weightType !== 'none' && (
            <div style={{ marginBottom: 16, display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 12, color: '#6B7280' }}>Total KRA weight:</span>
              <span style={{ fontSize: 13, fontWeight: 700, color: globalKraTotal === 100 ? '#16A34A' : globalKraTotal > 100 ? '#DC2626' : '#D97706' }}>
                {globalKraTotal} / 100
              </span>
              {globalKraTotal === 100 && <span style={{ fontSize: 12, color: '#16A34A' }}>✓</span>}
            </div>
          )}

          {/* No perspectives configured */}
          {configPerspNames.length === 0 && (
            <div style={{ marginBottom: 16, background: '#FFFBEB', border: '1.5px solid #FDE68A', borderRadius: 9, padding: '12px 14px', fontSize: 12.5, color: '#92400E', lineHeight: 1.6 }}>
              ⚠ <strong>No BSC perspectives configured</strong> for this org yet. Go back to the <strong>BSC Perspectives</strong> step to set them up before building libraries — KRAs must belong to a valid perspective.
            </div>
          )}

          {/* Perspective mismatch sync banner */}
          {showPerspSyncBanner && (
            <div style={{ marginBottom: 16, background: '#FEF2F2', border: '1.5px solid #FECACA', borderRadius: 9, padding: '12px 14px' }}>
              <div style={{ fontSize: 12.5, fontWeight: 600, color: '#991B1B', marginBottom: 6 }}>
                ⚠ Perspective mismatch
              </div>
              <div style={{ fontSize: 12, color: '#7F1D1D', lineHeight: 1.6, marginBottom: 8 }}>
                This library uses perspectives that don't match what's currently configured for this org.
                <br />
                <strong>Configured:</strong> {configPerspNames.join(' · ')}
                <br />
                <strong>In this library:</strong> {perspectives.map(p => p.name).join(' · ')}
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button type="button" onClick={syncPerspectivesToConfig} style={{ padding: '6px 14px', background: '#DC2626', color: '#fff', border: 'none', borderRadius: 7, fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' }}>
                  Sync to configured perspectives
                </button>
                <button type="button" onClick={() => setShowPerspSyncBanner(false)} style={{ padding: '6px 14px', background: '#fff', color: '#374151', border: '1px solid #E2E8F0', borderRadius: 7, fontSize: 12, cursor: 'pointer', fontFamily: 'inherit' }}>
                  Dismiss
                </button>
              </div>
            </div>
          )}

          {/* Save-time perspective error */}
          {perspSaveError && (
            <div style={{ marginBottom: 12, background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: 8, padding: '9px 12px', fontSize: 12.5, color: '#DC2626', fontWeight: 600 }}>
              {perspSaveError}
            </div>
          )}

          {/* Perspectives + KRAs */}
          {perspectives.map((persp, pi) => {
            const perspIsValid = configPerspNames.length === 0 ||
              configPerspNamesLower.includes(String(persp.name || '').trim().toLowerCase());
            return (
            <div key={persp.id} style={{ border: `1.5px solid ${perspIsValid ? '#E2E8F0' : '#FECACA'}`, borderRadius: 10, marginBottom: 14, overflow: 'hidden' }}>
              <div style={{ padding: '10px 14px', background: perspIsValid ? '#F8FAFC' : '#FEF2F2', borderBottom: `1px solid ${perspIsValid ? '#E9EDF2' : '#FECACA'}`, display: 'flex', alignItems: 'center', gap: 10 }}>
                <div style={{ width: 8, height: 8, borderRadius: '50%', background: perspIsValid ? '#2563EB' : '#DC2626', flexShrink: 0 }} />
                <div style={{ flex: 1, fontWeight: 600, color: perspIsValid ? '#0F172A' : '#991B1B', fontSize: 13 }}>
                  {persp.name || `Perspective ${pi + 1}`}
                  {!perspIsValid && <span style={{ marginLeft: 8, fontSize: 11, fontWeight: 600, background: '#FEE2E2', color: '#DC2626', borderRadius: 5, padding: '1px 6px' }}>not in config</span>}
                </div>
                {weightType !== 'none' && (
                  <>
                    <span style={{ fontSize: 12, color: '#9CA3AF' }}>Weight</span>
                    <input
                      type="number"
                      readOnly
                      value={getPerspKraTotal(persp.id) || ''}
                      style={{ ...inputStyle, width: 60, textAlign: 'center', background: '#F8FAFC', cursor: 'default' }}
                      placeholder="0"
                    />
                    <span style={{ fontSize: 12, color: '#9CA3AF' }}>%</span>
                  </>
                )}
              </div>
              <div style={{ padding: '10px 14px' }}>
                {(persp.kras || []).map((kra) => (
                  <div key={kra.id} style={{ marginBottom: 8, border: '1px solid #F1F5F9', borderRadius: 8, padding: '10px 12px' }}>
                    {(() => {
                      const descOpen = !!openKraDescriptions[kra.id];
                      const hasDesc = !!String(kra.desc || '').trim();
                      return (
                        <>
                    <div style={{ display: 'flex', gap: 8, marginBottom: type === 'kra-kpi' ? 6 : 0 }}>
                      <input value={kra.name} onChange={e => updateKRA(persp.id, kra.id, { name: e.target.value })} placeholder="KRA name" style={{ ...inputStyle, flex: 1 }} />
                      {weightType !== 'none' && (
                        <>
                          <input
                            type="text"
                            inputMode="decimal"
                            value={toNonNegativeWeight(kra.suggestedWeight) || ''}
                            onChange={e => updateKraWeight(persp.id, kra.id, e.target.value)}
                            style={{ ...inputStyle, width: 60, textAlign: 'center' }}
                            placeholder="%"
                          />
                          <span style={{ fontSize: 12, color: '#9CA3AF', alignSelf: 'center' }}>%</span>
                        </>
                      )}
                      <button type="button" onClick={() => removeKRA(persp.id, kra.id)} style={{ background: 'none', border: 'none', color: '#DC2626', cursor: 'pointer', fontSize: 16, lineHeight: 1, padding: '0 4px' }}>×</button>
                    </div>
                    <div style={{ marginBottom: type === 'kra-kpi' ? 8 : 0 }}>
                      <button
                        type="button"
                        onClick={() => setOpenKraDescriptions(current => ({ ...current, [kra.id]: !descOpen }))}
                        style={{
                          background: 'none',
                          border: 'none',
                          padding: 0,
                          marginBottom: descOpen ? 6 : 0,
                          color: hasDesc ? '#2563EB' : '#94A3B8',
                          fontSize: 12,
                          fontWeight: 600,
                          cursor: 'pointer',
                          fontFamily: 'inherit',
                        }}
                      >
                        {descOpen ? 'Hide KRA description' : hasDesc ? 'Edit KRA description' : '+ Add KRA description'}
                      </button>
                      {descOpen ? (
                        <textarea
                          value={kra.desc || ''}
                          onChange={e => updateKRA(persp.id, kra.id, { desc: e.target.value })}
                          placeholder="KRA description (optional)"
                          style={textareaStyle}
                        />
                      ) : null}
                    </div>
                    {type === 'kra-kpi' && (
                      <div style={{ paddingLeft: 16 }}>
                        {(kra.kpis || []).map(kpi => (
                          <div key={kpi.id} style={{ marginBottom: 8 }}>
                            <div style={{ display: 'flex', gap: 8, marginBottom: 4, alignItems: 'center' }}>
                              <div style={{ width: 4, height: 4, borderRadius: '50%', background: '#CBD5E1', flexShrink: 0 }} />
                              <input value={kpi.name} onChange={e => updateKPI(persp.id, kra.id, kpi.id, { name: e.target.value })} placeholder="KPI name" style={{ ...inputStyle, flex: 1, fontSize: 12 }} />
                              {weightType !== 'none' && (
                                <>
                                  <input
                                    type="text"
                                    inputMode="decimal"
                                    value={toNonNegativeWeight(kpi.weight) || ''}
                                    onChange={e => updateKpiWeight(persp.id, kra.id, kpi.id, e.target.value)}
                                    style={{ ...inputStyle, width: 55, textAlign: 'center', fontSize: 12 }}
                                    placeholder="%"
                                  />
                                  <span style={{ fontSize: 12, color: '#9CA3AF' }}>%</span>
                                </>
                              )}
                              <button type="button" onClick={() => removeKPI(persp.id, kra.id, kpi.id)} style={{ background: 'none', border: 'none', color: '#DC2626', cursor: 'pointer', fontSize: 14, lineHeight: 1 }}>×</button>
                            </div>
                          </div>
                        ))}
                        <button type="button" onClick={() => addKPI(persp.id, kra.id)} style={{ fontSize: 11.5, color: '#7C3AED', background: 'none', border: 'none', cursor: 'pointer', padding: '2px 0 2px 6px', fontFamily: 'inherit' }}>+ Add KPI</button>
                      </div>
                    )}
                        </>
                      );
                    })()}
                  </div>
                ))}
                <button type="button" onClick={() => addKRA(persp.id)} style={{ fontSize: 12.5, color: '#2563EB', background: 'none', border: 'none', cursor: 'pointer', fontWeight: 600, padding: '4px 0', fontFamily: 'inherit' }}>+ Add KRA</button>
              </div>
            </div>
          ); })}
        </div>

        <div style={{ padding: '16px 24px', borderTop: '1px solid #E9EDF2', display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
          <button type="button" onClick={onClose} style={{ padding: '9px 20px', border: '1px solid #E2E8F0', borderRadius: 8, background: '#fff', fontSize: 13, cursor: 'pointer', fontFamily: 'inherit' }}>Cancel</button>
          <button type="button" disabled={!canSave} onClick={() => {
            // Validate perspective names against configured perspectives before saving
            if (configPerspNames.length > 0) {
              const badNames = perspectives
                .map(p => String(p.name || '').trim())
                .filter(n => n && !configPerspNamesLower.includes(n.toLowerCase()));
              if (badNames.length > 0) {
                setPerspSaveError(`Perspective${badNames.length > 1 ? 's' : ''} "${badNames.join('", "')}" ${badNames.length > 1 ? 'are' : 'is'} not in this org's configured perspectives (${configPerspNames.join(', ')}). Use "Sync to configured perspectives" above to fix this.`);
                setShowPerspSyncBanner(true);
                return;
              }
            }
            setPerspSaveError('');
            const clampWeights = persp => ({
              ...persp,
              kras: (persp.kras || []).map(k => ({
                ...k,
                suggestedWeight: Math.max(0, Number(k.suggestedWeight) || 0),
                kpis: (k.kpis || []).map(kpi => ({ ...kpi, weight: Math.max(0, Number(kpi.weight) || 0) })),
              })),
            });
            const sanitized = (weightType === 'none' ? stripWeightsFromPerspectives(perspectives) : perspectives).map(clampWeights);
            onSave({
              id: initialLibrary?.id || `lib_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
              name: resolvedName.trim(),
              type,
              weightType,
              perspectives: sanitized,
            });
          }} style={{ padding: '9px 22px', background: canSave ? '#2563EB' : '#CBD5E1', color: '#fff', border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: canSave ? 'pointer' : 'not-allowed', fontFamily: 'inherit' }}>
            {initialLibrary ? 'Save Changes' : 'Save Library'}
          </button>
        </div>
      </div>
    </div>
  );
}

function StepGoalLibraries({ config, update }) {
  const libraries = config.goalLibraries || [];
  const groups = config.goalGroups || [];
  const groupsNeedingLib = groups.filter(isGroupLibraryEnabled);
  const canShowAllGroups = groupsNeedingLib.length > 1;
  const [showAddModal, setShowAddModal] = useState(false);
  const [editingLibraryId, setEditingLibraryId] = useState(null);
  const [showAllGroups, setShowAllGroups] = useState(false);
  const [selectedGroupId, setSelectedGroupId] = useState(groupsNeedingLib[0]?.id || '');
  const [editingSlot, setEditingSlot] = useState(null);

  const groupsWithAssignments = groupsNeedingLib.map(group => ({
    ...group,
    libraryAssignments: getGroupLibraryAssignments(group),
  }));
  const configPerspNamesLower = (config.perspectives || [])
    .filter(p => p.name)
    .map(p => String(p.name).trim().toLowerCase());
  const allSlotsAssigned = groupsWithAssignments.length === 0 || groupsWithAssignments.every(group =>
    group.libraryAssignments.every(assignment => assignment.libraryId && libraries.some(library => library.id === assignment.libraryId))
  );
  const assignedLibraries = Array.from(new Map(
    groupsWithAssignments.flatMap(group =>
      group.libraryAssignments
        .map(a => libraries.find(l => l.id === a.libraryId))
        .filter(Boolean)
        .map(l => [l.id, l])
    )
  ).values());
  const mismatchedLibraries = assignedLibraries.filter(l => libraryHasPerspectiveMismatch(l, configPerspNamesLower));
  const isValid = allSlotsAssigned && mismatchedLibraries.length === 0;
  const isApplied = !!config.goalLibrariesAppliedSnapshot && isValid;

  useEffect(() => {
    if (showAllGroups && canShowAllGroups) return;
    if (!groupsWithAssignments.some(group => group.id === selectedGroupId)) {
      setSelectedGroupId(groupsWithAssignments[0]?.id || '');
    }
  }, [groupsWithAssignments, selectedGroupId, showAllGroups, canShowAllGroups]);

  const selectedGroup = groupsWithAssignments.find(group => group.id === selectedGroupId) || groupsWithAssignments[0] || null;
  const templateScopeConfig = (showAllGroups && canShowAllGroups) || !selectedGroup
    ? config
    : { ...config, goalGroups: [selectedGroup] };
  const selectedGroupIndex = Math.max(0, groupsWithAssignments.findIndex(group => group.id === selectedGroup?.id));
  const editingLibrary = libraries.find(library => library.id === editingLibraryId) || null;
  const boardSlots = ((showAllGroups && canShowAllGroups) ? groupsWithAssignments : (selectedGroup ? [selectedGroup] : []))
    .flatMap((group, groupIndex) =>
      group.libraryAssignments.map((assignment, assignmentIndex) => ({
        group,
        assignment,
        accent: LIBRARY_BOARD_COLORS[(groupIndex + assignmentIndex + Math.max(selectedGroupIndex, 0)) % LIBRARY_BOARD_COLORS.length],
        library: libraries.find(library => library.id === assignment.libraryId) || null,
      }))
    );

  function saveLibrary(lib) {
    const exists = libraries.some(existing => existing.id === lib.id);
    const nextLibraries = exists
      ? libraries.map(existing => existing.id === lib.id ? lib : existing)
      : [...libraries, lib];
    update('goalLibraries', nextLibraries);
    if (editingSlot) {
      const currentAssignments = getGroupLibraryAssignments(editingSlot.group);
      const nextAssignments = currentAssignments.map(assignment =>
        assignment.slotKey === editingSlot.assignment.slotKey
          ? { ...assignment, libraryId: lib.id }
          : assignment
      );
      update('goalGroups', setGroupLibraryAssignments(groups, editingSlot.group.id, nextAssignments));
    }
    update('goalLibrariesAppliedSnapshot', null);
    setShowAddModal(false);
    setEditingLibraryId(null);
    setEditingSlot(null);
  }

  function deleteLibrary(id) {
    update('goalLibraries', libraries.filter(l => l.id !== id));
    update('goalGroups', groups.map(group => ({
      ...group,
      libraryId: group.libraryId === id ? null : group.libraryId,
      libraryAssignments: getGroupLibraryAssignments(group).map(assignment =>
        assignment.libraryId === id ? { ...assignment, libraryId: null } : assignment
      ),
    })));
    update('goalLibrariesAppliedSnapshot', null);
  }

  function openSlotEditor(group, assignment, libraryId = null) {
    setEditingSlot({ group, assignment });
    setEditingLibraryId(libraryId);
    setShowAddModal(true);
  }

  function handleImportedLibraries(nextLibraries, importedLibraries = nextLibraries) {
    let nextGroups = [...groups];
    const normalizeLookup = value => String(value || '').trim().toLowerCase()
      .replace(/\s*\(\s*/g, ' (').replace(/\s*\)\s*/g, ')').replace(/\s+/g, ' ').trim();
    const appendLookup = (map, key, value) => {
      if (!key) return;
      const existing = map.get(key) || [];
      existing.push(value);
      map.set(key, existing);
    };
    const libraryById = new Map(nextLibraries.map(library => [library.id, library]));
    const librariesByName = new Map();
    const librariesByGroup = new Map();
    const librariesByCompositeKey = new Map();

    nextLibraries.forEach(library => {
      const nameKey = normalizeLookup(library.name);
      const groupKey = normalizeLookup(library.groupName);
      appendLookup(librariesByName, nameKey, library);
      appendLookup(librariesByGroup, groupKey, library);
      if (nameKey && groupKey) {
        appendLookup(librariesByCompositeKey, `${groupKey}::${nameKey}`, library);
      }
    });

    const assignedLibraryIds = new Set();

    const resolveAssignmentLibraryId = (group, assignment) => {
      if (assignment.libraryId && libraryById.has(assignment.libraryId)) {
        return assignment.libraryId;
      }

      const groupKey = normalizeLookup(group.name);
      const labelKey = normalizeLookup(assignment.label);

      const compositeMatches = groupKey && labelKey
        ? (librariesByCompositeKey.get(`${groupKey}::${labelKey}`) || [])
        : [];
      if (compositeMatches.length === 1) {
        return compositeMatches[0].id;
      }

      const plainMatches = labelKey ? (librariesByName.get(labelKey) || []) : [];
      if (plainMatches.length === 1) {
        return plainMatches[0].id;
      }

      const groupMatches = groupKey ? (librariesByGroup.get(groupKey) || []) : [];
      if (group.libraryAssignments.length === 1 && groupMatches.length === 1) {
        return groupMatches[0].id;
      }

      return null;
    };

    groupsWithAssignments.forEach(group => {
      const nextAssignments = group.libraryAssignments.map(assignment => {
        const libraryId = resolveAssignmentLibraryId(group, assignment);
        if (libraryId) assignedLibraryIds.add(libraryId);
        return {
          ...assignment,
          libraryId,
        };
      });
      nextGroups = setGroupLibraryAssignments(nextGroups, group.id, nextAssignments);
    });

    update('goalLibraries', nextLibraries);
    update('goalGroups', nextGroups);
    update('goalLibrariesAppliedSnapshot', null);
    const unassignedImportedLibraries = importedLibraries.filter(library => !assignedLibraryIds.has(library.id));
    return {
      unassignedImportCount: unassignedImportedLibraries.length,
      unassignedImportNames: unassignedImportedLibraries.map(library => {
        const groupLabel = String(library.groupName || '').trim();
        const libraryLabel = String(library.name || '').trim() || 'Untitled library';
        return groupLabel ? `${groupLabel} / ${libraryLabel}` : libraryLabel;
      }),
    };
  }

  return (
    <div style={{ maxWidth: 1180, margin: '0 auto', paddingBottom: 40 }}>
      {showAddModal && (
        <AddLibraryModal
          config={config}
          initialLibrary={editingLibrary}
          fixedName={editingSlot?.assignment?.label || ''}
          suggestedType={editingSlot?.group?.libraryType || null}
          onSave={saveLibrary}
          onClose={() => {
            setShowAddModal(false);
            setEditingLibraryId(null);
            setEditingSlot(null);
          }}
        />
      )}

      <div style={{ marginBottom: 28 }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: '#94A3B8', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 6 }}>Goal Libraries</div>
        <h2 style={{ margin: 0, fontSize: 22, fontWeight: 800, color: '#0F172A' }}>Build your KRA libraries</h2>
        <p style={{ margin: '8px 0 0', fontSize: 14, color: '#64748B', lineHeight: 1.6, maxWidth: 820 }}>
          Each attribute value becomes its own goal-library card automatically. Switch groups on the right, then create or edit the library for each value.
        </p>
      </div>

      <div style={{ background: 'linear-gradient(180deg, #FFFFFF 0%, #FCFDFE 100%)', border: '1px solid #E2E8F0', borderRadius: 34, padding: 30, marginBottom: 22, boxShadow: '0 20px 45px rgba(15,23,42,.05)' }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 220px', gap: 24, alignItems: 'stretch' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
            {(() => {
              const groupedSlots = [];
              const groupIdToIndex = {};
              boardSlots.forEach(slot => {
                if (groupIdToIndex[slot.group.id] === undefined) {
                  groupIdToIndex[slot.group.id] = groupedSlots.length;
                  groupedSlots.push({ group: slot.group, slots: [] });
                }
                groupedSlots[groupIdToIndex[slot.group.id]].slots.push(slot);
              });
              return groupedSlots.map(({ group, slots }) => (
                <div key={group.id}>
                  {(group.segmentAttr || ((showAllGroups && canShowAllGroups) && group.name)) && (
                    <div style={{ marginBottom: 10, display: 'flex', alignItems: 'center', gap: 6 }}>
                      {(showAllGroups && canShowAllGroups) && group.name && (
                        <span style={{ fontSize: 12, fontWeight: 700, color: '#374151' }}>{group.name}</span>
                      )}
                      {group.segmentAttr && (
                        <span style={{ background: '#F1F5F9', border: '1px solid #E2E8F0', borderRadius: 6, padding: '2px 8px', fontSize: 11, fontWeight: 600, color: '#64748B' }}>{group.segmentAttr}</span>
                      )}
                    </div>
                  )}
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 18 }}>
                    {slots.map((slot, index) => {
                      const { group, assignment, library } = slot;
                      const accent = slot.accent || LIBRARY_BOARD_COLORS[(selectedGroupIndex + index) % LIBRARY_BOARD_COLORS.length];
                      const hasMismatch = !!library && libraryHasPerspectiveMismatch(library, configPerspNamesLower);
                      return (
                        <LibraryCard
                          key={`${group.id}:${assignment.slotKey}`}
                          library={library || { name: assignment.label, type: 'kra-kpi', perspectives: [] }}
                          groupLabel={assignment.label}
                          assignedText={null}
                          accent={accent}
                          active={!!library}
                          empty={!library}
                          warning={hasMismatch ? 'Perspective mismatch — open and sync' : null}
                          onSelect={() => openSlotEditor(group, assignment, library?.id || null)}
                          onEdit={() => openSlotEditor(group, assignment, library?.id || null)}
                          onDelete={library ? () => deleteLibrary(library.id) : null}
                          selectionHint={
                            library
                              ? `${group.name}${group.segmentAttr ? ` · ${group.segmentAttr}` : ''}`
                              : `Create library for ${assignment.label}`
                          }
                        />
                      );
                    })}
                  </div>
                </div>
              ));
            })()}
            {boardSlots.length === 0 && (
              <div style={{ minHeight: 220, borderRadius: 24, border: '1px dashed #D7E3F4', background: '#FAFCFF', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '24px 28px', textAlign: 'center' }}>
                <div>
                  <div style={{ fontSize: 15.5, fontWeight: 700, color: '#374151', marginBottom: 6 }}>No cards yet</div>
                  <div style={{ fontSize: 13.5, color: '#94A3B8', lineHeight: 1.6 }}>
                    Add employee values in Groups & Strategy first. Each value will appear here as a card automatically.
                  </div>
                </div>
              </div>
            )}
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'space-between', gap: 18 }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              {groupsWithAssignments.map((group, index) => {
                const active = selectedGroup?.id === group.id && !(showAllGroups && canShowAllGroups);
                return (
                  <button
                    key={group.id}
                    type="button"
                    onClick={() => { setShowAllGroups(false); setSelectedGroupId(group.id); }}
                    style={{
                      borderRadius: 16,
                      border: `1px solid ${active ? '#FCA5A5' : '#E2E8F0'}`,
                      background: active ? '#FFF5F5' : '#FFFFFF',
                      color: active ? '#DC2626' : '#334155',
                      padding: '12px 16px',
                      fontSize: 14,
                      fontWeight: 700,
                      cursor: 'pointer',
                      fontFamily: 'inherit',
                      boxShadow: active ? '0 10px 22px rgba(248,113,113,.08)' : 'none',
                    }}
                  >
                    {group.name || `Group ${index + 1}`}
                  </button>
                );
              })}

              {canShowAllGroups && (
                <button
                  type="button"
                  onClick={() => setShowAllGroups(true)}
                  style={{
                    borderRadius: 16,
                    border: `1px solid ${showAllGroups ? '#93C5FD' : '#E2E8F0'}`,
                    background: showAllGroups ? '#EFF6FF' : '#FFFFFF',
                    color: showAllGroups ? '#2563EB' : '#334155',
                    padding: '12px 16px',
                    fontSize: 14,
                    fontWeight: 700,
                    cursor: 'pointer',
                    fontFamily: 'inherit',
                    boxShadow: showAllGroups ? '0 10px 22px rgba(37,99,235,.08)' : 'none',
                  }}
                >
                  View all
                </button>
              )}
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <GoalLibrarySheetControls
                config={config}
                downloadConfig={templateScopeConfig}
                existingLibraries={libraries}
                onImported={handleImportedLibraries}
              />
            </div>
          </div>
        </div>
      </div>

      <StepStatusBar
        applied={isApplied}
        valid={isValid}
        appliedMessage="Libraries configured — proceed to Goal Limits."
        pendingMessage={
          groupsWithAssignments.length === 0
            ? 'Click confirm to proceed.'
            : !allSlotsAssigned
              ? 'Open each card and configure a library for every attribute value.'
              : mismatchedLibraries.length > 0
                ? `Fix perspective mismatch on ${mismatchedLibraries.length === 1 ? 'library' : 'libraries'}: ${mismatchedLibraries.map(l => l.name || 'Untitled').join(', ')}. Open the library and use "Sync to configured perspectives".`
                : 'Click confirm to proceed.'
        }
        buttonLabel="Confirm Libraries"
        onApply={() => update('goalLibrariesAppliedSnapshot', `confirmed_${Date.now()}`)}
      />
    </div>
  );
}

/* ─── STEP LIMITS (BSC) ──────────────────────────────────────────────────── */
function hasLimitValue(value) {
  return value !== null && value !== undefined && value !== '';
}

function getLimitPlaceholder(label, placeholder) {
  if (placeholder) return placeholder;
  if (label.startsWith('Min ')) return 'No minimum';
  if (label.startsWith('Max ')) return 'No maximum';
  return 'No limit';
}

function getAdvancedLimitValueCount(rule, hasKPIs) {
  const keys = [
    'minKRAsPerPersp',
    'maxKRAsPerPersp',
    'minKRAWeight',
    'maxKRAWeight',
    ...(hasKPIs ? ['minKPIWeight', 'maxKPIWeight'] : []),
  ];
  return keys.filter(key => hasLimitValue(rule?.[key])).length;
}

function LimitField({ label, value, onChange, placeholder }) {
  return (
    <div>
      <div style={{ fontSize: 11, color: '#9CA3AF', marginBottom: 4 }}>{label}</div>
      <input
        type="number"
        value={value ?? ''}
        onChange={e => onChange(e.target.value === '' ? null : Number(e.target.value))}
        placeholder={getLimitPlaceholder(label, placeholder)}
        min={0}
        style={{ width: '100%', border: '1px solid #E2E8F0', borderRadius: 6, padding: '7px 10px', fontSize: 13, outline: 'none', fontFamily: 'inherit', boxSizing: 'border-box' }}
      />
    </div>
  );
}

function StepLimits({ config, update }) {
  const enabled = !!config.limitsEnabled;
  const groups = config.goalGroups || [];
  const rules = config.limitsRules || [];
  const hasKPIs = groups.some(g => g.mode === 'prefill') || (config.goalLibraries || []).some(l => l.type === 'kra-kpi');
  const isApplied = !!config.limitsAppliedSnapshot;

  function getRuleForGroup(groupId) {
    return rules.find(r => r.groupId === groupId) || {};
  }

  const [advancedOpenByGroup, setAdvancedOpenByGroup] = useState(() =>
    Object.fromEntries(
      groups.map(group => {
        const rule = rules.find(item => item.groupId === group.id) || {};
        return [group.id, getAdvancedLimitValueCount(rule, hasKPIs) > 0];
      })
    )
  );

  useEffect(() => {
    setAdvancedOpenByGroup(current => {
      const next = { ...current };
      let changed = false;

      groups.forEach(group => {
        if (!(group.id in next)) {
          const rule = rules.find(item => item.groupId === group.id) || {};
          next[group.id] = getAdvancedLimitValueCount(rule, hasKPIs) > 0;
          changed = true;
        }
      });

      Object.keys(next).forEach(groupId => {
        if (!groups.some(group => group.id === groupId)) {
          delete next[groupId];
          changed = true;
        }
      });

      return changed ? next : current;
    });
  }, [groups, rules, hasKPIs]);

  function updateRule(groupId, changes) {
    const existing = rules.find(r => r.groupId === groupId);
    if (existing) {
      update('limitsRules', rules.map(r => r.groupId === groupId ? { ...r, ...changes } : r));
    } else {
      update('limitsRules', [...rules, { groupId, ...changes }]);
    }
    update('limitsAppliedSnapshot', null);
  }

  return (
    <div style={{ maxWidth: 820, margin: '0 auto', paddingBottom: 40 }}>
      <div style={{ marginBottom: 28 }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: '#94A3B8', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 6 }}>Goal Limits</div>
        <h2 style={{ margin: 0, fontSize: 22, fontWeight: 800, color: '#0F172A' }}>KRA/KPI count rules</h2>
        <p style={{ margin: '8px 0 0', fontSize: 14, color: '#64748B', lineHeight: 1.6 }}>
          Most teams only set total KRA limits and, when KPI mode is on, KPI counts per KRA. Perspective and weight rules stay under Advanced.
        </p>
      </div>

      {/* Master toggle */}
      <div style={{ background: '#fff', border: `1.5px solid ${enabled ? '#2563EB' : '#E2E8F0'}`, borderRadius: 12, padding: '18px 22px', marginBottom: 22, transition: 'border-color .15s' }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 14, cursor: 'pointer', userSelect: 'none' }}>
          <input type="checkbox" checked={enabled} onChange={e => { update('limitsEnabled', e.target.checked); update('limitsAppliedSnapshot', null); }} style={{ width: 18, height: 18, accentColor: '#2563EB', cursor: 'pointer', flexShrink: 0 }} />
          <div>
            <div style={{ fontSize: 14, fontWeight: 700, color: '#0F172A' }}>Enable Goal Limits</div>
            <div style={{ fontSize: 12.5, color: '#6B7280', marginTop: 2 }}>Employees will be constrained by the rules you define per group. Leave a field blank and we will not enforce that rule.</div>
          </div>
        </label>
      </div>

      {enabled && groups.map(group => {
        const rule = getRuleForGroup(group.id);
        const advancedValueCount = getAdvancedLimitValueCount(rule, hasKPIs);
        const advancedOpen = !!advancedOpenByGroup[group.id];
        return (
          <div key={group.id} style={{ background: '#fff', border: '1.5px solid #E2E8F0', borderRadius: 12, marginBottom: 14, overflow: 'hidden' }}>
            <div style={{ padding: '13px 20px', borderBottom: '1px solid #F1F5F9', background: '#FAFBFF', display: 'flex', alignItems: 'center', gap: 10 }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: '#0F172A' }}>{group.name}</div>
              <span style={{ fontSize: 11.5, color: '#9CA3AF', background: '#F1F5F9', padding: '2px 8px', borderRadius: 10 }}>
                {group.mode === 'prefill' ? '📋 Prefill' : '✏️ Scratch'}{isGroupLibraryEnabled(group) ? ' + Library' : ''}
              </span>
            </div>
            <div style={{ padding: '16px 20px' }}>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12 }}>
                <LimitField label="Min KRAs (total)" value={rule.minKRAs} onChange={v => updateRule(group.id, { minKRAs: v })} />
                <LimitField label="Max KRAs (total)" value={rule.maxKRAs} onChange={v => updateRule(group.id, { maxKRAs: v })} />
                {hasKPIs && <>
                  <LimitField label="Min KPIs / KRA" value={rule.minKPIsPerKRA} onChange={v => updateRule(group.id, { minKPIsPerKRA: v })} />
                  <LimitField label="Max KPIs / KRA" value={rule.maxKPIsPerKRA} onChange={v => updateRule(group.id, { maxKPIsPerKRA: v })} />
                </>}
              </div>

              <div style={{ marginTop: 14, paddingTop: 14, borderTop: '1px solid #F1F5F9' }}>
                <button
                  type="button"
                  onClick={() => setAdvancedOpenByGroup(current => ({ ...current, [group.id]: !current[group.id] }))}
                  aria-expanded={advancedOpen}
                  style={{
                    width: '100%',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 12,
                    border: '1px solid #E2E8F0',
                    borderRadius: 10,
                    background: advancedOpen ? '#F8FAFC' : '#FFFFFF',
                    padding: '11px 12px',
                    cursor: 'pointer',
                    textAlign: 'left',
                  }}
                >
                  <div>
                    <div style={{ fontSize: 12.5, fontWeight: 700, color: '#0F172A' }}>Advanced rules</div>
                    <div style={{ fontSize: 11.5, color: '#6B7280', marginTop: 2 }}>
                      Perspective-level counts and weight % limits for edge-case setups.
                    </div>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
                    <span style={{
                      fontSize: 11.5,
                      fontWeight: 600,
                      color: advancedValueCount > 0 ? '#2563EB' : '#94A3B8',
                      background: advancedValueCount > 0 ? '#EFF6FF' : '#F8FAFC',
                      borderRadius: 999,
                      padding: '4px 9px',
                    }}>
                      {advancedValueCount > 0 ? `${advancedValueCount} active` : 'Optional'}
                    </span>
                    <span style={{ fontSize: 15, color: '#64748B' }}>{advancedOpen ? 'Hide' : 'Show'}</span>
                  </div>
                </button>

                {advancedOpen && (
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12, marginTop: 12 }}>
                    <LimitField label="Min KRAs / Perspective" value={rule.minKRAsPerPersp} onChange={v => updateRule(group.id, { minKRAsPerPersp: v })} />
                    <LimitField label="Max KRAs / Perspective" value={rule.maxKRAsPerPersp} onChange={v => updateRule(group.id, { maxKRAsPerPersp: v })} />
                    <LimitField label="Min KRA weight %" value={rule.minKRAWeight} onChange={v => updateRule(group.id, { minKRAWeight: v })} />
                    <LimitField label="Max KRA weight %" value={rule.maxKRAWeight} onChange={v => updateRule(group.id, { maxKRAWeight: v })} />
                    {hasKPIs && <>
                      <LimitField label="Min KPI weight %" value={rule.minKPIWeight} onChange={v => updateRule(group.id, { minKPIWeight: v })} />
                      <LimitField label="Max KPI weight %" value={rule.maxKPIWeight} onChange={v => updateRule(group.id, { maxKPIWeight: v })} />
                    </>}
                  </div>
                )}
              </div>
            </div>
          </div>
        );
      })}

      <StepStatusBar
        applied={isApplied}
        valid={true}
        appliedMessage={enabled ? "Limits confirmed." : "No limits — employees can set any number of KRAs."}
        pendingMessage="Confirm limits to proceed."
        buttonLabel="Confirm Limits"
        onApply={() => update('limitsAppliedSnapshot', `confirmed_${Date.now()}`)}
      />
    </div>
  );
}

/* ─── STEP SUMMARY ───────────────────────────────────────────────────────── */
function StepSummary({ config, onLaunched }) {
  const SUMMARY_MAX_WIDTH = 1120;
  const groups = config.goalGroups || [];
  const libraries = config.goalLibraries || [];
  const employees = config.employeeUploadData?.employees || [];
  const missingGoalGroupNames = config.employeeUploadData?.missingGoalGroupNames || [];
  const deferredGoalGroupNames = normalizeDeferredGoalGroups(config.deferredGoalGroupNames || []);
  const employeeWarnings = config.employeeUploadData?.validationWarnings || [];
  const perspectives = (config.perspectives || []).filter(p => p.name && p.weight);
  const fw = FRAMEWORKS.find(f => f.id === config.frameworkId);
  const employeeCodeSet = new Set(
    employees.map((employee) => String(employee['Employee Code'] || '').trim().toLowerCase()).filter(Boolean)
  );
  const employeeByCode = new Map(
    employees
      .map((employee) => [String(employee['Employee Code'] || '').trim().toLowerCase(), employee])
      .filter(([code]) => code)
  );
  const [expandedGroupIds, setExpandedGroupIds] = useState([]);
  const groupSummary = groups.map(g => {
    const assignments = getGroupLibraryAssignments(g);
    const configuredAssignments = assignments
      .map(assignment => ({
        ...assignment,
        library: libraries.find(library => library.id === assignment.libraryId) || null,
      }))
      .filter(assignment => assignment.library);
    return { ...g, configuredAssignments, assignmentCount: assignments.length };
  });

  const outsideManagerWarningCategories = new Set([
    'manager_not_in_file',
    'l2_manager_not_in_file',
    'manager_outside_pms',
    'l2_manager_outside_pms',
  ]);
  const intentionalOutsideManagerCodes = new Set(
    employeeWarnings
      .filter((warning) => outsideManagerWarningCategories.has(warning.category) && isIntentionalOutsideManagerWarning(warning))
      .map((warning) => {
        const match = String(warning.message || '').match(/Manager "([^"]+)"/i);
        return String(match?.[1] || warning.code || '').trim().toLowerCase();
      })
      .filter(Boolean)
  );

  const coverageByGroup = groupSummary.map((group) => {
    const members = employees.filter((employee) => String(employee.assignedGoalGroupName || employee['Group Name'] || '').trim().toLowerCase() === String(group.name || '').trim().toLowerCase());
    const memberCodeMap = new Map(
      members
        .map((employee) => [String(employee['Employee Code'] || '').trim().toLowerCase(), employee])
        .filter(([code]) => code)
    );
    const directReportsMap = new Map();
    const externalManagerMap = new Map();

    members.forEach((employee) => {
      const managerCodeRaw = String(employee['Reporting Manager Code'] || '').trim();
      const managerCode = managerCodeRaw.toLowerCase();
      if (!managerCode) return;
      const list = directReportsMap.get(managerCode) || [];
      list.push(employee);
      directReportsMap.set(managerCode, list);

      if (!memberCodeMap.has(managerCode)) {
        const managerName = String(employee['Reporting Manager Name'] || '').trim();
        const managerEmployee = employeeByCode.get(managerCode);
        const existing = externalManagerMap.get(managerCode) || {
          code: managerCodeRaw || managerCode,
          name: managerEmployee?.['Employee Name'] || managerName || `Manager ${managerCodeRaw || managerCode}`,
          kind: managerEmployee ? 'cross-group' : (intentionalOutsideManagerCodes.has(managerCode) ? 'outside' : 'unresolved'),
        };
        if (!existing.name && (managerEmployee?.['Employee Name'] || managerName)) {
          existing.name = managerEmployee?.['Employee Name'] || managerName;
        }
        if (existing.kind === 'unresolved' && managerEmployee) existing.kind = 'cross-group';
        if (existing.kind !== 'outside' && intentionalOutsideManagerCodes.has(managerCode)) {
          existing.kind = 'outside';
        }
        externalManagerMap.set(managerCode, existing);
      }
    });

    const buildMemberNode = (employee, trail = new Set()) => {
      const code = String(employee['Employee Code'] || '').trim().toLowerCase();
      if (!code || trail.has(code)) return { type: 'employee', employee, reports: [], reportCount: 0 };
      const nextTrail = new Set(trail);
      nextTrail.add(code);
      const reports = (directReportsMap.get(code) || [])
        .slice()
        .sort((left, right) => String(left['Employee Name'] || '').localeCompare(String(right['Employee Name'] || '')))
        .map((item) => buildMemberNode(item, nextTrail));
      return { type: 'employee', employee, reports, reportCount: reports.length };
    };

    const internalRootNodes = members
      .filter((employee) => {
        const managerCode = String(employee['Reporting Manager Code'] || '').trim().toLowerCase();
        return !managerCode || !memberCodeMap.has(managerCode);
      })
      .sort((left, right) => String(left['Employee Name'] || '').localeCompare(String(right['Employee Name'] || '')))
      .filter((employee) => {
        const managerCode = String(employee['Reporting Manager Code'] || '').trim().toLowerCase();
        return !managerCode;
      })
      .map((employee) => buildMemberNode(employee));

    const externalRootNodes = Array.from(externalManagerMap.entries())
      .sort((left, right) => String(left[1].name || left[1].code).localeCompare(String(right[1].name || right[1].code)))
      .map(([managerCode, manager]) => {
        const reports = (directReportsMap.get(managerCode) || [])
          .slice()
          .sort((left, right) => String(left['Employee Name'] || '').localeCompare(String(right['Employee Name'] || '')))
          .map((employee) => buildMemberNode(employee, new Set([managerCode])));
        return {
          type: 'manager-placeholder',
          manager,
          reports,
          reportCount: reports.length,
        };
      });

    const rootNodes = [...internalRootNodes, ...externalRootNodes];

    const assignmentSummaries = group.configuredAssignments.map((assignment) => {
      const employeeCount = members.filter((employee) => {
        const match = getAssignedLibraryForGroup(employee, group, config);
        return match.library?.id === assignment.library?.id
          && String(match.assignment?.slotKey || '') === String(assignment.slotKey || '');
      }).length;
      return { ...assignment, employeeCount };
    });

    return {
      id: group.id,
      name: group.name,
      members,
      rootNodes,
      assignmentSummaries,
    };
  });

  const warnings = [];
  const groupsNeedingLib = groups.filter(g => isGroupLibraryEnabled(g) && getGroupLibraryAssignments(g).some(assignment => !assignment.libraryId));
  if (groupsNeedingLib.length > 0) warnings.push(`${groupsNeedingLib.length} group(s) have Goal Library enabled but no library assigned.`);
  if (employees.length === 0) warnings.push('No employees uploaded yet.');
  if (missingGoalGroupNames.length > 0) warnings.push(`No employees were uploaded for: ${missingGoalGroupNames.join(', ')}. The current employee upload is treated as the full master list.`);


  function toggleGroupDetails(groupId) {
    setExpandedGroupIds((prev) => (
      prev.includes(groupId)
        ? prev.filter((item) => item !== groupId)
        : [...prev, groupId]
    ));
  }

  return (
    <div style={{ maxWidth: SUMMARY_MAX_WIDTH, margin: '0 auto', paddingBottom: 60 }}>
      <div style={{ marginBottom: 28 }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: '#94A3B8', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 6 }}>Final Step</div>
        <h2 style={{ margin: 0, fontSize: 22, fontWeight: 800, color: '#0F172A' }}>Review & Launch</h2>
        <p style={{ margin: '8px 0 0', fontSize: 14, color: '#64748B', lineHeight: 1.6 }}>Review your complete configuration before going live.</p>
      </div>

      {/* Framework */}
      <div style={{ background: 'linear-gradient(180deg, #FFFFFF 0%, #F8FBFF 100%)', border: '1.5px solid #DCE8F8', borderRadius: 12, padding: '14px 18px', marginBottom: 14, boxShadow: '0 10px 24px rgba(37,99,235,.05)' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: '#0F172A' }}>Performance Framework</div>
          <span style={{ fontSize: 12.5, fontWeight: 600, color: '#2563EB', background: '#EFF6FF', padding: '3px 10px', borderRadius: 20 }}>{fw?.name || config.frameworkId}</span>
        </div>
        {perspectives.length > 0 && (
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 10 }}>
            {perspectives.map((p, i) => (
              <div key={i} style={{ padding: '3px 9px', borderRadius: 20, background: '#F8FAFC', border: '1px solid #E2E8F0', fontSize: 11.5 }}>
                <span style={{ fontWeight: 600, color: '#374151' }}>{p.name}</span>
                <span style={{ color: '#9CA3AF', marginLeft: 5 }}>{p.weight}%</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Groups */}
      <div style={{ background: 'linear-gradient(180deg, #FFFFFF 0%, #FAFCFF 100%)', border: '1.5px solid #E2E8F0', borderRadius: 12, padding: '18px 22px', marginBottom: 14, boxShadow: '0 12px 28px rgba(15,23,42,.04)' }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: '#0F172A', marginBottom: 14 }}>Employee Groups ({groups.length})</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {groupSummary.map((g) => {
            const groupCoverage = coverageByGroup.find((item) => item.id === g.id);
            const isExpanded = expandedGroupIds.includes(g.id);
            return (
              <div key={g.id} style={{ padding: '10px 14px', background: '#FFFFFF', borderRadius: 10, border: '1px solid #E4ECF4', boxShadow: '0 6px 14px rgba(15,23,42,.03)' }}>
                <button
                  type="button"
                  onClick={() => toggleGroupDetails(g.id)}
                  aria-label={isExpanded ? `Collapse ${g.name}` : `Expand ${g.name}`}
                  style={{
                    width: '100%',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 10,
                    marginBottom: isExpanded && groupCoverage?.assignmentSummaries?.length ? 10 : 0,
                    background: 'none',
                    border: 'none',
                    padding: 0,
                    cursor: 'pointer',
                    textAlign: 'left',
                    fontFamily: 'inherit',
                  }}
                >
                  <div style={{ fontSize: 13, fontWeight: 700, color: '#1E293B' }}>{g.name}</div>
                  <div style={{ fontSize: 11.5, fontWeight: 700, color: '#2563EB', background: '#EFF6FF', border: '1px solid #BFDBFE', borderRadius: 999, padding: '3px 9px' }}>
                    {groupCoverage?.members?.length || 0}
                  </div>
                </button>
                {isExpanded && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                    {g.prefillType && (
                      <div>
                        <div style={{ fontSize: 11.5, fontWeight: 700, color: '#64748B', textTransform: 'uppercase', letterSpacing: '.05em', marginBottom: 8 }}>Pre-fill Setup</div>
                        <div style={{ padding: '8px 10px', borderRadius: 8, background: '#fff', border: '1px solid #E2E8F0', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
                          <div>
                            <div style={{ fontSize: 12.5, fontWeight: 700, color: '#0F172A' }}>
                              {g.prefillType === 'kra-kpi' ? 'KRAs + KPIs' : 'KRAs only'}
                              <span style={{ fontSize: 11, fontWeight: 600, marginLeft: 8, color: '#64748B' }}>
                                · {g.prefillEditability === 'locked' ? 'Locked' : g.prefillEditability === 'edit-freely' ? 'Free edit' : 'Add KPIs'}
                              </span>
                            </div>
                          </div>
                          <div style={{ fontSize: 11.5, fontWeight: 700, color: '#2563EB' }}>
                            {getGroupPrefillAssignments(g).filter(assignment => (assignment.data || []).length > 0).length}/{getGroupPrefillAssignments(g).length} cards
                          </div>
                        </div>
                      </div>
                    )}
                    {groupCoverage?.assignmentSummaries?.length > 0 && (
                      <div>
                        <div style={{ fontSize: 11.5, fontWeight: 700, color: '#64748B', textTransform: 'uppercase', letterSpacing: '.05em', marginBottom: 8 }}>Associated Libraries</div>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                          {groupCoverage.assignmentSummaries.map((assignment) => (
                            <div key={`${g.id}_${assignment.slotKey || assignment.library?.id}`} style={{ padding: '8px 10px', borderRadius: 8, background: '#fff', border: '1px solid #E2E8F0', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
                              <div>
                                <div style={{ fontSize: 12.5, fontWeight: 700, color: '#0F172A' }}>
                                  {assignment.library?.name || assignment.label}
                                  {assignment.library?.type && <span style={{ fontSize: 11, fontWeight: 600, marginLeft: 8, color: '#64748B' }}>· {assignment.library.type === 'kra-kpi' ? 'KRA+KPI' : 'KRA only'}</span>}
                                </div>
                              </div>
                              <div style={{ fontSize: 11.5, fontWeight: 700, color: '#2563EB' }}>{assignment.employeeCount}</div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Rollout structure */}
      <div style={{ background: 'linear-gradient(180deg, #FFFFFF 0%, #F7FAFF 100%)', border: '1.5px solid #DCE7F5', borderRadius: 12, padding: '18px 22px', marginBottom: 20, boxShadow: '0 18px 40px rgba(37,99,235,.08)' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginBottom: 14, flexWrap: 'wrap' }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: '#0F172A' }}>PMS Rollout Structure</div>
          <span style={{
            fontSize: 11.5,
            fontWeight: 700,
            color: config.limitsEnabled ? '#16A34A' : '#64748B',
            background: config.limitsEnabled ? '#F0FDF4' : '#F8FAFC',
            border: `1px solid ${config.limitsEnabled ? '#BBF7D0' : '#E2E8F0'}`,
            padding: '4px 10px',
            borderRadius: 999,
          }}>
            Goal limits: {config.limitsEnabled ? 'Enabled' : 'Disabled'}
          </span>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 10, marginBottom: 16 }}>
          {[
            { label: 'Employees In PMS', value: employees.length, color: '#2563EB', bg: '#EFF6FF' },
            { label: 'Groups In Rollout', value: `${coverageByGroup.filter((group) => group.members.length > 0).length}/${groups.length || 0}`, color: '#16A34A', bg: '#F0FDF4' },
            { label: 'Deferred Groups', value: deferredGoalGroupNames.length, color: '#D97706', bg: '#FFFBEB' },
          ].map((item) => (
            <div key={item.label} style={{ padding: '12px 14px', borderRadius: 10, background: item.bg, border: '1px solid #E5E7EB' }}>
              <div style={{ fontSize: 11.5, color: '#64748B', marginBottom: 6 }}>{item.label}</div>
              <div style={{ fontSize: 20, fontWeight: 800, color: item.color }}>{item.value}</div>
            </div>
          ))}
        </div>

        <OrgChartPanel employees={employees} groups={groups} />

        {deferredGoalGroupNames.length > 0 && (
          <div style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: '#64748B', textTransform: 'uppercase', letterSpacing: '.05em', marginBottom: 8 }}>Deferred groups</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {deferredGoalGroupNames.map((name) => (
                <div key={name} style={{ padding: '6px 10px', borderRadius: 999, background: '#EFF6FF', border: '1px solid #BFDBFE', fontSize: 11.5, fontWeight: 700, color: '#1D4ED8' }}>
                  {name}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Warnings */}
      {warnings.length > 0 && (
        <div style={{ background: '#FFFBEB', border: '1.5px solid #FDE68A', borderRadius: 10, padding: '14px 18px', marginBottom: 20 }}>
          <div style={{ fontSize: 12.5, fontWeight: 700, color: '#92400E', marginBottom: 6 }}>⚠️ Warnings</div>
          {warnings.map((w, i) => <div key={i} style={{ fontSize: 12.5, color: '#78350F', marginBottom: 3 }}>· {w}</div>)}
        </div>
      )}
      {/* Launch */}
      <div style={{ background: 'linear-gradient(135deg,#1E293B,#0F172A)', borderRadius: 14, padding: '28px 32px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div>
          <div style={{ fontSize: 16, fontWeight: 800, color: '#fff', marginBottom: 4 }}>Ready to go live?</div>
          <div style={{ fontSize: 13, color: '#94A3B8' }}>This will activate the appraisal cycle for all employees.</div>
        </div>
        <button
          type="button"
          onClick={onLaunched}
          style={{ padding: '12px 28px', background: '#16A34A', color: '#fff', border: 'none', borderRadius: 10, fontSize: 14, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit', boxShadow: '0 4px 14px rgba(22,163,74,.4)' }}
        >
          🚀 Launch Cycle
        </button>
      </div>
    </div>
  );
}

function StepGoalLibrary({ config, update }) {
  const groups   = config.goalGroups || [];
  const strategy = config.goalGroupStrategy || 'uniform';
  const segAttr  = config.goalGroupAttr || 'Department';

  const isValid   = isGoalGroupsValid(config);
  const isApplied = isValid && config.goalGroupsAppliedSnapshot === getGoalGroupsSnapshot(config);

  function setStrategy(nextStrategy) {
    update('goalGroupStrategy', nextStrategy);
    if (nextStrategy === 'uniform') {
      // Merge to single default group, preserving first group's settings
      const first = groups[0] || {};
      update('goalGroups', [makeDefaultGroup({
        id: first.id || 'grp_default',
        name: 'All Employees',
        segmentAttr: null,
        segmentValues: [],
        modes: first.modes || ['free'],
        prefillData: first.prefillData || [],
        prefillEditability: first.prefillEditability || 'add-kpis',
        libraryData: first.libraryData || [],
        goalLimitsEnabled: first.goalLimitsEnabled || false,
        goalMin: first.goalMin || 3,
        goalMax: first.goalMax || 8,
        kraWeightsEnabled: first.kraWeightsEnabled !== false,
        kpiWeightsEnabled: first.kpiWeightsEnabled || false,
      })]);
    } else if (groups.length === 0) {
      // Add default group
      update('goalGroups', [makeDefaultGroup()]);
    }
  }

  function updateGroup(id, changes) {
    update('goalGroups', groups.map(g => g.id === id ? { ...g, ...changes } : g));
    update('goalGroupsAppliedSnapshot', null); // mark as dirty
  }

  function removeGroup(id) {
    update('goalGroups', groups.filter(g => g.id !== id));
    update('goalGroupsAppliedSnapshot', null);
  }

  function addGroup() {
    const last = groups[groups.length - 1];
    const isLastDefault = !last?.segmentValues?.length;
    const newGroup = makeDefaultGroup({
      name: `Group ${groups.length}`,
      segmentAttr: segAttr,
      segmentValues: [],
      modes: ['free'],
    });
    if (isLastDefault) {
      // Insert before the default (last) group
      update('goalGroups', [...groups.slice(0, -1), newGroup, last]);
    } else {
      update('goalGroups', [...groups, newGroup]);
    }
    update('goalGroupsAppliedSnapshot', null);
  }

  function applyConfig() {
    // Compute legacy fields for backward compat
    const hasAnyPrefill = groups.some(g => g.modes?.includes('prefill'));
    const hasAnyLibrary = groups.some(g => g.modes?.includes('library'));
    const hasAnyFree    = groups.some(g => g.modes?.includes('free'));

    // Write legacy goalCreationMode so old code paths still work
    if (hasAnyPrefill && !hasAnyFree && !hasAnyLibrary) {
      update('goalCreationMode', 'admin-library');
    } else if (!hasAnyPrefill && !hasAnyLibrary) {
      update('goalCreationMode', 'employee-self');
    } else {
      update('goalCreationMode', 'mixed');
    }

    // Build legacy goalLibraryData from prefillData of the first/only group
    if (hasAnyPrefill) {
      const prefillGroups = groups.filter(g => g.modes?.includes('prefill'));
      if (prefillGroups.length === 1) {
        const g = prefillGroups[0];
        update('goalLibraryData', { byAttr: false, attrLabel: null, data: g.prefillData || [] });
      } else {
        // Multiple prefill groups: build byAttr structure
        const data = {};
        prefillGroups.forEach(g => {
          (g.segmentValues || []).forEach(v => { data[v] = g.prefillData || []; });
        });
        update('goalLibraryData', { byAttr: true, attrLabel: segAttr, data });
      }
    }

    update('goalKpiMode', groups[0]?.kpiWeightsEnabled ? 'kra-kpi' : 'kra-only');
    update('goalEmployeeEdit', groups[0]?.prefillEditability || 'add-kpis');
    update('goalGroupsAppliedSnapshot', getGoalGroupsSnapshot(config));
    update('goalsAppliedSnapshot', 'migrated-to-groups'); // mark old snapshot as done too
  }

  const needsDataCount = groupsNeedingDataUpload(config).length;

  return (
    <div style={{ maxWidth: 860, margin: '0 auto', paddingBottom: 40 }}>
      {/* Page header */}
      <div style={{ marginBottom: 24 }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: '#94A3B8', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 6 }}>Flat KRA / KPI Structure</div>
        <h2 style={{ margin: 0, fontSize: 22, fontWeight: 800, color: '#0F172A' }}>Goal Creation Strategy</h2>
        <p style={{ margin: '8px 0 0', fontSize: 14, color: '#64748B', lineHeight: 1.6 }}>
          Define how employees create and manage KRAs and KPIs. This follows the BSC setup rhythm, without the perspective layer.
        </p>
      </div>

      {/* Group cards */}
      {groups.length === 0 && (
        <div style={{ padding: '30px', textAlign: 'center', color: '#94A3B8', border: '1.5px dashed #E2E8F0', borderRadius: 12, marginBottom: 14 }}>
          No groups configured. Click &quot;+ Add Group&quot; below.
        </div>
      )}
      {groups.map((group, idx) => (
        <GoalGroupCard
          key={group.id}
          group={group}
          index={idx}
          isDefault={groups.length > 1 && idx === groups.length - 1}
          isOnlyGroup={groups.length === 1}
          segAttr={segAttr}
          onUpdate={changes => updateGroup(group.id, changes)}
          onDelete={() => removeGroup(group.id)}
        />
      ))}

      <button
        type="button"
        onClick={addGroup}
        style={{
          display: 'flex', alignItems: 'center', gap: 8,
          padding: '10px 18px', border: '1.5px dashed #93C5FD', borderRadius: 8,
          background: '#F0F7FF', color: '#2563EB', fontWeight: 600, fontSize: 13,
          cursor: 'pointer', marginBottom: 20, width: '100%', justifyContent: 'center',
        }}
      >
        + Add Employee Group
      </button>

      {/* Summary */}
      {needsDataCount > 0 && (
        <div style={{ padding: '12px 18px', background: '#F0FDF4', border: '1px solid #BBF7D0', borderRadius: 8, marginBottom: 16, fontSize: 13, color: '#15803D' }}>
          ✅ <strong>{needsDataCount} group{needsDataCount !== 1 ? 's' : ''}</strong> will require KRA data upload in the next step.
          {' '}This includes pre-fill data and/or reference library content.
        </div>
      )}

      {/* Apply button */}
      <StepStatusBar
        applied={isApplied}
        valid={isValid}
        appliedMessage="Goal strategy applied — proceed to next step."
        pendingMessage={groups.length === 0 ? 'Add at least one employee group to continue.' : 'Review configuration and click Apply to proceed.'}
        buttonLabel="Apply Goal Strategy"
        onApply={applyConfig}
      />
    </div>
  );
}

/* ── OLD StepGoalLibrary BODY BELOW — replaced above, keeping a placeholder to mark removal ── */
function _OldStepGoalLibraryBody_REMOVED({ config, update }) {
  const [expandedNodes, setExpandedNodes] = useState([]);
  const [entryMode, setEntryMode] = useState('upload');
  const [editingSegValueId, setEditingSegValueId] = useState(null);
  const [editingSegValueDraft, setEditingSegValueDraft] = useState('');
  const treeRef = useRef(null);

  const c = config;
  const segVals   = (c.goalSegmentValues || []).filter(v => v.name.trim());
  const attrLabel = c.goalSegmentAttr || 'Department';
  const limAttr   = c.goalLimitAttr   || 'Department';
  const goalSettingsValid = isGoalSettingsValid(config);
  const goalSettingsApplied = goalSettingsValid && config.goalsAppliedSnapshot === getGoalsSnapshot(config);
  const segmentValuesConfirmed = !!c.goalSegmentValuesConfirmed || goalSettingsApplied;

  function choose(key, val, nodeId = null) {
    update(key, val);
    if (nodeId) {
      setExpandedNodes((prev) => (prev.includes(nodeId) ? prev : [...prev, nodeId]));
    }
  }
  function editing(id) { return expandedNodes.includes(id); }
  function done(id, cond) { return cond; }

  useEffect(() => {
    if (!expandedNodes.length) return;

    function handlePointerDown(event) {
      if (treeRef.current && !treeRef.current.contains(event.target)) {
        setExpandedNodes([]);
      }
    }

    document.addEventListener('mousedown', handlePointerDown);
    return () => document.removeEventListener('mousedown', handlePointerDown);
  }, [expandedNodes]);

  function addSegVal()  { update('goalSegmentValues', [...(c.goalSegmentValues||[]), { id: Date.now(), name:'' }]); }
  function delSegVal(id){ update('goalSegmentValues', (c.goalSegmentValues||[]).filter(v=>v.id!==id)); }
  function setSegVal(id,name){ update('goalSegmentValues', (c.goalSegmentValues||[]).map(v=>v.id===id?{...v,name}:v)); }
  function addLimVal()  { update('goalLimitValues', [...(c.goalLimitValues||[]), { id:Date.now(), name:'', min:3, max:8 }]); }
  function delLimVal(id){ update('goalLimitValues', (c.goalLimitValues||[]).filter(v=>v.id!==id)); }
  function setLimVal(id,f,v){ update('goalLimitValues', (c.goalLimitValues||[]).map(x=>x.id===id?{...x,[f]:v}:x)); }

  function startSegValueEdit(item) {
    if (segmentValuesConfirmed) return;
    setEditingSegValueId(item.id);
    setEditingSegValueDraft(item.name);
  }

  function cancelSegValueEdit() {
    setEditingSegValueId(null);
    setEditingSegValueDraft('');
  }

  function commitSegValueEdit(id) {
    const cleaned = String(editingSegValueDraft || '').trim();
    if (!cleaned) return;
    const duplicate = (c.goalSegmentValues || []).some((value) => value.id !== id && String(value.name || '').trim().toLowerCase() === cleaned.toLowerCase());
    if (duplicate) return;
    setSegVal(id, cleaned);
    cancelSegValueEdit();
  }

  /* ── build node list ─────────────────────────────────────── */
  const nodes = [];

  // N0: creation mode
  const n0done = done('n0', !!c.goalCreationMode);
  const pathColor = c.goalCreationMode === 'employee-self' ? TREE_AMBER : TREE_BLUE;
  nodes.push({
    id:'n0', done:n0done, color: pathColor,
      question: 'How will goals be created?',
      summary: c.goalCreationMode === 'admin-library' ? '🏛️ Admin builds a Goal Library' : '✍️ Employees create their own goals',
      connLabel: c.goalCreationMode === 'admin-library' ? 'Admin Library' : 'Employee self-create',
      render: () => (
        <ActiveNode question="How will goals be created?" color={TREE_BLUE}>
        <ChoiceGrid color={TREE_BLUE} selectedId={c.goalCreationMode} onSelect={v => choose('goalCreationMode', v, 'n0')} choices={[
          { id:'admin-library', icon:'🏛️', title:'Admin builds a Goal Library',    desc:'Goal Library is required. HR pre-defines KRAs and KPIs, and employees work from that library.' },
          { id:'employee-self', icon:'✍️', title:'Employees create their own goals', desc:'No Goal Library required. Employees write goals from scratch and managers review and approve.' },
        ]} />
      </ActiveNode>
    ),
  });

  if (!n0done) { /* tree stops here */ }

  else if (c.goalCreationMode === 'admin-library') {
    // N1: library scope
    const n1done = done('n1', !!c.goalLibraryScope);
    nodes.push({
      id:'n1', done:n1done, color:TREE_BLUE,
      question: 'Will the goal library be the same for all employees?',
      summary: c.goalLibraryScope === 'common' ? '🌐 Common for all' : <>🗂️ Differs by <MagicText text={attrLabel} /></>,
      connLabel: c.goalLibraryScope === 'common' ? 'Common for all' : `By ${attrLabel}`,
      render: () => (
        <ActiveNode question="Will the goal library be the same for all employees?" color={TREE_BLUE}>
          <ChoiceGrid color={TREE_BLUE} selectedId={c.goalLibraryScope} onSelect={v => choose('goalLibraryScope', v, 'n1')} choices={[
            { id:'common',       icon:'🌐', title:'Common for all employees', desc:'One shared KRA library that applies to everyone.' },
            { id:'by-attribute', icon:'🗂️', title:'Differs by attribute',     desc:'Different KRA sets per group — e.g. each Department gets its own goals.' },
          ]} />
        </ActiveNode>
      ),
    });

    if (n1done && c.goalLibraryScope === 'by-attribute') {
      // N2: segment values
      const hasSegmentValues = segVals.length > 0;
      const n2done = done('n2', hasSegmentValues && segmentValuesConfirmed);
      nodes.push({
        id:'n2', done:n2done, color:TREE_BLUE,
        question: <>Define <MagicText text={attrLabel} /> values</>,
        summary: segVals.map(v=>v.name).join(' · '),
        connLabel: `${segVals.length} values`,
        render: () => (
          <ActiveNode question={<>Define <MagicText text={attrLabel} /> values</>} color={TREE_BLUE} hint={<>Each unique <MagicText text={attrLabel} /> gets its own KRA set</>}>
            <SegmentAttributeInput
              value={c.goalSegmentAttr}
              onChange={(nextValue) => update('goalSegmentAttr', nextValue)}
            />
            <div style={{marginTop:14,marginBottom:8,fontSize:11.5,fontWeight:600,color:'#374151',textTransform:'uppercase',letterSpacing:'0.04em'}}>Unique <MagicText text={attrLabel} /> values</div>
            <div style={{display:'flex',flexWrap:'wrap',gap:8,marginBottom:12,alignItems:'center'}}>
              {(c.goalSegmentValues||[]).map(v=>(
                editingSegValueId === v.id ? (
                  <div key={v.id} style={{display:'flex',alignItems:'center',gap:6,background:'#FFFFFF',border:'1.5px solid #93C5FD',borderRadius:10,padding:'4px 6px 4px 10px',boxShadow:'0 0 0 3px rgba(37,99,235,.08)'}}>
                    <input
                      autoFocus
                      value={editingSegValueDraft}
                      onChange={(e) => setEditingSegValueDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          commitSegValueEdit(v.id);
                        }
                        if (e.key === 'Escape') {
                          e.preventDefault();
                          cancelSegValueEdit();
                        }
                      }}
                      onBlur={() => commitSegValueEdit(v.id)}
                      style={{border:'none',background:'transparent',fontSize:13,color:'#1e40af',fontWeight:600,outline:'none',minWidth:90,fontFamily:'inherit'}}
                    />
                  </div>
                ) : (
                  <div
                    key={v.id}
                    style={{display:'flex',alignItems:'center',gap:5,background:'#EFF4FF',border:'1.5px solid #BFCFFE',borderRadius:8,padding:'4px 10px',opacity:segmentValuesConfirmed ? 0.92 : 1}}
                  >
                    <button
                      type="button"
                      onClick={() => startSegValueEdit(v)}
                      disabled={segmentValuesConfirmed}
                      title={segmentValuesConfirmed ? 'Confirmed values are locked' : 'Click to edit'}
                      style={{border:'none',background:'transparent',padding:0,display:'flex',alignItems:'center',cursor:segmentValuesConfirmed ? 'default' : 'text',fontFamily:'inherit'}}
                    >
                      <span style={{fontSize:13,color:'#1e40af',fontWeight:500}}>{v.name}</span>
                    </button>
                    {!segmentValuesConfirmed ? (
                      <button
                        type="button"
                        onClick={() => delSegVal(v.id)}
                        style={{background:'none',border:'none',cursor:'pointer',color:'#DC2626',fontSize:13,padding:0,lineHeight:1,fontFamily:'inherit'}}
                        aria-label={`Delete ${v.name}`}
                      >
                        ✕
                      </button>
                    ) : null}
                  </div>
                )
              ))}
              {!segmentValuesConfirmed ? (
                <SegmentValueInput
                  attrKey={c.goalSegmentAttr || 'Department'}
                  existingValues={(c.goalSegmentValues||[]).map(v=>v.name)}
                  onAdd={name => update('goalSegmentValues', [...(c.goalSegmentValues||[]), { id: Date.now(), name }])}
                />
              ) : null}
            </div>
            {!segmentValuesConfirmed ? (
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 12 }}>
                <div style={{ fontSize: 11.5, color: '#64748B' }}>
                  Add values manually or import them from Excel.
                </div>
                <AttributeSheetControls
                  attrLabel={attrLabel}
                  values={(c.goalSegmentValues || []).map(v => v.name)}
                  onImported={(importedValues) => {
                    cancelSegValueEdit();
                    update('goalSegmentValues', importedValues.map((name, index) => ({ id: Date.now() + index, name })));
                    update('goalSegmentValuesConfirmed', false);
                  }}
                />
              </div>
            ) : null}
            {hasSegmentValues && (
              <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 4 }}>
                <button
                  onClick={() => {
                    update('goalSegmentValuesConfirmed', true);
                    setExpandedNodes((prev) => (prev.includes('n2') ? prev : [...prev, 'n2']));
                    requestAnimationFrame(() => {
                      const nextNode = treeRef.current?.querySelector('[data-goal-entry-node="true"]');
                      nextNode?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                    });
                  }}
                  style={{padding:'8px 16px',background:TREE_BLUE,color:'#fff',border:'none',borderRadius:8,fontSize:13,fontWeight:600,cursor:'pointer',fontFamily:'inherit'}}
                >
                  {segmentValuesConfirmed ? 'Confirmed' : 'Confirm'}
                </button>
              </div>
            )}
            {segmentValuesConfirmed ? (
              <div style={{marginTop:10,fontSize:12,color:'#64748B',lineHeight:1.45}}>
                These confirmed {attrLabel.toLowerCase()} values are stored in the wizard state and can be reused as the master list for the Excel template.
              </div>
            ) : null}
          </ActiveNode>
        ),
      });

    }

    // Pre-entry gate: scope + any attribute questions are done
    const preEntryDone = n1done && (
      c.goalLibraryScope === 'common' ||
      (c.goalLibraryScope === 'by-attribute' && segVals.length > 0 && segmentValuesConfirmed)
    );

    if (preEntryDone) {
      // N_KPI: what goes in the library?
      const nKpiDone = done('n_kpi', !!c.goalKpiMode);
      nodes.push({
        id: 'n_kpi', done: nKpiDone, color: TREE_BLUE,
        question: 'What should the library include?',
        summary: c.goalKpiMode === 'kra-only' ? '📋 KRAs only' : '🎯 KRAs and KPIs',
        connLabel: c.goalKpiMode === 'kra-only' ? 'KRAs only' : 'KRAs and KPIs',
        render: () => (
          <ActiveNode question="What should the library include?" color={TREE_BLUE}>
            <ChoiceGrid color={TREE_BLUE} selectedId={c.goalKpiMode} onSelect={v => choose('goalKpiMode', v, 'n_kpi')} choices={[
              { id: 'kra-only', icon: '📋', title: 'KRAs only', desc: 'You define the result areas. Each employee will fill in their own KPIs and targets during goal setting.' },
              { id: 'kra-kpi',  icon: '🎯', title: 'KRAs and KPIs', desc: 'You pre-define both the result areas and the specific metrics. Employees get a fully built-out library to work from.' },
            ]} />
          </ActiveNode>
        ),
      });

      if (nKpiDone) {
        // N_EDIT: what can employees change?
        const nEditDone = done('n_edit', !!c.goalEmployeeEdit);
        const nEditChoices = c.goalKpiMode === 'kra-kpi' ? [
          { id: 'locked',      icon: '🔒', title: 'View and submit only',    desc: 'Employees see the full pre-built library and submit as-is. They cannot add or change anything.' },
          { id: 'add-kpis',    icon: '✏️', title: 'They can add extra KPIs', desc: 'KRAs and the pre-loaded KPIs are fixed, but employees can add their own additional KPIs under each KRA.' },
          { id: 'edit-freely', icon: '🔓', title: 'They can edit and add freely', desc: 'Employees can edit KPI details, adjust weights, and add new KRAs or KPIs. Requires manager approval.' },
        ] : [
          { id: 'locked',      icon: '🔒', title: 'View and submit only',   desc: 'Employees see the pre-loaded KRAs and submit without making any changes.' },
          { id: 'add-kpis',    icon: '✏️', title: 'They fill in their own KPIs', desc: 'Employees get the pre-loaded KRAs and define their own KPI names and targets under each one.' },
          { id: 'edit-freely', icon: '🔓', title: 'They can edit and add freely', desc: 'Employees can add new KRAs, edit weights, and define their own KPIs. Requires manager approval.' },
        ];
        const editSummaryMap = {
          locked:        '🔒 View and submit only',
          'add-kpis':    c.goalKpiMode === 'kra-kpi' ? '✏️ Can add extra KPIs' : '✏️ They fill in their KPIs',
          'edit-freely': '🔓 Edit and add freely',
        };
        nodes.push({
          id: 'n_edit', done: nEditDone, color: TREE_BLUE,
          question: 'What can employees change during goal setting?',
          summary: editSummaryMap[c.goalEmployeeEdit] || '',
          connLabel: editSummaryMap[c.goalEmployeeEdit] || '',
          render: () => (
            <ActiveNode question="What can employees change during goal setting?" color={TREE_BLUE}>
              <ChoiceGrid color={TREE_BLUE} selectedId={c.goalEmployeeEdit} onSelect={v => choose('goalEmployeeEdit', v, 'n_edit')} choices={nEditChoices} />
            </ActiveNode>
          ),
        });

        if (nEditDone) {
          nodes.push({
            id: 'n_entry_cta', done: true, color: TREE_BLUE,
            question: 'Build your KRA Library',
            summary: '🗂️ KRA Library →',
            connLabel: 'KRA Library',
            render: () => (
              <ActiveNode question="Build your KRA Library" color={TREE_BLUE}
                hint="All decisions are locked in. Head to the next step to download the template, fill it in, and upload your full KRA library.">
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '14px 16px', background: 'linear-gradient(135deg,#EFF6FF,#DBEAFE)', border: '1.5px solid #BFDBFE', borderRadius: 10 }}>
                  <div style={{ fontSize: 28 }}>🗂️</div>
                  <div>
                    <div style={{ fontWeight: 700, fontSize: 13.5, color: '#1D4ED8', marginBottom: 2 }}>KRA Library is the next step</div>
                    <div style={{ fontSize: 12, color: '#3B82F6' }}>Download the pre-configured template → fill in your KRAs{c.goalKpiMode === 'kra-kpi' ? ' and KPIs' : ''} → upload it back. Hit <strong>Next</strong> to continue.</div>
                  </div>
                </div>
              </ActiveNode>
            ),
          });
        }
      }
    }

  } else {
    // Employee self-create path

    // N1b: limit toggle
    const n1bdone = done('n1b', c.goalLimitEnabled != null);
    nodes.push({
      id:'n1b', done:n1bdone, color:TREE_AMBER,
      question: 'Do you want to limit the number of goals?',
      summary: c.goalLimitEnabled ? '✓ Yes — limits enabled' : '✓ No limits',
      connLabel: c.goalLimitEnabled ? 'Yes, set limits' : 'No limits',
      render: () => (
        <ActiveNode question="Do you want to limit the number of goals employees can set?" color={TREE_AMBER}>
          <ChoiceGrid color={TREE_AMBER} selectedId={c.goalLimitEnabled===true?'yes':c.goalLimitEnabled===false?'no':null} onSelect={v=>choose('goalLimitEnabled',v==='yes','n1b')} choices={[
            { id:'yes', icon:'🔢', title:'Yes, set limits', desc:'Define a min and max goal count per employee.' },
            { id:'no',  icon:'∞',  title:'No limits',       desc:'Employees can set as many goals as they want.' },
          ]} />
        </ActiveNode>
      ),
    });

    if (n1bdone && c.goalLimitEnabled) {
      // N2b: limit scope
      const n2bdone = done('n2b', !!c.goalLimitScope);
      nodes.push({
        id:'n2b', done:n2bdone, color:TREE_AMBER,
        question: 'Should limits be the same for all employees?',
        summary: c.goalLimitScope==='common' ? `⚖️ Same — Min ${c.goalLimitMin}, Max ${c.goalLimitMax}` : <>🗂️ By <MagicText text={limAttr} /></>,
        connLabel: c.goalLimitScope==='common' ? 'Same for all' : `By ${limAttr}`,
        render: () => (
          <ActiveNode question="Should limits be the same for all employees?" color={TREE_AMBER}>
            <ChoiceGrid color={TREE_AMBER} selectedId={c.goalLimitScope} onSelect={v=>choose('goalLimitScope',v,'n2b')} choices={[
              { id:'common',       icon:'⚖️', title:'Same limit for all',   desc:'One global min / max applies to everyone.' },
              { id:'by-attribute', icon:'🗂️', title:'Differs by attribute', desc:'Different groups can have different goal count limits.' },
            ]} />
          </ActiveNode>
        ),
      });

      if (n2bdone && c.goalLimitScope === 'common') {
        nodes.push({
          id:'n3b', done:false, color:TREE_AMBER,
          question: 'Set goal count limits',
          render: () => (
            <ActiveNode question="Set goal count limits" color={TREE_AMBER}>
              <Grid2>
                <Field label="Minimum goals" hint="Must set at least this many">
                  <input style={inputStyle} type="number" min={1} value={c.goalLimitMin} onChange={e=>update('goalLimitMin',Number(e.target.value))} />
                </Field>
                <Field label="Maximum goals" hint="Cannot exceed this many">
                  <input style={inputStyle} type="number" min={1} value={c.goalLimitMax} onChange={e=>update('goalLimitMax',Number(e.target.value))} />
                </Field>
              </Grid2>
            </ActiveNode>
          ),
        });
      }

      if (n2bdone && c.goalLimitScope === 'by-attribute') {
        nodes.push({
          id:'n3b', done:false, color:TREE_AMBER,
          question: <>Set limits per <MagicText text={limAttr} /></>,
          render: () => (
            <ActiveNode question={<>Set limits per <MagicText text={limAttr} /></>} color={TREE_AMBER}>
              <SegmentAttributeInput
                value={c.goalLimitAttr}
                onChange={(nextValue) => update('goalLimitAttr', nextValue)}
              />
              <div style={{marginTop:14}}>
                <div style={{display:'grid',gridTemplateColumns:'1fr 72px 72px 28px',gap:'5px 8px',marginBottom:6}}>
                  {[`${limAttr} value`,'Min','Max',''].map((h,i)=>(
                    <div key={i} style={{fontSize:10.5,fontWeight:700,color:'#9CA3AF',textTransform:'uppercase'}}>{h}</div>
                  ))}
                </div>
                {(c.goalLimitValues||[]).map(v=>(
                  <div key={v.id} style={{display:'grid',gridTemplateColumns:'1fr 72px 72px 28px',gap:'5px 8px',alignItems:'center',padding:'5px 0',borderBottom:'1px solid #F1F3F5'}}>
                    <input style={inputStyle} placeholder="e.g. Finance" value={v.name} onChange={e=>setLimVal(v.id,'name',e.target.value)} />
                    <input style={{...inputStyle,textAlign:'center'}} type="number" min={1} value={v.min} onChange={e=>setLimVal(v.id,'min',Number(e.target.value))} />
                    <input style={{...inputStyle,textAlign:'center'}} type="number" min={1} value={v.max} onChange={e=>setLimVal(v.id,'max',Number(e.target.value))} />
                    <button onClick={()=>delLimVal(v.id)} style={{background:'none',border:'none',cursor:'pointer',color:'#DC2626',fontSize:14,padding:0}}>✕</button>
                  </div>
                ))}
                <button onClick={addLimVal} style={{marginTop:10,fontSize:12.5,color:TREE_AMBER,background:'none',border:`1.5px dashed ${TREE_AMBER}50`,borderRadius:8,padding:'5px 12px',cursor:'pointer',fontWeight:500}}>
                  + Add <MagicText text={limAttr} /> value
                </button>
              </div>
            </ActiveNode>
          ),
        });
      }
    }
  }

  /* ── render ──────────────────────────────────────────────── */
  return (
    <div>
      <style>{`
        @keyframes treeNodeIn {
          from { opacity:0; transform:translateY(10px); }
          to   { opacity:1; transform:translateY(0); }
        }
        @keyframes magicLabelIn {
          0% { opacity: 0; transform: translateY(6px) scale(.98); filter: blur(6px); }
          55% { opacity: .95; transform: translateY(0) scale(1.01); filter: blur(0); }
          100% { opacity: 1; transform: translateY(0) scale(1); filter: blur(0); }
        }
      `}</style>
      <SectionHead title="Goal library" sub="Answer each question to configure how goals are created for this cycle." />
      <GoalPathSummary config={config} />

      <div ref={treeRef} style={{display:'flex',flexDirection:'column',alignItems:'center',maxWidth:760,margin:'0 auto'}}>
        {nodes.map((node, idx) => {
          const prev = idx > 0 ? nodes[idx-1] : null;
          return (
            <div key={node.id} style={{width:'100%'}}>
              {prev && prev.done && <TreeConnector color={node.color} />}
              {editing(node.id)
                ? node.render()
                : node.done
                  ? <CompletedNode question={node.question} summary={node.summary} color={node.color} onOpen={()=>setExpandedNodes((prev) => (prev.includes(node.id) ? prev : [...prev, node.id]))} />
                  : node.render()
              }
            </div>
          );
        })}
      </div>
      <StepStatusBar
        applied={goalSettingsApplied}
        valid={goalSettingsValid}
        appliedMessage="Goal Library settings applied — make changes above to reconfigure."
        pendingMessage="Review the goal setup above, then apply changes to continue."
        invalidMessage="Finish the goal setup above before applying changes."
        buttonLabel="Apply goal settings"
        onApply={() => update('goalsAppliedSnapshot', getGoalsSnapshot(config))}
      />
    </div>
  );
}

/* ── GoalLibraryMaster — KRA master view after successful upload ─────────── */
function GoalLibraryMaster({ parsedData, config, onChange }) {
  const perspectives = config.perspectives || [];
  const hasKpis = config.goalKpiMode === 'kra-kpi';
  const onChangeRef = useRef(onChange);

  // Tabs for by-attribute
  const tabs = parsedData.byAttr ? Object.keys(parsedData.data) : ['__all__'];
  const [activeTab, setActiveTab] = useState(tabs[0] || '__all__');

  // Editable master data
  const [masterData, setMasterData] = useState(() => {
    // Deep clone
    if (!parsedData.byAttr) {
      return { ...parsedData, data: parsedData.data.map(k => ({ ...k, kpis: (k.kpis||[]).map(p => ({ ...p })) })) };
    }
    const data = {};
    for (const [tab, kras] of Object.entries(parsedData.data)) {
      data[tab] = kras.map(k => ({ ...k, kpis: (k.kpis||[]).map(p => ({ ...p })) }));
    }
    return { ...parsedData, data };
  });

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  useEffect(() => {
    onChangeRef.current?.(masterData);
  }, [masterData]);

  // Editing state
  const [editId, setEditId] = useState(null); // 'kra__<id>' or 'kpi__<kraId>__<kpiId>'
  const [draft, setDraft] = useState({});
  const [editError, setEditError] = useState('');

  function getCurrentKras() {
    if (!masterData.byAttr) return masterData.data;
    return masterData.data[activeTab] || [];
  }

  function setCurrentKras(updater) {
    if (!masterData.byAttr) {
      setMasterData(prev => ({ ...prev, data: typeof updater === 'function' ? updater(prev.data) : updater }));
    } else {
      setMasterData(prev => ({
        ...prev,
        data: { ...prev.data, [activeTab]: typeof updater === 'function' ? updater(prev.data[activeTab] || []) : updater },
      }));
    }
  }

  const startEditKra = useCallback((kra) => {
    setEditId(`kra__${kra.id}`);
    setDraft({ name: kra.name, weight: kra.weight, perspName: kra.perspName });
    setEditError('');
  }, []);

  const startEditKpi = useCallback((kra, kpi) => {
    setEditId(`kpi__${kra.id}__${kpi.id}`);
    setDraft({ name: kpi.name, weight: kpi.weight });
    setEditError('');
  }, []);

  const cancelEdit = useCallback(() => {
    setEditId(null);
    setDraft({});
    setEditError('');
  }, []);

  function getTrimmedCurrentKras() {
    return getCurrentKras().map((kra) => ({
      ...kra,
      name: sanitizeGoalName(kra.name),
      kpis: (kra.kpis || []).map((kpi) => ({ ...kpi, name: sanitizeGoalName(kpi.name) })),
    }));
  }

  function saveKra(kraId) {
    const nextName = sanitizeGoalName(draft.name);
    const nextWeight = String(draft.weight ?? '').trim();
    if (!nextName) {
      setEditError('KRA name is required.');
      return;
    }
    if (!isNonNegativeNumeric(nextWeight)) {
      setEditError('KRA weight must be a non-negative numeric value.');
      return;
    }
    const duplicateExists = getTrimmedCurrentKras().some((kra) => kra.id !== kraId && kra.name.toLowerCase() === nextName.toLowerCase());
    if (duplicateExists) {
      setEditError(`Duplicate KRA name "${nextName}" in this group.`);
      return;
    }
    setCurrentKras(prev => prev.map(k => k.id === kraId ? { ...k, ...draft, name: nextName, weight: nextWeight } : k));
    cancelEdit();
  }

  function saveKpi(kraId, kpiId) {
    const nextName = sanitizeGoalName(draft.name);
    const nextWeight = String(draft.weight ?? '').trim();
    if (!nextName) {
      setEditError('KPI name is required.');
      return;
    }
    if (nextWeight !== '' && !isNonNegativeNumeric(nextWeight)) {
      setEditError('KPI weight must be a non-negative numeric value.');
      return;
    }
    const parentKra = getCurrentKras().find((kra) => kra.id === kraId);
    const duplicateExists = (parentKra?.kpis || []).some((kpi) => kpi.id !== kpiId && sanitizeGoalName(kpi.name).toLowerCase() === nextName.toLowerCase());
    if (duplicateExists) {
      setEditError(`Duplicate KPI name "${nextName}" in "${sanitizeGoalName(parentKra?.name)}".`);
      return;
    }
    setCurrentKras(prev => prev.map(k => k.id === kraId
      ? { ...k, kpis: (k.kpis||[]).map(p => p.id === kpiId ? { ...p, ...draft, name: nextName, weight: nextWeight } : p) }
      : k));
    cancelEdit();
  }

  function deleteKra(kraId) {
    setCurrentKras(prev => prev.filter(k => k.id !== kraId));
    if (editId?.startsWith(`kra__${kraId}`)) cancelEdit();
  }

  function deleteKpi(kraId, kpiId) {
    setCurrentKras(prev => prev.map(k => k.id === kraId
      ? { ...k, kpis: (k.kpis||[]).filter(p => p.id !== kpiId) }
      : k));
    if (editId === `kpi__${kraId}__${kpiId}`) cancelEdit();
  }

  function addKra(perspName) {
    const newId = Date.now();
    setCurrentKras(prev => [...prev, { id: newId, name: '', weight: '', perspName, kpis: [] }]);
    setEditId(`kra__${newId}`);
    setDraft({ name: '', weight: '', perspName });
  }

  function addKpi(kraId) {
    const newId = Date.now();
    setCurrentKras(prev => prev.map(k => k.id === kraId
      ? { ...k, kpis: [...(k.kpis||[]), { id: newId, name: '', weight: '' }] }
      : k));
    setEditId(`kpi__${kraId}__${newId}`);
    setDraft({ name: '', weight: '' });
  }

  const currentKras = getCurrentKras();
  const totalWeight = currentKras.reduce((s, k) => s + (parseFloat(k.weight) || 0), 0);
  const weightOk = Math.abs(totalWeight - 100) <= 0.5;
  const validationErrors = useMemo(() => validateGoalLibraryData(masterData, config), [masterData, config]);
  const libraryIsValid = validationErrors.length === 0;

  // Group by perspective (preserve configured order) - MEMOIZED
  const perspSections = useMemo(() => {
    const groupedByPersp = {};
    for (const p of perspectives) groupedByPersp[p.name] = [];
    for (const kra of currentKras) {
      if (groupedByPersp[kra.perspName] !== undefined) groupedByPersp[kra.perspName].push(kra);
      else {
        if (!groupedByPersp['__other__']) groupedByPersp['__other__'] = [];
        groupedByPersp['__other__'].push(kra);
      }
    }
    return Object.entries(groupedByPersp)
      .filter(([, kras]) => kras.length > 0 || perspectives.find(p => p.name !== '__other__'))
      .map(([name, kras]) => ({
        name,
        kras,
        color: perspectives.find(p => p.name === name)?.color || '#94A3B8',
        sectionWeight: kras.reduce((s, k) => s + (parseFloat(k.weight) || 0), 0),
      }));
  }, [perspectives, currentKras]);

  const totalKraCount = currentKras.length;

  return (
    <div style={{borderRadius:12,border:'1.5px solid #BFDBFE',background:'#fff',overflow:'hidden'}}>
      {/* Master header */}
      <div style={{padding:'14px 18px',background:'linear-gradient(135deg,#EFF6FF 0%,#F8FAFC 100%)',borderBottom:'1px solid #BFDBFE',display:'flex',alignItems:'center',justifyContent:'space-between',gap:12,flexWrap:'wrap'}}>
        <div>
          <div style={{fontSize:15,fontWeight:700,color:'#1E3A8A',marginBottom:4}}>KRA Library Master</div>
          <div style={{display:'flex',flexWrap:'wrap',gap:8,alignItems:'center'}}>
            <span style={{fontSize:12,fontWeight:600,color:'#374151',background:'#E0F2FE',padding:'2px 8px',borderRadius:20,border:'1px solid #BAE6FD'}}>{totalKraCount} KRA{totalKraCount!==1?'s':''}</span>
            <span style={{fontSize:12,fontWeight:600,padding:'2px 8px',borderRadius:20,border:'1px solid',
              background: weightOk ? '#DCFCE7' : '#FEF2F2',
              color:       weightOk ? '#16A34A' : '#DC2626',
              borderColor: weightOk ? '#86EFAC' : '#FECACA'}}>
              Total weight: {totalWeight.toFixed(1)}% {weightOk ? '✓' : '⚠'}
            </span>
            <span style={{fontSize:12,fontWeight:600,padding:'2px 8px',borderRadius:20,border:'1px solid',
              background: libraryIsValid ? '#DCFCE7' : '#FEF2F2',
              color:       libraryIsValid ? '#16A34A' : '#DC2626',
              borderColor: libraryIsValid ? '#86EFAC' : '#FECACA'}}>
              {libraryIsValid ? 'Library valid' : `${validationErrors.length} issue${validationErrors.length !== 1 ? 's' : ''}`}
            </span>
          </div>
        </div>
      </div>

      {!libraryIsValid && (
        <div style={{padding:'12px 18px',background:'#FFFBEB',borderBottom:'1px solid #FDE68A',fontSize:12.5,color:'#92400E'}}>
          Note: {validationErrors.length} item{validationErrors.length !== 1 ? 's' : ''} may need attention — the library can still be used as a reference. {validationErrors.slice(0, 2).map((err) => err.message).join(' | ')}{validationErrors.length > 2 ? ` | +${validationErrors.length - 2} more` : ''}
        </div>
      )}

      {editError && (
        <div style={{padding:'12px 18px',background:'#FEF2F2',borderBottom:'1px solid #FECACA',fontSize:12.5,color:'#B91C1C'}}>
          {editError}
        </div>
      )}

      {/* Attribute tabs */}
      {parsedData.byAttr && tabs.length > 1 && (
        <div style={{display:'flex',gap:0,padding:'0 18px',background:'#F8FAFC',borderBottom:'1px solid #E2E8F0',overflowX:'auto'}}>
          {tabs.map(tab => {
            const kras = masterData.data[tab] || [];
            const tw = kras.reduce((s,k)=>s+(parseFloat(k.weight)||0),0);
            const ok = Math.abs(tw-100)<=0.5;
            return (
              <button key={tab} type="button" onClick={() => { setActiveTab(tab); cancelEdit(); }}
                style={{padding:'10px 16px',border:'none',borderBottom: activeTab===tab ? `2.5px solid ${TREE_BLUE}` : '2.5px solid transparent',
                  background:'transparent',fontSize:13,fontWeight:activeTab===tab?700:500,
                  color:activeTab===tab?TREE_BLUE:'#64748B',cursor:'pointer',fontFamily:'inherit',whiteSpace:'nowrap',display:'flex',alignItems:'center',gap:6}}>
                {tab}
                <span style={{fontSize:10.5,fontWeight:700,padding:'1px 6px',borderRadius:10,
                  background: ok ? '#DCFCE7' : '#FEF2F2',
                  color:       ok ? '#16A34A' : '#DC2626'}}>
                  {kras.length}
                </span>
              </button>
            );
          })}
        </div>
      )}

      {/* Perspective sections */}
      <div style={{padding:'16px 18px',display:'flex',flexDirection:'column',gap:16}}>
        {perspSections.filter(s => s.name !== '__other__' || s.kras.length > 0).map(section => {
          return (
            <div key={section.name}>
              {/* Section header */}
              <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:8}}>
                <div style={{display:'flex',alignItems:'center',gap:8}}>
                  <div style={{width:10,height:10,borderRadius:'50%',background:section.color,flexShrink:0}} />
                  <span style={{fontSize:13.5,fontWeight:700,color:'#1E293B'}}>{section.name}</span>
                  <span style={{fontSize:11.5,color:'#64748B',fontWeight:500}}>
                    {section.kras.length} KRA{section.kras.length!==1?'s':''} · {section.sectionWeight.toFixed(0)}%
                  </span>
                </div>
                <button onClick={() => addKra(section.name)}
                  style={{fontSize:12,color:TREE_BLUE,background:'#EFF6FF',border:'1px solid #BFDBFE',borderRadius:7,padding:'4px 10px',cursor:'pointer',fontWeight:600,fontFamily:'inherit'}}>
                  + Add KRA
                </button>
              </div>

              {/* KRA rows */}
              <div style={{border:'1px solid #E2E8F0',borderRadius:10,overflow:'hidden',background:'#fff'}}>
                {section.kras.length === 0 && (
                  <div style={{padding:'16px 18px',fontSize:12.5,color:'#94A3B8',textAlign:'center'}}>No KRAs yet — click + Add KRA</div>
                )}
                {section.kras.map((kra, kraIdx) => {
                  const isEditingKra = editId === `kra__${kra.id}`;
                  const kpiTotal = (kra.kpis||[]).reduce((s,k)=>s+(parseFloat(k.weight)||0),0);
                  const kpiOk = !hasKpis || (kra.kpis||[]).length === 0 || Math.abs(kpiTotal-100) <= 0.5;
                  return (
                    <div key={kra.id} style={{borderBottom: kraIdx < section.kras.length-1 ? '1px solid #F1F5F9' : 'none'}}>
                      {/* KRA row */}
                      {isEditingKra ? (
                        <div style={{display:'grid',gridTemplateColumns:'1fr 160px 80px auto',gap:'6px 8px',alignItems:'center',padding:'10px 14px',background:'#F8FBFF'}}>
                          <input autoFocus style={inputStyle} placeholder="KRA name" value={draft.name||''} onChange={e=>setDraft(d=>({...d,name:e.target.value}))} onFocus={()=>setEditError('')} onKeyDown={e=>{if(e.key==='Enter')saveKra(kra.id);if(e.key==='Escape')cancelEdit();}} />
                          <select style={selectStyle} value={draft.perspName||''} onChange={e=>setDraft(d=>({...d,perspName:e.target.value}))}>
                            {perspectives.map(p=><option key={p.id} value={p.name}>{p.name}</option>)}
                          </select>
                          <input style={{...inputStyle,textAlign:'center'}} inputMode="decimal" placeholder="%" value={draft.weight||''} onChange={e=>setDraft(d=>({...d,weight:sanitizeWeightInput(e.target.value)}))} onFocus={()=>setEditError('')} />
                          <div style={{display:'flex',gap:6}}>
                            <button onClick={()=>saveKra(kra.id)} style={{padding:'5px 10px',background:TREE_BLUE,color:'#fff',border:'none',borderRadius:6,fontSize:12,fontWeight:600,cursor:'pointer',fontFamily:'inherit'}}>Save</button>
                            <button onClick={cancelEdit} style={{padding:'5px 10px',background:'#F1F5F9',color:'#64748B',border:'none',borderRadius:6,fontSize:12,cursor:'pointer',fontFamily:'inherit'}}>Cancel</button>
                          </div>
                        </div>
                      ) : (
                        <div style={{display:'flex',alignItems:'center',gap:10,padding:'10px 14px',background: kraIdx%2===0?'#fff':'#F8FAFC'}}>
                          <div style={{width:6,height:6,borderRadius:'50%',background:section.color,flexShrink:0}} />
                          <span style={{flex:1,fontSize:13.5,fontWeight:600,color:'#1E293B',minWidth:0,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{kra.name||<span style={{color:'#94A3B8',fontStyle:'italic'}}>Unnamed KRA</span>}</span>
                          {!kpiOk && <span style={{fontSize:11,fontWeight:700,color:'#DC2626',background:'#FEF2F2',padding:'2px 6px',borderRadius:6,flexShrink:0}}>KPI total: {kpiTotal.toFixed(0)}%</span>}
                          <span style={{fontSize:13,fontWeight:700,color:'#374151',minWidth:40,textAlign:'right',flexShrink:0}}>{kra.weight}%</span>
                          <button onClick={()=>startEditKra(kra)} style={{padding:'4px 10px',background:'#F1F5F9',border:'1px solid #E2E8F0',borderRadius:6,fontSize:11.5,color:'#374151',cursor:'pointer',fontFamily:'inherit',flexShrink:0}}>Edit</button>
                          <button onClick={()=>deleteKra(kra.id)} style={{width:26,height:26,borderRadius:6,background:'#FFF1F2',border:'1px solid #FECDD3',cursor:'pointer',color:'#DC2626',fontSize:13,fontFamily:'inherit',flexShrink:0}}>✕</button>
                        </div>
                      )}

                      {/* KPI sub-rows */}
                      {hasKpis && (
                        <div style={{paddingLeft:30,background: kraIdx%2===0?'#FCFCFD':'#F8FAFC',borderTop:'1px solid #F1F5F9'}}>
                          {(kra.kpis||[]).map((kpi, kpiIdx) => {
                            const isEditingKpi = editId === `kpi__${kra.id}__${kpi.id}`;
                            return (
                              <div key={kpi.id} style={{display:'flex',alignItems:'center',gap:8,padding:'7px 14px 7px 0',borderBottom:kpiIdx<(kra.kpis||[]).length-1?'1px solid #F1F5F9':'none'}}>
                                <span style={{fontSize:12,color:'#CBD5E1',flexShrink:0}}>└─</span>
                                {isEditingKpi ? (
                                  <>
                                    <input autoFocus style={{...inputStyle,fontSize:12,flex:1}} placeholder="KPI name" value={draft.name||''} onChange={e=>setDraft(d=>({...d,name:e.target.value}))} onFocus={()=>setEditError('')} onKeyDown={e=>{if(e.key==='Enter')saveKpi(kra.id,kpi.id);if(e.key==='Escape')cancelEdit();}} />
                                    <input style={{...inputStyle,textAlign:'center',fontSize:12,width:70}} inputMode="decimal" placeholder="%" value={draft.weight||''} onChange={e=>setDraft(d=>({...d,weight:sanitizeWeightInput(e.target.value)}))} onFocus={()=>setEditError('')} />
                                    <button onClick={()=>saveKpi(kra.id,kpi.id)} style={{padding:'4px 9px',background:TREE_BLUE,color:'#fff',border:'none',borderRadius:6,fontSize:11.5,fontWeight:600,cursor:'pointer',fontFamily:'inherit'}}>Save</button>
                                    <button onClick={cancelEdit} style={{padding:'4px 9px',background:'#F1F5F9',color:'#64748B',border:'none',borderRadius:6,fontSize:11.5,cursor:'pointer',fontFamily:'inherit'}}>Cancel</button>
                                  </>
                                ) : (
                                  <>
                                    <span style={{flex:1,fontSize:12.5,color:'#374151',minWidth:0,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{kpi.name||<span style={{color:'#94A3B8',fontStyle:'italic'}}>Unnamed KPI</span>}</span>
                                    <span style={{fontSize:12,fontWeight:600,color:'#64748B',minWidth:36,textAlign:'right',flexShrink:0}}>{kpi.weight}%</span>
                                    <button onClick={()=>startEditKpi(kra,kpi)} style={{padding:'3px 8px',background:'#F1F5F9',border:'1px solid #E2E8F0',borderRadius:5,fontSize:11,color:'#374151',cursor:'pointer',fontFamily:'inherit',flexShrink:0}}>Edit</button>
                                    <button onClick={()=>deleteKpi(kra.id,kpi.id)} style={{width:22,height:22,borderRadius:5,background:'#FFF1F2',border:'1px solid #FECDD3',cursor:'pointer',color:'#DC2626',fontSize:11,fontFamily:'inherit',flexShrink:0}}>✕</button>
                                  </>
                                )}
                              </div>
                            );
                          })}
                          <div style={{padding:'6px 14px 8px 0'}}>
                            <button onClick={()=>addKpi(kra.id)} style={{fontSize:11.5,color:TREE_BLUE,background:'none',border:`1px dashed ${TREE_BLUE}40`,borderRadius:5,padding:'3px 9px',cursor:'pointer',fontWeight:500,fontFamily:'inherit'}}>+ Add KPI</button>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ── GoalLibraryErrorPanel — validation error display ───────────────────── */
function GoalLibraryErrorPanel({ errors, parsedData, config, onRetry }) {
  const parseError = errors.find(e => e.field === 'parse');

  return (
    <div style={{borderRadius:12,border:'1.5px solid #FECACA',background:'#FFF5F5',overflow:'hidden'}}>
      {/* Header */}
      <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',gap:12,padding:'14px 18px',background:'#FEE2E2',borderBottom:'1px solid #FECACA',flexWrap:'wrap'}}>
        <div style={{display:'flex',alignItems:'center',gap:10}}>
          <div style={{width:32,height:32,borderRadius:8,background:'#DC2626',display:'flex',alignItems:'center',justifyContent:'center',color:'#fff',fontSize:16,flexShrink:0}}>✕</div>
          <div>
            <div style={{fontSize:14,fontWeight:700,color:'#991B1B'}}>
              {parseError ? 'Could not read file' : `${errors.length} issue${errors.length!==1?'s':''} found`}
            </div>
            <div style={{fontSize:12,color:'#B91C1C',marginTop:2}}>
              {parseError ? parseError.message : 'Fix the highlighted issues and re-upload.'}
            </div>
          </div>
        </div>
        <div style={{display:'flex',gap:8,flexWrap:'wrap'}}>
          {!parseError && parsedData && (
            <button
              onClick={() => downloadErrorReport(parsedData, errors, config)}
              style={{padding:'7px 14px',background:'#fff',border:'1.5px solid #FECACA',borderRadius:8,fontSize:12.5,fontWeight:600,color:'#DC2626',cursor:'pointer',fontFamily:'inherit',display:'flex',alignItems:'center',gap:6}}>
              ⬇️ Download Error Report
            </button>
          )}
          <button
            onClick={onRetry}
            style={{padding:'7px 14px',background:'#DC2626',border:'none',borderRadius:8,fontSize:12.5,fontWeight:600,color:'#fff',cursor:'pointer',fontFamily:'inherit'}}>
            ↩ Try Again
          </button>
        </div>
      </div>

      {/* Error list */}
      {!parseError && (
        <div style={{padding:'12px 18px',maxHeight:260,overflowY:'auto'}}>
          {errors.map((err, i) => (
            <div key={i} style={{display:'flex',alignItems:'flex-start',gap:10,padding:'8px 0',borderBottom: i < errors.length-1 ? '1px solid #FFE4E4' : 'none'}}>
              <div style={{width:6,height:6,borderRadius:'50%',background:'#EF4444',marginTop:5,flexShrink:0}} />
              <div style={{flex:1,minWidth:0}}>
                <div style={{fontSize:13,fontWeight:600,color:'#DC2626'}}>
                  {err.group && err.group !== 'All Employees' ? <><span style={{background:'#FEE2E2',borderRadius:4,padding:'1px 6px',fontSize:11,fontWeight:700,marginRight:6}}>{err.group}</span></> : null}
                  {err.kraName && <span style={{color:'#374151'}}>{err.kraName}</span>}
                  {err.kraName && ' — '}
                  {err.message}
                </div>
                <div style={{fontSize:11,color:'#9CA3AF',marginTop:2}}>Field: {err.field}</div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ── Excel Preview table ─────────────────────────────────────────────────── */
function ExcelPreview({ headers, exampleRows, noteRows, maxPreviewRows = 4 }) {
  const [expanded, setExpanded] = useState(false);
  const visibleExamples = expanded ? exampleRows : exampleRows.slice(0, maxPreviewRows);
  const hiddenCount = exampleRows.length - maxPreviewRows;

  const cellStyle = (isHeader, isExample, colIdx) => ({
    padding: isHeader ? '7px 10px' : '5px 10px',
    fontSize: 11.5,
    fontWeight: isHeader ? 700 : 400,
    color: isHeader ? '#fff' : isExample ? '#B91C1C' : '#94A3B8',
    background: isHeader ? '#1D4ED8' : isExample ? '#FFF5F5' : colIdx % 2 === 0 ? '#FAFBFC' : '#fff',
    borderRight: '1px solid #E2E8F0',
    borderBottom: '1px solid #E2E8F0',
    whiteSpace: 'nowrap',
    fontFamily: "'Segoe UI', Inter, sans-serif",
    fontStyle: isExample ? 'italic' : 'normal',
    letterSpacing: isHeader ? '0.02em' : 'normal',
    minWidth: 90,
    maxWidth: 180,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  });

  return (
    <div style={{ marginBottom: 18 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
        <div style={{ fontSize: 11.5, fontWeight: 700, color: '#475569', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
          Template Preview
        </div>
        <div style={{ fontSize: 11, color: '#94A3B8' }}>
          {headers.length} columns · {exampleRows.length} example row{exampleRows.length !== 1 ? 's' : ''}
        </div>
      </div>

      {/* Scrollable table */}
      <div style={{ border: '1.5px solid #E2E8F0', borderRadius: 10, overflow: 'hidden', boxShadow: '0 2px 8px rgba(0,0,0,.05)' }}>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ borderCollapse: 'collapse', width: '100%', tableLayout: 'auto' }}>
            <thead>
              <tr>
                <td style={{ ...cellStyle(false, false, 0), background: '#F1F5F9', color: '#94A3B8', fontSize: 10.5, fontWeight: 700, padding: '4px 8px', minWidth: 28, textAlign: 'center' }}>#</td>
                {headers.map((h, i) => (
                  <td key={i} style={cellStyle(true, false, i)}>{h}</td>
                ))}
              </tr>
            </thead>
            <tbody>
              {/* Example rows — red italic */}
              {visibleExamples.map((row, ri) => (
                <tr key={ri}>
                  <td style={{ ...cellStyle(false, false, 0), background: '#FFF5F5', color: '#FCA5A5', fontSize: 10.5, textAlign: 'center', padding: '4px 8px' }}>{ri + 1}</td>
                  {headers.map((_, ci) => (
                    <td key={ci} style={cellStyle(false, true, ci)}>{row[ci] ?? ''}</td>
                  ))}
                </tr>
              ))}
              {/* Show more */}
              {!expanded && hiddenCount > 0 && (
                <tr>
                  <td colSpan={headers.length + 1} style={{ padding: '6px 12px', textAlign: 'center', background: '#FFF5F5', borderBottom: '1px solid #E2E8F0' }}>
                    <button type="button" onClick={() => setExpanded(true)} style={{ border: 'none', background: 'none', fontSize: 11.5, color: '#2563EB', cursor: 'pointer', fontWeight: 600 }}>
                      +{hiddenCount} more example row{hiddenCount !== 1 ? 's' : ''} — click to expand
                    </button>
                  </td>
                </tr>
              )}
              {/* Empty data rows */}
              {[...Array(3)].map((_, ri) => (
                <tr key={`empty-${ri}`}>
                  <td style={{ ...cellStyle(false, false, 0), color: '#CBD5E1', fontSize: 10.5, textAlign: 'center', padding: '4px 8px' }}>{exampleRows.length + ri + 1}</td>
                  {headers.map((_, ci) => (
                    <td key={ci} style={{ ...cellStyle(false, false, ci), color: '#CBD5E1', fontSize: 10.5 }}>…</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Notes strip */}
        {noteRows && noteRows.length > 0 && (
          <div style={{ background: '#F8FAFC', borderTop: '1px solid #E2E8F0', padding: '8px 14px', display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {noteRows.slice(1).map((row, i) => (
              row[0] ? <div key={i} style={{ fontSize: 11, color: '#64748B', lineHeight: 1.5 }}>{row[0]}</div> : null
            ))}
          </div>
        )}
      </div>

      {/* Legend */}
      <div style={{ display: 'flex', gap: 16, marginTop: 7, paddingLeft: 2 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, color: '#94A3B8' }}>
          <div style={{ width: 10, height: 10, background: '#1D4ED8', borderRadius: 2 }} /> Header row
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, color: '#94A3B8' }}>
          <div style={{ width: 10, height: 10, background: '#FFF5F5', border: '1px solid #FECACA', borderRadius: 2 }} /> Example data (delete before upload)
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, color: '#94A3B8' }}>
          <div style={{ width: 10, height: 10, background: '#FAFBFC', border: '1px solid #E2E8F0', borderRadius: 2 }} /> Your data rows
        </div>
      </div>
    </div>
  );
}

/* ── Goal library entry node — upload tab ───────────────────────────────── */
function GoalLibraryUploadPane({ config, attrLabel, phase, errors, parsedData, onRetry, onReset, onGoalLibraryChange }) {
  const scope = config.goalLibraryScope;

  // --- idle / upload zone ---
  if (phase === 'idle' || phase === 'parsing') {
    const meta = goalLibraryTemplateMeta(config);
    return (
      <>
        {/* Live Excel preview */}
        <ExcelPreview headers={meta.headers} exampleRows={meta.exampleRows} noteRows={meta.noteRows} />
      </>
    );
  }

  // --- error state ---
  if (phase === 'error') return (
    <GoalLibraryErrorPanel
      errors={errors}
      parsedData={parsedData}
      config={config}
      onRetry={onRetry}
    />
  );

  // --- success state ---
  return (
    <GoalLibraryMaster
      parsedData={parsedData}
      config={config}
      onChange={onGoalLibraryChange}
    />
  );
}

/* helper: goal entry node definition */
function goalEntryNodeDef(c, config, update, entryMode, setEntryMode, attrLabel) {
  const scope = c.goalLibraryScope;
  return {
    id:'n_entry', done:false, color:TREE_BLUE,
    question: 'Add your KRA library',
    render: () => (
      <div data-goal-entry-node="true">
        <ActiveNode question="Add your KRA library" color={TREE_BLUE} hint={<>Goals must include a Perspective column (required for BSC).{scope==='by-attribute' ? <> One set per <MagicText text={attrLabel} />.</> : ''}</>}>
          <div style={{display:'flex',gap:0,background:'#F8FAFC',border:'1px solid #E9EDF2',borderRadius:8,padding:3,marginBottom:16,width:'fit-content'}}>
            {[{id:'upload',label:'Upload Excel'},{id:'manual',label:'Enter manually'}].map(em=>(
              <button key={em.id} type="button" onClick={()=>setEntryMode(em.id)}
                style={{padding:'6px 16px',borderRadius:6,border:'none',fontSize:12.5,fontWeight:entryMode===em.id?600:400,color:entryMode===em.id?TREE_BLUE:'#9CA3AF',background:entryMode===em.id?'#fff':'transparent',cursor:'pointer',boxShadow:entryMode===em.id?'0 1px 3px rgba(0,0,0,.07)':'none',transition:'all .15s'}}>
                {em.label}
              </button>
            ))}
          </div>
          {entryMode === 'upload'
            ? <GoalLibraryUploadPane config={config} attrLabel={attrLabel} />
            : <ManualGoalEntry config={config} perspectives={config.perspectives||[]} />
          }
        </ActiveNode>
      </div>
    ),
  };
}

/* ── GROUP DATA UPLOAD PANEL (new groups system) ─────────────────────────── */
function GroupDataUploadPanel({ group, config, update }) {
  const [prefillImportOpen, setPrefillImportOpen] = useState(!group.prefillData?.length);
  const [libraryImportOpen, setLibraryImportOpen] = useState(!group.libraryData?.length);
  const [importPhase, setImportPhase] = useState({ prefill: 'idle', library: 'idle' });
  const [importErrors, setImportErrors] = useState({ prefill: [], library: [] });

  const hasPrefill = group.modes?.includes('prefill');
  const hasLibrary = group.modes?.includes('library');

  function updateGroupField(field, value) {
    update('goalGroups', (config.goalGroups || []).map(g =>
      g.id === group.id ? { ...g, [field]: value } : g
    ));
  }

  async function handleImport(type, e) {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = '';
    setImportPhase(prev => ({ ...prev, [type]: 'parsing' }));
    setImportErrors(prev => ({ ...prev, [type]: [] }));
    try {
      // Use a minimal config for parsing — no byAttr for per-group uploads
      const fakeConfig = { ...config, goalLibraryScope: 'common', goalSegmentValues: [] };
      const result = await parseGoalLibraryXlsx(file, fakeConfig);
      const errs = validateGoalLibraryData(result, fakeConfig);
      // Block on perspective errors and invalid/negative weights — KPIs and empty weights are optional.
      const blockingErrors = errs.filter(e => e.field === 'perspective' || e.field === 'kra_weight' || e.field === 'kpi_weight');
      if (blockingErrors.length > 0) {
        setImportErrors(prev => ({ ...prev, [type]: blockingErrors }));
        setImportPhase(prev => ({ ...prev, [type]: 'error' }));
      } else {
        const field = type === 'prefill' ? 'prefillData' : 'libraryData';
        updateGroupField(field, result.data || []);
        setImportPhase(prev => ({ ...prev, [type]: 'idle' }));
        if (type === 'prefill') setPrefillImportOpen(false);
        else setLibraryImportOpen(false);
      }
    } catch (err) {
      setImportErrors(prev => ({ ...prev, [type]: [{ field: 'parse', message: err.message }] }));
      setImportPhase(prev => ({ ...prev, [type]: 'error' }));
    }
  }

  const modeColor = { prefill: '#2563EB', library: '#7C3AED' };

  function UploadSection({ type, label, data, importOpen, setImportOpen: setOpen }) {
    const fileRef = useRef(null);
    const color = modeColor[type];
    const count = (data || []).length;
    return (
      <div style={{ padding: '16px 20px', borderTop: '1px solid #F1F5F9' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
          <div>
            <div style={{ fontWeight: 700, fontSize: 13.5, color }}>{label}</div>
            {count > 0 && <div style={{ fontSize: 12, color: '#16A34A', marginTop: 2 }}>✓ {count} KRA{count !== 1 ? 's' : ''} uploaded</div>}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="button" onClick={() => setOpen(o => !o)}
              style={{ padding: '6px 14px', borderRadius: 6, border: `1.5px solid ${color}`, background: '#fff', color, fontWeight: 600, fontSize: 12.5, cursor: 'pointer' }}>
              {importOpen ? 'Hide' : count > 0 ? 'Re-upload' : 'Upload Excel'}
            </button>
            {count > 0 && <span style={{ padding: '6px 12px', borderRadius: 6, background: '#F0FDF4', color: '#16A34A', fontSize: 12, fontWeight: 600 }}>✓ Ready</span>}
          </div>
        </div>
        {importOpen && (
          <div>
            <input ref={fileRef} type="file" accept=".xlsx,.xls" style={{ display: 'none' }} onChange={e => handleImport(type, e)} />
            <div
              onClick={() => fileRef.current?.click()}
              style={{ border: '2px dashed #CBD5E1', borderRadius: 8, padding: '24px', textAlign: 'center', cursor: 'pointer', background: '#F8FAFC' }}
            >
              <div style={{ fontSize: 28, marginBottom: 8 }}>📤</div>
              <div style={{ fontWeight: 600, color: '#374151', marginBottom: 4 }}>Drop Excel file here or click to browse</div>
              <div style={{ fontSize: 12, color: '#6B7280' }}>Upload a .xlsx file with KRA Name, KRA Weight, KPI Name, KPI Weight columns</div>
            </div>
            {importPhase[type] === 'parsing' && <div style={{ marginTop: 8, color: '#2563EB', fontSize: 13 }}>Parsing…</div>}
            {importPhase[type] === 'error' && importErrors[type].length > 0 && (
              <div style={{ marginTop: 8, padding: '10px 14px', background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: 6 }}>
                {importErrors[type].map((e, i) => <div key={i} style={{ fontSize: 12, color: '#DC2626' }}>• {e.message}</div>)}
              </div>
            )}
          </div>
        )}
        {/* Show uploaded KRAs list */}
        {!importOpen && count > 0 && (
          <div style={{ background: '#F8FAFC', borderRadius: 8, border: '1px solid #E9EEF5', overflow: 'hidden' }}>
            {(data || []).slice(0, 5).map((kra, i) => (
              <div key={i} style={{ padding: '8px 14px', borderBottom: i < Math.min(count, 5) - 1 ? '1px solid #F1F5F9' : 'none', fontSize: 12.5, color: '#374151' }}>
                <span style={{ fontWeight: 600 }}>{kra.name}</span>
                {kra.weight && <span style={{ color: '#9CA3AF', marginLeft: 8 }}>{kra.weight}%</span>}
                {kra.kpis?.length > 0 && <span style={{ color: '#9CA3AF', marginLeft: 8 }}>• {kra.kpis.length} KPI{kra.kpis.length !== 1 ? 's' : ''}</span>}
              </div>
            ))}
            {count > 5 && <div style={{ padding: '8px 14px', fontSize: 12, color: '#9CA3AF' }}>+{count - 5} more KRAs…</div>}
          </div>
        )}
      </div>
    );
  }

  return (
    <div style={{ background: '#fff', border: '1.5px solid #E2E8F0', borderRadius: 12, marginBottom: 14, overflow: 'hidden' }}>
      <div style={{ padding: '14px 20px', background: '#F8FAFC', borderBottom: '1px solid #E9EDF2', display: 'flex', alignItems: 'center', gap: 10 }}>
        <div style={{ fontWeight: 700, fontSize: 14, color: '#0F172A' }}>{group.name}</div>
        <div style={{ display: 'flex', gap: 6 }}>
          {group.modes?.map(m => {
            const mode = GOAL_MODES.find(gm => gm.id === m);
            return mode ? <span key={m} style={{ fontSize: 11, padding: '2px 8px', borderRadius: 10, background: mode.bg, color: mode.color, fontWeight: 600 }}>{mode.icon} {mode.title}</span> : null;
          })}
        </div>
      </div>
      {hasPrefill && (
        <UploadSection
          type="prefill"
          label="📋 Pre-fill Data — KRAs/KPIs that will appear ready-made in employee workspace"
          data={group.prefillData}
          importOpen={prefillImportOpen}
          setImportOpen={setPrefillImportOpen}
        />
      )}
      {hasLibrary && (
        <UploadSection
          type="library"
          label="📚 Reference Library — KRAs available in the employee's browse panel"
          data={group.libraryData}
          importOpen={libraryImportOpen}
          setImportOpen={setLibraryImportOpen}
        />
      )}
    </div>
  );
}

/* ── KRA LIBRARY PAGE ────────────────────────────────────────────────────── */
/* helper: build a blank parsedData structure matching parseGoalLibraryXlsx output */
function emptyLibraryData(config) {
  const isByAttr = config.goalLibraryScope === 'by-attribute';
  const attrLabel = config.goalSegmentAttr || 'Department';
  if (isByAttr) {
    const attrValues = (config.goalSegmentValues || []).map(v => v.name).filter(Boolean);
    const data = {};
    for (const v of attrValues) data[v] = [];
    return { byAttr: true, attrLabel, data };
  }
  return { byAttr: false, attrLabel: null, data: [] };
}

function StepKRALibrary({ config, update }) {
  // New groups system: show per-group upload panels
  const usingGroups = (config.goalGroups || []).length > 0;
  const groupsNeedData = usingGroups ? groupsNeedingDataUpload(config) : [];

  if (usingGroups) {
    return (
      <div style={{ maxWidth: 900, margin: '0 auto' }}>
        <div style={{ marginBottom: 24 }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: '#94A3B8', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 6 }}>KRA Data Upload</div>
          <h2 style={{ margin: 0, fontSize: 22, fontWeight: 800, color: '#0F172A' }}>Upload KRA / Library Data</h2>
          <p style={{ margin: '8px 0 0', fontSize: 14, color: '#64748B' }}>
            Upload KRA data for each group that uses pre-fill or reference library. You can upload separate datasets per group.
          </p>
        </div>
        {groupsNeedData.map(group => (
          <GroupDataUploadPanel key={group.id} group={group} config={config} update={update} />
        ))}
        {groupsNeedData.length === 0 && (
          <div style={{ padding: 30, textAlign: 'center', color: '#94A3B8' }}>
            No groups require data upload (all groups use Free Creation only).
          </div>
        )}
      </div>
    );
  }

  // Legacy path (old config without goalGroups)
  const hasKpis  = config.goalKpiMode === 'kra-kpi';
  const isByAttr = config.goalLibraryScope === 'by-attribute';
  const attrLabel = config.goalSegmentAttr || 'Department';
  const libraryIsReady = isGoalLibraryValid(config);
  const libraryIsApplied = libraryIsReady && config.goalLibraryAppliedSnapshot === getGoalLibraryDataSnapshot(config.goalLibraryData);

  // masterKey: bump to re-initialize GoalLibraryMaster when Excel import overwrites data
  const [masterKey, setMasterKey] = useState(0);
  // baseData: what GoalLibraryMaster is seeded from (empty or last import)
  const [baseData, setBaseData] = useState(() => config.goalLibraryData || emptyLibraryData(config));

  // Excel import panel
  const [importOpen, setImportOpen] = useState(!config.goalLibraryData);
  const [importPhase, setImportPhase] = useState('idle'); // 'idle'|'parsing'|'error'
  const [importErrors, setImportErrors] = useState([]);
  const [importErrorData, setImportErrorData] = useState(null);

  const modeSummary = [
    isByAttr ? `One library per ${attrLabel}` : 'Shared library for all employees',
    hasKpis  ? 'KRAs + KPIs pre-defined' : 'KRAs only — employees fill in KPIs',
  ];
  const editSummaryMap = {
    locked:        '🔒 View and submit only',
    'add-kpis':    hasKpis ? '✏️ Employees can add extra KPIs' : '✏️ Employees fill in their KPIs',
    'edit-freely': '🔓 Employees edit and add freely',
  };

  async function handleImport(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = '';
    setImportPhase('parsing');
    setImportErrors([]);
    setImportErrorData(null);
    try {
      const result = await parseGoalLibraryXlsx(file, config);
      const errs = validateGoalLibraryData(result, config);
      // Block on perspective errors and invalid/negative weights — KPIs and empty weights are optional.
      const blockingErrors = errs.filter(e => e.field === 'perspective' || e.field === 'kra_weight' || e.field === 'kpi_weight');
      if (blockingErrors.length > 0) {
        setImportErrors(blockingErrors);
        setImportErrorData(result);
        setImportPhase('error');
      } else {
        setBaseData(result);
        setMasterKey(k => k + 1);
        update('goalLibraryData', result);
        update('employeeUploadData', null);
        setImportPhase('idle');
        setImportOpen(false);
      }
    } catch (err) {
      setImportErrors([{ group: null, kraName: null, field: 'parse', message: err.message }]);
      setImportPhase('error');
    }
  }

  return (
    <div style={{ maxWidth: 900, margin: '0 auto' }}>
      {/* Page header */}
      <div style={{ marginBottom: 18 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{ width: 40, height: 40, borderRadius: 10, background: 'linear-gradient(135deg,#2563EB,#6366f1)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 20, flexShrink: 0 }}>🗂️</div>
          <div>
            <h2 style={{ margin: 0, fontSize: 21, fontWeight: 800, color: '#0F172A' }}>KRA Library</h2>
            <div style={{ fontSize: 13, color: '#64748B', marginTop: 2 }}>
              Add KRAs{hasKpis ? ' and KPIs' : ''} directly below, or import from Excel to populate quickly.
            </div>
          </div>
        </div>
      </div>

      {/* Config pills */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 18 }}>
        {modeSummary.map((s, i) => (
          <div key={i} style={{ padding: '5px 12px', background: '#EFF6FF', border: '1px solid #BFDBFE', borderRadius: 999, fontSize: 12, fontWeight: 600, color: '#1D4ED8' }}>{s}</div>
        ))}
        {config.goalEmployeeEdit && (
          <div style={{ padding: '5px 12px', background: '#F0FDF4', border: '1px solid #BBF7D0', borderRadius: 999, fontSize: 12, fontWeight: 600, color: '#15803D' }}>{editSummaryMap[config.goalEmployeeEdit]}</div>
        )}
      </div>

      {/* Import from Excel — collapsible */}
      <div style={{ background: '#fff', border: '1.5px solid #E9EDF2', borderRadius: 12, marginBottom: 16, overflow: 'hidden' }}>
        {/* Toggle header */}
        <button
          type="button"
          onClick={() => setImportOpen(o => !o)}
          style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 18px', background: 'transparent', border: 'none', cursor: 'pointer', fontFamily: 'inherit' }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ fontSize: 16 }}>📥</span>
            <span style={{ fontSize: 13.5, fontWeight: 700, color: '#1E293B' }}>Import from Excel</span>
            <span style={{ fontSize: 12, color: '#94A3B8' }}>Download template → fill in → upload to populate the library instantly</span>
          </div>
          <span style={{ fontSize: 11, color: '#94A3B8', fontWeight: 600 }}>{importOpen ? '▲ collapse' : '▼ expand'}</span>
        </button>

        {importOpen && (
          <div style={{ borderTop: '1px solid #E9EDF2', padding: 20 }}>
            {/* Preview */}
            {(() => { const m = goalLibraryTemplateMeta(config); return <ExcelPreview headers={m.headers} exampleRows={m.exampleRows} noteRows={m.noteRows} maxPreviewRows={3} />; })()}

            {/* Error panel */}
            {importPhase === 'error' && (
              <GoalLibraryErrorPanel
                errors={importErrors}
                parsedData={importErrorData}
                config={config}
                onRetry={() => { setImportPhase('idle'); setImportErrors([]); setImportErrorData(null); }}
              />
            )}

            {/* Action bar */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
              <button type="button" onClick={() => downloadGoalLibraryTemplate(config)}
                style={{ padding: '8px 16px', background: TREE_BLUE, color: '#fff', border: 'none', borderRadius: 8, fontSize: 12.5, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap', boxShadow: '0 4px 10px rgba(37,99,235,.18)' }}>
                Download Template
              </button>
              <label style={{ padding: '8px 16px', border: '1.5px solid #CBD5E1', borderRadius: 8, fontSize: 12.5, cursor: importPhase === 'parsing' ? 'wait' : 'pointer', background: '#fff', fontFamily: 'inherit', color: '#334155', display: 'inline-flex', alignItems: 'center', fontWeight: 600, whiteSpace: 'nowrap', opacity: importPhase === 'parsing' ? 0.6 : 1 }}>
                {importPhase === 'parsing' ? 'Parsing…' : importPhase === 'error' ? 'Re-upload' : 'Upload & Import'}
                <input type="file" accept=".xlsx,.xls,.csv" onChange={handleImport} style={{ display: 'none' }} disabled={importPhase === 'parsing'} />
              </label>
            </div>
            {libraryIsReady && (
              <div style={{ marginTop: 10, fontSize: 12, color: '#15803D', fontWeight: 600, textAlign: 'center' }}>
                Library already has data. Uploading a file here will replace the master view seed with the imported library.
              </div>
            )}
          </div>
        )}
      </div>

      {/* Always-visible master view */}
      <GoalLibraryMaster
        key={masterKey}
        parsedData={baseData}
        config={config}
        onChange={(data) => { update('goalLibraryData', data); update('employeeUploadData', null); }}
      />

      {/* Gate status */}
      <StepStatusBar
        applied={libraryIsApplied}
        valid={libraryIsReady}
        appliedMessage="Library changes applied — proceed to Employee Upload or make changes above to reconfigure."
        pendingMessage="Library is valid. Apply changes to continue to Employee Upload."
        invalidMessage="Fix the KRA library issues above before applying changes."
        buttonLabel="Apply library changes"
        onApply={() => update('goalLibraryAppliedSnapshot', getGoalLibraryDataSnapshot(config.goalLibraryData))}
      />
    </div>
  );
}

/* ── STEP 4: EMPLOYEE SETTINGS ───────────────────────────────────────────── */
function StepEmployeeSettings({ config, update }) {
  const isValidManagerSetup = isEmployeeSettingsValid(config);
  const settingsApplied = isValidManagerSetup && config.empSettingsAppliedSnapshot === getEmployeeSettingsSnapshot(config);
  const routingColumns = getEmployeeRoutingColumns(config);
  const routingColumnLabels = routingColumns.map(column => column.label);
  const hasGoalGroups = (config.goalGroups || []).length > 0;
  return (
    <div>
      <SectionHead title="Employee settings" sub="Configure manager fields and any routing columns needed before upload." />

      {/* Card 1: Manager hierarchy */}
      <Card>
        <CardHead title="Manager hierarchy" />
        <CardBody>
          <div style={{ fontSize: 13, color: '#374151', marginBottom: 14, lineHeight: 1.6 }}>
            How many manager levels should the employee upload capture?
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 4 }}>
            {[
              { value: 1, label: 'L1 only (direct manager)', desc: 'Each employee maps to one direct reporting manager. Most common setup.' },
              { value: 2, label: 'L1 + L2 (skip level)',     desc: 'Adds L2 Manager columns to the upload sheet. L2 is optional per employee — leave it blank for anyone who doesn\'t have a skip-level reviewer. Employees without an L2 will go through L1 review only.' },
            ].map(opt => (
              <label key={opt.value} style={{ display: 'flex', alignItems: 'flex-start', gap: 10, cursor: 'pointer', padding: '10px 14px', borderRadius: 9, border: `1.5px solid ${config.managerLevels === opt.value ? '#2563EB' : '#E2E8F0'}`, background: config.managerLevels === opt.value ? '#EFF4FF' : '#fff' }}>
                <input
                  type="radio" name="managerLevels" value={opt.value}
                  checked={config.managerLevels === opt.value}
                  onChange={() => update('managerLevels', opt.value)}
                  style={{ marginTop: 2, accentColor: '#2563EB' }}
                />
                <div>
                  <div style={{ fontSize: 13.5, fontWeight: 600, color: '#0D1117' }}>{opt.label}</div>
                  <div style={{ fontSize: 12, color: '#64748B', marginTop: 1 }}>{opt.desc}</div>
                </div>
              </label>
            ))}
          </div>
        </CardBody>
      </Card>

      {/* Card 2: Email */}
      <Card>
        <CardHead title="Email address" />
        <CardBody>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16 }}>
            <div>
              <div style={{ fontSize: 13.5, fontWeight: 600, color: '#0D1117', marginBottom: 2 }}>Require email ID</div>
              <div style={{ fontSize: 12.5, color: '#64748B', lineHeight: 1.6 }}>
                When enabled, upload will error on any row missing an email address. Disable only if your organisation doesn't use email-based notifications.
              </div>
            </div>
            <Toggle on={config.requireEmail !== false} onChange={v => update('requireEmail', v)} />
          </div>
        </CardBody>
      </Card>

      {/* Summary */}
      <div style={{ padding: '12px 16px', background: '#F8FAFC', border: '1.5px solid #E2E8F0', borderRadius: 10, fontSize: 12.5, color: '#64748B', lineHeight: 1.7 }}>
        <strong style={{ color: '#374151' }}>Your upload sheet will include:</strong>{' '}
        Employee Code, Employee Name{config.requireEmail !== false ? ', Email ID' : ''}
        {hasGoalGroups ? ', Group Name' : ''}
        {routingColumnLabels.length > 0 ? `, ${routingColumnLabels.join(', ')}` : ''}
        {', '}Reporting Manager Code, Reporting Manager Name{config.requireEmail !== false ? ', Reporting Manager Email' : ''}
        {config.managerLevels >= 2 ? ', L2 Manager Code (optional), L2 Manager Name (optional)' : ''}.
        {hasGoalGroups ? ' Group Name is mandatory and must match a configured group exactly.' : ''}
        {routingColumnLabels.length > 0 ? ` These routing field${routingColumnLabels.length > 1 ? 's' : ''} must match the library tagging values for that group.` : ''}
      </div>

      <div style={{ marginTop: 18, padding: '14px 16px', borderRadius: 10, background: settingsApplied ? '#F0FDF4' : '#EFF6FF', border: `1.5px solid ${settingsApplied ? '#86EFAC' : '#BFDBFE'}`, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16 }}>
        <div style={{ fontSize: 13, color: settingsApplied ? '#15803D' : '#1E40AF' }}>
          {settingsApplied
            ? '✓ Settings confirmed — make changes above to reconfigure.'
            : 'Review your selections above, then confirm to continue.'}
        </div>
        {!settingsApplied && (
          <button
            type="button"
            disabled={!isValidManagerSetup}
            onClick={() => {
              update('empSettingsAppliedSnapshot', getEmployeeSettingsSnapshot(config));
            }}
            style={{
              padding: '9px 20px', border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 600, flexShrink: 0,
              cursor: !isValidManagerSetup ? 'not-allowed' : 'pointer',
              background: !isValidManagerSetup ? '#CBD5E1' : '#2563EB',
              color: '#fff',
              fontFamily: 'inherit',
            }}
          >
            Apply settings
          </button>
        )}
      </div>
    </div>
  );
}


/* ── STEP 5: EMPLOYEE UPLOAD ─────────────────────────────────────────────── */
const GROUP_PALETTE = [
  { accent: '#2563EB' },
  { accent: '#7C3AED' },
  { accent: '#16A34A' },
  { accent: '#EA580C' },
  { accent: '#DC2626' },
  { accent: '#0891B2' },
];

function StepEmployeeUpload({ config, update }) {
  const buildUploadState = (result) => (
    result
      ? {
          status: 'done',
          message: getEmployeeUploadMessage(result),
          result,
          warnings: getVisibleEmployeeUploadWarnings(result),
        }
      : null
  );
  const [uploadState, setUploadState] = useState(() => (
    buildUploadState(config.employeeUploadData)
  ));
  const [previewExpanded, setPreviewExpanded] = useState(false);
  const uploadFileRef = useRef(null);
  const uploadBtnWrapRef = useRef(null);
  const [uploadBtnOpen, setUploadBtnOpen] = useState(false);

  useEffect(() => {
    if (!uploadBtnOpen) return;
    function handleOutside(e) {
      if (uploadBtnWrapRef.current && !uploadBtnWrapRef.current.contains(e.target)) setUploadBtnOpen(false);
    }
    document.addEventListener('mousedown', handleOutside);
    return () => document.removeEventListener('mousedown', handleOutside);
  }, [uploadBtnOpen]);

  const routingColumns = getEmployeeRoutingColumns(config);
  const routingLabels = routingColumns.map(column => column.label);
  const hasGoalGroups = (config.goalGroups || []).length > 0;
  const deferredGoalGroupNames = normalizeDeferredGoalGroups(config.deferredGoalGroupNames || []);
  const routingLabelText = routingLabels.length <= 1
    ? (routingLabels[0] || '')
    : `${routingLabels.slice(0, -1).join(', ')} and ${routingLabels[routingLabels.length - 1]}`;

  const previewColumns = uploadState?.result?.employees?.length > 0 ? [
    { key: 'code', label: 'Code', width: '1fr', render: (employee) => employee['Employee Code'] || '—' },
    { key: 'name', label: 'Name', width: '1.15fr', render: (employee) => employee['Employee Name'] || '—' },
    ...(routingColumns.length > 0 ? [{
      key: 'routing',
      label: routingColumns.length === 1 ? routingColumns[0].label : 'Routing',
      width: '1.45fr',
      render: (employee) => {
        const parts = routingColumns.map(column => {
          const value = getEmployeeFieldValue(employee, column.label);
          if (!value) return null;
          return routingColumns.length === 1 ? value : `${column.label}: ${value}`;
        }).filter(Boolean);
        return parts.join(' · ') || '—';
      },
    }] : []),
    ...((config.goalGroups || []).length > 0 ? [{
      key: 'group',
      label: 'Goal Group',
      width: '1.2fr',
      render: (employee) => employee.assignedGoalGroupName
        ? <span style={{ color: '#16A34A', fontWeight: 600 }}>{employee.assignedGoalGroupName}</span>
        : <span style={{ color: '#9CA3AF' }}>No match</span>,
    }] : []),
    ...(uploadState.result.libraryLinked ? [{
      key: 'library',
      label: 'Mapped Library',
      width: '1.25fr',
      render: (employee) => employee.assignedGoalLibraryName
        ? `${employee.assignedGoalLibraryName} (${employee.assignedGoalLibraryCount || 0})`
        : 'No library',
    }] : []),
    { key: 'manager', label: 'Manager', width: '1fr', render: (employee) => {
      const code = employee['Reporting Manager Code'] || '';
      if (!code) return '—';
      const allEmps = uploadState?.result?.employees || [];
      const found = allEmps.find(e => String(e['Employee Code'] || '').trim() === code.trim());
      const name = found?.['Employee Name'] || String(employee['Reporting Manager Name'] || '').trim();
      return name ? <span>{name}<span style={{ display: 'block', fontSize: 10.5, color: '#94A3B8', fontFamily: 'monospace' }}>{code}</span></span> : code;
    }},
  ] : [];
  const previewGridTemplate = previewColumns.map(column => column.width).join(' ');
  const getIssueRowLabel = (issue) => (typeof issue?.row === 'number' ? `Row ${issue.row}` : (issue?.row || 'Summary'));

  useEffect(() => {
    setUploadState((current) => {
      if (!config.employeeUploadData) return current?.status === 'done' ? null : current;
      return buildUploadState(config.employeeUploadData);
    });
  }, [config.employeeUploadData, config.deferredGoalGroupNames]);

  function deferMissingGoalGroups(names) {
    update('deferredGoalGroupNames', normalizeDeferredGoalGroups([...(config.deferredGoalGroupNames || []), ...names]));
  }

  async function handleUpload(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = '';
    setUploadState({ status: 'parsing', message: 'Parsing file…' });
    try {
      const parsed = await parseEmployeeXlsx(file);
      const missingRoutingColumns = routingColumns.filter(column => !parsed.headers.some(header =>
        normalizeEmployeeFieldKey(header) === normalizeEmployeeFieldKey(column.label)
      ));
      const missingGroupNameColumn = hasGoalGroups && !parsed.headers.some(h =>
        normalizeEmployeeFieldKey(h) === 'groupname'
      );
      const { errors, warnings } = validateEmployeeData(parsed.employees, config);
      const headerErrors = [
        ...(missingGroupNameColumn ? [{
          row: 1, code: 'HEADER', field: 'group_name_header',
          message: 'Missing "Group Name" column. Download a fresh template — this column is required to assign employees to the correct goal group.',
        }] : []),
        ...missingRoutingColumns.map(column => ({
          row: 1, code: 'HEADER', field: 'routing_header',
          message: `Missing "${column.label}" column. It is required to allot employees to the correct group and library.`,
        })),
      ];

      if (headerErrors.length > 0 || errors.length > 0) {
        update('employeeUploadData', null);
        setUploadState({ status: 'invalid', errors: [...headerErrors, ...errors], warnings });
        return;
      }

      const result = attachGoalLibraryToEmployees(parsed, config);
      const persistedResult = { ...result, validationWarnings: warnings };
      update('employeeUploadData', persistedResult);
      setPreviewExpanded(false);
      setUploadBtnOpen(false);
      setUploadState({
        status: 'done',
        message: getEmployeeUploadMessage(persistedResult),
        result: persistedResult,
        warnings: getVisibleEmployeeUploadWarnings(persistedResult),
      });
    } catch (err) {
      update('employeeUploadData', null);
      setUploadState({ status: 'error', message: err.message });
    }
  }

  const statusColors = {
    done:    { bg: '#F0FDF4', border: '#86EFAC', text: '#16A34A' },
    invalid: { bg: '#FEF2F2', border: '#FECACA', text: '#DC2626' },
    error:   { bg: '#FEF2F2', border: '#FECACA', text: '#DC2626' },
    parsing: { bg: '#EFF6FF', border: '#BFDBFE', text: '#2563EB' },
  };

  return (
    <div>
      <SectionHead title="Employee upload" sub="Upload your employee list with manager mapping and routing values. The latest successful upload becomes the employee master for this cycle." />

      {(hasGoalGroups || routingColumns.length > 0) && (
        <Banner type="blue">
          <span>ℹ️</span>
          <span>
            Include {hasGoalGroups ? <strong>Group Name</strong> : null}
            {hasGoalGroups && routingColumns.length > 0 ? ' and ' : ''}
            {routingColumns.length > 0 ? <strong>{routingLabelText}</strong> : null}
            {hasGoalGroups || routingColumns.length > 0 ? ' in the upload. ' : ''}
            {hasGoalGroups ? 'Group Name chooses the employee group.' : ''}
            {hasGoalGroups && routingColumns.length > 0 ? ' ' : ''}
            {routingColumns.length > 0 ? `The ${routingColumns.length > 1 ? 'routing values' : 'routing value'} must then map to a real goal library inside that group.` : ''}
          </span>
        </Banner>
      )}
      {deferredGoalGroupNames.length > 0 && (
        <Banner type="blue">
          <span>🕒</span>
          <span>Deferred for later upload: <strong>{deferredGoalGroupNames.join(', ')}</strong>. This draft can be reopened anytime.</span>
        </Banner>
      )}

      <Card>
        <div style={{ padding: '13px 20px', borderBottom: '1px solid #E9EDF2', display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
          <div style={{ fontSize: 13.5, fontWeight: 600, color: '#0D1117', flexShrink: 0 }}>Import from Excel</div>
          <div style={{ fontSize: 12.5, color: '#64748B', lineHeight: 1.6 }}>
            Download the template → fill in employee details, manager mapping{hasGoalGroups ? ', Group Name' : ''}{routingColumns.length > 0 ? ', and routing fields' : ''} → upload back. Each upload replaces the current employee list; it does not append another group on top.
          </div>
        </div>
        <CardBody>
          {/* Live Excel preview (reflects settings from Employee Settings step) */}
          {(() => { const m = employeeTemplateMeta(config); return <ExcelPreview headers={m.headers} exampleRows={m.exampleRows} noteRows={m.noteRows} />; })()}

          {/* Goal Group routing reference — shows which values map to which group */}
          {routingColumns.length > 0 && (config.goalGroups || []).length > 0 && (() => {
            const groups = config.goalGroups || [];
            const rows = [];
            routingColumns.forEach(col => {
              groups.forEach(group => {
                const attr = String(group.segmentAttr || '').trim();
                if (!attr || attr.toLowerCase() !== col.label.toLowerCase()) return;
                const values = (group.segmentValues || []).map(v => String(v?.name || v || '').trim()).filter(Boolean);
                if (values.length > 0) {
                  values.forEach(val => rows.push({ value: val, group: group.name, colLabel: col.label }));
                } else {
                  rows.push({ value: '(All)', group: group.name, colLabel: col.label });
                }
              });
            });
            const defaultGroup = groups.find(g => !g.segmentAttr || String(g.segmentAttr).trim() === '');
            if (!rows.length) return null;
            return (
              <div style={{ marginTop: 12, border: '1px solid #E2E8F0', borderRadius: 8, overflow: 'hidden' }}>
                <div style={{ padding: '8px 14px', background: '#F8FAFC', borderBottom: '1px solid #E2E8F0', display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontSize: 11.5, fontWeight: 700, color: '#334155', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Goal Group Routing</span>
                  <span style={{ fontSize: 11, color: '#94A3B8' }}>— how {routingLabelText} values map to groups</span>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 28px 1fr', background: '#fff' }}>
                  <div style={{ padding: '6px 14px', fontSize: 10.5, fontWeight: 700, color: '#94A3B8', textTransform: 'uppercase', letterSpacing: '0.05em', borderBottom: '1px solid #F1F5F9' }}>{rows[0]?.colLabel} value</div>
                  <div style={{ borderBottom: '1px solid #F1F5F9' }} />
                  <div style={{ padding: '6px 14px', fontSize: 10.5, fontWeight: 700, color: '#94A3B8', textTransform: 'uppercase', letterSpacing: '0.05em', borderBottom: '1px solid #F1F5F9' }}>Goal Group</div>
                  {rows.map((row, i) => {
                    const pal = GROUP_PALETTE[groups.findIndex(g => g.name === row.group) % GROUP_PALETTE.length];
                    return [
                      <div key={`v${i}`} style={{ padding: '5px 14px', fontSize: 12, color: '#374151', borderBottom: i < rows.length - 1 ? '1px solid #F8FAFC' : 'none', display: 'flex', alignItems: 'center' }}>{row.value}</div>,
                      <div key={`a${i}`} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, color: '#94A3B8', borderBottom: i < rows.length - 1 ? '1px solid #F8FAFC' : 'none' }}>→</div>,
                      <div key={`g${i}`} style={{ padding: '5px 14px', fontSize: 12, borderBottom: i < rows.length - 1 ? '1px solid #F8FAFC' : 'none', display: 'flex', alignItems: 'center', gap: 6 }}>
                        <span style={{ width: 7, height: 7, borderRadius: '50%', background: pal?.accent || '#64748B', display: 'inline-block', flexShrink: 0 }} />
                        <span style={{ fontWeight: 600, color: pal?.accent || '#374151' }}>{row.group}</span>
                      </div>,
                    ];
                  })}
                  {defaultGroup && (
                    <>
                      <div style={{ padding: '5px 14px', fontSize: 12, color: '#9CA3AF', fontStyle: 'italic' }}>Any other value</div>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, color: '#94A3B8' }}>→</div>
                      <div style={{ padding: '5px 14px', fontSize: 12, color: '#9CA3AF', fontStyle: 'italic' }}>{defaultGroup.name}</div>
                    </>
                  )}
                </div>
              </div>
            );
          })()}

          {/* Action bar — Upload Sheet slider */}
          <input ref={uploadFileRef} type="file" accept=".xlsx,.xls,.csv" onChange={handleUpload} style={{ display: 'none' }} />
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 2 }}>
            <div ref={uploadBtnWrapRef} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <button
                type="button"
                onClick={() => setUploadBtnOpen(prev => !prev)}
                style={{ fontSize: 12.5, color: uploadState?.status === 'parsing' ? '#94A3B8' : '#2563EB', background: uploadBtnOpen ? '#FFFFFF' : '#F8FAFC', border: '1px solid #D7E3F4', borderRadius: 12, padding: '7px 13px', minWidth: 108, cursor: 'pointer', fontWeight: 700, fontFamily: 'inherit' }}
              >
                {uploadState?.status === 'parsing' ? 'Uploading…' : 'Upload Sheet'}
              </button>
              <button
                type="button"
                onClick={() => downloadEmployeeTemplate(config)}
                title="Download template"
                style={{ width: uploadBtnOpen ? 34 : 0, opacity: uploadBtnOpen ? 1 : 0, overflow: 'hidden', padding: '7px 0', border: uploadBtnOpen ? '1px solid #D6E4FF' : '1px solid transparent', background: '#FFFFFF', color: '#2563EB', borderRadius: 10, cursor: uploadBtnOpen ? 'pointer' : 'default', fontSize: 17, lineHeight: 1, transition: 'width .18s ease, opacity .18s ease', pointerEvents: uploadBtnOpen ? 'auto' : 'none', fontFamily: 'inherit' }}
              >⬇</button>
              <button
                type="button"
                onClick={() => uploadFileRef.current?.click()}
                title="Upload sheet"
                disabled={!uploadBtnOpen || uploadState?.status === 'parsing'}
                style={{ width: uploadBtnOpen ? 34 : 0, opacity: uploadBtnOpen ? 1 : 0, overflow: 'hidden', padding: '7px 0', border: uploadBtnOpen ? '1px solid #D6E4FF' : '1px solid transparent', background: '#F8FBFF', color: uploadState?.status === 'parsing' ? '#94A3B8' : '#2563EB', borderRadius: 10, cursor: (!uploadBtnOpen || uploadState?.status === 'parsing') ? 'default' : 'pointer', fontSize: 17, lineHeight: 1, transition: 'width .18s ease, opacity .18s ease', pointerEvents: uploadBtnOpen ? 'auto' : 'none', fontFamily: 'inherit' }}
              >⬆</button>
            </div>
          </div>

          {uploadState && uploadState.status !== 'parsing' && (
            <div style={{ marginTop: 14 }}>
              {/* Main status bar */}
              {uploadState.status !== 'invalid' && (
                <div style={{ padding: '12px 16px', borderRadius: 10,
                  background: statusColors[uploadState.status]?.bg,
                  border: `1px solid ${statusColors[uploadState.status]?.border}`,
                  fontSize: 13, lineHeight: 1.6,
                  color: statusColors[uploadState.status]?.text }}>
                  {uploadState.status === 'done' && '✓ '}{uploadState.status === 'error' && '✕ '}{uploadState.message}
                  {uploadState.status === 'done' && uploadState.result?.employees?.length > 0 && (
                    <div style={{ marginTop: 10, border: '1px solid #D1FAE5', borderRadius: 8, overflow: 'hidden' }}>
                      <div style={{ display: 'grid', gridTemplateColumns: previewGridTemplate, gap: 0, background: '#ECFDF5', padding: '6px 12px', fontSize: 11, fontWeight: 700, color: '#059669', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                        {previewColumns.map(column => <span key={column.key}>{column.label}</span>)}
                      </div>
                      <div style={{ maxHeight: previewExpanded ? 'none' : 220, overflowY: previewExpanded ? 'visible' : 'auto' }}>
                        {(previewExpanded ? uploadState.result.employees : uploadState.result.employees.slice(0, 5)).map((emp, i) => (
                          <div key={i} style={{ display: 'grid', gridTemplateColumns: previewGridTemplate, gap: 0, padding: '6px 12px', fontSize: 12, color: '#374151', borderTop: '1px solid #D1FAE5' }}>
                            {previewColumns.map(column => <span key={column.key}>{column.render(emp)}</span>)}
                          </div>
                        ))}
                      </div>
                      {uploadState.result.count > 5 && (
                        <button type="button" onClick={() => setPreviewExpanded(v => !v)} style={{ width: '100%', padding: '7px 12px', fontSize: 11.5, color: '#2563EB', fontWeight: 600, background: '#F0FDF4', border: 'none', borderTop: '1px solid #D1FAE5', cursor: 'pointer', fontFamily: 'inherit', textAlign: 'left' }}>
                          {previewExpanded ? '▲ Show less' : `▼ Show all ${uploadState.result.count} employees`}
                        </button>
                      )}
                    </div>
                  )}
                  {uploadState.status === 'done' && (uploadState.result?.groupLinked || uploadState.result?.libraryLinked) && (
                    <div style={{ marginTop: 10, fontSize: 12, color: '#166534' }}>
                      {uploadState.result.groupLinked ? `Group matches: ${uploadState.result.assignedGroupCount || 0}/${uploadState.result.count}. ` : ''}
                      {uploadState.result.libraryLinked ? `Library matches: ${uploadState.result.assignedCount || 0}/${uploadState.result.count}. ` : ''}
                      {routingColumns.length > 0 ? `Routing is based on ${routingLabelText}.` : 'Routing uses your current group setup.'}
                    </div>
                  )}
                </div>
              )}

              {/* Validation errors panel */}
              {uploadState.status === 'invalid' && uploadState.errors?.length > 0 && (
                <div style={{ background: '#FEF2F2', border: '1.5px solid #FECACA', borderRadius: 10, overflow: 'hidden' }}>
                  <div style={{ padding: '10px 16px', background: '#FEE2E2', display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontSize: 14 }}>✕</span>
                    <span style={{ fontSize: 13, fontWeight: 600, color: '#DC2626' }}>
                      {uploadState.errors.length} validation error{uploadState.errors.length !== 1 ? 's' : ''} — fix and re-upload
                    </span>
                  </div>
                  <div style={{ maxHeight: 220, overflowY: 'auto' }}>
                    {uploadState.errors.map((err, i) => (
                      <div key={i} style={{ display: 'grid', gridTemplateColumns: '60px 120px 1fr', gap: 8, padding: '7px 16px', borderTop: '1px solid #FECACA', fontSize: 12, color: '#374151' }}>
                        <span style={{ color: '#9CA3AF', fontFamily: 'monospace' }}>{getIssueRowLabel(err)}</span>
                        <span style={{ color: '#6B7280', fontFamily: 'monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{err.code}</span>
                        <span style={{ color: '#DC2626' }}>{err.message}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Warnings panel (shown when upload succeeded but there are soft issues) */}
              {uploadState.warnings?.length > 0 && (
                <div style={{ marginTop: 10, background: '#FFFBEB', border: '1.5px solid #FDE68A', borderRadius: 10, overflow: 'hidden' }}>
                  <div style={{ padding: '8px 16px', background: '#FEF3C7', display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontSize: 13 }}>⚠</span>
                    <span style={{ fontSize: 12.5, fontWeight: 600, color: '#92400E' }}>
                      {uploadState.warnings.length} warning{uploadState.warnings.length !== 1 ? 's' : ''} — review before launching
                    </span>
                  </div>
                  <div style={{ maxHeight: 160, overflowY: 'auto' }}>
                    {uploadState.warnings.map((w, i) => (
                      <div key={i} style={{ display: 'grid', gridTemplateColumns: '60px 120px 1fr auto', gap: 8, padding: '6px 16px', borderTop: '1px solid #FDE68A', fontSize: 12, color: '#374151', alignItems: 'start' }}>
                        <span style={{ color: '#9CA3AF', fontFamily: 'monospace' }}>{getIssueRowLabel(w)}</span>
                        <span style={{ color: '#6B7280', fontFamily: 'monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{w.code}</span>
                        <span style={{ color: '#92400E' }}>{w.message}</span>
                        {w.category === 'group_missing' && Array.isArray(uploadState.result?.missingGoalGroupNames) && uploadState.result.missingGoalGroupNames.length > 0 ? (
                          <button
                            type="button"
                            onClick={() => deferMissingGoalGroups(uploadState.result.missingGoalGroupNames)}
                            style={{
                              padding: '6px 10px',
                              borderRadius: 8,
                              border: '1px solid #F59E0B',
                              background: '#FFF7ED',
                              color: '#B45309',
                              fontSize: 11.5,
                              fontWeight: 700,
                              cursor: 'pointer',
                              fontFamily: 'inherit',
                              whiteSpace: 'nowrap',
                            }}
                          >
                            Defer for later
                          </button>
                        ) : <span />}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {uploadState?.status === 'parsing' && (
            <div style={{ marginTop: 14, padding: '12px 16px', borderRadius: 10, background: '#EFF6FF', border: '1px solid #BFDBFE', fontSize: 13, color: '#2563EB' }}>
              Parsing file…
            </div>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHead title="Post-upload actions" />
        <CardBody>
          {config.requireEmail !== false ? (
            <>
              <TogRow label="Auto-send invite email to employees" desc="Each employee gets a login link and goal-setting instructions" last={false} on={true} onChange={() => {}} />
              <TogRow label="Send manager summary email" desc="Each manager gets a list of their reportees and pending actions" last={true} on={true} onChange={() => {}} />
            </>
          ) : (
            <div style={{ fontSize: 13, color: '#6B7280', padding: '4px 0' }}>No email actions — email is disabled for this organisation.</div>
          )}
        </CardBody>
      </Card>
    </div>
  );
}

/* ── LIMITS & RULES (dynamic step) ──────────────────────────────────────── */
function StepLimitsRules({ config, update }) {
  const segmentLabel = config.goalSegmentBy || 'Department';
  return (
    <div>
      <SectionHead
        title="Limits & rules"
        sub="Set KRA count limits, weightage rules, and what employees can do during goal setting. The system enforces these at submission."
      />

      {/* ── C: EMPLOYEE PERMISSIONS ──────────────────────────────────── */}
      <Card>
        <CardHead title="Employee & manager permissions" />
        <CardBody>
          <div style={{ fontSize: 12, color: '#6B7280', lineHeight: 1.55, marginBottom: 14 }}>
            Control whether employees and managers can add goals on top of what HR has pre-loaded.
          </div>
          <TogRow
            label="Employees can add their own goals on top of the library"
            desc="Beyond what HR pre-loads, employees can propose additional KRAs for manager approval."
            on={config.employeeCanAddGoals}
            onChange={v => update('employeeCanAddGoals', v)}
          />
          {config.employeeCanAddGoals && (
            <div style={{ paddingLeft: 0, marginTop: 4, marginBottom: 4 }}>
              <Grid2>
                <Field label="Max additional goals employee can add">
                  <input
                    style={inputStyle} type="number" min={1} max={10}
                    value={config.maxEmployeeAddedGoals}
                    onChange={e => update('maxEmployeeAddedGoals', Number(e.target.value))}
                  />
                </Field>
                <Field label="Approval required for employee-added goals">
                  <select style={selectStyle} value={config.employeeGoalApproval} onChange={e => update('employeeGoalApproval', e.target.value)}>
                    <option value="manager">Manager must approve</option>
                    <option value="auto">Auto-approved (no approval needed)</option>
                    <option value="hr">HR approval required</option>
                  </select>
                </Field>
              </Grid2>
            </div>
          )}
          <TogRow
            label="Manager can assign extra goals to an employee"
            desc="During goal setting phase, managers can add KRAs directly to an employee's sheet."
            on={config.managerCanAddGoals}
            onChange={v => update('managerCanAddGoals', v)}
          />
          <TogRow
            label="Manager approval required for all KRAs before finalisation"
            desc="Every KRA on an employee's sheet — from the library or self-added — must be explicitly approved by the manager before the goal window closes."
            last
            on={config.managerApproveKRA}
            onChange={v => update('managerApproveKRA', v)}
          />
        </CardBody>
      </Card>

      {/* ── D: KRA LIMITS ────────────────────────────────────────────── */}
      <Card>
        <CardHead title="D  —  KRA count & weightage limits" />
        <CardBody>
          <Banner type="amber">
            <span>⚠️</span>
            <span>Set clear limits so KRA weightages always total 100% and employees don't under- or over-load their goal sheets. The system enforces these at submission.</span>
          </Banner>

          {/* KRA count */}
          <div style={{ fontSize: 12, fontWeight: 600, color: '#374151', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 10 }}>KRA count limits</div>
          <TogRow
            label={`Apply different KRA count limits per ${segmentLabel}`}
            desc={`E.g. Sales gets min 3 / max 8 KRAs while Support gets min 2 / max 5. Configure per-group limits from the Goal Library section.`}
            on={config.kraLimitsPerAttribute}
            onChange={v => update('kraLimitsPerAttribute', v)}
          />
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: 12, marginTop: 14, marginBottom: 6 }}>
            <Field label="Min KRAs required" hint="Per employee">
              <input style={inputStyle} type="number" min={1} max={20}
                value={config.minKRAs} onChange={e => update('minKRAs', Number(e.target.value))} />
            </Field>
            <Field label="Max KRAs allowed" hint="Per employee">
              <input style={inputStyle} type="number" min={1} max={20}
                value={config.maxKRAs} onChange={e => update('maxKRAs', Number(e.target.value))} />
            </Field>
            <Field label="Max KPIs per KRA" hint="Sub-metrics under each KRA">
              <input style={inputStyle} type="number" min={1} max={10}
                value={config.maxKPIsPerKRA} onChange={e => update('maxKPIsPerKRA', Number(e.target.value))} />
            </Field>
            <Field label="Min KPI weightage %" hint="Each KPI must carry at least this weight">
              <input style={inputStyle} type="number" min={1} max={50}
                value={config.minKPIWeight} onChange={e => update('minKPIWeight', Number(e.target.value))} />
            </Field>
          </div>
          {config.kraLimitsPerAttribute && (
            <Banner type="blue">
              <span>ℹ️</span>
              <span>The values above act as defaults. Override them per {segmentLabel} from the Goal Library section once employees are uploaded.</span>
            </Banner>
          )}

          {/* Weightage rules */}
          <div style={{ height: 1, background: '#F1F3F5', margin: '16px 0' }} />
          <div style={{ fontSize: 12, fontWeight: 600, color: '#374151', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 10 }}>Who controls KRA weightages?</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 14 }}>
            {WEIGHTAGE_OWNERSHIP_OPTIONS.map(opt => {
              const isSelected = config.weightageOwnership === opt.id;
              return (
                <button
                  key={opt.id}
                  type="button"
                  onClick={() => update('weightageOwnership', opt.id)}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 12, textAlign: 'left',
                    border: `1.5px solid ${isSelected ? '#2563EB' : '#E9EDF2'}`,
                    borderRadius: 8, padding: '10px 12px', cursor: 'pointer',
                    background: isSelected ? '#EFF4FF' : '#fff', transition: 'all .16s', appearance: 'none',
                  }}
                >
                  <div style={{
                    width: 16, height: 16, borderRadius: '50%', flexShrink: 0,
                    border: `2px solid ${isSelected ? '#2563EB' : '#D1D5DB'}`,
                    background: isSelected ? '#2563EB' : '#fff',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                  }}>
                    {isSelected && <div style={{ width: 6, height: 6, borderRadius: '50%', background: '#fff' }} />}
                  </div>
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 500, color: '#0D1117' }}>{opt.label}</div>
                    <div style={{ fontSize: 11.5, color: '#9CA3AF' }}>{opt.desc}</div>
                  </div>
                </button>
              );
            })}
          </div>
          <Grid2>
            <Field label="Min weightage per KRA %" hint="A single KRA must carry at least this much weight">
              <input style={inputStyle} type="number" min={1} max={50}
                value={config.minKRAWeight} onChange={e => update('minKRAWeight', Number(e.target.value))} />
            </Field>
            <Field label="Max weightage per KRA %" hint="No single KRA can exceed this weight">
              <input style={inputStyle} type="number" min={10} max={100}
                value={config.maxKRAWeight} onChange={e => update('maxKRAWeight', Number(e.target.value))} />
            </Field>
          </Grid2>
          <Banner type="green">
            <span>✓</span>
            <span>Total KRA weightage is always enforced at <strong>100%</strong>. The system prevents goal sheet submission if weights don't sum correctly.</span>
          </Banner>
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
    const next = (config.selectedCompetencies || []).includes(c)
      ? (config.selectedCompetencies || []).filter(x => x !== c)
      : [...(config.selectedCompetencies || []), c];
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
                      border: `1px solid ${(config.selectedCompetencies || []).includes(c) ? '#2563EB' : '#E2E8F0'}`,
                      background: (config.selectedCompetencies || []).includes(c) ? '#EFF4FF' : '#fff',
                      color: (config.selectedCompetencies || []).includes(c) ? '#2563EB' : '#6B7280',
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

/* ── STEP: PHASES ──────────────────────────────────────────────────────── */
function StepPhases({ config, update }) {
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
      <SectionHead title="Phase windows & cycle dates" sub="Set all date windows for each phase of the appraisal cycle. Also configure goal phase controls." />
      <Card>
        <CardHead title="Goal phase controls" />
        <CardBody>
          {[
            { label: 'Freeze goal setting after the deadline',            desc: 'Employees cannot add or edit KRAs once the goal setting window closes.',                key: 'freezeGoalSetting' },
            { label: 'Allow manager to reopen goal setting per employee', desc: 'Manager can individually unlock the goal window for a specific reportee.',              key: 'managerUnlockGoals' },
            { label: 'Allow HR to reopen goal setting globally',          desc: 'HR can extend the goal window for all or selected employees.',                           key: 'hrReopenSelf' },
            { label: 'Allow mid-year KRA revision',                       desc: 'KRAs can be revised during the mid-year review window with manager approval.',           key: 'midYearRevision' },
            { label: 'Freeze self-evaluation after the deadline',         desc: 'Employee cannot change self-ratings after the evaluation window closes.',                key: 'freezeSelfEval' },
          ].map((t, i, arr) => (
            <TogRow key={t.key} label={t.label} desc={t.desc} last={i === arr.length - 1}
              on={config[t.key]} onChange={v => update(t.key, v)} />
          ))}
        </CardBody>
      </Card>
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
function StepExport({ config }) {
  const cols = ['Employee code', 'Employee name', 'Email ID', 'Reporting manager code', 'Template assigned', 'KRA 1 name', 'KRA 1 weight %', 'KPI 1.1 name', 'KPI 1.1 target', 'KPI 1.1 direction', 'KRA 2 name', '… up to max KRAs', 'Perspective (if BSC)'];
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
          {config.requireEmail !== false ? (
            <>
              <TogRow label="Auto-send invite email to employees on upload" desc="Each employee gets a login link and goal-setting instructions" last={false} on={true} onChange={() => {}} />
              <TogRow label="Send manager summary email" desc="Each manager gets a list of their reportees and pending actions" last={true} on={true} onChange={() => {}} />
            </>
          ) : (
            <div style={{ fontSize: 13, color: '#6B7280', padding: '4px 0' }}>No email actions — email is disabled for this organisation.</div>
          )}
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
  frameworkId: 'bsc',
  frameworkAppliedSnapshot: null,
  perspectives: [
    { id: 1, name: 'Financial',          weight: 25, color: '#2563EB' },
    { id: 2, name: 'Customer',           weight: 25, color: '#16A34A' },
    { id: 3, name: 'Internal Processes', weight: 25, color: '#D97706' },
    { id: 4, name: 'Learning & Growth',  weight: 25, color: '#7C3AED' },
  ],
  perspectivesConfirmed: false,
  perspectivesAppliedSnapshot: null,
  lastDeletedPerspective: null,
  // Modules
  enabledModules: ['kpi', 'persp', 'goals', 'comp', 'quest', 'bell', 'showfinal', 'showself'],
  // Hierarchy
  ratingLevels: ['self', 'l1', 'hr'],
  selfVisibility: 'Yes — always visible', l1Visibility: 'After results are published',
  managerOverride: 'Yes — full override', peerVisibility: 'Anonymous — aggregated only',
  finalRatingOwner: 'Weighted average of all levels',
  // Scale
  scalePoints: 5, scaleDisplay: 'Number + label', ratingAppliesAt: 'KPI level — rolled up',
  // Goal creation flow
  goalCreationMode: 'admin-library',   // 'admin-library' | 'employee-self' | 'mixed' (legacy + new)
  goalLibraryScope: 'common',          // 'common' | 'by-attribute'
  goalSegmentAttr: 'Department',
  goalSegmentValues: [],               // [{ id, name }]
  goalSegmentValuesConfirmed: false,
  goalKpiMode: null,          // 'kra-only' | 'kra-kpi'
  goalEmployeeEdit: null,     // 'locked' | 'add-kpis' | 'edit-freely'
  goalsAppliedSnapshot: null,
  goalLibraryData: null,
  goalLibraryAppliedSnapshot: null,
  prefillDataAppliedSnapshot: null,
  employeeUploadData: null,
  // New goal groups system
  goalGroups: [
    {
      id: 'grp_default',
      name: 'All Employees',
      segmentAttr: null,
      segmentValues: [],
      mode: 'scratch',            // 'scratch' | 'prefill'
      hasLibrary: false,
      libraryId: null,
      prefillEditability: 'add-kpis',
    }
  ],
  goalGroupsAppliedSnapshot: null,
  deferredGoalGroupNames: [],
  // Goal libraries (created/uploaded by admin)
  goalLibraries: [],              // [{id, name, type, weightType, perspectives:[{name,weight,kras:[{id,name,desc,suggestedWeight,kpis:[{id,name,desc,weight}]}]}]}]
  goalLibrariesAppliedSnapshot: null,
  // Limits
  limitsEnabled: false,
  limitsRules: [],                // [{groupId, minKRAs, maxKRAs, minKRAsPerPersp, maxKRAsPerPersp, minKPIsPerKRA, maxKPIsPerKRA, minKRAWeight, maxKRAWeight, minKPIWeight, maxKPIWeight}]
  limitsAppliedSnapshot: null,
  // Employee settings
  empCodeFormat: { type: 'free' },
  managerLevels: 1,
  requireEmail: true,
  empSettingsAppliedSnapshot: null,
  goalLimitEnabled: false,
  goalLimitScope: 'common',            // 'common' | 'by-attribute'
  goalLimitAttr: 'Department',
  goalLimitValues: [],                 // [{ id, name, min, max }]
  goalLimitMin: 3,
  goalLimitMax: 8,
  // Goals — legacy fields kept for non-BSC flows
  goalLibraryMode: 'shared', goalSegmentBy: 'Department', goalSegmentFallback: 'merged', goalPreFillDepth: 'kras-only',
  employeeCanAddGoals: true, maxEmployeeAddedGoals: 2, employeeGoalApproval: 'manager',
  managerCanAddGoals: true, managerApproveKRA: true,
  kraLimitsPerAttribute: false, minKRAs: 3, maxKRAs: 6, maxKPIsPerKRA: 4,
  minKPIWeight: 5, weightageOwnership: 'hr-fixed', minKRAWeight: 5, maxKRAWeight: 60,
  freezeGoalSetting: true, managerUnlockGoals: true, freezeSelfEval: true,
  hrReopenSelf: true, midYearRevision: false,
  // Targets
  autoRating: true, managerOverrideAuto: true,
  // Competencies
  competenciesEnabled: true,
  selectedCompetencies: ['Communication', 'Problem Solving', 'Teamwork', 'Ownership', 'Technical Expertise'],
  // Bell curve
  bellEnabled: true, bellPerDept: true, bellNotify: false,
  bellBands: [10, 20, 50, 15, 5],
};

/* Ensures critical array fields are never null/undefined when loading persisted state */
function normalizeConfig(raw) {
  const merged = { ...INITIAL, ...raw };
  // Guarantee all fields that are accessed with .filter/.map/.includes/.length
  // are always arrays — persisted state can store null for these if it was corrupted
  if (!Array.isArray(merged.perspectives))     merged.perspectives     = INITIAL.perspectives;
  if (!Array.isArray(merged.ratingLevels))     merged.ratingLevels     = INITIAL.ratingLevels;
  if (!Array.isArray(merged.enabledModules))   merged.enabledModules   = INITIAL.enabledModules;
  if (!Array.isArray(merged.bellBands))        merged.bellBands        = INITIAL.bellBands;
  if (!Array.isArray(merged.goalGroups))       merged.goalGroups       = INITIAL.goalGroups;
  if (!Array.isArray(merged.deferredGoalGroupNames)) merged.deferredGoalGroupNames = INITIAL.deferredGoalGroupNames;
  if (!Array.isArray(merged.goalLibraries))    merged.goalLibraries    = INITIAL.goalLibraries;
  if (!Array.isArray(merged.goalSegmentValues))merged.goalSegmentValues= INITIAL.goalSegmentValues;
  if (!Array.isArray(merged.goalLimitValues))  merged.goalLimitValues  = INITIAL.goalLimitValues;
  if (!Array.isArray(merged.selectedCompetencies)) merged.selectedCompetencies = INITIAL.selectedCompetencies;
  if (merged.prefillDataAppliedSnapshot === undefined) merged.prefillDataAppliedSnapshot = INITIAL.prefillDataAppliedSnapshot;
  merged.goalLibraries = normalizeGoalLibraries(merged.goalLibraries);
  merged.deferredGoalGroupNames = normalizeDeferredGoalGroups(merged.deferredGoalGroupNames);
  return merged;
}

/* Returns true only when a step has genuinely valid / complete data */
function isStepComplete(stepId, config) {
  switch (stepId) {
    case 'framework':
      return !!config.frameworkId && config.frameworkAppliedSnapshot === getFrameworkSnapshot(config);
    case 'perspectives': {
      const activePerspectives = (config.perspectives || []).filter((perspective) => !isPerspectiveRowEmpty(perspective));
      const total = activePerspectives.reduce((sum, perspective) => sum + (Number(perspective.weight) || 0), 0);
      return (
        activePerspectives.length > 0 &&
        total === 100 &&
        activePerspectives.every((perspective) => isPerspectiveRowComplete(perspective)) &&
        config.perspectivesAppliedSnapshot === getPerspectivesSnapshot(config)
      );
    }
    case 'goals':
      // Support both new (goalGroups) and old (goalCreationMode) config
      if (config.goalGroups?.length > 0) {
        return isGoalGroupsValid(config) && config.goalGroupsAppliedSnapshot === getGoalGroupsSnapshot(config);
      }
      return isGoalSettingsValid(config) && config.goalsAppliedSnapshot === getGoalsSnapshot(config);
    case 'groups':
      return (config.goalGroups || []).length > 0 &&
        (config.goalGroups || []).every(g => g.prefillType || g.canEditOwn !== false) &&
        config.goalGroupsAppliedSnapshot === getNewGroupsSnapshot(config);
    case 'prefill_data': {
      const groupsNeedingPrefill = groupsNeedingPrefillData(config);
      if (groupsNeedingPrefill.length === 0) return true;
      return isPrefillDataValid(config) && !!config.prefillDataAppliedSnapshot;
    }
    case 'goal_libraries': {
      const groupsNeedingLib = groupsNeedingLibraryData(config);
      if (groupsNeedingLib.length === 0) return true;
      return groupsNeedingLib.every(group =>
        getGroupLibraryAssignments(group).every(assignment =>
          assignment.libraryId && (config.goalLibraries || []).some(library => library.id === assignment.libraryId)
        )
      ) && !!config.goalLibrariesAppliedSnapshot;
    }
    case 'kra_library':
      // Support both new and old config
      if (config.goalGroups?.length > 0) {
        return isGoalGroupDataValid(config);
      }
      return isGoalLibraryValid(config) && config.goalLibraryAppliedSnapshot === getGoalLibraryDataSnapshot(config.goalLibraryData);
    case 'emp_settings':
      return isEmployeeSettingsValid(config) && config.empSettingsAppliedSnapshot === getEmployeeSettingsSnapshot(config);
    case 'upload':
      return !!config.employeeUploadData;
    case 'limits':
      if (config.frameworkId === 'bsc') {
        return !!config.limitsAppliedSnapshot;
      }
      return config.minKRAs > 0 && config.maxKRAs >= config.minKRAs && !!config.weightageOwnership;
    case 'hierarchy':
      return (config.ratingLevels || []).length >= 1;
    case 'scale':
      return config.scalePoints > 0;
    case 'targets':
    case 'competencies':
    case 'bellcurve':
    case 'phases':
      return true;
    case 'summary':
      return false; // completed when launched
    case 'export':
      return false; // only done when actually launched
    default:
      return false;
  }
}

export default function PMSWizard({ onLaunched, orgKeyOverride, orgNameOverride }) {
  const persistedState = useMemo(() => loadWizardState(orgKeyOverride), [orgKeyOverride]);
  const [step, setStep]       = useState(() => persistedState && typeof persistedState.step === 'number' ? persistedState.step : 0);
  const [config, setConfig]   = useState(() => persistedState?.config ? normalizeConfig(persistedState.config) : INITIAL);
  const [visited, setVisited] = useState(() => new Set(Array.isArray(persistedState?.visited) ? persistedState.visited : []));
  const [stepNotice, setStepNotice] = useState(null); // { message, type: 'warn'|'info' }
  const workspace = useMemo(() => {
    if (orgKeyOverride != null) {
      return { orgKey: orgKeyOverride, orgName: orgNameOverride || orgKeyOverride };
    }
    return getWorkspaceContext();
  }, [orgKeyOverride, orgNameOverride]);

  function saveAndExitSetup() {
    saveWizardState(workspace.orgKey, {
      step: safeStep,
      config,
      visited: [...visited],
    });
    exitToLogin();
  }

  useEffect(() => {
    setConfig(prev => {
      const normalizedLibraries = normalizeGoalLibraries(prev.goalLibraries);
      return JSON.stringify(prev.goalLibraries) === JSON.stringify(normalizedLibraries)
        ? prev
        : { ...prev, goalLibraries: normalizedLibraries };
    });
  }, []);

  const navSteps = useMemo(() => getNavSteps(config), [config]);
  const totalSteps = navSteps.length;
  const safeStep = Math.min(step, Math.max(totalSteps - 1, 0));

  function canAccessStep(targetStep) {
    if (targetStep < 0 || targetStep >= navSteps.length) return false;
    const targetStepId = navSteps[targetStep]?.id;
    for (let i = 0; i < targetStep; i += 1) {
      const priorStepId = navSteps[i]?.id;
      if (
        targetStepId === 'goal_libraries' &&
        priorStepId === 'prefill_data'
      ) {
        continue;
      }
      if (!isStepComplete(navSteps[i].id, config)) {
        return false;
      }
    }
    return true;
  }

  function update(key, val) {
    if (key === 'frameworkId') {
      setStep(0);
      setVisited(new Set());
    }
    setConfig(prev => {
      const next = { ...prev, [key]: val };
      if (key === 'goalLibraries') {
        next.goalLibraries = normalizeGoalLibraries(val);
      }
      const shouldResetLibraryData =
        (key === 'frameworkId' && val !== prev.frameworkId) ||
        key === 'perspectives' ||
        (key === 'goalCreationMode' && val !== prev.goalCreationMode) ||
        (key === 'goalSegmentAttr' && val !== prev.goalSegmentAttr) ||
        (key === 'goalKpiMode' && val !== prev.goalKpiMode) ||
        key === 'goalSegmentValues' ||
        (key === 'goalLibraryScope' && val !== prev.goalLibraryScope);

      if (key === 'frameworkId') {
        next.enabledModules = syncEnabledModules(val, prev.enabledModules);
        next.perspectivesConfirmed = false;
        next.lastDeletedPerspective = null;
      }
      if (key === 'perspectives') {
        next.perspectivesConfirmed = false;
      }
      if (key === 'goalSegmentAttr' && val !== prev.goalSegmentAttr) {
        next.goalSegmentValues = [];
        next.goalSegmentValuesConfirmed = false;
      }
      if (key === 'goalKpiMode' && val !== prev.goalKpiMode) {
        next.goalEmployeeEdit = null;
      }
      if (key === 'goalSegmentValues') {
        next.goalSegmentValuesConfirmed = false;
      }
      if (key === 'goalLibraryScope' && val !== prev.goalLibraryScope) {
        next.goalSegmentValuesConfirmed = false;
      }
      if ((key === 'managerLevels' && val !== prev.managerLevels) || (key === 'requireEmail' && val !== prev.requireEmail)) {
        next.empSettingsAppliedSnapshot = null;
        // Column structure of the upload sheet changes — old data is now incompatible
        if (prev.employeeUploadData) {
          next.employeeUploadData = null;
          setStepNotice({ type: 'warn', message: 'Employee upload data was cleared because the column structure changed. Re-confirm settings and re-upload.' });
        }
      }
      if ((key === 'goalGroups' || key === 'goalLibraries') && prev.employeeUploadData) {
        next.employeeUploadData = null;
        setStepNotice({ type: 'warn', message: 'Employee upload data was cleared because group or library allotment changed. Re-upload to recalculate assignment.' });
      }
      if (key === 'deferredGoalGroupNames') {
        next.deferredGoalGroupNames = normalizeDeferredGoalGroups(val);
        if (prev.employeeUploadData) {
          next.employeeUploadData = attachGoalLibraryToEmployees(prev.employeeUploadData, next);
        }
      }
      if (shouldResetLibraryData) {
        next.goalLibraryData = null;
        next.goalLibraryAppliedSnapshot = null;
        next.employeeUploadData = null;
      }
      return next;
    });
  }

  // Sidebar click: just navigate, don't auto-complete anything
  function goTo(n) {
    if (!canAccessStep(n)) return;
    setStepNotice(null);
    setStep(n);
  }

  // Next button: mark current step as visited, then advance
  function next() {
    if (!isStepComplete(navSteps[step]?.id, config)) return;
    if (step < totalSteps - 1) {
      if (!canAccessStep(step + 1)) return;
      setStepNotice(null);
      setVisited(prev => { const s = new Set(prev); s.add(step); return s; });
      setStep(step + 1);
    }
  }
  function back() {
    if (step > 0) {
      setStepNotice(null);
      setStep(step - 1);
    }
  }

  const stepComponents = navSteps.map((navStep) => {
    switch (navStep.id) {
      case 'framework':
        return <StepFramework key="framework" config={config} update={update} />;
      case 'perspectives':
        return <StepPerspectives key="perspectives" config={config} update={update} />;
      case 'groups':
        return <StepGroups key="groups" config={config} update={update} />;
      case 'prefill_data':
        return <StepPrefillData key="prefill_data" config={config} update={update} />;
      case 'goal_libraries':
        return <StepGoalLibraries key="goal_libraries" config={config} update={update} />;
      case 'limits':
        return config.frameworkId === 'bsc'
          ? <StepLimits key="limits" config={config} update={update} />
          : <StepLimitsRules key="limits" config={config} update={update} />;
      case 'emp_settings':
        return <StepEmployeeSettings key="emp_settings" config={config} update={update} />;
      case 'upload':
        return <StepEmployeeUpload key="upload" config={config} update={update} />;
      case 'summary':
        return <StepSummary key="summary" config={config} onLaunched={onLaunched} />;
      case 'goals':
        return <StepGoalLibrary key="goals" config={config} update={update} />;
      case 'kra_library':
        return <StepKRALibrary key="kra_library" config={config} update={update} />;
      case 'hierarchy':
        return <StepHierarchy key="hierarchy" config={config} update={update} />;
      case 'scale':
        return <StepScale key="scale" config={config} update={update} />;
      case 'targets':
        return <StepTargets key="targets" config={config} update={update} />;
      case 'competencies':
        return <StepCompetencies key="competencies" config={config} update={update} />;
      case 'bellcurve':
        return <StepBellCurve key="bellcurve" config={config} update={update} />;
      case 'phases':
        return <StepPhases key="phases" config={config} update={update} />;
      case 'export':
        return <StepExport key="export" config={config} />;
      default:
        return <div key={navStep.id} />;
    }
  });

  const completedCount = navSteps.filter((s, i) => visited.has(i) && isStepComplete(s.id, config)).length;
  const pct = Math.round((completedCount / totalSteps) * 100);
  const currentStepId = navSteps[safeStep]?.id;
  const canProceed = isStepComplete(currentStepId, config);

  useEffect(() => {
    const firstIncompleteStep = navSteps.findIndex((navStep) => !isStepComplete(navStep.id, config));
    const currentStepId = navSteps[safeStep]?.id;
    const firstIncompleteStepId = firstIncompleteStep >= 0 ? navSteps[firstIncompleteStep]?.id : null;
    const allowAdjacentGoalDataNavigation =
      (currentStepId === 'goal_libraries' && firstIncompleteStepId === 'prefill_data') ||
      (currentStepId === 'prefill_data' && firstIncompleteStepId === 'goal_libraries');
    if (allowAdjacentGoalDataNavigation) {
      return;
    }
    if (firstIncompleteStep !== -1 && safeStep > firstIncompleteStep) {
      setStep(firstIncompleteStep);
    }
  }, [config, navSteps, safeStep]);

  useEffect(() => {
    const normalizedStep = Math.min(step, Math.max(navSteps.length - 1, 0));
    if (normalizedStep !== step) {
      setStep(normalizedStep);
      return;
    }

    saveWizardState(workspace.orgKey, {
      step: normalizedStep,
      config,
      visited: [...visited],
    });
  }, [config, navSteps.length, step, visited, workspace.orgKey]);

  return (
    <div style={{ display: 'flex', minHeight: '100vh', fontFamily: "'Geist','Inter','Segoe UI',Arial,sans-serif", fontSize: 14, color: '#0D1117', background: '#F8FAFC' }}>

      {/* SIDEBAR */}
      <aside style={{ width: 230, minWidth: 230, background: '#fff', borderRight: '1.5px solid #E9EDF2', display: 'flex', flexDirection: 'column', position: 'sticky', top: 0, height: '100vh', overflowY: 'auto' }}>
        <div style={{ padding: '20px 18px', borderBottom: '1px solid #E9EDF2' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <img src={zaroLogo} alt="Zaro HR" style={{ width: 34, height: 34, borderRadius: 10, objectFit: 'cover' }} />
            <div>
              <div style={{ fontSize: 14, fontWeight: 700, color: '#0D1117' }}>Zaro HR</div>
              <div style={{ fontSize: 11, color: '#9CA3AF', marginTop: 2 }}>Organization admin / PMS configuration wizard</div>
            </div>
          </div>
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
          {navSteps.map((s, i) => {
            const isActive   = i === safeStep;
            const wasVisited = visited.has(i);
            const isDone     = wasVisited && isStepComplete(s.id, config);
            const isInvalid  = wasVisited && !isStepComplete(s.id, config);
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
                    background: isActive ? '#2563EB' : isDone ? '#16A34A' : isInvalid ? '#F97316' : '#F1F3F5',
                    color:      isActive ? '#fff'    : isDone ? '#fff'    : isInvalid ? '#fff'    : '#9CA3AF',
                  }}>
                    {!isActive && isDone ? '✓' : !isActive && isInvalid ? '!' : i + 1}
                  </div>
                  <div>
                    <div style={{ fontSize: 12.5, fontWeight: isActive ? 600 : 500, color: isActive ? '#2563EB' : isDone ? '#16A34A' : isInvalid ? '#F97316' : '#374151', lineHeight: 1.3 }}>{s.label}</div>
                    <div style={{ fontSize: 11, color: '#9CA3AF', marginTop: 1 }}>{s.desc}</div>
                  </div>
                </div>
                {i < navSteps.length - 1 && <div style={{ width: 1.5, height: 8, background: isDone ? '#16A34A' : '#E9EDF2', marginLeft: 27 }} />}
              </div>
            );
          })}
        </div>
        <div style={{ padding: '14px 16px', borderTop: '1px solid #E9EDF2', fontSize: 11.5, color: '#9CA3AF' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
            <div>
              <div style={{ fontWeight: 600, color: '#374151', marginBottom: 1 }}>HR Admin</div>
              <div>{workspace.orgName}</div>
            </div>
            <button
              type="button"
              onClick={saveAndExitSetup}
              style={{
                padding: '7px 12px',
                borderRadius: 8,
                border: '1px solid #CBD5E1',
                background: '#F8FAFC',
                color: '#374151',
                fontSize: 12,
                fontWeight: 700,
                cursor: 'pointer',
                fontFamily: 'inherit',
                whiteSpace: 'nowrap',
                display: 'flex',
                alignItems: 'center',
                gap: 5,
              }}
            >
              💾 Save & Exit
            </button>
          </div>
        </div>
      </aside>

      {/* MAIN */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>

        {/* PERSISTENT NOTICE — appears when a change wiped downstream data */}
        {stepNotice && (
          <div style={{ padding: '10px 32px', background: '#FFF7ED', borderBottom: '1.5px solid #FED7AA', display: 'flex', alignItems: 'center', gap: 12 }}>
            <span style={{ fontSize: 13, color: '#92400E', flex: 1 }}>⚠ {stepNotice.message}</span>
            <button onClick={() => setStepNotice(null)} style={{ background: 'none', border: 'none', color: '#92400E', cursor: 'pointer', fontSize: 16, lineHeight: 1, fontFamily: 'inherit' }}>×</button>
          </div>
        )}

        {/* CONTENT */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '28px 32px 100px' }}>
          <div style={{ marginBottom: 6, fontSize: 11, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: '#2563EB' }}>
            Step {safeStep + 1} of {totalSteps}
          </div>
          {stepComponents[safeStep]}
        </div>

        {/* CHANGES DETECTED STRIP — shown when revisiting a step and changes are pending */}
        {visited.has(safeStep) && !canProceed && (
          <div style={{ padding: '9px 32px', background: '#FEF3C7', borderTop: '1.5px solid #FDE68A', display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ fontSize: 12.5, color: '#78350F', fontWeight: 500 }}>
              You've made changes — confirm them below before continuing. Downstream steps that depend on this configuration will need to be completed again.
            </span>
          </div>
        )}

        {/* FOOTER NAV */}
        <div style={{ padding: '14px 32px', background: '#fff', borderTop: '1.5px solid #E9EDF2', display: 'flex', alignItems: 'center', justifyContent: 'space-between', position: 'sticky', bottom: 0 }}>
          <div style={{ fontSize: 13, color: '#9CA3AF' }}>
            Step <strong style={{ color: '#2563EB' }}>{safeStep + 1}</strong> of {totalSteps} — {navSteps[safeStep]?.label ?? ''}
          </div>
          <div style={{ display: 'flex', gap: 10 }}>
            {safeStep > 0 && (
              <button onClick={back} style={{ padding: '9px 20px', border: '1.5px solid #E2E8F0', borderRadius: 9, fontSize: 13.5, cursor: 'pointer', background: '#fff', fontFamily: 'inherit' }}>
                ← Back
              </button>
            )}
            <button onClick={next} disabled={!canProceed} style={{ padding: '9px 22px', background: !canProceed ? '#CBD5E1' : safeStep === totalSteps - 1 ? '#16A34A' : '#2563EB', color: '#fff', border: 'none', borderRadius: 9, fontSize: 13.5, fontWeight: 600, cursor: !canProceed ? 'not-allowed' : 'pointer', fontFamily: 'inherit' }}>
              {safeStep === totalSteps - 1 ? '🚀 Launch' : `Next: ${navSteps[safeStep + 1]?.label || ''} →`}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ── LAUNCH OVERVIEW MODAL ───────────────────────────────────────────────── */
export function LaunchOverview({ config, workspace, onClose }) {
  const fw = FRAMEWORKS.find(f => f.id === config?.frameworkId);
  const employees = config?.employeeUploadData?.employees || [];
  const groups = config?.goalGroups || [];
  const hasNewGroups = groups.length > 0;
  const deferredGoalGroupNames = normalizeDeferredGoalGroups(config?.deferredGoalGroupNames || []);

  const groupSummary = hasNewGroups ? groups.map(g => ({
    name: g.name,
    modes: (g.modes || []).map(m => GOAL_MODES.find(gm => gm.id === m)?.title || m).join(' + '),
    prefillCount: getGroupPrefillAssignments(g).filter(assignment => (assignment.data || []).length > 0).length,
    libraryCount: (g.libraryData || []).length,
    limits: g.goalLimitsEnabled ? `${g.goalMin}–${g.goalMax} KRAs` : 'No limits',
  })) : [];

  let credentialCount = 0;
  try {
    const raw = localStorage.getItem('zarohr_emp_credentials');
    if (raw) credentialCount = Object.keys(JSON.parse(raw)).length;
  } catch (_) {}

  const SummaryRow = ({ label, value, highlight }) => (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '9px 0', borderBottom: '1px solid #F1F5F9' }}>
      <span style={{ fontSize: 13, color: '#6B7280' }}>{label}</span>
      <span style={{ fontSize: 13, fontWeight: 600, color: highlight ? '#2563EB' : '#0F172A' }}>{value}</span>
    </div>
  );

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}
      onClick={e => e.target === e.currentTarget && onClose()}>
      <div style={{ background: '#fff', borderRadius: 16, width: '100%', maxWidth: 640, maxHeight: '85vh', overflow: 'hidden', display: 'flex', flexDirection: 'column', boxShadow: '0 20px 60px rgba(0,0,0,0.2)' }}>
        <div style={{ padding: '20px 24px', borderBottom: '1.5px solid #E9EDF2', display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: 'linear-gradient(135deg,#1E293B,#0F172A)', color: '#fff' }}>
          <div>
            <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.1em', textTransform: 'uppercase', color: '#94A3B8', marginBottom: 4 }}>Config Overview</div>
            <div style={{ fontSize: 18, fontWeight: 800 }}>{workspace?.orgName || 'Organization'}</div>
          </div>
          <button onClick={onClose} style={{ background: 'rgba(255,255,255,.12)', border: 'none', borderRadius: 8, color: '#fff', width: 32, height: 32, cursor: 'pointer', fontSize: 18, lineHeight: 1 }}>×</button>
        </div>
        <div style={{ overflowY: 'auto', padding: '20px 24px' }}>
          <div style={{ marginBottom: 20 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: '#94A3B8', textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 10 }}>Framework</div>
            <div style={{ padding: '12px 16px', background: '#F8FAFC', borderRadius: 8, border: '1px solid #E9EDF2' }}>
              <SummaryRow label="Performance Framework" value={fw?.name || config?.frameworkId || 'Not set'} />
              <SummaryRow label="Employees uploaded" value={employees.length > 0 ? `${employees.length} employees` : 'None'} highlight={employees.length > 0} />
              {credentialCount > 0 && <SummaryRow label="Credentials generated" value={`${credentialCount} employees`} highlight />}
            </div>
          </div>
          <div style={{ marginBottom: 20 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: '#94A3B8', textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 10 }}>Goal Creation Strategy</div>
            {hasNewGroups ? (
              <div>
                <div style={{ fontSize: 12, color: '#6B7280', marginBottom: 8 }}>
                  {config.goalGroupStrategy === 'by-group' ? `Segmented by ${config.goalGroupAttr || 'attribute'}` : 'Uniform for all employees'}
                </div>
                {groupSummary.map((g, i) => (
                  <div key={i} style={{ padding: '10px 14px', background: '#F8FAFC', borderRadius: 8, border: '1px solid #E9EDF2', marginBottom: 8 }}>
                    <div style={{ fontWeight: 700, fontSize: 13, color: '#0F172A', marginBottom: 4 }}>{g.name}</div>
                    <div style={{ fontSize: 12, color: '#2563EB', fontWeight: 600, marginBottom: 4 }}>{g.modes}</div>
                    <div style={{ fontSize: 12, color: '#6B7280', display: 'flex', gap: 16 }}>
                      {g.prefillCount > 0 && <span>📋 {g.prefillCount} pre-fill cards</span>}
                      {g.libraryCount > 0 && <span>📚 {g.libraryCount} library KRAs</span>}
                      <span>⚖️ {g.limits}</span>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div style={{ padding: '12px 16px', background: '#F8FAFC', borderRadius: 8, border: '1px solid #E9EDF2' }}>
                <SummaryRow label="Mode" value={config?.goalCreationMode === 'admin-library' ? 'Admin Library' : config?.goalCreationMode === 'employee-self' ? 'Employee Self-Create' : config?.goalCreationMode || 'Not set'} />
              </div>
            )}
          </div>
          {config?.frameworkId === 'bsc' && (
            <div style={{ marginBottom: 20 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: '#94A3B8', textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 10 }}>BSC Perspectives</div>
              <div style={{ padding: '12px 16px', background: '#F8FAFC', borderRadius: 8, border: '1px solid #E9EDF2' }}>
                {(config.perspectives || []).filter(p => p.name && Number(p.weight) > 0).map((p, i) => (
                  <div key={i} style={{ display: 'flex', justifyContent: 'space-between', padding: '7px 0', borderBottom: '1px solid #F1F5F9', fontSize: 13 }}>
                    <span style={{ color: '#374151' }}>{p.name}</span>
                    <span style={{ fontWeight: 600, color: p.color || '#2563EB' }}>{p.weight}%</span>
                  </div>
                ))}
              </div>
            </div>
          )}
          {employees.length > 0 && (
            <div>
              <div style={{ fontSize: 11, fontWeight: 700, color: '#94A3B8', textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 10 }}>Employees ({employees.length})</div>
              <div style={{ background: '#F8FAFC', borderRadius: 8, border: '1px solid #E9EDF2', overflow: 'hidden', maxHeight: 200, overflowY: 'auto' }}>
                {employees.slice(0, 20).map((emp, i) => (
                  <div key={i} style={{ padding: '8px 14px', borderBottom: '1px solid #F1F5F9', display: 'flex', justifyContent: 'space-between', fontSize: 12.5 }}>
                    <span style={{ fontWeight: 600, color: '#0F172A' }}>{emp['Employee Name'] || emp['Employee Code']}</span>
                    <span style={{ color: '#9CA3AF' }}>{emp['Employee Code']} · {emp['Designation'] || emp['Department'] || ''}</span>
                  </div>
                ))}
                {employees.length > 20 && <div style={{ padding: '8px 14px', fontSize: 12, color: '#9CA3AF' }}>+{employees.length - 20} more…</div>}
              </div>
            </div>
          )}
          {deferredGoalGroupNames.length > 0 && (
            <div style={{ marginTop: 20 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: '#94A3B8', textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 10 }}>Deferred Rollout</div>
              <div style={{ padding: '12px 16px', background: '#EFF6FF', borderRadius: 8, border: '1px solid #BFDBFE', fontSize: 12.5, color: '#1E3A8A' }}>
                {deferredGoalGroupNames.join(', ')} are intentionally left out of this rollout and can be uploaded later by reopening the saved draft.
              </div>
            </div>
          )}
        </div>
        <div style={{ padding: '16px 24px', borderTop: '1.5px solid #E9EDF2', background: '#F8FAFC' }}>
          <button onClick={onClose} style={{ width: '100%', padding: '10px', background: '#2563EB', color: '#fff', border: 'none', borderRadius: 8, fontSize: 14, fontWeight: 600, cursor: 'pointer' }}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

/* ── STANDALONE ORG CHART PANEL ──────────────────────────────────────────── */
const ORG_PARTICLES = (() => {
  const count = 32;
  const particles = [];
  for (let i = 0; i < count; i++) {
    const size = 4 + Math.random() * 8;
    const x = Math.random() * 100;
    const dur = 10 + Math.random() * 16;
    const delay = -(Math.random() * dur);
    const drift = -40 + Math.random() * 80;
    const opacity = 0.18 + Math.random() * 0.28;
    const colors = ['99,102,241','59,130,246','139,92,246','14,165,233','16,185,129','245,158,11'];
    const color = colors[i % colors.length];
    const startY = Math.random() * 90;
    particles.push({ size, x, dur, delay, drift, opacity, color, id: i, startY });
  }
  return particles;
})();

const ORG_ANIM_CSS = ORG_PARTICLES.map(p => `
@keyframes orgP${p.id}{
  0%{transform:translateY(0) translateX(0) scale(1);opacity:0}
  8%{opacity:${p.opacity}}
  50%{opacity:${p.opacity * 0.8};transform:translateY(-250px) translateX(${p.drift * 0.5}px) scale(1.1)}
  100%{transform:translateY(-550px) translateX(${p.drift}px) scale(0.7);opacity:0}
}`).join('') + `
@keyframes orgTwinkle{
  0%,100%{opacity:0.5}
  50%{opacity:1}
}`;

function orgNid(node) {
  return node.type === 'manager-placeholder'
    ? `mgr:${String(node.manager?.code || '').trim().toLowerCase()}`
    : `emp:${String(node.employee?.['Employee Code'] || '').trim().toLowerCase()}`;
}

function orgFilterNode(node, q) {
  if (!q) return node;
  const reps = (node.reports || []).map((c) => orgFilterNode(c, q)).filter(Boolean);
  const text = node.type === 'manager-placeholder'
    ? `${node.manager?.name || ''} ${node.manager?.code || ''}`.toLowerCase()
    : `${node.employee?.['Employee Name'] || ''} ${node.employee?.['Employee Code'] || ''} ${node.employee?.Designation || ''}`.toLowerCase();
  return (text.includes(q) || reps.length > 0) ? { ...node, reports: reps, reportCount: reps.length } : null;
}

function OrgNode({ node, depth = 0, gid = '', expandedOrgNodeIds, toggleNode, searchActive }) {
  const rawId = orgNid(node);
  const id = gid ? `${gid}:${rawId}` : rawId;
  const expandable = node.reportCount > 0;
  const expanded = expandable ? (searchActive ? true : expandedOrgNodeIds[id] !== false) : false;

  let name, code, title, isPlaceholder, placeholderKind;
  if (node.type === 'manager-placeholder') {
    const mgr = node.manager || {};
    name = mgr.name || mgr.code; code = mgr.code || '—'; title = '';
    isPlaceholder = true; placeholderKind = mgr.kind;
  } else {
    const emp = node.employee || {};
    name = emp['Employee Name'] || emp['Employee Code'] || 'Employee';
    code = emp['Employee Code'] || '—';
    title = String(emp.Designation || emp.Department || emp['Group Name'] || '').trim();
    isPlaceholder = false;
  }

  const cardBg = isPlaceholder
    ? (placeholderKind === 'cross-group' ? '#F5F3FF' : '#FFFBEB')
    : (depth === 0 ? '#F8FAFC' : '#fff');
  const cardBorder = isPlaceholder
    ? (placeholderKind === 'cross-group' ? '#DDD6FE' : '#FDE68A')
    : '#E2E8F0';
  const titleColor = isPlaceholder
    ? (placeholderKind === 'cross-group' ? '#312E81' : '#78350F')
    : '#0F172A';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', minWidth: 220 }}>
      <div style={{
        width: 200, maxWidth: '100%',
        padding: '9px 11px', borderRadius: 10, background: cardBg,
        border: `1px solid ${cardBorder}`, fontFamily: 'inherit',
        boxShadow: depth === 0 ? '0 2px 6px rgba(15,23,42,.06)' : '0 1px 3px rgba(15,23,42,.04)',
      }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 12.5, fontWeight: 700, color: titleColor, lineHeight: 1.3, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{name}</div>
            <div style={{ fontSize: 11, color: '#64748B', marginTop: 2, lineHeight: 1.3, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {code}{title ? ` · ${title}` : ''}
            </div>
            {isPlaceholder && (
              <div style={{ fontSize: 10.5, color: placeholderKind === 'cross-group' ? '#5B21B6' : '#B45309', marginTop: 3 }}>
                {placeholderKind === 'cross-group' ? 'Cross-group manager' : 'Outside-PMS manager'}
              </div>
            )}
          </div>
          {expandable && (
            <button type="button" onClick={() => toggleNode(id)} aria-label={expanded ? 'Collapse' : 'Expand'}
              title={`${node.reportCount} reportee${node.reportCount === 1 ? '' : 's'}`}
              style={{ background: '#EFF6FF', border: '1px solid #BFDBFE', borderRadius: 999, cursor: 'pointer',
                padding: '1px 7px', color: '#2563EB', fontSize: 10.5, fontWeight: 700, lineHeight: 1.4, fontFamily: 'inherit',
                display: 'inline-flex', alignItems: 'center', gap: 3, flexShrink: 0 }}>
              <span>{node.reportCount}</span>
              <span style={{ display: 'inline-block', transform: expanded ? 'rotate(180deg)' : 'rotate(0deg)', transition: 'transform 220ms ease' }}>▾</span>
            </button>
          )}
        </div>
      </div>
      {expandable && (
        <OrgNodeChildren kids={node.reports} depth={depth} gid={gid} expanded={expanded}
          expandedOrgNodeIds={expandedOrgNodeIds} toggleNode={toggleNode} searchActive={searchActive} />
      )}
    </div>
  );
}

function OrgNodeChildren({ kids, depth, gid, expanded, expandedOrgNodeIds, toggleNode, searchActive }) {
  if (!kids || !kids.length) return null;
  const lineColor = '#CBD5E1'; const lineW = 2;
  const single = kids.length === 1; const gap = 14; const trunk = 18;

  const content = (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', width: 'max-content', minWidth: '100%' }}>
      <div style={{ width: lineW, height: trunk, background: lineColor, flexShrink: 0 }} />
      {single
        ? <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
            <OrgNode node={kids[0]} depth={depth + 1} gid={gid} expandedOrgNodeIds={expandedOrgNodeIds} toggleNode={toggleNode} searchActive={searchActive} />
          </div>
        : <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'center', width: 'max-content', minWidth: '100%' }}>
            {kids.map((child, i) => {
              const isF = i === 0, isL = i === kids.length - 1;
              return (
                <div key={orgNid(child)} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', width: 'max-content', minWidth: 230, padding: `0 ${gap / 2}px` }}>
                  <div style={{ width: '100%', height: trunk, position: 'relative', flexShrink: 0 }}>
                    <div style={{ position: 'absolute', top: 0, left: isF ? '50%' : 0, right: isL ? '50%' : 0, height: lineW, background: lineColor }} />
                    <div style={{ position: 'absolute', top: 0, left: '50%', transform: 'translateX(-50%)', width: lineW, height: '100%', background: lineColor }} />
                  </div>
                  <OrgNode node={child} depth={depth + 1} gid={gid} expandedOrgNodeIds={expandedOrgNodeIds} toggleNode={toggleNode} searchActive={searchActive} />
                </div>
              );
            })}
          </div>
      }
    </div>
  );

  return (
    <div style={{
      display: 'grid',
      gridTemplateRows: expanded ? '1fr' : '0fr',
      opacity: expanded ? 1 : 0,
      width: 'max-content', minWidth: '100%', overflow: 'visible',
      pointerEvents: expanded ? 'auto' : 'none',
      transition: 'grid-template-rows 600ms cubic-bezier(0.22,1,0.36,1), opacity 400ms ease',
      willChange: 'grid-template-rows, opacity',
    }}>
      <div style={{ overflow: 'hidden', width: 'max-content', minWidth: '100%', padding: '0 4px 6px' }}>
        {content}
      </div>
    </div>
  );
}

const ORG_GROUP_PALETTE = [
  { dot: '#4F46E5', bg: '#EEF2FF', border: '#C7D2FE', text: '#3730A3', avatarFrom: '#4F46E5', avatarTo: '#7C3AED' },
  { dot: '#0891B2', bg: '#ECFEFF', border: '#A5F3FC', text: '#0E7490', avatarFrom: '#0891B2', avatarTo: '#0284C7' },
  { dot: '#16A34A', bg: '#F0FDF4', border: '#BBF7D0', text: '#15803D', avatarFrom: '#16A34A', avatarTo: '#059669' },
  { dot: '#D97706', bg: '#FFFBEB', border: '#FDE68A', text: '#92400E', avatarFrom: '#D97706', avatarTo: '#F59E0B' },
  { dot: '#DC2626', bg: '#FEF2F2', border: '#FECACA', text: '#991B1B', avatarFrom: '#DC2626', avatarTo: '#E11D48' },
  { dot: '#7C3AED', bg: '#F5F3FF', border: '#DDD6FE', text: '#5B21B6', avatarFrom: '#7C3AED', avatarTo: '#A855F7' },
];

export function OrgChartPanel({ employees, groups }) {
  const [expandedOrgNodeIds, setExpandedOrgNodeIds] = useState({});
  const [organogramSearch, setOrganogramSearch]     = useState('');
  const [orgViewMode, setOrgViewMode]               = useState('tree');
  const [expandedGroupIds, setExpandedGroupIds]     = useState([]);
  const [isFullscreen, setIsFullscreen]             = useState(false);
  const [orgZoom, setOrgZoom]                       = useState(1);
  const zoomOut = () => setOrgZoom((z) => Math.max(0.5, +(z - 0.1).toFixed(2)));
  const zoomIn  = () => setOrgZoom((z) => Math.min(1.6, +(z + 0.1).toFixed(2)));
  const zoomReset = () => setOrgZoom(1);

  const coverageByGroup = useMemo(() => {
    function buildCoverage({ id, name, members, pal }) {
      const memberCodeMap = new Map(members.map((e) => [String(e['Employee Code'] || '').trim().toLowerCase(), e]));
      const directReportsMap = new Map();
      const externalManagerMap = new Map();
      members.forEach((emp) => {
        const mgrCodeRaw = String(emp['Reporting Manager Code'] || '').trim();
        const mgrCode = mgrCodeRaw.toLowerCase();
        if (!mgrCode) return;
        const list = directReportsMap.get(mgrCode) || [];
        list.push(emp);
        directReportsMap.set(mgrCode, list);
        if (!memberCodeMap.has(mgrCode)) {
          const mgrName = String(emp['Reporting Manager Name'] || '').trim();
          const crossEmp = employees.find((x) => String(x['Employee Code'] || '').trim().toLowerCase() === mgrCode);
          const existing = externalManagerMap.get(mgrCode) || {
            code: mgrCodeRaw,
            name: crossEmp?.['Employee Name'] || mgrName || mgrCodeRaw,
            kind: crossEmp ? 'cross-group' : 'outside',
          };
          externalManagerMap.set(mgrCode, existing);
        }
      });
      function buildNode(emp, trail = new Set()) {
        const code = String(emp['Employee Code'] || '').trim().toLowerCase();
        if (!code || trail.has(code)) return { type: 'employee', employee: emp, reports: [], reportCount: 0 };
        const t2 = new Set(trail); t2.add(code);
        const reports = (directReportsMap.get(code) || [])
          .slice().sort((a, b) => String(a['Employee Name'] || '').localeCompare(String(b['Employee Name'] || '')))
          .map((x) => buildNode(x, t2));
        return { type: 'employee', employee: emp, reports, reportCount: reports.length };
      }
      const internalRoots = members
        .filter((e) => { const c = String(e['Reporting Manager Code'] || '').trim().toLowerCase(); return !c; })
        .sort((a, b) => String(a['Employee Name'] || '').localeCompare(String(b['Employee Name'] || '')))
        .map((e) => buildNode(e));
      const externalRoots = Array.from(externalManagerMap.entries())
        .sort(([, a], [, b]) => String(a.name || a.code).localeCompare(String(b.name || b.code)))
        .map(([mgrCode, mgr]) => {
          const reports = (directReportsMap.get(mgrCode) || [])
            .slice().sort((a, b) => String(a['Employee Name'] || '').localeCompare(String(b['Employee Name'] || '')))
            .map((e) => buildNode(e, new Set([mgrCode])));
          return { type: 'manager-placeholder', manager: mgr, reports, reportCount: reports.length };
        });
      return { id, name, members, rootNodes: [...internalRoots, ...externalRoots], pal };
    }

    const knownNames = new Set(groups.map((g) => String(g?.name || '').trim().toLowerCase()).filter(Boolean));
    const list = groups.map((group, gi) => {
      const gName = String(group?.name || '').trim().toLowerCase();
      const members = employees.filter((e) =>
        String(e.assignedGoalGroupName || e['Group Name'] || '').trim().toLowerCase() === gName
      );
      return buildCoverage({
        id: group.id || String(gi),
        name: group.name || `Group ${gi + 1}`,
        members,
        pal: ORG_GROUP_PALETTE[gi % ORG_GROUP_PALETTE.length],
      });
    });
    const unassignedMembers = employees.filter((e) => {
      const g = String(e.assignedGoalGroupName || e['Group Name'] || '').trim().toLowerCase();
      return !knownNames.has(g);
    });
    if (unassignedMembers.length) {
      list.push(buildCoverage({
        id: '__unassigned__',
        name: 'Unassigned',
        members: unassignedMembers,
        pal: { dot: '#64748B', bg: '#F8FAFC', border: '#E2E8F0', text: '#475569', avatarFrom: '#64748B', avatarTo: '#94A3B8' },
      }));
    }
    return list;
  }, [employees, groups]);

  const populatedGroups = useMemo(() => coverageByGroup.filter((g) => g.members.length > 0), [coverageByGroup]);

  useEffect(() => {
    function collect(nodes, bucket = []) {
      nodes.forEach((n) => { if (n.reportCount > 0) { bucket.push(orgNid(n)); collect(n.reports || [], bucket); } });
      return bucket;
    }
    // Scope IDs per group so the same person in different groups gets independent expand/collapse.
    // Also drop keys that no longer correspond to any node so state doesn't leak across reorgs.
    const ids = populatedGroups.flatMap((g) => collect(g.rootNodes).map((id) => `${g.id}:${id}`));
    setExpandedOrgNodeIds((prev) => {
      const next = {};
      const valid = new Set(ids);
      ids.forEach((id) => { next[id] = prev[id] !== undefined ? prev[id] : true; });
      // Preserve keys we still know about; drop the rest.
      Object.keys(prev).forEach((k) => { if (valid.has(k) && next[k] === undefined) next[k] = prev[k]; });
      return next;
    });
  }, [populatedGroups]);

  useEffect(() => {
    if (populatedGroups.length > 0) setExpandedGroupIds(populatedGroups.map(g => g.id));
  }, [populatedGroups]);

  function toggleNode(id) { setExpandedOrgNodeIds((p) => ({ ...p, [id]: p[id] === undefined ? false : !p[id] })); }
  function toggleGroup(id) { setExpandedGroupIds((p) => p.includes(id) ? p.filter((x) => x !== id) : [...p, id]); }

  const q = organogramSearch.trim().toLowerCase();
  const allEmpty = populatedGroups.length===0;

  const VIEW_MODES=[
    {id:'tree',label:'Tree',icon:<svg width="15" height="15" viewBox="0 0 32 32" fill="none"><path d="M5 15.4C5 8.2 9.9 4 16 4s11 4.2 11 11.4" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"/><path d="M16 4c-2.8 3.5-4.2 7.3-4.2 11.4M16 4c2.8 3.5 4.2 7.3 4.2 11.4" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"/><path d="M6.8 10.6h18.4M5.5 14.4h21" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"/><circle cx="8.6" cy="19.6" r="2.8" stroke="currentColor" strokeWidth="2.4"/><path d="M2.8 28v-2.1c0-2.7 2.6-4.8 5.8-4.8s5.8 2.1 5.8 4.8V28H2.8Z" stroke="currentColor" strokeWidth="2.4" strokeLinejoin="round"/><circle cx="23.4" cy="19.6" r="2.8" stroke="currentColor" strokeWidth="2.4"/><path d="M17.6 28v-2.1c0-2.7 2.6-4.8 5.8-4.8s5.8 2.1 5.8 4.8V28H17.6Z" stroke="currentColor" strokeWidth="2.4" strokeLinejoin="round"/></svg>},
    {id:'by-group',label:'By Group',icon:<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><rect x="1" y="2" width="14" height="3.5" rx="1.5" stroke="currentColor" strokeWidth="1.3"/><rect x="1" y="7.5" width="14" height="3" rx="1.5" stroke="currentColor" strokeWidth="1.3"/><rect x="1" y="12" width="14" height="2.5" rx="1.25" stroke="currentColor" strokeWidth="1.3"/></svg>},
  ];

  const orgContent = (fsMode) => (
    <div style={{fontFamily:"'Geist','Inter','Segoe UI',Arial,sans-serif",position:'relative',minHeight:fsMode?'100vh':200,
      background:fsMode?'linear-gradient(135deg,#F8FAFF 0%,#F0F4FF 30%,#F5F0FF 60%,#F8FAFC 100%)':'transparent'}}>
      <style>{ORG_ANIM_CSS}</style>
      {/* Floating particles background — covers entire content area */}
      <div style={{position:'absolute',top:0,left:0,right:0,bottom:0,overflow:'hidden',pointerEvents:'none',zIndex:0}}>
        {ORG_PARTICLES.map(p=>(
          <div key={p.id} style={{position:'absolute',bottom:`${p.startY}%`,left:`${p.x}%`,width:p.size,height:p.size,borderRadius:'50%',background:`rgba(${p.color},${p.opacity + 0.15})`,boxShadow:`0 0 ${p.size*2}px ${p.size}px rgba(${p.color},${p.opacity*0.4})`,animation:`orgP${p.id} ${p.dur}s ease-in-out ${p.delay}s infinite`}} />
        ))}
      </div>

      <div style={{position:'relative',zIndex:1,padding:fsMode?'20px 28px':0}}>
      {/* Fullscreen header */}
      {fsMode&&(
        <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:18}}>
          <div>
            <div style={{fontSize:18,fontWeight:800,color:'#0F172A'}}>Organogram</div>
            <div style={{fontSize:12,color:'#64748B',fontWeight:600,marginTop:2}}>{employees.length} employees · {populatedGroups.length} groups</div>
          </div>
          <button type="button" onClick={()=>setIsFullscreen(false)}
            style={{padding:'7px 16px',border:'1.5px solid #E2E8F0',borderRadius:8,fontSize:12.5,fontWeight:600,cursor:'pointer',background:'#fff',color:'#374151',fontFamily:'inherit',display:'flex',alignItems:'center',gap:6}}>
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M6 2H3.5A1.5 1.5 0 0 0 2 3.5V6m8-4h2.5A1.5 1.5 0 0 1 14 3.5V6M2 10v2.5A1.5 1.5 0 0 0 3.5 14H6m4 0h2.5a1.5 1.5 0 0 0 1.5-1.5V10" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/></svg>
            Exit Full Screen
          </button>
        </div>
      )}
      <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',gap:10,flexWrap:'wrap',marginBottom:14}}>
        <div style={{position:'relative',display:'flex',alignItems:'center'}}>
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" style={{position:'absolute',left:8,pointerEvents:'none',color:'#94A3B8'}}><circle cx="6.5" cy="6.5" r="4.5" stroke="currentColor" strokeWidth="1.4"/><line x1="10" y1="10" x2="14" y2="14" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/></svg>
          <input type="text" value={organogramSearch} onChange={(e)=>setOrganogramSearch(e.target.value)} placeholder="Search employees…"
            style={{width:180,border:'1px solid #E2E8F0',borderRadius:8,padding:'6px 28px 6px 26px',fontSize:12,color:'#334155',outline:'none',fontFamily:'inherit',background:'rgba(255,255,255,.85)',backdropFilter:'blur(6px)'}}/>
          {organogramSearch&&<button type="button" onClick={()=>setOrganogramSearch('')} style={{position:'absolute',right:6,background:'none',border:'none',cursor:'pointer',color:'#94A3B8',fontSize:13,lineHeight:1,padding:2}}>✕</button>}
        </div>
        <div style={{display:'flex',alignItems:'center',gap:6,flexWrap:'wrap'}}>
          {/* Zoom controls */}
          <div style={{display:'flex',alignItems:'center',gap:0,background:'rgba(241,245,249,.85)',backdropFilter:'blur(6px)',borderRadius:10,padding:3}}>
            <button type="button" onClick={zoomOut} disabled={orgZoom <= 0.5} title="Zoom out"
              style={{width:28,height:28,display:'flex',alignItems:'center',justifyContent:'center',border:'none',borderRadius:7,background:'transparent',cursor:orgZoom<=0.5?'not-allowed':'pointer',color:orgZoom<=0.5?'#CBD5E1':'#475569'}}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M5 12h14"/></svg>
            </button>
            <button type="button" onClick={zoomReset} title="Reset zoom"
              style={{minWidth:44,padding:'0 8px',height:28,background:'transparent',border:'none',borderRadius:7,cursor:'pointer',fontSize:11,fontWeight:700,color:'#475569',fontFamily:'inherit'}}>
              {Math.round(orgZoom * 100)}%
            </button>
            <button type="button" onClick={zoomIn} disabled={orgZoom >= 1.6} title="Zoom in"
              style={{width:28,height:28,display:'flex',alignItems:'center',justifyContent:'center',border:'none',borderRadius:7,background:'transparent',cursor:orgZoom>=1.6?'not-allowed':'pointer',color:orgZoom>=1.6?'#CBD5E1':'#475569'}}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M5 12h14M12 5v14"/></svg>
            </button>
          </div>

          {/* View mode (Tree / By Group) */}
          <div style={{display:'flex',background:'rgba(241,245,249,.85)',backdropFilter:'blur(6px)',borderRadius:10,padding:3,gap:2}}>
            {VIEW_MODES.map((vm)=>{
              const active=orgViewMode===vm.id;
              return(
                <button key={vm.id} type="button" onClick={()=>setOrgViewMode(vm.id)}
                  style={{display:'flex',alignItems:'center',gap:5,padding:'5px 10px',borderRadius:7,border:'none',cursor:'pointer',fontFamily:'inherit',fontSize:12,fontWeight:active?600:500,background:active?'rgba(255,255,255,.9)':'transparent',color:active?'#1E293B':'#64748B',boxShadow:active?'0 1px 4px rgba(15,23,42,.1)':'none',transition:'all 180ms ease'}}>
                  {vm.icon}{vm.label}
                </button>
              );
            })}
          </div>

          {!fsMode&&(
            <button type="button" onClick={()=>setIsFullscreen(true)} title="Full screen"
              style={{width:32,height:32,display:'flex',alignItems:'center',justifyContent:'center',border:'1px solid #E2E8F0',borderRadius:8,background:'rgba(255,255,255,.85)',backdropFilter:'blur(6px)',cursor:'pointer',color:'#64748B',flexShrink:0}}>
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M2 6V3.5A1.5 1.5 0 0 1 3.5 2H6m4 0h2.5A1.5 1.5 0 0 1 14 3.5V6M2 10v2.5A1.5 1.5 0 0 0 3.5 14H6m4 0h2.5a1.5 1.5 0 0 0 1.5-1.5V10" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/></svg>
            </button>
          )}
        </div>
      </div>

      {orgViewMode==='tree'&&populatedGroups.length>1&&(
        <div style={{display:'flex',gap:12,flexWrap:'wrap',marginBottom:12}}>
          {populatedGroups.map((g)=>(
            <div key={g.id} style={{display:'flex',alignItems:'center',gap:5}}>
              <span style={{width:8,height:8,borderRadius:'50%',background:g.pal.dot,display:'inline-block',flexShrink:0}}/>
              <span style={{fontSize:11.5,color:'#475569',fontWeight:500}}>{g.name}</span>
            </div>
          ))}
        </div>
      )}

      {allEmpty&&<div style={{padding:'14px',borderRadius:10,border:'1px solid #E9EDF2',background:'rgba(248,250,252,.85)',fontSize:12,color:'#64748B'}}>No employees uploaded yet.</div>}

      {/* ── TREE VIEW ─────────────────────────────── */}
      {!allEmpty && orgViewMode === 'tree' && (
        <div style={{ overflow: 'auto', paddingBottom: 20 }}>
          <div style={{ zoom: orgZoom, padding: '8px 32px 16px', display: 'flex', justifyContent: 'center', width: 'max-content', minWidth: '100%' }}>
            {(() => {
              const allRoots = populatedGroups.flatMap((group) => {
                const filtered = q ? group.rootNodes.map((n) => orgFilterNode(n, q)).filter(Boolean) : group.rootNodes;
                return filtered.length > 0 ? filtered : (q ? [] : group.members.map((m) => ({ type: 'employee', employee: m, reports: [], reportCount: 0 })));
              });
              if (q && allRoots.length === 0) {
                return <div style={{ padding: '10px 14px', borderRadius: 10, border: '1px dashed #D7E2EE', background: 'rgba(250,252,255,.85)', fontSize: 12, color: '#64748B' }}>No matching employees.</div>;
              }
              const balaRoot = {
                type: 'employee',
                employee: { 'Employee Name': 'Balakumaran', 'Employee Code': 'BALA001', Designation: 'CEO' },
                reports: allRoots,
                reportCount: allRoots.length,
              };
              return <OrgNode node={balaRoot} depth={0} gid="__bala__" expandedOrgNodeIds={expandedOrgNodeIds} toggleNode={toggleNode} searchActive={!!q} />;
            })()}
          </div>
        </div>
      )}

      {/* ── BY-GROUP VIEW ─────────────────────────── */}
      {!allEmpty && orgViewMode === 'by-group' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {populatedGroups.map((group) => {
            const isExp = expandedGroupIds.includes(group.id);
            const filtered = q ? group.rootNodes.map((n) => orgFilterNode(n, q)).filter(Boolean) : group.rootNodes;
            const groupRoots = filtered.length > 0 ? filtered : (q ? [] : group.members.map((m) => ({ type: 'employee', employee: m, reports: [], reportCount: 0 })));
            const balaForGroup = {
              type: 'employee',
              employee: { 'Employee Name': 'Balakumaran', 'Employee Code': 'BALA001', Designation: 'CEO' },
              reports: groupRoots,
              reportCount: groupRoots.length,
            };
            return (
              <div key={group.id} style={{ borderRadius: 12, border: `1.5px solid ${group.pal.border}`, background: 'rgba(255,255,255,.8)', backdropFilter: 'blur(4px)' }}>
                <button type="button" onClick={() => toggleGroup(group.id)}
                  style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 10, padding: '12px 14px', background: 'none', border: 'none', cursor: 'pointer', textAlign: 'left', fontFamily: 'inherit' }}>
                  <span style={{ width: 10, height: 10, borderRadius: '50%', background: group.pal.dot, flexShrink: 0 }} />
                  <span style={{ fontSize: 13.5, fontWeight: 700, color: '#0F172A', flex: 1 }}>{group.name}</span>
                  <span style={{ fontSize: 12, fontWeight: 700, color: group.pal.text, background: group.pal.bg, border: `1px solid ${group.pal.border}`, borderRadius: 999, padding: '3px 10px' }}>{group.members.length}</span>
                  <span style={{ color: '#94A3B8', fontSize: 12, transform: isExp ? 'rotate(180deg)' : 'none', transition: 'transform 240ms ease' }}>&#9662;</span>
                </button>
                <div style={{ display: 'grid', gridTemplateRows: isExp ? '1fr' : '0fr', transition: 'grid-template-rows 900ms cubic-bezier(0.22,1,0.36,1),opacity 600ms ease', opacity: isExp ? 1 : 0 }}>
                  <div style={{ overflow: 'hidden', minWidth: 0 }}>
                    <div style={{ overflow: 'auto', padding: '4px 18px 24px', scrollBehavior: 'smooth' }}>
                      <div style={{ zoom: orgZoom, display: 'flex', justifyContent: 'center', width: 'max-content', minWidth: '100%', padding: '8px 0' }}>
                        {q && filtered.length === 0
                          ? <div style={{ fontSize: 12, color: '#94A3B8', padding: '8px 0' }}>No matches in this group.</div>
                          : <OrgNode node={balaForGroup} depth={0} gid={`${group.id}__bala`} expandedOrgNodeIds={expandedOrgNodeIds} toggleNode={toggleNode} searchActive={!!q} />}
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      </div>
    </div>
  );

  return isFullscreen ? (
    <div style={{ position: 'fixed', inset: 0, zIndex: 9999, background: '#F8FAFC', overflowY: 'auto', animation: 'orgFsIn 250ms ease' }}>
      <style>{`@keyframes orgFsIn{from{opacity:0;transform:scale(0.97)}to{opacity:1;transform:scale(1)}}`}</style>
      {orgContent(true)}
    </div>
  ) : orgContent(false);
}
