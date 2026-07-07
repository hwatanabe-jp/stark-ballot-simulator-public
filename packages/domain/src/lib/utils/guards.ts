/**
 * Runtime type guards for unknown values.
 */

/**
 * Check whether a value is a finite number.
 */
function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Check whether a value is a string array.
 */
function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

/**
 * Check whether a value is a number array.
 */
export function isNumberArray(value: unknown): value is number[] {
  return Array.isArray(value) && value.every(isNumber);
}

/**
 * Check whether a value is a boolean array.
 */
function isBooleanArray(value: unknown): value is boolean[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'boolean');
}

/**
 * Check whether a value is an array of unknown values.
 */
function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

/**
 * Check whether a value is a non-null object record.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Safely read a string property from an unknown record.
 */
export function getStringProperty(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const candidate = value[key];
  return typeof candidate === 'string' ? candidate : undefined;
}

/**
 * Safely read a number property from an unknown record.
 */
export function getNumberProperty(value: unknown, key: string): number | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const candidate = value[key];
  return isNumber(candidate) ? candidate : undefined;
}

/**
 * Safely read a record property from an unknown record.
 */
export function getRecordProperty(value: unknown, key: string): Record<string, unknown> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const candidate = value[key];
  return isRecord(candidate) ? candidate : undefined;
}

/**
 * Safely read an array property from an unknown record.
 */
export function getArrayProperty(value: unknown, key: string): unknown[] | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const candidate = value[key];
  return isUnknownArray(candidate) ? candidate : undefined;
}

/**
 * Safely read a string array property from an unknown record.
 */
export function getStringArrayProperty(value: unknown, key: string): string[] | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const candidate = value[key];
  return isStringArray(candidate) ? candidate : undefined;
}

/**
 * Safely read a number array property from an unknown record.
 */
export function getNumberArrayProperty(value: unknown, key: string): number[] | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const candidate = value[key];
  return isNumberArray(candidate) ? candidate : undefined;
}

/**
 * Safely read a boolean array property from an unknown record.
 */
export function getBooleanArrayProperty(value: unknown, key: string): boolean[] | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const candidate = value[key];
  return isBooleanArray(candidate) ? candidate : undefined;
}

/**
 * Assert that a value is a record for use in tests and runtime checks.
 */
export function requireRecord(value: unknown, label = 'value'): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`Expected ${label} to be a record`);
  }
  return value;
}
