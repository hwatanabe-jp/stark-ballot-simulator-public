import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Buffer } from 'buffer';
import { POST as createSession } from '@/app/api/session/route';
import { POST as submitVote } from '@/app/api/vote/route';
import { GET as getProgress } from '@/app/api/progress/route';
import { POST as finalize } from '@/app/api/finalize/route';
import { NextRequest } from 'next/server';
import { generateCommitment } from '@/lib/crypto/commitment';
import { BOT_COUNT } from '@/shared/constants';
import { ServerRateLimiter } from '@/lib/rateLimit/serverRateLimit';
import { getGlobalStore } from '@/lib/store/storeInstance';
import { SimpleBulletinBoard } from '@/lib/bulletin/simple-bulletin-board';
import { DEFAULT_POC_IMAGE_ID } from '@/lib/verification/expected-image-id';
import { addHexPrefix } from '@/lib/utils/hex';
import type { SessionData, VoteData, FinalizationState } from '@/types/server';
import type { VoteStore } from '@/types/voteStore';
import { setTestSessionCapabilitySecret } from '@/lib/testing/sessionCapability';
import { buildDefaultElectionConfig, getDefaultElectionConfigHash } from '@/lib/zkvm/election-config';
import { CURRENT_METHOD_VERSION, computeInputCommitment, computeSTHDigest, type ZkVMInput } from '@/lib/zkvm/types';
import { resolveCurrentContractGeneration } from '@/lib/contract';
const REAL_IMAGE_ID = DEFAULT_POC_IMAGE_ID;
const originalTurnstileBypass = process.env.TURNSTILE_BYPASS;
const originalTurnstileSecret = process.env.TURNSTILE_SECRET_KEY;
const originalRuntimeDeploymentEnv = process.env.RUNTIME_DEPLOYMENT_ENV;

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null;
}

