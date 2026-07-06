// Input validators for edge handlers. Every failure is a client-facing
// ApiError('BAD_REQUEST', ...) that names the offending field.
import { ApiError } from './kernel.ts';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function bad(name: string, want: string): never {
  throw new ApiError('BAD_REQUEST', `${name} must be ${want}`, 400);
}

export function reqString(v: unknown, name: string, maxLen = 500): string {
  if (typeof v !== 'string' || v.trim() === '' || v.length > maxLen) {
    bad(name, `a non-empty string (max ${maxLen} chars)`);
  }
  return (v as string).trim();
}

export function optString(v: unknown, name: string, maxLen = 2000): string | null {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v !== 'string' || v.length > maxLen) bad(name, `a string (max ${maxLen} chars)`);
  return v as string;
}

export function reqUuid(v: unknown, name: string): string {
  if (typeof v !== 'string' || !UUID_RE.test(v)) bad(name, 'a UUID');
  return (v as string).toLowerCase();
}

export function optUuid(v: unknown, name: string): string | null {
  if (v === undefined || v === null || v === '') return null;
  return reqUuid(v, name);
}

export function reqInt(v: unknown, name: string): number {
  if (typeof v !== 'number' || !Number.isInteger(v)) bad(name, 'an integer');
  return v as number;
}

export function optInt(v: unknown, name: string): number | null {
  if (v === undefined || v === null || v === '') return null;
  return reqInt(v, name);
}

export function reqNumber(v: unknown, name: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) bad(name, 'a number');
  return v as number;
}

export function optNumber(v: unknown, name: string): number | null {
  if (v === undefined || v === null || v === '') return null;
  return reqNumber(v, name);
}

export function optBool(v: unknown, name: string, dflt = false): boolean {
  if (v === undefined || v === null) return dflt;
  if (typeof v !== 'boolean') bad(name, 'true or false');
  return v as boolean;
}

export function reqEnum(v: unknown, name: string, allowed: string[]): string {
  if (typeof v !== 'string' || !allowed.includes(v)) bad(name, `one of: ${allowed.join(', ')}`);
  return v as string;
}

export function optEnum(v: unknown, name: string, allowed: string[]): string | null {
  if (v === undefined || v === null || v === '') return null;
  return reqEnum(v, name, allowed);
}

export function reqArray(v: unknown, name: string, maxItems = 500): unknown[] {
  if (!Array.isArray(v) || v.length > maxItems) bad(name, `an array (max ${maxItems} items)`);
  return v as unknown[];
}

export function reqObject(v: unknown, name: string): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) bad(name, 'an object');
  return v as Record<string, unknown>;
}

export function reqIsoDate(v: unknown, name: string): string {
  if (typeof v !== 'string' || !ISO_DATE_RE.test(v) || Number.isNaN(Date.parse(v))) {
    bad(name, 'a date like 2026-04-01');
  }
  return v as string;
}
