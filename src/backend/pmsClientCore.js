// Pure request/error core for the pms backend. No browser/env imports — unit-testable.
export class PmsError extends Error {
  constructor(code, message, status) {
    super(message || code);
    this.name = 'PmsError';
    this.code = code || 'ERROR';
    this.status = status || 0;
  }
}

const DEFAULT_TIMEOUT_MS = 12000;

// POST {action, payload} to ${baseUrl}/functions/v1/${fnName} with a bearer token.
// Resolve to `data` on {ok:true}; throw PmsError otherwise. fetchImpl defaults to global fetch.
export async function postAction({ baseUrl, fnName, action, payload = {}, token, fetchImpl, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  if (!token) throw new PmsError('NO_SESSION', 'You are signed out. Please sign in again.', 401);
  const doFetch = fetchImpl || fetch;
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timeout = controller && timeoutMs > 0
    ? setTimeout(() => controller.abort(), timeoutMs)
    : null;
  let res;
  try {
    res = await doFetch(`${baseUrl}/functions/v1/${fnName}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, payload }),
      ...(controller ? { signal: controller.signal } : {}),
    });
  } catch (e) {
    if (e?.name === 'AbortError') {
      throw new PmsError('TIMEOUT', 'Request timed out. Please retry.', 0);
    }
    throw new PmsError('NETWORK', e?.message || 'Network error', 0);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
  let body = null;
  try { body = await res.json(); } catch { /* non-JSON */ }
  if (body && body.ok === true) return body.data;
  if (body && body.ok === false && body.error) throw new PmsError(body.error.code || 'ERROR', body.error.message || 'Request failed', res.status);
  throw new PmsError('DB_ERROR', `Request failed (HTTP ${res.status})`, res.status);
}
