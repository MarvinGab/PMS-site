// Pure request/error core for the pms backend. No browser/env imports — unit-testable.
export class PmsError extends Error {
  constructor(code, message, status) {
    super(message || code);
    this.name = 'PmsError';
    this.code = code || 'ERROR';
    this.status = status || 0;
  }
}

// POST {action,...payload} to ${baseUrl}/functions/v1/${fnName} with a bearer token.
// Resolve to `data` on {ok:true}; throw PmsError otherwise. fetchImpl defaults to global fetch.
export async function postAction({ baseUrl, fnName, action, payload = {}, token, fetchImpl }) {
  if (!token) throw new PmsError('NO_SESSION', 'You are signed out. Please sign in again.', 401);
  const doFetch = fetchImpl || fetch;
  let res;
  try {
    res = await doFetch(`${baseUrl}/functions/v1/${fnName}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, ...payload }),
    });
  } catch (e) {
    throw new PmsError('NETWORK', e?.message || 'Network error', 0);
  }
  let body = null;
  try { body = await res.json(); } catch { /* non-JSON */ }
  if (body && body.ok === true) return body.data;
  if (body && body.ok === false && body.error) throw new PmsError(body.error.code || 'ERROR', body.error.message || 'Request failed', res.status);
  throw new PmsError('DB_ERROR', `Request failed (HTTP ${res.status})`, res.status);
}
