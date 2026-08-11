import type {
  ArtifactReader,
  ArtifactReadFailureKind,
  ArtifactReadRequest,
  ArtifactReadResult,
  ArtifactRepresentationIdentity,
} from '@stark-ballot/application/verification/artifact-reader';
import { resolveArtifactRange, type ArtifactReaderLimits } from '@stark-ballot/node-adapters/artifact-reader';
import { getStringProperty } from '@stark-ballot/validation/unknown-value-guards';
import { buildFinalizationArtifactS3Keys } from '../finalize/artifact-key-layout';
import { downloadRangeFromS3, downloadS3Object, headS3Object, type S3ByteRange } from './s3-download';
import { getS3Config } from './s3-client';
import type { ResolvedRuntimeProfile } from '@stark-ballot/runtime-config/env/runtimeProfile';

export interface S3ArtifactObjectMetadata extends ArtifactRepresentationIdentity {
  contentLength: number;
}

export interface S3ArtifactObjectDownload extends ArtifactRepresentationIdentity {
  body: Buffer;
  contentLength?: number;
  contentRange?: string;
}

export interface S3ArtifactReaderDependencies {
  headObject: (key: string) => Promise<S3ArtifactObjectMetadata>;
  readObject: (key: string, representation: ArtifactRepresentationIdentity) => Promise<S3ArtifactObjectDownload>;
  readRange: (
    key: string,
    range: S3ByteRange,
    representation: ArtifactRepresentationIdentity,
  ) => Promise<S3ArtifactObjectDownload>;
}

export interface S3ArtifactReaderOptions {
  dependencies?: S3ArtifactReaderDependencies;
  limits: ArtifactReaderLimits;
  profile: ResolvedRuntimeProfile;
}

function assertPositiveSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive safe integer`);
  }
}

function assertValidLimits(limits: ArtifactReaderLimits): void {
  assertPositiveSafeInteger(limits.bundleInlineMaxBytes, 'bundleInlineMaxBytes');
  assertPositiveSafeInteger(limits.bundleRangeMaxBytes, 'bundleRangeMaxBytes');
  assertPositiveSafeInteger(limits.reportMaxBytes, 'reportMaxBytes');
}

function defaultDependencies(profile: ResolvedRuntimeProfile): S3ArtifactReaderDependencies {
  return {
    headObject: (key) => headS3Object(profile, key),
    readObject: (key, representation) => downloadS3Object(profile, key, representation),
    readRange: (key, range, representation) => downloadRangeFromS3(profile, key, range, representation),
  };
}

function artifactKey(request: ArtifactReadRequest): string {
  const keys = buildFinalizationArtifactS3Keys(request.sessionId, request.finalizationId);
  return request.artifact === 'bundle' ? keys.bundleS3Key : keys.reportS3Key;
}

function classifyS3Failure(error: unknown): ArtifactReadResult {
  const code = getStringProperty(error, 'Code') ?? getStringProperty(error, 'code') ?? getStringProperty(error, 'name');
  if (code === 'NoSuchKey' || code === 'NotFound' || code === 'NotFoundError') {
    return { kind: 'notFound' };
  }

  let failureKind: ArtifactReadFailureKind = 'unknown';
  if (code === 'AccessDenied' || code === 'Forbidden') {
    failureKind = 'accessDenied';
  } else if (code === 'RequestTimeout' || code === 'RequestTimeoutException' || code === 'TimeoutError') {
    failureKind = 'timeout';
  } else if (code === 'SlowDown' || code === 'Throttling' || code === 'ThrottlingException') {
    failureKind = 'throttled';
  }
  return { kind: 'unavailable', failureKind };
}

function hasConsistentIdentity(
  expected: ArtifactRepresentationIdentity,
  actual: ArtifactRepresentationIdentity,
): boolean {
  return (
    (expected.etag === undefined || expected.etag === actual.etag) &&
    (expected.versionId === undefined || expected.versionId === actual.versionId)
  );
}

function hasRepresentationIdentity(identity: ArtifactRepresentationIdentity): boolean {
  return Boolean(identity.etag?.trim() || identity.versionId?.trim());
}

function representationIdentity(
  expected: ArtifactRepresentationIdentity,
  actual: ArtifactRepresentationIdentity,
): ArtifactRepresentationIdentity {
  return {
    ...((actual.etag ?? expected.etag) ? { etag: actual.etag ?? expected.etag } : {}),
    ...((actual.versionId ?? expected.versionId) ? { versionId: actual.versionId ?? expected.versionId } : {}),
  };
}

function matchesFullDownload(download: S3ArtifactObjectDownload, totalBytes: number): boolean {
  return download.body.byteLength === totalBytes && download.contentLength === totalBytes;
}

function matchesRangeDownload(download: S3ArtifactObjectDownload, range: S3ByteRange, totalBytes: number): boolean {
  const expectedLength = range.end - range.start + 1;
  return (
    download.body.byteLength === expectedLength &&
    download.contentLength === expectedLength &&
    download.contentRange === `bytes ${range.start}-${range.end}/${totalBytes}`
  );
}

export function createS3ArtifactReader(options: S3ArtifactReaderOptions): ArtifactReader {
  assertValidLimits(options.limits);
  if (!options.dependencies) {
    getS3Config(options.profile);
  }
  const dependencies = options.dependencies ?? defaultDependencies(options.profile);

  return {
    async read(request): Promise<ArtifactReadResult> {
      let key: string;
      try {
        key = artifactKey(request);
      } catch {
        return { kind: 'unavailable', failureKind: 'unknown' };
      }

      let metadata: S3ArtifactObjectMetadata;
      try {
        metadata = await dependencies.headObject(key);
      } catch (error) {
        return classifyS3Failure(error);
      }
      if (!Number.isSafeInteger(metadata.contentLength) || metadata.contentLength < 0) {
        return { kind: 'unavailable', failureKind: 'unknown' };
      }
      if (!hasRepresentationIdentity(metadata)) {
        return { kind: 'unavailable', failureKind: 'unknown' };
      }
      const totalBytes = metadata.contentLength;

      if (
        request.range === undefined &&
        totalBytes >
          (request.artifact === 'bundle' ? options.limits.bundleInlineMaxBytes : options.limits.reportMaxBytes)
      ) {
        return { kind: 'tooLarge', totalBytes };
      }
      if (request.artifact === 'report' && request.range !== undefined) {
        return { kind: 'invalidRange', totalBytes };
      }

      if (request.range === undefined) {
        let download: S3ArtifactObjectDownload;
        try {
          download = await dependencies.readObject(key, metadata);
        } catch (error) {
          return classifyS3Failure(error);
        }
        if (!matchesFullDownload(download, totalBytes) || !hasConsistentIdentity(metadata, download)) {
          return { kind: 'unavailable', failureKind: 'unknown' };
        }
        return {
          kind: 'full',
          bytes: Uint8Array.from(download.body),
          totalBytes,
          representation: representationIdentity(metadata, download),
        };
      }

      const range = resolveArtifactRange(request.range, totalBytes, options.limits.bundleRangeMaxBytes);
      if (!range) {
        return { kind: 'invalidRange', totalBytes };
      }

      let download: S3ArtifactObjectDownload;
      try {
        download = await dependencies.readRange(key, range, metadata);
      } catch (error) {
        return classifyS3Failure(error);
      }
      if (!matchesRangeDownload(download, range, totalBytes) || !hasConsistentIdentity(metadata, download)) {
        return { kind: 'unavailable', failureKind: 'unknown' };
      }
      return {
        kind: 'range',
        bytes: Uint8Array.from(download.body),
        totalBytes,
        start: range.start,
        end: range.end,
        representation: representationIdentity(metadata, download),
      };
    },
  };
}
