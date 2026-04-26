import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Buffer } from 'buffer';
import { NextRequest } from 'next/server';
import { POST } from './route';
import { DEFAULT_POC_IMAGE_ID } from './routeConstants';
import { getGlobalStore } from '@/lib/store/storeInstance';
import type { SessionData, VoteData } from '@/types/server';
import { computeCommitment, computeInputCommitment, computeSTHDigest } from '@/lib/zkvm/types';
import { SimpleBulletinBoard } from '@/lib/bulletin/simple-bulletin-board';
import { addHexPrefix } from '@/lib/utils/hex';
import { createMockVoteStore } from '@/lib/testing/mockVoteStore';
import { readJsonRecord, requireDataRecord } from '@/lib/testing/response-helpers';
import { getNumberProperty, getRecordProperty, getStringProperty } from '@/lib/utils/guards';
import type { VoteStore } from '@/types/voteStore';
import type { ZkVMExecutor } from '@/lib/zkvm/executor-factory';
import type { ZkVMInput } from '@/lib/zkvm/types';
import type { ZkVMExecutionResult } from '@/lib/zkvm/executor';
import { buildDefaultElectionConfig, getDefaultElectionConfigHash } from '@/lib/zkvm/election-config';
import { SESSION_CAPABILITY_HEADER } from '@/lib/session/capability';
import { createTestSessionCapabilityToken, setTestSessionCapabilitySecret } from '@/lib/testing/sessionCapability';
import { CURRENT_METHOD_VERSION } from '@/lib/zkvm/types';
import { resolveCurrentContractGeneration, UnsupportedCurrentArtifactBoundaryError } from '@/lib/contract';

// Mock dependencies
vi.mock('@/lib/store/storeInstance');
vi.mock('@/lib/zkvm/executor-factory');

function createVoteData(overrides: Partial<VoteData> = {}): VoteData {
  return {
    vote: 'A',
    commit: '0x' + 'a'.repeat(64),
    rand: '0x' + '1'.repeat(64),
    path: [],
    ...overrides,
  };
}

function createBaseSession(overrides: Partial<SessionData> = {}): SessionData {
  const now = Date.now();
  const electionConfig = buildDefaultElectionConfig();
  return {
    sessionId: 'session-base',
    contractGeneration: resolveCurrentContractGeneration(),
    electionConfigHash: getDefaultElectionConfigHash(),
    electionConfig,
    votes: new Map(),
    botCount: 0,
    finalized: false,
    createdAt: now,
    lastActivity: now,
    ...overrides,
  };
}

