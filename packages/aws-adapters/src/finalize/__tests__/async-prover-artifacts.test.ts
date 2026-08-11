import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { buildDefaultElectionConfig } from '@stark-ballot/zkvm-contract/zkvm/election-config';
import { createTestJournal } from '@stark-ballot/test-support/testing/test-helpers';
import { createTestPublicInputArtifact } from '@stark-ballot/test-support/testing/public-input-artifact';
import { buildCloseStatement, buildElectionManifest } from '@stark-ballot/verification/public-audit-artifacts';
import { admitReceiptPayload } from '@stark-ballot/verification/receipt-normalizer';
import {
  buildAsyncProverArtifactKeys,
  buildAsyncProverFailureMarkerKey,
  buildFinalizationResultFromS3Bundle,
  parseProverFailureMarker,
  readAsyncProverFailureCategory,
  persistAsyncProverInputToS3,
  validateAsyncProverArtifactKeys,
  validateAsyncProverBundleKey,
} from '@stark-ballot/aws-adapters/finalize/async-prover-artifacts';
import type { ZkVMInput } from '@stark-ballot/zkvm-contract/zkvm/types';
import { targetRuntimeProfile } from '@stark-ballot/runtime-config/env/__tests__/runtimeProfileFixtures';

const targetProfile = targetRuntimeProfile();
vi.mock('@stark-ballot/aws-adapters/aws/s3-client', () => ({
  getS3Config: vi.fn(() => ({
    region: 'ap-northeast-1',
    bucket: 'proof-bucket',
    prefix: 'sessions/',
    expectedBucketOwner: '123456789012',
  })),
  getS3Client: vi.fn(),
}));

vi.mock('@stark-ballot/aws-adapters/aws/bundle-restore', () => ({
  restoreReceiptFromS3: vi.fn(),
}));

vi.mock('@stark-ballot/aws-adapters/aws/s3-download', () => ({
  headS3Object: vi.fn(),
  downloadRangeFromS3: vi.fn(),
}));

const zkvmInput: ZkVMInput = {
  electionId: '550e8400-e29b-41d4-a716-446655440000',
  electionConfigHash: '0x' + '1'.repeat(64),
  bulletinRoot: '0x' + '2'.repeat(64),
  treeSize: 1,
  logId: '0x' + '3'.repeat(64),
  timestamp: 1730000000000,
  totalExpected: 1,
  votes: [
    {
      commitment: '0x' + '4'.repeat(64),
      choice: 0,
      random: '0x' + '5'.repeat(64),
      index: 0,
      merklePath: ['0x' + '6'.repeat(64)],
    },
  ],
};

