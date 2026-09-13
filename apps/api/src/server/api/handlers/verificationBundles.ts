import type {
  ArtifactRangeRequest,
  ArtifactReadFailureKind,
  ArtifactReadResult,
  ArtifactRepresentationIdentity,
} from '@stark-ballot/application/verification/artifact-reader';
import { ARTIFACT_DELIVERY_LIMITS } from '@stark-ballot/application/verification/artifact-reader';
import type {
  finalizationArtifactBundleRoute,
  finalizationArtifactReportRoute,
} from '@stark-ballot/api-contract/routes';
import { ApiError, ErrorCode } from '@stark-ballot/api-contract/errors/apiErrors';
import {
  emitCanonicalEvent,
  type BundleDownloadEndpoint,
  type BundleDownloadS3ErrorCode,
} from '@stark-ballot/diagnostics/canonicalEvents';
import { hashKeyPrefixForLogging, hashSessionIdForLogging } from '@stark-ballot/diagnostics/logging';
import { isSafeVerifierSegment } from '@stark-ballot/validation/safe-verifier-segment';
import type { FinalizationId } from '@stark-ballot/application/finalize/finalization-types';
import type { SessionId } from '@stark-ballot/domain/types/identifiers';
import type { ArtifactDeliveryDependencies } from '../../composition/artifactDeliveryDependencies';
import { errorResponse } from '../../http/response';
import type { ApiContextStore, ApiHandlerArguments, SessionFinalizationIdentityContext } from '../context';

const BUNDLE_RANGE_CHUNK_BYTES = ARTIFACT_DELIVERY_LIMITS.bundleRangeMaxBytes;
type HeadersInput = NonNullable<ConstructorParameters<typeof Headers>[0]>;

export interface ArtifactDeliveryHandlerContext extends SessionFinalizationIdentityContext {
  artifactDeliveryDependencies: ArtifactDeliveryDependencies;
}

interface AuthenticatedDownloadObservation {
  endpoint: BundleDownloadEndpoint;
  sessionId: SessionId;
  finalizationId: FinalizationId;
  keyMaterial: string;
}

interface FinalizationScopeFailure {
  ok: false;
  response: Response;
  observationCode: BundleDownloadS3ErrorCode;
}

type FinalizationScopeResult = { ok: true } | FinalizationScopeFailure;

function artifactErrorResponse(
  error: ErrorCode,
  status: number,
  message: string,
  additionalHeaders?: HeadersInput,
): Response {
  const headers = new Headers(additionalHeaders);
  headers.set('Cache-Control', 'no-store');
  return errorResponse(new ApiError(error, status, message), undefined, { headers });
}

function endpointNotFound(endpoint: BundleDownloadEndpoint): Response {
  return endpoint === 'bundle'
    ? artifactErrorResponse(ErrorCode.BUNDLE_NOT_FOUND, 404, 'Bundle not found')
    : artifactErrorResponse(ErrorCode.REPORT_NOT_FOUND, 404, 'Report not found');
}

async function ensureFinalizationScope(
  store: ApiContextStore,
  endpoint: BundleDownloadEndpoint,
  sessionId: SessionId,
  finalizationId: FinalizationId,
): Promise<FinalizationScopeResult> {
  const finalization = await store.getCurrentFinalizationRecord(sessionId);
  if (
    !finalization ||
    finalization.state.status !== 'succeeded' ||
    !isSafeVerifierSegment(finalization.finalizationId) ||
    finalization.finalizationId !== finalizationId
  ) {
    return {
      ok: false,
      response: endpointNotFound(endpoint),
      observationCode: 'no_such_key',
    };
  }
  return { ok: true };
}

function createAuthenticatedDownloadObservation(
  endpoint: BundleDownloadEndpoint,
  sessionId: SessionId,
  finalizationId: FinalizationId,
): AuthenticatedDownloadObservation {
  return {
    endpoint,
    sessionId,
    finalizationId,
    keyMaterial: `artifact/${endpoint}/${sessionId}/${finalizationId}`,
  };
}

