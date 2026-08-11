import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createVerificationBundleArchive, type VerificationBundleArchivePolicy } from './verification-bundle';
import { createLocalArtifactReader } from './local-artifact-reader';

const KiB = 1024;

const SYNC_BUNDLE_POLICY: VerificationBundleArchivePolicy = {
  mode: 'sync',
  requiredMembers: [
    'public-input.json',
    'election-manifest.json',
    'close-statement.json',
    'receipt.json',
    'journal.json',
    'metadata.json',
  ],
  optionalMembers: ['sth.json', 'consistency-proof.json'],
  knownPublicMembers: [
    'public-input.json',
    'election-manifest.json',
    'close-statement.json',
    'receipt.json',
    'journal.json',
    'metadata.json',
    'sth.json',
    'consistency-proof.json',
  ],
  neverPublicMembers: ['input.json', 'verification.json', 'included-bitmap.json', 'seen-bitmap.json'],
};

const TEST_LIMITS = {
  bundleInlineMaxBytes: 64 * KiB,
  bundleRangeMaxBytes: 8,
  reportMaxBytes: 16,
};

describe('local artifact reader', () => {
  let baseDir: string;
  const sessionId = 'session-1';
  const finalizationId = 'finalization-1';

  beforeEach(async () => {
    baseDir = await mkdtemp(path.join(os.tmpdir(), 'local-artifact-reader-'));
  });

  afterEach(async () => {
    await rm(baseDir, { recursive: true, force: true });
  });

  async function createValidBundle(): Promise<Buffer> {
    const bundleDir = path.join(baseDir, sessionId, finalizationId);
    await mkdir(bundleDir, { recursive: true });
    await Promise.all(
      SYNC_BUNDLE_POLICY.requiredMembers.map((member) =>
        writeFile(path.join(bundleDir, member), JSON.stringify({ member })),
      ),
    );
    const archivePath = await createVerificationBundleArchive(bundleDir, {
      policy: SYNC_BUNDLE_POLICY,
    });
    return await import('node:fs/promises').then(({ readFile }) => readFile(archivePath));
  }

  function createReader(overrides: Partial<typeof TEST_LIMITS> = {}) {
    return createLocalArtifactReader({
      baseDir,
      bundlePolicy: SYNC_BUNDLE_POLICY,
      limits: { ...TEST_LIMITS, ...overrides },
    });
  }

  it('returns exact admitted bundle bytes for a bounded range', async () => {
    const archive = await createValidBundle();
    const reader = createReader();

    const result = await reader.read({
      artifact: 'bundle',
      sessionId,
      finalizationId,
      range: { kind: 'closed', start: 1, end: 100 },
    });

    expect(result).toMatchObject({
      kind: 'range',
      totalBytes: archive.byteLength,
      start: 1,
      end: 8,
    });
    if (result.kind !== 'range') {
      throw new Error('Expected ranged artifact result');
    }
    expect(result.representation.etag).toMatch(/^"[0-9a-f]{64}"$/);
    expect(Buffer.from(result.bytes)).toEqual(archive.subarray(1, 9));
  });

  it('returns exact report bytes without UTF-8 reserialization', async () => {
    const reportBytes = Buffer.from([0xff, 0x00, 0x7b, 0x7d]);
    const bundleDir = path.join(baseDir, sessionId, finalizationId);
    await mkdir(bundleDir, { recursive: true });
    await writeFile(path.join(bundleDir, 'verification.json'), reportBytes);

    const result = await createReader().read({
      artifact: 'report',
      sessionId,
      finalizationId,
    });

    expect(result).toMatchObject({
      kind: 'full',
      totalBytes: reportBytes.byteLength,
    });
    if (result.kind !== 'full') {
      throw new Error('Expected full artifact result');
    }
    expect(Buffer.from(result.bytes)).toEqual(reportBytes);
  });

  it('enforces bundle and report inline limits before returning bytes', async () => {
    const archive = await createValidBundle();
    const bundleDir = path.join(baseDir, sessionId, finalizationId);
    await writeFile(path.join(bundleDir, 'verification.json'), Buffer.alloc(17));
    const reader = createReader({ bundleInlineMaxBytes: archive.byteLength - 1 });

    await expect(
      reader.read({
        artifact: 'bundle',
        sessionId,
        finalizationId,
      }),
    ).resolves.toEqual({
      kind: 'tooLarge',
      totalBytes: archive.byteLength,
    });
    await expect(
      reader.read({
        artifact: 'report',
        sessionId,
        finalizationId,
      }),
    ).resolves.toEqual({
      kind: 'tooLarge',
      totalBytes: 17,
    });
  });

  it('normalizes invalid ranges, missing files, unsafe identities, and malformed archives', async () => {
    const archive = await createValidBundle();
    const reader = createReader();

    await expect(
      reader.read({
        artifact: 'bundle',
        sessionId,
        finalizationId,
        range: { kind: 'closed', start: archive.byteLength, end: archive.byteLength + 1 },
      }),
    ).resolves.toEqual({
      kind: 'invalidRange',
      totalBytes: archive.byteLength,
    });
    await expect(
      reader.read({
        artifact: 'report',
        sessionId,
        finalizationId,
      }),
    ).resolves.toEqual({ kind: 'notFound' });
    await expect(
      reader.read({
        artifact: 'bundle',
        sessionId: '../other-session',
        finalizationId,
      }),
    ).resolves.toEqual({
      kind: 'unavailable',
      failureKind: 'unknown',
    });

    await writeFile(path.join(baseDir, sessionId, finalizationId, 'bundle.zip'), 'not-a-zip');
    await expect(
      reader.read({
        artifact: 'bundle',
        sessionId,
        finalizationId,
        range: { kind: 'suffix', length: 1 },
      }),
    ).resolves.toEqual({
      kind: 'unavailable',
      failureKind: 'unknown',
    });
  });
});
