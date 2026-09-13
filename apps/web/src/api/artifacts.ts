import { parseContentRange } from '@stark-ballot/api-contract/http/content-range';
import { API_ROUTES, buildApiRouteUrl } from '@stark-ballot/api-contract/routes';
import type { SessionIdentity } from '@stark-ballot/web/session';
import { isSafeVerifierSegment } from '@stark-ballot/validation/safe-verifier-segment';
import {
  parseVerifierServiceWireReport,
  type VerifierServiceWireReport,
} from '@stark-ballot/verification/verifier-service-report';
import {
  readResponseJsonSafely,
  resolveVerificationClientApiError,
} from '@stark-ballot/web/verification/client-api-errors';
import { apiFetch } from './apiFetch';
import { buildPathSessionHeaders, resolveWebApiUrl, type ApiSessionIdentity } from './client';

export type BundleSource = 'authenticated-endpoint';

export interface DownloadCandidate {
  kind: 'bundle';
  url: string;
  source: BundleSource;
  sessionId: string;
  finalizationId: string;
}

export interface ReportCandidate {
  kind: 'report';
  url: string;
  source: BundleSource;
  sessionId: string;
  finalizationId: string;
}

interface ArtifactDownloadOptions {
  identity: ApiSessionIdentity;
  sessionIdentity?: SessionIdentity | null;
  resolveSessionErrorMessage?: () => string;
}

const DEFAULT_BUNDLE_RANGE_CHUNK_BYTES = 4 * 1024 * 1024;
const MAX_BUNDLE_DOWNLOAD_BYTES = 256 * 1024 * 1024;
const MAX_REPORT_DOWNLOAD_BYTES = 4 * 1024 * 1024;
const BUNDLE_RANGE_CHUNK_HEADER = 'x-stark-bundle-range-chunk-size';

export function buildAuthenticatedBundleDownloadUrl(sessionId: string, finalizationId: string): string {
  return resolveWebApiUrl(
    buildApiRouteUrl(API_ROUTES.finalizationArtifactBundle, {
      params: { sessionId, finalizationId },
    }),
  );
}

export function buildAuthenticatedReportDownloadUrl(sessionId: string, finalizationId: string): string {
  return resolveWebApiUrl(
    buildApiRouteUrl(API_ROUTES.finalizationArtifactReport, {
      params: { sessionId, finalizationId },
    }),
  );
}

export async function downloadBundle(candidate: DownloadCandidate, options: ArtifactDownloadOptions): Promise<void> {
  assertTrustedAuthenticatedDownloadCandidate(candidate);
  const blob = await fetchBundleBlob(candidate.url, options);
  saveBundleBlob(blob);
}

export async function fetchVerificationReport(
  candidate: ReportCandidate,
  options: ArtifactDownloadOptions,
): Promise<VerifierServiceWireReport> {
  assertTrustedAuthenticatedReportCandidate(candidate);
  const response = await apiFetch(candidate.url, {
    headers: buildPathSessionHeaders(options.identity),
  });
  await throwIfDownloadFailed(response, options);
  if (response.status !== 200) {
    throw new Error('Invalid verification report response');
  }

  const rawBody = await readVerificationReportJsonWithLimit(response);
  try {
    return parseVerifierServiceWireReport(rawBody);
  } catch {
    throw new Error('Invalid verification report response');
  }
}

async function fetchBundleBlob(url: string, options: ArtifactDownloadOptions): Promise<Blob> {
  const firstResponse = await fetchBundleRange(url, options.identity, 0, DEFAULT_BUNDLE_RANGE_CHUNK_BYTES - 1);
  if (firstResponse.status !== 206) {
    await throwIfDownloadFailed(firstResponse, options);
    if (firstResponse.status !== 200) {
      throw new Error('Invalid bundle download response');
    }
    return readBundleBodyWithLimit(firstResponse);
  }

  const contentRange = parseContentRange(firstResponse.headers.get('content-range'));
  if (
    contentRange?.kind !== 'satisfied' ||
    contentRange.start !== 0 ||
    contentRange.end >= DEFAULT_BUNDLE_RANGE_CHUNK_BYTES ||
    contentRange.total > MAX_BUNDLE_DOWNLOAD_BYTES
  ) {
    throw new Error('Invalid ranged bundle response');
  }

  const representationIdentity = readRepresentationIdentity(firstResponse.headers);
  if (!representationIdentity) {
    throw new Error('Invalid ranged bundle response');
  }
  const chunks: Blob[] = [await readRangeBody(firstResponse, contentRange.advertisedLength)];
  const chunkSize = resolveAdvertisedChunkSize(firstResponse.headers.get(BUNDLE_RANGE_CHUNK_HEADER));
  let nextStart = contentRange.end + 1;

  while (nextStart < contentRange.total) {
    const nextEnd = Math.min(nextStart + chunkSize - 1, contentRange.total - 1);
    const response = await fetchBundleRange(url, options.identity, nextStart, nextEnd);
    await throwIfDownloadFailed(response, options);
    if (response.status !== 206) {
      throw new Error('Invalid ranged bundle response');
    }

    const range = parseContentRange(response.headers.get('content-range'));
    if (
      range?.kind !== 'satisfied' ||
      range.start !== nextStart ||
      range.end !== nextEnd ||
      range.total !== contentRange.total
    ) {
      throw new Error('Invalid ranged bundle response');
    }

    const nextRepresentationIdentity = readRepresentationIdentity(response.headers);
    if (!nextRepresentationIdentity || nextRepresentationIdentity !== representationIdentity) {
      throw new Error('Bundle representation changed during download');
    }
    chunks.push(await readRangeBody(response, range.advertisedLength));
    nextStart = range.end + 1;
  }

  return new Blob(chunks, { type: 'application/zip' });
}

