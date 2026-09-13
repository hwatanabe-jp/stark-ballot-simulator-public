import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BotVoter } from './botVoter';
import { generateBotVote } from '@stark-ballot/domain/bot/voteGenerator';
import { createMockVoteStore, type MockVoteStore } from '../finalize/test-support/mockVoteStore';
import type {
  SessionIdentityRecord,
  SessionVotingRecord,
  StoredVoteRecord,
} from '@stark-ballot/domain/types/sessionRecords';
import { SimpleBulletinBoard } from '@stark-ballot/domain/bulletin/simple-bulletin-board';
import type { FinalizationRecord } from '@stark-ballot/application/finalize/finalization-record';
import { createTestJournal } from '@stark-ballot/test-support/testing/test-helpers';
import {
  buildDefaultElectionConfig,
  getDefaultElectionConfigHash,
} from '@stark-ballot/zkvm-contract/zkvm/election-config';
import { asSessionId, type SessionId } from '@stark-ballot/domain/types/identifiers';
import { asFinalizationId } from '@stark-ballot/application/finalize/finalization-id';
import { createUnavailableFinalizationArtifacts } from '@stark-ballot/application/finalize/finalization-types';

function strictDefined<T>(value: T, label = 'value'): NonNullable<T> {
  if (value === undefined || value === null) {
    throw new Error(`Expected ${label} to be defined`);
  }
  return value;
}

vi.mock('@stark-ballot/domain/bot/voteGenerator', () => ({
  generateBotVote: vi.fn(),
}));

const SESSION_ID = asSessionId('test-session-123');
const ELECTION_ID = '550e8400-e29b-41d4-a716-446655440000';
const LOG_ID = `0x${'a'.repeat(64)}`;

function createStoredVote(index: number, vote: StoredVoteRecord['vote'], hexChar: string): StoredVoteRecord {
  return {
    voteId: `00000000-0000-4000-8000-${index.toString().padStart(12, '0')}`,
    vote,
    rand: `0x${hexChar.repeat(64)}`,
    commit: `0x${hexChar.repeat(64)}`,
    timestamp: 1_730_000_000_000 + index,
    rootAtCast: `0x${'b'.repeat(64)}`,
  };
}

function createVotes(botCount: number): Map<number, StoredVoteRecord> {
  const hexChars = ['3', '4', '5', '6', '7', '8', '9', 'a', 'b', 'c', 'd', 'e', 'f'];
  const votes = new Map<number, StoredVoteRecord>([[0, createStoredVote(0, 'A', '2')]]);

  for (let index = 1; index <= botCount; index += 1) {
    const hexChar = strictDefined(hexChars[(index - 1) % hexChars.length]);
    votes.set(index, createStoredVote(index, 'B', hexChar));
  }
  return votes;
}

function createSucceededFinalization(sessionId: SessionId): FinalizationRecord {
  const finalizationId = asFinalizationId('finalization-1');
  return {
    sessionId,
    finalizationId,
    scenarioContext: {
      scenarios: [],
      tamperMode: 'none',
      claimedCounts: { A: 1, B: 0, C: 0, D: 0, E: 0 },
      claimedTotalVotes: 1,
      summary: { ignoredCount: 0, recountedCount: 0, userRecountChoice: null },
    },
    state: {
      status: 'succeeded',
      finalizationId,
      queuedAtMs: 1,
      startedAtMs: 2,
      completedAtMs: 3,
    },
    finalizationResult: {
      finalizationId,
      tally: {
        counts: { A: 1, B: 0, C: 0, D: 0, E: 0 },
        totalVotes: 1,
        tamperedCount: 0,
      },
      imageId: `0x${'c'.repeat(64)}`,
      journal: createTestJournal(),
      artifacts: createUnavailableFinalizationArtifacts(),
    },
  };
}

function createSessionRecords(
  overrides: {
    sessionId?: SessionId;
    electionId?: string;
    votes?: Map<number, StoredVoteRecord>;
    botCount?: number;
    userParticipation?: SessionVotingRecord['userParticipation'];
    currentFinalization?: FinalizationRecord | null;
  } = {},
): {
  identity: SessionIdentityRecord;
  voting: SessionVotingRecord;
  currentFinalization: FinalizationRecord | null;
} {
  const sessionId = overrides.sessionId ?? SESSION_ID;
  const votes = overrides.votes ?? createVotes(0);
  return {
    identity: {
      sessionId,
      electionId: overrides.electionId ?? ELECTION_ID,
      electionConfigHash: getDefaultElectionConfigHash(),
      electionConfig: buildDefaultElectionConfig(),
      logId: LOG_ID,
      createdAtMs: 1_730_000_000_000,
    },
    voting: {
      sessionId,
      votes,
      bulletin: new SimpleBulletinBoard(LOG_ID),
      bulletinRootHistory: [],
      botCount: overrides.botCount ?? Math.max(votes.size - 1, 0),
      userParticipation: overrides.userParticipation ?? { status: 'cast', voteIndex: 0 },
      lastActivityMs: 1_730_000_000_000,
    },
    currentFinalization: overrides.currentFinalization ?? null,
  };
}

