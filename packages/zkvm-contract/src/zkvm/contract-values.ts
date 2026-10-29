import { isRecord } from './guards';

/** Descriptor records exclude arrays; bitmap envelope admission keeps its separate array-compatible guard. */
export function requireContractRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value) || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value;
}

export function requireExactContractKeys(
  record: Record<string, unknown>,
  keys: readonly string[],
  label: string,
  contract: string,
): void {
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${label} must contain the exact keys for the ${contract}`);
  }
}

export function requireContractString(record: Record<string, unknown>, key: string, label: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${label}.${key} must be a non-empty string`);
  return value;
}

/** Canonical descriptor JSON sorts object keys and admits only safe integer numbers. */
export function canonicalContractJson(value: unknown, label: string): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new Error(`${label} canonical JSON admits only safe integers`);
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalContractJson(entry, label)).join(',')}]`;
  const record = requireContractRecord(value, `${label} canonical value`);
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalContractJson(record[key], label)}`)
    .join(',')}}`;
}
