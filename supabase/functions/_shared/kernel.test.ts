import { assertEquals, assertThrows } from 'jsr:@std/assert@1';
import { ApiError, parseActionBody, toResponse } from './kernel.ts';

Deno.test('parseActionBody accepts a valid action and defaults payload', () => {
  const parsed = parseActionBody({ action: 'admin.whoami' });
  assertEquals(parsed.action, 'admin.whoami');
  assertEquals(parsed.payload, {});
});

Deno.test('parseActionBody rejects a missing action', () => {
  assertThrows(() => parseActionBody({}), ApiError);
});

Deno.test('parseActionBody rejects a non-namespaced action', () => {
  assertThrows(() => parseActionBody({ action: 'whoami' }), ApiError);
});

Deno.test('parseActionBody rejects an array payload', () => {
  assertThrows(() => parseActionBody({ action: 'a.b', payload: [] }), ApiError);
});

Deno.test('toResponse wraps success and error shapes', async () => {
  const okRes = toResponse({ ok: true, data: { x: 1 } });
  assertEquals(okRes.status, 200);
  assertEquals(await okRes.json(), { ok: true, data: { x: 1 } });
  const errRes = toResponse({ ok: false, error: { code: 'CONFLICT', message: 'someone else changed this — reload' } }, 409);
  assertEquals(errRes.status, 409);
  const body = await errRes.json();
  assertEquals(body.error.code, 'CONFLICT');
});
