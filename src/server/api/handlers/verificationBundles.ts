import path from 'path';
import { promises as fs } from 'fs';
import type { ApiContext } from '@/server/api/context';
import { jsonResponse } from '@/server/http/response';
import { getStringProperty } from '@/lib/utils/guards';
import {
  downloadFromS3,
  downloadRangeFromS3,
  headS3Object,
  type S3ByteRange,
  type S3RangeDownload,
} from '@/lib/aws/s3-download';
import { isS3UploadEnabled } from '@/lib/aws/s3-upload';
import { validateSessionCapabilityForSession } from '@/server/api/middleware/session';
import {
  buildFailClosedDownloadResponse,
  resolveSupportedFinalizedRead,
} from '@/server/api/utils/currentArtifactAdmission';

const S3_BUNDLE_RANGE_CHUNK_BYTES = 4 * 1024 * 1024;
const S3_REPORT_INLINE_MAX_BYTES = S3_BUNDLE_RANGE_CHUNK_BYTES;

function getBundleBaseDir(): string {
  return process.env.VERIFIER_WORK_DIR ?? path.join(/* turbopackIgnore: true */ process.cwd(), '.verifier-bundles');
}

function isSafeSegment(value: string): boolean {
  return /^[A-Za-z0-9-]+$/.test(value);
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
  | { ok: false; response: Response }
> {
  const session = await store.getSession(sessionId);
  if (!session || !session.finalized) {
    return { ok: false, response: jsonResponse({ error: 'Bundle not found' }, { status: 404 }) };
  }

  const finalizedRead = resolveSupportedFinalizedRead(session);
  if (finalizedRead.artifactState) {
    return {
      ok: false,
      response: buildFailClosedDownloadResponse(finalizedRead.artifactState),
    };
  }

  const finalizationResult = finalizedRead.finalizationResult;
  if (!finalizationResult) {
    return {
      ok: false,
      response: buildFailClosedDownloadResponse('corrupt_or_unreadable'),
    };
  }

  const allowedExecutionId = finalizationResult.verificationExecutionId;
  if (!allowedExecutionId || !isSafeSegment(allowedExecutionId) || allowedExecutionId !== executionId) {
    return { ok: false, response: jsonResponse({ error: 'Bundle not found' }, { status: 404 }) };
  }

  return { ok: true, finalizationResult };
}

interface S3ServeOptions {
  contentType: string;
  contentDisposition: string;
  notFoundMessage: string;
  failureMessage: string;
  maxInlineBytes?: number;
  tooLargeMessage?: string;
}

function resolveS3DownloadFailureStatus(error: unknown): number {
  const code = getStringProperty(error, 'Code') ?? getStringProperty(error, 'code') ?? getStringProperty(error, 'name');
  if (code === 'NoSuchKey' || code === 'NotFound' || code === 'NotFoundError') {
    return 404;
  }

  return 500;
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
): Promise<Response | null> {
  if (!artifactKey || !isS3UploadEnabled()) {
    return null;
  }

  let totalSize: number;
  try {
    ({ contentLength: totalSize } = await headS3Object(artifactKey));
  } catch (error) {
    const status = resolveS3DownloadFailureStatus(error);
    return jsonResponse({ error: status === 404 ? 'Bundle not found' : 'Failed to load bundle' }, { status });
  }

  const rangeHeader = requestHeaders.get('range');
  if (!rangeHeader) {
    if (totalSize > S3_BUNDLE_RANGE_CHUNK_BYTES) {
      return jsonResponse(
        { error: 'Bundle requires ranged download' },
        {
          status: 413,
          headers: buildS3BundleErrorHeaders({
            'Content-Range': `bytes */${totalSize}`,
          }),
        },
      );
    }

    return maybeServeFromS3(artifactKey, {
      contentType: 'application/zip',
      contentDisposition: `attachment; filename="${executionId}.zip"`,
      notFoundMessage: 'Bundle not found',
      failureMessage: 'Failed to load bundle',
    });
  }

  const parsedRange = parseByteRange(rangeHeader, totalSize);
  if (parsedRange === 'invalid') {
    return jsonResponse(
      { error: 'Invalid range' },
      {
        status: 416,
        headers: buildS3BundleErrorHeaders({
          'Content-Range': `bytes */${totalSize}`,
        }),
      },
    );
  }

  try {
    const file = await downloadRangeFromS3(artifactKey, parsedRange);
    if (!isExpectedS3RangeDownload(file, parsedRange, totalSize)) {
      return jsonResponse({ error: 'Failed to load bundle' }, { status: 500 });
    }
    const headers = buildS3BundleHeaders(executionId, {
      'Content-Range': buildContentRange(parsedRange, totalSize),
      'Content-Length': String(getRangeContentLength(parsedRange)),
    });
    return new Response(Uint8Array.from(file.body), {
      status: 206,
      headers,
    });
  } catch (error) {
    const status = resolveS3DownloadFailureStatus(error);
    return jsonResponse({ error: status === 404 ? 'Bundle not found' : 'Failed to load bundle' }, { status });
  }
}

async function maybeServeFromS3(artifactKey: string | undefined, options: S3ServeOptions): Promise<Response | null> {
  if (!artifactKey || !isS3UploadEnabled()) {
    return null;
  }

  if (options.maxInlineBytes !== undefined) {
    try {
      const { contentLength } = await headS3Object(artifactKey);
      if (contentLength > options.maxInlineBytes) {
        return jsonResponse(
          { error: options.tooLargeMessage ?? options.failureMessage },
          {
            status: 413,
            headers: {
              'Cache-Control': 'no-store',
            },
          },
        );
      }
    } catch (error) {
      const status = resolveS3DownloadFailureStatus(error);
      return jsonResponse({ error: status === 404 ? options.notFoundMessage : options.failureMessage }, { status });
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
    const status = resolveS3DownloadFailureStatus(error);
    return jsonResponse({ error: status === 404 ? options.notFoundMessage : options.failureMessage }, { status });
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
    return jsonResponse({ error: 'Invalid bundle reference' }, { status: 400 });
  }

  const capabilityResult = validateSessionCapabilityForSession(request.headers, sessionId);
  if (capabilityResult instanceof Response) {
    return capabilityResult;
  }

  const executionScope = await ensureExecutionScope(store, sessionId, executionId);
  if (!executionScope.ok) {
    return executionScope.response;
  }

  const s3Response = await maybeServeS3Bundle(
    executionScope.finalizationResult.s3BundleKey,
    request.headers,
    executionId,
  );
  if (s3Response) {
    return s3Response;
  }

  const archivePath = path.join(getBundleBaseDir(), sessionId, executionId, 'bundle.zip');

  try {
    const file = await fs.readFile(archivePath);
    return new Response(Uint8Array.from(file), {
      headers: {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="${executionId}.zip"`,
        'Cache-Control': 'no-store',
      },
    });
  } catch (error) {
    if (getStringProperty(error, 'code') === 'ENOENT') {
      return jsonResponse({ error: 'Bundle not found' }, { status: 404 });
    }

    return jsonResponse({ error: 'Failed to load bundle' }, { status: 500 });
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
    return jsonResponse({ error: 'Invalid bundle reference' }, { status: 400 });
  }

  const capabilityResult = validateSessionCapabilityForSession(request.headers, sessionId);
  if (capabilityResult instanceof Response) {
    return capabilityResult;
  }

  const executionScope = await ensureExecutionScope(store, sessionId, executionId);
  if (!executionScope.ok) {
    return executionScope.response;
  }

  const s3Response = await maybeServeFromS3(executionScope.finalizationResult.verificationResult?.s3ReportKey, {
    contentType: 'application/json',
    contentDisposition: `inline; filename="${executionId}-verification.json"`,
    notFoundMessage: 'Report not found',
    failureMessage: 'Failed to load report',
    maxInlineBytes: S3_REPORT_INLINE_MAX_BYTES,
    tooLargeMessage: 'Report exceeds authenticated download limit',
  });
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
      return jsonResponse({ error: 'Report not found' }, { status: 404 });
    }

    return jsonResponse({ error: 'Failed to load report' }, { status: 500 });
  }
}
