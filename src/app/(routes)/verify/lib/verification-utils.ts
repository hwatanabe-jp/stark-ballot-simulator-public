import { getStringProperty } from '@/lib/utils/guards';

export const safeJsonParse = (text: string): { ok: true; value: unknown } | { ok: false; value: null } => {
  if (!text) {
    return { ok: true, value: null };
  }
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, value: null };
  }
};

export function isAbortError(error: unknown): boolean {
  return getStringProperty(error, 'name') === 'AbortError';
}
