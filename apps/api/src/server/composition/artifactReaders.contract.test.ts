import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ArtifactReader } from '@stark-ballot/application/verification/artifact-reader';
import {
  createS3ArtifactReader,
  type S3ArtifactReaderDependencies,
} from '@stark-ballot/aws-adapters/aws/s3-artifact-reader';
import { createLocalArtifactReader } from '@stark-ballot/node-adapters/artifact-reader';
import { createVerificationBundleArchive } from '@stark-ballot/node-adapters/verification-bundle';
import { resolveRuntimeProfile } from '@stark-ballot/runtime-config/env/runtimeProfile';
import { targetRuntimeProfileEnv } from '@stark-ballot/runtime-config/env/test-support/runtimeProfileFixtures';
import { resolvePublicBundlePolicy } from '@stark-ballot/verification/public-bundle-manifest';
import { asSessionId } from '@stark-ballot/domain/types/identifiers';
import { asFinalizationId } from '@stark-ballot/application/finalize/finalization-id';

const sessionId = asSessionId('contract-session');
const finalizationId = asFinalizationId('contract-finalization');
const bundleKey = `sessions/${sessionId}/${finalizationId}/bundle.zip`;
const reportKey = `sessions/${sessionId}/${finalizationId}/verification.json`;
const bundlePolicy = resolvePublicBundlePolicy('sync');
const reportBytes = Buffer.from([0xff, 0x00, 0x7b, 0x7d]);

interface ContractLimits {
  bundleInlineMaxBytes: number;
  bundleRangeMaxBytes: number;
  reportMaxBytes: number;
}

interface ReaderFixture {
  bundleBytes: Buffer;
  reader: ArtifactReader;
}

type ReaderBackend = 'local' | 's3';

function missingObjectError(): Error {
  return Object.assign(new Error('missing object'), { name: 'NoSuchKey' });
}

async function createReaderFixture(
  backend: ReaderBackend,
  baseDir: string,
  limits: ContractLimits,
  options: { missingReport?: boolean } = {},
): Promise<ReaderFixture> {
  const artifactDir = path.join(baseDir, sessionId, finalizationId);
  await mkdir(artifactDir, { recursive: true });
  await Promise.all(
    bundlePolicy.requiredMembers.map((member) => writeFile(path.join(artifactDir, member), JSON.stringify({ member }))),
  );
  const archivePath = await createVerificationBundleArchive(artifactDir, { policy: bundlePolicy });
  const bundleBytes = await readFile(archivePath);
  if (!options.missingReport) {
    await writeFile(path.join(artifactDir, 'verification.json'), reportBytes);
  }

  if (backend === 'local') {
    return {
      bundleBytes,
      reader: createLocalArtifactReader({
        baseDir,
        bundlePolicy,
        limits,
      }),
    };
  }

  const objects = new Map<string, Buffer>([[bundleKey, bundleBytes]]);
  if (!options.missingReport) {
    objects.set(reportKey, reportBytes);
  }
  const getObject = (key: string): Buffer => {
    const object = objects.get(key);
    if (!object) {
      throw missingObjectError();
    }
    return object;
  };
  const headObject: S3ArtifactReaderDependencies['headObject'] = (key) => {
    const object = getObject(key);
    return Promise.resolve({
      contentLength: object.byteLength,
      etag: `"${key}"`,
      versionId: 'contract-version',
    });
  };
  const readObject: S3ArtifactReaderDependencies['readObject'] = (key) => {
    const object = getObject(key);
    return Promise.resolve({
      body: Buffer.from(object),
      contentLength: object.byteLength,
      etag: `"${key}"`,
      versionId: 'contract-version',
    });
  };
  const readRange: S3ArtifactReaderDependencies['readRange'] = (key, range) => {
    const object = getObject(key);
    const body = object.subarray(range.start, range.end + 1);
    return Promise.resolve({
      body,
      contentLength: body.byteLength,
      contentRange: `bytes ${range.start}-${range.end}/${object.byteLength}`,
      etag: `"${key}"`,
      versionId: 'contract-version',
    });
  };
  const dependencies: S3ArtifactReaderDependencies = {
    headObject,
    readObject,
    readRange,
  };
  return {
    bundleBytes,
    reader: createS3ArtifactReader({
      profile: resolveRuntimeProfile(targetRuntimeProfileEnv()),
      dependencies,
      limits,
    }),
  };
}

