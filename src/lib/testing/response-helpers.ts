import { getRecordProperty, requireRecord } from '@/lib/utils/guards';

export interface JsonResponseLike {
  json(): Promise<unknown>;
}

export async function readJsonRecord(response: JsonResponseLike, label = 'response'): Promise<Record<string, unknown>> {
  const payload = await response.json();
  return requireRecord(payload, label);
}

export function requireDataRecord(payload: Record<string, unknown>, label = 'data'): Record<string, unknown> {
  const data = getRecordProperty(payload, 'data');
  if (!data) {
    throw new Error(`Expected ${label} to be present`);
  }
  return data;
}
