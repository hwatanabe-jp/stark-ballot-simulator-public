import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { createTestJournal, createTestVoteWithProof } from '@/lib/testing/test-helpers';
import type { FinalizationScenarioContext, VerificationResult } from '@/types/server';
import {
  buildFinalizationResultFromJournal,
  hasConsistentPublicAuditArtifacts,
  hydrateFinalizationResultFromJournal,
  projectFinalizationResultForPublicResponse,
  updateFinalizationResultBundleMetadata,
  updateFinalizationResultVerificationState,
} from '@/lib/finalize/finalization-result';
import { createTestPublicInputArtifact } from '@/lib/testing/public-input-artifact';
import { buildCloseStatement, buildElectionManifest } from '@/lib/verification/public-audit-artifacts';
import { buildDefaultElectionConfig } from '@/lib/zkvm/election-config';
import {
  CURRENT_METHOD_VERSION,
  computeInputCommitment,
  computeSTHDigest,
  type ZkVMInput,
  type ZkVMJournal,
} from '@/lib/zkvm/types';
import { resolveCurrentContractGeneration } from '@/lib/contract';

function createAuthoritativePublicInputArtifact(
  journal: Pick<
    ZkVMJournal,
    | 'electionId'
    | 'electionConfigHash'
    | 'methodVersion'
    | 'bulletinRoot'
    | 'treeSize'
    | 'totalExpected'
    | 'validVotes'
    | 'inputCommitment'
  >,
  overrides: Parameters<typeof createTestPublicInputArtifact>[0] = {},
) {
  return createTestPublicInputArtifact({
    ...overrides,
    typedAuthority: {
      electionId: journal.electionId,
      electionConfigHash: journal.electionConfigHash,
      methodVersion: journal.methodVersion,
      bulletinRoot: journal.bulletinRoot,
      treeSize: journal.treeSize,
      totalExpected: journal.totalExpected,
      votesCount: journal.validVotes,
      logId: '0x' + '2'.repeat(64),
      timestamp: 123,
      recomputedInputCommitment: journal.inputCommitment,
      ...overrides.typedAuthority,
    },
  });
}

describe('buildFinalizationResultFromJournal', () => {
  it('maps journal fields and bundle metadata into a finalization result', () => {
    const journal = createTestJournal({
      totalExpected: 64,
      validVotes: 61,
      missingIndices: 1,
      invalidIndices: 2,
    });

    const result = buildFinalizationResultFromJournal({
      journal,
      imageId: 'image-id-123',
      verificationExecutionId: 'execution-1',
      bundleMetadata: {
        s3BundleKey: 'sessions/session-1/execution-1/bundle.zip',
        s3BundleUrl: 'https://example.com/bundle.zip',
        s3BundleExpiresAt: '2025-12-31T00:00:00.000Z',
        s3UploadedAt: '2025-12-30T00:00:00.000Z',
      },
    });

    expect(result.tally.counts).toEqual({
      A: journal.verifiedTally[0],
      B: journal.verifiedTally[1],
      C: journal.verifiedTally[2],
      D: journal.verifiedTally[3],
      E: journal.verifiedTally[4],
    });
    expect(result.tally.totalVotes).toBe(journal.totalExpected);
    expect(result.tally.tamperedCount).toBe(journal.excludedSlots);
    expect(result.tamperDetected).toBe(true);
    expect(result.s3BundleKey).toBe('sessions/session-1/execution-1/bundle.zip');
    expect(result).not.toHaveProperty('s3BundleUrl');
    expect(result).not.toHaveProperty('s3BundleExpiresAt');
    expect(result.imageId).toBe('image-id-123');
    expect(result.verificationExecutionId).toBe('execution-1');
    expect(result.electionManifest).toBeUndefined();
    expect(result.closeStatement).toBeUndefined();
    expect(result.journal).toEqual(journal);
    expect(result.receipt).toBeUndefined();
    expect('bulletinRoot' in result).toBe(false);
    expect('verifiedTally' in result).toBe(false);
    expect('missingIndices' in result).toBe(false);
    expect('excludedCount' in result).toBe(false);
  });

  it('stores explicit public audit artifacts when provided', () => {
    const journal = createTestJournal();
    const electionManifest = buildElectionManifest(journal.electionId, buildDefaultElectionConfig());
    const closeStatement = buildCloseStatement({
      logId: '0x' + '1'.repeat(64),
      treeSize: journal.treeSize,
      timestamp: 123,
      bulletinRoot: journal.bulletinRoot,
    });

    const result = buildFinalizationResultFromJournal({
      journal,
      electionManifest,
      closeStatement,
    });

    expect(result.electionManifest).toEqual(electionManifest);
    expect(result.closeStatement).toEqual(closeStatement);
  });

  it('uses scenario context for claimed tally and tamper detection', () => {
    const journal = createTestJournal({
      totalExpected: 3,
      validVotes: 3,
      missingIndices: 0,
      invalidIndices: 0,
    });

    const scenarioContext: FinalizationScenarioContext = {
      scenarios: ['S2'],
      tamperMode: 'claim',
      claimedCounts: {
        A: 0,
        B: 2,
        C: 1,
        D: 0,
        E: 0,
      },
      claimedTotalVotes: 3,
      summary: {
        ignoredCount: 0,
        recountedCount: 1,
        userRecountChoice: 'B',
      },
    };

    const result = buildFinalizationResultFromJournal({
      journal,
      imageId: 'image-id-claim',
      scenarioContext,
    });

    expect(result.tally.counts).toEqual(scenarioContext.claimedCounts);
    expect(result.tally.totalVotes).toBe(3);
    expect(result.tally.tamperedCount).toBe(1);
    expect(result.tamperDetected).toBe(true);
    expect(result.journal.verifiedTally).toEqual(journal.verifiedTally);
    expect(result.scenarios).toEqual(['S2']);
    expect(result.tamperSummary).toEqual({
      ignoredVotes: 0,
      recountedVotes: 1,
      userRecountedTo: 'B',
    });
  });
});

