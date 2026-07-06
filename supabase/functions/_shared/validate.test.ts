import { assertEquals, assertThrows } from 'jsr:@std/assert@1';
import { ApiError } from './kernel.ts';
import {
  optBool, optString, reqArray, reqEnum, reqInt, reqIsoDate, reqNumber,
  reqObject, reqString, reqUuid,
} from './validate.ts';

Deno.test('reqString trims and enforces max length', () => {
  assertEquals(reqString('  hi  ', 'f'), 'hi');
  assertThrows(() => reqString('', 'f'), ApiError);
  assertThrows(() => reqString('abc', 'f', 2), ApiError);
  assertThrows(() => reqString(42, 'f'), ApiError);
});

Deno.test('optString returns null for empty-ish values', () => {
  assertEquals(optString(undefined, 'f'), null);
  assertEquals(optString(null, 'f'), null);
  assertEquals(optString('', 'f'), null);
  assertEquals(optString('x', 'f'), 'x');
});

Deno.test('reqUuid validates and lowercases', () => {
  assertEquals(reqUuid('00000000-0000-0000-0000-0000000000AB', 'f'),
    '00000000-0000-0000-0000-0000000000ab');
  assertThrows(() => reqUuid('not-a-uuid', 'f'), ApiError);
});

Deno.test('reqInt rejects floats and strings', () => {
  assertEquals(reqInt(3, 'f'), 3);
  assertThrows(() => reqInt(3.5, 'f'), ApiError);
  assertThrows(() => reqInt('3', 'f'), ApiError);
});

Deno.test('reqNumber rejects NaN and Infinity', () => {
  assertEquals(reqNumber(2.5, 'f'), 2.5);
  assertThrows(() => reqNumber(Number.NaN, 'f'), ApiError);
  assertThrows(() => reqNumber(Infinity, 'f'), ApiError);
});

Deno.test('optBool defaults and rejects non-booleans', () => {
  assertEquals(optBool(undefined, 'f'), false);
  assertEquals(optBool(undefined, 'f', true), true);
  assertEquals(optBool(true, 'f'), true);
  assertThrows(() => optBool('yes', 'f'), ApiError);
});

Deno.test('reqEnum names the allowed values in its error', () => {
  assertEquals(reqEnum('a', 'f', ['a', 'b']), 'a');
  try { reqEnum('c', 'f', ['a', 'b']); throw new Error('should throw'); }
  catch (e) { assertEquals((e as ApiError).message.includes('a, b'), true); }
});

Deno.test('reqArray enforces max items', () => {
  assertEquals(reqArray([1, 2], 'f').length, 2);
  assertThrows(() => reqArray('x', 'f'), ApiError);
  assertThrows(() => reqArray([1, 2, 3], 'f', 2), ApiError);
});

Deno.test('reqObject rejects arrays and null', () => {
  assertEquals(reqObject({ a: 1 }, 'f').a, 1);
  assertThrows(() => reqObject([], 'f'), ApiError);
  assertThrows(() => reqObject(null, 'f'), ApiError);
});

Deno.test('reqIsoDate wants YYYY-MM-DD', () => {
  assertEquals(reqIsoDate('2026-04-01', 'f'), '2026-04-01');
  assertThrows(() => reqIsoDate('01/04/2026', 'f'), ApiError);
  assertThrows(() => reqIsoDate('2026-13-99', 'f'), ApiError);
});