describe('POST /api/finalize current contract', () => {
  let mockStore: VoteStore;
  let getSessionMock: ReturnType<typeof vi.fn<NonNullable<VoteStore['getSession']>>>;
  let updateSessionMock: ReturnType<typeof vi.fn<NonNullable<VoteStore['updateSession']>>>;
  let finalizeSessionMock: ReturnType<typeof vi.fn<NonNullable<VoteStore['finalizeSession']>>>;
  let saveBitmapDataMock: ReturnType<typeof vi.fn<NonNullable<VoteStore['saveBitmapData']>>>;
  let saveReceiptToBoardMock: ReturnType<typeof vi.fn<NonNullable<VoteStore['saveReceiptToBoard']>>>;
  let mockExecutor: ZkVMExecutor;
  let executeMock: ReturnType<typeof vi.fn<ZkVMExecutor['execute']>>;
  let originalTurnstileBypass: string | undefined;
  let originalTurnstileSecret: string | undefined;
  let originalRuntimeDeploymentEnv: string | undefined;
  let originalSessionCapabilitySecret: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    originalTurnstileBypass = process.env.TURNSTILE_BYPASS;
    originalTurnstileSecret = process.env.TURNSTILE_SECRET_KEY;
    originalRuntimeDeploymentEnv = process.env.RUNTIME_DEPLOYMENT_ENV;
    originalSessionCapabilitySecret = process.env.SESSION_CAPABILITY_SECRET;

    // Setup mock store with new methods
    getSessionMock = vi.fn<NonNullable<VoteStore['getSession']>>();
    updateSessionMock = vi.fn<NonNullable<VoteStore['updateSession']>>().mockResolvedValue(undefined);
    finalizeSessionMock = vi.fn<NonNullable<VoteStore['finalizeSession']>>().mockResolvedValue(undefined);
    saveBitmapDataMock = vi.fn<NonNullable<VoteStore['saveBitmapData']>>().mockResolvedValue(undefined);
    saveReceiptToBoardMock = vi.fn<NonNullable<VoteStore['saveReceiptToBoard']>>().mockResolvedValue({
      receiptHash: '0x' + 'f'.repeat(64),
      boardIndex: 100,
    });
    mockStore = createMockVoteStore({
      getSession: getSessionMock,
      updateSession: updateSessionMock,
      finalizeSession: finalizeSessionMock,
      saveBitmapData: saveBitmapDataMock,
      saveReceiptToBoard: saveReceiptToBoardMock,
    });

    vi.mocked(getGlobalStore).mockReturnValue(mockStore);

    // Setup mock zkVM executor
    executeMock = vi.fn<ZkVMExecutor['execute']>();
    mockExecutor = {
      type: 'mock',
      version: '1.0',
      execute: executeMock,
    };

    // Set test environment
    process.env.USE_MOCK_STORE = 'true';
    process.env.USE_MOCK_ZKVM = 'true';
    process.env.EXPECTED_IMAGE_ID = DEFAULT_POC_IMAGE_ID;
    process.env.TURNSTILE_BYPASS = '1';
    process.env.RUNTIME_DEPLOYMENT_ENV = 'develop';
    setTestSessionCapabilitySecret();
    delete process.env.TURNSTILE_SECRET_KEY;
  });

  afterEach(() => {
    if (originalTurnstileBypass === undefined) {
      delete process.env.TURNSTILE_BYPASS;
    } else {
      process.env.TURNSTILE_BYPASS = originalTurnstileBypass;
    }

    if (originalTurnstileSecret === undefined) {
      delete process.env.TURNSTILE_SECRET_KEY;
    } else {
      process.env.TURNSTILE_SECRET_KEY = originalTurnstileSecret;
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

  describe('zkVM Input Structure', () => {
    it('should use electionId from session', async () => {
      // Arrange
      const mockSessionId = 'test-session-contract';
      const mockElectionId = '550e8400-e29b-41d4-a716-446655440000';
      const mockSession = createMockSession(mockSessionId, mockElectionId);

      getSessionMock.mockResolvedValue(mockSession);

      // Mock executor to capture input
      const capturedInputs: ZkVMInput[] = [];
      executeMock.mockImplementation((input: ZkVMInput) => {
        capturedInputs.push(input);
        return Promise.resolve(createMockZkVMOutput(input));
      });

      const { getDefaultExecutor } = await import('@/lib/zkvm/executor-factory');
      vi.mocked(getDefaultExecutor).mockResolvedValue(mockExecutor);

      const request = createRequest(mockSessionId);

      // Act
      const response = await POST(request);

      // Assert
      expect(response.status).toBe(200);
      expect(capturedInputs).toHaveLength(1);
      expect(capturedInputs[0].electionId).toBe(mockElectionId);
    });

    it('should compute commitments with domain separation', async () => {
      // Arrange
      const mockSessionId = 'test-session-contract';
      const mockElectionId = '550e8400-e29b-41d4-a716-446655440000';
      const mockSession = createMockSession(mockSessionId, mockElectionId);

      getSessionMock.mockResolvedValue(mockSession);

      const capturedInputs: ZkVMInput[] = [];
      executeMock.mockImplementation((input: ZkVMInput) => {
        capturedInputs.push(input);
        return Promise.resolve(createMockZkVMOutput(input));
      });

      const { getDefaultExecutor } = await import('@/lib/zkvm/executor-factory');
      vi.mocked(getDefaultExecutor).mockResolvedValue(mockExecutor);

      const request = createRequest(mockSessionId);

      // Act
      await POST(request);

      // Assert
      const firstVote = mockSession.votes.get(0);
      if (!firstVote) {
        throw new Error('Expected user vote at index 0');
      }
      const expectedCommitment = computeCommitment(
        mockElectionId,
        0, // choice A
        firstVote.rand,
      );

      // Verify that commitments are computed with domain separation
      expect(capturedInputs).toHaveLength(1);
      expect(capturedInputs[0].votes[0].commitment).toBe(expectedCommitment);
    });

    it('should sort votes by index before computing inputCommitment', async () => {
      // Arrange
      const mockSessionId = 'test-session-contract';
      const mockElectionId = '550e8400-e29b-41d4-a716-446655440000';
      const mockSession = createMockSession(mockSessionId, mockElectionId);

      // Add votes in non-sorted order
      mockSession.votes.clear();
      mockSession.votes.set(2, {
        vote: 'C',
        commit: '0xc',
        rand: '0x3',
        path: [],
      });
      mockSession.votes.set(0, {
        vote: 'A',
        commit: '0xa',
        rand: '0x1',
        path: [],
      });
      mockSession.votes.set(1, {
        vote: 'B',
        commit: '0xb',
        rand: '0x2',
        path: [],
      });

      getSessionMock.mockResolvedValue(mockSession);

      const capturedInputs: ZkVMInput[] = [];
      executeMock.mockImplementation((input: ZkVMInput) => {
        capturedInputs.push(input);
        return Promise.resolve(createMockZkVMOutput(input));
      });

      const { getDefaultExecutor } = await import('@/lib/zkvm/executor-factory');
      vi.mocked(getDefaultExecutor).mockResolvedValue(mockExecutor);

      const request = createRequest(mockSessionId);

      // Act
      await POST(request);

      // Assert
      // Verify votes are sorted by index (0, 1, 2)
      expect(capturedInputs).toHaveLength(1);
      expect(capturedInputs[0].votes[0].index).toBe(0);
      expect(capturedInputs[0].votes[1].index).toBe(1);
      expect(capturedInputs[0].votes[2].index).toBe(2);
    });
  });

  describe('Receipt Atomicity', () => {
    it('should save receipt to bulletin board before returning', async () => {
      // Arrange
      const mockSessionId = 'test-session-contract';
      const mockElectionId = '550e8400-e29b-41d4-a716-446655440000';
      const mockSession = createMockSession(mockSessionId, mockElectionId);

      getSessionMock.mockResolvedValue(mockSession);
      saveReceiptToBoardMock.mockResolvedValue({
        receiptHash: '0x' + 'f'.repeat(64),
        boardIndex: 100,
      });

      executeMock.mockImplementation((input: ZkVMInput) => Promise.resolve(createMockZkVMOutput(input)));

      const { getDefaultExecutor } = await import('@/lib/zkvm/executor-factory');
      vi.mocked(getDefaultExecutor).mockResolvedValue(mockExecutor);

      const request = createRequest(mockSessionId);

      // Act
      const response = await POST(request);
      const payload = await readJsonRecord(response, 'finalize contract response');
      const data = requireDataRecord(payload);

      // Assert
      expect(saveReceiptToBoardMock).toHaveBeenCalledTimes(1);
      const saveCall = saveReceiptToBoardMock.mock.calls[0];
      expect(saveCall[0]).toBe(mockSessionId);
      const savePayload = saveCall[1];
      expect(getStringProperty(savePayload, 'receipt')).toBeTypeOf('string');
      expect(getNumberProperty(savePayload, 'timestamp')).toBeTypeOf('number');
      const receiptPublication = getRecordProperty(data, 'receiptPublication');
      expect(receiptPublication).toEqual(
        expect.objectContaining({
          receiptHash: '0x' + 'f'.repeat(64),
          boardIndex: 100,
        }),
      );
    });

    it('should fail if receipt cannot be saved to board', async () => {
      // Arrange
      const mockSessionId = 'test-session-contract';
      const mockElectionId = '550e8400-e29b-41d4-a716-446655440000';
      const mockSession = createMockSession(mockSessionId, mockElectionId);

      getSessionMock.mockResolvedValue(mockSession);
      saveReceiptToBoardMock.mockRejectedValue(new Error('Board save failed'));

      executeMock.mockImplementation((input: ZkVMInput) => Promise.resolve(createMockZkVMOutput(input)));

      const { getDefaultExecutor } = await import('@/lib/zkvm/executor-factory');
      vi.mocked(getDefaultExecutor).mockResolvedValue(mockExecutor);

      const request = createRequest(mockSessionId);

      // Act
      const response = await POST(request);
      const payload = await readJsonRecord(response, 'finalize contract response');

      // Assert
      expect(response.status).toBe(500);
      expect(getStringProperty(payload, 'error')).toBeDefined();
      expect(finalizeSessionMock).not.toHaveBeenCalled();
    });

    it('fails closed when the store rejects sync finalize at the current-contract boundary', async () => {
      const mockSessionId = 'test-session-contract';
      const mockElectionId = '550e8400-e29b-41d4-a716-446655440000';
      const mockSession = createMockSession(mockSessionId, mockElectionId);

      getSessionMock.mockResolvedValue(mockSession);
      executeMock.mockImplementation((input: ZkVMInput) => Promise.resolve(createMockZkVMOutput(input)));
      finalizeSessionMock.mockRejectedValue(
        new UnsupportedCurrentArtifactBoundaryError({
          runtimeContractGeneration: resolveCurrentContractGeneration(),
          persistedContractGeneration: resolveCurrentContractGeneration(),
          carriedContractGeneration: 'stale-contract-generation',
        }),
      );

      const { getDefaultExecutor } = await import('@/lib/zkvm/executor-factory');
      vi.mocked(getDefaultExecutor).mockResolvedValue(mockExecutor);

      const request = createRequest(mockSessionId);

      const response = await POST(request);
      const payload = await readJsonRecord(response, 'finalize contract boundary response');

      expect(response.status).toBe(500);
      expect(getStringProperty(payload, 'error')).toBe('UNSUPPORTED_CURRENT_ARTIFACT');
      expect(getStringProperty(payload, 'artifactState')).toBe('unsupported_current_artifact');
    });
  });

  describe('claimedTally Removal', () => {
    it('should not use claimedTally in any response', async () => {
      // Arrange
      const mockSessionId = 'test-session-contract';
      const mockElectionId = '550e8400-e29b-41d4-a716-446655440000';
      const mockSession = createMockSession(mockSessionId, mockElectionId);

      getSessionMock.mockResolvedValue(mockSession);
      executeMock.mockImplementation((input: ZkVMInput) => Promise.resolve(createMockZkVMOutput(input)));

      const { getDefaultExecutor } = await import('@/lib/zkvm/executor-factory');
      vi.mocked(getDefaultExecutor).mockResolvedValue(mockExecutor);

      const request = createRequest(mockSessionId);

      // Act
      const response = await POST(request);
      const payload = await readJsonRecord(response, 'finalize contract response');

      // Assert
      expect(payload).not.toHaveProperty('claimedTally');
      const data = getRecordProperty(payload, 'data');
      const debug = getRecordProperty(data, 'debug');
      if (debug) {
        expect(debug).not.toHaveProperty('claimedTally');
      }
    });

    it('should not pass claimedTally to zkVM executor', async () => {
      // Arrange
      const mockSessionId = 'test-session-contract';
      const mockElectionId = '550e8400-e29b-41d4-a716-446655440000';
      const mockSession = createMockSession(mockSessionId, mockElectionId);

      getSessionMock.mockResolvedValue(mockSession);

      const capturedInputs: ZkVMInput[] = [];
      executeMock.mockImplementation((input: ZkVMInput) => {
        capturedInputs.push(input);
        return Promise.resolve(createMockZkVMOutput(input));
      });

      const { getDefaultExecutor } = await import('@/lib/zkvm/executor-factory');
      vi.mocked(getDefaultExecutor).mockResolvedValue(mockExecutor);

      const request = createRequest(mockSessionId, { scenarioId: 'S1' });

      // Act
      await POST(request);

      // Assert
      expect(capturedInputs).toHaveLength(1);
      expect(capturedInputs[0]).not.toHaveProperty('claimedTally');
      expect(capturedInputs[0]).not.toHaveProperty('tamperDetected');
    });
  });

  describe('STH Binding', () => {
    it('should compute and include STH digest', async () => {
      // Arrange
      const mockSessionId = 'test-session-contract';
      const mockElectionId = '550e8400-e29b-41d4-a716-446655440000';
      const mockSession = createMockSession(mockSessionId, mockElectionId);

      getSessionMock.mockResolvedValue(mockSession);
      const capturedInputs: ZkVMInput[] = [];
      executeMock.mockImplementation((input: ZkVMInput) => {
        capturedInputs.push(input);
        return Promise.resolve(createMockZkVMOutput(input));
      });

      const { getDefaultExecutor } = await import('@/lib/zkvm/executor-factory');
      vi.mocked(getDefaultExecutor).mockResolvedValue(mockExecutor);

      const request = createRequest(mockSessionId);

      // Act
      const response = await POST(request);
      const payload = await readJsonRecord(response, 'finalize contract response');
      const data = getRecordProperty(payload, 'data');

      // Assert
      expect(capturedInputs).toHaveLength(1);
      const expectedSTHDigest = computeSTHDigest(
        capturedInputs[0].logId,
        capturedInputs[0].treeSize,
        capturedInputs[0].timestamp,
        capturedInputs[0].bulletinRoot,
      );
      expect(response.status).toBe(200);
      expect(getStringProperty(data, 'sthDigest')).toBe(expectedSTHDigest);
    });
  });
});

// Helper functions
function createMockSession(sessionId: string, electionId: string): SessionData {
  const votes = new Map<number, VoteData>([
    [
      0,
      createVoteData({
        voteId: '00000000-0000-4000-8000-000000000001',
        vote: 'A',
        commit: '0x' + 'a'.repeat(64),
        rand: '0x' + '1'.repeat(64),
        path: [],
      }),
    ],
    [
      1,
      createVoteData({
        voteId: '00000000-0000-4000-8000-000000000002',
        vote: 'B',
        commit: '0x' + 'b'.repeat(64),
        rand: '0x' + '2'.repeat(64),
        path: [],
      }),
    ],
    [
      2,
      createVoteData({
        voteId: '00000000-0000-4000-8000-000000000003',
        vote: 'C',
        commit: '0x' + 'c'.repeat(64),
        rand: '0x' + '3'.repeat(64),
        path: [],
      }),
    ],
  ]);

  const bulletin = new SimpleBulletinBoard('0x' + '0'.repeat(64));
  for (const vote of votes.values()) {
    if (!vote.voteId) {
      throw new Error('Missing voteId in test setup');
    }
    const appendResult = bulletin.appendVote(vote.voteId, vote.commit.replace(/^0x/, ''));
    vote.rootAtCast = addHexPrefix(appendResult.rootAtAppend);
  }

  return createBaseSession({
    sessionId,
    electionId,
    logId: '0x' + '0'.repeat(64),
    votes,
    userVoteIndex: 0,
    botCount: 63,
    finalized: false,
    bulletin,
    bulletinRootHistory: [
      {
        root: addHexPrefix(bulletin.getCurrentRoot()),
        timestamp: Date.now(),
        treeSize: bulletin.getSize(),
      },
    ],
  });
}

function createRequest(sessionId: string, body: Record<string, unknown> = {}): NextRequest {
  const payload = { scenarioId: 'S0', ...body };
  return new NextRequest('http://localhost:3000/api/finalize', {
    method: 'POST',
    headers: {
      'X-Session-ID': sessionId,
      [SESSION_CAPABILITY_HEADER]: createTestSessionCapabilityToken(sessionId),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
}

function createMockZkVMOutput(input: ZkVMInput, overrides: Partial<ZkVMExecutionResult> = {}): ZkVMExecutionResult {
  const verifiedTally = [0, 0, 0, 0, 0];
  for (const vote of input.votes) {
    verifiedTally[vote.choice] += 1;
  }

  const validVotes = input.votes.length;
  const missingSlots = Math.max(0, input.treeSize - validVotes);
  const baseReceipt = {
    imageId: DEFAULT_POC_IMAGE_ID,
    payload: {
      seal: Buffer.from('mock-seal').toString('base64'),
      journal: {
        bytes: Array.from({ length: 32 }, (_, i) => (i * 5) % 256),
      },
    },
    raw: {
      seal: Buffer.from('mock-seal').toString('base64'),
      journal: {
        bytes: Array.from({ length: 32 }, (_, i) => (i * 5) % 256),
      },
    },
  };

  return {
    verifiedTally,
    bulletinRoot: input.bulletinRoot,
    treeSize: input.treeSize,
    totalExpected: input.totalExpected,
    totalVotes: validVotes,
    validVotes,
    invalidVotes: 0,
    seenIndicesCount: validVotes,
    missingSlots,
    invalidPresentedSlots: 0,
    rejectedRecords: 0,
    seenBitmapRoot: '0x' + '4'.repeat(64),
    includedBitmapRoot: '0x' + '2'.repeat(64),
    excludedSlots: missingSlots,
    inputCommitment: computeInputCommitment(input),
    methodVersion: CURRENT_METHOD_VERSION,
    electionId: input.electionId,
    electionConfigHash: input.electionConfigHash,
    sthDigest: computeSTHDigest(input.logId, input.treeSize, input.timestamp, input.bulletinRoot),
    imageId: DEFAULT_POC_IMAGE_ID,
    receipt: baseReceipt,
    ...overrides,
  };
}
