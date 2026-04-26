import { describe, it, expect, beforeEach, afterEach, vi, type MockInstance } from 'vitest';
import { NextRequest } from 'next/server';
import { GET } from '../route';
import { getGlobalStore } from '@/lib/store/storeInstance';
import { ErrorCode } from '@/lib/errors';
import type { SessionData } from '@/types/server';
import type { ZkVMJournal } from '@/lib/zkvm/types';
import { createMockVoteStore } from '@/lib/testing/mockVoteStore';
import { readJsonRecord } from '@/lib/testing/response-helpers';
import { getNumberProperty, getRecordProperty, getStringProperty } from '@/lib/utils/guards';
import type { VoteStore } from '@/types/voteStore';
import { SESSION_CAPABILITY_HEADER } from '@/lib/session/capability';
import { createTestSessionCapabilityToken, setTestSessionCapabilitySecret } from '@/lib/testing/sessionCapability';
import { createTestJournal } from '@/lib/testing/test-helpers';
import { createTestPublicInputArtifact } from '@/lib/testing/public-input-artifact';
import { buildCloseStatement, buildElectionManifest } from '@/lib/verification/public-audit-artifacts';
import { buildDefaultElectionConfig } from '@/lib/zkvm/election-config';
import { CURRENT_METHOD_VERSION } from '@/lib/zkvm/types';
import { resolveCurrentContractGeneration } from '@/lib/contract';

vi.mock('@/lib/store/storeInstance', () => ({
  getGlobalStore: vi.fn(),
}));