describe.each(['local', 's3'] as const)('%s artifact reader contract', (backend) => {
  let baseDir: string;
  const limits: ContractLimits = {
    bundleInlineMaxBytes: 1024 * 1024,
    bundleRangeMaxBytes: 4,
    reportMaxBytes: 1024 * 1024,
  };

  beforeEach(async () => {
    baseDir = await mkdtemp(path.join(os.tmpdir(), `${backend}-artifact-contract-`));
  });

  afterEach(async () => {
    await rm(baseDir, { recursive: true, force: true });
  });

  it('returns the exact full bundle and report bytes', async () => {
    const fixture = await createReaderFixture(backend, baseDir, limits);

    const bundle = await fixture.reader.read({
      artifact: 'bundle',
      sessionId,
      finalizationId,
    });
    const report = await fixture.reader.read({
      artifact: 'report',
      sessionId,
      finalizationId,
    });

    expect(bundle).toMatchObject({ kind: 'full', totalBytes: fixture.bundleBytes.byteLength });
    expect(report).toMatchObject({ kind: 'full', totalBytes: reportBytes.byteLength });
    if (bundle.kind !== 'full' || report.kind !== 'full') {
      throw new Error('Expected full artifact results');
    }
    expect(Buffer.from(bundle.bytes)).toEqual(fixture.bundleBytes);
    expect(Buffer.from(report.bytes)).toEqual(reportBytes);
  });

  it('returns the same bounded range and invalid-range outcomes', async () => {
    const fixture = await createReaderFixture(backend, baseDir, limits);

    const ranged = await fixture.reader.read({
      artifact: 'bundle',
      sessionId,
      finalizationId,
      range: { kind: 'closed', start: 1, end: 100 },
    });
    const invalid = await fixture.reader.read({
      artifact: 'bundle',
      sessionId,
      finalizationId,
      range: {
        kind: 'closed',
        start: fixture.bundleBytes.byteLength,
        end: fixture.bundleBytes.byteLength + 1,
      },
    });

    expect(ranged).toMatchObject({
      kind: 'range',
      totalBytes: fixture.bundleBytes.byteLength,
      start: 1,
      end: 4,
    });
    if (ranged.kind !== 'range') {
      throw new Error('Expected a ranged artifact result');
    }
    expect(Buffer.from(ranged.bytes)).toEqual(fixture.bundleBytes.subarray(1, 5));
    expect(invalid).toEqual({
      kind: 'invalidRange',
      totalBytes: fixture.bundleBytes.byteLength,
    });
  });

  it('enforces full-download limits without returning bytes', async () => {
    const fixture = await createReaderFixture(backend, baseDir, {
      ...limits,
      bundleInlineMaxBytes: 1,
      reportMaxBytes: 1,
    });

    await expect(
      fixture.reader.read({
        artifact: 'bundle',
        sessionId,
        finalizationId,
      }),
    ).resolves.toEqual({
      kind: 'tooLarge',
      totalBytes: fixture.bundleBytes.byteLength,
    });
    await expect(
      fixture.reader.read({
        artifact: 'report',
        sessionId,
        finalizationId,
      }),
    ).resolves.toEqual({
      kind: 'tooLarge',
      totalBytes: reportBytes.byteLength,
    });
  });

  it('returns not-found for an absent report', async () => {
    const fixture = await createReaderFixture(backend, baseDir, limits, { missingReport: true });

    await expect(
      fixture.reader.read({
        artifact: 'report',
        sessionId,
        finalizationId,
      }),
    ).resolves.toEqual({ kind: 'notFound' });
  });
});
