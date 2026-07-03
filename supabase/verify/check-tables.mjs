// Run: node supabase/verify/check-tables.mjs
// Asserts every expected pms.* table is reachable via the service role.
import assert from 'node:assert/strict';
import { adminClient } from './_clients.mjs';

export const EXPECTED_TABLES = [
  // Task 1: core org
  'organizations', 'organization_branding', 'org_members', 'employees',
  'reporting_relationships', 'org_grades', 'competency_library',
  'goal_libraries', 'goal_library_items', 'prefill_datasets', 'prefill_dataset_items',
  // Task 2: cycles
  'appraisal_cycles', 'cycle_phase_windows', 'cycle_config_snapshots', 'cycle_config_versions',
  'cycle_perspectives', 'cycle_groups', 'cycle_group_segment_values', 'cycle_group_library_assignments',
  'cycle_target_types', 'cycle_rating_scale_levels', 'cycle_auto_rating_bands', 'cycle_goal_rules',
  'cycle_competency_config', 'cycle_competency_assignments', 'cycle_bell_curve_bands',
  'cycle_participants', 'cycle_participant_assignments',
  // Task 3: workflow + plumbing
  'employee_goal_plans', 'employee_goal_items', 'employee_goal_plan_competencies',
  'goal_workflow_events', 'evaluations', 'evaluation_goal_scores', 'evaluation_competency_scores',
  'calibrations', 'cycle_publications', 'rating_acknowledgements',
  'notifications', 'email_jobs', 'email_delivery_attempts', 'background_jobs',
  'import_runs', 'import_run_errors', 'audit_logs',
];

const admin = adminClient();
let failed = 0;
for (const table of EXPECTED_TABLES) {
  // limit-0 GET, not head:true: postgrest-js swallows the 404 on HEAD (empty body), so a missing table would report ok.
  const { error } = await admin.from(table).select('*').limit(0);
  if (error) { failed += 1; console.error(`MISSING pms.${table}: ${error.message}`); }
  else console.log(`ok pms.${table}`);
}
assert.equal(failed, 0, `${failed} table(s) missing`);
console.log('check-tables: PASS');
