import { isNonNullObject } from '@stark-ballot/validation/unknown-value-guards';

/** Stable JSON key ordering without invoking the legacy __proto__ setter. */
export function normalizeJsonKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeJsonKeys);
  if (isNonNullObject(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, normalizeJsonKeys(value[key])]),
    );
  }
  return value;
}
