import { createClient, SupabaseClient } from 'npm:@supabase/supabase-js@2';
import { emailHandlers } from './emails.ts';

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, content-type' };

export type JobsCtx = { admin: SupabaseClient<any, any, any>; url: string; serviceKey: string };
export type JobsHandler = (payload: Record<string, unknown>, ctx: JobsCtx) => Promise<unknown>;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
}

// The gateway (verify_jwt=true) validates the JWT signature, so the decoded role claim is
// trustworthy. Only a service_role token (the cron / internal workers) may drive the queue —
// a valid anon or authenticated-user token is rejected here even though the gateway lets it through.
function callerIsServiceRole(req: Request): boolean {
  const bearer = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
  const parts = bearer.split('.');
  if (parts.length !== 3) return false;
  try {
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const pad = b64.length % 4 ? '='.repeat(4 - (b64.length % 4)) : '';
    const payload = JSON.parse(atob(b64 + pad)) as { role?: string };
    return payload.role === 'service_role';
  } catch {
    return false;
  }
}

const handlers: Record<string, JobsHandler> = { ...emailHandlers };

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (!callerIsServiceRole(req)) {
    return json({ ok: false, error: { code: 'UNAUTHORIZED', message: 'Worker requires a service role token' } }, 401);
  }
  const url = Deno.env.get('SUPABASE_URL') ?? '';
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ ok: false, error: { code: 'BAD_REQUEST', message: 'Invalid JSON' } }, 400); }
  const action = String(body.action ?? '');
  const handler = handlers[action];
  if (!handler) return json({ ok: false, error: { code: 'UNKNOWN_ACTION', message: action } }, 404);
  const admin = createClient(url, serviceKey, { auth: { persistSession: false }, db: { schema: 'pms' } });
  try {
    const data = await handler(body, { admin, url, serviceKey });
    return json({ ok: true, data });
  } catch (e) {
    const code = (e as { code?: string }).code ?? 'DB_ERROR';
    const status = (e as { status?: number }).status ?? 500;
    if (status >= 500) console.error('pms-jobs handler error', action, e);
    return json({ ok: false, error: { code, message: (e as Error).message ?? 'Error' } }, status);
  }
});
