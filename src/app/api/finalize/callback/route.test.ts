import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createHmac } from 'crypto';
import { NextRequest } from 'next/server';
import { POST } from './route';
import { getGlobalStore } from '@/lib/store/storeInstance';
import { createMockVoteStore } from '@/lib/testing/mockVoteStore';
import { createTestPublicInputArtifact } from '@/lib/testing/public-input-artifact';
import { createTestJournal } from '@/lib/testing/test-helpers';
import { UnsupportedCurrentArtifactBoundaryError } from '@/lib/contract';
import type { VoteStore } from '@/types/voteStore';

vi.mock('@/lib/store/storeInstance');

describe('POST /api/finalize/callback', () => {
  const secret = 'super-secret-token';
  const unresolvedAmplifySecret = '<value will be resolved during runtime>';
  let originalSecret: string | undefined;
  let originalMaxSkew: string | undefined;
  let originalBodyLimit: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    originalSecret = process.env.FINALIZE_CALLBACK_SECRET;
    originalMaxSkew = process.env.FINALIZE_CALLBACK_MAX_SKEW_MS;
    originalBodyLimit = process.env.FINALIZE_CALLBACK_BODY_LIMIT_BYTES;
    process.env.FINALIZE_CALLBACK_SECRET = secret;
    delete process.env.FINALIZE_CALLBACK_MAX_SKEW_MS;
    delete process.env.FINALIZE_CALLBACK_BODY_LIMIT_BYTES;
  });

  afterEach(() => {
    if (originalSecret === undefined) {
      delete process.env.FINALIZE_CALLBACK_SECRET;
    } else {
      process.env.FINALIZE_CALLBACK_SECRET = originalSecret;
    }

    if (originalMaxSkew === undefined) {
      delete process.env.FINALIZE_CALLBACK_MAX_SKEW_MS;
    } else {
      process.env.FINALIZE_CALLBACK_MAX_SKEW_MS = originalMaxSkew;
    }

    if (originalBodyLimit === undefined) {
      delete process.env.FINALIZE_CALLBACK_BODY_LIMIT_BYTES;
    } else {
      process.env.FINALIZE_CALLBACK_BODY_LIMIT_BYTES = originalBodyLimit;
    }
  });

  it('updates session state on success callback when signature is valid', async () => {
    const markFinalizationSucceeded = vi.fn<NonNullable<VoteStore['markFinalizationSucceeded']>>().mockResolvedValue({
      status: 'succeeded' as const,
      executionId: '01HVN5WA1CEH94868G90QGJ7HX',
      queuedAt: 1730000000000,
      startedAt: 1730000001000,
      completedAt: 1730000005000,
    });
    const finalizeSession = vi.fn().mockResolvedValue(undefined);
    const journal = createTestJournal({
      totalExpected: 64,
      validVotes: 61,
      missingIndices: 1,
      invalidIndices: 2,
    });
    const store = createMockVoteStore({
      getSession: vi.fn().mockResolvedValue({
        sessionId: '2d8a4d02-1a56-4e8a-98f1-e8eb7a482a4b',
        votes: new Map(),
        botCount: 63,
        finalized: false,
        createdAt: 0,
        lastActivity: 0,
      }),
      markFinalizationSucceeded,
      finalizeSession,
    });
    vi.mocked(getGlobalStore).mockReturnValue(store);

    const payload = {
      sessionId: '2d8a4d02-1a56-4e8a-98f1-e8eb7a482a4b',
      executionId: '01HVN5WA1CEH94868G90QGJ7HX',
      contractGeneration: '2026-04-zkvm-current-v1',
      status: 'SUCCEEDED',
      queuedAt: 1730000000000,
      startedAt: 1730000001000,
      completedAt: 1730000005000,
      finalizationResult: {
        tally: {
          counts: { A: 32, B: 32, C: 0, D: 0, E: 0 },
          totalVotes: 64,
          tamperedCount: 0,
        },
        imageId: '0x' + '2'.repeat(64),
        publicInputArtifact: createTestPublicInputArtifact({
          typedAuthority: {
            electionId: journal.electionId,
            electionConfigHash: journal.electionConfigHash,
            methodVersion: journal.methodVersion,
            bulletinRoot: journal.bulletinRoot,
            treeSize: journal.treeSize,
            totalExpected: journal.totalExpected,
            votesCount: journal.validVotes,
            logId: '0x' + 'b'.repeat(64),
            timestamp: 123,
            recomputedInputCommitment: journal.inputCommitment,
          },
        }),
        journal,
      },
      stepFunctionsArn: 'arn:aws:states:ap-northeast-1:123456789012:execution:ProverDispatcher:exec-001',
    };

    const body = JSON.stringify(payload);
    const timestamp = new Date().toISOString();
    const signature = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');

    const request = new NextRequest('http://localhost:3000/api/finalize/callback', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Finalize-Callback-Timestamp': timestamp,
        'X-Finalize-Callback-Signature': signature,
      },
      body,
    });

    const response = await POST(request);
    expect(response.status).toBe(200);

    expect(markFinalizationSucceeded).toHaveBeenCalled();
    const successCall = markFinalizationSucceeded.mock.calls[0];
    expect(successCall).toBeDefined();
    expect(successCall[0]).toBe(payload.sessionId);
    expect(successCall[1]).toMatchObject({
      executionId: payload.executionId,
      queuedAt: payload.queuedAt,
      startedAt: payload.startedAt,
      completedAt: payload.completedAt,
      bundleMetadata: undefined,
      stepFunctionsArn: payload.stepFunctionsArn,
      finalizationResult: {
        imageId: payload.finalizationResult.imageId,
        journal,
      },
    });
    expect(successCall[1].finalizationResult).not.toHaveProperty('bulletinRoot');
    expect(successCall[1].finalizationResult).not.toHaveProperty('missingIndices');
    expect(finalizeSession).not.toHaveBeenCalled();
  });

  it('fails closed when success callback includes compatibility alias fields', async () => {
    const markFinalizationSucceeded = vi.fn<NonNullable<VoteStore['markFinalizationSucceeded']>>();
    const markFinalizationFailed = vi.fn<NonNullable<VoteStore['markFinalizationFailed']>>().mockResolvedValue({
      status: 'failed' as const,
      executionId: '01HVN5WA1CEH94868G90QGJ7HX',
      queuedAt: 1730000000000,
      startedAt: 1730000001000,
      failedAt: 1730000005000,
      error: {
        code: 'FINALIZATION_RESULT_INVALID',
        message: 'Canonical finalization result is missing proof-bound journal data',
      },
    });
    const journal = createTestJournal({
      totalExpected: 64,
      validVotes: 64,
      missingIndices: 0,
      invalidIndices: 0,
    });
    const store = createMockVoteStore({
      getSession: vi.fn().mockResolvedValue({
        sessionId: '2d8a4d02-1a56-4e8a-98f1-e8eb7a482a4b',
        votes: new Map(),
        botCount: 63,
        finalized: false,
        createdAt: 0,
        lastActivity: 0,
      }),
      markFinalizationSucceeded,
      markFinalizationFailed,
    });
    vi.mocked(getGlobalStore).mockReturnValue(store);

    const payload = {
      sessionId: '2d8a4d02-1a56-4e8a-98f1-e8eb7a482a4b',
      executionId: '01HVN5WA1CEH94868G90QGJ7HX',
      contractGeneration: '2026-04-zkvm-current-v1',
      status: 'SUCCEEDED',
      queuedAt: 1730000000000,
      startedAt: 1730000001000,
      completedAt: 1730000005000,
      finalizationResult: {
        tally: {
          counts: { A: 32, B: 32, C: 0, D: 0, E: 0 },
          totalVotes: 64,
          tamperedCount: 0,
        },
        bulletinRoot: '0x' + '1'.repeat(64),
        imageId: '0x' + '2'.repeat(64),
        missingIndices: 0,
        invalidIndices: 0,
        countedIndices: 64,
        totalExpected: 64,
        treeSize: 64,
        excludedCount: 0,
        sthDigest: '0x' + '3'.repeat(64),
        includedBitmapRoot: '0x' + '4'.repeat(64),
        inputCommitment: '0x' + '5'.repeat(64),
        journal,
      },
    };

    const body = JSON.stringify(payload);
    const timestamp = new Date().toISOString();
    const signature = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');

    const request = new NextRequest('http://localhost:3000/api/finalize/callback', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Finalize-Callback-Timestamp': timestamp,
        'X-Finalize-Callback-Signature': signature,
      },
      body,
    });

    const response = await POST(request);
    expect(response.status).toBe(200);

    expect(markFinalizationSucceeded).not.toHaveBeenCalled();
    expect(markFinalizationFailed).toHaveBeenCalledOnce();
  });

  it('fails closed when success callback omits required authority tally', async () => {
    const markFinalizationSucceeded = vi.fn<NonNullable<VoteStore['markFinalizationSucceeded']>>();
    const markFinalizationFailed = vi.fn<NonNullable<VoteStore['markFinalizationFailed']>>().mockResolvedValue({
      status: 'failed' as const,
      executionId: '01HVN5WA1CEH94868G90QGJ7HX',
      queuedAt: 1730000000000,
      startedAt: 1730000001000,
      failedAt: 1730000005000,
      error: {
        code: 'FINALIZATION_RESULT_INVALID',
        message: 'Canonical finalization result is missing proof-bound journal data',
      },
    });
    const journal = createTestJournal({
      totalExpected: 64,
      validVotes: 61,
      missingIndices: 1,
      invalidIndices: 2,
    });
    const store = createMockVoteStore({
      getSession: vi.fn().mockResolvedValue({
        sessionId: '2d8a4d02-1a56-4e8a-98f1-e8eb7a482a4b',
        votes: new Map(),
        botCount: 63,
        finalized: false,
        createdAt: 0,
        lastActivity: 0,
      }),
      markFinalizationSucceeded,
      markFinalizationFailed,
    });
    vi.mocked(getGlobalStore).mockReturnValue(store);

    const payload = {
      sessionId: '2d8a4d02-1a56-4e8a-98f1-e8eb7a482a4b',
      executionId: '01HVN5WA1CEH94868G90QGJ7HX',
      contractGeneration: '2026-04-zkvm-current-v1',
      status: 'SUCCEEDED',
      queuedAt: 1730000000000,
      startedAt: 1730000001000,
      completedAt: 1730000005000,
      finalizationResult: {
        bulletinRoot: journal.bulletinRoot,
        imageId: '0x' + '2'.repeat(64),
        journal,
      },
    };

    const body = JSON.stringify(payload);
    const timestamp = new Date().toISOString();
    const signature = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');

    const request = new NextRequest('http://localhost:3000/api/finalize/callback', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Finalize-Callback-Timestamp': timestamp,
        'X-Finalize-Callback-Signature': signature,
      },
      body,
    });

    const response = await POST(request);
    expect(response.status).toBe(200);

    expect(markFinalizationSucceeded).not.toHaveBeenCalled();
    expect(markFinalizationFailed).toHaveBeenCalledOnce();
  });

  it('fails closed when success callback carries an unsupported journal contract', async () => {
    const markFinalizationSucceeded = vi.fn<NonNullable<VoteStore['markFinalizationSucceeded']>>();
    const markFinalizationFailed = vi.fn<NonNullable<VoteStore['markFinalizationFailed']>>().mockResolvedValue({
      status: 'failed' as const,
      executionId: '01HVN5WA1CEH94868G90QGJ7HX',
      queuedAt: 1730000000000,
      startedAt: 1730000001000,
      failedAt: 1730000005000,
      error: {
        code: 'FINALIZATION_RESULT_INVALID',
        message: 'Canonical finalization result is missing proof-bound journal data',
      },
    });
    const store = createMockVoteStore({
      getSession: vi.fn().mockResolvedValue({
        sessionId: '2d8a4d02-1a56-4e8a-98f1-e8eb7a482a4b',
        votes: new Map(),
        botCount: 63,
        finalized: false,
        createdAt: 0,
        lastActivity: 0,
      }),
      markFinalizationSucceeded,
      markFinalizationFailed,
    });
    vi.mocked(getGlobalStore).mockReturnValue(store);

    const payload = {
      sessionId: '2d8a4d02-1a56-4e8a-98f1-e8eb7a482a4b',
      executionId: '01HVN5WA1CEH94868G90QGJ7HX',
      contractGeneration: '2026-04-zkvm-current-v1',
      status: 'SUCCEEDED',
      queuedAt: 1730000000000,
      startedAt: 1730000001000,
      completedAt: 1730000005000,
      finalizationResult: {
        tally: {
          counts: { A: 1, B: 0, C: 0, D: 0, E: 0 },
          totalVotes: 1,
          tamperedCount: 0,
        },
        bulletinRoot: '0x' + '1'.repeat(64),
        imageId: '0x' + '2'.repeat(64),
        journal: {
          ...createTestJournal(),
          methodVersion: 3,
        },
      },
    };

    const body = JSON.stringify(payload);
    const timestamp = new Date().toISOString();
    const signature = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');

    const request = new NextRequest('http://localhost:3000/api/finalize/callback', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Finalize-Callback-Timestamp': timestamp,
        'X-Finalize-Callback-Signature': signature,
      },
      body,
    });

    const response = await POST(request);
    expect(response.status).toBe(200);
    expect(markFinalizationSucceeded).not.toHaveBeenCalled();
    expect(markFinalizationFailed).toHaveBeenCalledOnce();
  });

  it('rejects callback with invalid signature', async () => {
    const request = new NextRequest('http://localhost:3000/api/finalize/callback', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Finalize-Callback-Timestamp': new Date().toISOString(),
        'X-Finalize-Callback-Signature': 'invalid',
      },
      body: JSON.stringify({}),
    });

    const response = await POST(request);
    expect(response.status).toBe(401);
  });

  it('fails closed when callback secret is unresolved Amplify placeholder', async () => {
    process.env.FINALIZE_CALLBACK_SECRET = unresolvedAmplifySecret;

    const request = new NextRequest('http://localhost:3000/api/finalize/callback', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({}),
    });

    const response = await POST(request);
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({ error: 'Callback secret not configured' });
  });

  it('rejects callback when timestamp exceeds skew limit', async () => {
    const payload = { sessionId: 'abc', executionId: 'exec', status: 'SUCCEEDED', queuedAt: 1 };
    const body = JSON.stringify(payload);
    const pastTimestamp = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const signature = createHmac('sha256', secret).update(`${pastTimestamp}.${body}`).digest('hex');

    const request = new NextRequest('http://localhost:3000/api/finalize/callback', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Finalize-Callback-Timestamp': pastTimestamp,
        'X-Finalize-Callback-Signature': signature,
      },
      body,
    });

    const response = await POST(request);
    expect(response.status).toBe(401);
  });

  it('fails closed when callback skew configuration is invalid', async () => {
    process.env.FINALIZE_CALLBACK_MAX_SKEW_MS = 'invalid-ms';

    const payload = {
      sessionId: '2d8a4d02-1a56-4e8a-98f1-e8eb7a482a4b',
      executionId: '01HVN5WA1CEH94868G90QGJ7HX',
      status: 'UNKNOWN',
      queuedAt: 1730000000000,
    };
    const body = JSON.stringify(payload);
    const timestamp = new Date().toISOString();
    const signature = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');

    const request = new NextRequest('http://localhost:3000/api/finalize/callback', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Finalize-Callback-Timestamp': timestamp,
        'X-Finalize-Callback-Signature': signature,
      },
      body,
    });

    const response = await POST(request);
    expect(response.status).toBe(500);

    await expect(response.json()).resolves.toMatchObject({
      error: 'Invalid callback skew configuration',
    });
  });

  it('rejects oversized callback payloads before signature verification', async () => {
    process.env.FINALIZE_CALLBACK_BODY_LIMIT_BYTES = '64';
    const oversizedPayload = {
      sessionId: '2d8a4d02-1a56-4e8a-98f1-e8eb7a482a4b',
      executionId: '01HVN5WA1CEH94868G90QGJ7HX',
      status: 'SUCCEEDED',
      queuedAt: 1730000000000,
      padding: 'x'.repeat(256),
    };
    const body = JSON.stringify(oversizedPayload);
    const timestamp = new Date().toISOString();
    const signature = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');

    const request = new NextRequest('http://localhost:3000/api/finalize/callback', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Finalize-Callback-Timestamp': timestamp,
        'X-Finalize-Callback-Signature': signature,
      },
      body,
    });

    const response = await POST(request);

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({
      error: 'Callback payload too large',
    });
  });

  it('rejects callback payloads without contractGeneration', async () => {
    const payload = {
      sessionId: '2d8a4d02-1a56-4e8a-98f1-e8eb7a482a4b',
      executionId: '01HVN5WA1CEH94868G90QGJ7HX',
      status: 'FAILED',
      queuedAt: 1730000000000,
      failedAt: 1730000005000,
      error: {
        code: 'FINALIZATION_FAILED',
        message: 'callback failed',
      },
    };
    const body = JSON.stringify(payload);
    const timestamp = new Date().toISOString();
    const signature = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');

    const request = new NextRequest('http://localhost:3000/api/finalize/callback', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Finalize-Callback-Timestamp': timestamp,
        'X-Finalize-Callback-Signature': signature,
      },
      body,
    });

    const response = await POST(request);
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: 'Invalid callback payload',
    });
  });

  it('returns 409 when an in-flight callback hits the current-artifact boundary', async () => {
    const markFinalizationFailed = vi.fn<NonNullable<VoteStore['markFinalizationFailed']>>().mockRejectedValue(
      new UnsupportedCurrentArtifactBoundaryError({
        runtimeContractGeneration: '2026-04-zkvm-current-v1',
        persistedContractGeneration: 'stale-contract-generation',
        carriedContractGeneration: '2026-04-zkvm-current-v1',
      }),
    );
    const store = createMockVoteStore({
      markFinalizationFailed,
    });
    vi.mocked(getGlobalStore).mockReturnValue(store);

    const payload = {
      sessionId: '2d8a4d02-1a56-4e8a-98f1-e8eb7a482a4b',
      executionId: '01HVN5WA1CEH94868G90QGJ7HX',
      contractGeneration: '2026-04-zkvm-current-v1',
      status: 'FAILED',
      queuedAt: 1730000000000,
      failedAt: 1730000005000,
      error: {
        code: 'FINALIZATION_FAILED',
        message: 'callback failed',
      },
    };
    const body = JSON.stringify(payload);
    const timestamp = new Date().toISOString();
    const signature = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');

    const request = new NextRequest('http://localhost:3000/api/finalize/callback', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Finalize-Callback-Timestamp': timestamp,
        'X-Finalize-Callback-Signature': signature,
      },
      body,
    });

    const response = await POST(request);
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: 'UNSUPPORTED_CURRENT_ARTIFACT',
      artifactState: 'unsupported_current_artifact',
      details: {
        persistedContractGeneration: 'stale-contract-generation',
      },
    });
  });
});
