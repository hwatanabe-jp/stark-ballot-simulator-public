import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import type { MockInstance } from 'vitest';
import { NextRequest } from 'next/server';
import { POST } from './route';
import { getGlobalStore, resetGlobalStore } from '@/lib/store/storeInstance';
import { generateVoteId } from '@/lib/vote/voteId';
import { computeCommitment } from '@/lib/zkvm/types';
import { DEFAULT_TEST_ELECTION_ID } from '@/lib/testing/commitment-test-helpers';
import { resetVoteRateLimiter } from '@/lib/rateLimit/voteRateLimit';
import { createMockVoteStore } from '@/lib/testing/mockVoteStore';
import { readJsonRecord, requireDataRecord } from '@/lib/testing/response-helpers';
import { getNumberProperty, getRecordProperty, getStringProperty } from '@/lib/utils/guards';
import { createSessionCapabilityToken } from '@/lib/security/sessionCapabilityToken';
import { SESSION_CAPABILITY_HEADER, SESSION_ID_HEADER } from '@/lib/session/capability';
import type { SessionData } from '@/types/server';
import type { VoteStore } from '@/types/voteStore';
import { resolveCurrentContractGeneration } from '@/lib/contract';

// Mock dependencies
vi.mock('@/lib/vote/voteId');
vi.mock('@/lib/store/storeInstance', () => {
  const getGlobalStore = vi.fn();
  return {
    getGlobalStore,
    resetGlobalStore: vi.fn(() => {
      getGlobalStore.mockReset();
    }),
  };
});
let startBotVotingMock: ReturnType<typeof vi.fn<(sessionId: string) => Promise<void>>>;

vi.mock('@/lib/bot/botVoter', () => {
  class BotVoter {
    startBotVoting(sessionId: string): Promise<void> {
      return startBotVotingMock(sessionId);
    }
  }

  return { BotVoter };
});