function fetchBundleRange(url: string, identity: ApiSessionIdentity, start: number, end: number): Promise<Response> {
  return apiFetch(url, {
    headers: {
      ...buildPathSessionHeaders(identity),
      Range: `bytes=${start}-${end}`,
    },
  });
}

async function throwIfDownloadFailed(response: Response, options: ArtifactDownloadOptions): Promise<void> {
  if (response.ok) {
    return;
  }
  const rawBody = await readResponseJsonSafely(response);
  throw resolveVerificationClientApiError({
    rawBody,
    responseStatus: response.status,
    responseStatusText: response.statusText,
    sessionIdentity: options.sessionIdentity ?? options.identity,
    ...(options.resolveSessionErrorMessage ? { resolveSessionErrorMessage: options.resolveSessionErrorMessage } : {}),
    fallbackMessage: `HTTP ${response.status}`,
  });
}

function resolveAdvertisedChunkSize(value: string | null): number {
  if (!value) {
    return DEFAULT_BUNDLE_RANGE_CHUNK_BYTES;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0
    ? Math.min(parsed, DEFAULT_BUNDLE_RANGE_CHUNK_BYTES)
    : DEFAULT_BUNDLE_RANGE_CHUNK_BYTES;
}

function readRepresentationIdentity(headers: Headers): string | null {
  const etag = headers.get('etag')?.trim() ?? '';
  const versionId = headers.get('x-amz-version-id')?.trim() ?? '';
  return etag || versionId ? `${etag}\u0000${versionId}` : null;
}

async function readRangeBody(response: Response, expectedLength: number): Promise<Blob> {
  const bytes = await readResponseBytesWithLimit(response, expectedLength, 'Invalid ranged bundle response');
  if (bytes.byteLength !== expectedLength) {
    throw new Error('Invalid ranged bundle response');
  }
  return new Blob([bytes], { type: 'application/zip' });
}

async function readBundleBodyWithLimit(response: Response): Promise<Blob> {
  const bytes = await readResponseBytesWithLimit(
    response,
    MAX_BUNDLE_DOWNLOAD_BYTES,
    'Bundle download exceeds size limit',
  );
  return new Blob([bytes], { type: 'application/zip' });
}

async function readVerificationReportJsonWithLimit(response: Response): Promise<unknown> {
  const bytes = await readResponseBytesWithLimit(
    response,
    MAX_REPORT_DOWNLOAD_BYTES,
    'Verification report exceeds size limit',
  );
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
  } catch {
    throw new Error('Invalid verification report response');
  }
}

async function readResponseBytesWithLimit(
  response: Response,
  maxBytes: number,
  limitMessage: string,
): Promise<Uint8Array<ArrayBuffer>> {
  const contentLength = response.headers.get('content-length');
  const declaredBytes = contentLength === null || !/^\d+$/.test(contentLength) ? undefined : Number(contentLength);
  if (
    contentLength !== null &&
    (declaredBytes === undefined || !Number.isSafeInteger(declaredBytes) || declaredBytes > maxBytes)
  ) {
    throw new Error(limitMessage);
  }

  if (!response.body) {
    return new Uint8Array();
  }

  const chunks: Uint8Array[] = [];
  const reader = response.body.getReader();
  let totalBytes = 0;
  try {
    let result = await reader.read();
    while (!result.done) {
      totalBytes += result.value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel();
        throw new Error(limitMessage);
      }
      chunks.push(result.value);
      result = await reader.read();
    }
  } finally {
    reader.releaseLock();
  }

  if (declaredBytes !== undefined && declaredBytes !== totalBytes) {
    throw new Error(limitMessage);
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
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
  const candidateKind: unknown = candidate.kind;
  const candidateSource: unknown = candidate.source;
  if (candidateKind !== 'bundle' || candidateSource !== 'authenticated-endpoint') {
    throw new Error('Invalid bundle download reference');
  }
  if (!isSafeVerifierSegment(candidate.sessionId) || !isSafeVerifierSegment(candidate.finalizationId)) {
    throw new Error('Invalid bundle download reference');
  }
  if (candidate.url !== buildAuthenticatedBundleDownloadUrl(candidate.sessionId, candidate.finalizationId)) {
    throw new Error('Invalid bundle download reference');
  }
}

function assertTrustedAuthenticatedReportCandidate(candidate: ReportCandidate): void {
  const candidateKind: unknown = candidate.kind;
  const candidateSource: unknown = candidate.source;
  if (candidateKind !== 'report' || candidateSource !== 'authenticated-endpoint') {
    throw new Error('Invalid verification report reference');
  }
  if (!isSafeVerifierSegment(candidate.sessionId) || !isSafeVerifierSegment(candidate.finalizationId)) {
    throw new Error('Invalid verification report reference');
  }
  if (candidate.url !== buildAuthenticatedReportDownloadUrl(candidate.sessionId, candidate.finalizationId)) {
    throw new Error('Invalid verification report reference');
  }
}

function buildBundleFilename(): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `stark-ballot-verification-bundle-${timestamp}.zip`;
}
