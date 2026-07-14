// Browser wiring: attach the current Supabase session token to the pure postAction core.
import { supabase } from './supabaseClient';
import { supabaseEnv } from './config';
import { postAction, PmsError } from './pmsClientCore';

export { PmsError };

async function currentToken() {
  if (!supabase) return null;
  const { data } = await supabase.auth.getSession();
  return data?.session?.access_token || null;
}

export async function callPms(action, payload = {}) {
  const token = await currentToken();
  return postAction({ baseUrl: supabaseEnv.url, fnName: 'pms-admin', action, payload, token });
}

export async function callWorkflow(action, payload = {}) {
  const token = await currentToken();
  return postAction({ baseUrl: supabaseEnv.url, fnName: 'pms-workflow', action, payload, token });
}
