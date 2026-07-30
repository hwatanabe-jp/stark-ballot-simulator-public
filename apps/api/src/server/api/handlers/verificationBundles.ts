import path from 'path';
import { promises as fs } from 'fs';
import type { ApiContext } from '../context';
import { errorResponse } from '../../http/response';
import { ApiError, ErrorCode } from '@stark-ballot/api-contract/errors/apiErrors';
import { getStringProperty } from '@stark-ballot/domain/utils/guards';
import {
  downloadFromS3,
  downloadRangeFromS3,
  headS3Object,
  type S3ByteRange,
  type S3RangeDownload,
} from '@stark-ballot/aws-adapters/aws/s3-download';
import { isS3UploadEnabled } from '@stark-ballot/aws-adapters/aws/s3-upload';
import { validateSessionCapabilityForSession } from '../middleware/session';
import { buildFailClosedDownloadResponse, resolveSupportedFinalizedRead } from '../utils/currentArtifactAdmission';
import { isTargetAwsRuntime } from '@stark-ballot/runtime-config/env/targetRuntime';
import { omitUndefinedProperties } from '@stark-ballot/validation/definedProperties';
import {
  emitCanonicalEvent,
  type BundleDownloadEndpoint,
  type BundleDownloadS3ErrorCode,
} from '@stark-ballot/diagnostics/canonicalEvents';
import { hashKeyPrefixForLogging, hashSessionIdForLogging } from '@stark-ballot/diagnostics/logging';

const S3_BUNDLE_RANGE_CHUNK_BYTES = 4 * 1024 * 1024;
const S3_REPORT_INLINE_MAX_BYTES = S3_BUNDLE_RANGE_CHUNK_BYTES;

function getBundleBaseDir(): string {
  return process.env['VERIFIER_WORK_DIR'] ?? path.join(/* turbopackIgnore: true */ process.cwd(), '.verifier-bundles');
}

function isSafeSegment(value: string): boolean {
  return /^[A-Za-z0-9-]+$/.test(value);
}

function getStringField(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const fieldValue = (value as Record<string, unknown>)[key];
  return typeof fieldValue === 'string' ? fieldValue : undefined;
}

function artifactErrorResponse(error: ErrorCode, statusCode: number, message: string, headers?: HeadersInit): Response {
  return errorResponse(new ApiError(error, statusCode, message), undefined, omitUndefinedProperties({ headers }));
}

async function ensureExecutionScope(
  store: ApiContext['store'],
  sessionId: string,
  executionId: string,
): Promise<
  | {
      ok: true;
      finalizationResult: NonNullable<ReturnType<typeof resolveSupportedFinalizedRead>['finalizationResult']>;
    }
  | { ok: false; response: Response; s3ErrorCode: BundleDownloadS3ErrorCode }
> {
  const session = await store.getSession(sessionId);
  if (!session || !session.finalized) {
    return {
      ok: false,
      response: artifactErrorResponse(ErrorCode.BUNDLE_NOT_FOUND, 404, 'Bundle not found'),
      s3ErrorCode: 'no_such_key',
    };
  }

  const finalizedRead = resolveSupportedFinalizedRead(session);
  if (finalizedRead.artifactState) {
    return {
      ok: false,
      response: buildFailClosedDownloadResponse(finalizedRead.artifactState),
      s3ErrorCode: 'not_applicable',
    };
  }

  const finalizationResult = finalizedRead.finalizationResult;
  if (!finalizationResult) {
    return {
      ok: false,
      response: buildFailClosedDownloadResponse('corrupt_or_unreadable'),
      s3ErrorCode: 'not_applicable',
    };
  }

  const allowedExecutionId = finalizationResult.verificationExecutionId;
  if (!allowedExecutionId || !isSafeSegment(allowedExecutionId) || allowedExecutionId !== executionId) {
    return {
      ok: false,
      response: artifactErrorResponse(ErrorCode.BUNDLE_NOT_FOUND, 404, 'Bundle not found'),
      s3ErrorCode: 'no_such_key',
    };
  }

  return { ok: true, finalizationResult };
}

interface S3ServeOptions {
  contentType: string;
  contentDisposition: string;
  notFoundMessage: string;
  notFoundError: ErrorCode;
  failureMessage: string;
  failureError: ErrorCode;
  maxInlineBytes?: number;
  tooLargeMessage?: string;
  tooLargeError?: ErrorCode;
}

