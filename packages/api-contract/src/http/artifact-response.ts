import { parseContentRange, type SatisfiedContentRange } from './content-range';

function readRepresentationIdentity(headers: Headers): string | null {
  const etag = headers.get('etag')?.trim() ?? '';
  const versionId = headers.get('x-amz-version-id')?.trim() ?? '';
  return etag || versionId ? `${etag}\u0000${versionId}` : null;
}

/** Admit the first partial response before reading artifact bytes. */
export function admitInitialArtifactRange(
  headers: Headers,
  limits: { chunkBytes: number; maxBytes: number },
): { range: SatisfiedContentRange; representationIdentity: string } {
  const range = parseContentRange(headers.get('content-range'));
  if (
    range?.kind !== 'satisfied' ||
    range.start !== 0 ||
    range.end >= limits.chunkBytes ||
    range.total > limits.maxBytes
  ) {
    throw new Error('Invalid ranged bundle response');
  }
  const representationIdentity = readRepresentationIdentity(headers);
  if (!representationIdentity) throw new Error('Invalid ranged bundle response');
  return { range, representationIdentity };
}

/** Every subsequent response must describe the requested bytes of the same representation. */
export function admitNextArtifactRange(
  headers: Headers,
  expected: { start: number; end: number; total: number; representationIdentity: string },
): SatisfiedContentRange {
  const range = parseContentRange(headers.get('content-range'));
  if (
    range?.kind !== 'satisfied' ||
    range.start !== expected.start ||
    range.end !== expected.end ||
    range.total !== expected.total
  ) {
    throw new Error('Invalid ranged bundle response');
  }
  const representationIdentity = readRepresentationIdentity(headers);
  if (!representationIdentity || representationIdentity !== expected.representationIdentity) {
    throw new Error('Bundle representation changed during download');
  }
  return range;
}

export function resolveArtifactChunkSize(value: string | null, defaultBytes: number): number {
  if (!value) return defaultBytes;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? Math.min(parsed, defaultBytes) : defaultBytes;
}

/** Reject malformed or oversized declarations before a client acquires the body reader. */
export function readArtifactContentLength(
  headers: Headers,
  maxBytes: number,
  limitMessage: string,
): number | undefined {
  const contentLength = headers.get('content-length');
  const declaredBytes = contentLength === null || !/^\d+$/.test(contentLength) ? undefined : Number(contentLength);
  if (
    contentLength !== null &&
    (declaredBytes === undefined || !Number.isSafeInteger(declaredBytes) || declaredBytes > maxBytes)
  ) {
    throw new Error(limitMessage);
  }
  return declaredBytes;
}
