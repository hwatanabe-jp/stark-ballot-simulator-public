import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest';
import { createTestJournal, createTestVoteWithProof } from '@/lib/testing/test-helpers';
import { createTestPublicInputArtifact } from '@/lib/testing/public-input-artifact';
import { buildCloseStatement, buildElectionManifest } from '@/lib/verification/public-audit-artifacts';
import { buildDefaultElectionConfig } from '@/lib/zkvm/election-config';
import { CURRENT_METHOD_VERSION, computeInputCommitment, computeSTHDigest, type ZkVMInput } from '@/lib/zkvm/types';
import {
  canonicalizeFinalizationResult,
  projectFinalizationResultForPublicResponse,
} from '@/lib/finalize/finalization-result';
import { resolveCurrentContractGeneration } from '@/lib/contract';

vi.mock('@/lib/aws/bundle-restore', () => ({
  restoreReceiptFromS3: vi.fn(),
}));

describe('AmplifySessionStore S3 backfill', () => {
  const originalEnv = process.env;
  let restoreReceiptFromS3: Mock;
  let AmplifySessionStore: typeof import('../amplifySessionStore').AmplifySessionStore;
  let verifierWorkDir: string;

  type AmplifySessionRecord = {
    id: string;
    electionId: string;
    electionConfigHash?: string | null;
    logId?: string | null;
    botCount?: number | null;
    finalized?: boolean | null;
    userVoteIndex?: number | null;
    ttl?: number | null;
    createdAt?: string | number | null;
    lastActivity?: string | number | null;
    finalizationResultJson?: unknown;
    bulletinRootHistoryJson?: unknown;
  };

  type AmplifyVoteRecord = {
    id: string;
    sessionId: string;
    voteIndex: number;
    choice: string;
    random: string;
    commitment: string;
    timestamp?: string | number | null;
    rootAtCast?: string | null;
    isUserVote?: boolean | null;
    path?: string[] | null;
  };

  const createTestStore = () => {
    class TestAmplifySessionStore extends AmplifySessionStore {
      public buildSessionDataForTest(session: AmplifySessionRecord, votes: AmplifyVoteRecord[]) {
        return this.buildSessionData(session, votes);
      }
    }
    return new TestAmplifySessionStore();
  };

  const wrapFinalizationPayload = (finalizationResult: Record<string, unknown> | null): string =>
    JSON.stringify({
      contractGeneration: resolveCurrentContractGeneration(),
      finalizationResult,
      finalizationState: null,
    });

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    process.env = { ...originalEnv };
    process.env.AMPLIFY_DATA_ENDPOINT = 'https://example.appsync-api.ap-northeast-1.amazonaws.com/graphql';
    process.env.AMPLIFY_DATA_TTL_SECONDS = '300';
    verifierWorkDir = await fs.mkdtemp(path.join(os.tmpdir(), 'amplify-session-store-'));
    process.env.VERIFIER_WORK_DIR = verifierWorkDir;
    restoreReceiptFromS3 = vi.mocked((await import('@/lib/aws/bundle-restore')).restoreReceiptFromS3);
    ({ AmplifySessionStore } = await import('../amplifySessionStore'));
  });

  afterEach(async () => {
    process.env = originalEnv;
    vi.restoreAllMocks();
    await fs.rm(verifierWorkDir, { recursive: true, force: true });
  });

  const baseSession = (): AmplifySessionRecord => {
    const now = new Date().toISOString();
    const journal = createTestJournal({
      electionId: '550e8400-e29b-41d4-a716-446655440000',
      totalExpected: 1,
      validVotes: 1,
    });
    return {
      id: 'session-123',
      electionId: '550e8400-e29b-41d4-a716-446655440000',
      electionConfigHash: '0x' + '1'.repeat(64),
      logId: null,
      botCount: 63,
      finalized: true,
      userVoteIndex: 0,
      ttl: Math.floor(Date.now() / 1000) + 300,
      createdAt: now,
      lastActivity: now,
      finalizationResultJson: wrapFinalizationPayload({
        tally: {
          counts: { A: 1, B: 0, C: 0, D: 0, E: 0 },
          totalVotes: 1,
          tamperedCount: 0,
        },
        imageId: '0x' + '1'.repeat(64),
        journal,
        publicInputArtifact: createTestPublicInputArtifact({
          bundleKey: 'sessions/session-123/exec-1/bundle.zip',
          typedAuthority: {
            electionId: journal.electionId,
            electionConfigHash: journal.electionConfigHash,
            methodVersion: journal.methodVersion,
            bulletinRoot: journal.bulletinRoot,
            treeSize: journal.treeSize,
            totalExpected: journal.totalExpected,
            votesCount: journal.validVotes,
            logId: '0x' + '3'.repeat(64),
            timestamp: 123,
            recomputedInputCommitment: journal.inputCommitment,
          },
        }),
        s3BundleKey: 'sessions/session-123/exec-1/bundle.zip',
      }),
      bulletinRootHistoryJson: JSON.stringify([]),
    };
  };

  const emptyVotes: AmplifyVoteRecord[] = [];

  it('restores receipt and journal from S3 when stored authority omits bundle artifacts', async () => {
    const restoredJournal = createTestJournal({
      electionId: '550e8400-e29b-41d4-a716-446655440000',
      totalExpected: 1,
      validVotes: 1,
    });
    const restored = {
      receipt: { seal: 'base64', journal: { bytes: [1, 2, 3] } },
      receiptRaw: { receipt: { seal: 'base64' } },
      journal: restoredJournal,
      publicInputArtifact: createTestPublicInputArtifact({
        source: 'bundle',
        executionId: 'exec-1',
        bundleKey: 'sessions/session-123/exec-1/bundle.zip',
        typedAuthority: {
          electionId: restoredJournal.electionId,
          electionConfigHash: restoredJournal.electionConfigHash,
          votesCount: 1,
          treeSize: 1,
          totalExpected: restoredJournal.totalExpected,
          bulletinRoot: restoredJournal.bulletinRoot,
          logId: '0x' + '3'.repeat(64),
          timestamp: 123,
          uniqueIndices: true,
          uniqueCommitments: true,
          recomputedInputCommitment: restoredJournal.inputCommitment,
          methodVersion: CURRENT_METHOD_VERSION,
        },
      }),
    };
    restoreReceiptFromS3.mockResolvedValueOnce(restored);

    const store = createTestStore();
    const session = await store.buildSessionDataForTest(baseSession(), emptyVotes);

    expect(restoreReceiptFromS3).toHaveBeenCalledWith('sessions/session-123/exec-1/bundle.zip');
    expect(session.finalizationResult?.receipt).toEqual(restored.receipt);
    expect(session.finalizationResult?.receiptRaw).toEqual(restored.receiptRaw);
    expect(session.finalizationResult?.journal).toEqual(restored.journal);
    expect(session.finalizationResult?.publicInputArtifact).toEqual(restored.publicInputArtifact);
  });

  it('restores from S3 when local bundle artifacts belong to a different execution', async () => {
    const electionId = '550e8400-e29b-41d4-a716-446655440000';
    const electionConfig = buildDefaultElectionConfig();
    const vote = createTestVoteWithProof({
      electionId,
      index: 0,
      choice: 0,
      treeSize: electionConfig.totalExpected,
    });
    const electionManifest = buildElectionManifest(electionId, electionConfig);
    const zkvmInput: ZkVMInput = {
      electionId,
      electionConfigHash: electionManifest.electionConfigHash,
      bulletinRoot: '0x' + '2'.repeat(64),
      treeSize: electionConfig.totalExpected,
      totalExpected: electionConfig.totalExpected,
      logId: '0x' + '3'.repeat(64),
      timestamp: 123,
      votes: [
        {
          index: vote.index,
          choice: vote.choice,
          random: vote.random,
          commitment: vote.commitment,
          merklePath: vote.merklePath,
        },
      ],
    };
    const closeStatement = buildCloseStatement({
      logId: zkvmInput.logId,
      treeSize: zkvmInput.treeSize,
      timestamp: zkvmInput.timestamp,
      bulletinRoot: zkvmInput.bulletinRoot,
    });
    const journal = {
      ...createTestJournal({
        electionId,
        totalExpected: zkvmInput.totalExpected,
        validVotes: 1,
        missingIndices: zkvmInput.totalExpected - 1,
        invalidIndices: 0,
      }),
      electionConfigHash: zkvmInput.electionConfigHash,
      bulletinRoot: zkvmInput.bulletinRoot,
      treeSize: zkvmInput.treeSize,
      totalExpected: zkvmInput.totalExpected,
      sthDigest: computeSTHDigest(zkvmInput.logId, zkvmInput.treeSize, zkvmInput.timestamp, zkvmInput.bulletinRoot),
      inputCommitment: computeInputCommitment(zkvmInput),
      includedBitmapRoot: '0x' + '4'.repeat(64),
      seenBitmapRoot: '0x' + '5'.repeat(64),
    };
    const oldBundlePath = path.join(verifierWorkDir, 'session-123', 'old-exec');
    await fs.mkdir(oldBundlePath, { recursive: true });
    await fs.writeFile(
      path.join(oldBundlePath, 'public-input.json'),
      JSON.stringify(
        {
          schema: 'stark-ballot.public_input',
          version: '1.1',
          contractGeneration: resolveCurrentContractGeneration(),
          electionId: zkvmInput.electionId,
          electionConfigHash: zkvmInput.electionConfigHash,
          bulletinRoot: zkvmInput.bulletinRoot,
          treeSize: zkvmInput.treeSize,
          totalExpected: zkvmInput.totalExpected,
          logId: zkvmInput.logId,
          timestamp: zkvmInput.timestamp,
          methodVersion: CURRENT_METHOD_VERSION,
          votes: zkvmInput.votes.map((entry) => ({
            index: entry.index,
            commitment: entry.commitment,
            merklePath: entry.merklePath,
          })),
        },
        null,
        2,
      ),
      'utf-8',
    );
    await fs.writeFile(
      path.join(oldBundlePath, 'election-manifest.json'),
      JSON.stringify(electionManifest, null, 2),
      'utf-8',
    );
    await fs.writeFile(
      path.join(oldBundlePath, 'close-statement.json'),
      JSON.stringify(closeStatement, null, 2),
      'utf-8',
    );

    const restoredSummary = createTestPublicInputArtifact({
      source: 'bundle',
      executionId: 'new-exec',
      bundleKey: 'sessions/session-123/new-exec/bundle.zip',
      typedAuthority: {
        electionId: journal.electionId,
        electionConfigHash: journal.electionConfigHash,
        votesCount: 1,
        treeSize: journal.treeSize,
        totalExpected: journal.totalExpected,
        bulletinRoot: journal.bulletinRoot,
        logId: zkvmInput.logId,
        timestamp: zkvmInput.timestamp,
        uniqueIndices: true,
        uniqueCommitments: true,
        recomputedInputCommitment: journal.inputCommitment,
        methodVersion: CURRENT_METHOD_VERSION,
      },
    });
    restoreReceiptFromS3.mockResolvedValueOnce({
      receipt: { seal: 'restored', journal: { bytes: [1, 2, 3] } },
      receiptRaw: { receipt: { seal: 'restored' } },
      journal,
      publicInputArtifact: restoredSummary,
      electionManifest,
      closeStatement,
    });

    const store = createTestStore();
    const session = await store.buildSessionDataForTest(
      {
        ...baseSession(),
        finalizationResultJson: wrapFinalizationPayload({
          tally: {
            counts: { A: 1, B: 0, C: 0, D: 0, E: 0 },
            totalVotes: 1,
            tamperedCount: 0,
          },
          imageId: '0x' + '1'.repeat(64),
          receipt: { seal: 'persisted', journal: 'persisted' },
          journal,
          s3BundleKey: 'sessions/session-123/new-exec/bundle.zip',
          verificationExecutionId: 'new-exec',
          verificationResult: {
            status: 'success',
            bundlePath: oldBundlePath,
            reportPath: path.join(oldBundlePath, 'verification.json'),
          },
        }),
      },
      emptyVotes,
    );

    expect(restoreReceiptFromS3).toHaveBeenCalledWith('sessions/session-123/new-exec/bundle.zip');
    expect(session.finalizationResult?.publicInputArtifact).toEqual(restoredSummary);
    expect(session.finalizationResult?.receipt).toEqual({ seal: 'restored', journal: { bytes: [1, 2, 3] } });
  });

  it('prefers restored canonical artifacts over stale persisted copies', async () => {
    const restoredElectionId = '550e8400-e29b-41d4-a716-446655440000';
    const restoredManifest = buildElectionManifest(restoredElectionId, buildDefaultElectionConfig());
    const restoredJournalBase = createTestJournal({
      electionId: restoredElectionId,
      totalExpected: 64,
      validVotes: 61,
      missingIndices: 1,
      invalidIndices: 2,
    });
    const restoredCloseStatement = buildCloseStatement({
      logId: '0x' + 'f'.repeat(64),
      treeSize: restoredJournalBase.treeSize,
      timestamp: 123,
      bulletinRoot: restoredJournalBase.bulletinRoot,
    });
    const restoredJournal = {
      ...restoredJournalBase,
      electionConfigHash: restoredManifest.electionConfigHash,
      sthDigest: restoredCloseStatement.sthDigest,
    };
    const restoredSummary = createTestPublicInputArtifact({
      source: 'bundle',
      executionId: 'exec-1',
      bundleKey: 'sessions/session-123/exec-1/bundle.zip',
      typedAuthority: {
        electionId: restoredJournal.electionId,
        electionConfigHash: restoredJournal.electionConfigHash,
        votesCount: 61,
        treeSize: restoredJournal.treeSize,
        totalExpected: restoredJournal.totalExpected,
        bulletinRoot: restoredJournal.bulletinRoot,
        logId: restoredCloseStatement.logId,
        timestamp: restoredCloseStatement.timestamp,
        uniqueIndices: true,
        uniqueCommitments: true,
        recomputedInputCommitment: restoredJournal.inputCommitment,
        methodVersion: CURRENT_METHOD_VERSION,
      },
    });
    restoreReceiptFromS3.mockResolvedValueOnce({
      receipt: { seal: 'base64', journal: { bytes: [1, 2, 3] } },
      receiptRaw: { receipt: { seal: 'base64' } },
      journal: restoredJournal,
      publicInputArtifact: restoredSummary,
      electionManifest: restoredManifest,
      closeStatement: restoredCloseStatement,
    });

    const staleManifest = buildElectionManifest('11111111-1111-4111-8111-111111111111', buildDefaultElectionConfig());
    const staleCloseStatement = buildCloseStatement({
      logId: '0x' + 'e'.repeat(64),
      treeSize: 32,
      timestamp: 456,
      bulletinRoot: '0x' + '7'.repeat(64),
    });
    const staleSummary = createTestPublicInputArtifact({
      typedAuthority: {
        votesCount: 1,
        treeSize: 1,
        bulletinRoot: '0x' + '8'.repeat(64),
        recomputedInputCommitment: '0x' + '9'.repeat(64),
      },
    });

    const store = createTestStore();
    const session = await store.buildSessionDataForTest(
      {
        ...baseSession(),
        finalizationResultJson: wrapFinalizationPayload({
          tally: {
            counts: { A: 61, B: 0, C: 0, D: 0, E: 0 },
            totalVotes: 61,
            tamperedCount: 0,
          },
          imageId: '0x' + '1'.repeat(64),
          receipt: { seal: 'persisted', journal: 'persisted' },
          journal: restoredJournal,
          publicInputArtifact: staleSummary,
          electionManifest: staleManifest,
          closeStatement: staleCloseStatement,
          s3BundleKey: 'sessions/session-123/exec-1/bundle.zip',
        }),
      },
      emptyVotes,
    );

    const canonical = canonicalizeFinalizationResult(session.finalizationResult);
    if (!canonical) {
      throw new Error('Expected canonical finalization result');
    }
    const projected = projectFinalizationResultForPublicResponse(canonical);

    expect(projected.bulletinRoot).toBe(restoredJournal.bulletinRoot);
    expect(projected.missingSlots).toBe(restoredJournal.missingSlots);
    expect(projected.invalidPresentedSlots).toBe(restoredJournal.invalidPresentedSlots);
    expect(projected.journal.validVotes).toBe(restoredJournal.validVotes);
    expect(projected.totalExpected).toBe(restoredJournal.totalExpected);
    expect(projected.treeSize).toBe(restoredJournal.treeSize);
    expect(projected.excludedSlots).toBe(restoredJournal.excludedSlots);
    expect(projected.sthDigest).toBe(restoredJournal.sthDigest);
    expect(projected.includedBitmapRoot).toBe(restoredJournal.includedBitmapRoot);
    expect(projected.inputCommitment).toBe(restoredJournal.inputCommitment);
    expect(canonical.publicInputArtifact).toEqual(restoredSummary);
    expect(canonical.electionManifest).toEqual(restoredManifest);
    expect(canonical.closeStatement).toEqual(restoredCloseStatement);
  });

  it('restores canonical artifacts when persisted copies are stale but still carry matching bundle metadata', async () => {
    const restoredElectionId = '550e8400-e29b-41d4-a716-446655440000';
    const restoredManifest = buildElectionManifest(restoredElectionId, buildDefaultElectionConfig());
    const restoredJournalBase = createTestJournal({
      electionId: restoredElectionId,
      totalExpected: 64,
      validVotes: 61,
      missingIndices: 1,
      invalidIndices: 2,
    });
    const restoredCloseStatement = buildCloseStatement({
      logId: '0x' + 'f'.repeat(64),
      treeSize: restoredJournalBase.treeSize,
      timestamp: 123,
      bulletinRoot: restoredJournalBase.bulletinRoot,
    });
    const restoredJournal = {
      ...restoredJournalBase,
      electionConfigHash: restoredManifest.electionConfigHash,
      sthDigest: restoredCloseStatement.sthDigest,
    };
    const restoredSummary = createTestPublicInputArtifact({
      source: 'bundle',
      executionId: 'exec-1',
      bundleKey: 'sessions/session-123/exec-1/bundle.zip',
      typedAuthority: {
        electionId: restoredJournal.electionId,
        electionConfigHash: restoredJournal.electionConfigHash,
        votesCount: 61,
        treeSize: restoredJournal.treeSize,
        totalExpected: restoredJournal.totalExpected,
        bulletinRoot: restoredJournal.bulletinRoot,
        logId: restoredCloseStatement.logId,
        timestamp: restoredCloseStatement.timestamp,
        uniqueIndices: true,
        uniqueCommitments: true,
        recomputedInputCommitment: restoredJournal.inputCommitment,
        methodVersion: CURRENT_METHOD_VERSION,
      },
    });
    restoreReceiptFromS3.mockResolvedValueOnce({
      receipt: { seal: 'base64', journal: { bytes: [1, 2, 3] } },
      receiptRaw: { receipt: { seal: 'base64' } },
      journal: restoredJournal,
      publicInputArtifact: restoredSummary,
      electionManifest: restoredManifest,
      closeStatement: restoredCloseStatement,
    });

    const persistedManifest = {
      ...restoredManifest,
      totalExpected: restoredManifest.totalExpected + 1,
    };
    const persistedCloseStatement = buildCloseStatement({
      logId: restoredCloseStatement.logId,
      treeSize: restoredJournal.treeSize + 1,
      timestamp: restoredCloseStatement.timestamp,
      bulletinRoot: '0x' + '7'.repeat(64),
    });
    const persistedSummary = {
      ...restoredSummary,
      recomputedInputCommitment: '0x' + '9'.repeat(64),
    };

    const store = createTestStore();
    const session = await store.buildSessionDataForTest(
      {
        ...baseSession(),
        finalizationResultJson: wrapFinalizationPayload({
          tally: {
            counts: { A: 61, B: 0, C: 0, D: 0, E: 0 },
            totalVotes: 61,
            tamperedCount: 0,
          },
          imageId: '0x' + '1'.repeat(64),
          receipt: { seal: 'persisted', journal: 'persisted' },
          journal: restoredJournal,
          publicInputArtifact: persistedSummary,
          electionManifest: persistedManifest,
          closeStatement: persistedCloseStatement,
          s3BundleKey: 'sessions/session-123/exec-1/bundle.zip',
        }),
      },
      emptyVotes,
    );

    expect(restoreReceiptFromS3).toHaveBeenCalledWith('sessions/session-123/exec-1/bundle.zip');
    expect(session.finalizationResult?.publicInputArtifact).toEqual(restoredSummary);
    expect(session.finalizationResult?.electionManifest).toEqual(restoredManifest);
    expect(session.finalizationResult?.closeStatement).toEqual(restoredCloseStatement);
  });

  it('keeps session usable when S3 restoration fails', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    restoreReceiptFromS3.mockRejectedValueOnce(new Error('download failed'));

    const store = createTestStore();
    const session = await store.buildSessionDataForTest(baseSession(), emptyVotes);

    expect(errorSpy).toHaveBeenCalledWith('[AmplifySessionStore] Failed to restore from S3:', 'download failed');
    expect(session.finalizationResult?.receipt).toBeUndefined();
    expect(session.finalizationResult?.journal).toBeDefined();
  });
});
