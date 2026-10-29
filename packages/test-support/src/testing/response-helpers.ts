import {
  getObjectProperty,
  getStringProperty,
  requireNonNullObject,
} from '@stark-ballot/validation/unknown-value-guards';

export interface JsonResponseLike {
  json(): Promise<unknown>;
}

export async function readJsonRecord(response: JsonResponseLike, label = 'response'): Promise<Record<string, unknown>> {
  const payload = await response.json();
  return requireNonNullObject(payload, label);
}

export function requireDataRecord(payload: Record<string, unknown>, label = 'data'): Record<string, unknown> {
  const data = getObjectProperty(payload, 'data');
  if (!data) {
    throw new Error(`Expected ${label} to be present`);
  }
  return data;
}

export function getApiErrorCode(payload: unknown): string | undefined {
  return getStringProperty(getObjectProperty(payload, 'error'), 'code');
}
