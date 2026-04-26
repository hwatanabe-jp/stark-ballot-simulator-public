const WEAK_PREFIX = 'W/';

function normalizeTagValue(tag: string): string | null {
  const trimmed = tag.trim();
  if (!trimmed) {
    return null;
  }
  if (trimmed === '*') {
    return '*';
  }

  let value = trimmed;
  if (value.startsWith(WEAK_PREFIX)) {
    value = value.slice(WEAK_PREFIX.length).trim();
  }
  if (value.startsWith('"') && value.endsWith('"')) {
    value = value.slice(1, -1);
  }

  return value.length > 0 ? value : null;
}

function splitIfNoneMatchHeader(headerValue: string): string[] {
  return headerValue
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

export function matchesIfNoneMatch(ifNoneMatch: string | null, currentETag: string): boolean {
  if (!ifNoneMatch) {
    return false;
  }

  const currentTag = normalizeTagValue(currentETag);
  if (!currentTag) {
    return false;
  }

  const candidates = splitIfNoneMatchHeader(ifNoneMatch);
  for (const candidate of candidates) {
    const normalized = normalizeTagValue(candidate);
    if (!normalized) {
      continue;
    }
    if (normalized === '*' || normalized === currentTag) {
      return true;
    }
  }

  return false;
}