describe('projectFinalizationResultForPublicResponse', () => {
  it('reconstructs public compatibility aliases from the canonical journal only', () => {
    const journal = createTestJournal({
      totalExpected: 64,
      validVotes: 61,
      missingIndices: 1,
      invalidIndices: 2,
    });
    const authority = buildFinalizationResultFromJournal({
      journal,
      imageId: '0x' + '1'.repeat(64),
    });
    authority.receiptRaw = { raw: true };
    authority.bitmapData = {
      includedBitmap: [true, false],
      includedBitmapRoot: journal.includedBitmapRoot,
      treeSize: journal.treeSize,
      finalizedAt: 1730000000000,
    };

    const projected = projectFinalizationResultForPublicResponse(authority);

    expect(projected.bulletinRoot).toBe(journal.bulletinRoot);
    expect(projected.verifiedTally).toEqual(journal.verifiedTally);
    expect(projected.missingSlots).toBe(journal.missingSlots);
    expect(projected.invalidPresentedSlots).toBe(journal.invalidPresentedSlots);
    expect(projected.rejectedRecords).toBe(journal.rejectedRecords);
    expect(projected.missingSlots).toBe(journal.missingSlots);
    expect(projected.invalidPresentedSlots).toBe(journal.invalidPresentedSlots);
    expect(projected.journal.validVotes).toBe(journal.validVotes);
    expect(projected.totalExpected).toBe(journal.totalExpected);
    expect(projected.treeSize).toBe(journal.treeSize);
    expect(projected.excludedSlots).toBe(journal.excludedSlots);
    expect(projected.excludedSlots).toBe(journal.excludedSlots);
    expect(projected.sthDigest).toBe(journal.sthDigest);
    expect(projected.seenBitmapRoot).toBe(journal.seenBitmapRoot);
    expect(projected.includedBitmapRoot).toBe(journal.includedBitmapRoot);
    expect(projected.inputCommitment).toBe(journal.inputCommitment);
    expect(projected.seenIndicesCount).toBe(journal.seenIndicesCount);
    expect(projected.imageId).toBe(authority.imageId);
    expect(projected.journal).toEqual(journal);
    expect('receiptRaw' in projected).toBe(false);
    expect('bitmapData' in projected).toBe(false);
  });

  it('serializes verification result without server-only paths', () => {
    const journal = createTestJournal();
    const authority = buildFinalizationResultFromJournal({
      journal,
      imageId: '0x' + '1'.repeat(64),
    });
    authority.verificationResult = {
      status: 'success',
      executionId: 'exec-1',
      report: {
        status: 'success',
        verifier_version: '1.0.0',
        verified_at: '2026-01-01T00:00:00.000Z',
        duration_ms: 1234,
        expected_image_id: authority.imageId,
        receipt_image_id: authority.imageId,
        bundle_path: '/tmp/mock-bundle',
        receipt_path: '/tmp/mock-bundle/receipt.json',
        dev_mode_receipt: false,
        errors: [],
      },
    } as unknown as VerificationResult;

    const projected = projectFinalizationResultForPublicResponse(authority);

    expect(projected.verificationResult).toMatchObject({
      status: 'success',
      executionId: 'exec-1',
    });
    expect(projected.verificationResult).not.toHaveProperty('bundleUrl');
    expect(projected.verificationResult).not.toHaveProperty('reportUrl');
    expect(projected.verificationResult).not.toHaveProperty('bundlePath');
    expect(projected.verificationResult).not.toHaveProperty('reportPath');
    expect(projected.verificationResult).not.toHaveProperty('bundleArchivePath');
    expect(projected.verificationResult?.report).toMatchObject({
      status: 'success',
      verifier_version: '1.0.0',
      verified_at: '2026-01-01T00:00:00.000Z',
      duration_ms: 1234,
      expected_image_id: authority.imageId,
      receipt_image_id: authority.imageId,
      dev_mode_receipt: false,
    });
    expect(projected.verificationResult?.report).not.toHaveProperty('bundle_path');
    expect(projected.verificationResult?.report).not.toHaveProperty('receipt_path');
  });
});