describe('async prover artifacts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('builds deterministic S3 keys under the configured proof prefix', () => {
    const keys = buildAsyncProverArtifactKeys(targetProfile, 'session-1', 'exec-1');

    expect(keys).toEqual({
      inputS3Key: 'sessions/session-1/exec-1/input.json',
      outputS3Prefix: 'sessions/session-1/exec-1',
      bundleS3Key: 'sessions/session-1/exec-1/bundle.zip',
    });
  });

  it('builds the private failure marker key under the canonical execution prefix', () => {
    expect(buildAsyncProverFailureMarkerKey(targetProfile, 'session-1', 'exec-1')).toBe(
      'sessions/session-1/exec-1/failure-marker.json',
    );
  });

  it.each([
    'configuration',
    'input',
    'prover_execution',
    'infrastructure_interruption',
    'artifact',
    'upload',
    'timeout',
    'unknown',
  ] as const)('admits the exact bounded failure marker category %s', (category) => {
    expect(parseProverFailureMarker(Buffer.from(JSON.stringify({ category })))).toBe(category);
  });

  it.each([
    ['extra key', { category: 'artifact', message: 'private failure' }],
    ['legacy schema_version', { schema_version: 1, category: 'artifact' }],
    ['missing category', {}],
    ['open category', { category: 's3://private-bucket/raw-key' }],
  ])('rejects a failure marker with %s', (_label, marker) => {
    expect(parseProverFailureMarker(Buffer.from(JSON.stringify(marker)))).toBeUndefined();
  });

  it('rejects oversized failure markers before parsing their contents', () => {
    const oversized = Buffer.from(JSON.stringify({ category: 'artifact', padding: 'private'.repeat(100) }));
    expect(parseProverFailureMarker(oversized)).toBeUndefined();
  });

  it('bounded-reads a valid private failure marker and returns only its closed category', async () => {
    const { headS3Object, downloadRangeFromS3 } = await import('@stark-ballot/aws-adapters/aws/s3-download');
    const marker = Buffer.from(JSON.stringify({ category: 'upload' }));
    vi.mocked(headS3Object).mockResolvedValue({ contentLength: marker.byteLength });
    vi.mocked(downloadRangeFromS3).mockResolvedValue({ body: marker });

    await expect(readAsyncProverFailureCategory(targetProfile, 'session-1', 'exec-1')).resolves.toBe('upload');
    expect(headS3Object).toHaveBeenCalledWith(targetProfile, 'sessions/session-1/exec-1/failure-marker.json');
    expect(downloadRangeFromS3).toHaveBeenCalledWith(targetProfile, 'sessions/session-1/exec-1/failure-marker.json', {
      start: 0,
      end: marker.byteLength - 1,
    });
  });

  it('fails closed without downloading an oversized private failure marker', async () => {
    const { headS3Object, downloadRangeFromS3 } = await import('@stark-ballot/aws-adapters/aws/s3-download');
    vi.mocked(headS3Object).mockResolvedValue({ contentLength: 10_000 });

    await expect(readAsyncProverFailureCategory(targetProfile, 'session-1', 'exec-1')).resolves.toBeUndefined();
    expect(downloadRangeFromS3).not.toHaveBeenCalled();
  });

  it('treats a missing private failure marker as absent evidence', async () => {
    const { headS3Object, downloadRangeFromS3 } = await import('@stark-ballot/aws-adapters/aws/s3-download');
    vi.mocked(headS3Object).mockRejectedValue(
      Object.assign(new Error('marker does not exist'), {
        name: 'NoSuchKey',
        $metadata: { httpStatusCode: 404 },
      }),
    );

    await expect(readAsyncProverFailureCategory(targetProfile, 'session-1', 'exec-1')).resolves.toBeUndefined();
    expect(downloadRangeFromS3).not.toHaveBeenCalled();
  });

  it('rethrows transient failure-marker HEAD errors for callback retry', async () => {
    const { headS3Object, downloadRangeFromS3 } = await import('@stark-ballot/aws-adapters/aws/s3-download');
    vi.mocked(headS3Object).mockRejectedValue(
      Object.assign(new Error('S3 temporarily unavailable'), {
        name: 'ServiceUnavailable',
        $metadata: { httpStatusCode: 503 },
      }),
    );

    await expect(readAsyncProverFailureCategory(targetProfile, 'session-1', 'exec-1')).rejects.toThrow(
      'S3 temporarily unavailable',
    );
    expect(downloadRangeFromS3).not.toHaveBeenCalled();
  });

  it('rethrows transient failure-marker GET errors for callback retry', async () => {
    const { headS3Object, downloadRangeFromS3 } = await import('@stark-ballot/aws-adapters/aws/s3-download');
    vi.mocked(headS3Object).mockResolvedValue({ contentLength: 24 });
    vi.mocked(downloadRangeFromS3).mockRejectedValue(
      Object.assign(new Error('S3 read timed out'), {
        name: 'TimeoutError',
      }),
    );

    await expect(readAsyncProverFailureCategory(targetProfile, 'session-1', 'exec-1')).rejects.toThrow(
      'S3 read timed out',
    );
  });

  it.each([
    ['sessionId', 'session/1', 'exec-1'],
    ['finalizationId with slash', 'session-1', 'bad/segment-123'],
    ['finalizationId with dot', 'session-1', 'bad.segment-123'],
    ['finalizationId as URL', 'session-1', 'https://example.invalid/execution'],
  ])('rejects unsafe %s before constructing target S3 keys', (_label, sessionId, finalizationId) => {
    expect(() => buildAsyncProverArtifactKeys(targetProfile, sessionId, finalizationId)).toThrow(
      /safe single path segment/,
    );
  });

  it('validates that supplied artifact keys match the canonical session and execution layout', () => {
    const keys = validateAsyncProverArtifactKeys({
      profile: targetProfile,
      sessionId: 'session-1',
      finalizationId: 'exec-1',
      inputS3Key: 'sessions/session-1/exec-1/input.json',
      outputS3Prefix: 'sessions/session-1/exec-1',
      bundleS3Key: 'sessions/session-1/exec-1/bundle.zip',
    });

    expect(keys).toEqual({
      inputS3Key: 'sessions/session-1/exec-1/input.json',
      outputS3Prefix: 'sessions/session-1/exec-1',
      bundleS3Key: 'sessions/session-1/exec-1/bundle.zip',
    });
  });

  it.each([
    [
      'foreign session',
      {
        inputS3Key: 'sessions/session-2/exec-1/input.json',
        outputS3Prefix: 'sessions/session-1/exec-1',
        bundleS3Key: 'sessions/session-1/exec-1/bundle.zip',
      },
    ],
    [
      'foreign execution',
      {
        inputS3Key: 'sessions/session-1/exec-1/input.json',
        outputS3Prefix: 'sessions/session-1/exec-2',
        bundleS3Key: 'sessions/session-1/exec-1/bundle.zip',
      },
    ],
    [
      'foreign prefix',
      {
        inputS3Key: 'archive/session-1/exec-1/input.json',
        outputS3Prefix: 'archive/session-1/exec-1',
        bundleS3Key: 'archive/session-1/exec-1/bundle.zip',
      },
    ],
  ])('rejects %s artifact keys', (_label, keys) => {
    expect(() =>
      validateAsyncProverArtifactKeys({
        profile: targetProfile,
        sessionId: 'session-1',
        finalizationId: 'exec-1',
        ...keys,
      }),
    ).toThrow('Async prover artifact keys must match the canonical session/finalization S3 layout');
  });

  it('rejects a supplied bundle key outside the canonical session and finalization layout', () => {
    expect(() =>
      validateAsyncProverBundleKey(targetProfile, 'session-1', 'exec-1', 'sessions/session-2/exec-1/bundle.zip'),
    ).toThrow('Async prover bundle key must match the canonical session/finalization S3 layout');
  });

  it('persists the target prover input with public artifact fields required by the container', async () => {
    const { getS3Client } = await import('@stark-ballot/aws-adapters/aws/s3-client');
    const send = vi.fn().mockResolvedValue({});
    vi.mocked(getS3Client).mockReturnValue({ send } as never);

    const keys = await persistAsyncProverInputToS3({
      profile: targetProfile,
      sessionId: 'session-1',
      finalizationId: 'exec-1',
      zkvmInput,
      electionConfig: {
        ...buildDefaultElectionConfig(),
        totalExpected: 1,
        botCount: 0,
      },
    });

    expect(keys.inputS3Key).toBe('sessions/session-1/exec-1/input.json');
    expect(send).toHaveBeenCalledTimes(1);
    const command = send.mock.calls[0]?.[0] as PutObjectCommand;
    expect(command).toBeInstanceOf(PutObjectCommand);
    expect(command.input.Bucket).toBe('proof-bucket');
    expect(command.input.Key).toBe('sessions/session-1/exec-1/input.json');
    expect(command.input.ExpectedBucketOwner).toBe('123456789012');
    expect(typeof command.input.Body).toBe('string');
    const payload = JSON.parse(command.input.Body as string) as Record<string, unknown>;
    expect(payload).not.toHaveProperty('contract_generation');
    expect(payload).not.toHaveProperty('contractGeneration');
    expect(command.input.Metadata).toEqual({
      sessionId: 'session-1',
      finalizationId: 'exec-1',
    });
    expect(payload['election_config']).toMatchObject({ totalExpected: 1, botCount: 0 });
    expect(payload['votes']).toHaveLength(1);
  });

  it('builds canonical finalization authority from a restored S3 bundle', async () => {
    const { restoreReceiptFromS3 } = await import('@stark-ballot/aws-adapters/aws/bundle-restore');
    const journal = createTestJournal({ totalExpected: 1, validVotes: 1, missingSlots: 0 });
    const electionManifest = buildElectionManifest(journal.electionId, {
      ...buildDefaultElectionConfig(),
      totalExpected: journal.totalExpected,
      botCount: 0,
    });
    journal.electionConfigHash = electionManifest.electionConfigHash;
    const closeStatement = buildCloseStatement({
      logId: '0x' + '3'.repeat(64),
      treeSize: journal.treeSize,
      timestamp: 1730000000000,
      bulletinRoot: journal.bulletinRoot,
    });
    journal.sthDigest = closeStatement.sthDigest;

    vi.mocked(restoreReceiptFromS3).mockResolvedValue({
      receipt: { seal: 'seal', journal: { bytes: [1, 2, 3] }, imageId: journal.imageId },
      receiptRaw: admitReceiptPayload({ receipt: { seal: 'seal' }, imageId: journal.imageId }),
      journal,
      publicInputArtifact: createTestPublicInputArtifact({
        source: 'bundle',
        finalizationId: 'exec-1',
        bundleKey: 'sessions/session-1/exec-1/bundle.zip',
        typedAuthority: {
          electionId: journal.electionId,
          electionConfigHash: journal.electionConfigHash,
          bulletinRoot: journal.bulletinRoot,
          treeSize: journal.treeSize,
          totalExpected: journal.totalExpected,
          methodVersion: journal.methodVersion,
          votesCount: 1,
          logId: closeStatement.logId,
          timestamp: closeStatement.timestamp,
          recomputedInputCommitment: journal.inputCommitment,
        },
      }),
      electionManifest,
      closeStatement,
    });

    const result = await buildFinalizationResultFromS3Bundle({
      profile: targetProfile,
      bundleS3Key: 'sessions/session-1/exec-1/bundle.zip',
      finalizationId: 'exec-1',
      finalizedAtMs: 1730000005000,
    });

    expect(result.journal).toEqual(journal);
    expect(result).not.toHaveProperty('s3BundleKey');
    expect(result).not.toHaveProperty('finalizationId');
    expect(result).not.toHaveProperty('s3UploadedAtMs');
    expect(result).not.toHaveProperty('receiptRaw');
    expect(result.publicInputArtifact?.provenance).toMatchObject({
      source: 'bundle',
      finalizationId: 'exec-1',
      bundleKey: 'sessions/session-1/exec-1/bundle.zip',
    });
    expect(result.electionManifest).toEqual(electionManifest);
    expect(result.closeStatement).toEqual(closeStatement);
  });
});
