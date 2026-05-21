// Resolve the goal library assigned to an employee, based on the org's
// `goalGroups` + `goalLibraries` config. Extracted from EmployeePage so HR-side
// auto-apply and other surfaces can share the same logic.
//
// Returns { group, library } | null

export function resolveEmployeeLibrary(config, employee) {
  const groups = config?.goalGroups;
  const libraries = config?.goalLibraries;
  if (!Array.isArray(groups) || !Array.isArray(libraries) || !employee) return null;

  function pickLibraryForGroup(group) {
    if (!group.hasLibrary) return null;
    const attrVal = group.segmentAttr ? String(employee[group.segmentAttr] || '').trim() : '';
    const libId = (group.libraryAssignments || []).find(
      (a) => String(a.slotKey || '').trim().toLowerCase() === attrVal.toLowerCase()
    )?.libraryId || group.libraryId;
    if (!libId) return null;
    return libraries.find((l) => l.id === libId) || null;
  }

  // Prefer explicit Group Name written into the employee record during upload.
  const groupNameVal = String(employee.assignedGoalGroupName || employee['Group Name'] || '').trim();
  if (groupNameVal) {
    const namedGroup = groups.find(
      (g) => String(g.name || '').trim().toLowerCase() === groupNameVal.toLowerCase()
    );
    if (namedGroup) {
      const library = pickLibraryForGroup(namedGroup);
      if (library) return { group: namedGroup, library };
    }
  }

  // Fall back to attribute-based matching.
  for (const group of groups) {
    if (!group.hasLibrary) continue;
    const attrVal = String(employee[group.segmentAttr] || '').trim();
    if (!attrVal) continue;
    const inGroup = (group.segmentValues || []).some(
      (v) => String(v?.name || v || '').trim().toLowerCase() === attrVal.toLowerCase()
    );
    if (!inGroup) continue;
    const library = pickLibraryForGroup(group);
    if (library) return { group, library };
  }
  return null;
}

// Flatten a library into a [{ kra, kpis }] shape with weights resolved.
export function flattenLibraryKras(library) {
  return (library?.perspectives || []).flatMap((persp) =>
    (persp.kras || []).map((kra) => ({
      ...kra,
      perspName: kra.perspName || persp.name,
      weight: Number(kra.suggestedWeight ?? kra.weight ?? 0) || 0,
      kpis: (kra.kpis || []).map((kpi) => ({
        ...kpi,
        weight: Number(kpi.suggestedWeight ?? kpi.weight ?? 0) || 0,
      })),
    }))
  );
}

// Summarize a library's totals so the UI can decide whether auto-apply is safe.
// Returns { totalKraWeight, kraCount, kpiCount, ready, reason }.
//   ready === true   → library sums to exactly 100% (or close — within 0.5pt)
//   ready === false  → reason gives a one-line human explanation
export function summarizeLibrary(library) {
  if (!library) {
    return { totalKraWeight: 0, kraCount: 0, kpiCount: 0, ready: false, reason: 'No library assigned to this employee.' };
  }
  const kras = flattenLibraryKras(library);
  const total = kras.reduce((sum, kra) => sum + (Number(kra.weight) || 0), 0);
  const kpiCount = kras.reduce((sum, kra) => sum + (kra.kpis || []).length, 0);
  if (kras.length === 0) {
    return { totalKraWeight: 0, kraCount: 0, kpiCount: 0, ready: false, reason: 'Library has no KRAs configured.' };
  }
  const rounded = Math.round(total * 10) / 10;
  if (Math.abs(total - 100) <= 0.5) {
    return { totalKraWeight: 100, kraCount: kras.length, kpiCount, ready: true, reason: '' };
  }
  return {
    totalKraWeight: rounded,
    kraCount: kras.length,
    kpiCount,
    ready: false,
    reason: total < 100
      ? `Library weights total ${rounded}% — must be 100% to auto-apply.`
      : `Library weights total ${rounded}% — exceeds 100%, can't auto-apply.`,
  };
}

// Build a submission payload from a library — used by HR "Apply default goals"
// to materialize a library's KRAs as approved goals on an employee. Mirrors the
// shape EmployeePage already writes for normal submissions.
export function buildLibraryGoalPlan(library) {
  const summary = summarizeLibrary(library);
  if (!summary.ready) return { ok: false, reason: summary.reason, goals: [] };

  const kras = flattenLibraryKras(library);
  const goals = kras.map((kra, i) => ({
    id: `goal_lib_${kra.id || i}_${Date.now()}`,
    libraryKraId: kra.id || null,
    name: String(kra.name || '').trim() || `KRA ${i + 1}`,
    weight: kra.weight,
    perspName: kra.perspName || '',
    kpis: (kra.kpis || []).map((kpi, j) => ({
      id: kpi.id || `kpi_lib_${kra.id || i}_${j}_${Date.now()}`,
      libraryKpiId: kpi.id || null,
      name: String(kpi.name || '').trim() || `KPI ${j + 1}`,
      weight: kpi.weight || '',
      target: kpi.target || '',
      source: 'library-default',
    })),
    source: 'library-default',
  }));

  return { ok: true, goals, summary };
}
