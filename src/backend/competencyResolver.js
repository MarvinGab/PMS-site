// Single source of truth for "which competencies apply to this employee?"
// Returns the resolved list AND where it came from, so the rating pages can
// label the section ("via group scope" / "role override") for transparency.
//
// Resolution order (group_role scope): role > group > org.

function cleanCompetencyList(list = []) {
  const seen = new Set();
  const out = [];
  (Array.isArray(list) ? list : []).forEach((item) => {
    const name = String(item || '').trim();
    const key = name.toLowerCase();
    if (!name || seen.has(key)) return;
    seen.add(key);
    out.push(name);
  });
  return out;
}

export function resolveCompetenciesForEmployee(config = {}, employee = {}, submission = null) {
  const enabled = config.competenciesEnabled !== false;
  if (!enabled) {
    return { competencies: [], scope: 'org', source: 'none', sourceLabel: 'Competencies disabled', groupName: '', roleName: '' };
  }
  if (config.employeeCanEditCompetencies === true) {
    const max = Math.max(1, Number(config.maxCompetencies) || 1);
    const employeeList = cleanCompetencyList(submission?.employeeCompetencies).slice(0, max);
    return {
      competencies: employeeList,
      scope: 'employee',
      source: 'employee',
      sourceLabel: 'Employee-selected competencies',
      groupName: String(employee?.['Group Name'] || '').trim(),
      roleName: String(employee?.['Role'] || employee?.['Designation'] || '').trim(),
      kraShare: 100 - Math.max(0, Math.min(100, Number(config.competencyWeight ?? 20))),
      compShare: Math.max(0, Math.min(100, Number(config.competencyWeight ?? 20))),
    };
  }
  const scope = config.competencyScope === 'group' || config.competencyScope === 'group_role'
    ? config.competencyScope
    : 'org';
  const groupName = String(employee?.['Group Name'] || '').trim();
  const roleName = String(employee?.['Role'] || employee?.['Designation'] || '').trim();
  const orgList = Array.isArray(config.selectedCompetencies) ? config.selectedCompetencies : [];

  if (scope === 'org') {
    return {
      competencies: orgList,
      scope, source: 'org',
      sourceLabel: 'Org-wide list',
      groupName, roleName,
    };
  }

  const group = (config.goalGroups || []).find(
    (g) => String(g.name || '').trim().toLowerCase() === groupName.toLowerCase()
  );

  // No matching group on the employee — fall back to org so we never hand
  // back an empty list silently.
  if (!group) {
    return {
      competencies: orgList,
      scope, source: 'org',
      sourceLabel: 'Org-wide list (no group match)',
      groupName, roleName,
    };
  }

  if (scope === 'group_role' && roleName) {
    const roleEntry = ((config.competencyByRole || {})[group.id] || {})[roleName];
    if (roleEntry && Array.isArray(roleEntry.competencies) && roleEntry.competencies.length > 0) {
      return {
        competencies: roleEntry.competencies,
        scope, source: 'role',
        sourceLabel: `Role override for ${roleName} in ${group.name}`,
        groupName, roleName,
        kraShare: roleEntry.kraShare, compShare: roleEntry.compShare,
      };
    }
  }

  const groupEntry = (config.competencyByGroup || {})[group.id];
  if (groupEntry && Array.isArray(groupEntry.competencies) && groupEntry.competencies.length > 0) {
    return {
      competencies: groupEntry.competencies,
      scope, source: 'group',
      sourceLabel: `Per-group list for ${group.name}`,
      groupName, roleName,
      kraShare: groupEntry.kraShare, compShare: groupEntry.compShare,
    };
  }

  return {
    competencies: orgList,
    scope, source: 'org',
    sourceLabel: `Org-wide list (no per-group entry for ${group.name})`,
    groupName, roleName,
  };
}
