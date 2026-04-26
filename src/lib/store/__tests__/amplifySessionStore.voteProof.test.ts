import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionData, VoteData } from '@/types/server';
import { SimpleBulletinBoard } from '@/lib/bulletin/simple-bulletin-board';

describe('AmplifySessionStore getVoteProof', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      AMPLIFY_DATA_ENDPOINT: 'https://example.appsync-api.ap-northeast-1.amazonaws.com/graphql',
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    process.env = originalEnv;
  });

  it('queries voteId using the listVoteById index', async () => {
    const { AmplifySessionStore } = await import('../amplifySessionStore');
    const store = new AmplifySessionStore();

    const voteId = '11111111-1111-4111-8111-111111111111';
    const sessionId = 'session-123';

    const voteData: VoteData = {
      voteId,
      vote: 'A',
      rand: `0x${'1'.repeat(64)}`,
      commit: `0x${'2'.repeat(64)}`,
      path: [],
    };
    const bulletin = new SimpleBulletinBoard('log-123');
    const appendResult = bulletin.appendVote(voteId, voteData.commit.slice(2));
    voteData.rootAtCast = `0x${appendResult.rootAtAppend}`;

    const session: SessionData = {
      sessionId,
      electionId: '550e8400-e29b-41d4-a716-446655440000',
      electionConfigHash: `0x${'3'.repeat(64)}`,
      logId: 'log-123',
      votes: new Map([[0, voteData]]),
      bulletin,
      botCount: 0,
      finalized: false,
      createdAt: Date.now(),
      lastActivity: Date.now(),
      userVoteIndex: 0,
      bulletinRootHistory: [],
    };

    let capturedQuery = '';
    const executeStub = vi.fn((query: string, variables: Record<string, unknown>) => {
      capturedQuery = query;
      expect(variables).toEqual({ id: voteId });
      return {
        listVoteById: {
          items: [
            {
              id: voteId,
              sessionId,
              voteIndex: 0,
              choice: voteData.vote,
              random: voteData.rand,
              commitment: voteData.commit,
              timestamp: null,
              rootAtCast: voteData.rootAtCast,
              isUserVote: null,
            },
          ],
          nextToken: null,
        },
      };
    });

    (store as unknown as { execute: typeof executeStub }).execute = executeStub;
    vi.spyOn(store, 'getSession').mockResolvedValue(session);

    const result = await store.getVoteProof(voteId);

    expect(capturedQuery).toContain('listVoteById');
    expect(result).toMatchObject({
      leafIndex: 0,
      merklePath: [],
      bulletinRootAtCast: voteData.rootAtCast,
      treeSize: 1,
    });
    expect(result).not.toHaveProperty('proofMode');
  });

  it('fails closed when persisted rootAtCast is missing even if the hydrated session has one', async () => {
    const { AmplifySessionStore } = await import('../amplifySessionStore');
    const store = new AmplifySessionStore();

    const voteId = '22222222-2222-4222-8222-222222222222';
    const sessionId = 'session-456';
    const hydratedRootAtCast = `0x${'a'.repeat(64)}`;
    const voteData: VoteData = {
      voteId,
      vote: 'A',
      rand: `0x${'1'.repeat(64)}`,
      commit: `0x${'2'.repeat(64)}`,
      path: [],
      rootAtCast: hydratedRootAtCast,
      timestamp: Date.now(),
    };

    const bulletin = new SimpleBulletinBoard('log-456');
    const session: SessionData = {
      sessionId,
      electionId: '550e8400-e29b-41d4-a716-446655440000',
      electionConfigHash: `0x${'3'.repeat(64)}`,
      logId: 'log-456',
      votes: new Map([[0, voteData]]),
      bulletin,
      botCount: 0,
      finalized: false,
      createdAt: Date.now(),
      lastActivity: Date.now(),
      userVoteIndex: 0,
      bulletinRootHistory: [],
    };

    const executeStub = vi.fn((query: string) => {
      if (query.includes('listVoteById')) {
        return {
          listVoteById: {
            items: [
              {
                id: voteId,
                sessionId,
                voteIndex: 0,
                choice: voteData.vote,
                random: voteData.rand,
                commitment: voteData.commit,
                timestamp: new Date(voteData.timestamp ?? Date.now()).toISOString(),
                rootAtCast: null,
                isUserVote: true,
              },
            ],
            nextToken: null,
          },
        };
      }
      throw new Error(`Unexpected query: ${query}`);
    });

    (store as unknown as { execute: typeof executeStub }).execute = executeStub;
    vi.spyOn(store, 'getSession').mockResolvedValue(session);

    await expect(store.getVoteByIdWithProof(sessionId, voteId)).rejects.toThrow('CT_PROOF_UNAVAILABLE');
  });

  it('fails closed when the session owns the vote but the persisted vote record is missing', async () => {
    const { AmplifySessionStore } = await import('../amplifySessionStore');
    const store = new AmplifySessionStore();

    const voteId = '33333333-3333-4333-8333-333333333333';
    const sessionId = 'session-789';
    const voteData: VoteData = {
      voteId,
      vote: 'A',
      rand: `0x${'1'.repeat(64)}`,
      commit: `0x${'2'.repeat(64)}`,
      path: [],
      rootAtCast: `0x${'a'.repeat(64)}`,
      timestamp: Date.now(),
    };

    const session: SessionData = {
      sessionId,
      electionId: '550e8400-e29b-41d4-a716-446655440000',
      electionConfigHash: `0x${'3'.repeat(64)}`,
      logId: 'log-789',
      votes: new Map([[0, voteData]]),
      bulletin: new SimpleBulletinBoard('log-789'),
      botCount: 0,
      finalized: false,
      createdAt: Date.now(),
      lastActivity: Date.now(),
      userVoteIndex: 0,
      bulletinRootHistory: [],
    };

    const executeStub = vi.fn((query: string) => {
      if (query.includes('listVoteById')) {
        return {
          listVoteById: {
            items: [],
            nextToken: null,
          },
        };
      }
      throw new Error(`Unexpected query: ${query}`);
    });

    (store as unknown as { execute: typeof executeStub }).execute = executeStub;
    vi.spyOn(store, 'getSession').mockResolvedValue(session);

    await expect(store.getVoteByIdWithProof(sessionId, voteId)).rejects.toThrow('CT_PROOF_UNAVAILABLE');
  });
});