describe('finalization authority update helpers', () => {
  it('keeps refreshed delivery values out of persisted authority and nested verification state', () => {
    const journal = createTestJournal();
    const authority = buildFinalizationResultFromJournal({
      journal,
      imageId: '0x' + '1'.repeat(64),
    });
    authority.verificationResult = {
      status: 'running',
      s3BundleKey: 'sessions/session-1/exec-1/bundle.zip',
      executionId: 'exec-1',
    };

    const updated = updateFinalizationResultBundleMetadata(authority, {
      s3BundleUrl: 'https://new.example.com/bundle.zip',
      s3BundleKey: 'sessions/session-1/exec-2/bundle.zip',
      s3BundleExpiresAt: '2026-01-02T00:00:00.000Z',
      s3UploadedAt: '2026-01-01T12:00:00.000Z',
    });

    expect(updated.s3BundleKey).toBe('sessions/session-1/exec-2/bundle.zip');
    expect(updated.s3UploadedAt).toBe('2026-01-01T12:00:00.000Z');
    expect(updated).not.toHaveProperty('s3BundleUrl');
    expect(updated).not.toHaveProperty('s3BundleExpiresAt');
    expect(updated.verificationResult).toMatchObject({
      s3BundleKey: 'sessions/session-1/exec-2/bundle.zip',
      s3UploadedAt: '2026-01-01T12:00:00.000Z',
    });
    expect(updated.verificationResult).not.toHaveProperty('s3BundleUrl');
    expect(updated.verificationResult).not.toHaveProperty('s3BundleExpiresAt');
  });

  it('can explicitly clear verification state while staying on the authority shape', () => {
    const journal = createTestJournal();
    const authority = buildFinalizationResultFromJournal({
      journal,
      imageId: '0x' + '1'.repeat(64),
    });
    authority.verificationResult = {
      status: 'failed',
      executionId: 'exec-1',
    };
    authority.verificationExecutionId = 'exec-1';

    const updated = updateFinalizationResultVerificationState(authority, {
      verificationResult: undefined,
      verificationExecutionId: undefined,
    });

    expect(updated.verificationResult).toBeUndefined();
    expect(updated.verificationExecutionId).toBeUndefined();
    expect(updated.journal).toEqual(journal);
  });

  it('derives trusted local bundle references from scoped session and execution identity', async () => {
    const { resolveTrustedLocalBundleReference } = await import('@/lib/finalize/finalization-result');
    const previousVerifierWorkDir = process.env.VERIFIER_WORK_DIR;
    const verifierWorkDir = await fs.mkdtemp(path.join(os.tmpdir(), 'finalization-result-reference-'));
    process.env.VERIFIER_WORK_DIR = verifierWorkDir;

    try {
      const bundlePath = path.join(verifierWorkDir, 'session-123', 'exec-1');
      await fs.mkdir(bundlePath, { recursive: true });
      await fs.writeFile(path.join(bundlePath, 'public-input.json'), '{}', 'utf-8');

      const reference = resolveTrustedLocalBundleReference('session-123', {
        verificationExecutionId: 'exec-1',
        verificationResult: {
          status: 'success',
          executionId: 'exec-1',
        },
      });

      expect(reference).toEqual({
        bundlePath,
        sessionId: 'session-123',
        executionId: 'exec-1',
        reportPath: path.join(bundlePath, 'verification.json'),
        bundleKey: undefined,
      });
    } finally {
      process.env.VERIFIER_WORK_DIR = previousVerifierWorkDir;
      await fs.rm(verifierWorkDir, { recursive: true, force: true });
    }
  });
});