describe('STH API route', () => {
  let consoleWarnSpy: MockInstance<typeof console.warn>;
  let consoleErrorSpy: MockInstance<typeof console.error>;
  const mockSessionId = 'test-session-123';
  const mockJournal: ZkVMJournal = {
    ...createTestJournal({
      totalExpected: 64,
      validVotes: 64,
      missingIndices: 0,
      invalidIndices: 0,
      seenIndicesCount: 64,
    }),
    electionId: '550e8400-e29b-41d4-a716-446655440000',
    bulletinRoot: '0x' + 'a'.repeat(64),
    treeSize: 64,
    totalExpected: 64,
    verifiedTally: [10, 20, 15, 12, 7],
    totalVotes: 64,
    validVotes: 64,
    invalidVotes: 0,
    seenIndicesCount: 64,
    missingSlots: 0,
    invalidPresentedSlots: 0,
    rejectedRecords: 0,
    includedBitmapRoot: '0x' + '0'.repeat(64),
    excludedSlots: 0,
    inputCommitment: '0x' + '0'.repeat(64),
    methodVersion: CURRENT_METHOD_VERSION,
    imageId: '0x98465a16a6776bd5fc35299e06dfea5886f87d2f94aac5fd79353af50caa01f4',
  };

  const logId = '0x' + '7'.repeat(64);
  const journalImageId = mockJournal.imageId ?? '0x' + '5'.repeat(64);
  const electionManifest = buildElectionManifest(mockJournal.electionId, buildDefaultElectionConfig());
  mockJournal.electionConfigHash = electionManifest.electionConfigHash;
  const closeStatement = buildCloseStatement({
    logId,
    treeSize: mockJournal.treeSize,
    timestamp: 123,
    bulletinRoot: mockJournal.bulletinRoot,
  });
  mockJournal.sthDigest = closeStatement.sthDigest;
  const mockSession: SessionData = {
    sessionId: mockSessionId,
    contractGeneration: resolveCurrentContractGeneration(),
    finalizationContractGeneration: resolveCurrentContractGeneration(),
    votes: new Map(),
    botCount: 0,
    finalized: true,
    finalizationResult: {
      journal: mockJournal,
      tally: {
        counts: { A: 10, B: 20, C: 15, D: 12, E: 7 },
        totalVotes: 64,
        tamperedCount: 0,
      },
      imageId: journalImageId,
      publicInputArtifact: createTestPublicInputArtifact({
        executionId: 'exec-sth-test',
        typedAuthority: {
          electionId: mockJournal.electionId,
          electionConfigHash: mockJournal.electionConfigHash,
          methodVersion: mockJournal.methodVersion,
          bulletinRoot: mockJournal.bulletinRoot,
          treeSize: mockJournal.treeSize,
          totalExpected: mockJournal.totalExpected,
          votesCount: mockJournal.validVotes,
          logId,
          timestamp: 123,
          recomputedInputCommitment: mockJournal.inputCommitment,
        },
      }),
      electionManifest,
      closeStatement,
      verificationExecutionId: 'exec-sth-test',
    },
    lastActivity: Date.now(),
    logId,
    createdAt: Date.now(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    setTestSessionCapabilitySecret();
    consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleWarnSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  it('returns STH data in { sth: { ... } } format when session is finalized', async () => {
    const mockStore: VoteStore = createMockVoteStore({
      getSession: vi.fn().mockResolvedValue(mockSession),
    });
    vi.mocked(getGlobalStore).mockReturnValue(mockStore);

    const request = new NextRequest('http://localhost/api/sth', {
      headers: {
        'X-Session-ID': mockSessionId,
        [SESSION_CAPABILITY_HEADER]: createTestSessionCapabilityToken(mockSessionId),
      },
    });

    const response = await GET(request);
    const payload = await readJsonRecord(response, 'sth response');

    expect(response.status).toBe(200);
    expect(payload).toHaveProperty('sth');
    const sthRecord = getRecordProperty(payload, 'sth');
    expect(sthRecord).toMatchObject({
      sthDigest: mockJournal.sthDigest,
      bulletinRoot: mockJournal.bulletinRoot,
      treeSize: mockJournal.treeSize,
      logId,
    });
    expect(getNumberProperty(sthRecord, 'timestamp')).toBeTypeOf('number');
  });

  it('returns 400 when X-Session-ID header is missing', async () => {
    const getSessionMock = vi.fn<NonNullable<VoteStore['getSession']>>();
    const mockStore: VoteStore = createMockVoteStore({
      getSession: getSessionMock,
    });
    vi.mocked(getGlobalStore).mockReturnValue(mockStore);

    const request = new NextRequest('http://localhost/api/sth');

    const response = await GET(request);
    const payload = await readJsonRecord(response, 'sth response');

    expect(response.status).toBe(400);
    expect(getStringProperty(payload, 'error')).toBe(ErrorCode.SESSION_ID_REQUIRED);
    expect(getSessionMock).not.toHaveBeenCalled();
  });

  it('returns 401 when capability header is missing', async () => {
    const getSessionMock = vi.fn<NonNullable<VoteStore['getSession']>>();
    const mockStore: VoteStore = createMockVoteStore({
      getSession: getSessionMock,
    });
    vi.mocked(getGlobalStore).mockReturnValue(mockStore);

    const request = new NextRequest('http://localhost/api/sth', {
      headers: { 'X-Session-ID': mockSessionId },
    });

    const response = await GET(request);
    const payload = await readJsonRecord(response, 'sth response');

    expect(response.status).toBe(401);
    expect(getStringProperty(payload, 'error')).toBe(ErrorCode.SESSION_CAPABILITY_REQUIRED);
    expect(getSessionMock).not.toHaveBeenCalled();
  });

  it('returns 404 when session is not found', async () => {
    const mockStore: VoteStore = createMockVoteStore({
      getSession: vi.fn().mockResolvedValue(null),
    });
    vi.mocked(getGlobalStore).mockReturnValue(mockStore);

    const request = new NextRequest('http://localhost/api/sth', {
      headers: {
        'X-Session-ID': 'nonexistent-session',
        [SESSION_CAPABILITY_HEADER]: createTestSessionCapabilityToken('nonexistent-session'),
      },
    });

    const response = await GET(request);
    const payload = await readJsonRecord(response, 'sth response');

    expect(response.status).toBe(404);
    expect(getStringProperty(payload, 'error')).toBe(ErrorCode.SESSION_NOT_FOUND);
  });

  it('returns 404 when session is not finalized', async () => {
    const unfinalizedSession: SessionData = {
      ...mockSession,
      finalized: false,
      finalizationContractGeneration: undefined,
      finalizationResult: undefined,
    };

    const mockStore: VoteStore = createMockVoteStore({
      getSession: vi.fn().mockResolvedValue(unfinalizedSession),
    });
    vi.mocked(getGlobalStore).mockReturnValue(mockStore);

    const request = new NextRequest('http://localhost/api/sth', {
      headers: {
        'X-Session-ID': mockSessionId,
        [SESSION_CAPABILITY_HEADER]: createTestSessionCapabilityToken(mockSessionId),
      },
    });

    const response = await GET(request);
    const payload = await readJsonRecord(response, 'sth response');

    expect(response.status).toBe(404);
    expect(getStringProperty(payload, 'error')).toBe(ErrorCode.SESSION_NOT_FINALIZED);
    expect(getStringProperty(payload, 'message')).toContain('Session has not been finalized yet');
  });

  it('fails closed when finalized STH state is unsupported for the current contract', async () => {
    const mockStore: VoteStore = createMockVoteStore({
      getSession: vi.fn().mockResolvedValue({
        ...mockSession,
        finalizationArtifactState: 'unsupported_current_artifact',
      }),
    });
    vi.mocked(getGlobalStore).mockReturnValue(mockStore);

    const request = new NextRequest('http://localhost/api/sth', {
      headers: {
        'X-Session-ID': mockSessionId,
        [SESSION_CAPABILITY_HEADER]: createTestSessionCapabilityToken(mockSessionId),
      },
    });

    const response = await GET(request);
    const payload = await readJsonRecord(response, 'sth response');

    expect(response.status).toBe(500);
    expect(getStringProperty(payload, 'error')).toBe(ErrorCode.UNSUPPORTED_CURRENT_ARTIFACT);
    expect(getStringProperty(payload, 'artifactState')).toBe('unsupported_current_artifact');
  });

  it('fails closed when canonicalized finalized STH state is corrupt', async () => {
    const baseFinalizationResult = mockSession.finalizationResult;
    if (!baseFinalizationResult) {
      throw new Error('Expected finalization result to be available');
    }

    const mockStore: VoteStore = createMockVoteStore({
      getSession: vi.fn().mockResolvedValue({
        ...mockSession,
        finalizationResult: {
          ...baseFinalizationResult,
          publicInputArtifact: createTestPublicInputArtifact({
            typedAuthority: {
              electionId: mockJournal.electionId,
              electionConfigHash: mockJournal.electionConfigHash,
              methodVersion: mockJournal.methodVersion,
              bulletinRoot: mockJournal.bulletinRoot,
              treeSize: mockJournal.treeSize,
              totalExpected: mockJournal.totalExpected,
              votesCount: mockJournal.validVotes,
              logId,
              timestamp: 123,
              recomputedInputCommitment: mockJournal.inputCommitment,
            },
          }),
        },
      }),
    });
    vi.mocked(getGlobalStore).mockReturnValue(mockStore);

    const request = new NextRequest('http://localhost/api/sth', {
      headers: {
        'X-Session-ID': mockSessionId,
        [SESSION_CAPABILITY_HEADER]: createTestSessionCapabilityToken(mockSessionId),
      },
    });

    const response = await GET(request);
    const payload = await readJsonRecord(response, 'sth response');

    expect(response.status).toBe(500);
    expect(getStringProperty(payload, 'error')).toBe(ErrorCode.CORRUPT_OR_UNREADABLE_FINALIZED_STATE);
    expect(getStringProperty(payload, 'artifactState')).toBe('corrupt_or_unreadable');
  });

  it('returns 500 when journal is missing in finalization result', async () => {
    const baseFinalizationResult = mockSession.finalizationResult;
    if (!baseFinalizationResult) {
      throw new Error('Expected finalization result to be available');
    }
    const sessionWithoutJournal: SessionData = {
      ...mockSession,
      finalizationResult: {
        ...baseFinalizationResult,
        journal: undefined,
      } as unknown as NonNullable<SessionData['finalizationResult']>,
    };

    const mockStore: VoteStore = createMockVoteStore({
      getSession: vi.fn().mockResolvedValue(sessionWithoutJournal),
    });
    vi.mocked(getGlobalStore).mockReturnValue(mockStore);

    const request = new NextRequest('http://localhost/api/sth', {
      headers: {
        'X-Session-ID': mockSessionId,
        [SESSION_CAPABILITY_HEADER]: createTestSessionCapabilityToken(mockSessionId),
      },
    });

    const response = await GET(request);
    const payload = await readJsonRecord(response, 'sth response');

    expect(response.status).toBe(500);
    expect(getStringProperty(payload, 'error')).toBe(ErrorCode.CORRUPT_OR_UNREADABLE_FINALIZED_STATE);
    expect(getStringProperty(payload, 'artifactState')).toBe('corrupt_or_unreadable');
  });

  it('fails closed when required journal fields are missing', async () => {
    const baseFinalizationResult = mockSession.finalizationResult;
    if (!baseFinalizationResult) {
      throw new Error('Expected finalization result to be available');
    }
    const partialJournal: ZkVMJournal = {
      ...mockJournal,
      sthDigest: '',
      bulletinRoot: '',
      treeSize: 0,
    };

    const sessionWithPartialJournal: SessionData = {
      ...mockSession,
      finalizationResult: {
        ...baseFinalizationResult,
        journal: partialJournal,
      },
      logId: undefined,
    };

    const mockStore: VoteStore = createMockVoteStore({
      getSession: vi.fn().mockResolvedValue(sessionWithPartialJournal),
    });
    vi.mocked(getGlobalStore).mockReturnValue(mockStore);

    const request = new NextRequest('http://localhost/api/sth', {
      headers: {
        'X-Session-ID': mockSessionId,
        [SESSION_CAPABILITY_HEADER]: createTestSessionCapabilityToken(mockSessionId),
      },
    });

    const response = await GET(request);
    const payload = await readJsonRecord(response, 'sth response');

    expect(response.status).toBe(500);
    expect(getStringProperty(payload, 'error')).toBe(ErrorCode.CORRUPT_OR_UNREADABLE_FINALIZED_STATE);
    expect(getStringProperty(payload, 'artifactState')).toBe('corrupt_or_unreadable');
  });
});
