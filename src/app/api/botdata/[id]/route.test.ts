import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { MockInstance } from 'vitest';
import { NextRequest } from 'next/server';
import { GET } from './route';
import { getGlobalStore } from '@/lib/store/storeInstance';
import { createMockVoteStore } from '@/lib/testing/mockVoteStore';
import { readJsonRecord } from '@/lib/testing/response-helpers';
import { getRecordProperty, getStringArrayProperty, getStringProperty, getNumberProperty } from '@/lib/utils/guards';
import type { SessionData } from '@/types/server';
import type { VoteStore } from '@/types/voteStore';
import { SimpleBulletinBoard } from '@/lib/bulletin/simple-bulletin-board';
import { addHexPrefix } from '@/lib/utils/hex';
import { SESSION_CAPABILITY_HEADER } from '@/lib/session/capability';
import { createTestSessionCapabilityToken, setTestSessionCapabilitySecret } from '@/lib/testing/sessionCapability';
import { createTestJournal } from '@/lib/testing/test-helpers';
import { createTestPublicInputArtifact } from '@/lib/testing/public-input-artifact';
import { buildCloseStatement, buildElectionManifest } from '@/lib/verification/public-audit-artifacts';
import { buildDefaultElectionConfig } from '@/lib/zkvm/election-config';
import { resolveCurrentContractGeneration } from '@/lib/contract';

// Mock dependencies
vi.mock('@/lib/store/storeInstance', () => ({
  getGlobalStore: vi.fn(),
}));

