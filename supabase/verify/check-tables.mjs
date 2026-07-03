// Run: node supabase/verify/check-tables.mjs
// Asserts every expected pms.* table is reachable via the service role.
import assert from 'node:assert/strict';
import { adminClient } from './_clients.mjs';

export const EXPECTED_TABLES = [
  // Task 1: core org
  'organizations', 'organization_branding', 'org_members', 'employees',
  'reporting_relationships', 'org_grades', 'competency_library',
  'goal_libraries', 'goal_library_items', 'prefill_datasets', 'prefill_dataset_items',
];

const admin = adminClient();
let failed = 0;
for (const table of EXPECTED_TABLES) {
  // select('*') not 'id': organization_branding's PK is organization_id (no id column).
  const { error } = await admin.from(table).select('*', { count: 'exact', head: true });
  if (error) { failed += 1; console.error(`MISSING pms.${table}: ${error.message}`); }
  else console.log(`ok pms.${table}`);
}
assert.equal(failed, 0, `${failed} table(s) missing`);
console.log('check-tables: PASS');