function observeAuthenticatedDownloadFailure(
  response: Response,
  observation: AuthenticatedDownloadObservation,
  s3ErrorCode: BundleDownloadS3ErrorCode,
): Response {
  if (response.status < 400) {
    return response;
  }
  try {
    emitCanonicalEvent({
      event: 'bundle_download_failed',
      endpoint: observation.endpoint,
      http_status: response.status,
      s3_error_code: s3ErrorCode,
      key_prefix: hashKeyPrefixForLogging(observation.keyMaterial),
      session_id_hash: hashSessionIdForLogging(observation.sessionId),
      finalization_id: observation.finalizationId,
    });
  } catch {
    // Delivery telemetry cannot alter an authenticated artifact response.
  }
  return response;
}

function parseRangeHeader(rangeHeader: string | undefined): ArtifactRangeRequest | undefined {
  if (rangeHeader === undefined) {
    return undefined;
  }

  const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
  if (!match) {
    return { kind: 'invalid' };
  }
  const [, rawStart, rawEnd] = match;
  if (!rawStart && !rawEnd) {
    return { kind: 'invalid' };
  }
  if (!rawStart) {
    const length = Number(rawEnd);
    return Number.isSafeInteger(length) && length > 0 ? { kind: 'suffix', length } : { kind: 'invalid' };
  }

  const start = Number(rawStart);
  if (!Number.isSafeInteger(start) || start < 0) {
    return { kind: 'invalid' };
  }
  if (!rawEnd) {
    return { kind: 'openEnded', start };
  }
  const end = Number(rawEnd);
  return Number.isSafeInteger(end) && end >= start ? { kind: 'closed', start, end } : { kind: 'invalid' };
}

function applyRepresentationHeaders(headers: Headers, representation: ArtifactRepresentationIdentity): void {
  if (representation.etag) {
    headers.set('ETag', representation.etag);
  }
  if (representation.versionId) {
    headers.set('X-Amz-Version-Id', representation.versionId);
  }
}

function buildBundleHeaders(
  finalizationId: string,
  representation?: ArtifactRepresentationIdentity,
  additionalHeaders?: HeadersInput,
): Headers {
  const headers = new Headers(additionalHeaders);
  headers.set('Content-Type', 'application/zip');
  headers.set('Content-Disposition', `attachment; filename="${finalizationId}.zip"`);
  headers.set('Cache-Control', 'no-store');
  headers.set('Accept-Ranges', 'bytes');
  headers.set('X-Stark-Bundle-Range-Chunk-Size', String(BUNDLE_RANGE_CHUNK_BYTES));
  if (representation) {
    applyRepresentationHeaders(headers, representation);
  }
  return headers;
}

function buildBundleErrorHeaders(totalBytes?: number): Headers {
  const headers = new Headers();
  headers.set('Accept-Ranges', 'bytes');
  headers.set('X-Stark-Bundle-Range-Chunk-Size', String(BUNDLE_RANGE_CHUNK_BYTES));
  if (totalBytes !== undefined) {
    headers.set('Content-Range', `bytes */${totalBytes}`);
  }
  return headers;
}

function buildReportHeaders(
  finalizationId: string,
  totalBytes: number,
  representation: ArtifactRepresentationIdentity,
): Headers {
  const headers = new Headers({
    'Content-Type': 'application/json',
    'Content-Disposition': `inline; filename="${finalizationId}-verification.json"`,
    'Cache-Control': 'no-store',
    'Content-Length': String(totalBytes),
  });
  applyRepresentationHeaders(headers, representation);
  return headers;
}

function diagnosticCodeForFailure(failureKind: ArtifactReadFailureKind): BundleDownloadS3ErrorCode {
  switch (failureKind) {
    case 'accessDenied':
      return 'access_denied';
    case 'timeout':
      return 'timeout';
    case 'throttled':
      return 'throttled';
    case 'unknown':
      return 'unknown';
  }
}

function validFullResult(result: Extract<ArtifactReadResult, { kind: 'full' }>): boolean {
  return (
    Number.isSafeInteger(result.totalBytes) && result.totalBytes >= 0 && result.bytes.byteLength === result.totalBytes
  );
}

