import { isNonArrayObject, hasExactOwnKeys } from '@stark-ballot/validation/unknown-value-guards';

export function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isNonArrayObject(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

export function requireExactKeys(record: Record<string, unknown>, keys: readonly string[], label: string): void {
  const expected = [...keys].sort();
  if (!hasExactOwnKeys(record, expected)) {
    throw new Error(`${label} must contain exactly: ${expected.join(', ')}`);
  }
}

export function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} must be a nonempty string`);
  }
  return value;
}

export function requireArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array`);
  }
  return value;
}