interface AuthenticatedDownloadObservation {
  endpoint: BundleDownloadEndpoint;
  sessionId: string;
  executionId: string;
  keyMaterial: string;
}

interface S3DownloadFailure {
  status: number;
  s3ErrorCode: BundleDownloadS3ErrorCode;
}

function createAuthenticatedDownloadObservation(
  endpoint: BundleDownloadEndpoint,
  sessionId: string,
  executionId: string,
  artifactKey?: string,
): AuthenticatedDownloadObservation {
  return {
    endpoint,
    sessionId,
    executionId,
    keyMaterial:
      artifactKey ??
      `sessions/${sessionId}/${executionId}/${endpoint === 'bundle' ? 'bundle.zip' : 'verification.json'}`,
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
      execution_id: observation.executionId,
    });
  } catch {
    // Artifact-delivery telemetry must never alter the authenticated response.
  }
  return response;
}

function resolveS3DownloadFailure(error: unknown): S3DownloadFailure {
  const code = getStringProperty(error, 'Code') ?? getStringProperty(error, 'code') ?? getStringProperty(error, 'name');
  if (code === 'NoSuchKey' || code === 'NotFound' || code === 'NotFoundError') {
    return { status: 404, s3ErrorCode: 'no_such_key' };
  }
  if (code === 'AccessDenied' || code === 'Forbidden') {
    return { status: 500, s3ErrorCode: 'access_denied' };
  }
  if (code === 'RequestTimeout' || code === 'RequestTimeoutException' || code === 'TimeoutError') {
    return { status: 500, s3ErrorCode: 'timeout' };
  }
  if (code === 'SlowDown' || code === 'Throttling' || code === 'ThrottlingException') {
    return { status: 500, s3ErrorCode: 'throttled' };
  }
  return { status: 500, s3ErrorCode: 'unknown' };
}

function buildS3BundleHeaders(executionId: string, extra?: HeadersInit): Headers {
  const headers = new Headers(extra);
  headers.set('Content-Type', 'application/zip');
  headers.set('Content-Disposition', `attachment; filename="${executionId}.zip"`);
  headers.set('Cache-Control', 'no-store');
  headers.set('Accept-Ranges', 'bytes');
  headers.set('X-Stark-Bundle-Range-Chunk-Size', String(S3_BUNDLE_RANGE_CHUNK_BYTES));
  return headers;
}

function buildS3BundleErrorHeaders(extra?: HeadersInit): Headers {
  const headers = new Headers(extra);
  headers.set('Content-Type', 'application/json');
  headers.set('Cache-Control', 'no-store');
  headers.set('Accept-Ranges', 'bytes');
  headers.set('X-Stark-Bundle-Range-Chunk-Size', String(S3_BUNDLE_RANGE_CHUNK_BYTES));
  return headers;
}

type ParsedByteRange = S3ByteRange | 'invalid';

function parseByteRange(rangeHeader: string, totalSize: number): ParsedByteRange {
  const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
  if (!match) {
    return 'invalid';
  }

  const [, rawStart, rawEnd] = match;
  if (!rawStart && !rawEnd) {
    return 'invalid';
  }

  if (!rawStart) {
    const suffixLength = Number(rawEnd);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) {
      return 'invalid';
    }
    const boundedLength = Math.min(suffixLength, totalSize, S3_BUNDLE_RANGE_CHUNK_BYTES);
    return {
      start: Math.max(0, totalSize - boundedLength),
      end: totalSize - 1,
    };
  }

  const start = Number(rawStart);
  const requestedEnd = rawEnd ? Number(rawEnd) : totalSize - 1;
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(requestedEnd) ||
    start < 0 ||
    requestedEnd < start ||
    start >= totalSize
  ) {
    return 'invalid';
  }

  return {
    start,
    end: Math.min(requestedEnd, totalSize - 1, start + S3_BUNDLE_RANGE_CHUNK_BYTES - 1),
  };
}

function getRangeContentLength(range: S3ByteRange): number {
  return range.end - range.start + 1;
}

function buildContentRange(range: S3ByteRange, totalSize: number): string {
  return `bytes ${range.start}-${range.end}/${totalSize}`;
}

