import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { createTestJournal, createTestVoteWithProof } from '@stark-ballot/test-support/testing/test-helpers';
import type { FinalizationScenarioContext } from '@stark-ballot/application/finalize/finalization-types';
import {
  buildFinalizationResultFromJournal,
  hasConsistentPublicAuditArtifacts,
  hydrateFinalizationResultFromJournal,
} from '@stark-ballot/application/finalize/finalization-result';
import { createTestPublicInputArtifact } from '@stark-ballot/test-support/testing/public-input-artifact';
import { buildCloseStatement, buildElectionManifest } from '@stark-ballot/verification/public-audit-artifacts';
import { buildDefaultElectionConfig } from '@stark-ballot/zkvm-contract/zkvm/election-config';
import {
  CURRENT_METHOD_VERSION,
  asUnixTimestampMillis,
  computeInputCommitment,
  computeSTHDigest,
  type ZkVMInput,
  type ZkVMJournal,
} from '@stark-ballot/zkvm-contract/zkvm/types';
import { omitUndefinedProperties } from '@stark-ballot/validation/definedProperties';
import { sanitizeFinalizationResultVerificationStatus } from '@stark-ballot/verification/fail-closed-status';

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
  it('maps journal fields into pure finalization authority without delivery metadata', () => {
    const journal = createTestJournal({
      totalExpected: 64,
      validVotes: 61,
      missingSlots: 1,
      invalidPresentedSlots: 2,
    });

    const result = buildFinalizationResultFromJournal({
      journal,
      imageId: 'image-id-123',
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
    expect(result).not.toHaveProperty('s3BundleKey');
    expect(result).not.toHaveProperty('s3UploadedAtMs');
    expect(result.imageId).toBe('image-id-123');
    expect(result).not.toHaveProperty('finalizationId');
    expect(result.electionManifest).toBeUndefined();
    expect(result.closeStatement).toBeUndefined();
    expect(result.journal).toEqual(journal);
    expect(result.receipt).toBeUndefined();
    expect('bulletinRoot' in result).toBe(false);
    expect('verifiedTally' in result).toBe(false);
    expect('missingIndices' in result).toBe(false);
    expect('excludedCount' in result).toBe(false);
  });

  it('rejects current-method journals with legacy count aliases', () => {
    const journal = {
      ...createTestJournal(),
      excludedCount: 1,
    };

    expect(() =>
      buildFinalizationResultFromJournal({
        journal,
        imageId: 'image-id-123',
      }),
    ).toThrow('Current zkVM journal contains unsupported legacy count aliases');
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
      missingSlots: 0,
      invalidPresentedSlots: 0,
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

describe('hydrateFinalizationResultFromJournal', () => {
  it('fills journal-derived fields when missing', () => {
    const journal = createTestJournal({
      totalExpected: 64,
      validVotes: 60,
      missingSlots: 2,
      invalidPresentedSlots: 2,
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
      publicInputArtifact: createAuthoritativePublicInputArtifact(journal),
    };

    const hydrated = hydrateFinalizationResultFromJournal(partialResult);
    if (!hydrated) {
      throw new Error('Expected hydrated result to be defined');
    }
    expect(hydrated.journal.missingSlots).toBe(journal.missingSlots);
    expect(hydrated.journal.invalidPresentedSlots).toBe(journal.invalidPresentedSlots);
    expect(hydrated.journal.validVotes).toBe(journal.validVotes);
    expect(hydrated.journal.totalExpected).toBe(journal.totalExpected);
    expect(hydrated.journal.treeSize).toBe(journal.treeSize);
    expect(hydrated.tally.totalVotes).toBe(partialResult.tally.totalVotes);
  });

  it('accepts bundle-restored public input summary when provided fields remain consistent', () => {
    const journal = createTestJournal({
      totalExpected: 64,
      validVotes: 64,
      missingSlots: 0,
      invalidPresentedSlots: 0,
    });

    const publicInputArtifact = createTestPublicInputArtifact({
      source: 'bundle',
      finalizationId: 'exec-1',
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
      publicInputArtifact,
    });

    expect(hydrated?.publicInputArtifact).toEqual(publicInputArtifact);
  });

  it('accepts generated public input summary when no bundle authority is expected', () => {
    const journal = createTestJournal({
      totalExpected: 64,
      validVotes: 64,
      missingSlots: 0,
      invalidPresentedSlots: 0,
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
      publicInputArtifact,
      closeStatement,
    });

    expect(hydrated?.publicInputArtifact).toEqual(publicInputArtifact);
    expect(hydrated?.closeStatement).toEqual(closeStatement);
  });

  it('accepts generated public input summary when sync authority matches finalization and bundle identity', () => {
    const journal = createTestJournal({
      totalExpected: 64,
      validVotes: 64,
      missingSlots: 0,
      invalidPresentedSlots: 0,
    });

    const publicInputArtifact = createTestPublicInputArtifact({
      source: 'generated',
      finalizationId: 'exec-1',
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
      publicInputArtifact,
      closeStatement,
    });

    expect(hydrated?.publicInputArtifact).toEqual(publicInputArtifact);
    expect(hydrated?.closeStatement).toEqual(closeStatement);
  });

  it('keeps generated public input summary when typed authority matches at the pure application boundary', () => {
    const journal = createTestJournal({
      totalExpected: 64,
      validVotes: 64,
      missingSlots: 0,
      invalidPresentedSlots: 0,
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
      publicInputArtifact: createTestPublicInputArtifact({
        source: 'generated',
        finalizationId: 'stale-exec',
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
    });

    expect(hydrated?.publicInputArtifact?.provenance).toMatchObject({
      source: 'generated',
      finalizationId: 'stale-exec',
      bundleKey: 'sessions/session-1/stale-exec/bundle.zip',
    });
  });

  it('fails closed when an authoritative bundle summary omits required public-input fields', () => {
    const journal = createTestJournal({
      totalExpected: 64,
      validVotes: 64,
      missingSlots: 0,
      invalidPresentedSlots: 0,
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
      publicInputArtifact: createTestPublicInputArtifact({
        source: 'bundle',
        finalizationId: 'exec-1',
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
    });

    expect(hydrated).toBeUndefined();
  });

  it('fails closed when authoritative public-input authority is missing entirely', () => {
    const journal = createTestJournal({
      totalExpected: 64,
      validVotes: 64,
      missingSlots: 0,
      invalidPresentedSlots: 0,
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
    });

    expect(hydrated).toBeUndefined();
  });

  it('keeps sync-generated public-input authority without bundle metadata when provenance is authoritative', () => {
    const journal = createTestJournal({
      totalExpected: 64,
      validVotes: 61,
      missingSlots: 1,
      invalidPresentedSlots: 2,
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

  it('keeps journal-derived fields on hydrated canonical results', () => {
    const baseJournal = {
      ...createTestJournal({
        totalExpected: 64,
        validVotes: 61,
        missingSlots: 1,
        invalidPresentedSlots: 2,
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
      finalizationId: 'exec-1',
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
      publicInputArtifact,
      electionManifest,
      closeStatement,
      receipt: {
        seal: 'base64-seal',
        journal: 'base64-journal',
      },
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
    expect(hydrated.journal.bulletinRoot).toBe(journal.bulletinRoot);
    expect(hydrated.journal.verifiedTally).toEqual(journal.verifiedTally);
    expect(hydrated.journal.missingSlots).toBe(journal.missingSlots);
    expect(hydrated.journal.invalidPresentedSlots).toBe(journal.invalidPresentedSlots);
    expect(hydrated.journal.validVotes).toBe(journal.validVotes);
    expect(hydrated.journal.totalExpected).toBe(journal.totalExpected);
    expect(hydrated.journal.treeSize).toBe(journal.treeSize);
    expect(hydrated.journal.excludedSlots).toBe(journal.excludedSlots);
    expect(hydrated.journal.sthDigest).toBe(journal.sthDigest);
    expect(hydrated.journal.seenBitmapRoot).toBe(journal.seenBitmapRoot);
    expect(hydrated.journal.includedBitmapRoot).toBe(journal.includedBitmapRoot);
    expect(hydrated.journal.seenIndicesCount).toBe(journal.seenIndicesCount);
    expect(hydrated.journal.inputCommitment).toBe(journal.inputCommitment);
    expect(hydrated.publicInputArtifact).toEqual(publicInputArtifact);
    expect(hydrated.electionManifest).toEqual(electionManifest);
    expect(hydrated.closeStatement).toEqual(closeStatement);
    expect(hydrated.receipt).toEqual({
      seal: 'base64-seal',
      journal: 'base64-journal',
    });
    expect(hydrated).not.toHaveProperty('finalizationId');
    expect(hydrated).not.toHaveProperty('receiptRaw');
  });

  it('rejects legacy count aliases from hydrated canonical journals', () => {
    const journal = {
      ...createTestJournal({
        totalExpected: 64,
        validVotes: 61,
        missingSlots: 1,
        invalidPresentedSlots: 2,
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

    expect(hydrated).toBeUndefined();
  });

  it('keeps verification separate and downgrades success when canonical journal shows excluded votes', () => {
    const journal = createTestJournal({
      totalExpected: 64,
      validVotes: 61,
      missingSlots: 1,
      invalidPresentedSlots: 2,
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
      publicInputArtifact: createAuthoritativePublicInputArtifact(journal),
    });

    expect(hydrated).not.toHaveProperty('verificationResult');
    const sanitized = hydrated
      ? sanitizeFinalizationResultVerificationStatus({
          ...hydrated,
          verificationResult: { status: 'success' },
        })
      : undefined;
    expect(sanitized?.verificationResult.status).toBe('failed');
  });

  it('fails closed when a current-method journal is missing seenBitmapRoot', () => {
    const journal = createTestJournal({
      totalExpected: 64,
      validVotes: 64,
      missingSlots: 0,
      invalidPresentedSlots: 0,
      seenIndicesCount: 64,
    });
    const unsupportedJournal = {
      ...journal,
      ...omitUndefinedProperties({ seenBitmapRoot: undefined }),
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
    });

    expect(hydrated).toBeUndefined();
  });

  it('keeps separate STARK verification success when only the claimed tally disagrees with verified tally', () => {
    const journal = {
      ...createTestJournal({
        totalExpected: 3,
        validVotes: 3,
        missingSlots: 0,
        invalidPresentedSlots: 0,
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
      publicInputArtifact: createAuthoritativePublicInputArtifact(journal),
    });

    expect(hydrated).not.toHaveProperty('verificationResult');
    const sanitized = hydrated
      ? sanitizeFinalizationResultVerificationStatus({
          ...hydrated,
          verificationResult: { status: 'success' },
        })
      : undefined;
    expect(sanitized?.verificationResult.status).toBe('success');
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
    });

    expect(hydrated).toBeUndefined();
  });

  it('fails closed when public audit artifacts drift from canonical proof data', () => {
    const journal = createTestJournal({
      totalExpected: 64,
      validVotes: 61,
      missingSlots: 1,
      invalidPresentedSlots: 2,
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
      missingSlots: 0,
      invalidPresentedSlots: 0,
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
      missingSlots: 0,
      invalidPresentedSlots: 0,
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
      closeStatement: driftedCloseStatement,
    });

    expect(hydrated).toBeUndefined();
  });

  it('does not use nested verification-result state as public-audit authority at the pure application boundary', () => {
    const journal = createTestJournal({
      totalExpected: 64,
      validVotes: 64,
      missingSlots: 0,
      invalidPresentedSlots: 0,
    });
    const bundleKey = 'sessions/session-1/exec-1/bundle.zip';
    const electionManifest = buildElectionManifest(journal.electionId, buildDefaultElectionConfig());
    const closeStatement = buildCloseStatement({
      logId: '0x' + '2'.repeat(64),
      treeSize: journal.treeSize,
      timestamp: 123,
      bulletinRoot: journal.bulletinRoot,
    });

    const result = {
      journal: {
        ...journal,
        electionConfigHash: electionManifest.electionConfigHash,
        sthDigest: closeStatement.sthDigest,
      },
      publicInputArtifact: createTestPublicInputArtifact({
        source: 'generated',
        finalizationId: 'exec-1',
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
    };

    expect(hasConsistentPublicAuditArtifacts(result)).toBe(true);
    const resultWithNestedVerification = {
      ...result,
      verificationResult: {
        status: 'success',
      },
    } as unknown as Parameters<typeof hasConsistentPublicAuditArtifacts>[0];
    expect(hasConsistentPublicAuditArtifacts(resultWithNestedVerification)).toBe(true);
  });

  it('does not treat local bundle artifacts as authoritative when bundlePath finalization mismatches expected authority', async () => {
    const previousVerifierWorkDir = process.env['VERIFIER_WORK_DIR'];
    const verifierWorkDir = await fs.mkdtemp(path.join(os.tmpdir(), 'finalization-result-'));
    process.env['VERIFIER_WORK_DIR'] = verifierWorkDir;

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
          missingSlots: zkvmInput.totalExpected - 1,
          invalidPresentedSlots: 0,
        }),
        electionConfigHash: zkvmInput.electionConfigHash,
        bulletinRoot: zkvmInput.bulletinRoot,
        treeSize: zkvmInput.treeSize,
        totalExpected: zkvmInput.totalExpected,
        sthDigest: computeSTHDigest(
          zkvmInput.logId,
          zkvmInput.treeSize,
          asUnixTimestampMillis(zkvmInput.timestamp),
          zkvmInput.bulletinRoot,
        ),
        inputCommitment: computeInputCommitment(zkvmInput),
        includedBitmapRoot: '0x' + '4'.repeat(64),
        ...omitUndefinedProperties({ seenBitmapRoot: '0x' + '5'.repeat(64) }),
      };
      const oldBundlePath = path.join(verifierWorkDir, 'session-123', 'old-exec');
      await fs.mkdir(oldBundlePath, { recursive: true });
      await fs.writeFile(
        path.join(oldBundlePath, 'public-input.json'),
        JSON.stringify(
          {
            schema: 'stark-ballot.public_input',
            version: '1.1',
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
        }),
      ).toBe(false);
    } finally {
      process.env['VERIFIER_WORK_DIR'] = previousVerifierWorkDir;
      await fs.rm(verifierWorkDir, { recursive: true, force: true });
    }
  });

  it('does not trust local bundle artifacts when a bundle path escapes via symlink', async () => {
    const previousVerifierWorkDir = process.env['VERIFIER_WORK_DIR'];
    const verifierWorkDir = await fs.mkdtemp(path.join(os.tmpdir(), 'finalization-result-'));
    const escapedBundleDir = await fs.mkdtemp(path.join(os.tmpdir(), 'finalization-result-escaped-'));
    process.env['VERIFIER_WORK_DIR'] = verifierWorkDir;

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
          missingSlots: zkvmInput.totalExpected - 1,
          invalidPresentedSlots: 0,
        }),
        electionConfigHash: zkvmInput.electionConfigHash,
        bulletinRoot: zkvmInput.bulletinRoot,
        treeSize: zkvmInput.treeSize,
        totalExpected: zkvmInput.totalExpected,
        sthDigest: computeSTHDigest(
          zkvmInput.logId,
          zkvmInput.treeSize,
          asUnixTimestampMillis(zkvmInput.timestamp),
          zkvmInput.bulletinRoot,
        ),
        inputCommitment: computeInputCommitment(zkvmInput),
        includedBitmapRoot: '0x' + '4'.repeat(64),
        ...omitUndefinedProperties({ seenBitmapRoot: '0x' + '5'.repeat(64) }),
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
        }),
      ).toBe(false);
    } finally {
      process.env['VERIFIER_WORK_DIR'] = previousVerifierWorkDir;
      await fs.rm(verifierWorkDir, { recursive: true, force: true });
      await fs.rm(escapedBundleDir, { recursive: true, force: true });
    }
  });
});
