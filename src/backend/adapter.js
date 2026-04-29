import { backendMode, shouldUseSupabase, getBackendDiagnostics } from './config';
import { supabase } from './supabaseClient';

export function getBackendAdapter() {
  return {
    kind: shouldUseSupabase ? 'supabase' : 'local',
    mode: backendMode,
    diagnostics: getBackendDiagnostics(),
    clients: {
      supabase,
    },
    capabilities: {
      auth: shouldUseSupabase ? 'supabase' : 'local-storage',
      persistence: shouldUseSupabase ? 'supabase' : 'browser-storage',
      messaging: shouldUseSupabase ? 'supabase' : 'browser-storage',
      workflow: shouldUseSupabase ? 'supabase' : 'browser-storage',
      brandingAssets: shouldUseSupabase ? 'supabase-storage' : 'browser-storage',
    },
  };
}