function isExpectedS3RangeDownload(file: S3RangeDownload, range: S3ByteRange, totalSize: number): boolean {
  const expectedLength = getRangeContentLength(range);
  return (
    file.contentRange === buildContentRange(range, totalSize) &&
    file.contentLength === expectedLength &&
    file.body.byteLength === expectedLength
  );
}

async function maybeServeS3Bundle(
  artifactKey: string | undefined,
  requestHeaders: Headers,
  executionId: string,
  observation: AuthenticatedDownloadObservation,
): Promise<Response | null> {
  const targetAwsRuntime = isTargetAwsRuntime();
  if (!artifactKey) {
    return targetAwsRuntime
      ? observeAuthenticatedDownloadFailure(
          artifactErrorResponse(ErrorCode.BUNDLE_NOT_FOUND, 404, 'Bundle not found'),
          observation,
          'no_such_key',
        )
      : null;
  }
  if (!isS3UploadEnabled()) {
    return targetAwsRuntime
      ? observeAuthenticatedDownloadFailure(
          artifactErrorResponse(ErrorCode.BUNDLE_DOWNLOAD_FAILED, 500, 'Failed to load bundle'),
          observation,
          'not_applicable',
        )
      : null;
  }

  let totalSize: number;
  try {
    ({ contentLength: totalSize } = await headS3Object(artifactKey));
  } catch (error) {
    const failure = resolveS3DownloadFailure(error);
    return observeAuthenticatedDownloadFailure(
      failure.status === 404
        ? artifactErrorResponse(ErrorCode.BUNDLE_NOT_FOUND, failure.status, 'Bundle not found')
        : artifactErrorResponse(ErrorCode.BUNDLE_DOWNLOAD_FAILED, failure.status, 'Failed to load bundle'),
      observation,
      failure.s3ErrorCode,
    );
  }

  const rangeHeader = requestHeaders.get('range');
  if (!rangeHeader) {
    if (totalSize > S3_BUNDLE_RANGE_CHUNK_BYTES) {
      return observeAuthenticatedDownloadFailure(
        artifactErrorResponse(
          ErrorCode.BUNDLE_REQUIRES_RANGE_DOWNLOAD,
          413,
          'Bundle requires ranged download',
          buildS3BundleErrorHeaders({
            'Content-Range': `bytes */${totalSize}`,
          }),
        ),
        observation,
        'not_applicable',
      );
    }

    return maybeServeFromS3(
      artifactKey,
      {
        contentType: 'application/zip',
        contentDisposition: `attachment; filename="${executionId}.zip"`,
        notFoundMessage: 'Bundle not found',
        notFoundError: ErrorCode.BUNDLE_NOT_FOUND,
        failureMessage: 'Failed to load bundle',
        failureError: ErrorCode.BUNDLE_DOWNLOAD_FAILED,
      },
      observation,
    );
  }

  const parsedRange = parseByteRange(rangeHeader, totalSize);
  if (parsedRange === 'invalid') {
    return observeAuthenticatedDownloadFailure(
      artifactErrorResponse(
        ErrorCode.INVALID_RANGE,
        416,
        'Invalid range',
        buildS3BundleErrorHeaders({
          'Content-Range': `bytes */${totalSize}`,
        }),
      ),
      observation,
      'not_applicable',
    );
  }

  try {
    const file = await downloadRangeFromS3(artifactKey, parsedRange);
    if (!isExpectedS3RangeDownload(file, parsedRange, totalSize)) {
      return observeAuthenticatedDownloadFailure(
        artifactErrorResponse(ErrorCode.BUNDLE_DOWNLOAD_FAILED, 500, 'Failed to load bundle'),
        observation,
        'unknown',
      );
    }
    const headers = buildS3BundleHeaders(executionId, {
      'Content-Range': buildContentRange(parsedRange, totalSize),
      'Content-Length': String(getRangeContentLength(parsedRange)),
    });
    return new Response(Uint8Array.from(file.body), {
      status: 206,
      ...omitUndefinedProperties({ headers: headers }),
    });
  } catch (error) {
    const failure = resolveS3DownloadFailure(error);
    return observeAuthenticatedDownloadFailure(
      failure.status === 404
        ? artifactErrorResponse(ErrorCode.BUNDLE_NOT_FOUND, failure.status, 'Bundle not found')
        : artifactErrorResponse(ErrorCode.BUNDLE_DOWNLOAD_FAILED, failure.status, 'Failed to load bundle'),
      observation,
      failure.s3ErrorCode,
    );
  }
}

