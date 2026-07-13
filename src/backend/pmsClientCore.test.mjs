import { test } from 'node:test';
import assert from 'node:assert/strict';
import { postAction, PmsError } from './pmsClientCore.js';

function fakeFetch(status, body) {
  return async () => ({ status, ok: status >= 200 && status < 300, json: async () => body, text: async () => JSON.stringify(body) });
}

test('returns data on ok:true', async () => {
  const data = await postAction({ baseUrl: 'http://x', fnName: 'pms-admin', action: 'a', payload: {}, token: 't', fetchImpl: fakeFetch(200, { ok: true, data: { hi: 1 } }) });
  assert.deepEqual(data, { hi: 1 });
});

test('throws PmsError with code on ok:false', async () => {
  await assert.rejects(
    () => postAction({ baseUrl: 'http://x', fnName: 'pms-admin', action: 'a', payload: {}, token: 't', fetchImpl: fakeFetch(409, { ok: false, error: { code: 'CONFLICT', message: 'stale' } }) }),
    (e) => e instanceof PmsError && e.code === 'CONFLICT' && e.status === 409,
  );
});

test('throws NO_SESSION when token missing', async () => {
  await assert.rejects(
    () => postAction({ baseUrl: 'http://x', fnName: 'pms-admin', action: 'a', payload: {}, token: '', fetchImpl: fakeFetch(200, {}) }),
    (e) => e instanceof PmsError && e.code === 'NO_SESSION' && e.status === 401,
  );
});

test('non-2xx non-JSON throws DB_ERROR-ish PmsError', async () => {
  const badFetch = async () => ({ status: 500, ok: false, json: async () => { throw new Error('no json'); }, text: async () => 'oops' });
  await assert.rejects(
    () => postAction({ baseUrl: 'http://x', fnName: 'pms-admin', action: 'a', payload: {}, token: 't', fetchImpl: badFetch }),
    (e) => e instanceof PmsError && e.status === 500,
  );
});
