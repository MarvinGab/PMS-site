// Shared kernel for all pms-* edge functions.
// Contract: POST { action: 'domain.action', payload: {} } with the user's JWT.
// Every handler: validate → permission check → transactional write → audit → { ok, data }.
import { createClient, SupabaseClient } from 'npm:@supabase/supabase-js@2';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

export class ApiError extends Error {
  constructor(public code: string, message: string, public status = 400) {
    super(message);
  }
}

export type Membership = {
  memberId: string;
  organizationId: string | null;
  roles: string[];
  employeeId: string | null;
};

export type AuditEntry = {
  organizationId: string;
  cycleId?: string | null;
  action: string;
  entityType?: string;
  entityId?: string | null;
  before?: unknown;
  after?: unknown;
  note?: string;
};

export type HandlerCtx = {
  admin: SupabaseClient<any, any, any>;
  userId: string;
  memberships: Membership[];
  requireOrgRole(orgId: string, roles: string[]): Membership;
  audit(entry: AuditEntry): Promise<void>;
  versionedUpdate(
    table: string,
    id: string,
    expectedVersion: number,
    patch: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;
};

export type Handler = (payload: Record<string, unknown>, ctx: HandlerCtx) => Promise<unknown>;

export function parseActionBody(body: unknown): { action: string; payload: Record<string, unknown> } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new ApiError('BAD_REQUEST', 'Request body must be a JSON object', 400);
  }
  const { action, payload } = body as Record<string, unknown>;
  if (typeof action !== 'string' || !action.includes('.')) {
    throw new ApiError('BAD_REQUEST', 'Missing or invalid "action" (expected "domain.action")', 400);
  }
  if (payload !== undefined && (payload === null || typeof payload !== 'object' || Array.isArray(payload))) {
    throw new ApiError('BAD_REQUEST', '"payload" must be an object when provided', 400);
  }
  return { action, payload: (payload ?? {}) as Record<string, unknown> };
}

export function toResponse(
  result: { ok: true; data: unknown } | { ok: false; error: { code: string; message: string } },
  status = 200,
): Response {
  return new Response(JSON.stringify(result), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

async function buildCtx(req: Request): Promise<HandlerCtx> {
  const url = Deno.env.get('SUPABASE_URL')!;
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!;
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

  const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
  if (!token) throw new ApiError('AUTH_REQUIRED', 'Sign in required', 401);

  const authClient = createClient(url, anonKey, { auth: { persistSession: false } });
  const { data: userData, error: userErr } = await authClient.auth.getUser(token);
  if (userErr || !userData?.user) throw new ApiError('AUTH_REQUIRED', 'Sign in required', 401);
  const userId = userData.user.id;

  const admin = createClient(url, serviceKey, {
    db: { schema: 'pms' },
    auth: { persistSession: false },
  });

  const { data: memberRows, error: memberErr } = await admin
    .from('org_members')
    .select('id, organization_id, roles, status')
    .eq('user_id', userId)
    .eq('status', 'active');
  if (memberErr) throw new ApiError('DB_ERROR', memberErr.message, 500);

  const { data: empRows, error: empErr } = await admin
    .from('employees')
    .select('id, organization_id')
    .eq('user_id', userId);
  if (empErr) throw new ApiError('DB_ERROR', empErr.message, 500);

  const memberships: Membership[] = (memberRows ?? []).map((m) => ({
    memberId: m.id,
    organizationId: m.organization_id,
    roles: m.roles ?? [],
    employeeId: (empRows ?? []).find((e) => e.organization_id === m.organization_id)?.id ?? null,
  }));
  if (memberships.length === 0) {
    throw new ApiError('NO_MEMBERSHIP', 'This account has no organization access', 403);
  }

  const isSuperAdmin = memberships.some(
    (m) => m.organizationId === null && m.roles.includes('super_admin'),
  );

  const ctx: HandlerCtx = {
    admin,
    userId,
    memberships,
    requireOrgRole(orgId, roles) {
      const membership = memberships.find((m) => m.organizationId === orgId);
      if (membership && roles.some((r) => membership.roles.includes(r))) return membership;
      if (isSuperAdmin) {
        return { memberId: '', organizationId: orgId, roles: ['super_admin'], employeeId: null };
      }
      throw new ApiError('FORBIDDEN', 'You do not have permission for this action', 403);
    },
    async audit(entry) {
      const { error } = await admin.from('audit_logs').insert({
        organization_id: entry.organizationId,
        cycle_id: entry.cycleId ?? null,
        actor_user_id: userId,
        actor_role: memberships.find((m) => m.organizationId === entry.organizationId)?.roles.join(',') ??
          (isSuperAdmin ? 'super_admin' : null),
        action: entry.action,
        entity_type: entry.entityType ?? null,
        entity_id: entry.entityId ?? null,
        before: entry.before ?? null,
        after: entry.after ?? null,
        note: entry.note ?? null,
      });
      if (error) throw new ApiError('DB_ERROR', `audit failed: ${error.message}`, 500);
    },
    async versionedUpdate(table, id, expectedVersion, patch) {
      const { data, error } = await admin
        .from(table)
        .update(patch)
        .eq('id', id)
        .eq('version', expectedVersion)
        .select()
        .maybeSingle();
      if (error) throw new ApiError('DB_ERROR', error.message, 500);
      if (data) return data;
      const { data: row } = await admin.from(table).select('id').eq('id', id).maybeSingle();
      if (!row) throw new ApiError('NOT_FOUND', `${table} row not found`, 404);
      throw new ApiError('CONFLICT', 'someone else changed this — reload', 409);
    },
  };
  return ctx;
}

export function serveActions(handlers: Record<string, Handler>): void {
  Deno.serve(async (req) => {
    if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
    try {
      if (req.method !== 'POST') throw new ApiError('BAD_REQUEST', 'POST only', 405);
      let body: unknown;
      try {
        body = await req.json();
      } catch {
        throw new ApiError('BAD_REQUEST', 'Body must be valid JSON', 400);
      }
      const { action, payload } = parseActionBody(body);
      const handler = handlers[action];
      if (!handler) throw new ApiError('UNKNOWN_ACTION', `Unknown action "${action}"`, 404);
      const ctx = await buildCtx(req);
      const data = await handler(payload, ctx);
      return toResponse({ ok: true, data });
    } catch (err) {
      if (err instanceof ApiError) {
        return toResponse({ ok: false, error: { code: err.code, message: err.message } }, err.status);
      }
      console.error('unhandled', err);
      return toResponse(
        { ok: false, error: { code: 'INTERNAL', message: 'Something went wrong' } },
        500,
      );
    }
  });
}
