function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

export function isNumberArray(value: unknown): value is number[] {
  return Array.isArray(value) && value.every(isNumber);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function getStringProperty(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const candidate = value[key];
  return typeof candidate === 'string' ? candidate : undefined;
}

export function getNumberProperty(value: unknown, key: string): number | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const candidate = value[key];
  return isNumber(candidate) ? candidate : undefined;
}

export function getRecordProperty(value: unknown, key: string): Record<string, unknown> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const candidate = value[key];
  return isRecord(candidate) ? candidate : undefined;
}

export function getArrayProperty(value: unknown, key: string): unknown[] | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const candidate = value[key];
  return isUnknownArray(candidate) ? candidate : undefined;
}

export function getStringArrayProperty(value: unknown, key: string): string[] | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const candidate = value[key];
  return isStringArray(candidate) ? candidate : undefined;
}

export function getNumberArrayProperty(value: unknown, key: string): number[] | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const candidate = value[key];
  return isNumberArray(candidate) ? candidate : undefined;
}
