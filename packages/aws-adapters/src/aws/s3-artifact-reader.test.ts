import { describe, expect, it, vi } from 'vitest';
import { createS3ArtifactReader, type S3ArtifactReaderDependencies } from './s3-artifact-reader';
import { asFinalizationId } from '@stark-ballot/application/finalize/finalization-id';
import { asSessionId } from '@stark-ballot/domain/types/identifiers';
import { targetRuntimeProfile } from '@stark-ballot/runtime-config/env/test-support/runtimeProfileFixtures';

const targetProfile = targetRuntimeProfile();
const TEST_LIMITS = {
  bundleInlineMaxBytes: 8,
  bundleRangeMaxBytes: 4,
  reportMaxBytes: 8,
};

function createDependencies(overrides: Partial<S3ArtifactReaderDependencies> = {}): S3ArtifactReaderDependencies {
  return {
    headObject: vi.fn().mockResolvedValue({
      contentLength: 4,
      etag: '"etag-1"',
      versionId: 'version-1',
    }),
    readObject: vi.fn().mockResolvedValue({
      body: Buffer.from([1, 2, 3, 4]),
      contentLength: 4,
      etag: '"etag-1"',
      versionId: 'version-1',
    }),
    readRange: vi.fn().mockResolvedValue({
      body: Buffer.from([1, 2, 3, 4]),
      contentLength: 4,
      contentRange: 'bytes 0-3/10',
      etag: '"etag-1"',
      versionId: 'version-1',
    }),
    ...overrides,
  };
}

describe('S3 artifact reader', () => {
  const sessionId = asSessionId('session-1');
  const finalizationId = asFinalizationId('finalization-1');

  it('returns exact report bytes from the canonical finalization key', async () => {
    const dependencies = createDependencies();
    const reader = createS3ArtifactReader({
      profile: targetProfile,
      dependencies,
      limits: TEST_LIMITS,
    });

    const result = await reader.read({
      artifact: 'report',
      sessionId,
      finalizationId,
    });

    expect(dependencies.headObject).toHaveBeenCalledWith(`sessions/${sessionId}/${finalizationId}/verification.json`);
    expect(dependencies.readObject).toHaveBeenCalledWith(`sessions/${sessionId}/${finalizationId}/verification.json`, {
      contentLength: 4,
      etag: '"etag-1"',
      versionId: 'version-1',
    });
    expect(result).toEqual({
      kind: 'full',
      bytes: Uint8Array.from([1, 2, 3, 4]),
      totalBytes: 4,
      representation: {
        etag: '"etag-1"',
        versionId: 'version-1',
      },
    });
  });

  it('clamps bundle ranges and rejects inconsistent S3 response metadata', async () => {
    const dependencies = createDependencies({
      headObject: vi.fn().mockResolvedValue({
        contentLength: 10,
        etag: '"etag-1"',
        versionId: 'version-1',
      }),
    });
    const reader = createS3ArtifactReader({
      profile: targetProfile,
      dependencies,
      limits: TEST_LIMITS,
    });

    await expect(
      reader.read({
        artifact: 'bundle',
        sessionId,
        finalizationId,
        range: { kind: 'openEnded', start: 0 },
      }),
    ).resolves.toEqual({
      kind: 'range',
      bytes: Uint8Array.from([1, 2, 3, 4]),
      totalBytes: 10,
      start: 0,
      end: 3,
      representation: {
        etag: '"etag-1"',
        versionId: 'version-1',
      },
    });
    expect(dependencies.readRange).toHaveBeenCalledWith(
      `sessions/${sessionId}/${finalizationId}/bundle.zip`,
      {
        start: 0,
        end: 3,
      },
      {
        contentLength: 10,
        etag: '"etag-1"',
        versionId: 'version-1',
      },
    );

    vi.mocked(dependencies.readRange).mockResolvedValueOnce({
      body: Buffer.from([1, 2, 3]),
      contentLength: 3,
      contentRange: 'bytes 0-2/10',
      etag: '"etag-2"',
      versionId: 'version-1',
    });
    await expect(
      reader.read({
        artifact: 'bundle',
        sessionId,
        finalizationId,
        range: { kind: 'closed', start: 0, end: 3 },
      }),
    ).resolves.toEqual({
      kind: 'unavailable',
      failureKind: 'unknown',
    });
  });

  it('returns bounded failures without downloading or falling through', async () => {
    const readObject = vi.fn();
    const readRange = vi.fn();
    const oversized = createS3ArtifactReader({
      profile: targetProfile,
      dependencies: createDependencies({
        headObject: vi.fn().mockResolvedValue({ contentLength: 9, etag: '"etag-1"' }),
        readObject,
        readRange,
      }),
      limits: TEST_LIMITS,
    });

    await expect(
      oversized.read({
        artifact: 'report',
        sessionId,
        finalizationId,
      }),
    ).resolves.toEqual({ kind: 'tooLarge', totalBytes: 9 });
    await expect(
      oversized.read({
        artifact: 'bundle',
        sessionId,
        finalizationId,
        range: { kind: 'invalid' },
      }),
    ).resolves.toEqual({ kind: 'invalidRange', totalBytes: 9 });
    expect(readObject).not.toHaveBeenCalled();
    expect(readRange).not.toHaveBeenCalled();
  });

  it('rejects an object without a stable representation identity before downloading it', async () => {
    const readObject = vi.fn();
    const readRange = vi.fn();
    const reader = createS3ArtifactReader({
      profile: targetProfile,
      dependencies: createDependencies({
        headObject: vi.fn().mockResolvedValue({ contentLength: 4 }),
        readObject,
        readRange,
      }),
      limits: TEST_LIMITS,
    });

    await expect(
      reader.read({
        artifact: 'bundle',
        sessionId,
        finalizationId,
      }),
    ).resolves.toEqual({
      kind: 'unavailable',
      failureKind: 'unknown',
    });
    expect(readObject).not.toHaveBeenCalled();
    expect(readRange).not.toHaveBeenCalled();
  });

  it.each([
    [{ name: 'NoSuchKey' }, { kind: 'notFound' }],
    [{ Code: 'AccessDenied' }, { kind: 'unavailable', failureKind: 'accessDenied' }],
    [{ code: 'RequestTimeout' }, { kind: 'unavailable', failureKind: 'timeout' }],
    [{ name: 'SlowDown' }, { kind: 'unavailable', failureKind: 'throttled' }],
    [new Error('private s3://bucket/key'), { kind: 'unavailable', failureKind: 'unknown' }],
  ] as const)('normalizes storage failure %# without exposing its details', async (failure, expected) => {
    const reader = createS3ArtifactReader({
      profile: targetProfile,
      dependencies: createDependencies({
        headObject: vi.fn().mockRejectedValue(failure),
      }),
      limits: TEST_LIMITS,
    });

    await expect(
      reader.read({
        artifact: 'bundle',
        sessionId,
        finalizationId,
      }),
    ).resolves.toEqual(expected);
  });
});