function hasRepresentationIdentity(representation: ArtifactRepresentationIdentity): boolean {
  return Boolean(representation.etag?.trim() || representation.versionId?.trim());
}

function validRangeResult(result: Extract<ArtifactReadResult, { kind: 'range' }>): boolean {
  return (
    Number.isSafeInteger(result.totalBytes) &&
    result.totalBytes > 0 &&
    Number.isSafeInteger(result.start) &&
    Number.isSafeInteger(result.end) &&
    result.start >= 0 &&
    result.end >= result.start &&
    result.end < result.totalBytes &&
    result.bytes.byteLength === result.end - result.start + 1 &&
    hasRepresentationIdentity(result.representation)
  );
}

function bundleReaderResponse(
  result: ArtifactReadResult,
  finalizationId: string,
  requestedRange: ArtifactRangeRequest | undefined,
): { response: Response; observationCode: BundleDownloadS3ErrorCode } {
  switch (result.kind) {
    case 'full': {
      if (requestedRange !== undefined || !validFullResult(result)) {
        break;
      }
      return {
        response: new Response(Uint8Array.from(result.bytes), {
          headers: buildBundleHeaders(finalizationId, result.representation, {
            'Content-Length': String(result.totalBytes),
          }),
        }),
        observationCode: 'not_applicable',
      };
    }
    case 'range': {
      if (requestedRange === undefined || !validRangeResult(result)) {
        break;
      }
      return {
        response: new Response(Uint8Array.from(result.bytes), {
          status: 206,
          headers: buildBundleHeaders(finalizationId, result.representation, {
            'Content-Range': `bytes ${result.start}-${result.end}/${result.totalBytes}`,
            'Content-Length': String(result.bytes.byteLength),
          }),
        }),
        observationCode: 'not_applicable',
      };
    }
    case 'notFound':
      return {
        response: endpointNotFound('bundle'),
        observationCode: 'no_such_key',
      };
    case 'invalidRange':
      return {
        response: artifactErrorResponse(
          ErrorCode.INVALID_RANGE,
          416,
          'Invalid range',
          buildBundleErrorHeaders(result.totalBytes),
        ),
        observationCode: 'not_applicable',
      };
    case 'tooLarge':
      return {
        response: artifactErrorResponse(
          ErrorCode.BUNDLE_REQUIRES_RANGE_DOWNLOAD,
          413,
          'Bundle requires ranged download',
          buildBundleErrorHeaders(result.totalBytes),
        ),
        observationCode: 'not_applicable',
      };
    case 'unavailable':
      return {
        response: artifactErrorResponse(ErrorCode.BUNDLE_DOWNLOAD_FAILED, 500, 'Failed to load bundle'),
        observationCode: diagnosticCodeForFailure(result.failureKind),
      };
  }

  return {
    response: artifactErrorResponse(ErrorCode.BUNDLE_DOWNLOAD_FAILED, 500, 'Failed to load bundle'),
    observationCode: 'unknown',
  };
}

function reportReaderResponse(
  result: ArtifactReadResult,
  finalizationId: string,
): { response: Response; observationCode: BundleDownloadS3ErrorCode } {
  switch (result.kind) {
    case 'full':
      if (validFullResult(result)) {
        return {
          response: new Response(Uint8Array.from(result.bytes), {
            headers: buildReportHeaders(finalizationId, result.totalBytes, result.representation),
          }),
          observationCode: 'not_applicable',
        };
      }
      break;
    case 'notFound':
      return {
        response: endpointNotFound('report'),
        observationCode: 'no_such_key',
      };
    case 'tooLarge':
      return {
        response: artifactErrorResponse(
          ErrorCode.REPORT_DOWNLOAD_TOO_LARGE,
          413,
          'Report exceeds authenticated download limit',
        ),
        observationCode: 'not_applicable',
      };
    case 'unavailable':
      return {
        response: artifactErrorResponse(ErrorCode.REPORT_DOWNLOAD_FAILED, 500, 'Failed to load report'),
        observationCode: diagnosticCodeForFailure(result.failureKind),
      };
    case 'range':
    case 'invalidRange':
      break;
  }

  return {
    response: artifactErrorResponse(ErrorCode.REPORT_DOWNLOAD_FAILED, 500, 'Failed to load report'),
    observationCode: 'unknown',
  };
}

