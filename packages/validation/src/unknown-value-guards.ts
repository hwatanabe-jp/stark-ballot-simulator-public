/**
 * Runtime type guards for unknown values.
 */

function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

/**
 * Check whether a value is a number array.
 */
export function isNumberArray(value: unknown): value is number[] {
  return Array.isArray(value) && value.every(isNumber);
}

function isBooleanArray(value: unknown): value is boolean[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'boolean');
}

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

/**
 * Check whether a value is a non-null object, including arrays.
 *
 * Arrays intentionally satisfy this guard to preserve the existing runtime
 * contract.
 */
export function isNonNullObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Safely read a string property from an unknown object.
 */
export function getStringProperty(value: unknown, key: string): string | undefined {
  if (!isNonNullObject(value)) {
    return undefined;
  }
  const candidate = value[key];
  return typeof candidate === 'string' ? candidate : undefined;
}

/**
 * Safely read a number property from an unknown object.
 */
export function getNumberProperty(value: unknown, key: string): number | undefined {
  if (!isNonNullObject(value)) {
    return undefined;
  }
  const candidate = value[key];
  return isNumber(candidate) ? candidate : undefined;
}

/**
 * Safely read a non-null object property, including arrays, from an unknown object.
 */
export function getObjectProperty(value: unknown, key: string): Record<string, unknown> | undefined {
  if (!isNonNullObject(value)) {
    return undefined;
  }
  const candidate = value[key];
  return isNonNullObject(candidate) ? candidate : undefined;
}

/**
 * Safely read an array property from an unknown object.
 */
export function getArrayProperty(value: unknown, key: string): unknown[] | undefined {
  if (!isNonNullObject(value)) {
    return undefined;
  }
  const candidate = value[key];
  return isUnknownArray(candidate) ? candidate : undefined;
}

/**
 * Safely read a string array property from an unknown object.
 */
export function getStringArrayProperty(value: unknown, key: string): string[] | undefined {
  if (!isNonNullObject(value)) {
    return undefined;
  }
  const candidate = value[key];
  return isStringArray(candidate) ? candidate : undefined;
}

/**
 * Safely read a number array property from an unknown object.
 */
export function getNumberArrayProperty(value: unknown, key: string): number[] | undefined {
  if (!isNonNullObject(value)) {
    return undefined;
  }
  const candidate = value[key];
  return isNumberArray(candidate) ? candidate : undefined;
}

/**
 * Safely read a boolean array property from an unknown object.
 */
export function getBooleanArrayProperty(value: unknown, key: string): boolean[] | undefined {
  if (!isNonNullObject(value)) {
    return undefined;
  }
  const candidate = value[key];
  return isBooleanArray(candidate) ? candidate : undefined;
}

/**
 * Assert that a value is a non-null object, including arrays.
 */
export function requireNonNullObject(value: unknown, label = 'value'): Record<string, unknown> {
  if (!isNonNullObject(value)) {
    throw new Error(`Expected ${label} to be a record`);
  }
  return value;
}

/** Check for an object while excluding null and arrays; prototypes are unrestricted. */
export function isNonArrayObject(value: unknown): value is Record<string, unknown> {
  return isNonNullObject(value) && !Array.isArray(value);
}

/** Compare the complete set of own enumerable string keys. */
export function hasExactOwnKeys(value: object, expected: ReadonlySet<string> | readonly string[]): boolean {
  const keys = Object.keys(value);
  if ('size' in expected) return keys.length === expected.size && keys.every((key) => expected.has(key));
  return keys.length === expected.length && keys.every((key) => expected.includes(key));
}

export function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export function isPositiveSafeInteger(value: unknown): value is number {
  return isNonNegativeSafeInteger(value) && value > 0;
}

/** Admit optional fields without requiring every allowed field to be present. */
export function hasOnlyAllowedKeys(value: object, allowedKeys: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowedKeys.has(key));
}

/** Integer admission for contracts that do not impose the safe-integer bound. */
export function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}
