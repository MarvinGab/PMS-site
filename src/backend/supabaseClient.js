import { createClient } from '@supabase/supabase-js';
import { shouldUseSupabase, supabaseEnv } from './config';

let client = null;

if (shouldUseSupabase) {
  client = createClient(supabaseEnv.url, supabaseEnv.anonKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
      storageKey: 'zarohr_supabase_auth',
    },
  });
}

export const supabase = client;

export function requireSupabase() {
  if (!supabase) {
    throw new Error('Supabase client is not configured. Set VITE_BACKEND_MODE=supabase with URL and anon key.');
  }
  return supabase;
}