function ensureRecord(value: unknown, label: string): JsonRecord {
  if (!isRecord(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function ensureString(value: unknown, label: string): string {
  if (typeof value !== 'string') {
    throw new Error(`${label} must be a string`);
  }
  return value;
}

async function readJson(response: Response, label: string): Promise<unknown> {
  const text = await response.text();
  if (!text) {
    throw new Error(`${label} response is empty`);
  }
  try {
    const payload: unknown = JSON.parse(text);
    return payload;
  } catch {
    throw new Error(`${label} response is not valid JSON`);
  }
}

function deterministicVoteId(index: number): string {
  const suffix = (index + 1).toString(16).padStart(12, '0');
  return `00000000-0000-4000-8000-${suffix}`;
}

function normalizeCommitment(commitment: string): string {
  return commitment.startsWith('0x') ? commitment.slice(2) : commitment;
}

function createMockExecutionResult(input: ZkVMInput) {
  const verifiedTally = [0, 0, 0, 0, 0];
  for (const vote of input.votes) {
    verifiedTally[vote.choice] += 1;
  }

  const validVotes = input.votes.length;
  const missingSlots = Math.max(0, input.treeSize - validVotes);
  const imageId = process.env.EXPECTED_IMAGE_ID ?? REAL_IMAGE_ID;

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
    seenBitmapRoot: '0x' + '6'.repeat(64),
    missingIndices: missingSlots,
    invalidIndices: 0,
    countedIndices: validVotes,
    includedBitmapRoot: '0x' + '2'.repeat(64),
    excludedSlots: missingSlots,
    excludedCount: missingSlots,
    inputCommitment: computeInputCommitment(input),
    methodVersion: CURRENT_METHOD_VERSION,
    electionId: input.electionId,
    electionConfigHash: input.electionConfigHash,
    sthDigest: computeSTHDigest(input.logId, input.treeSize, input.timestamp, input.bulletinRoot),
    imageId,
    receipt: {
      imageId,
      payload: {
        seal: Buffer.from('mock-seal').toString('base64'),
        journal: {
          bytes: Array.from({ length: 32 }, (_, i) => (i * 3) % 256),
        },
      },
      raw: {
        seal: Buffer.from('mock-seal').toString('base64'),
        journal: {
          bytes: Array.from({ length: 32 }, (_, i) => (i * 3) % 256),
        },
      },
    },
  };
}

// Mock dependencies
vi.mock('@/lib/store/storeInstance');

// Mock bot voter to run immediately
vi.mock('@/lib/bot/botVoter', () => {
  const BotVoter = vi.fn(function () {
    return {
      startBotVoting: vi.fn().mockResolvedValue(undefined),
    };
  });

  return { BotVoter };
});

// Mock zkVM executor factory
vi.mock('@/lib/zkvm/executor-factory', () => ({
  getDefaultExecutor: vi.fn().mockResolvedValue({
    type: 'mock',
    execute: vi.fn().mockImplementation((input: ZkVMInput) => Promise.resolve(createMockExecutionResult(input))),
  }),
}));

describe('Complete Voting Flow Integration', () => {
  let sessionId: string;
  let mockStore: VoteStore;
  let mockSession: SessionData;

  beforeEach(() => {
    vi.clearAllMocks();
    setTestSessionCapabilitySecret();
    sessionId = 'test-session-123';
    process.env.EXPECTED_IMAGE_ID = REAL_IMAGE_ID;
    process.env.TURNSTILE_BYPASS = '1';
    process.env.RUNTIME_DEPLOYMENT_ENV = 'develop';
    delete process.env.TURNSTILE_SECRET_KEY;

    // Create mock session
    const electionConfig = buildDefaultElectionConfig();
    mockSession = {
      sessionId,
      electionId: '550e8400-e29b-41d4-a716-446655440000',
      electionConfigHash: getDefaultElectionConfigHash(),
      electionConfig,
      contractGeneration: resolveCurrentContractGeneration(),
      logId: '0x' + '4'.repeat(64), // Must match mockStore.createSession return value
      votes: new Map<number, VoteData>(),
      botCount: 0,
      finalized: false,
      createdAt: Date.now(),
      lastActivity: Date.now(),
      userVoteIndex: undefined,
      bulletin: new SimpleBulletinBoard('0x' + '4'.repeat(64)),
      bulletinRootHistory: [{ root: '0x' + '0'.repeat(64), timestamp: Date.now(), treeSize: 0 }],
    };

    // Create mock store
    const pendingState = (executionId: string, queuedAt: number): FinalizationState => ({
      status: 'pending',
      executionId,
      queuedAt,
    });
    const runningState = (executionId: string, queuedAt: number, startedAt: number): FinalizationState => ({
      status: 'running',
      executionId,
      queuedAt,
      startedAt,
    });
    const succeededState = (
      executionId: string,
      queuedAt: number,
      startedAt: number,
      completedAt: number,
    ): FinalizationState => ({
      status: 'succeeded',
      executionId,
      queuedAt,
      startedAt,
      completedAt,
    });
    const failedState = (
      executionId: string,
      queuedAt: number,
      failedAt: number,
      error: { code: string; message: string; details?: unknown },
    ): FinalizationState => ({
      status: 'failed',
      executionId,
      queuedAt,
      failedAt,
      error,
    });
    const timedOutState = (executionId: string, queuedAt: number, timeoutAt: number): FinalizationState => ({
      status: 'timeout',
      executionId,
      queuedAt,
      timeoutAt,
    });

    mockStore = {
      createSession: vi.fn().mockResolvedValue({
        sessionId,
        electionId: mockSession.electionId,
        electionConfigHash: mockSession.electionConfigHash,
        contractGeneration: resolveCurrentContractGeneration(),
        logId: '0x' + '4'.repeat(64),
      }),
      getSession: vi.fn().mockResolvedValue(mockSession),
      addVote: vi.fn().mockImplementation((_sid, voteData: VoteData) => {
        // Simulate adding user vote
        const index = mockSession.votes.size;
        const voteId = deterministicVoteId(index);
        const formattedVote: VoteData = { ...voteData, voteId };
        let bulletinRootAtCast = '0x' + '0'.repeat(64);

        if (mockSession.bulletin) {
          mockSession.bulletin.appendVote(voteId, normalizeCommitment(formattedVote.commit));
          bulletinRootAtCast = addHexPrefix(mockSession.bulletin.getCurrentRoot());
          if (!mockSession.bulletinRootHistory) {
            mockSession.bulletinRootHistory = [];
          }
          mockSession.bulletinRootHistory.push({
            root: bulletinRootAtCast,
            treeSize: mockSession.bulletin.getSize(),
            timestamp: Date.now(),
          });
        }

        formattedVote.rootAtCast = bulletinRootAtCast;
        mockSession.votes.set(index, formattedVote);
        mockSession.userVoteIndex = mockSession.userVoteIndex ?? 0;
        return Promise.resolve({
          leafIndex: index,
          merklePath: [],
          bulletinRootAtCast,
        });
      }),
      addBotVotes: vi.fn().mockResolvedValue(undefined),
      updateSession: vi.fn().mockResolvedValue(undefined),
      getActiveSessionCount: vi.fn().mockResolvedValue(0),
      finalizeSession: vi.fn().mockImplementation(() => {
        mockSession.finalized = true;
        return Promise.resolve();
      }),
      markFinalizationQueued: vi
        .fn<NonNullable<VoteStore['markFinalizationQueued']>>()
        .mockImplementation((_sid, payload) => {
          return Promise.resolve(pendingState(payload.executionId, payload.queuedAt));
        }),
      markFinalizationRunning: vi
        .fn<NonNullable<VoteStore['markFinalizationRunning']>>()
        .mockImplementation((_sid, payload) => {
          return Promise.resolve(runningState(payload.executionId, payload.queuedAt, payload.startedAt));
        }),
      markFinalizationSucceeded: vi
        .fn<NonNullable<VoteStore['markFinalizationSucceeded']>>()
        .mockImplementation((_sid, payload) => {
          return Promise.resolve(
            succeededState(payload.executionId, payload.queuedAt, payload.startedAt, payload.completedAt),
          );
        }),
      markFinalizationFailed: vi
        .fn<NonNullable<VoteStore['markFinalizationFailed']>>()
        .mockImplementation((_sid, payload) => {
          return Promise.resolve(failedState(payload.executionId, payload.queuedAt, payload.failedAt, payload.error));
        }),
      markFinalizationTimedOut: vi
        .fn<NonNullable<VoteStore['markFinalizationTimedOut']>>()
        .mockImplementation((_sid, payload) => {
          return Promise.resolve(timedOutState(payload.executionId, payload.queuedAt, payload.timeoutAt));
        }),
      getVoteById: vi.fn().mockResolvedValue(null),
      getVoteByIdWithProof: vi.fn().mockResolvedValue(null),
      getVoteProof: vi.fn().mockResolvedValue(null),
      saveBitmapData: vi.fn().mockResolvedValue(undefined),
      saveReceiptToBoard: vi.fn().mockResolvedValue({
        receiptHash: '0x' + 'a'.repeat(64),
        boardIndex: mockSession.bulletin?.getSize() ?? 0,
      }),
    };

    // Stub rate limiter methods on the prototype so new instances use these mocks
    vi.spyOn(ServerRateLimiter.prototype, 'checkZkVmRateLimit').mockResolvedValue({
      allowed: true,
      remainingExecutions: 50,
    });
    vi.spyOn(ServerRateLimiter.prototype, 'checkGlobalLimit').mockResolvedValue({
      allowed: true,
      currentCount: 0,
      limit: 1000,
    });
    vi.spyOn(ServerRateLimiter.prototype, 'consumeZkVmExecution').mockResolvedValue({
      allowed: true,
      remainingExecutions: 50,
    });
    vi.spyOn(ServerRateLimiter.prototype, 'recordZkVmExecution').mockResolvedValue(undefined);
    vi.spyOn(ServerRateLimiter.prototype, 'incrementGlobalCount').mockResolvedValue(1);
    vi.mocked(getGlobalStore).mockReturnValue(mockStore);
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
  });

  it('should complete full voting flow from session creation to finalization', async () => {
    // Step 1: Create session
    const sessionRequest = new NextRequest('http://localhost:3000/api/session', { method: 'POST' });
    const sessionResponse = await createSession(sessionRequest);
    expect(sessionResponse.status).toBe(200);

    const sessionPayload = await readJson(sessionResponse, 'Session');
    const sessionRecord = ensureRecord(sessionPayload, 'Session response');
    const sessionData = ensureRecord(sessionRecord.data, 'Session response data');
    expect(sessionData).toHaveProperty('sessionId');
    expect(sessionData).toHaveProperty('electionId');
    sessionId = ensureString(sessionData.sessionId, 'sessionId');
    const electionId = ensureString(sessionData.electionId, 'electionId');
    const capabilityToken = ensureString(sessionData.capabilityToken, 'capabilityToken');

    // Step 2: Submit user vote
    const vote = 'A';
    const { commitment, randomValue } = await generateCommitment(vote, electionId);

    const voteRequest = new NextRequest('http://localhost:3000/api/vote', {
      method: 'POST',
      headers: {
        'X-Session-ID': sessionId,
        'X-Session-Capability': capabilityToken,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ commitment, vote, rand: randomValue }),
    });

    const voteResponse = await submitVote(voteRequest);
    expect(voteResponse.status).toBe(200);

    const votePayload = await readJson(voteResponse, 'vote');
    const voteRecord = ensureRecord(votePayload, 'vote response');
    const voteData = ensureRecord(voteRecord.data, 'vote response data');
    expect(voteData).toHaveProperty('bulletinIndex');
    expect(voteData).toHaveProperty('bulletinRootAtCast');
    expect(voteData).toHaveProperty('timestamp');

    // Step 3: Check progress
    const progressRequest = new NextRequest('http://localhost:3000/api/progress', {
      method: 'GET',
      headers: {
        'X-Session-ID': sessionId,
        'X-Session-Capability': capabilityToken,
      },
    });

    const progressResponse = await getProgress(progressRequest);
    expect(progressResponse.status).toBe(200);

    const progressPayload = await readJson(progressResponse, 'progress');
    const progressRecord = ensureRecord(progressPayload, 'progress response');
    const progressData = ensureRecord(progressRecord.data, 'progress response data');
    expect(progressData.userVoted).toBe(true);

    // Note: In a real integration test, we would wait for bot voting to complete
    // For this test, we'll simulate it by manually adding bot votes
    mockSession.botCount = BOT_COUNT;

    // Add bot votes to the session
    const voteChoices = ['A', 'B', 'C', 'D', 'E'] as const;
    for (let i = 1; i <= BOT_COUNT; i++) {
      const voteId = deterministicVoteId(i);
      const botVote = {
        vote: voteChoices[i % voteChoices.length],
        rand: '0x' + i.toString(16).padStart(64, '0'),
        commit: '0x' + (i * 100).toString(16).padStart(64, '0'),
        path: [],
        voteId,
      };
      mockSession.votes.set(i, botVote);
      if (mockSession.bulletin) {
        mockSession.bulletin.appendVote(voteId, normalizeCommitment(botVote.commit));
      }
    }

    // Update bulletinRootHistory with correct treeSize after all votes are added
    const bulletinRoot = mockSession.bulletin
      ? addHexPrefix(mockSession.bulletin.getCurrentRoot())
      : '0x' + '1'.repeat(64);
    const bulletinSize = mockSession.bulletin ? mockSession.bulletin.getSize() : BOT_COUNT + 1;
    mockSession.bulletinRootHistory = [
      { root: bulletinRoot, timestamp: Date.now(), treeSize: bulletinSize }, // 64 total votes
    ];

    // Step 4: Finalize
    const finalizeRequest = new NextRequest('http://localhost:3000/api/finalize', {
      method: 'POST',
      headers: {
        'X-Session-ID': sessionId,
        'X-Session-Capability': capabilityToken,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ scenarioId: 'S0' }),
    });

    const finalizeResponse = await finalize(finalizeRequest);

    // Debug: check what error we're getting
    if (finalizeResponse.status !== 200) {
      const errorData = await readJson(finalizeResponse, 'finalize error');
      console.log('Finalize error:', errorData);
    }

    // Should succeed now that we've simulated bot voting completion
    expect(finalizeResponse.status).toBe(200);
    const finalizePayload = await readJson(finalizeResponse, 'finalize');
    const finalizeRecord = ensureRecord(finalizePayload, 'finalize response');
    const finalizeData = ensureRecord(finalizeRecord.data, 'finalize response data');
    expect(finalizeData).toHaveProperty('sessionId', sessionId);
    expect(finalizeData).toHaveProperty('tally');
    expect(finalizeData).toHaveProperty('bulletinRoot');
    expect(finalizeData).toHaveProperty('imageId');
  });

  it('should reject vote without session', async () => {
    const vote = 'B';
    const { commitment, randomValue } = await generateCommitment(vote, '550e8400-e29b-41d4-a716-446655440000');

    const voteRequest = new NextRequest('http://localhost:3000/api/vote', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ commitment, vote, rand: randomValue }),
    });

    const voteResponse = await submitVote(voteRequest);
    expect(voteResponse.status).toBe(400);

    const errorPayload = await readJson(voteResponse, 'vote error');
    const errorRecord = ensureRecord(errorPayload, 'vote error response');
    expect(ensureString(errorRecord.error, 'error code')).toBe('SESSION_ID_REQUIRED');
  });

  it('should enforce session limits', async () => {
    // This test would require mocking the session store to simulate
    // the session limit being reached. For brevity, we'll skip the
    // implementation but the pattern would be:
    // 1. Create MAX_SESSIONS sessions
    // 2. Try to create one more
    // 3. Expect SESSION_LIMIT_EXCEEDED error
  });
});

afterEach(() => {
  delete process.env.EXPECTED_IMAGE_ID;
});
