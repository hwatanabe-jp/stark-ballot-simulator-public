export interface SatisfiedContentRange {
  kind: 'satisfied';
  unit: 'bytes';
  start: number;
  end: number;
  total: number;
  advertisedLength: number;
}

export interface UnsatisfiedContentRange {
  kind: 'unsatisfied';
  unit: 'bytes';
  total: number;
}

export type ParsedContentRange = SatisfiedContentRange | UnsatisfiedContentRange;

function parseSafeInteger(value: string): number | null {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

export function parseContentRange(value: string | null): ParsedContentRange | null {
  if (value === null) {
    return null;
  }

  const satisfiedMatch = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(value);
  if (satisfiedMatch) {
    const start = parseSafeInteger(satisfiedMatch[1] ?? '');
    const end = parseSafeInteger(satisfiedMatch[2] ?? '');
    const total = parseSafeInteger(satisfiedMatch[3] ?? '');
    if (start === null || end === null || total === null || start < 0 || end < start || total <= end) {
      return null;
    }
    return {
      kind: 'satisfied',
      unit: 'bytes',
      start,
      end,
      total,
      advertisedLength: end - start + 1,
    };
  }

  const unsatisfiedMatch = /^bytes \*\/(\d+)$/.exec(value);
  if (!unsatisfiedMatch) {
    return null;
  }
  const total = parseSafeInteger(unsatisfiedMatch[1] ?? '');
  if (total === null || total < 0) {
    return null;
  }
  return {
    kind: 'unsatisfied',
    unit: 'bytes',
    total,
  };
}