describe('hydrateFinalizationResultFromJournal', () => {
  it('fills journal-derived fields when missing', () => {
    const journal = createTestJournal({
      totalExpected: 64,
      validVotes: 60,
      missingIndices: 2,
      invalidIndices: 2,
    });

    const partialResult = {
      journal,
      imageId: 'image-id-456',
      tally: {
        counts: {
          A: 10,
          B: 10,
          C: 10,
          D: 10,
          E: 20,
        },
        totalVotes: 60,
        tamperedCount: 0,
      },
      bulletinRoot: journal.bulletinRoot,
      publicInputArtifact: createAuthoritativePublicInputArtifact(journal),
    };

    const hydrated = hydrateFinalizationResultFromJournal(partialResult);
    if (!hydrated) {
      throw new Error('Expected hydrated result to be defined');
    }
    const projected = projectFinalizationResultForPublicResponse(hydrated);

    expect(projected.missingSlots).toBe(journal.missingSlots);
    expect(projected.invalidPresentedSlots).toBe(journal.invalidPresentedSlots);
    expect(projected.journal.validVotes).toBe(journal.validVotes);
    expect(projected.totalExpected).toBe(journal.totalExpected);
    expect(projected.treeSize).toBe(journal.treeSize);
    expect(hydrated.tally.totalVotes).toBe(partialResult.tally.totalVotes);
  });

  it('accepts bundle-restored public input summary when provided fields remain consistent', () => {
    const journal = createTestJournal({
      totalExpected: 64,
      validVotes: 64,
      missingIndices: 0,
      invalidIndices: 0,
    });

    const publicInputArtifact = createTestPublicInputArtifact({
      source: 'bundle',
      executionId: 'exec-1',
      bundleKey: 'sessions/session-1/exec-1/bundle.zip',
      typedAuthority: {
        electionId: journal.electionId,
        electionConfigHash: journal.electionConfigHash,
        votesCount: 64,
        treeSize: journal.treeSize,
        totalExpected: journal.totalExpected,
        bulletinRoot: journal.bulletinRoot,
        logId: '0x' + '2'.repeat(64),
        timestamp: 123,
        methodVersion: journal.methodVersion,
        recomputedInputCommitment: journal.inputCommitment,
      },
    });

    const hydrated = hydrateFinalizationResultFromJournal({
      journal,
      imageId: '0x' + '1'.repeat(64),
      tally: {
        counts: {
          A: 64,
          B: 0,
          C: 0,
          D: 0,
          E: 0,
        },
        totalVotes: 64,
        tamperedCount: 0,
      },
      bulletinRoot: journal.bulletinRoot,
      publicInputArtifact,
      verificationExecutionId: 'exec-1',
      s3BundleKey: 'sessions/session-1/exec-1/bundle.zip',
    });

    expect(hydrated?.publicInputArtifact).toEqual(publicInputArtifact);
  });

  it('accepts generated public input summary when no bundle authority is expected', () => {
    const journal = createTestJournal({
      totalExpected: 64,
      validVotes: 64,
      missingIndices: 0,
      invalidIndices: 0,
    });

    const publicInputArtifact = createTestPublicInputArtifact({
      source: 'generated',
      typedAuthority: {
        electionId: journal.electionId,
        electionConfigHash: journal.electionConfigHash,
        votesCount: 64,
        treeSize: journal.treeSize,
        totalExpected: journal.totalExpected,
        bulletinRoot: journal.bulletinRoot,
        logId: '0x' + '2'.repeat(64),
        timestamp: 123,
        methodVersion: journal.methodVersion,
        recomputedInputCommitment: journal.inputCommitment,
      },
    });
    const closeStatement = buildCloseStatement({
      logId: publicInputArtifact.typedAuthority.logId,
      treeSize: journal.treeSize,
      timestamp: publicInputArtifact.typedAuthority.timestamp,
      bulletinRoot: journal.bulletinRoot,
    });

    const hydrated = hydrateFinalizationResultFromJournal({
      journal: {
        ...journal,
        sthDigest: closeStatement.sthDigest,
      },
      imageId: '0x' + '1'.repeat(64),
      tally: {
        counts: {
          A: 64,
          B: 0,
          C: 0,
          D: 0,
          E: 0,
        },
        totalVotes: 64,
        tamperedCount: 0,
      },
      bulletinRoot: journal.bulletinRoot,
      publicInputArtifact,
      closeStatement,
    });

    expect(hydrated?.publicInputArtifact).toEqual(publicInputArtifact);
    expect(hydrated?.closeStatement).toEqual(closeStatement);
  });

  it('accepts generated public input summary when sync authority matches execution and bundle identity', () => {
    const journal = createTestJournal({
      totalExpected: 64,
      validVotes: 64,
      missingIndices: 0,
      invalidIndices: 0,
    });

    const publicInputArtifact = createTestPublicInputArtifact({
      source: 'generated',
      executionId: 'exec-1',
      bundleKey: 'sessions/session-1/exec-1/bundle.zip',
      typedAuthority: {
        electionId: journal.electionId,
        electionConfigHash: journal.electionConfigHash,
        votesCount: 64,
        treeSize: journal.treeSize,
        totalExpected: journal.totalExpected,
        bulletinRoot: journal.bulletinRoot,
        logId: '0x' + '3'.repeat(64),
        timestamp: 456,
        methodVersion: journal.methodVersion,
        recomputedInputCommitment: journal.inputCommitment,
      },
    });
    const closeStatement = buildCloseStatement({
      logId: publicInputArtifact.typedAuthority.logId,
      treeSize: journal.treeSize,
      timestamp: publicInputArtifact.typedAuthority.timestamp,
      bulletinRoot: journal.bulletinRoot,
    });

    const hydrated = hydrateFinalizationResultFromJournal({
      journal: {
        ...journal,
        sthDigest: closeStatement.sthDigest,
      },
      imageId: '0x' + '1'.repeat(64),
      tally: {
        counts: {
          A: 64,
          B: 0,
          C: 0,
          D: 0,
          E: 0,
        },
        totalVotes: 64,
        tamperedCount: 0,
      },
      bulletinRoot: journal.bulletinRoot,
      publicInputArtifact,
      closeStatement,
      verificationExecutionId: 'exec-1',
      s3BundleKey: 'sessions/session-1/exec-1/bundle.zip',
    });

    expect(hydrated?.publicInputArtifact).toEqual(publicInputArtifact);
    expect(hydrated?.closeStatement).toEqual(closeStatement);
  });

  it('drops generated public input summary when sync authority execution or bundle identity mismatches', () => {
    const journal = createTestJournal({
      totalExpected: 64,
      validVotes: 64,
      missingIndices: 0,
      invalidIndices: 0,
    });

    const closeStatement = buildCloseStatement({
      logId: '0x' + '4'.repeat(64),
      treeSize: journal.treeSize,
      timestamp: 789,
      bulletinRoot: journal.bulletinRoot,
    });

    const hydrated = hydrateFinalizationResultFromJournal({
      journal: {
        ...journal,
        sthDigest: closeStatement.sthDigest,
      },
      imageId: '0x' + '1'.repeat(64),
      tally: {
        counts: {
          A: 64,
          B: 0,
          C: 0,
          D: 0,
          E: 0,
        },
        totalVotes: 64,
        tamperedCount: 0,
      },
      bulletinRoot: journal.bulletinRoot,
      publicInputArtifact: createTestPublicInputArtifact({
        source: 'generated',
        executionId: 'stale-exec',
        bundleKey: 'sessions/session-1/stale-exec/bundle.zip',
        typedAuthority: {
          electionId: journal.electionId,
          electionConfigHash: journal.electionConfigHash,
          votesCount: 64,
          treeSize: journal.treeSize,
          totalExpected: journal.totalExpected,
          bulletinRoot: journal.bulletinRoot,
          logId: closeStatement.logId,
          timestamp: closeStatement.timestamp,
          methodVersion: journal.methodVersion,
          recomputedInputCommitment: journal.inputCommitment,
        },
      }),
      closeStatement,
      verificationExecutionId: 'exec-1',
      s3BundleKey: 'sessions/session-1/exec-1/bundle.zip',
    });

    expect(hydrated).toBeUndefined();
  });

  it('fails closed when an authoritative bundle summary omits required public-input fields', () => {
    const journal = createTestJournal({
      totalExpected: 64,
      validVotes: 64,
      missingIndices: 0,
      invalidIndices: 0,
    });

    const hydrated = hydrateFinalizationResultFromJournal({
      journal,
      imageId: '0x' + '1'.repeat(64),
      tally: {
        counts: {
          A: 64,
          B: 0,
          C: 0,
          D: 0,
          E: 0,
        },
        totalVotes: 64,
        tamperedCount: 0,
      },
      bulletinRoot: journal.bulletinRoot,
      publicInputArtifact: createTestPublicInputArtifact({
        source: 'bundle',
        executionId: 'exec-1',
        bundleKey: 'sessions/session-1/exec-1/bundle.zip',
        typedAuthority: {
          votesCount: 64,
          treeSize: journal.treeSize,
          totalExpected: journal.totalExpected,
          bulletinRoot: journal.bulletinRoot,
          recomputedInputCommitment: journal.inputCommitment,
          methodVersion: journal.methodVersion,
        },
      }),
      verificationExecutionId: 'exec-1',
      s3BundleKey: 'sessions/session-1/exec-1/bundle.zip',
    });

    expect(hydrated).toBeUndefined();
  });

  it('fails closed when authoritative public-input authority is missing entirely', () => {
    const journal = createTestJournal({
      totalExpected: 64,
      validVotes: 64,
      missingIndices: 0,
      invalidIndices: 0,
    });

    const hydrated = hydrateFinalizationResultFromJournal({
      journal,
      imageId: '0x' + '1'.repeat(64),
      tally: {
        counts: {
          A: 64,
          B: 0,
          C: 0,
          D: 0,
          E: 0,
        },
        totalVotes: 64,
        tamperedCount: 0,
      },
      bulletinRoot: journal.bulletinRoot,
    });

    expect(hydrated).toBeUndefined();
  });

  it('keeps sync-generated public-input authority without bundle metadata when provenance is authoritative', () => {
    const journal = createTestJournal({
      totalExpected: 64,
      validVotes: 61,
      missingIndices: 1,
      invalidIndices: 2,
    });

    const hydrated = hydrateFinalizationResultFromJournal({
      journal,
      imageId: '0x' + '1'.repeat(64),
      tally: {
        counts: {
          A: 61,
          B: 0,
          C: 0,
          D: 0,
          E: 0,
        },
        totalVotes: 61,
        tamperedCount: 0,
      },
      bulletinRoot: journal.bulletinRoot,
      publicInputArtifact: createTestPublicInputArtifact({
        typedAuthority: {
          electionId: journal.electionId,
          electionConfigHash: journal.electionConfigHash,
          votesCount: 999,
          treeSize: journal.treeSize,
          totalExpected: journal.totalExpected,
          bulletinRoot: journal.bulletinRoot,
          uniqueIndices: false,
          uniqueCommitments: false,
          methodVersion: journal.methodVersion,
          recomputedInputCommitment: journal.inputCommitment,
        },
      }),
    });

    expect(hydrated).toBeDefined();
    const artifact = hydrated?.publicInputArtifact;
    expect(artifact).toBeDefined();
    expect(artifact?.provenance).toEqual({ source: 'generated' });
    expect(artifact?.typedAuthority).toMatchObject({
      electionId: journal.electionId,
      electionConfigHash: journal.electionConfigHash,
      votesCount: 999,
      treeSize: journal.treeSize,
      totalExpected: journal.totalExpected,
      bulletinRoot: journal.bulletinRoot,
      uniqueIndices: false,
      uniqueCommitments: false,
      methodVersion: journal.methodVersion,
      recomputedInputCommitment: journal.inputCommitment,
    });
  });

  it('keeps journal-derived fields authoritative over stale top-level copies', () => {
    const baseJournal = {
      ...createTestJournal({
        totalExpected: 64,
        validVotes: 61,
        missingIndices: 1,
        invalidIndices: 2,
      }),
      imageId: '0x' + '9'.repeat(64),
    };
    const electionManifest = buildElectionManifest(baseJournal.electionId, buildDefaultElectionConfig());
    const journalWithoutSthBinding = {
      ...baseJournal,
      electionConfigHash: electionManifest.electionConfigHash,
    };
    const closeStatement = buildCloseStatement({
      logId: '0x' + '1'.repeat(64),
      treeSize: journalWithoutSthBinding.treeSize,
      timestamp: 123,
      bulletinRoot: journalWithoutSthBinding.bulletinRoot,
    });
    const journal = {
      ...journalWithoutSthBinding,
      sthDigest: closeStatement.sthDigest,
    };
    const publicInputArtifact = createTestPublicInputArtifact({
      source: 'bundle',
      executionId: 'exec-1',
      bundleKey: 'sessions/session-1/exec-1/bundle.zip',
      typedAuthority: {
        electionId: journal.electionId,
        electionConfigHash: journal.electionConfigHash,
        votesCount: 61,
        treeSize: journal.treeSize,
        totalExpected: journal.totalExpected,
        bulletinRoot: journal.bulletinRoot,
        logId: closeStatement.logId,
        timestamp: closeStatement.timestamp,
        methodVersion: journal.methodVersion,
        recomputedInputCommitment: journal.inputCommitment,
      },
    });

    const hydrated = hydrateFinalizationResultFromJournal({
      journal,
      imageId: '0x' + '1'.repeat(64),
      tally: {
        counts: {
          A: 0,
          B: 61,
          C: 0,
          D: 0,
          E: 0,
        },
        totalVotes: 61,
        tamperedCount: 99,
      },
      bulletinRoot: '0x' + '2'.repeat(64),
      verifiedTally: [0, 61, 0, 0, 0],
      missingIndices: 99,
      invalidIndices: 98,
      countedIndices: 0,
      totalExpected: 999,
      treeSize: 999,
      excludedCount: 97,
      sthDigest: '0x' + '3'.repeat(64),
      seenBitmapRoot: '0x' + '4'.repeat(64),
      includedBitmapRoot: '0x' + '5'.repeat(64),
      seenIndicesCount: 0,
      inputCommitment: '0x' + '6'.repeat(64),
      publicInputArtifact,
      electionManifest,
      closeStatement,
      s3BundleKey: 'sessions/session-1/exec-1/bundle.zip',
      verificationExecutionId: 'exec-1',
      receipt: {
        seal: 'base64-seal',
        journal: 'base64-journal',
      },
      receiptRaw: { receipt: 'raw' },
    });

    if (!hydrated) {
      throw new Error('Expected hydrated result to be defined');
    }

    expect(hydrated.imageId).toBe('0x' + '1'.repeat(64));
    expect(hydrated.tally).toEqual({
      counts: {
        A: 0,
        B: 61,
        C: 0,
        D: 0,
        E: 0,
      },
      totalVotes: 61,
      tamperedCount: 99,
    });
    const projected = projectFinalizationResultForPublicResponse(hydrated);
    expect(projected.bulletinRoot).toBe(journal.bulletinRoot);
    expect(projected.verifiedTally).toEqual(journal.verifiedTally);
    expect(projected.missingSlots).toBe(journal.missingSlots);
    expect(projected.invalidPresentedSlots).toBe(journal.invalidPresentedSlots);
    expect(projected.journal.validVotes).toBe(journal.validVotes);
    expect(projected.totalExpected).toBe(journal.totalExpected);
    expect(projected.treeSize).toBe(journal.treeSize);
    expect(projected.excludedSlots).toBe(journal.excludedSlots);
    expect(projected.sthDigest).toBe(journal.sthDigest);
    expect(projected.seenBitmapRoot).toBe(journal.seenBitmapRoot);
    expect(projected.includedBitmapRoot).toBe(journal.includedBitmapRoot);
    expect(projected.seenIndicesCount).toBe(journal.seenIndicesCount);
    expect(projected.inputCommitment).toBe(journal.inputCommitment);
    expect(hydrated.publicInputArtifact).toEqual(publicInputArtifact);
    expect(hydrated.electionManifest).toEqual(electionManifest);
    expect(hydrated.closeStatement).toEqual(closeStatement);
    expect(hydrated.receipt).toEqual({
      seal: 'base64-seal',
      journal: 'base64-journal',
    });
    expect(hydrated.receiptRaw).toEqual({ receipt: 'raw' });
    expect(hydrated.verificationExecutionId).toBe('exec-1');
  });

  it('drops legacy count aliases from hydrated canonical journals and public journal projection', () => {
    const journal = {
      ...createTestJournal({
        totalExpected: 64,
        validVotes: 61,
        missingIndices: 1,
        invalidIndices: 2,
      }),
      missingIndices: 99,
      invalidIndices: 98,
      countedIndices: 0,
      excludedCount: 97,
    };

    const hydrated = hydrateFinalizationResultFromJournal({
      journal,
      imageId: '0x' + '1'.repeat(64),
      tally: {
        counts: {
          A: 0,
          B: 61,
          C: 0,
          D: 0,
          E: 0,
        },
        totalVotes: 61,
        tamperedCount: 0,
      },
      publicInputArtifact: createAuthoritativePublicInputArtifact(journal),
    });

    if (!hydrated) {
      throw new Error('Expected hydrated result to be defined');
    }

    const projected = projectFinalizationResultForPublicResponse(hydrated);
    expect(hydrated.journal).not.toHaveProperty('missingIndices');
    expect(hydrated.journal).not.toHaveProperty('invalidIndices');
    expect(hydrated.journal).not.toHaveProperty('countedIndices');
    expect(hydrated.journal).not.toHaveProperty('excludedCount');
    expect(projected.journal).not.toHaveProperty('missingIndices');
    expect(projected.journal).not.toHaveProperty('invalidIndices');
    expect(projected.journal).not.toHaveProperty('countedIndices');
    expect(projected.journal).not.toHaveProperty('excludedCount');
    expect(projected).not.toHaveProperty('missingIndices');
    expect(projected).not.toHaveProperty('invalidIndices');
    expect(projected).not.toHaveProperty('countedIndices');
    expect(projected).not.toHaveProperty('excludedCount');
    expect(projected.missingSlots).toBe(hydrated.journal.missingSlots);
    expect(projected.invalidPresentedSlots).toBe(hydrated.journal.invalidPresentedSlots);
    expect(projected.excludedSlots).toBe(hydrated.journal.excludedSlots);
  });

  it('downgrades persisted verification success when canonical journal shows excluded votes', () => {
    const journal = createTestJournal({
      totalExpected: 64,
      validVotes: 61,
      missingIndices: 1,
      invalidIndices: 2,
    });

    const hydrated = hydrateFinalizationResultFromJournal({
      journal,
      imageId: '0x' + '1'.repeat(64),
      tally: {
        counts: {
          A: 61,
          B: 0,
          C: 0,
          D: 0,
          E: 0,
        },
        totalVotes: 61,
        tamperedCount: 3,
      },
      bulletinRoot: journal.bulletinRoot,
      publicInputArtifact: createAuthoritativePublicInputArtifact(journal),
      verificationResult: {
        status: 'success',
      },
    });

    expect(hydrated?.verificationResult?.status).toBe('failed');
  });

  it('fails closed when a current-method journal is missing seenBitmapRoot', () => {
    const journal = createTestJournal({
      totalExpected: 64,
      validVotes: 64,
      missingIndices: 0,
      invalidIndices: 0,
      seenIndicesCount: 64,
    });
    const unsupportedJournal = {
      ...journal,
      seenBitmapRoot: undefined,
    };

    const hydrated = hydrateFinalizationResultFromJournal({
      journal: unsupportedJournal,
      imageId: '0x' + '1'.repeat(64),
      tally: {
        counts: {
          A: 64,
          B: 0,
          C: 0,
          D: 0,
          E: 0,
        },
        totalVotes: 64,
        tamperedCount: 0,
      },
      bulletinRoot: journal.bulletinRoot,
    });

    expect(hydrated).toBeUndefined();
  });

  it('keeps persisted STARK verification success when only the claimed tally disagrees with verified tally', () => {
    const journal = {
      ...createTestJournal({
        totalExpected: 3,
        validVotes: 3,
        missingIndices: 0,
        invalidIndices: 0,
      }),
      verifiedTally: [1, 0, 1, 0, 1],
    };

    const hydrated = hydrateFinalizationResultFromJournal({
      journal,
      imageId: '0x' + '1'.repeat(64),
      tally: {
        counts: {
          A: 0,
          B: 3,
          C: 0,
          D: 0,
          E: 0,
        },
        totalVotes: 3,
        tamperedCount: 1,
      },
      bulletinRoot: journal.bulletinRoot,
      publicInputArtifact: createAuthoritativePublicInputArtifact(journal),
      verificationResult: {
        status: 'success',
      },
    });

    expect(hydrated?.verificationResult?.status).toBe('success');
  });

  it('fails closed when the persisted journal methodVersion is unsupported', () => {
    const hydrated = hydrateFinalizationResultFromJournal({
      journal: {
        ...createTestJournal(),
        methodVersion: 3,
      },
      imageId: '0x' + '1'.repeat(64),
      tally: {
        counts: {
          A: 1,
          B: 0,
          C: 0,
          D: 0,
          E: 0,
        },
        totalVotes: 1,
        tamperedCount: 0,
      },
      bulletinRoot: '0x' + '1'.repeat(64),
    });

    expect(hydrated).toBeUndefined();
  });

  it('fails closed when public audit artifacts drift from canonical proof data', () => {
    const journal = createTestJournal({
      totalExpected: 64,
      validVotes: 61,
      missingIndices: 1,
      invalidIndices: 2,
    });

    const hydrated = hydrateFinalizationResultFromJournal({
      journal,
      imageId: '0x' + '1'.repeat(64),
      tally: {
        counts: {
          A: 61,
          B: 0,
          C: 0,
          D: 0,
          E: 0,
        },
        totalVotes: 61,
        tamperedCount: 0,
      },
      bulletinRoot: journal.bulletinRoot,
      publicInputArtifact: createTestPublicInputArtifact({
        typedAuthority: {
          electionId: journal.electionId,
          electionConfigHash: journal.electionConfigHash,
          votesCount: 61,
          treeSize: journal.treeSize,
          totalExpected: journal.totalExpected,
          bulletinRoot: journal.bulletinRoot,
          methodVersion: journal.methodVersion,
          recomputedInputCommitment: '0x' + '9'.repeat(64),
        },
      }),
      electionManifest: {
        ...buildElectionManifest(journal.electionId, buildDefaultElectionConfig()),
        totalExpected: journal.totalExpected + 1,
      },
      closeStatement: buildCloseStatement({
        logId: '0x' + '1'.repeat(64),
        treeSize: journal.treeSize + 1,
        timestamp: 123,
        bulletinRoot: '0x' + '7'.repeat(64),
      }),
    });

    expect(hydrated).toBeUndefined();
  });

  it('fails closed when close statement input-side fields drift from public input summary', () => {
    const journal = createTestJournal({
      totalExpected: 64,
      validVotes: 64,
      missingIndices: 0,
      invalidIndices: 0,
    });

    const hydrated = hydrateFinalizationResultFromJournal({
      journal,
      imageId: '0x' + '1'.repeat(64),
      tally: {
        counts: {
          A: 64,
          B: 0,
          C: 0,
          D: 0,
          E: 0,
        },
        totalVotes: 64,
        tamperedCount: 0,
      },
      bulletinRoot: journal.bulletinRoot,
      publicInputArtifact: createTestPublicInputArtifact({
        typedAuthority: {
          electionId: journal.electionId,
          electionConfigHash: journal.electionConfigHash,
          votesCount: 64,
          treeSize: journal.treeSize,
          totalExpected: journal.totalExpected,
          bulletinRoot: journal.bulletinRoot,
          logId: '0x' + '2'.repeat(64),
          timestamp: 123,
          methodVersion: journal.methodVersion,
          recomputedInputCommitment: journal.inputCommitment,
        },
      }),
      closeStatement: buildCloseStatement({
        logId: '0x' + '3'.repeat(64),
        treeSize: journal.treeSize,
        timestamp: 456,
        bulletinRoot: journal.bulletinRoot,
      }),
    });

    expect(hydrated).toBeUndefined();
  });

  it('fails closed when close statement STH digest drifts from the canonical journal', () => {
    const journal = createTestJournal({
      totalExpected: 64,
      validVotes: 64,
      missingIndices: 0,
      invalidIndices: 0,
    });

    const driftedCloseStatement = buildCloseStatement({
      logId: '0x' + '2'.repeat(64),
      treeSize: journal.treeSize,
      timestamp: 123,
      bulletinRoot: journal.bulletinRoot,
    });

    const hydrated = hydrateFinalizationResultFromJournal({
      journal,
      imageId: '0x' + '1'.repeat(64),
      tally: {
        counts: {
          A: 64,
          B: 0,
          C: 0,
          D: 0,
          E: 0,
        },
        totalVotes: 64,
        tamperedCount: 0,
      },
      bulletinRoot: journal.bulletinRoot,
      closeStatement: driftedCloseStatement,
    });

    expect(hydrated).toBeUndefined();
  });

  it('does not repair authoritative bundle identity from nested verification-result locators', () => {
    const journal = createTestJournal({
      totalExpected: 64,
      validVotes: 64,
      missingIndices: 0,
      invalidIndices: 0,
    });
    const bundleKey = 'sessions/session-1/exec-1/bundle.zip';
    const electionManifest = buildElectionManifest(journal.electionId, buildDefaultElectionConfig());
    const closeStatement = buildCloseStatement({
      logId: '0x' + '2'.repeat(64),
      treeSize: journal.treeSize,
      timestamp: 123,
      bulletinRoot: journal.bulletinRoot,
    });

    expect(
      hasConsistentPublicAuditArtifacts({
        journal: {
          ...journal,
          electionConfigHash: electionManifest.electionConfigHash,
          sthDigest: closeStatement.sthDigest,
        },
        publicInputArtifact: createTestPublicInputArtifact({
          source: 'generated',
          executionId: 'exec-1',
          bundleKey,
          typedAuthority: {
            electionId: journal.electionId,
            electionConfigHash: electionManifest.electionConfigHash,
            votesCount: 64,
            treeSize: journal.treeSize,
            totalExpected: journal.totalExpected,
            bulletinRoot: journal.bulletinRoot,
            logId: closeStatement.logId,
            timestamp: closeStatement.timestamp,
            methodVersion: journal.methodVersion,
            recomputedInputCommitment: journal.inputCommitment,
          },
        }),
        electionManifest,
        closeStatement,
        verificationExecutionId: 'exec-1',
        verificationResult: {
          status: 'success',
          executionId: 'exec-1',
          s3BundleKey: bundleKey,
        },
      }),
    ).toBe(false);
  });

  it('does not treat local bundle artifacts as authoritative when bundlePath execution mismatches expected authority', async () => {
    const previousVerifierWorkDir = process.env.VERIFIER_WORK_DIR;
    const verifierWorkDir = await fs.mkdtemp(path.join(os.tmpdir(), 'finalization-result-'));
    process.env.VERIFIER_WORK_DIR = verifierWorkDir;

    try {
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

      expect(
        hasConsistentPublicAuditArtifacts({
          journal,
          verificationExecutionId: 'new-exec',
          s3BundleKey: 'sessions/session-123/new-exec/bundle.zip',
          verificationResult: {
            status: 'success',
          },
        }),
      ).toBe(false);
    } finally {
      process.env.VERIFIER_WORK_DIR = previousVerifierWorkDir;
      await fs.rm(verifierWorkDir, { recursive: true, force: true });
    }
  });

  it('does not trust local bundle artifacts when a bundle path escapes via symlink', async () => {
    const previousVerifierWorkDir = process.env.VERIFIER_WORK_DIR;
    const verifierWorkDir = await fs.mkdtemp(path.join(os.tmpdir(), 'finalization-result-'));
    const escapedBundleDir = await fs.mkdtemp(path.join(os.tmpdir(), 'finalization-result-escaped-'));
    process.env.VERIFIER_WORK_DIR = verifierWorkDir;

    try {
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
      const symlinkParent = path.join(verifierWorkDir, 'session-123');
      const symlinkBundlePath = path.join(symlinkParent, 'exec-1');
      await fs.mkdir(symlinkParent, { recursive: true });
      await fs.writeFile(
        path.join(escapedBundleDir, 'public-input.json'),
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
        path.join(escapedBundleDir, 'election-manifest.json'),
        JSON.stringify(electionManifest, null, 2),
        'utf-8',
      );
      await fs.writeFile(
        path.join(escapedBundleDir, 'close-statement.json'),
        JSON.stringify(closeStatement, null, 2),
        'utf-8',
      );
      await fs.symlink(escapedBundleDir, symlinkBundlePath, 'dir');

      expect(
        hasConsistentPublicAuditArtifacts({
          journal,
          verificationExecutionId: 'exec-1',
          s3BundleKey: 'sessions/session-123/exec-1/bundle.zip',
          verificationResult: {
            status: 'success',
          },
        }),
      ).toBe(false);
    } finally {
      process.env.VERIFIER_WORK_DIR = previousVerifierWorkDir;
      await fs.rm(verifierWorkDir, { recursive: true, force: true });
      await fs.rm(escapedBundleDir, { recursive: true, force: true });
    }
  });
});
