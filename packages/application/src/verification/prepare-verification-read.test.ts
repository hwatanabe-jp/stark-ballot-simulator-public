import { describe, expect, it, vi } from 'vitest';
import {
  createUnavailableFinalizationArtifacts,
  type FinalizationResultAuthority,
} from '../finalize/finalization-types';
import {
  prepareVerificationRead,
  type VerificationReadPort,
  type VerificationReadSource,
} from './prepare-verification-read';
import { CURRENT_METHOD_VERSION } from '@stark-ballot/zkvm-contract/zkvm/types';
import { asSessionId } from '@stark-ballot/domain/types/identifiers';
import { asFinalizationId } from '@stark-ballot/application/finalize/finalization-id';

const HEX_A = `0x${'a'.repeat(64)}`;
const HEX_B = `0x${'b'.repeat(64)}`;
const HEX_C = `0x${'c'.repeat(64)}`;
const SESSION_ID = asSessionId('session-1');
const FINALIZATION_ID = asFinalizationId('finalization-1');
const OTHER_FINALIZATION_ID = asFinalizationId('other-finalization');

const authority = {
  tally: {
    counts: { A: 1, B: 0, C: 0, D: 0, E: 0 },
    totalVotes: 1,
    tamperedCount: 0,
  },
  imageId: HEX_A,
  artifacts: createUnavailableFinalizationArtifacts(),
  journal: {
    electionId: 'election-1',
    electionConfigHash: HEX_B,
    bulletinRoot: HEX_C,
    treeSize: 1,
    totalExpected: 1,
    sthDigest: HEX_A,
    verifiedTally: [1, 0, 0, 0, 0],
    totalVotes: 1,
    validVotes: 1,
    invalidVotes: 0,
    seenIndicesCount: 1,
    missingSlots: 0,
    invalidPresentedSlots: 0,
    rejectedRecords: 0,
    seenBitmapRoot: HEX_B,
    includedBitmapRoot: HEX_C,
    excludedSlots: 0,
    inputCommitment: HEX_A,
    methodVersion: CURRENT_METHOD_VERSION,
  },
} satisfies FinalizationResultAuthority;

const source: VerificationReadSource = {
  sessionId: SESSION_ID,
  electionId: 'election-1',
  electionConfigHash: HEX_B,
  logId: HEX_C,
  createdAtMs: 1,
  lastActivityAtMs: 2,
  userVote: {
    index: 0,
    voteId: 'vote-1',
    commitment: HEX_A,
  },
  finalization: {
    finalizationId: FINALIZATION_ID,
    authority,
  },
};

function withoutAuthorityField(field: 'electionId' | 'electionConfigHash' | 'logId'): VerificationReadSource {
  const incompleteSource: VerificationReadSource = { ...source };
  delete incompleteSource[field];
  return incompleteSource;
}

const sourceWithoutElectionId = withoutAuthorityField('electionId');
const sourceWithoutElectionConfigHash = withoutAuthorityField('electionConfigHash');
const sourceWithoutLogId = withoutAuthorityField('logId');

function port(overrides: Partial<VerificationReadPort> = {}): VerificationReadPort {
  return {
    readCurrent: vi.fn(() =>
      Promise.resolve({
        availability: 'available' as const,
        source,
      }),
    ),
    readExactVoterEvidence: vi.fn(() =>
      Promise.resolve({
        availability: 'available' as const,
        voteReceipt: {
          voteId: 'vote-1',
          commitment: HEX_A,
          bulletinIndex: 0,
          bulletinRootAtCast: HEX_C,
          castAtMs: 1,
        },
        userVote: {
          commitment: HEX_A,
          voteId: 'vote-1',
          proof: {
            leafIndex: 0,
            treeSize: 1,
            merklePath: [],
            bulletinRootAtCast: HEX_C,
          },
        },
      }),
    ),
    ...overrides,
  };
}

describe('prepareVerificationRead', () => {
  it('admits complete current authority and exact voter evidence without a mutation port', async () => {
    const reader = port();

    await expect(
      prepareVerificationRead(
        {
          sessionId: SESSION_ID,
          finalizationId: FINALIZATION_ID,
        },
        reader,
      ),
    ).resolves.toMatchObject({
      availability: 'available',
      source,
      voterEvidence: {
        availability: 'available',
        userVote: {
          voteId: 'vote-1',
        },
      },
    });

    expect(reader.readCurrent).toHaveBeenCalledWith('session-1');
    expect(reader.readExactVoterEvidence).toHaveBeenCalledWith({
      sessionId: SESSION_ID,
      voteId: 'vote-1',
      voteIndex: 0,
      expectedCommitment: HEX_A,
    });
    expect(Object.keys(reader).sort()).toEqual(['readCurrent', 'readExactVoterEvidence']);
  });

  it('fails closed when the requested finalization is not current', async () => {
    const reader = port();

    await expect(
      prepareVerificationRead(
        {
          sessionId: SESSION_ID,
          finalizationId: OTHER_FINALIZATION_ID,
        },
        reader,
      ),
    ).resolves.toEqual({
      availability: 'unavailable',
      reason: 'finalization_not_current',
    });
    expect(reader.readExactVoterEvidence).not.toHaveBeenCalled();
  });

  it.each([
    ['electionId', sourceWithoutElectionId],
    ['electionConfigHash', sourceWithoutElectionConfigHash],
    ['logId', sourceWithoutLogId],
  ] as const)('treats missing %s authority as corrupt instead of repairing it', async (_field, incompleteSource) => {
    const reader = port({
      readCurrent: vi.fn(() =>
        Promise.resolve({
          availability: 'available' as const,
          source: incompleteSource,
        }),
      ),
    });

    await expect(
      prepareVerificationRead(
        {
          sessionId: SESSION_ID,
          finalizationId: FINALIZATION_ID,
        },
        reader,
      ),
    ).resolves.toEqual({
      availability: 'corrupt',
      reason: 'incomplete_session_authority',
    });
    expect(reader.readExactVoterEvidence).not.toHaveBeenCalled();
  });

  it('derives unavailable voter identity from the admitted source without inventing a receipt or proof', async () => {
    const reader = port({
      readExactVoterEvidence: vi.fn(() =>
        Promise.resolve({
          availability: 'unavailable' as const,
          reason: 'exact_proof_unavailable' as const,
        }),
      ),
    });

    await expect(
      prepareVerificationRead(
        {
          sessionId: SESSION_ID,
          finalizationId: FINALIZATION_ID,
        },
        reader,
      ),
    ).resolves.toMatchObject({
      availability: 'available',
      voterEvidence: {
        availability: 'unavailable',
        reason: 'exact_proof_unavailable',
        userVote: {
          commitment: HEX_A,
          voteId: 'vote-1',
        },
      },
    });
  });

  it('propagates unavailable and corrupt current-read outcomes without reading voter evidence', async () => {
    for (const outcome of [
      { availability: 'unavailable' as const, reason: 'user_vote_unavailable' as const },
      { availability: 'corrupt' as const, reason: 'invalid_artifact' as const },
    ]) {
      const reader = port({
        readCurrent: vi.fn(() => Promise.resolve(outcome)),
      });

      await expect(
        prepareVerificationRead(
          {
            sessionId: SESSION_ID,
            finalizationId: FINALIZATION_ID,
          },
          reader,
        ),
      ).resolves.toEqual(outcome);
      expect(reader.readExactVoterEvidence).not.toHaveBeenCalled();
    }
  });
});
