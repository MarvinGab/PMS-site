// Minimal .env loader so verify scripts run on any Node ≥18 (no --env-file needed).
import { readFileSync } from 'node:fs';

export function loadEnv(path = '.env') {
  let text = '';
  try { text = readFileSync(path, 'utf8'); } catch { return; }
  for (const line of text.split('\n')) {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].trim();
  }
}