describe('POST /api/vote', () => {
  let mockStore: VoteStore;
  let consoleErrorSpy: MockInstance<typeof console.error>;
  let getSessionMock: ReturnType<typeof vi.fn<NonNullable<VoteStore['getSession']>>>;
  let addVoteMock: ReturnType<typeof vi.fn<NonNullable<VoteStore['addVote']>>>;
  let updateSessionMock: ReturnType<typeof vi.fn<NonNullable<VoteStore['updateSession']>>>;
  let voteIdCounter = 0;
  const originalTurnstileSecret = process.env.TURNSTILE_SECRET_KEY;
  const originalTurnstileBypass = process.env.TURNSTILE_BYPASS;
  const originalRuntimeDeploymentEnv = process.env.RUNTIME_DEPLOYMENT_ENV;
  const originalSessionCapabilitySecret = process.env.SESSION_CAPABILITY_SECRET;
  const capabilitySecret = 'test-session-capability-secret-0123456789abcdef';
  const createBaseSession = (overrides: Partial<SessionData> = {}): SessionData => {
    const now = Date.now();
    return {
      sessionId: 'default-session',
      electionId: '550e8400-e29b-41d4-a716-446655440000',
      contractGeneration: resolveCurrentContractGeneration(),
      votes: new Map(),
      botCount: 0,
      finalized: false,
      createdAt: now,
      lastActivity: now,
      ...overrides,
    };
  };
  const createCapabilityToken = (sessionId: string): string =>
    createSessionCapabilityToken(
      {
        sessionId,
        nowMs: Date.now(),
        ttlSeconds: 300,
      },
      capabilitySecret,
    );
  const buildVoteHeaders = (sessionId: string, extra: Record<string, string> = {}): Record<string, string> => ({
    'Content-Type': 'application/json',
    [SESSION_ID_HEADER]: sessionId,
    [SESSION_CAPABILITY_HEADER]: createCapabilityToken(sessionId),
    ...extra,
  });

  beforeEach(() => {
    vi.clearAllMocks();
    voteIdCounter = 0;

    process.env.TURNSTILE_BYPASS = '1';
    process.env.RUNTIME_DEPLOYMENT_ENV = 'develop';
    process.env.SESSION_CAPABILITY_SECRET = capabilitySecret;
    delete process.env.TURNSTILE_SECRET_KEY;
    resetVoteRateLimiter();

    resetGlobalStore();

    startBotVotingMock = vi.fn<(sessionId: string) => Promise<void>>().mockResolvedValue(undefined);
    getSessionMock = vi.fn<NonNullable<VoteStore['getSession']>>();
    addVoteMock = vi.fn<NonNullable<VoteStore['addVote']>>();
    updateSessionMock = vi.fn<NonNullable<VoteStore['updateSession']>>();
    mockStore = createMockVoteStore({
      getSession: getSessionMock,
      addVote: addVoteMock,
      updateSession: updateSessionMock,
    });

    getSessionMock.mockResolvedValue(
      createBaseSession({
        userVoteIndex: undefined,
      }),
    );
    addVoteMock.mockResolvedValue({
      leafIndex: 0,
      merklePath: [],
      bulletinRootAtCast: '0x' + '0'.repeat(64),
    });
    updateSessionMock.mockResolvedValue(undefined);

    vi.mocked(getGlobalStore).mockReturnValue(mockStore);

    vi.mocked(generateVoteId).mockImplementation(() => `test-vote-${voteIdCounter++}`);

    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  afterAll(() => {
    if (originalTurnstileSecret === undefined) {
      delete process.env.TURNSTILE_SECRET_KEY;
    } else {
      process.env.TURNSTILE_SECRET_KEY = originalTurnstileSecret;
    }

    if (originalTurnstileBypass === undefined) {
      delete process.env.TURNSTILE_BYPASS;
    } else {
      process.env.TURNSTILE_BYPASS = originalTurnstileBypass;
    }

    if (originalRuntimeDeploymentEnv === undefined) {
      delete process.env.RUNTIME_DEPLOYMENT_ENV;
    } else {
      process.env.RUNTIME_DEPLOYMENT_ENV = originalRuntimeDeploymentEnv;
    }

    if (originalSessionCapabilitySecret === undefined) {
      delete process.env.SESSION_CAPABILITY_SECRET;
    } else {
      process.env.SESSION_CAPABILITY_SECRET = originalSessionCapabilitySecret;
    }
  });

  it('should use store-produced cast metadata for the receipt root', async () => {
    // Arrange
    const mockSessionId = 'session-valid-1';
    const mockVote = 'A';
    const mockRand = '0x' + '1'.repeat(64);
    const electionId = '550e8400-e29b-41d4-a716-446655440000';
    const mockCommitment = computeCommitment(electionId, 0, mockRand);
    const staleSessionRoot = '0x' + 'f'.repeat(64);
    const storeProducedRoot = '0x' + 'e'.repeat(64);

    getSessionMock.mockResolvedValue(
      createBaseSession({
        sessionId: mockSessionId,
        electionId,
        botCount: 0,
        finalized: false,
        userVoteIndex: undefined,
        bulletinRootHistory: [
          {
            root: staleSessionRoot,
            treeSize: 0,
            timestamp: Date.now(),
          },
        ],
      }),
    );

    addVoteMock.mockResolvedValue({
      leafIndex: 0,
      merklePath: ['hash1', 'hash2', 'hash3'],
      bulletinRootAtCast: storeProducedRoot,
    });

    const request = new NextRequest('http://localhost:3000/api/vote', {
      method: 'POST',
      headers: buildVoteHeaders(mockSessionId, { 'cf-connecting-ip': '203.0.113.10' }),
      body: JSON.stringify({
        commitment: mockCommitment,
        vote: mockVote,
        rand: mockRand,
      }),
    });

    // Act
    const response = await POST(request);
    const payload = await readJsonRecord(response, 'vote response');
    const data = requireDataRecord(payload);

    // Assert
    expect(response.status).toBe(200);
    expect(getStringProperty(data, 'voteId')).toBeDefined();
    expect(getStringProperty(data, 'commitment')).toBe(mockCommitment);
    expect(getNumberProperty(data, 'bulletinIndex')).toBe(0);
    expect(getStringProperty(data, 'bulletinRootAtCast')).toBe(storeProducedRoot);
    expect(addVoteMock).toHaveBeenCalledWith(
      mockSessionId,
      expect.objectContaining({
        vote: mockVote,
        rand: mockRand,
        commit: mockCommitment,
      }),
    );
  });

  it('should use the store result even when session CT history is unavailable', async () => {
    const mockSessionId = 'session-zero-root';
    const mockVote = 'A';
    const mockRand = '0x' + '1'.repeat(64);
    const electionId = DEFAULT_TEST_ELECTION_ID;
    const mockCommitment = computeCommitment(electionId, 0, mockRand);

    getSessionMock.mockResolvedValue(
      createBaseSession({
        sessionId: mockSessionId,
        electionId,
        bulletin: undefined,
        bulletinRootHistory: undefined,
      }),
    );

    addVoteMock.mockResolvedValue({
      leafIndex: 0,
      merklePath: [],
      bulletinRootAtCast: '0x' + '0'.repeat(64),
    });

    const request = new NextRequest('http://localhost:3000/api/vote', {
      method: 'POST',
      headers: buildVoteHeaders(mockSessionId, { 'cf-connecting-ip': '203.0.113.10' }),
      body: JSON.stringify({
        commitment: mockCommitment,
        vote: mockVote,
        rand: mockRand,
      }),
    });

    const response = await POST(request);
    const payload = await readJsonRecord(response, 'vote response');
    const data = requireDataRecord(payload);

    expect(response.status).toBe(200);
    expect(getStringProperty(data, 'bulletinRootAtCast')).toBe('0x' + '0'.repeat(64));
  });

  it('should reject request without session ID', async () => {
    // Arrange
    const request = new NextRequest('http://localhost:3000/api/vote', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        commitment: 'a'.repeat(64),
        vote: 'A',
        rand: '0x' + 'b'.repeat(64),
      }),
    });

    // Act
    const response = await POST(request);
    const payload = await readJsonRecord(response, 'vote response');

    // Assert
    expect(response.status).toBe(400);
    expect(getStringProperty(payload, 'error')).toBe('SESSION_ID_REQUIRED');
  });

  it('applies vote attempt rate limit before parsing malformed JSON', async () => {
    const originalVoteRateLimit = process.env.VOTE_RATE_LIMIT;
    const originalVoteRateLimitWindowMs = process.env.VOTE_RATE_LIMIT_WINDOW_MS;
    process.env.VOTE_RATE_LIMIT = '1';
    process.env.VOTE_RATE_LIMIT_WINDOW_MS = '600000';
    resetVoteRateLimiter();

    const createMalformedRequest = () =>
      new NextRequest('http://localhost:3000/api/vote', {
        method: 'POST',
        headers: buildVoteHeaders('session-malformed', { 'cf-connecting-ip': '203.0.113.77' }),
        body: '{',
      });

    try {
      const responseA = await POST(createMalformedRequest());
      const payloadA = await readJsonRecord(responseA, 'vote response A');
      expect(responseA.status).toBe(400);
      expect(getStringProperty(payloadA, 'error')).toBe('INVALID_REQUEST');

      const responseB = await POST(createMalformedRequest());
      const payloadB = await readJsonRecord(responseB, 'vote response B');
      expect(responseB.status).toBe(400);
      expect(getStringProperty(payloadB, 'error')).toBe('INVALID_REQUEST');

      getSessionMock.mockClear();
      const responseC = await POST(createMalformedRequest());
      const payloadC = await readJsonRecord(responseC, 'vote response C');
      expect(responseC.status).toBe(503);
      expect(getStringProperty(payloadC, 'error')).toBe('GLOBAL_LIMIT_EXCEEDED');
      expect(getSessionMock).not.toHaveBeenCalled();
    } finally {
      if (originalVoteRateLimit === undefined) {
        delete process.env.VOTE_RATE_LIMIT;
      } else {
        process.env.VOTE_RATE_LIMIT = originalVoteRateLimit;
      }

      if (originalVoteRateLimitWindowMs === undefined) {
        delete process.env.VOTE_RATE_LIMIT_WINDOW_MS;
      } else {
        process.env.VOTE_RATE_LIMIT_WINDOW_MS = originalVoteRateLimitWindowMs;
      }
      resetVoteRateLimiter();
    }
  });

  it('returns 413 when vote payload exceeds body limit', async () => {
    const originalBodyLimit = process.env.API_REQUEST_BODY_LIMIT_BYTES;
    process.env.API_REQUEST_BODY_LIMIT_BYTES = '140';

    try {
      const request = new NextRequest('http://localhost:3000/api/vote', {
        method: 'POST',
        headers: buildVoteHeaders('session-too-large', { 'cf-connecting-ip': '203.0.113.10' }),
        body: JSON.stringify({
          commitment: '0x' + 'a'.repeat(64),
          vote: 'A',
          rand: '0x' + 'b'.repeat(64),
          turnstileToken: 'x'.repeat(256),
        }),
      });

      const response = await POST(request);
      const payload = await readJsonRecord(response, 'vote oversized payload');

      expect(response.status).toBe(413);
      expect(getStringProperty(payload, 'error')).toBe('PAYLOAD_TOO_LARGE');
      expect(getSessionMock).toHaveBeenCalledWith('session-too-large');
    } finally {
      if (originalBodyLimit === undefined) {
        delete process.env.API_REQUEST_BODY_LIMIT_BYTES;
      } else {
        process.env.API_REQUEST_BODY_LIMIT_BYTES = originalBodyLimit;
      }
    }
  });

  it('should reject when Turnstile token is missing under enforcement', async () => {
    process.env.TURNSTILE_BYPASS = '0';
    process.env.TURNSTILE_SECRET_KEY = 'live-secret';

    const request = new NextRequest('http://localhost:3000/api/vote', {
      method: 'POST',
      headers: buildVoteHeaders('session-valid-1'),
      body: JSON.stringify({
        commitment: '0x' + 'a'.repeat(64),
        vote: 'A',
        rand: '0x' + 'b'.repeat(64),
      }),
    });

    const response = await POST(request);
    const payload = await readJsonRecord(response, 'vote response');

    expect(response.status).toBe(403);
    expect(getStringProperty(payload, 'error')).toBe('CAPTCHA_FAILED');
    expect(getSessionMock).toHaveBeenCalledWith('session-valid-1');
  });

  it('should reject non-existent session', async () => {
    // Arrange
    getSessionMock.mockResolvedValue(null);

    const request = new NextRequest('http://localhost:3000/api/vote', {
      method: 'POST',
      headers: buildVoteHeaders('session-missing'),
      body: JSON.stringify({
        commitment: '0x' + 'a'.repeat(64),
        vote: 'A',
        rand: '0x' + 'b'.repeat(64),
      }),
    });

    // Act
    const response = await POST(request);
    const payload = await readJsonRecord(response, 'vote response');

    // Assert
    expect(response.status).toBe(404);
    expect(getStringProperty(payload, 'error')).toBe('SESSION_NOT_FOUND');
  });

  it('should reject if user already voted', async () => {
    // Arrange
    getSessionMock.mockResolvedValue(
      createBaseSession({
        sessionId: 'session-already',
        electionId: '550e8400-e29b-41d4-a716-446655440000',
        votes: new Map(),
        botCount: 0,
        finalized: false,
        userVoteIndex: 0, // Already voted
      }),
    );

    const request = new NextRequest('http://localhost:3000/api/vote', {
      method: 'POST',
      headers: buildVoteHeaders('session-already'),
      body: JSON.stringify({
        commitment: '0x' + 'a'.repeat(64),
        vote: 'A',
        rand: '0x' + 'b'.repeat(64),
      }),
    });

    // Act
    const response = await POST(request);
    const payload = await readJsonRecord(response, 'vote response');

    // Assert
    expect(response.status).toBe(400);
    expect(getStringProperty(payload, 'error')).toBe('ALREADY_VOTED');
  });

  it('should reject finalized session', async () => {
    // Arrange
    getSessionMock.mockResolvedValue(
      createBaseSession({
        sessionId: 'session-finalized',
        electionId: '550e8400-e29b-41d4-a716-446655440000',
        votes: new Map(),
        botCount: 0,
        finalized: true,
        userVoteIndex: undefined,
      }),
    );

    const request = new NextRequest('http://localhost:3000/api/vote', {
      method: 'POST',
      headers: buildVoteHeaders('session-finalized'),
      body: JSON.stringify({
        commitment: '0x' + 'a'.repeat(64),
        vote: 'A',
        rand: '0x' + 'b'.repeat(64),
      }),
    });

    // Act
    const response = await POST(request);
    const payload = await readJsonRecord(response, 'vote response');

    // Assert
    expect(response.status).toBe(400);
    expect(getStringProperty(payload, 'error')).toBe('SESSION_FINALIZED');
  });

  it('should reject when commitment verification fails', async () => {
    // Arrange
    const mockSessionId = 'test-session-123';
    const mockVote = 'A';
    const mockRand = '0x' + 'b'.repeat(64);
    const wrongCommitment = '0x' + 'a'.repeat(64);

    getSessionMock.mockResolvedValue(
      createBaseSession({
        sessionId: mockSessionId,
        electionId: '550e8400-e29b-41d4-a716-446655440000',
        votes: new Map(),
        botCount: 0,
        finalized: false,
        userVoteIndex: undefined,
      }),
    );

    const request = new NextRequest('http://localhost:3000/api/vote', {
      method: 'POST',
      headers: buildVoteHeaders(mockSessionId),
      body: JSON.stringify({
        commitment: wrongCommitment,
        vote: mockVote,
        rand: mockRand,
      }),
    });

    // Act
    const response = await POST(request);
    const payload = await readJsonRecord(response, 'vote response');

    // Assert
    expect(response.status).toBe(400);
    expect(getStringProperty(payload, 'error')).toBe('INVALID_COMMITMENT');
  });

  it('should reject invalid vote choice', async () => {
    // Arrange
    getSessionMock.mockResolvedValue(
      createBaseSession({
        sessionId: 'test-session',
        electionId: '550e8400-e29b-41d4-a716-446655440000',
        votes: new Map(),
        botCount: 0,
        finalized: false,
        userVoteIndex: undefined,
      }),
    );

    const request = new NextRequest('http://localhost:3000/api/vote', {
      method: 'POST',
      headers: buildVoteHeaders('test-session'),
      body: JSON.stringify({
        commitment: '0x' + 'a'.repeat(64),
        vote: 'X', // Invalid choice
        rand: '0x' + 'b'.repeat(64),
      }),
    });

    // Act
    const response = await POST(request);
    const payload = await readJsonRecord(response, 'vote response');

    // Assert
    expect(response.status).toBe(400);
    expect(getStringProperty(payload, 'error')).toBe('INVALID_REQUEST');
  });

  it('should return vote receipt with voteId and timestamp', async () => {
    // Arrange
    const mockSessionId = 'session-receipt';
    const electionId = DEFAULT_TEST_ELECTION_ID;
    const mockVote = 'A';
    const mockRand = '0x' + 'a'.repeat(64);
    const mockCommitment = computeCommitment(electionId, 0, mockRand);
    const mockTimestamp = Date.now();
    const mockVoteId = '550e8400-e29b-41d4-a716-446655440000';
    const mockMerkleRoot = '0x' + 'f'.repeat(64);

    // Mock SHA256 commitment verification
    // Mock vote ID generation
    vi.mocked(generateVoteId).mockReturnValue(mockVoteId);

    getSessionMock.mockResolvedValue(
      createBaseSession({
        sessionId: mockSessionId,
        electionId: '550e8400-e29b-41d4-a716-446655440000',
        votes: new Map(),
        botCount: 0,
        finalized: false,
        userVoteIndex: undefined,
        bulletinRootHistory: [
          {
            root: mockMerkleRoot,
            treeSize: 0,
            timestamp: Date.now(),
          },
        ],
      }),
    );

    addVoteMock.mockResolvedValue({
      leafIndex: 0,
      merklePath: ['hash1', 'hash2', 'hash3'],
      bulletinRootAtCast: mockMerkleRoot,
    });

    // Mock Date.now to return consistent timestamp
    const dateNowSpy = vi.spyOn(Date, 'now').mockReturnValue(mockTimestamp);

    const request = new NextRequest('http://localhost:3000/api/vote', {
      method: 'POST',
      headers: buildVoteHeaders(mockSessionId),
      body: JSON.stringify({
        commitment: mockCommitment,
        vote: mockVote,
        rand: mockRand,
      }),
    });

    // Act
    const response = await POST(request);
    const payload = await readJsonRecord(response, 'vote response');
    const data = requireDataRecord(payload);

    // Assert
    expect(response.status).toBe(200);
    const voteId = getStringProperty(data, 'voteId');
    expect(voteId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    expect(getStringProperty(data, 'commitment')).toBe(mockCommitment);
    expect(getNumberProperty(data, 'bulletinIndex')).toBe(0);
    expect(getStringProperty(data, 'bulletinRootAtCast')).toBeDefined();
    expect(getNumberProperty(data, 'timestamp')).toBe(mockTimestamp);

    // Cleanup
    dateNowSpy.mockRestore();
  });

  describe('duplicate vote detection', () => {
    it('should reject duplicate voteId', async () => {
      // Arrange
      const mockSessionId = 'session-dup-voteid';
      const electionId = DEFAULT_TEST_ELECTION_ID;
      const mockVoteId = '550e8400-e29b-41d4-a716-446655440001';
      const mockVote = 'A';
      const mockRand1 = '0x' + 'a'.repeat(64);
      const mockRand2 = '0x' + 'b'.repeat(64);
      const mockCommitment1 = computeCommitment(electionId, 0, mockRand1);
      const mockCommitment2 = computeCommitment(electionId, 0, mockRand2);

      // Mock SHA256 verification
      // Mock vote ID generation to return same ID for both calls (simulating duplicate)
      vi.mocked(generateVoteId).mockReturnValue(mockVoteId);

      // Setup session for first vote
      getSessionMock.mockResolvedValue(
        createBaseSession({
          sessionId: mockSessionId,
          electionId: '550e8400-e29b-41d4-a716-446655440000',
          votes: new Map(),
          botCount: 0,
          finalized: false,
          userVoteIndex: undefined,
          bulletinRootHistory: [
            {
              root: '0x' + 'a'.repeat(64),
              treeSize: 0,
              timestamp: Date.now(),
            },
          ],
        }),
      );

      addVoteMock.mockResolvedValue({
        leafIndex: 0,
        merklePath: ['hash1'],
        bulletinRootAtCast: '0x' + 'a'.repeat(64),
      });

      // First vote - should succeed
      const request1 = new NextRequest('http://localhost:3000/api/vote', {
        method: 'POST',
        headers: buildVoteHeaders(mockSessionId),
        body: JSON.stringify({
          commitment: mockCommitment1,
          vote: mockVote,
          rand: mockRand1,
        }),
      });

      const response1 = await POST(request1);
      expect(response1.status).toBe(200);

      // Second vote with same voteId - should be rejected
      const request2 = new NextRequest('http://localhost:3000/api/vote', {
        method: 'POST',
        headers: buildVoteHeaders(mockSessionId),
        body: JSON.stringify({
          commitment: mockCommitment2,
          vote: mockVote,
          rand: mockRand2,
        }),
      });

      const response2 = await POST(request2);
      const payload2 = await readJsonRecord(response2, 'vote response');

      // Assert
      expect(response2.status).toBe(409);
      expect(getStringProperty(payload2, 'error')).toBe('DUPLICATE_VOTE');
      expect(getStringProperty(payload2, 'message')).toContain('Vote ID already exists');
    });

    it('should reject duplicate commitment', async () => {
      // Arrange
      const mockSessionId = 'session-dup-commit';
      const electionId = DEFAULT_TEST_ELECTION_ID;
      const mockVoteId1 = '550e8400-e29b-41d4-a716-446655440001';
      const mockVoteId2 = '550e8400-e29b-41d4-a716-446655440002';
      const mockVote = 'A';
      const mockRand = '0x' + 'a'.repeat(64); // Same random produces same commitment
      const mockCommitment = computeCommitment(electionId, 0, mockRand);

      // Mock SHA256 verification
      // Mock different vote IDs for each call
      vi.mocked(generateVoteId).mockReturnValueOnce(mockVoteId1).mockReturnValueOnce(mockVoteId2);

      // Setup session
      getSessionMock.mockResolvedValue(
        createBaseSession({
          sessionId: mockSessionId,
          electionId: '550e8400-e29b-41d4-a716-446655440000',
          votes: new Map(),
          botCount: 0,
          finalized: false,
          userVoteIndex: undefined,
          bulletinRootHistory: [
            {
              root: '0x' + 'a'.repeat(64),
              treeSize: 0,
              timestamp: Date.now(),
            },
          ],
        }),
      );

      addVoteMock.mockResolvedValue({
        leafIndex: 0,
        merklePath: ['hash1'],
        bulletinRootAtCast: '0x' + 'a'.repeat(64),
      });

      // First vote - should succeed
      const request1 = new NextRequest('http://localhost:3000/api/vote', {
        method: 'POST',
        headers: buildVoteHeaders(mockSessionId),
        body: JSON.stringify({
          commitment: mockCommitment,
          vote: mockVote,
          rand: mockRand,
        }),
      });

      const response1 = await POST(request1);
      expect(response1.status).toBe(200);

      // Second vote with same commitment but different voteId - should fail
      const request2 = new NextRequest('http://localhost:3000/api/vote', {
        method: 'POST',
        headers: buildVoteHeaders(mockSessionId),
        body: JSON.stringify({
          commitment: mockCommitment,
          vote: mockVote,
          rand: mockRand,
        }),
      });

      const response2 = await POST(request2);
      const data2 = await readJsonRecord(response2, 'duplicate commitment');

      // Should be rejected due to duplicate commitment
      expect(response2.status).toBe(409);
      expect(getStringProperty(data2, 'error')).toBe('DUPLICATE_VOTE');
      const message = getStringProperty(data2, 'message');
      expect(message).toBeDefined();
      expect(message).toContain('commitment has already been submitted');
    });

    it('should allow different voteId and commitment for separate sessions', async () => {
      // Arrange - Test two different sessions can use different IDs/commitments
      const electionId = DEFAULT_TEST_ELECTION_ID;
      const mockSessionId1 = 'session-dup-a';
      const mockSessionId2 = 'session-dup-b';
      const mockVoteId1 = '550e8400-e29b-41d4-a716-446655440001';
      const mockVoteId2 = '550e8400-e29b-41d4-a716-446655440002';
      const mockVote1 = 'A';
      const mockVote2 = 'B';
      const mockRand1 = '0x' + 'a'.repeat(64);
      const mockRand2 = '0x' + 'b'.repeat(64);
      const mockCommitment1 = computeCommitment(electionId, 0, mockRand1);
      const mockCommitment2 = computeCommitment(electionId, 1, mockRand2);

      // Mock SHA256 verification
      // Mock different vote IDs
      vi.mocked(generateVoteId).mockReturnValueOnce(mockVoteId1).mockReturnValueOnce(mockVoteId2);

      // Setup for first session/vote
      getSessionMock.mockResolvedValueOnce(
        createBaseSession({
          sessionId: mockSessionId1,
          electionId: '550e8400-e29b-41d4-a716-446655440000',
          votes: new Map(),
          botCount: 0,
          finalized: false,
          userVoteIndex: undefined,
          bulletinRootHistory: [
            {
              root: '0x' + 'a'.repeat(64),
              treeSize: 0,
              timestamp: Date.now(),
            },
          ],
        }),
      );

      addVoteMock.mockResolvedValueOnce({
        leafIndex: 0,
        merklePath: ['hash1'],
        bulletinRootAtCast: '0x' + 'a'.repeat(64),
      });

      // First vote in session 1
      const request1 = new NextRequest('http://localhost:3000/api/vote', {
        method: 'POST',
        headers: buildVoteHeaders(mockSessionId1),
        body: JSON.stringify({
          commitment: mockCommitment1,
          vote: mockVote1,
          rand: mockRand1,
        }),
      });

      const response1 = await POST(request1);
      expect(response1.status).toBe(200);

      // Setup for second session/vote
      getSessionMock.mockResolvedValueOnce(
        createBaseSession({
          sessionId: mockSessionId2,
          electionId: '550e8400-e29b-41d4-a716-446655440000',
          votes: new Map(),
          botCount: 0,
          finalized: false,
          userVoteIndex: undefined,
          bulletinRootHistory: [
            {
              root: '0x' + 'b'.repeat(64),
              treeSize: 0,
              timestamp: Date.now(),
            },
          ],
        }),
      );

      addVoteMock.mockResolvedValueOnce({
        leafIndex: 0,
        merklePath: ['hash2'],
        bulletinRootAtCast: '0x' + 'b'.repeat(64),
      });

      // Second vote in different session with different ID and commitment - should succeed
      const request2 = new NextRequest('http://localhost:3000/api/vote', {
        method: 'POST',
        headers: buildVoteHeaders(mockSessionId2),
        body: JSON.stringify({
          commitment: mockCommitment2,
          vote: mockVote2,
          rand: mockRand2,
        }),
      });

      const response2 = await POST(request2);
      const data2 = await readJsonRecord(response2, 'session-specific vote');
      const payload = getRecordProperty(data2, 'data');

      // Should succeed because it's a different session with different values
      expect(response2.status).toBe(200);
      expect(getStringProperty(payload, 'voteId')).toBe(mockVoteId2);
      expect(getStringProperty(payload, 'commitment')).toBe(mockCommitment2);
    });

    it('should include duplicate details in error response', async () => {
      // Arrange
      const electionId = DEFAULT_TEST_ELECTION_ID;
      const mockSessionId = 'session-dup-details';
      const mockVoteId = '550e8400-e29b-41d4-a716-446655440001';
      const mockVote = 'A';
      const mockRand = '0x' + 'a'.repeat(64);
      const mockCommitment = computeCommitment(electionId, 0, mockRand);

      // Mock SHA256 verification
      // Mock vote ID generation to return same ID for both calls
      vi.mocked(generateVoteId).mockReturnValue(mockVoteId);

      getSessionMock.mockResolvedValue(
        createBaseSession({
          sessionId: mockSessionId,
          electionId: '550e8400-e29b-41d4-a716-446655440000',
          votes: new Map(),
          botCount: 0,
          finalized: false,
          userVoteIndex: undefined,
          bulletinRootHistory: [
            {
              root: '0x' + 'a'.repeat(64),
              treeSize: 0,
              timestamp: Date.now(),
            },
          ],
        }),
      );

      addVoteMock.mockResolvedValue({
        leafIndex: 0,
        merklePath: ['hash1'],
        bulletinRootAtCast: '0x' + 'a'.repeat(64),
      });

      // First vote - succeed
      const request1 = new NextRequest('http://localhost:3000/api/vote', {
        method: 'POST',
        headers: buildVoteHeaders(mockSessionId),
        body: JSON.stringify({
          commitment: mockCommitment,
          vote: mockVote,
          rand: mockRand,
        }),
      });

      await POST(request1);

      // Second vote with same ID but different commitment - should be rejected with details
      const mockRand2 = '0x' + 'b'.repeat(64);
      const mockCommitment2 = computeCommitment(electionId, 0, mockRand2);

      const request2 = new NextRequest('http://localhost:3000/api/vote', {
        method: 'POST',
        headers: buildVoteHeaders(mockSessionId),
        body: JSON.stringify({
          commitment: mockCommitment2,
          vote: mockVote,
          rand: mockRand2,
        }),
      });

      const response2 = await POST(request2);
      const data2 = await readJsonRecord(response2, 'duplicate vote id');

      // Assert
      expect(response2.status).toBe(409);
      expect(getStringProperty(data2, 'error')).toBe('DUPLICATE_VOTE');
      const message = getStringProperty(data2, 'message');
      expect(message).toBeDefined();
      expect(message).toContain('Vote ID already exists');
    });
  });

  describe('bot voting error handling', () => {
    it('should succeed even if bot voting fails (error logged only)', async () => {
      // Arrange
      const electionId = DEFAULT_TEST_ELECTION_ID;
      const mockSessionId = 'session-bot-error';
      const mockVote = 'A';
      const mockRand = '0x' + 'd'.repeat(64);
      const mockCommitment = computeCommitment(electionId, 0, mockRand);
      const mockVoteId = '550e8400-e29b-41d4-a716-446655440003';

      // Mock SHA256 verification
      // Mock vote ID generation
      vi.mocked(generateVoteId).mockReturnValue(mockVoteId);

      // Setup session
      getSessionMock.mockResolvedValue(
        createBaseSession({
          sessionId: mockSessionId,
          electionId: '550e8400-e29b-41d4-a716-446655440000',
          votes: new Map(),
          botCount: 0,
          finalized: false,
          userVoteIndex: undefined,
          bulletinRootHistory: [
            {
              root: '0x' + 'c'.repeat(64),
              treeSize: 0,
              timestamp: Date.now(),
            },
          ],
        }),
      );

      addVoteMock.mockResolvedValue({
        leafIndex: 0,
        merklePath: ['hash1'],
        bulletinRootAtCast: '0x' + 'c'.repeat(64),
      });

      // Mock BotVoter to throw error
      startBotVotingMock.mockRejectedValue(new Error('Bot voting service unavailable'));

      const request = new NextRequest('http://localhost:3000/api/vote', {
        method: 'POST',
        headers: buildVoteHeaders(mockSessionId),
        body: JSON.stringify({
          commitment: mockCommitment,
          vote: mockVote,
          rand: mockRand,
        }),
      });

      // Act
      const response = await POST(request);
      const payload = await readJsonRecord(response, 'vote response');
      const data = requireDataRecord(payload);

      // Assert - User vote should succeed despite bot voting failure
      expect(response.status).toBe(200);
      expect(getStringProperty(data, 'voteId')).toBe(mockVoteId);
      expect(getStringProperty(data, 'commitment')).toBe(mockCommitment);

      // Wait for async error handling (bot voting is started asynchronously)
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Verify error was logged
      expect(consoleErrorSpy).toHaveBeenCalledWith('Bot voting failed:', expect.any(Error));
    });
  });

  it('should reject commitment that does not match election-scoped hash', async () => {
    const mockSessionId = 'session-domain-mismatch';
    const electionId = '550e8400-e29b-41d4-a716-446655440000';
    const random = '0x' + '1'.repeat(64);
    const voteChoice = 'A';

    getSessionMock.mockResolvedValue(
      createBaseSession({
        sessionId: mockSessionId,
        electionId,
        votes: new Map(),
        botCount: 0,
        finalized: false,
        userVoteIndex: undefined,
      }),
    );

    // Legacy commitment missing electionId domain separation
    const legacyCommitment = '0x' + '2'.repeat(64);
    expect(legacyCommitment).not.toBe(computeCommitment(electionId, 0, random));

    const request = new NextRequest('http://localhost:3000/api/vote', {
      method: 'POST',
      headers: buildVoteHeaders(mockSessionId),
      body: JSON.stringify({
        commitment: legacyCommitment,
        vote: voteChoice,
        rand: random,
      }),
    });

    const response = await POST(request);
    const payload = await readJsonRecord(response, 'vote response');

    expect(response.status).toBe(400);
    expect(getStringProperty(payload, 'error')).toBe('INVALID_COMMITMENT');
  });
});