async function resolveReaderResult(
  dependencies: ArtifactDeliveryDependencies,
  request: Parameters<ArtifactDeliveryDependencies['artifactReader']['read']>[0],
): Promise<ArtifactReadResult> {
  try {
    return await dependencies.artifactReader.read(request);
  } catch {
    return { kind: 'unavailable', failureKind: 'unknown' };
  }
}

export async function getVerificationBundleHandler({
  input,
  context,
}: ApiHandlerArguments<typeof finalizationArtifactBundleRoute, ArtifactDeliveryHandlerContext>): Promise<Response> {
  const { sessionId: wireSessionId, finalizationId: wireFinalizationId } = input.params;
  const { sessionId, finalizationId } = context;
  if (
    !isSafeVerifierSegment(wireSessionId) ||
    !isSafeVerifierSegment(wireFinalizationId) ||
    wireSessionId !== sessionId ||
    wireFinalizationId !== finalizationId
  ) {
    return artifactErrorResponse(ErrorCode.INVALID_BUNDLE_REFERENCE, 400, 'Invalid bundle reference');
  }

  const observation = createAuthenticatedDownloadObservation('bundle', sessionId, finalizationId);
  let scope: FinalizationScopeResult;
  try {
    scope = await ensureFinalizationScope(context.store, 'bundle', sessionId, finalizationId);
  } catch {
    return observeAuthenticatedDownloadFailure(
      artifactErrorResponse(ErrorCode.BUNDLE_DOWNLOAD_FAILED, 500, 'Failed to load bundle'),
      observation,
      'unknown',
    );
  }
  if (!scope.ok) {
    return observeAuthenticatedDownloadFailure(scope.response, observation, scope.observationCode);
  }

  const range = parseRangeHeader(input.headers.Range);
  const result = await resolveReaderResult(context.artifactDeliveryDependencies, {
    artifact: 'bundle',
    sessionId,
    finalizationId,
    ...(range ? { range } : {}),
  });
  const mapped = bundleReaderResponse(result, finalizationId, range);
  return observeAuthenticatedDownloadFailure(mapped.response, observation, mapped.observationCode);
}

export async function getVerificationReportHandler({
  input,
  context,
}: ApiHandlerArguments<typeof finalizationArtifactReportRoute, ArtifactDeliveryHandlerContext>): Promise<Response> {
  const { sessionId: wireSessionId, finalizationId: wireFinalizationId } = input.params;
  const { sessionId, finalizationId } = context;
  if (
    !isSafeVerifierSegment(wireSessionId) ||
    !isSafeVerifierSegment(wireFinalizationId) ||
    wireSessionId !== sessionId ||
    wireFinalizationId !== finalizationId
  ) {
    return artifactErrorResponse(ErrorCode.INVALID_BUNDLE_REFERENCE, 400, 'Invalid bundle reference');
  }

  const observation = createAuthenticatedDownloadObservation('report', sessionId, finalizationId);
  let scope: FinalizationScopeResult;
  try {
    scope = await ensureFinalizationScope(context.store, 'report', sessionId, finalizationId);
  } catch {
    return observeAuthenticatedDownloadFailure(
      artifactErrorResponse(ErrorCode.REPORT_DOWNLOAD_FAILED, 500, 'Failed to load report'),
      observation,
      'unknown',
    );
  }
  if (!scope.ok) {
    return observeAuthenticatedDownloadFailure(scope.response, observation, scope.observationCode);
  }

  const result = await resolveReaderResult(context.artifactDeliveryDependencies, {
    artifact: 'report',
    sessionId,
    finalizationId,
  });
  const mapped = reportReaderResponse(result, finalizationId);
  return observeAuthenticatedDownloadFailure(mapped.response, observation, mapped.observationCode);
}
