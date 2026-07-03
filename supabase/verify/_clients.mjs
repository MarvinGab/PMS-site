import { createClient } from '@supabase/supabase-js';
import { loadEnv } from './_env.mjs';

loadEnv();

export const SUPABASE_URL = process.env.VITE_SUPABASE_URL;
export const ANON_KEY = process.env.VITE_SUPABASE_ANON_KEY;
export const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !ANON_KEY || !SERVICE_KEY) {
  console.error('Missing VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY in .env');
  process.exit(1);
}

const opts = { db: { schema: 'pms' }, auth: { persistSession: false } };

export function adminClient() {
  return createClient(SUPABASE_URL, SERVICE_KEY, opts);
}

export function anonClient() {
  return createClient(SUPABASE_URL, ANON_KEY, opts);
}

// Returns a client whose PostgREST requests carry the signed-in user's JWT.
export async function signIn(email, password) {
  const client = createClient(SUPABASE_URL, ANON_KEY, opts);
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error) throw new Error(`signIn(${email}) failed: ${error.message}`);
  return { client, session: data.session, userId: data.user.id };
}
