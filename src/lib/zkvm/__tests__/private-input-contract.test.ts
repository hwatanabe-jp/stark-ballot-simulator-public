import { describe, expect, it, vi } from 'vitest';
import type { SessionData, VoteData } from '@/types/server';
import { BOT_COUNT } from '@/shared/constants';
import { SimpleBulletinBoard } from '@/lib/bulletin/simple-bulletin-board';
import { buildDefaultElectionConfig, hashElectionConfig } from '@/lib/zkvm/election-config';
import {
  buildCanonicalZkVMInputFromSession,
  CanonicalZkVMInputValidationError,
} from '@/lib/zkvm/private-input-contract';

const SNAPSHOT_TIMESTAMP = 1_695_000_000_000;

function createVoteData(overrides?: Partial<VoteData>): VoteData {
  return {
    vote: 'A',
    rand: `0x${'1'.repeat(64)}`,
    commit: `0x${'2'.repeat(64)}`,
    path: [`0x${'3'.repeat(64)}`, `0x${'4'.repeat(64)}`],
    treeSize: 2,
    ...overrides,
  };
}

function createSession(overrides?: Partial<SessionData>): SessionData {
  const electionConfig = buildDefaultElectionConfig();
  const votes = new Map<number, VoteData>([
    [0, createVoteData({ vote: 'A' })],
    [1, createVoteData({ vote: 'B', path: [`0x${'5'.repeat(64)}`, `0x${'6'.repeat(64)}`] })],
  ]);

  const bulletin = new SimpleBulletinBoard(`0x${'b'.repeat(64)}`);
  vi.spyOn(bulletin, 'getCurrentRoot').mockReturnValue(`0x${'a'.repeat(64)}`);
  vi.spyOn(bulletin, 'getLogId').mockReturnValue(`0x${'b'.repeat(64)}`);

  return {
    sessionId: 'session-test',
    electionId: '550e8400-e29b-41d4-a716-446655440000',
    votes,
    bulletin,
    botCount: BOT_COUNT,
    finalized: false,
    createdAt: Date.now(),
    lastActivity: Date.now(),
    bulletinRootHistory: [
      {
        timestamp: SNAPSHOT_TIMESTAMP,
        root: `0x${'a'.repeat(64)}`,
        treeSize: votes.size,
      },
    ],
    electionConfigHash: hashElectionConfig(electionConfig),
    electionConfig,
    logId: `0x${'b'.repeat(64)}`,
    ...overrides,
  };
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