describe('GET /api/botdata/[id]', () => {
  let mockStore: VoteStore;
  let getSessionMock: ReturnType<typeof vi.fn<NonNullable<VoteStore['getSession']>>>;
  let consoleErrorSpy: MockInstance<typeof console.error>;

  function createBaseSession(overrides: Partial<SessionData> = {}): SessionData {
    const now = Date.now();
    const journal = createTestJournal();
    const electionManifest = buildElectionManifest(journal.electionId, buildDefaultElectionConfig());
    journal.electionConfigHash = electionManifest.electionConfigHash;
    const closeStatement = buildCloseStatement({
      logId: '0x' + '2'.repeat(64),
      treeSize: journal.treeSize,
      timestamp: 123,
      bulletinRoot: journal.bulletinRoot,
    });
    journal.sthDigest = closeStatement.sthDigest;
    const session: SessionData = {
      sessionId: 'test-session',
      contractGeneration: resolveCurrentContractGeneration(),
      votes: new Map(),
      botCount: 0,
      finalized: false,
      createdAt: now,
      lastActivity: now,
      ...overrides,
    };

    if (session.finalized && session.finalizationContractGeneration === undefined) {
      session.finalizationContractGeneration = resolveCurrentContractGeneration();
    }

    if (
      session.finalized &&
      session.finalizationResult === undefined &&
      session.finalizationState === undefined &&
      session.finalizationScenarioContext === undefined
    ) {
      session.finalizationResult = {
        tally: {
          counts: { A: 0, B: 0, C: 0, D: 0, E: 0 },
          totalVotes: 0,
          tamperedCount: 0,
        },
        imageId: '0x' + '1'.repeat(64),
        journal,
        publicInputArtifact: createTestPublicInputArtifact({
          executionId: 'exec-botdata-test',
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
          },
        }),
        electionManifest,
        closeStatement,
        verificationExecutionId: 'exec-botdata-test',
      };
    }

    return session;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    setTestSessionCapabilitySecret();

    // Setup mock store
    getSessionMock = vi.fn<NonNullable<VoteStore['getSession']>>();
    mockStore = createMockVoteStore({
      getSession: getSessionMock,
    });

    // Mock getGlobalStore to return our mock
    vi.mocked(getGlobalStore).mockReturnValue(mockStore);

    // Suppress console.error logs in tests
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  it('should return bot data for valid ID', async () => {
    // Arrange
    const mockSessionId = 'test-session-123';
    const botId = 1;
    const userVoteId = '00000000-0000-4000-8000-000000000001';
    const botVoteId = '00000000-0000-4000-8000-000000000002';
    const userCommit = '0x' + '1'.repeat(64);
    const botCommit = '0x' + '2'.repeat(64);
    const userRand = '0x' + '3'.repeat(64);
    const botRand = '0x' + '4'.repeat(64);

    const bulletin = new SimpleBulletinBoard('log-1');
    const userAppend = bulletin.appendVote(userVoteId, userCommit);
    const botAppend = bulletin.appendVote(botVoteId, botCommit);
    const extraVoteId = '00000000-0000-4000-8000-000000000003';
    const extraCommit = '0x' + '5'.repeat(64);
    const extraRand = '0x' + '6'.repeat(64);
    const extraAppend = bulletin.appendVote(extraVoteId, extraCommit);
    const botProofAtCast = bulletin.getInclusionProof(botVoteId, botId + 1);
    if (!botProofAtCast) {
      throw new Error('Expected inclusion proof for bot vote');
    }

    getSessionMock.mockResolvedValue(
      createBaseSession({
        sessionId: mockSessionId,
        bulletin,
        votes: new Map([
          [
            0,
            {
              voteId: userVoteId,
              vote: 'A',
              rand: userRand,
              commit: userCommit,
              path: [],
              rootAtCast: userAppend.rootAtAppend,
              timestamp: userAppend.timestamp,
            },
          ],
          [
            botId,
            {
              voteId: botVoteId,
              vote: 'C',
              rand: botRand,
              commit: botCommit,
              path: [],
              rootAtCast: botAppend.rootAtAppend,
              timestamp: botAppend.timestamp,
            },
          ],
          [
            2,
            {
              voteId: extraVoteId,
              vote: 'D',
              rand: extraRand,
              commit: extraCommit,
              path: [],
              rootAtCast: extraAppend.rootAtAppend,
              timestamp: extraAppend.timestamp,
            },
          ],
        ]),
        botCount: 63,
        finalized: true, // Session must be finalized to access bot data
        userVoteIndex: 0,
      }),
    );

    const request = new NextRequest(`http://localhost:3000/api/botdata/${botId}`, {
      method: 'GET',
      headers: {
        'X-Session-ID': mockSessionId,
        [SESSION_CAPABILITY_HEADER]: createTestSessionCapabilityToken(mockSessionId),
      },
    });

    // Act
    const response = await GET(request, { params: Promise.resolve({ id: botId.toString() }) });
    const payload = await readJsonRecord(response, 'botdata response');
    const data = getRecordProperty(payload, 'data');

    // Assert
    expect(response.status).toBe(200);
    expect(getNumberProperty(data, 'id')).toBe(botId);
    expect(getStringProperty(data, 'vote')).toBe('C');
    expect(getStringProperty(data, 'random')).toBe(botRand);
    expect(getStringProperty(data, 'commitment')).toBe(botCommit);
    expect(getStringProperty(data, 'voteId')).toBe(botVoteId);
    const proof = getRecordProperty(data, 'proof');
    expect(getNumberProperty(proof, 'leafIndex')).toBe(botProofAtCast.leafIndex);
    expect(getNumberProperty(proof, 'treeSize')).toBe(botProofAtCast.treeSize);
    expect(getStringProperty(proof, 'bulletinRootAtCast')).toBe(addHexPrefix(botProofAtCast.rootHash));
    expect(getStringArrayProperty(proof, 'merklePath')).toEqual(
      botProofAtCast.proofNodes.map((node) => addHexPrefix(node)),
    );
  });

  it('should reject request without session ID', async () => {
    // Arrange
    const request = new NextRequest('http://localhost:3000/api/botdata/1', {
      method: 'GET',
    });

    // Act
    const response = await GET(request, { params: Promise.resolve({ id: '1' }) });
    const payload = await readJsonRecord(response, 'botdata response');

    // Assert
    expect(response.status).toBe(400);
    expect(getStringProperty(payload, 'error')).toBe('SESSION_ID_REQUIRED');
  });

  it('should reject request without capability token', async () => {
    const request = new NextRequest('http://localhost:3000/api/botdata/1', {
      method: 'GET',
      headers: {
        'X-Session-ID': 'test-session',
      },
    });

    const response = await GET(request, { params: Promise.resolve({ id: '1' }) });
    const payload = await readJsonRecord(response, 'botdata response');

    expect(response.status).toBe(401);
    expect(getStringProperty(payload, 'error')).toBe('SESSION_CAPABILITY_REQUIRED');
  });

  it('should return 404 for non-existent session', async () => {
    // Arrange
    getSessionMock.mockResolvedValue(null);

    const request = new NextRequest('http://localhost:3000/api/botdata/1', {
      method: 'GET',
      headers: {
        'X-Session-ID': 'non-existent',
        [SESSION_CAPABILITY_HEADER]: createTestSessionCapabilityToken('non-existent'),
      },
    });

    // Act
    const response = await GET(request, { params: Promise.resolve({ id: '1' }) });
    const payload = await readJsonRecord(response, 'botdata response');

    // Assert
    expect(response.status).toBe(404);
    expect(getStringProperty(payload, 'error')).toBe('SESSION_NOT_FOUND');
  });

  it('should reject invalid bot ID (non-numeric)', async () => {
    // Arrange
    getSessionMock.mockResolvedValue(
      createBaseSession({
        sessionId: 'test-session',
        votes: new Map(),
        botCount: 63,
        finalized: false,
      }),
    );

    const request = new NextRequest('http://localhost:3000/api/botdata/invalid', {
      method: 'GET',
      headers: {
        'X-Session-ID': 'test-session',
        [SESSION_CAPABILITY_HEADER]: createTestSessionCapabilityToken('test-session'),
      },
    });

    // Act
    const response = await GET(request, { params: Promise.resolve({ id: 'invalid' }) });
    const payload = await readJsonRecord(response, 'botdata response');

    // Assert
    expect(response.status).toBe(400);
    expect(getStringProperty(payload, 'error')).toBe('INVALID_BOT_ID');
  });

  it('should reject bot ID out of range (0 or > 63)', async () => {
    // Arrange
    getSessionMock.mockResolvedValue(
      createBaseSession({
        sessionId: 'test-session',
        votes: new Map(),
        botCount: 63,
        finalized: false,
      }),
    );

    const request1 = new NextRequest('http://localhost:3000/api/botdata/0', {
      method: 'GET',
      headers: {
        'X-Session-ID': 'test-session',
        [SESSION_CAPABILITY_HEADER]: createTestSessionCapabilityToken('test-session'),
      },
    });

    const request2 = new NextRequest('http://localhost:3000/api/botdata/64', {
      method: 'GET',
      headers: {
        'X-Session-ID': 'test-session',
        [SESSION_CAPABILITY_HEADER]: createTestSessionCapabilityToken('test-session'),
      },
    });

    // Act
    const response1 = await GET(request1, { params: Promise.resolve({ id: '0' }) });
    const data1 = await readJsonRecord(response1, 'botdata invalid id');

    const response2 = await GET(request2, { params: Promise.resolve({ id: '64' }) });
    const data2 = await readJsonRecord(response2, 'botdata invalid id');

    // Assert
    expect(response1.status).toBe(400);
    expect(getStringProperty(data1, 'error')).toBe('INVALID_BOT_ID');

    expect(response2.status).toBe(400);
    expect(getStringProperty(data2, 'error')).toBe('INVALID_BOT_ID');
  });

  it('should return 404 if bot data not found', async () => {
    // Arrange
    const mockSessionId = 'test-session-123';
    const botId = 50;

    getSessionMock.mockResolvedValue(
      createBaseSession({
        sessionId: mockSessionId,
        votes: new Map([
          [0, { vote: 'A', rand: 'userRand', commit: 'userCommit', path: [] }],
          // Bot 50 data is not in votes map
        ]),
        botCount: 63,
        finalized: true, // Session must be finalized to access bot data
        userVoteIndex: 0,
      }),
    );

    const request = new NextRequest(`http://localhost:3000/api/botdata/${botId}`, {
      method: 'GET',
      headers: {
        'X-Session-ID': mockSessionId,
        [SESSION_CAPABILITY_HEADER]: createTestSessionCapabilityToken(mockSessionId),
      },
    });

    // Act
    const response = await GET(request, { params: Promise.resolve({ id: botId.toString() }) });
    const payload = await readJsonRecord(response, 'botdata response');

    // Assert
    expect(response.status).toBe(404);
    expect(getStringProperty(payload, 'error')).toBe('BOT_DATA_NOT_FOUND');
  });

  it('should reject if session is not finalized', async () => {
    // Arrange
    const mockSessionId = 'test-session-123';
    const botId = 10;

    getSessionMock.mockResolvedValue(
      createBaseSession({
        sessionId: mockSessionId,
        votes: new Map([[botId, { vote: 'C', rand: 'botRand10', commit: 'botCommit10', path: [] }]]),
        botCount: 63,
        finalized: false, // Not finalized
      }),
    );

    const request = new NextRequest(`http://localhost:3000/api/botdata/${botId}`, {
      method: 'GET',
      headers: {
        'X-Session-ID': mockSessionId,
        [SESSION_CAPABILITY_HEADER]: createTestSessionCapabilityToken(mockSessionId),
      },
    });

    // Act
    const response = await GET(request, { params: Promise.resolve({ id: botId.toString() }) });
    const payload = await readJsonRecord(response, 'botdata response');

    // Assert
    expect(response.status).toBe(400);
    expect(getStringProperty(payload, 'error')).toBe('SESSION_NOT_FINALIZED');
  });

  it('fails closed when finalized bot data state is marked corrupt', async () => {
    const mockSessionId = 'test-session-corrupt';

    getSessionMock.mockResolvedValue(
      createBaseSession({
        sessionId: mockSessionId,
        finalized: true,
        finalizationArtifactState: 'corrupt_or_unreadable',
        votes: new Map([
          [
            1,
            {
              voteId: '00000000-0000-4000-8000-000000000002',
              vote: 'B',
              rand: '0x' + '5'.repeat(64),
              commit: '0x' + '6'.repeat(64),
              path: [],
            },
          ],
        ]),
      }),
    );

    const request = new NextRequest('http://localhost:3000/api/botdata/1', {
      method: 'GET',
      headers: {
        'X-Session-ID': mockSessionId,
        [SESSION_CAPABILITY_HEADER]: createTestSessionCapabilityToken(mockSessionId),
      },
    });

    const response = await GET(request, { params: Promise.resolve({ id: '1' }) });
    const payload = await readJsonRecord(response, 'botdata response');

    expect(response.status).toBe(500);
    expect(getStringProperty(payload, 'error')).toBe('CORRUPT_OR_UNREADABLE_FINALIZED_STATE');
    expect(getStringProperty(payload, 'artifactState')).toBe('corrupt_or_unreadable');
  });

  it('should fail fast when CT proof is unavailable', async () => {
    const mockSessionId = 'test-session-ct-missing';
    const botId = 1;
    const botVoteId = '00000000-0000-4000-8000-000000000003';

    getSessionMock.mockResolvedValue(
      createBaseSession({
        sessionId: mockSessionId,
        votes: new Map([
          [
            botId,
            {
              voteId: botVoteId,
              vote: 'B',
              rand: '0x' + '5'.repeat(64),
              commit: '0x' + '6'.repeat(64),
              path: [],
            },
          ],
        ]),
        botCount: 63,
        finalized: true,
        userVoteIndex: 0,
      }),
    );

    const request = new NextRequest(`http://localhost:3000/api/botdata/${botId}`, {
      method: 'GET',
      headers: {
        'X-Session-ID': mockSessionId,
        [SESSION_CAPABILITY_HEADER]: createTestSessionCapabilityToken(mockSessionId),
      },
    });

    const response = await GET(request, { params: Promise.resolve({ id: botId.toString() }) });
    const payload = await readJsonRecord(response, 'botdata response');

    expect(response.status).toBe(500);
    expect(getStringProperty(payload, 'error')).toBe('INTERNAL_ERROR');
  });
});