describe('BotVoter', () => {
  let store: MockVoteStore;
  let addBotVotesMock: ReturnType<typeof vi.fn<MockVoteStore['addBotVotes']>>;
  let getSessionIdentityMock: ReturnType<typeof vi.fn<MockVoteStore['getSessionIdentity']>>;
  let getVotingRecordMock: ReturnType<typeof vi.fn<MockVoteStore['getVotingRecord']>>;
  let getCurrentFinalizationRecordMock: ReturnType<typeof vi.fn<MockVoteStore['getCurrentFinalizationRecord']>>;
  let botVoter: BotVoter;

  function admit(records: ReturnType<typeof createSessionRecords>): void {
    getSessionIdentityMock.mockResolvedValue(records.identity);
    getVotingRecordMock.mockResolvedValue(records.voting);
    getCurrentFinalizationRecordMock.mockResolvedValue(records.currentFinalization);
  }

  beforeEach(() => {
    vi.clearAllMocks();
    addBotVotesMock = vi.fn<MockVoteStore['addBotVotes']>().mockResolvedValue({ ok: true, value: undefined });
    getSessionIdentityMock = vi.fn<MockVoteStore['getSessionIdentity']>();
    getVotingRecordMock = vi.fn<MockVoteStore['getVotingRecord']>();
    getCurrentFinalizationRecordMock = vi.fn<MockVoteStore['getCurrentFinalizationRecord']>();
    store = createMockVoteStore({
      addBotVotes: addBotVotesMock,
      getSessionIdentity: getSessionIdentityMock,
      getVotingRecord: getVotingRecordMock,
      getCurrentFinalizationRecord: getCurrentFinalizationRecordMock,
    });
    botVoter = new BotVoter(store);
  });

  describe('startBotVoting', () => {
    it('should generate and add 63 bot votes', async () => {
      vi.mocked(generateBotVote).mockResolvedValue({
        vote: 'A',
        rand: `0x${'1'.repeat(64)}`,
      });
      admit(createSessionRecords());

      await botVoter.startBotVoting(SESSION_ID);

      expect(generateBotVote).toHaveBeenCalledTimes(63);
      expect(addBotVotesMock).toHaveBeenCalled();
      expect(generateBotVote).toHaveBeenCalledWith();
      const submittedBatch = addBotVotesMock.mock.calls[0]?.[1];
      expect(submittedBatch).toHaveLength(63);
      expect(submittedBatch?.every((vote) => Object.keys(vote).sort().join(',') === 'rand,vote')).toBe(true);
    });

    it('should add bot votes in a single batch for speed', async () => {
      vi.mocked(generateBotVote).mockResolvedValue({
        vote: 'A',
        rand: `0x${'1'.repeat(64)}`,
      });
      admit(createSessionRecords());

      await botVoter.startBotVoting(SESSION_ID);

      expect(addBotVotesMock).toHaveBeenCalledTimes(1);
    });

    it('should handle partial bot voting (resume)', async () => {
      vi.mocked(generateBotVote).mockResolvedValue({
        vote: 'A',
        rand: `0x${'1'.repeat(64)}`,
      });
      admit(createSessionRecords({ votes: createVotes(30), botCount: 30 }));

      await botVoter.startBotVoting(SESSION_ID);

      expect(generateBotVote).toHaveBeenCalledTimes(33);
    });

    it('rejects inconsistent bot count metadata', async () => {
      vi.mocked(generateBotVote).mockResolvedValue({
        vote: 'A',
        rand: `0x${'1'.repeat(64)}`,
      });
      admit(createSessionRecords({ votes: createVotes(2), botCount: 0 }));

      await expect(botVoter.startBotVoting(SESSION_ID)).rejects.toThrow('Invalid bot vote count');

      expect(generateBotVote).not.toHaveBeenCalled();
    });

    it('should not start if session is finalized', async () => {
      admit(createSessionRecords({ currentFinalization: createSucceededFinalization(SESSION_ID) }));

      await expect(botVoter.startBotVoting(SESSION_ID)).rejects.toThrow('SESSION_ALREADY_FINALIZED');

      expect(generateBotVote).not.toHaveBeenCalled();
      expect(addBotVotesMock).not.toHaveBeenCalled();
    });

    it('should not start if all bots have voted', async () => {
      admit(createSessionRecords({ votes: createVotes(63), botCount: 63 }));

      await expect(botVoter.startBotVoting(SESSION_ID)).resolves.toBeUndefined();

      expect(generateBotVote).not.toHaveBeenCalled();
      expect(addBotVotesMock).not.toHaveBeenCalled();
    });

    it('should handle errors gracefully', async () => {
      vi.mocked(generateBotVote).mockRejectedValue(new Error('Generation failed'));
      admit(createSessionRecords());

      await expect(botVoter.startBotVoting(SESSION_ID)).rejects.toThrow('Generation failed');
    });

    it('bounds retries when repeated store conflicts cannot establish completion', async () => {
      vi.mocked(generateBotVote).mockResolvedValue({ vote: 'A', rand: `0x${'1'.repeat(64)}` });
      addBotVotesMock.mockResolvedValue({ ok: false, error: { code: 'ALREADY_VOTED' } });
      admit(createSessionRecords());
      await expect(botVoter.startBotVoting(SESSION_ID)).rejects.toThrow('Bot voting contention limit exceeded');
      expect(addBotVotesMock).toHaveBeenCalledTimes(3);
    });

    it('recognizes completion by a competing invocation after a typed conflict', async () => {
      vi.mocked(generateBotVote).mockResolvedValue({ vote: 'A', rand: `0x${'1'.repeat(64)}` });
      admit(createSessionRecords());
      addBotVotesMock.mockImplementationOnce(() => {
        admit(
          createSessionRecords({
            votes: createVotes(63),
            botCount: 63,
            currentFinalization: createSucceededFinalization(SESSION_ID),
          }),
        );
        return Promise.resolve({ ok: false, error: { code: 'SESSION_FINALIZED' } });
      });
      await expect(botVoter.startBotVoting(SESSION_ID)).resolves.toBeUndefined();
      expect(addBotVotesMock).toHaveBeenCalledTimes(1);
    });

    it('propagates infrastructure errors without interpreting them as completion', async () => {
      vi.mocked(generateBotVote).mockResolvedValue({ vote: 'A', rand: `0x${'1'.repeat(64)}` });
      admit(createSessionRecords());
      const failure = new Error('Access denied');
      addBotVotesMock.mockRejectedValueOnce(failure);
      await expect(botVoter.startBotVoting(SESSION_ID)).rejects.toBe(failure);
      expect(addBotVotesMock).toHaveBeenCalledTimes(1);
    });

    it('fails closed when the identity record is unavailable', async () => {
      const records = createSessionRecords();
      getSessionIdentityMock.mockResolvedValue(null);
      getVotingRecordMock.mockResolvedValue(records.voting);
      getCurrentFinalizationRecordMock.mockResolvedValue(null);

      await expect(botVoter.startBotVoting(SESSION_ID)).rejects.toThrow('SESSION_NOT_FOUND');

      expect(generateBotVote).not.toHaveBeenCalled();
      expect(addBotVotesMock).not.toHaveBeenCalled();
    });

    it('fails closed when bot voting is requested before the canonical user vote exists', async () => {
      admit(
        createSessionRecords({
          votes: new Map(),
          botCount: 0,
          userParticipation: { status: 'not_cast' },
        }),
      );

      await expect(botVoter.startBotVoting(SESSION_ID)).rejects.toThrow('USER_VOTE_REQUIRED_BEFORE_BOT_VOTES');

      expect(generateBotVote).not.toHaveBeenCalled();
      expect(addBotVotesMock).not.toHaveBeenCalled();
    });

    it('fails closed when the stored user vote index is not the canonical index zero', async () => {
      admit(
        createSessionRecords({
          votes: createVotes(1),
          botCount: 1,
          userParticipation: { status: 'cast', voteIndex: 1 },
        }),
      );

      await expect(botVoter.startBotVoting(SESSION_ID)).rejects.toThrow('USER_VOTE_REQUIRED_BEFORE_BOT_VOTES');

      expect(generateBotVote).not.toHaveBeenCalled();
      expect(addBotVotesMock).not.toHaveBeenCalled();
    });
  });

  describe('getProgress', () => {
    it('should return current bot voting progress', async () => {
      getVotingRecordMock.mockResolvedValue(createSessionRecords({ votes: createVotes(50) }).voting);

      const progress = await botVoter.getProgress(SESSION_ID);

      expect(progress).toEqual({
        completed: 50,
        total: 63,
        percentage: Math.round((50 / 63) * 100),
      });
    });

    it('derives progress from canonical vote count when metadata is stale', async () => {
      getVotingRecordMock.mockResolvedValue(createSessionRecords({ votes: createVotes(2), botCount: 0 }).voting);

      const progress = await botVoter.getProgress(SESSION_ID);

      expect(progress).toEqual({
        completed: 2,
        total: 63,
        percentage: Math.round((2 / 63) * 100),
      });
    });

    it('should return null for non-existent session', async () => {
      getVotingRecordMock.mockResolvedValue(null);

      const progress = await botVoter.getProgress(asSessionId('non-existent'));

      expect(progress).toBeNull();
    });
  });
});
