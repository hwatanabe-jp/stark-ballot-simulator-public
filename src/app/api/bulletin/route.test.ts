import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { GET } from './route';
import type { VoteData, SessionData } from '@/types/server';
import { createMockVoteStore } from '@/lib/testing/mockVoteStore';
import { readJsonRecord } from '@/lib/testing/response-helpers';
import { getArrayProperty, getNumberProperty, getStringProperty, isRecord } from '@/lib/utils/guards';
import { addHexPrefix } from '@/lib/utils/hex';
import { SimpleBulletinBoard } from '@/lib/bulletin/simple-bulletin-board';
import type { VoteStore } from '@/types/voteStore';
import { SESSION_CAPABILITY_HEADER } from '@/lib/session/capability';
import { createTestSessionCapabilityToken, setTestSessionCapabilitySecret } from '@/lib/testing/sessionCapability';
import { resolveCurrentContractGeneration } from '@/lib/contract';

// Mock the store instance module
vi.mock('@/lib/store/storeInstance', () => ({
  getGlobalStore: vi.fn(),
  resetGlobalStore: vi.fn(),
}));

import { getGlobalStore } from '@/lib/store/storeInstance';

describe('GET /api/bulletin', () => {
  let mockStore: VoteStore;
  let mockSession: SessionData;
  let getSessionMock: ReturnType<typeof vi.fn<NonNullable<VoteStore['getSession']>>>;

  const buildVoteId = (index: number): string => `550e8400-e29b-41d4-a716-${(index + 1).toString().padStart(12, '0')}`;

  const seedVotes = (count: number): string[] => {
    const commitments: string[] = [];
    const choices = ['A', 'B', 'C', 'D', 'E'] as const;
    const bulletin = mockSession.bulletin;
    if (!bulletin) {
      throw new Error('Expected bulletin to be initialized');
    }

    for (let index = 0; index < count; index += 1) {
      const voteId = buildVoteId(index);
      const rand = `0x${(index + 1).toString(16).padStart(64, '0')}`;
      const commit = `0x${(index + 10).toString(16).padStart(64, '0')}`;
      mockSession.votes.set(index, {
        voteId,
        vote: choices[index % choices.length],
        rand,
        commit,
        path: [],
        timestamp: 1000 + index,
      });
      bulletin.appendVote(voteId, commit);
      commitments.push(commit);
    }

    return commitments;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    setTestSessionCapabilitySecret();

    // Setup mock store
    getSessionMock = vi.fn<NonNullable<VoteStore['getSession']>>();
    mockStore = createMockVoteStore({
      getSession: getSessionMock,
    });

    // Mock getGlobalStore to return our mock store
    vi.mocked(getGlobalStore).mockReturnValue(mockStore);

    // Setup mock session with votes
    mockSession = {
      sessionId: 'test-session-123',
      contractGeneration: resolveCurrentContractGeneration(),
      votes: new Map(),
      bulletin: new SimpleBulletinBoard('log-123'),
      botCount: 0,
      finalized: false,
      createdAt: Date.now(),
      lastActivity: Date.now(),
    };
  });

  it('should return all commitments in vote index order', async () => {
    // Arrange
    const votes: VoteData[] = [
      {
        voteId: buildVoteId(0),
        vote: 'A',
        rand: '0x' + '1'.repeat(64),
        commit: '0x' + 'c1'.padEnd(64, '0'),
        path: [],
        timestamp: 1000,
      },
      {
        voteId: buildVoteId(1),
        vote: 'B',
        rand: '0x' + '2'.repeat(64),
        commit: '0x' + 'c2'.padEnd(64, '0'),
        path: [],
        timestamp: 2000,
      },
      {
        voteId: buildVoteId(2),
        vote: 'C',
        rand: '0x' + '3'.repeat(64),
        commit: '0x' + 'c3'.padEnd(64, '0'),
        path: [],
        timestamp: 1500,
      },
    ];

    // Add votes to session
    votes.forEach((vote, index) => {
      mockSession.votes.set(index, vote);
      if (!vote.voteId) {
        throw new Error('Expected voteId to be defined');
      }
      mockSession.bulletin?.appendVote(vote.voteId, vote.commit);
    });

    getSessionMock.mockResolvedValue(mockSession);

    const request = new NextRequest('http://localhost:3000/api/bulletin', {
      headers: {
        'X-Session-ID': 'test-session-123',
        [SESSION_CAPABILITY_HEADER]: createTestSessionCapabilityToken('test-session-123'),
      },
    });

    // Act
    const response = await GET(request);
    const payload = await readJsonRecord(response, 'bulletin response');
    const commitments = Array.isArray(payload.commitments) ? payload.commitments : [];

    // Assert
    expect(response.status).toBe(200);
    expect(commitments).toHaveLength(3);
    // Should follow vote index ordering
    expect(commitments[0]).toBe('0x' + 'c1'.padEnd(64, '0'));
    expect(commitments[1]).toBe('0x' + 'c2'.padEnd(64, '0'));
    expect(commitments[2]).toBe('0x' + 'c3'.padEnd(64, '0'));
    expect(getStringProperty(payload, 'bulletinRoot')).toBeDefined();
    expect(getNumberProperty(payload, 'treeSize')).toBe(3);
    expect(getNumberProperty(payload, 'timestamp')).toBeDefined();
  });

  it('should support paging with offset and limit', async () => {
    const commitments = seedVotes(5);
    getSessionMock.mockResolvedValue(mockSession);

    const request = new NextRequest('http://localhost:3000/api/bulletin?offset=1&limit=2', {
      headers: {
        'X-Session-ID': 'test-session-123',
        [SESSION_CAPABILITY_HEADER]: createTestSessionCapabilityToken('test-session-123'),
      },
    });

    const response = await GET(request);
    const payload = await readJsonRecord(response, 'bulletin response');
    const slicedCommitments = getArrayProperty(payload, 'commitments') ?? [];

    expect(response.status).toBe(200);
    expect(slicedCommitments).toEqual(commitments.slice(1, 3));
    expect(getNumberProperty(payload, 'nextOffset')).toBe(3);
    expect(payload.hasMore).toBe(true);
  });

  it('should support paging with limit only', async () => {
    const commitments = seedVotes(4);
    getSessionMock.mockResolvedValue(mockSession);

    const request = new NextRequest('http://localhost:3000/api/bulletin?limit=2', {
      headers: {
        'X-Session-ID': 'test-session-123',
        [SESSION_CAPABILITY_HEADER]: createTestSessionCapabilityToken('test-session-123'),
      },
    });

    const response = await GET(request);
    const payload = await readJsonRecord(response, 'bulletin response');
    const slicedCommitments = getArrayProperty(payload, 'commitments') ?? [];

    expect(response.status).toBe(200);
    expect(slicedCommitments).toEqual(commitments.slice(0, 2));
    expect(getNumberProperty(payload, 'nextOffset')).toBe(2);
    expect(payload.hasMore).toBe(true);
  });

  it('should support paging with offset only', async () => {
    const commitments = seedVotes(4);
    getSessionMock.mockResolvedValue(mockSession);

    const request = new NextRequest('http://localhost:3000/api/bulletin?offset=2', {
      headers: {
        'X-Session-ID': 'test-session-123',
        [SESSION_CAPABILITY_HEADER]: createTestSessionCapabilityToken('test-session-123'),
      },
    });

    const response = await GET(request);
    const payload = await readJsonRecord(response, 'bulletin response');
    const slicedCommitments = getArrayProperty(payload, 'commitments') ?? [];

    expect(response.status).toBe(200);
    expect(slicedCommitments).toEqual(commitments.slice(2));
    expect(payload.nextOffset).toBeNull();
    expect(payload.hasMore).toBe(false);
  });

  it('should return empty list when offset is out of range', async () => {
    seedVotes(2);
    getSessionMock.mockResolvedValue(mockSession);

    const request = new NextRequest('http://localhost:3000/api/bulletin?offset=10', {
      headers: {
        'X-Session-ID': 'test-session-123',
        [SESSION_CAPABILITY_HEADER]: createTestSessionCapabilityToken('test-session-123'),
      },
    });

    const response = await GET(request);
    const payload = await readJsonRecord(response, 'bulletin response');
    const slicedCommitments = getArrayProperty(payload, 'commitments') ?? [];

    expect(response.status).toBe(200);
    expect(slicedCommitments).toEqual([]);
    expect(payload.nextOffset).toBeNull();
    expect(payload.hasMore).toBe(false);
  });

  it('should return error for invalid offset parameter', async () => {
    getSessionMock.mockResolvedValue(mockSession);

    const request = new NextRequest('http://localhost:3000/api/bulletin?offset=-1', {
      headers: {
        'X-Session-ID': 'test-session-123',
        [SESSION_CAPABILITY_HEADER]: createTestSessionCapabilityToken('test-session-123'),
      },
    });

    const response = await GET(request);
    const payload = await readJsonRecord(response, 'bulletin response');

    expect(response.status).toBe(400);
    expect(getStringProperty(payload, 'error')).toBe('INVALID_OFFSET');
    expect(getStringProperty(payload, 'field')).toBe('offset');
    expect(getStringProperty(payload, 'reason')).toBe('min');
    expect(getNumberProperty(payload, 'actual')).toBe(-1);
  });

  it('should return error for limit above maximum', async () => {
    getSessionMock.mockResolvedValue(mockSession);

    const request = new NextRequest('http://localhost:3000/api/bulletin?limit=1001', {
      headers: {
        'X-Session-ID': 'test-session-123',
        [SESSION_CAPABILITY_HEADER]: createTestSessionCapabilityToken('test-session-123'),
      },
    });

    const response = await GET(request);
    const payload = await readJsonRecord(response, 'bulletin response');

    expect(response.status).toBe(400);
    expect(getStringProperty(payload, 'error')).toBe('INVALID_LIMIT');
    expect(getStringProperty(payload, 'field')).toBe('limit');
    expect(getStringProperty(payload, 'reason')).toBe('max');
    expect(getNumberProperty(payload, 'actual')).toBe(1001);
    expect(getNumberProperty(payload, 'max')).toBe(1000);
  });

  it('should prefer the bulletin board root when available', async () => {
    // Arrange
    const bulletin = new SimpleBulletinBoard();
    const voteId1 = '550e8400-e29b-41d4-a716-446655440000';
    const voteId2 = '550e8400-e29b-41d4-a716-446655440001';
    const commit1 = '0x' + 'a'.repeat(64);
    const commit2 = '0x' + 'b'.repeat(64);

    bulletin.appendVote(voteId1, commit1);
    bulletin.appendVote(voteId2, commit2);

    mockSession.bulletin = bulletin;
    mockSession.votes.set(0, {
      voteId: voteId1,
      vote: 'A',
      rand: '0x' + '1'.repeat(64),
      commit: commit1,
      path: [],
      timestamp: 1000,
    });
    mockSession.votes.set(1, {
      voteId: voteId2,
      vote: 'B',
      rand: '0x' + '2'.repeat(64),
      commit: commit2,
      path: [],
      timestamp: 2000,
    });

    getSessionMock.mockResolvedValue(mockSession);

    const request = new NextRequest('http://localhost:3000/api/bulletin', {
      headers: {
        'X-Session-ID': 'test-session-123',
        [SESSION_CAPABILITY_HEADER]: createTestSessionCapabilityToken('test-session-123'),
      },
    });

    // Act
    const response = await GET(request);
    const payload = await readJsonRecord(response, 'bulletin response');

    // Assert
    const expectedRoot = addHexPrefix(bulletin.getCurrentRoot());
    expect(response.status).toBe(200);
    expect(getStringProperty(payload, 'bulletinRoot')).toBe(expectedRoot);
    expect(getNumberProperty(payload, 'treeSize')).toBe(2);
  });

  it('should prefer bulletin commitments when available', async () => {
    // Arrange
    const bulletin = new SimpleBulletinBoard();
    const voteId1 = '550e8400-e29b-41d4-a716-446655440010';
    const voteId2 = '550e8400-e29b-41d4-a716-446655440011';
    const bulletinCommit1 = '0x' + 'A'.repeat(64);
    const bulletinCommit2 = '0x' + 'B'.repeat(64);

    bulletin.appendVote(voteId1, bulletinCommit1);
    bulletin.appendVote(voteId2, bulletinCommit2);

    mockSession.bulletin = bulletin;
    mockSession.votes.set(0, {
      voteId: voteId1,
      vote: 'A',
      rand: '0x' + '1'.repeat(64),
      commit: '0x' + '1'.repeat(64),
      path: [],
      timestamp: 1000,
    });
    mockSession.votes.set(1, {
      voteId: voteId2,
      vote: 'B',
      rand: '0x' + '2'.repeat(64),
      commit: '0x' + '2'.repeat(64),
      path: [],
      timestamp: 2000,
    });

    getSessionMock.mockResolvedValue(mockSession);

    const request = new NextRequest('http://localhost:3000/api/bulletin', {
      headers: {
        'X-Session-ID': 'test-session-123',
        [SESSION_CAPABILITY_HEADER]: createTestSessionCapabilityToken('test-session-123'),
      },
    });

    // Act
    const response = await GET(request);
    const payload = await readJsonRecord(response, 'bulletin response');
    const commitments = Array.isArray(payload.commitments) ? payload.commitments : [];

    // Assert
    expect(response.status).toBe(200);
    expect(commitments).toEqual([bulletinCommit1.toLowerCase(), bulletinCommit2.toLowerCase()]);
  });

  it('should return empty list for session with no votes', async () => {
    // Arrange
    getSessionMock.mockResolvedValue(mockSession);

    const request = new NextRequest('http://localhost:3000/api/bulletin', {
      headers: {
        'X-Session-ID': 'test-session-123',
        [SESSION_CAPABILITY_HEADER]: createTestSessionCapabilityToken('test-session-123'),
      },
    });

    // Act
    const response = await GET(request);
    const payload = await readJsonRecord(response, 'bulletin response');
    const commitments = Array.isArray(payload.commitments) ? payload.commitments : [];

    // Assert
    expect(response.status).toBe(200);
    expect(commitments).toEqual([]);
    expect(getNumberProperty(payload, 'treeSize')).toBe(0);
  });

  it('should return error for missing session ID', async () => {
    // Arrange
    const request = new NextRequest('http://localhost:3000/api/bulletin');

    // Act
    const response = await GET(request);
    const payload = await readJsonRecord(response, 'bulletin response');

    // Assert
    expect(response.status).toBe(400);
    expect(getStringProperty(payload, 'error')).toBe('SESSION_ID_REQUIRED');
  });

  it('should return error when inspection bulletin state is unavailable', async () => {
    mockSession.bulletin = undefined;
    mockSession.bulletinRootHistory = [];
    getSessionMock.mockResolvedValue(mockSession);

    const request = new NextRequest('http://localhost:3000/api/bulletin', {
      headers: {
        'X-Session-ID': 'test-session-123',
        [SESSION_CAPABILITY_HEADER]: createTestSessionCapabilityToken('test-session-123'),
      },
    });

    const response = await GET(request);
    const payload = await readJsonRecord(response, 'bulletin response');

    expect(response.status).toBe(400);
    expect(getStringProperty(payload, 'error')).toBe('INVALID_REQUEST');
    expect(getStringProperty(payload, 'details')).toBe('BULLETIN_STATE_UNAVAILABLE');
  });

  it('should return error for missing capability token', async () => {
    const request = new NextRequest('http://localhost:3000/api/bulletin', {
      headers: {
        'X-Session-ID': 'test-session-123',
      },
    });

    const response = await GET(request);
    const payload = await readJsonRecord(response, 'bulletin response');

    expect(response.status).toBe(401);
    expect(getStringProperty(payload, 'error')).toBe('SESSION_CAPABILITY_REQUIRED');
  });

  it('should return error for non-existent session', async () => {
    // Arrange
    getSessionMock.mockResolvedValue(null);

    const request = new NextRequest('http://localhost:3000/api/bulletin', {
      headers: {
        'X-Session-ID': 'non-existent',
        [SESSION_CAPABILITY_HEADER]: createTestSessionCapabilityToken('non-existent'),
      },
    });

    // Act
    const response = await GET(request);
    const payload = await readJsonRecord(response, 'bulletin response');

    // Assert
    expect(response.status).toBe(404);
    expect(getStringProperty(payload, 'error')).toBe('SESSION_NOT_FOUND');
  });

  it('fails closed when a finalized bulletin session is unsupported for the current contract', async () => {
    mockSession.finalized = true;
    mockSession.finalizationArtifactState = 'unsupported_current_artifact';
    getSessionMock.mockResolvedValue(mockSession);

    const request = new NextRequest('http://localhost:3000/api/bulletin', {
      headers: {
        'X-Session-ID': 'test-session-123',
        [SESSION_CAPABILITY_HEADER]: createTestSessionCapabilityToken('test-session-123'),
      },
    });

    const response = await GET(request);
    const payload = await readJsonRecord(response, 'bulletin response');

    expect(response.status).toBe(500);
    expect(getStringProperty(payload, 'error')).toBe('UNSUPPORTED_CURRENT_ARTIFACT');
    expect(getStringProperty(payload, 'artifactState')).toBe('unsupported_current_artifact');
  });

  it('should include canonical bulletin root history when persisted snapshots match CT state', async () => {
    seedVotes(2);
    const expectedHistory = mockSession.bulletin?.getRootHistory() ?? [];
    mockSession.bulletinRootHistory = expectedHistory.map((snapshot, index) => ({
      timestamp: 1000 + index,
      root: addHexPrefix(snapshot.root),
      treeSize: snapshot.treeSize,
      signature: `sig-${index + 1}`,
    }));

    getSessionMock.mockResolvedValue(mockSession);

    const request = new NextRequest('http://localhost:3000/api/bulletin', {
      headers: {
        'X-Session-ID': 'test-session-123',
        [SESSION_CAPABILITY_HEADER]: createTestSessionCapabilityToken('test-session-123'),
      },
    });

    // Act
    const response = await GET(request);
    const payload = await readJsonRecord(response, 'bulletin response');
    const rootHistory = getArrayProperty(payload, 'rootHistory') ?? [];

    // Assert
    expect(response.status).toBe(200);
    expect(rootHistory).toBeDefined();
    expect(rootHistory).toHaveLength(2);
    const firstRoot = rootHistory[0];
    expect(isRecord(firstRoot)).toBe(true);
    if (isRecord(firstRoot)) {
      expect(getStringProperty(firstRoot, 'bulletinRoot')).toBe(addHexPrefix(expectedHistory[0]?.root ?? ''));
      expect(getStringProperty(firstRoot, 'signature')).toBe('sig-1');
    }
  });

  it('ignores stale persisted bulletin root history when canonical CT state disagrees', async () => {
    seedVotes(2);
    const expectedHistory = mockSession.bulletin?.getRootHistory() ?? [];
    mockSession.bulletinRootHistory = [
      { timestamp: 1000, root: '0x' + 'f'.repeat(64), treeSize: 1 },
      { timestamp: 2000, root: '0x' + 'e'.repeat(64), treeSize: 2, signature: 'stale-sig' },
    ];

    getSessionMock.mockResolvedValue(mockSession);

    const request = new NextRequest('http://localhost:3000/api/bulletin', {
      headers: {
        'X-Session-ID': 'test-session-123',
        [SESSION_CAPABILITY_HEADER]: createTestSessionCapabilityToken('test-session-123'),
      },
    });

    const response = await GET(request);
    const payload = await readJsonRecord(response, 'bulletin response');
    const rootHistory = getArrayProperty(payload, 'rootHistory') ?? [];

    expect(response.status).toBe(200);
    expect(getStringProperty(payload, 'bulletinRoot')).toBe(addHexPrefix(expectedHistory[1]?.root ?? ''));
    expect(rootHistory).toHaveLength(2);
    const secondRoot = rootHistory[1];
    expect(isRecord(secondRoot)).toBe(true);
    if (isRecord(secondRoot)) {
      expect(getStringProperty(secondRoot, 'bulletinRoot')).toBe(addHexPrefix(expectedHistory[1]?.root ?? ''));
      expect(secondRoot.signature).toBeUndefined();
    }
  });
});