async function maybeServeFromS3(
  artifactKey: string | undefined,
  options: S3ServeOptions,
  observation: AuthenticatedDownloadObservation,
): Promise<Response | null> {
  const targetAwsRuntime = isTargetAwsRuntime();
  if (!artifactKey) {
    return targetAwsRuntime
      ? observeAuthenticatedDownloadFailure(
          artifactErrorResponse(options.notFoundError, 404, options.notFoundMessage),
          observation,
          'no_such_key',
        )
      : null;
  }
  if (!isS3UploadEnabled()) {
    return targetAwsRuntime
      ? observeAuthenticatedDownloadFailure(
          artifactErrorResponse(options.failureError, 500, options.failureMessage),
          observation,
          'not_applicable',
        )
      : null;
  }

  if (options.maxInlineBytes !== undefined) {
    try {
      const { contentLength } = await headS3Object(artifactKey);
      if (contentLength > options.maxInlineBytes) {
        return observeAuthenticatedDownloadFailure(
          artifactErrorResponse(
            options.tooLargeError ?? options.failureError,
            413,
            options.tooLargeMessage ?? options.failureMessage,
            {
              'Cache-Control': 'no-store',
            },
          ),
          observation,
          'not_applicable',
        );
      }
    } catch (error) {
      const failure = resolveS3DownloadFailure(error);
      return observeAuthenticatedDownloadFailure(
        failure.status === 404
          ? artifactErrorResponse(options.notFoundError, failure.status, options.notFoundMessage)
          : artifactErrorResponse(options.failureError, failure.status, options.failureMessage),
        observation,
        failure.s3ErrorCode,
      );
    }
  }

  try {
    const file = await downloadFromS3(artifactKey);
    return new Response(Uint8Array.from(file), {
      headers: {
        'Content-Type': options.contentType,
        'Content-Disposition': options.contentDisposition,
        'Cache-Control': 'no-store',
      },
    });
  } catch (error) {
    const failure = resolveS3DownloadFailure(error);
    return observeAuthenticatedDownloadFailure(
      failure.status === 404
        ? artifactErrorResponse(options.notFoundError, failure.status, options.notFoundMessage)
        : artifactErrorResponse(options.failureError, failure.status, options.failureMessage),
      observation,
      failure.s3ErrorCode,
    );
  }
}

/**
 * Serve a verification bundle archive from local storage.
 */
