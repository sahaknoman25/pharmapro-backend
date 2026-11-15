// Small validation + serialisation helpers. All amounts are integer minor
// units; all dates are ISO strings (YYYY-MM-DD for date columns).
import { ApiError } from './errors';

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function reqStr(body: Record<string, unknown>, field: string): string {
  const v = body[field];
  if (typeof v !== 'string' || v.trim() === '') {
    throw new ApiError(`${field} is required`, 400);
  }
  return v.trim();
}

export function optStr(body: Record<string, unknown>, field: string, fallback = ''): string {
  const v = body[field];
  if (v === undefined || v === null) return fallback;
  if (typeof v !== 'string') throw new ApiError(`${field} must be a string`, 400);
  return v.trim();
}

export function optStrNull(body: Record<string, unknown>, field: string): string | null {
  const v = body[field];
  if (v === undefined || v === null || v === '') return null;
  if (typeof v !== 'string') throw new ApiError(`${field} must be a string`, 400);
  return v.trim();
}

export function reqInt(body: Record<string, unknown>, field: string): number {
  const v = body[field];
  if (typeof v !== 'number' || !Number.isInteger(v)) {
    throw new ApiError(`${field} must be an integer`, 400);
  }
  return v;
}

export function optInt(body: Record<string, unknown>, field: string, fallback: number): number {
  const v = body[field];
  if (v === undefined || v === null) return fallback;
  if (typeof v !== 'number' || !Number.isInteger(v)) {
    throw new ApiError(`${field} must be an integer`, 400);
  }
  return v;
}

export function optIntNull(body: Record<string, unknown>, field: string): number | null {
  const v = body[field];
  if (v === undefined || v === null) return null;
  if (typeof v !== 'number' || !Number.isInteger(v)) {
    throw new ApiError(`${field} must be an integer`, 400);
  }
  return v;
}

export function reqNum(body: Record<string, unknown>, field: string): number {
  const v = body[field];
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new ApiError(`${field} must be a number`, 400);
  }
  return v;
}

export function optNum(body: Record<string, unknown>, field: string, fallback: number): number {
  const v = body[field];
  if (v === undefined || v === null) return fallback;
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new ApiError(`${field} must be a number`, 400);
  }
  return v;
}

export function reqBool(body: Record<string, unknown>, field: string): boolean {
  const v = body[field];
  if (typeof v !== 'boolean') throw new ApiError(`${field} must be a boolean`, 400);
  return v;
}

export function optBool(body: Record<string, unknown>, field: string, fallback: boolean): boolean {
  const v = body[field];
  if (v === undefined || v === null) return fallback;
  if (typeof v !== 'boolean') throw new ApiError(`${field} must be a boolean`, 400);
  return v;
}

export function reqDate(body: Record<string, unknown>, field: string): string {
  const v = body[field];
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(v))) {
    throw new ApiError(`${field} must be a date (YYYY-MM-DD)`, 400);
  }
  return v;
}

export function optDate(body: Record<string, unknown>, field: string): string | null {
  const v = body[field];
  if (v === undefined || v === null || v === '') return null;
  return reqDate(body, field);
}

export function reqArray<T>(body: Record<string, unknown>, field: string): T[] {
  const v = body[field];
  if (!Array.isArray(v) || v.length === 0) {
    throw new ApiError(`${field} must be a non-empty array`, 400);
  }
  return v as T[];
}

/** pg returns DATE columns as Date (midnight UTC) — serialise as YYYY-MM-DD. */
export function fmtDate(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'string') return v.slice(0, 10);
  return null;
}

/** pg returns timestamptz as Date — serialise as full ISO string. */
export function fmtTs(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'string') return v;
  return null;
}

export function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

export function addDaysStr(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
