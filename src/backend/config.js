export const BACKEND_MODES = {
  LOCAL: 'local',
  SUPABASE: 'supabase',
};

const rawMode = String(import.meta.env.VITE_BACKEND_MODE || BACKEND_MODES.LOCAL).trim().toLowerCase();

export const backendMode =
  rawMode === BACKEND_MODES.SUPABASE ? BACKEND_MODES.SUPABASE : BACKEND_MODES.LOCAL;

export const supabaseEnv = {
  url: String(import.meta.env.VITE_SUPABASE_URL || '').trim(),
  anonKey: String(import.meta.env.VITE_SUPABASE_ANON_KEY || '').trim(),
};

export const isSupabaseConfigured = Boolean(supabaseEnv.url && supabaseEnv.anonKey);
export const shouldUseSupabase = backendMode === BACKEND_MODES.SUPABASE && isSupabaseConfigured;

export function getBackendDiagnostics() {
  return {
    backendMode,
    isSupabaseConfigured,
    shouldUseSupabase,
    hasSupabaseUrl: Boolean(supabaseEnv.url),
    hasSupabaseAnonKey: Boolean(supabaseEnv.anonKey),
  };
}
