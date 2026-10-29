import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { isSafeVerifierSegment } from '@stark-ballot/validation/safe-verifier-segment';
import { inspectVerificationBundleArchiveBuffer, type VerificationBundleArchivePolicy } from './verification-bundle';

export interface ArtifactReaderLimits {
  bundleInlineMaxBytes: number;
  bundleRangeMaxBytes: number;
  reportMaxBytes: number;
}

export type LocalArtifactRangeRequest =
  | { kind: 'closed'; start: number; end: number }
  | { kind: 'openEnded'; start: number }
  | { kind: 'suffix'; length: number }
  | { kind: 'invalid' };

export interface LocalArtifactReadRequest {
  artifact: 'bundle' | 'report';
  sessionId: string;
  finalizationId: string;
  range?: LocalArtifactRangeRequest;
}

export type LocalArtifactReadResult =
  | {
      kind: 'full';
      bytes: Uint8Array;
      totalBytes: number;
      representation: { etag?: string; versionId?: string };
    }
  | {
      kind: 'range';
      bytes: Uint8Array;
      totalBytes: number;
      start: number;
      end: number;
      representation: { etag?: string; versionId?: string };
    }
  | { kind: 'notFound' }
  | { kind: 'invalidRange'; totalBytes: number }
  | { kind: 'tooLarge'; totalBytes: number }
  | { kind: 'unavailable'; failureKind: 'accessDenied' | 'timeout' | 'throttled' | 'unknown' };

export interface LocalArtifactReaderOptions {
  baseDir: string;
  bundlePolicy: VerificationBundleArchivePolicy;
  limits: ArtifactReaderLimits;
}

export interface LocalArtifactReader {
  read: (request: LocalArtifactReadRequest) => Promise<LocalArtifactReadResult>;
}

export interface ResolvedArtifactRange {
  start: number;
  end: number;
}

function isMissingFileError(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === 'ENOENT'
  );
}

function assertPositiveSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive safe integer`);
  }
}

export function assertValidArtifactReaderLimits(limits: ArtifactReaderLimits): void {
  assertPositiveSafeInteger(limits.bundleInlineMaxBytes, 'bundleInlineMaxBytes');
  assertPositiveSafeInteger(limits.bundleRangeMaxBytes, 'bundleRangeMaxBytes');
  assertPositiveSafeInteger(limits.reportMaxBytes, 'reportMaxBytes');
}

export function resolveArtifactRange(
  requested: LocalArtifactRangeRequest,
  totalBytes: number,
  maxRangeBytes: number,
): ResolvedArtifactRange | null {
  if (requested.kind === 'invalid' || totalBytes <= 0) {
    return null;
  }

  if (requested.kind === 'suffix') {
    if (!Number.isSafeInteger(requested.length) || requested.length <= 0) {
      return null;
    }
    const length = Math.min(requested.length, totalBytes, maxRangeBytes);
    return { start: totalBytes - length, end: totalBytes - 1 };
  }

  const start = requested.start;
  const requestedEnd = requested.kind === 'closed' ? requested.end : totalBytes - 1;
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(requestedEnd) ||
    start < 0 ||
    requestedEnd < start ||
    start >= totalBytes
  ) {
    return null;
  }

  return {
    start,
    end: Math.min(requestedEnd, totalBytes - 1, start + maxRangeBytes - 1),
  };
}

function artifactFileName(artifact: LocalArtifactReadRequest['artifact']): 'bundle.zip' | 'verification.json' {
  return artifact === 'bundle' ? 'bundle.zip' : 'verification.json';
}

function isExpectedRealPath(configuredPath: string, realPath: string, baseDir: string): boolean {
  const expectedPath = path.resolve(configuredPath);
  const relative = path.relative(baseDir, realPath);
  return realPath === expectedPath && relative.length > 0 && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function representationFor(bytes: Buffer): { etag: string } {
  return { etag: `"${createHash('sha256').update(bytes).digest('hex')}"` };
}

type ArtifactReadFailure = Extract<LocalArtifactReadResult, { kind: 'notFound' | 'unavailable' }>;

function artifactReadFailure(error: unknown): ArtifactReadFailure {
  return isMissingFileError(error) ? { kind: 'notFound' } : { kind: 'unavailable', failureKind: 'unknown' };
}

async function readArtifactMetadata(
  configuredPath: string,
  baseDir: string,
): Promise<{ kind: 'ready'; realPath: string; totalBytes: number } | ArtifactReadFailure> {
  let realPath: string;
  try {
    realPath = await fs.realpath(configuredPath);
  } catch (error) {
    return artifactReadFailure(error);
  }
  if (!isExpectedRealPath(configuredPath, realPath, baseDir)) {
    return { kind: 'unavailable', failureKind: 'unknown' };
  }

  let totalBytes: number;
  try {
    const metadata = await fs.stat(realPath);
    if (!metadata.isFile() || !Number.isSafeInteger(metadata.size) || metadata.size < 0) {
      return { kind: 'unavailable', failureKind: 'unknown' };
    }
    totalBytes = metadata.size;
  } catch (error) {
    return artifactReadFailure(error);
  }

  return { kind: 'ready', realPath, totalBytes };
}

export function admitArtifactReadSize(
  request: LocalArtifactReadRequest,
  totalBytes: number,
  limits: ArtifactReaderLimits,
): Extract<LocalArtifactReadResult, { kind: 'tooLarge' | 'invalidRange' }> | null {
  if (
    request.range === undefined &&
    totalBytes > (request.artifact === 'bundle' ? limits.bundleInlineMaxBytes : limits.reportMaxBytes)
  ) {
    return { kind: 'tooLarge', totalBytes };
  }
  if (request.artifact === 'report' && request.range !== undefined) {
    return { kind: 'invalidRange', totalBytes };
  }

  return null;
}

async function readAdmittedArtifactBytes(
  realPath: string,
  totalBytes: number,
  artifact: LocalArtifactReadRequest['artifact'],
  options: Pick<LocalArtifactReaderOptions, 'bundlePolicy'>,
): Promise<{ kind: 'ready'; bytes: Buffer } | ArtifactReadFailure> {
  let bytes: Buffer;
  try {
    bytes = await fs.readFile(realPath);
  } catch (error) {
    return artifactReadFailure(error);
  }
  if (bytes.byteLength !== totalBytes) {
    return { kind: 'unavailable', failureKind: 'unknown' };
  }

  if (artifact === 'bundle') {
    try {
      await inspectVerificationBundleArchiveBuffer(bytes, options.bundlePolicy);
    } catch {
      return { kind: 'unavailable', failureKind: 'unknown' };
    }
  }

  return { kind: 'ready', bytes };
}

function projectArtifactRead(
  request: LocalArtifactReadRequest,
  bytes: Buffer,
  totalBytes: number,
  maxRangeBytes: number,
): LocalArtifactReadResult {
  const representation = representationFor(bytes);
  if (request.range === undefined) {
    return {
      kind: 'full',
      bytes: Uint8Array.from(bytes),
      totalBytes,
      representation,
    };
  }

  const range = resolveArtifactRange(request.range, totalBytes, maxRangeBytes);
  if (!range) {
    return { kind: 'invalidRange', totalBytes };
  }
  return {
    kind: 'range',
    bytes: Uint8Array.from(bytes.subarray(range.start, range.end + 1)),
    totalBytes,
    start: range.start,
    end: range.end,
    representation,
  };
}

export function createLocalArtifactReader(options: LocalArtifactReaderOptions): LocalArtifactReader {
  const baseDir = path.resolve(options.baseDir);
  assertValidArtifactReaderLimits(options.limits);

  return {
    async read(request): Promise<LocalArtifactReadResult> {
      if (!isSafeVerifierSegment(request.sessionId) || !isSafeVerifierSegment(request.finalizationId)) {
        return { kind: 'unavailable', failureKind: 'unknown' };
      }
      const configuredPath = path.join(
        baseDir,
        request.sessionId,
        request.finalizationId,
        artifactFileName(request.artifact),
      );
      const metadata = await readArtifactMetadata(configuredPath, baseDir);
      if (metadata.kind !== 'ready') return metadata;
      const sizeFailure = admitArtifactReadSize(request, metadata.totalBytes, options.limits);
      if (sizeFailure) return sizeFailure;
      const content = await readAdmittedArtifactBytes(
        metadata.realPath,
        metadata.totalBytes,
        request.artifact,
        options,
      );
      if (content.kind !== 'ready') return content;
      return projectArtifactRead(request, content.bytes, metadata.totalBytes, options.limits.bundleRangeMaxBytes);
    },
  };
}
