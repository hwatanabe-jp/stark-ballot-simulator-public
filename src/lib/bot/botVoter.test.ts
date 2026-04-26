import { describe, it, expect, beforeEach, vi } from 'vitest';
import { BotVoter } from './botVoter';
import { generateBotVote } from './voteGenerator';
import type { VoteChoice } from '@/shared/constants';
import { getGlobalStore } from '@/lib/store/storeInstance';
import { createMockVoteStore } from '@/lib/testing/mockVoteStore';
import type { SessionData, VoteData } from '@/types/server';
import type { VoteStore } from '@/types/voteStore';
import { resolveCurrentContractGeneration } from '@/lib/contract';

// Mock dependencies
vi.mock('./voteGenerator', () => ({
  generateBotVote: vi.fn(),
  generateBotId: vi.fn<(index: number) => number>((index) => index + 1),
}));
vi.mock('@/lib/store/storeInstance', () => ({
  getGlobalStore: vi.fn(),
}));

describe('BotVoter', () => {
  let mockStore: VoteStore;
  let addBotVotesMock: ReturnType<typeof vi.fn<NonNullable<VoteStore['addBotVotes']>>>;
  let getSessionMock: ReturnType<typeof vi.fn<NonNullable<VoteStore['getSession']>>>;
  let botVoter: BotVoter;

  const createVotes = (botCount: number): Map<number, VoteData> => {
    const hexChars = ['3', '4', '5', '6', '7', '8', '9', 'a', 'b', 'c', 'd', 'e', 'f'];
    const votes = new Map<number, VoteData>([
      [
        0,
        {
          vote: 'A',
          rand: '0x' + '1'.repeat(64),
          commit: '0x' + '2'.repeat(64),
          path: [],
        },
      ],
    ]);

    for (let index = 1; index <= botCount; index += 1) {
      const hexChar = hexChars[(index - 1) % hexChars.length];
      votes.set(index, {
        vote: 'B',
        rand: `0x${hexChar.repeat(64)}`,
        commit: `0x${hexChar.repeat(64)}`,
        path: [],
      });
    }

    return votes;
  };

  const createBaseSession = (overrides: Partial<SessionData> = {}): SessionData => {
    const now = Date.now();
    return {
      sessionId: 'test-session-123',
      contractGeneration: resolveCurrentContractGeneration(),
      votes: createVotes(0),
      botCount: 0,
      finalized: false,
      createdAt: now,
      lastActivity: now,
      userVoteIndex: 0,
      ...overrides,
    };
  };

  beforeEach(() => {
    vi.clearAllMocks();

    // Setup mock store
    addBotVotesMock = vi.fn<NonNullable<VoteStore['addBotVotes']>>();
    getSessionMock = vi.fn<NonNullable<VoteStore['getSession']>>();
    mockStore = createMockVoteStore({
      addBotVotes: addBotVotesMock,
      getSession: getSessionMock,
    });

    // Mock getGlobalStore to return mockStore
    vi.mocked(getGlobalStore).mockReturnValue(mockStore);

    botVoter = new BotVoter();
  });

  describe('startBotVoting', () => {
    it('should generate and add 63 bot votes', async () => {
      // Arrange
      const sessionId = 'test-session-123';
      const mockVote = {
        vote: 'A' as VoteChoice,
        rand: '0x' + '1'.repeat(64),
        commit: '0x' + '2'.repeat(64),
        path: [],
      };

      vi.mocked(generateBotVote).mockResolvedValue(mockVote);
      addBotVotesMock.mockResolvedValue(undefined);
      getSessionMock.mockResolvedValue(
        createBaseSession({
          sessionId,
          botCount: 0,
          finalized: false,
          electionId: '550e8400-e29b-41d4-a716-446655440000',
        }),
      );

      // Act
      await botVoter.startBotVoting(sessionId);

      // Assert
      expect(generateBotVote).toHaveBeenCalledTimes(63);
      expect(addBotVotesMock).toHaveBeenCalled();

      // Verify bot IDs 1-63 were generated
      for (let i = 1; i <= 63; i++) {
        expect(generateBotVote).toHaveBeenCalledWith(i, '550e8400-e29b-41d4-a716-446655440000');
      }
    });

    it('should add bot votes in a single batch for speed', async () => {
      // Arrange
      const sessionId = 'test-session-123';
      const mockVote = {
        vote: 'A' as VoteChoice,
        rand: '0x' + '1'.repeat(64),
        commit: '0x' + '2'.repeat(64),
        path: [],
      };

      vi.mocked(generateBotVote).mockResolvedValue(mockVote);
      addBotVotesMock.mockResolvedValue(undefined);
      getSessionMock.mockResolvedValue(
        createBaseSession({
          sessionId,
          botCount: 0,
          finalized: false,
          electionId: '550e8400-e29b-41d4-a716-446655440000',
        }),
      );

      // Act
      await botVoter.startBotVoting(sessionId);

      // Assert
      expect(addBotVotesMock).toHaveBeenCalledTimes(1);
    });

    it('should handle partial bot voting (resume)', async () => {
      // Arrange
      const sessionId = 'test-session-123';
      const mockVote = {
        vote: 'A' as VoteChoice,
        rand: '0x' + '1'.repeat(64),
        commit: '0x' + '2'.repeat(64),
        path: [],
      };

      vi.mocked(generateBotVote).mockResolvedValue(mockVote);
      addBotVotesMock.mockResolvedValue(undefined);

      // Session already has 30 bot votes
      getSessionMock.mockResolvedValue(
        createBaseSession({
          sessionId,
          botCount: 30,
          finalized: false,
          electionId: '550e8400-e29b-41d4-a716-446655440000',
          votes: createVotes(30),
        }),
      );

      // Act
      await botVoter.startBotVoting(sessionId);

      // Assert
      // Should only generate remaining 33 votes
      expect(generateBotVote).toHaveBeenCalledTimes(33);
    });

    it('derives remaining bot votes from canonical vote count when metadata is stale', async () => {
      const sessionId = 'test-session-123';
      const mockVote = {
        vote: 'A' as VoteChoice,
        rand: '0x' + '1'.repeat(64),
        commit: '0x' + '2'.repeat(64),
        path: [],
      };

      vi.mocked(generateBotVote).mockResolvedValue(mockVote);
      addBotVotesMock.mockResolvedValue(undefined);
      getSessionMock.mockResolvedValue(
        createBaseSession({
          sessionId,
          botCount: 0,
          finalized: false,
          electionId: '550e8400-e29b-41d4-a716-446655440000',
          votes: new Map([
            [
              0,
              {
                vote: 'A',
                rand: '0x' + '1'.repeat(64),
                commit: '0x' + '2'.repeat(64),
                path: [],
              },
            ],
            [
              1,
              {
                vote: 'B',
                rand: '0x' + '3'.repeat(64),
                commit: '0x' + '4'.repeat(64),
                path: [],
              },
            ],
            [
              2,
              {
                vote: 'C',
                rand: '0x' + '5'.repeat(64),
                commit: '0x' + '6'.repeat(64),
                path: [],
              },
            ],
          ]),
          userVoteIndex: 0,
        }),
      );

      await botVoter.startBotVoting(sessionId);

      expect(generateBotVote).toHaveBeenCalledTimes(61);
      expect(generateBotVote).toHaveBeenNthCalledWith(1, 3, '550e8400-e29b-41d4-a716-446655440000');
      expect(generateBotVote).toHaveBeenLastCalledWith(63, '550e8400-e29b-41d4-a716-446655440000');
    });

    it('should not start if session is finalized', async () => {
      // Arrange
      const sessionId = 'test-session-123';

      getSessionMock.mockResolvedValue(
        createBaseSession({
          sessionId,
          botCount: 0,
          finalized: true,
          electionId: '550e8400-e29b-41d4-a716-446655440000',
        }),
      );

      // Act & Assert
      await expect(botVoter.startBotVoting(sessionId)).rejects.toThrow('SESSION_ALREADY_FINALIZED');

      expect(generateBotVote).not.toHaveBeenCalled();
      expect(addBotVotesMock).not.toHaveBeenCalled();
    });

    it('should not start if all bots have voted', async () => {
      // Arrange
      const sessionId = 'test-session-123';

      getSessionMock.mockResolvedValue(
        createBaseSession({
          sessionId,
          botCount: 63,
          finalized: false,
          electionId: '550e8400-e29b-41d4-a716-446655440000',
          votes: createVotes(63),
        }),
      );

      // Act & Assert
      await expect(botVoter.startBotVoting(sessionId)).rejects.toThrow('ALL_BOTS_VOTED');

      expect(generateBotVote).not.toHaveBeenCalled();
      expect(addBotVotesMock).not.toHaveBeenCalled();
    });

    it('should handle errors gracefully', async () => {
      // Arrange
      const sessionId = 'test-session-123';

      vi.mocked(generateBotVote).mockRejectedValue(new Error('Generation failed'));
      getSessionMock.mockResolvedValue(
        createBaseSession({
          sessionId,
          botCount: 0,
          finalized: false,
          electionId: '550e8400-e29b-41d4-a716-446655440000',
        }),
      );

      // Act & Assert
      await expect(botVoter.startBotVoting(sessionId)).rejects.toThrow('Generation failed');
    });

    it('fails closed when the live session contract generation is stale', async () => {
      const sessionId = 'test-session-123';

      getSessionMock.mockResolvedValue(
        createBaseSession({
          sessionId,
          contractGeneration: 'stale-contract-generation',
          botCount: 0,
          finalized: false,
          electionId: '550e8400-e29b-41d4-a716-446655440000',
        }),
      );

      await expect(botVoter.startBotVoting(sessionId)).rejects.toThrow('SESSION_NOT_FOUND');

      expect(generateBotVote).not.toHaveBeenCalled();
      expect(addBotVotesMock).not.toHaveBeenCalled();
    });

    it('fails closed when bot voting is requested before the canonical user vote exists', async () => {
      const sessionId = 'test-session-123';
      vi.mocked(generateBotVote).mockResolvedValue({
        vote: 'A',
        rand: '0x' + '1'.repeat(64),
        commit: '0x' + '2'.repeat(64),
        path: [],
      });

      getSessionMock.mockResolvedValue(
        createBaseSession({
          sessionId,
          votes: new Map(),
          userVoteIndex: undefined,
          electionId: '550e8400-e29b-41d4-a716-446655440000',
        }),
      );

      await expect(botVoter.startBotVoting(sessionId)).rejects.toThrow('USER_VOTE_REQUIRED_BEFORE_BOT_VOTES');

      expect(generateBotVote).not.toHaveBeenCalled();
      expect(addBotVotesMock).not.toHaveBeenCalled();
    });

    it('fails closed when the stored user vote index is not the canonical index zero', async () => {
      const sessionId = 'test-session-123';
      vi.mocked(generateBotVote).mockResolvedValue({
        vote: 'A',
        rand: '0x' + '1'.repeat(64),
        commit: '0x' + '2'.repeat(64),
        path: [],
      });

      getSessionMock.mockResolvedValue(
        createBaseSession({
          sessionId,
          votes: new Map([
            [
              0,
              {
                vote: 'A',
                rand: '0x' + '1'.repeat(64),
                commit: '0x' + '2'.repeat(64),
                path: [],
              },
            ],
            [
              1,
              {
                vote: 'B',
                rand: '0x' + '3'.repeat(64),
                commit: '0x' + '4'.repeat(64),
                path: [],
              },
            ],
          ]),
          userVoteIndex: 1,
          electionId: '550e8400-e29b-41d4-a716-446655440000',
        }),
      );

      await expect(botVoter.startBotVoting(sessionId)).rejects.toThrow('USER_VOTE_REQUIRED_BEFORE_BOT_VOTES');

      expect(generateBotVote).not.toHaveBeenCalled();
      expect(addBotVotesMock).not.toHaveBeenCalled();
    });
  });

  describe('getProgress', () => {
    it('should return current bot voting progress', async () => {
      // Arrange
      const sessionId = 'test-session-123';

      getSessionMock.mockResolvedValue(
        createBaseSession({
          sessionId,
          botCount: 50,
          finalized: false,
          votes: createVotes(50),
        }),
      );

      // Act
      const progress = await botVoter.getProgress(sessionId);

      // Assert
      expect(progress).toEqual({
        completed: 50,
        total: 63,
        percentage: Math.round((50 / 63) * 100),
      });
    });

    it('derives progress from canonical vote count when metadata is stale', async () => {
      const sessionId = 'test-session-123';

      getSessionMock.mockResolvedValue(
        createBaseSession({
          sessionId,
          botCount: 0,
          finalized: false,
          votes: new Map([
            [
              0,
              {
                vote: 'A',
                rand: '0x' + '1'.repeat(64),
                commit: '0x' + '2'.repeat(64),
                path: [],
              },
            ],
            [
              1,
              {
                vote: 'B',
                rand: '0x' + '3'.repeat(64),
                commit: '0x' + '4'.repeat(64),
                path: [],
              },
            ],
            [
              2,
              {
                vote: 'C',
                rand: '0x' + '5'.repeat(64),
                commit: '0x' + '6'.repeat(64),
                path: [],
              },
            ],
          ]),
          userVoteIndex: 0,
        }),
      );

      const progress = await botVoter.getProgress(sessionId);

      expect(progress).toEqual({
        completed: 2,
        total: 63,
        percentage: Math.round((2 / 63) * 100),
      });
    });

    it('should return null for non-existent session', async () => {
      // Arrange
      getSessionMock.mockResolvedValue(null);

      // Act
      const progress = await botVoter.getProgress('non-existent');

      // Assert
      expect(progress).toBeNull();
    });
  });
});
