// Run: node supabase/verify/run-all.mjs
// Foundation gate: schema present, seed fresh, RLS holds, kernel live.
import { spawnSync } from 'node:child_process';

const scripts = [
  'supabase/verify/check-tables.mjs',
  'supabase/verify/seed-foundation.mjs',
  'supabase/verify/rls-check.mjs',
  'supabase/verify/kernel-check.mjs',
];

for (const script of scripts) {
  console.log(`\n=== ${script} ===`);
  const res = spawnSync(process.execPath, [script], { stdio: 'inherit' });
  if (res.status !== 0) {
    console.error(`\nFOUNDATION SMOKE: FAILED at ${script}`);
    process.exit(res.status ?? 1);
  }
}
console.log('\nFOUNDATION SMOKE: ALL PASS');
