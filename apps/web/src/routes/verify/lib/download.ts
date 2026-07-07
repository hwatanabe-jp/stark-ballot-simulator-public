import type { SessionIdentity } from '@stark-ballot/web/session';
import { resolveApiUrl } from '@stark-ballot/web/api/apiBaseUrl';
import { buildVerifierPath, isSafeVerifierSegment } from '@stark-ballot/web/verification/verifier-paths';
import {
  readResponseJsonSafely,
  resolveVerificationClientApiError,
} from '@stark-ballot/web/verification/client-api-errors';
import { isRecord } from '@stark-ballot/verification/shared/guards';
import type { DownloadCandidate, ReportCandidate } from './verification-data';
import { omitUndefinedProperties } from '@stark-ballot/validation/definedProperties';

interface DownloadOptions {
  authHeaders?: Record<string, string>;
  sessionIdentity?: SessionIdentity | null;
  resolveSessionErrorMessage?: () => string;
}

interface ParsedContentRange {
  start: number;
  end: number;
  total: number;
}

const DEFAULT_BUNDLE_RANGE_CHUNK_BYTES = 4 * 1024 * 1024;
const BUNDLE_RANGE_CHUNK_HEADER = 'x-stark-bundle-range-chunk-size';

export async function downloadBundle(candidate: DownloadCandidate, options: DownloadOptions = {}): Promise<void> {
  assertTrustedAuthenticatedDownloadCandidate(candidate);

  const blob = await fetchBundleBlob(candidate.url, options);
  saveBundleBlob(blob);
}

export async function fetchVerificationReport(
  candidate: ReportCandidate,
  options: DownloadOptions = {},
): Promise<Record<string, unknown>> {
  assertTrustedAuthenticatedReportCandidate(candidate);

  const response = await fetch(candidate.url, {
    headers: {
      ...(options.authHeaders ?? {}),
    },
  });
  await throwIfDownloadFailed(response, options);

  const rawBody = await readResponseJsonSafely(response);
  if (!isRecord(rawBody)) {
    throw new Error('Invalid verification report response');
  }
  return rawBody;
}

async function fetchBundleBlob(url: string, options: DownloadOptions): Promise<Blob> {
  const firstResponse = await fetchBundleRange(url, options, 0, DEFAULT_BUNDLE_RANGE_CHUNK_BYTES - 1);
  if (firstResponse.status !== 206) {
    await throwIfDownloadFailed(firstResponse, options);
    return firstResponse.blob();
  }

  const contentRange = parseContentRange(firstResponse.headers.get('content-range'));
  if (!contentRange || contentRange.start !== 0) {
    throw new Error('Invalid ranged bundle response');
  }

  const chunks: Blob[] = [await firstResponse.blob()];
  const chunkSize = resolveAdvertisedChunkSize(firstResponse.headers.get(BUNDLE_RANGE_CHUNK_HEADER));
  let nextStart = contentRange.end + 1;

  while (nextStart < contentRange.total) {
    const nextEnd = Math.min(nextStart + chunkSize - 1, contentRange.total - 1);
    const response = await fetchBundleRange(url, options, nextStart, nextEnd);
    await throwIfDownloadFailed(response, options);
    if (response.status !== 206) {
      throw new Error('Invalid ranged bundle response');
    }

    const range = parseContentRange(response.headers.get('content-range'));
    if (!range || range.start !== nextStart || range.total !== contentRange.total) {
      throw new Error('Invalid ranged bundle response');
    }

    chunks.push(await response.blob());
    nextStart = range.end + 1;
  }

  return new Blob(chunks, { type: 'application/zip' });
}

function fetchBundleRange(url: string, options: DownloadOptions, start: number, end: number): Promise<Response> {
  return fetch(url, {
    headers: {
      ...(options.authHeaders ?? {}),
      Range: `bytes=${start}-${end}`,
    },
  });
}

async function throwIfDownloadFailed(response: Response, options: DownloadOptions): Promise<void> {
  if (!response.ok) {
    const rawBody = await readResponseJsonSafely(response);
    throw resolveVerificationClientApiError({
      rawBody,
      responseStatus: response.status,
      responseStatusText: response.statusText,
      ...omitUndefinedProperties({ sessionIdentity: options.sessionIdentity }),
      ...omitUndefinedProperties({ resolveSessionErrorMessage: options.resolveSessionErrorMessage }),
      fallbackMessage: `HTTP ${response.status}`,
    });
  }
}

function parseContentRange(value: string | null): ParsedContentRange | null {
  if (!value) {
    return null;
  }
  const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(value);
  if (!match) {
    return null;
  }

  const [, rawStart, rawEnd, rawTotal] = match;
  const start = Number(rawStart);
  const end = Number(rawEnd);
  const total = Number(rawTotal);
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    !Number.isSafeInteger(total) ||
    start < 0 ||
    end < start ||
    total <= end
  ) {
    return null;
  }

  return { start, end, total };
}

function resolveAdvertisedChunkSize(value: string | null): number {
  if (!value) {
    return DEFAULT_BUNDLE_RANGE_CHUNK_BYTES;
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    return DEFAULT_BUNDLE_RANGE_CHUNK_BYTES;
  }
  return parsed;
}

function saveBundleBlob(blob: Blob): void {
  const blobUrl = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = blobUrl;
  anchor.download = buildBundleFilename();
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(blobUrl);
}

function assertTrustedAuthenticatedDownloadCandidate(candidate: DownloadCandidate): void {
  const candidateSource: unknown = candidate.source;
  const candidateKind: unknown = candidate.kind;
  if (candidateKind !== 'bundle' || candidateSource !== 'authenticated-endpoint') {
    throw new Error('Invalid bundle download reference');
  }

  if (!isSafeVerifierSegment(candidate.sessionId) || !isSafeVerifierSegment(candidate.executionId)) {
    throw new Error('Invalid bundle download reference');
  }

  const expectedUrl = resolveApiUrl(buildVerifierPath(candidate.sessionId, candidate.executionId));
  if (candidate.url !== expectedUrl) {
    throw new Error('Invalid bundle download reference');
  }
}

function assertTrustedAuthenticatedReportCandidate(candidate: ReportCandidate): void {
  const candidateSource: unknown = candidate.source;
  const candidateKind: unknown = candidate.kind;
  if (candidateKind !== 'report' || candidateSource !== 'authenticated-endpoint') {
    throw new Error('Invalid verification report reference');
  }

  if (!isSafeVerifierSegment(candidate.sessionId) || !isSafeVerifierSegment(candidate.executionId)) {
    throw new Error('Invalid verification report reference');
  }

  const expectedUrl = resolveApiUrl(buildVerifierPath(candidate.sessionId, candidate.executionId, 'report'));
  if (candidate.url !== expectedUrl) {
    throw new Error('Invalid verification report reference');
  }
}

function buildBundleFilename(): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `stark-ballot-verification-bundle-${timestamp}.zip`;
}
