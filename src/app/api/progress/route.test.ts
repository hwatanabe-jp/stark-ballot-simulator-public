import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { MockInstance } from 'vitest';
import { NextRequest } from 'next/server';
import { GET } from './route';
import { getGlobalStore } from '@/lib/store/storeInstance';
import { createMockVoteStore } from '@/lib/testing/mockVoteStore';
import { readJsonRecord } from '@/lib/testing/response-helpers';
import { getRecordProperty, getStringProperty } from '@/lib/utils/guards';
import type { SessionData, VoteData } from '@/types/server';
import type { VoteStore } from '@/types/voteStore';
import { SESSION_CAPABILITY_HEADER } from '@/lib/session/capability';
import { createTestSessionCapabilityToken, setTestSessionCapabilitySecret } from '@/lib/testing/sessionCapability';
import { resolveCurrentContractGeneration } from '@/lib/contract';

// Mock getGlobalStore
vi.mock('@/lib/store/storeInstance', () => ({
  getGlobalStore: vi.fn(),
}));

describe('GET /api/progress', () => {
  let mockStore: VoteStore;
  let getSessionMock: ReturnType<typeof vi.fn<NonNullable<VoteStore['getSession']>>>;
  let consoleErrorSpy: MockInstance<typeof console.error>;

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
      sessionId: 'test-session',
      contractGeneration: resolveCurrentContractGeneration(),
      votes: new Map(),
      botCount: 0,
      finalized: false,
      createdAt: now,
      lastActivity: now,
      ...overrides,
    };
  };

  const createSupportedFinalizedSession = (overrides: Partial<SessionData> = {}): SessionData =>
    createBaseSession({
      finalized: true,
      finalizationContractGeneration: resolveCurrentContractGeneration(),
      finalizationResult: {
        verificationExecutionId: 'exec-1',
      } as NonNullable<SessionData['finalizationResult']>,
      ...overrides,
    });

  beforeEach(() => {
    vi.clearAllMocks();
    setTestSessionCapabilitySecret();

    // Setup mock store
    getSessionMock = vi.fn<NonNullable<VoteStore['getSession']>>();
    mockStore = createMockVoteStore({
      getSession: getSessionMock,
      updateSession: vi.fn<NonNullable<VoteStore['updateSession']>>().mockResolvedValue(undefined),
    });

    // Mock getGlobalStore to return our mock
    vi.mocked(getGlobalStore).mockReturnValue(mockStore);

    // Suppress console.error logs in tests
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  it('should return progress for valid session', async () => {
    // Arrange
    const mockSessionId = 'test-session-123';

    getSessionMock.mockResolvedValue(
      createBaseSession({
        sessionId: mockSessionId,
        botCount: 50,
        finalized: false,
        userVoteIndex: 0,
        votes: createVotes(50),
      }),
    );

    const request = new NextRequest('http://localhost:3000/api/progress', {
      method: 'GET',
      headers: {
        'X-Session-ID': mockSessionId,
        [SESSION_CAPABILITY_HEADER]: createTestSessionCapabilityToken(mockSessionId),
      },
    });

    // Act
    const response = await GET(request);
    const payload = await readJsonRecord(response, 'progress response');
    const data = getRecordProperty(payload, 'data');

    // Assert
    expect(response.status).toBe(200);
    expect(data).toEqual({
      count: 50,
      total: 63,
      completed: false,
      userVoted: true,
      finalized: false,
    });
  });

  it('should derive progress from canonical vote count when session metadata is stale', async () => {
    const mockSessionId = 'test-session-123';

    getSessionMock.mockResolvedValue(
      createBaseSession({
        sessionId: mockSessionId,
        botCount: 0,
        finalized: false,
        userVoteIndex: undefined,
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
      }),
    );

    const request = new NextRequest('http://localhost:3000/api/progress', {
      method: 'GET',
      headers: {
        'X-Session-ID': mockSessionId,
        [SESSION_CAPABILITY_HEADER]: createTestSessionCapabilityToken(mockSessionId),
      },
    });

    const response = await GET(request);
    const payload = await readJsonRecord(response, 'progress response');
    const data = getRecordProperty(payload, 'data');

    expect(response.status).toBe(200);
    expect(data).toEqual({
      count: 2,
      total: 63,
      completed: false,
      userVoted: true,
      finalized: false,
    });
  });

  it('should indicate user has not voted', async () => {
    // Arrange
    const mockSessionId = 'test-session-123';

    getSessionMock.mockResolvedValue(
      createBaseSession({
        sessionId: mockSessionId,
        botCount: 63,
        finalized: false,
        userVoteIndex: undefined,
      }),
    );

    const request = new NextRequest('http://localhost:3000/api/progress', {
      method: 'GET',
      headers: {
        'X-Session-ID': mockSessionId,
        [SESSION_CAPABILITY_HEADER]: createTestSessionCapabilityToken(mockSessionId),
      },
    });

    // Act
    const response = await GET(request);
    const payload = await readJsonRecord(response, 'progress response');
    const data = getRecordProperty(payload, 'data');

    // Assert
    expect(response.status).toBe(200);
    expect(data).toEqual({
      count: 0,
      total: 63,
      completed: false,
      userVoted: false,
      finalized: false,
    });
  });

  it('should reject request without session ID', async () => {
    // Arrange
    const request = new NextRequest('http://localhost:3000/api/progress', {
      method: 'GET',
    });

    // Act
    const response = await GET(request);
    const payload = await readJsonRecord(response, 'progress response');

    // Assert
    expect(response.status).toBe(400);
    expect(getStringProperty(payload, 'error')).toBe('SESSION_ID_REQUIRED');
  });

  it('should reject request without capability token', async () => {
    const request = new NextRequest('http://localhost:3000/api/progress', {
      method: 'GET',
      headers: {
        'X-Session-ID': 'test-session-123',
      },
    });

    const response = await GET(request);
    const payload = await readJsonRecord(response, 'progress response');

    expect(response.status).toBe(401);
    expect(getStringProperty(payload, 'error')).toBe('SESSION_CAPABILITY_REQUIRED');
  });

  it('should return 404 for non-existent session', async () => {
    // Arrange
    getSessionMock.mockResolvedValue(null);

    const request = new NextRequest('http://localhost:3000/api/progress', {
      method: 'GET',
      headers: {
        'X-Session-ID': 'non-existent',
        [SESSION_CAPABILITY_HEADER]: createTestSessionCapabilityToken('non-existent'),
      },
    });

    // Act
    const response = await GET(request);
    const payload = await readJsonRecord(response, 'progress response');

    // Assert
    expect(response.status).toBe(404);
    expect(getStringProperty(payload, 'error')).toBe('SESSION_NOT_FOUND');
  });

  it('should return 404 for stale live sessions via getSession fallback', async () => {
    const mockSessionId = 'test-session-123';

    getSessionMock.mockResolvedValue(
      createBaseSession({
        sessionId: mockSessionId,
        contractGeneration: 'stale-contract-generation',
        botCount: 10,
        finalized: false,
        userVoteIndex: 0,
      }),
    );

    const request = new NextRequest('http://localhost:3000/api/progress', {
      method: 'GET',
      headers: {
        'X-Session-ID': mockSessionId,
        [SESSION_CAPABILITY_HEADER]: createTestSessionCapabilityToken(mockSessionId),
      },
    });

    const response = await GET(request);
    const payload = await readJsonRecord(response, 'progress response');

    expect(response.status).toBe(404);
    expect(getStringProperty(payload, 'error')).toBe('SESSION_NOT_FOUND');
  });

  it('should return 404 for stale live sessions via getSessionSummary', async () => {
    const mockSessionId = 'test-session-summary';
    const getSessionSummaryMock = vi.fn<NonNullable<NonNullable<VoteStore['getSessionSummary']>>>().mockResolvedValue({
      sessionId: mockSessionId,
      contractGeneration: 'stale-contract-generation',
      botCount: 8,
      userVoteIndex: 0,
      finalized: false,
    });

    mockStore = createMockVoteStore({
      getSession: getSessionMock,
      getSessionSummary: getSessionSummaryMock,
      updateSession: vi.fn<NonNullable<VoteStore['updateSession']>>().mockResolvedValue(undefined),
    });
    vi.mocked(getGlobalStore).mockReturnValue(mockStore);

    const request = new NextRequest('http://localhost:3000/api/progress', {
      method: 'GET',
      headers: {
        'X-Session-ID': mockSessionId,
        [SESSION_CAPABILITY_HEADER]: createTestSessionCapabilityToken(mockSessionId),
      },
    });

    const response = await GET(request);
    const payload = await readJsonRecord(response, 'progress response');

    expect(response.status).toBe(404);
    expect(getStringProperty(payload, 'error')).toBe('SESSION_NOT_FOUND');
    expect(getSessionSummaryMock).toHaveBeenCalledWith(mockSessionId);
  });

  it('should resolve progress directly from getSessionSummary for current live sessions', async () => {
    const mockSessionId = 'test-session-summary-current';
    const getSessionSummaryMock = vi.fn<NonNullable<NonNullable<VoteStore['getSessionSummary']>>>().mockResolvedValue({
      sessionId: mockSessionId,
      contractGeneration: resolveCurrentContractGeneration(),
      botCount: 12,
      userVoteIndex: 0,
      finalized: false,
    });

    mockStore = createMockVoteStore({
      getSession: getSessionMock,
      getSessionSummary: getSessionSummaryMock,
      updateSession: vi.fn<NonNullable<VoteStore['updateSession']>>().mockResolvedValue(undefined),
    });
    vi.mocked(getGlobalStore).mockReturnValue(mockStore);

    const request = new NextRequest('http://localhost:3000/api/progress', {
      method: 'GET',
      headers: {
        'X-Session-ID': mockSessionId,
        [SESSION_CAPABILITY_HEADER]: createTestSessionCapabilityToken(mockSessionId),
      },
    });

    const response = await GET(request);
    const payload = await readJsonRecord(response, 'progress response');
    const data = getRecordProperty(payload, 'data');

    expect(response.status).toBe(200);
    expect(data).toEqual({
      count: 12,
      total: 63,
      completed: false,
      userVoted: true,
      finalized: false,
    });
    expect(getSessionSummaryMock).toHaveBeenCalledWith(mockSessionId);
    expect(getSessionMock).not.toHaveBeenCalled();
  });

  it('should return 404 when getSessionSummary reports a fail-closed finalization branch', async () => {
    const mockSessionId = 'test-session-branch-fail-closed';
    const getSessionSummaryMock = vi.fn<NonNullable<NonNullable<VoteStore['getSessionSummary']>>>().mockResolvedValue({
      sessionId: mockSessionId,
      contractGeneration: resolveCurrentContractGeneration(),
      finalizationArtifactState: 'unsupported_current_artifact',
      botCount: 8,
      userVoteIndex: 0,
      finalized: false,
    });

    mockStore = createMockVoteStore({
      getSession: getSessionMock,
      getSessionSummary: getSessionSummaryMock,
      updateSession: vi.fn<NonNullable<VoteStore['updateSession']>>().mockResolvedValue(undefined),
    });
    vi.mocked(getGlobalStore).mockReturnValue(mockStore);

    const request = new NextRequest('http://localhost:3000/api/progress', {
      method: 'GET',
      headers: {
        'X-Session-ID': mockSessionId,
        [SESSION_CAPABILITY_HEADER]: createTestSessionCapabilityToken(mockSessionId),
      },
    });

    const response = await GET(request);
    const payload = await readJsonRecord(response, 'progress response');

    expect(response.status).toBe(404);
    expect(getStringProperty(payload, 'error')).toBe('SESSION_NOT_FOUND');
    expect(getSessionSummaryMock).toHaveBeenCalledWith(mockSessionId);
    expect(getSessionMock).not.toHaveBeenCalled();
  });

  it('should return 404 when getSessionSummary reports finalized unsupported state', async () => {
    const mockSessionId = 'test-session-finalized-summary-stale';
    const getSessionSummaryMock = vi.fn<NonNullable<NonNullable<VoteStore['getSessionSummary']>>>().mockResolvedValue({
      sessionId: mockSessionId,
      contractGeneration: resolveCurrentContractGeneration(),
      finalizationArtifactState: 'unsupported_current_artifact',
      botCount: 63,
      userVoteIndex: 0,
      finalized: true,
    });

    mockStore = createMockVoteStore({
      getSession: getSessionMock,
      getSessionSummary: getSessionSummaryMock,
      updateSession: vi.fn<NonNullable<VoteStore['updateSession']>>().mockResolvedValue(undefined),
    });
    vi.mocked(getGlobalStore).mockReturnValue(mockStore);

    const request = new NextRequest('http://localhost:3000/api/progress', {
      method: 'GET',
      headers: {
        'X-Session-ID': mockSessionId,
        [SESSION_CAPABILITY_HEADER]: createTestSessionCapabilityToken(mockSessionId),
      },
    });

    const response = await GET(request);
    const payload = await readJsonRecord(response, 'progress response');

    expect(response.status).toBe(404);
    expect(getStringProperty(payload, 'error')).toBe('SESSION_NOT_FOUND');
    expect(getSessionSummaryMock).toHaveBeenCalledWith(mockSessionId);
    expect(getSessionMock).not.toHaveBeenCalled();
  });

  it('should return 404 for finalized fail-closed sessions via getSession fallback', async () => {
    const mockSessionId = 'test-session-finalized-fallback-fail-closed';

    getSessionMock.mockResolvedValue(
      createSupportedFinalizedSession({
        sessionId: mockSessionId,
        finalizationArtifactState: 'corrupt_or_unreadable',
      }),
    );

    const request = new NextRequest('http://localhost:3000/api/progress', {
      method: 'GET',
      headers: {
        'X-Session-ID': mockSessionId,
        [SESSION_CAPABILITY_HEADER]: createTestSessionCapabilityToken(mockSessionId),
      },
    });

    const response = await GET(request);
    const payload = await readJsonRecord(response, 'progress response');

    expect(response.status).toBe(404);
    expect(getStringProperty(payload, 'error')).toBe('SESSION_NOT_FOUND');
  });

  it('should indicate finalized session', async () => {
    // Arrange
    const mockSessionId = 'test-session-123';

    getSessionMock.mockResolvedValue(
      createSupportedFinalizedSession({
        sessionId: mockSessionId,
        votes: createVotes(63),
        botCount: 63,
        userVoteIndex: 0,
      }),
    );

    const request = new NextRequest('http://localhost:3000/api/progress', {
      method: 'GET',
      headers: {
        'X-Session-ID': mockSessionId,
        [SESSION_CAPABILITY_HEADER]: createTestSessionCapabilityToken(mockSessionId),
      },
    });

    // Act
    const response = await GET(request);
    const payload = await readJsonRecord(response, 'progress response');
    const data = getRecordProperty(payload, 'data');

    // Assert
    expect(response.status).toBe(200);
    expect(data).toEqual({
      count: 63,
      total: 63,
      completed: true,
      userVoted: true,
      finalized: true,
    });
  });
});