export async function getVerificationBundleHandler({
  request,
  store,
  params,
}: ApiContext<{ sessionId: string; executionId: string }>): Promise<Response> {
  const sessionId = params?.sessionId;
  const executionId = params?.executionId;

  if (!sessionId || !executionId || !isSafeSegment(sessionId) || !isSafeSegment(executionId)) {
    return artifactErrorResponse(ErrorCode.INVALID_BUNDLE_REFERENCE, 400, 'Invalid bundle reference');
  }

  const capabilityResult = validateSessionCapabilityForSession(request.headers, sessionId);
  if (capabilityResult instanceof Response) {
    return capabilityResult;
  }

  const defaultObservation = createAuthenticatedDownloadObservation('bundle', sessionId, executionId);
  const executionScope = await ensureExecutionScope(store, sessionId, executionId);
  if (!executionScope.ok) {
    return observeAuthenticatedDownloadFailure(executionScope.response, defaultObservation, executionScope.s3ErrorCode);
  }

  const s3BundleKey = executionScope.finalizationResult.s3BundleKey;
  const s3Observation = createAuthenticatedDownloadObservation('bundle', sessionId, executionId, s3BundleKey);
  const s3Response = await maybeServeS3Bundle(s3BundleKey, request.headers, executionId, s3Observation);
  if (s3Response) {
    return s3Response;
  }

  const archivePath = path.join(getBundleBaseDir(), sessionId, executionId, 'bundle.zip');

  try {
    const file = await fs.readFile(archivePath);
    const rangeHeader = request.headers.get('range');
    if (rangeHeader) {
      const parsedRange = parseByteRange(rangeHeader, file.byteLength);
      if (parsedRange === 'invalid') {
        return observeAuthenticatedDownloadFailure(
          artifactErrorResponse(
            ErrorCode.INVALID_RANGE,
            416,
            'Invalid range',
            buildS3BundleErrorHeaders({
              'Content-Range': `bytes */${file.byteLength}`,
            }),
          ),
          defaultObservation,
          'not_applicable',
        );
      }
      return new Response(Uint8Array.from(file.subarray(parsedRange.start, parsedRange.end + 1)), {
        status: 206,
        headers: buildS3BundleHeaders(executionId, {
          'Content-Range': buildContentRange(parsedRange, file.byteLength),
          'Content-Length': String(getRangeContentLength(parsedRange)),
        }),
      });
    }
    return new Response(Uint8Array.from(file), {
      headers: {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="${executionId}.zip"`,
        'Cache-Control': 'no-store',
      },
    });
  } catch (error) {
    if (getStringProperty(error, 'code') === 'ENOENT') {
      return observeAuthenticatedDownloadFailure(
        artifactErrorResponse(ErrorCode.BUNDLE_NOT_FOUND, 404, 'Bundle not found'),
        defaultObservation,
        'no_such_key',
      );
    }

    return observeAuthenticatedDownloadFailure(
      artifactErrorResponse(ErrorCode.BUNDLE_DOWNLOAD_FAILED, 500, 'Failed to load bundle'),
      defaultObservation,
      'not_applicable',
    );
  }
}

/**
 * Serve a verification report from local storage.
 */
export async function getVerificationReportHandler({
  request,
  store,
  params,
}: ApiContext<{ sessionId: string; executionId: string }>): Promise<Response> {
  const sessionId = params?.sessionId;
  const executionId = params?.executionId;

  if (!sessionId || !executionId || !isSafeSegment(sessionId) || !isSafeSegment(executionId)) {
    return artifactErrorResponse(ErrorCode.INVALID_BUNDLE_REFERENCE, 400, 'Invalid bundle reference');
  }

  const capabilityResult = validateSessionCapabilityForSession(request.headers, sessionId);
  if (capabilityResult instanceof Response) {
    return capabilityResult;
  }

  const defaultObservation = createAuthenticatedDownloadObservation('report', sessionId, executionId);
  const executionScope = await ensureExecutionScope(store, sessionId, executionId);
  if (!executionScope.ok) {
    return observeAuthenticatedDownloadFailure(executionScope.response, defaultObservation, executionScope.s3ErrorCode);
  }

  const s3ReportKey = getStringField(executionScope.finalizationResult.verificationResult, 's3ReportKey');
  const s3Observation = createAuthenticatedDownloadObservation('report', sessionId, executionId, s3ReportKey);
  const s3Response = await maybeServeFromS3(
    s3ReportKey,
    {
      contentType: 'application/json',
      contentDisposition: `inline; filename="${executionId}-verification.json"`,
      notFoundMessage: 'Report not found',
      notFoundError: ErrorCode.REPORT_NOT_FOUND,
      failureMessage: 'Failed to load report',
      failureError: ErrorCode.REPORT_DOWNLOAD_FAILED,
      maxInlineBytes: S3_REPORT_INLINE_MAX_BYTES,
      tooLargeMessage: 'Report exceeds authenticated download limit',
      tooLargeError: ErrorCode.REPORT_DOWNLOAD_TOO_LARGE,
    },
    s3Observation,
  );
  if (s3Response) {
    return s3Response;
  }

  const reportPath = path.join(getBundleBaseDir(), sessionId, executionId, 'verification.json');

  try {
    const file = await fs.readFile(reportPath, 'utf-8');
    return new Response(file, {
      headers: {
        'Content-Type': 'application/json',
        'Content-Disposition': `inline; filename="${executionId}-verification.json"`,
        'Cache-Control': 'no-store',
      },
    });
  } catch (error) {
    if (getStringProperty(error, 'code') === 'ENOENT') {
      return observeAuthenticatedDownloadFailure(
        artifactErrorResponse(ErrorCode.REPORT_NOT_FOUND, 404, 'Report not found'),
        defaultObservation,
        'no_such_key',
      );
    }

    return observeAuthenticatedDownloadFailure(
      artifactErrorResponse(ErrorCode.REPORT_DOWNLOAD_FAILED, 500, 'Failed to load report'),
      defaultObservation,
      'not_applicable',
    );
  }
}
