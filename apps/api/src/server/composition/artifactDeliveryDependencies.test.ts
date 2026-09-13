import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ArtifactReader } from '@stark-ballot/application/verification/artifact-reader';
import {
  localRuntimeProfile,
  targetRuntimeProfile,
} from '@stark-ballot/runtime-config/env/test-support/runtimeProfileFixtures';

const readerMocks = vi.hoisted(() => ({
  createLocalArtifactReader: vi.fn(),
  createS3ArtifactReader: vi.fn(),
}));

vi.mock('@stark-ballot/node-adapters/artifact-reader', () => ({
  createLocalArtifactReader: readerMocks.createLocalArtifactReader,
}));

vi.mock('@stark-ballot/aws-adapters/aws/s3-artifact-reader', () => ({
  createS3ArtifactReader: readerMocks.createS3ArtifactReader,
}));

function fakeReader(): ArtifactReader {
  return {
    read: vi.fn().mockResolvedValue({ kind: 'notFound' }),
  };
}

describe('artifact delivery composition', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('selects only the local reader for the injected local profile', async () => {
    const localReader = fakeReader();
    readerMocks.createLocalArtifactReader.mockReturnValue(localReader);

    const { createArtifactDeliveryDependencies } = await import('./artifactDeliveryDependencies');
    const dependencies = createArtifactDeliveryDependencies(localRuntimeProfile());

    expect(dependencies.artifactReader).toBe(localReader);
    expect(readerMocks.createLocalArtifactReader).toHaveBeenCalledOnce();
    const localOptions: unknown = readerMocks.createLocalArtifactReader.mock.calls[0]?.[0];
    expect(localOptions).toMatchObject({ bundlePolicy: { mode: 'sync' } });
    expect(readerMocks.createS3ArtifactReader).not.toHaveBeenCalled();
  });

  it('selects only the S3 reader for the injected target profile', async () => {
    const s3Reader = fakeReader();
    readerMocks.createS3ArtifactReader.mockReturnValue(s3Reader);

    const { createArtifactDeliveryDependencies } = await import('./artifactDeliveryDependencies');
    const dependencies = createArtifactDeliveryDependencies(targetRuntimeProfile());

    expect(dependencies.artifactReader).toBe(s3Reader);
    expect(readerMocks.createS3ArtifactReader).toHaveBeenCalledOnce();
    expect(readerMocks.createLocalArtifactReader).not.toHaveBeenCalled();
  });

  it('uses an explicit test override without constructing either backend', async () => {
    const override = fakeReader();
    const { createArtifactDeliveryDependencies } = await import('./artifactDeliveryDependencies');

    const dependencies = createArtifactDeliveryDependencies(localRuntimeProfile(), { artifactReader: override });

    expect(dependencies.artifactReader).toBe(override);
    expect(readerMocks.createS3ArtifactReader).not.toHaveBeenCalled();
    expect(readerMocks.createLocalArtifactReader).not.toHaveBeenCalled();
  });
});
