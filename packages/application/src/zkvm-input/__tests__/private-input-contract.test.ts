import { describe, expect, it } from 'vitest';
import type {
  SessionIdentityRecord,
  SessionVotingRecord,
  StoredVoteRecord,
} from '@stark-ballot/domain/types/sessionRecords';
import { BOT_COUNT } from '@stark-ballot/domain/shared/constants';
import { SimpleBulletinBoard } from '@stark-ballot/domain/bulletin/simple-bulletin-board';
import { buildDefaultElectionConfig, hashElectionConfig } from '@stark-ballot/zkvm-contract/zkvm/election-config';
import type { ZkVMInputSessionRecords } from '@stark-ballot/application/zkvm-input/input-builder';
import {
  buildCanonicalZkVMInputFromSession,
  CanonicalZkVMInputValidationError,
} from '@stark-ballot/application/zkvm-input/private-input-contract';

const SNAPSHOT_TIMESTAMP = 1_695_000_000_000;

function createVoteData(index: number, overrides?: Partial<StoredVoteRecord>): StoredVoteRecord {
  const vote = overrides?.vote ?? 'A';
  const commitmentDigit = vote === 'A' ? '2' : '3';
  return {
    voteId: `00000000-0000-4000-8000-${index.toString().padStart(12, '0')}`,
    vote,
    rand: `0x${'1'.repeat(64)}`,
    commit: `0x${commitmentDigit.repeat(64)}`,
    timestamp: SNAPSHOT_TIMESTAMP - 1 + index,
    rootAtCast: `0x${'a'.repeat(64)}`,
    ...overrides,
  };
}

function createSession(overrides?: {
  electionConfig?: SessionIdentityRecord['electionConfig'];
  electionConfigHash?: string;
}): ZkVMInputSessionRecords {
  const electionConfig = overrides?.electionConfig ?? buildDefaultElectionConfig();
  const votes = new Map<number, StoredVoteRecord>([
    [0, createVoteData(0)],
    [1, createVoteData(1, { vote: 'B' })],
  ]);

  const bulletin = new SimpleBulletinBoard(`0x${'b'.repeat(64)}`);
  for (const vote of votes.values()) {
    bulletin.appendVote(vote.voteId, vote.commit.slice(2));
  }

  const identity: SessionIdentityRecord = {
    sessionId: 'session-test',
    electionId: '550e8400-e29b-41d4-a716-446655440000',
    electionConfigHash: overrides?.electionConfigHash ?? hashElectionConfig(electionConfig),
    electionConfig,
    logId: `0x${'b'.repeat(64)}`,
    createdAtMs: SNAPSHOT_TIMESTAMP - 10,
  };
  const voting: SessionVotingRecord = {
    sessionId: identity.sessionId,
    votes,
    bulletin,
    botCount: BOT_COUNT,
    userParticipation: { status: 'cast', voteIndex: 0 },
    lastActivityMs: SNAPSHOT_TIMESTAMP,
    bulletinRootHistory: [
      {
        timestamp: SNAPSHOT_TIMESTAMP,
        root: bulletin.getCurrentRoot(),
        treeSize: votes.size,
      },
    ],
  };
  return { identity, voting };
}

describe('buildCanonicalZkVMInputFromSession', () => {
  it('returns the canonical private input for a valid session', () => {
    const input = buildCanonicalZkVMInputFromSession(createSession());

    expect(input.electionId).toBe('550e8400-e29b-41d4-a716-446655440000');
    expect(input.totalExpected).toBe(BOT_COUNT + 1);
    expect(input.timestamp).toBe(SNAPSHOT_TIMESTAMP);
    expect(input.votes).toHaveLength(2);
  });

  it('fails closed when the built input does not satisfy the canonical validator', () => {
    const invalidElectionConfig = {
      ...buildDefaultElectionConfig(),
      totalExpected: 0,
    };

    expect(() =>
      buildCanonicalZkVMInputFromSession(
        createSession({
          electionConfig: invalidElectionConfig,
          electionConfigHash: hashElectionConfig(invalidElectionConfig),
        }),
      ),
    ).toThrow(CanonicalZkVMInputValidationError);

    try {
      buildCanonicalZkVMInputFromSession(
        createSession({
          electionConfig: invalidElectionConfig,
          electionConfigHash: hashElectionConfig(invalidElectionConfig),
        }),
      );
    } catch (error) {
      expect(error).toBeInstanceOf(CanonicalZkVMInputValidationError);
      expect((error as CanonicalZkVMInputValidationError).errors).toEqual(
        expect.arrayContaining(['Invalid totalExpected: must be between 1 and 1000000']),
      );
    }
  });
});
