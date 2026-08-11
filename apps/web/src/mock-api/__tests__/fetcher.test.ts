import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mockApiFetch } from '../fetcher';
import { MOCK_FINALIZATION_ID } from '../fixtures';
import { resetMockState, updateMockState } from '../state';
import { CURRENT_METHOD_VERSION } from '@stark-ballot/zkvm-contract/zkvm/types';
import { readJsonRecord } from '@stark-ballot/test-support/testing/response-helpers';
import { VerificationResourceResponseSchema } from '@stark-ballot/api-contract/schemas/verification';
import { CurrentFinalizationResponseSchema } from '@stark-ballot/api-contract/schemas/finalizations';
import { BitmapProofResponseSchema } from '@stark-ballot/api-contract/schemas/artifacts';
import {
  buildAuthenticatedBitmapProofContext,
  verifyBitmapMerkleProof,
} from '@stark-ballot/verification/merkle/bitmap-merkle-tree';
import { getNumberProperty, getRecordProperty, getStringProperty } from '@stark-ballot/validation/unknown-value-guards';

const mockRandomUUID = vi.fn();
type MockErrorPayload = {
  error?: {
    code?: string;
    details?: {
      kind?: string;
      issues?: { fieldErrors?: Record<string, string[]> };
    };
  };
  meta?: { requestId?: string };
};

Object.defineProperty(globalThis, 'crypto', {
  value: { randomUUID: mockRandomUUID },
  writable: true,
});

describe('mockApiFetch', () => {
  beforeEach(() => {
    resetMockState();
    mockRandomUUID.mockReset();
  });

  async function createSession(): Promise<{ sessionId: string; capabilityToken: string }> {
    mockRandomUUID
      .mockReturnValueOnce('session-auth')
      .mockReturnValueOnce('capability-auth')
      .mockReturnValueOnce('550e8400-e29b-41d4-a716-446655440000');
    const response = mockApiFetch('http://localhost/api/sessions', { method: 'POST' });
    const payload = (await response.json()) as {
      data?: { sessionId?: string; capabilityToken?: string };
    };
    const sessionId = payload.data?.sessionId;
    const capabilityToken = payload.data?.capabilityToken;
    if (!sessionId || !capabilityToken) {
      throw new Error('Invalid mock session payload');
    }
    return { sessionId, capabilityToken };
  }

  function verificationUrl(sessionId: string, finalizationId = MOCK_FINALIZATION_ID): string {
    return `http://localhost/api/sessions/${sessionId}/finalizations/${finalizationId}/verification`;
  }

  function completeFinalization(
    verificationStatus: 'success' | 'failed' | 'dev_mode' | 'not_run' | 'running' = 'success',
  ): void {
    const now = Date.now();
    updateMockState((current) => {
      current.finalizationId = MOCK_FINALIZATION_ID;
      current.finalizationQueuedAtMs = now - 22_000;
      current.finalizationStartedAtMs = now - 20_000;
      current.finalizationCompletedAtMs = now - 1_000;
      current.verificationStatus = verificationStatus;
    });
  }

  const successfulCastChecks = {
    cast_receipt_present: 'success',
    cast_choice_range: 'success',
    cast_random_format: 'success',
    cast_commitment_match: 'success',
  } as const;

  it('returns a new session for each /api/sessions call with correlated server request IDs', async () => {
    mockRandomUUID
      .mockReturnValueOnce('session-1')
      .mockReturnValueOnce('capability-1')
      .mockReturnValueOnce('election-1')
      .mockReturnValueOnce('session-2')
      .mockReturnValueOnce('capability-2')
      .mockReturnValueOnce('election-2');

    const response1 = mockApiFetch('http://localhost/api/sessions', { method: 'POST' });
    const payload1 = (await response1.json()) as {
      data?: { sessionId?: string };
      meta?: { requestId?: string };
    };

    const response2 = mockApiFetch('http://localhost/api/sessions', { method: 'POST' });
    const payload2 = (await response2.json()) as {
      data?: { sessionId?: string };
      meta?: { requestId?: string };
    };

    expect(response1.status).toBe(200);
    expect(response2.status).toBe(200);
    expect(payload1.data?.sessionId).toBe('session-1');
    expect(payload2.data?.sessionId).toBe('session-2');
    expect(response1.headers.get('x-request-id')).toBe(payload1.meta?.requestId);
    expect(response2.headers.get('x-request-id')).toBe(payload2.meta?.requestId);
    expect(payload1.meta?.requestId).not.toBe(payload2.meta?.requestId);
  });

  it.each([
    { name: 'session creation', url: 'http://localhost/api/sessions?unexpected=1', init: { method: 'POST' } },
    {
      name: 'vote submission',
      url: 'http://localhost/api/sessions/11111111-1111-4111-8111-111111111111/votes?unexpected=1',
      init: { method: 'POST' },
    },
    {
      name: 'progress',
      url: 'http://localhost/api/sessions/11111111-1111-4111-8111-111111111111/progress?unexpected=1',
      init: { method: 'GET' },
    },
    {
      name: 'finalize',
      url: 'http://localhost/api/sessions/session-auth/finalizations?unexpected=1',
      init: { method: 'POST' },
    },
    {
      name: 'finalize cancel',
      url: `http://localhost/api/sessions/session-auth/finalizations/${MOCK_FINALIZATION_ID}/cancel?unexpected=1`,
      init: { method: 'POST' },
    },
    {
      name: 'current finalization',
      url: 'http://localhost/api/sessions/session-auth/finalizations/current?unexpected=1',
      init: { method: 'GET' },
    },
    {
      name: 'verification run',
      url: `http://localhost/api/sessions/session-auth/finalizations/${MOCK_FINALIZATION_ID}/verification?unexpected=1`,
      init: { method: 'POST' },
    },
    {
      name: 'verification observation',
      url: `http://localhost/api/sessions/session-auth/finalizations/${MOCK_FINALIZATION_ID}/verification/observations?unexpected=1`,
      init: { method: 'POST' },
    },
    {
      name: 'bulletin vote proof',
      url: 'http://localhost/api/sessions/session-auth/votes/11111111-1111-4111-8111-111111111111/inclusion-proof?unexpected=1',
      init: { method: 'GET' },
    },
    {
      name: 'verification report',
      url: 'http://localhost/api/sessions/session-auth/finalizations/execution-auth/artifacts/report?unexpected=1',
      init: { method: 'GET' },
    },
  ])('rejects unexpected query parameters for $name before route handling', async ({ url, init }) => {
    const response = mockApiFetch(url, init);
    const payload = (await response.json()) as MockErrorPayload;

    expect(response.status).toBe(400);
    expect(payload.error?.code).toBe('INVALID_REQUEST');
    expect(payload.error?.details?.issues?.fieldErrors?.['unexpected']).toEqual(['Unexpected query parameter']);
    expect(response.headers.get('x-request-id')).toBe(payload.meta?.requestId);
  });

  it('rejects unknown verification representation selectors before route handling', async () => {
    const response = mockApiFetch(
      `http://localhost/api/sessions/session-auth/finalizations/${MOCK_FINALIZATION_ID}/verification?unexpected=1`,
      { method: 'GET' },
    );
    const payload = (await response.json()) as MockErrorPayload;

    expect(response.status).toBe(400);
    expect(payload.error?.code).toBe('INVALID_REQUEST');
    expect(payload.error?.details?.issues?.fieldErrors?.['unexpected']).toEqual(['Unrecognized key']);
  });

  it.each([
    { method: 'GET', path: '/api/verify' },
    { method: 'POST', path: '/api/verification/run' },
    { method: 'POST', path: '/api/verification/observation' },
  ])('does not expose retired verification route $path', async ({ method, path }) => {
    const response = mockApiFetch(`http://localhost${path}`, { method });
    const payload = (await response.json()) as MockErrorPayload;

    expect(response.status).toBe(404);
    expect(payload.error?.code).toBe('MOCK_NOT_FOUND');
  });

  it('rejects invalid finalize request bodies', async () => {
    const { sessionId, capabilityToken } = await createSession();

    const response = mockApiFetch(`http://localhost/api/sessions/${sessionId}/finalizations`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Session-Capability': capabilityToken,
      },
      body: JSON.stringify({ scenarioId: 'S9' }),
    });
    const payload = (await response.json()) as MockErrorPayload;

    expect(response.status).toBe(400);
    expect(payload.error?.code).toBe('INVALID_REQUEST');
  });

  it('rejects malformed JSON in mock mutation bodies', async () => {
    const { sessionId, capabilityToken } = await createSession();

    const response = mockApiFetch(`http://localhost/api/sessions/${sessionId}/finalizations`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Session-Capability': capabilityToken,
      },
      body: '{',
    });
    const payload = (await response.json()) as MockErrorPayload;

    expect(response.status).toBe(400);
    expect(payload.error?.code).toBe('INVALID_REQUEST');
  });

  it('rejects unexpected fields in mock mutation bodies', async () => {
    const { sessionId, capabilityToken } = await createSession();

    const response = mockApiFetch(`http://localhost/api/sessions/${sessionId}/votes`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Session-Capability': capabilityToken,
      },
      body: JSON.stringify({
        commitment: `0x${'1'.repeat(64)}`,
        vote: 'A',
        rand: `0x${'2'.repeat(64)}`,
        unexpected: true,
      }),
    });
    const payload = (await response.json()) as MockErrorPayload;

    expect(response.status).toBe(400);
    expect(payload.error?.code).toBe('INVALID_REQUEST');
  });

  it('requires capability token for the create-finalization route', async () => {
    const { sessionId } = await createSession();

    const response = mockApiFetch(`http://localhost/api/sessions/${sessionId}/finalizations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scenarioId: 'S0' }),
    });
    const payload = (await response.json()) as MockErrorPayload;

    expect(response.status).toBe(401);
    expect(payload.error?.code).toBe('SESSION_CAPABILITY_REQUIRED');
  });

  it('uses the declared cancellation precondition error for a matched route and reserves MOCK_NOT_FOUND for unmatched routes', async () => {
    const { sessionId, capabilityToken } = await createSession();
    const matched = mockApiFetch(
      `http://localhost/api/sessions/${sessionId}/finalizations/missing-finalization/cancel`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Session-Capability': capabilityToken,
        },
        body: JSON.stringify({}),
      },
    );
    const matchedPayload = (await matched.json()) as MockErrorPayload;
    const unmatched = mockApiFetch(
      `http://localhost/api/sessions/${sessionId}/finalizations/missing-finalization/cancelled`,
      { method: 'POST' },
    );
    const unmatchedPayload = (await unmatched.json()) as MockErrorPayload;

    expect(matched.status).toBe(409);
    expect(matchedPayload.error?.code).toBe('FINALIZATION_NOT_CANCELLABLE');
    expect(unmatched.status).toBe(404);
    expect(unmatchedPayload.error?.code).toBe('MOCK_NOT_FOUND');
  });

  it('requires capability token for /api/sessions/:sessionId/votes', async () => {
    const { sessionId } = await createSession();

    const response = mockApiFetch(`http://localhost/api/sessions/${sessionId}/votes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        commitment: `0x${'1'.repeat(64)}`,
        vote: 'A',
        rand: `0x${'2'.repeat(64)}`,
      }),
    });
    const payload = (await response.json()) as MockErrorPayload;

    expect(response.status).toBe(401);
    expect(payload.error?.code).toBe('SESSION_CAPABILITY_REQUIRED');
  });

  it('requires capability token for the finalization verification resource', async () => {
    const { sessionId } = await createSession();

    const response = mockApiFetch(verificationUrl(sessionId), { method: 'GET' });
    const payload = (await response.json()) as MockErrorPayload;

    expect(response.status).toBe(401);
    expect(payload.error?.code).toBe('SESSION_CAPABILITY_REQUIRED');
  });

  it('requires capability token for the current-finalization route', async () => {
    const { sessionId } = await createSession();

    const response = mockApiFetch(`http://localhost/api/sessions/${sessionId}/finalizations/current`, {
      method: 'GET',
    });
    const payload = (await response.json()) as MockErrorPayload;

    expect(response.status).toBe(401);
    expect(payload.error?.code).toBe('SESSION_CAPABILITY_REQUIRED');
  });

  it('requires capability token for the finalization verification mutation', async () => {
    const { sessionId } = await createSession();

    const response = mockApiFetch(verificationUrl(sessionId), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const payload = (await response.json()) as MockErrorPayload;

    expect(response.status).toBe(401);
    expect(payload.error?.code).toBe('SESSION_CAPABILITY_REQUIRED');
  });

  it('requires capability token for the finalization verification observation', async () => {
    const { sessionId } = await createSession();

    const response = mockApiFetch(`${verificationUrl(sessionId)}/observations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        castChecks: successfulCastChecks,
      }),
    });
    const payload = (await response.json()) as MockErrorPayload;

    expect(response.status).toBe(401);
    expect(payload.error?.code).toBe('SESSION_CAPABILITY_REQUIRED');
  });

  it('validates and idempotently records a browser-local verification observation', async () => {
    const { sessionId, capabilityToken } = await createSession();
    const now = Date.now();
    updateMockState((current) => {
      current.finalizationId = MOCK_FINALIZATION_ID;
      current.finalizationQueuedAtMs = now - 22_000;
      current.finalizationStartedAtMs = now - 20_000;
      current.finalizationCompletedAtMs = now - 1_000;
      current.verificationStatus = 'success';
    });
    const request = {
      method: 'POST',
      headers: {
        'X-Session-Capability': capabilityToken,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        castChecks: successfulCastChecks,
      }),
    };

    const first = mockApiFetch(`${verificationUrl(sessionId)}/observations`, request);
    const second = mockApiFetch(`${verificationUrl(sessionId)}/observations`, request);

    expect(first.status).toBe(200);
    const firstPayload = (await first.json()) as {
      data?: { status?: string };
      meta?: { requestId?: string };
    };
    expect(firstPayload.data?.status).toBe('recorded');
    expect(firstPayload.meta?.requestId).toBeTypeOf('string');
    expect(second.status).toBe(200);
    const secondPayload = (await second.json()) as {
      data?: { status?: string };
      meta?: { requestId?: string };
    };
    expect(secondPayload.data?.status).toBe('idempotent');
    expect(secondPayload.meta?.requestId).toBeTypeOf('string');
  });

  it('rejects a conflicting verification observation after the first accepted fingerprint', async () => {
    const { sessionId, capabilityToken } = await createSession();
    completeFinalization();
    const url = `${verificationUrl(sessionId)}/observations`;
    const headers = {
      'X-Session-Capability': capabilityToken,
      'Content-Type': 'application/json',
    };

    const first = mockApiFetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ castChecks: successfulCastChecks }),
    });
    const conflicting = mockApiFetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        castChecks: {
          ...successfulCastChecks,
          cast_commitment_match: 'failed',
        },
      }),
    });
    const payload = (await conflicting.json()) as MockErrorPayload;

    expect(first.status).toBe(200);
    expect(conflicting.status).toBe(409);
    expect(payload.error?.code).toBe('VERIFICATION_OBSERVATION_CONFLICT');
  });

  it('rejects a verification observation before finalization or while verification is non-terminal', async () => {
    const { sessionId, capabilityToken } = await createSession();
    const request = {
      method: 'POST',
      headers: {
        'X-Session-Capability': capabilityToken,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        castChecks: successfulCastChecks,
      }),
    };

    const beforeFinalization = mockApiFetch(`${verificationUrl(sessionId)}/observations`, request);
    expect(beforeFinalization.status).toBe(409);
    const beforeFinalizationPayload = (await beforeFinalization.json()) as MockErrorPayload;
    expect(beforeFinalizationPayload.error?.code).toBe('VERIFICATION_OBSERVATION_CONFLICT');
    expect(beforeFinalizationPayload.meta?.requestId).toBeTypeOf('string');

    const now = Date.now();
    updateMockState((current) => {
      current.finalizationId = MOCK_FINALIZATION_ID;
      current.finalizationQueuedAtMs = now - 22_000;
      current.finalizationStartedAtMs = now - 20_000;
      current.finalizationCompletedAtMs = now - 1_000;
      current.verificationStatus = 'running';
    });
    const whileRunning = mockApiFetch(`${verificationUrl(sessionId)}/observations`, request);
    expect(whileRunning.status).toBe(409);
    const whileRunningPayload = (await whileRunning.json()) as MockErrorPayload;
    expect(whileRunningPayload.error?.code).toBe('VERIFICATION_OBSERVATION_CONFLICT');
    expect(whileRunningPayload.meta?.requestId).toBeTypeOf('string');
  });

  it('takes observation identity only from the path and keeps the body closed', async () => {
    const { sessionId, capabilityToken } = await createSession();
    completeFinalization();

    const response = mockApiFetch(`${verificationUrl(sessionId)}/observations`, {
      method: 'POST',
      headers: {
        'X-Session-Capability': capabilityToken,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        finalizationId: MOCK_FINALIZATION_ID,
        castChecks: successfulCastChecks,
      }),
    });
    const payload = (await response.json()) as MockErrorPayload;

    expect(response.status).toBe(400);
    expect(payload.error?.code).toBe('INVALID_REQUEST');
  });

  it('keeps verification run input as a strict empty object', async () => {
    const { sessionId, capabilityToken } = await createSession();
    completeFinalization();

    const response = mockApiFetch(verificationUrl(sessionId), {
      method: 'POST',
      headers: {
        'X-Session-Capability': capabilityToken,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ finalizationId: MOCK_FINALIZATION_ID }),
    });
    const payload = (await response.json()) as MockErrorPayload;

    expect(response.status).toBe(400);
    expect(payload.error?.code).toBe('INVALID_REQUEST');
  });

  it('starts and idempotently returns verification for the path finalization with an empty body', async () => {
    const { sessionId, capabilityToken } = await createSession();
    completeFinalization('not_run');
    const request = {
      method: 'POST',
      headers: {
        'X-Session-Capability': capabilityToken,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({}),
    };

    const first = mockApiFetch(verificationUrl(sessionId), request);
    const second = mockApiFetch(verificationUrl(sessionId), request);
    const firstPayload = (await first.json()) as {
      data?: { finalizationId?: string; verificationStatus?: string; idempotent?: boolean };
    };
    const secondPayload = (await second.json()) as {
      data?: { finalizationId?: string; verificationStatus?: string; idempotent?: boolean };
    };

    expect(first.status).toBe(200);
    expect(firstPayload.data).toMatchObject({
      finalizationId: MOCK_FINALIZATION_ID,
      verificationStatus: 'running',
      idempotent: true,
    });
    expect(second.status).toBe(200);
    expect(secondPayload.data).toEqual(firstPayload.data);
  });

  it('fails closed when verification path identity is not the current finalization', async () => {
    const { sessionId, capabilityToken } = await createSession();
    completeFinalization();
    const headers = {
      'X-Session-Capability': capabilityToken,
    };
    const mismatchedUrl = verificationUrl(sessionId, 'other-finalization');

    const readResponse = mockApiFetch(mismatchedUrl, { method: 'GET', headers });
    const readPayload = VerificationResourceResponseSchema.parse(await readResponse.json());
    const runResponse = mockApiFetch(mismatchedUrl, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const runPayload = (await runResponse.json()) as MockErrorPayload;
    const observationResponse = mockApiFetch(`${mismatchedUrl}/observations`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ castChecks: successfulCastChecks }),
    });
    const observationPayload = (await observationResponse.json()) as MockErrorPayload;

    expect(readResponse.status).toBe(200);
    expect(readPayload.data).toEqual({
      availability: 'unavailable',
      finalizationId: 'other-finalization',
      reason: 'finalization_not_current',
      message: 'Requested finalization is not the current finalized authority',
    });
    expect(runResponse.status).toBe(500);
    expect(runPayload.error?.code).toBe('INVALID_FINALIZATION_ARTIFACT');
    expect(observationResponse.status).toBe(409);
    expect(observationPayload.error?.code).toBe('VERIFICATION_OBSERVATION_CONFLICT');
  });

  it('requires capability token for /api/sessions/:sessionId/progress', async () => {
    const { sessionId } = await createSession();

    const response = mockApiFetch(`http://localhost/api/sessions/${sessionId}/progress`, {
      method: 'GET',
    });
    const payload = (await response.json()) as MockErrorPayload;

    expect(response.status).toBe(401);
    expect(payload.error?.code).toBe('SESSION_CAPABILITY_REQUIRED');
  });

  it('requires capability token for the session bulletin resource', async () => {
    const { sessionId } = await createSession();

    const response = mockApiFetch(`http://localhost/api/sessions/${sessionId}/bulletin`, {
      method: 'GET',
    });
    const payload = (await response.json()) as MockErrorPayload;

    expect(response.status).toBe(401);
    expect(payload.error?.code).toBe('SESSION_CAPABILITY_REQUIRED');
  });

  it('requires capability token for the session vote inclusion proof resource', async () => {
    const { sessionId } = await createSession();

    const response = mockApiFetch(
      `http://localhost/api/sessions/${sessionId}/votes/11111111-1111-4111-8111-111111111111/inclusion-proof`,
      { method: 'GET' },
    );
    const payload = (await response.json()) as MockErrorPayload;

    expect(response.status).toBe(401);
    expect(payload.error?.code).toBe('SESSION_CAPABILITY_REQUIRED');
  });

  it('requires capability token for the session bulletin consistency-proof resource', async () => {
    const { sessionId } = await createSession();

    const response = mockApiFetch(
      `http://localhost/api/sessions/${sessionId}/bulletin/consistency-proof?fromTreeSize=1&toTreeSize=1`,
      { method: 'GET' },
    );
    const payload = (await response.json()) as MockErrorPayload;

    expect(response.status).toBe(401);
    expect(payload.error?.code).toBe('SESSION_CAPABILITY_REQUIRED');
  });

  it('rejects retired /api/botdata/:id access in normal browser mock mode', async () => {
    await createSession();

    const response = mockApiFetch('http://localhost/api/botdata/1', {
      method: 'GET',
    });
    const payload = (await response.json()) as MockErrorPayload;

    expect(response.status).toBe(404);
    expect(payload.error?.code).toBe('MOCK_NOT_FOUND');
  });

  it('does not expose the retired mock-only finalization shortcut', async () => {
    const response = mockApiFetch('http://localhost/api/sessions/mock/finalize', {
      method: 'POST',
    });
    const payload = (await response.json()) as MockErrorPayload;

    expect(response.status).toBe(404);
    expect(payload.error?.code).toBe('MOCK_NOT_FOUND');
  });

  it('serves authenticated report and ranged bundle artifacts through canonical routes', async () => {
    const { sessionId, capabilityToken } = await createSession();
    const route = `http://localhost/api/sessions/${sessionId}/finalizations/${MOCK_FINALIZATION_ID}/artifacts`;

    const reportResponse = mockApiFetch(`${route}/report`, {
      headers: { 'X-Session-Capability': capabilityToken },
    });
    expect(reportResponse.status).toBe(200);
    const report = await readJsonRecord(reportResponse, 'mock verification report');
    expect(getStringProperty(report, 'status')).toBeTypeOf('string');

    const bundleResponse = mockApiFetch(`${route}/bundle`, {
      headers: {
        'X-Session-Capability': capabilityToken,
        Range: 'bytes=0-3',
      },
    });
    expect(bundleResponse.status).toBe(206);
    expect(bundleResponse.headers.get('content-range')).toMatch(/^bytes 0-3\/\d+$/);
    expect(bundleResponse.headers.get('etag')).toMatch(/^".+"$/);
    expect(await bundleResponse.text()).toHaveLength(4);
  });

  it('serves canonical STH and input-commitment evidence routes', async () => {
    const { sessionId, capabilityToken } = await createSession();
    const headers = { 'X-Session-Capability': capabilityToken };
    updateMockState((current) => {
      current.bulletinIndex = 0;
      current.voteId = '11111111-1111-4111-8111-111111111111';
    });

    const sthResponse = mockApiFetch(`http://localhost/api/sessions/${sessionId}/bulletin/sth?auditorId=browser-mock`, {
      headers,
    });
    expect(sthResponse.status).toBe(200);
    const sthPayload = await readJsonRecord(sthResponse, 'mock signed tree head');
    const sth = getRecordProperty(getRecordProperty(sthPayload, 'data'), 'sth');
    expect(getStringProperty(sth, 'logId')).toBeTypeOf('string');
    expect(getNumberProperty(sth, 'treeSize')).toBeTypeOf('number');

    const inputCommitmentResponse = mockApiFetch(
      `http://localhost/api/sessions/${sessionId}/finalizations/current/input-commitment`,
      { headers },
    );
    expect(inputCommitmentResponse.status).toBe(200);
    const inputCommitmentPayload = await readJsonRecord(inputCommitmentResponse, 'mock input commitment');
    const inputCommitment = getRecordProperty(inputCommitmentPayload, 'data');
    expect(getStringProperty(inputCommitment, 'inputCommitment')).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it.each([
    { scenarioId: 'S0', kind: 'included', expectedBit: true },
    { scenarioId: 'S0', kind: 'seen', expectedBit: true },
    { scenarioId: 'S1', kind: 'included', expectedBit: false },
    { scenarioId: 'S1', kind: 'seen', expectedBit: false },
  ] as const)(
    'serves a cryptographically valid $kind bitmap proof for $scenarioId',
    async ({ scenarioId, kind, expectedBit }) => {
      const { sessionId, capabilityToken } = await createSession();
      const headers = { 'X-Session-Capability': capabilityToken };
      updateMockState((current) => {
        current.scenarioId = scenarioId;
        current.bulletinIndex = 0;
        current.voteId = '11111111-1111-4111-8111-111111111111';
      });
      completeFinalization();

      const currentResponse = mockApiFetch(`http://localhost/api/sessions/${sessionId}/finalizations/current`, {
        headers,
      });
      const currentPayload = CurrentFinalizationResponseSchema.parse(await currentResponse.json());
      if (currentPayload.data?.status !== 'succeeded') {
        throw new Error('Expected a succeeded mock finalization');
      }
      const journal = currentPayload.data.result.authority.journal;
      const expectedRoot = kind === 'seen' ? journal.seenBitmapRoot : journal.includedBitmapRoot;

      const proofResponse = mockApiFetch(
        `http://localhost/api/sessions/${sessionId}/finalizations/current/bitmap-proofs/${kind}/0`,
        { headers },
      );
      expect(proofResponse.status).toBe(200);
      const proof = BitmapProofResponseSchema.parse(await proofResponse.json()).data;
      expect(proof.leafChunk).toMatch(/^[0-9a-f]{64}$/);
      expect(proof.auditPath.every((node) => /^[0-9a-f]{64}$/.test(node.hash))).toBe(true);

      const verification = verifyBitmapMerkleProof(
        proof.leafChunk,
        proof.auditPath,
        buildAuthenticatedBitmapProofContext({
          bitIndex: 0,
          treeSize: journal.treeSize,
          expectedRoot,
        }),
      );
      expect(verification).toMatchObject({ valid: true, included: expectedBit });
    },
  );

  it('rejects bitmap proof requests before finalization succeeds', async () => {
    const { sessionId, capabilityToken } = await createSession();
    updateMockState((current) => {
      current.bulletinIndex = 0;
      current.voteId = '11111111-1111-4111-8111-111111111111';
    });

    const response = mockApiFetch(
      `http://localhost/api/sessions/${sessionId}/finalizations/current/bitmap-proofs/included/0`,
      { headers: { 'X-Session-Capability': capabilityToken } },
    );
    const payload = (await response.json()) as MockErrorPayload;

    expect(response.status).toBe(400);
    expect(payload.error?.code).toBe('INVALID_BITMAP_PROOF_REQUEST');
  });

  it('rejects bitmap proof requests when the session user has not voted', async () => {
    const { sessionId, capabilityToken } = await createSession();
    completeFinalization();

    const response = mockApiFetch(
      `http://localhost/api/sessions/${sessionId}/finalizations/current/bitmap-proofs/included/0`,
      { headers: { 'X-Session-Capability': capabilityToken } },
    );
    const payload = (await response.json()) as MockErrorPayload;

    expect(response.status).toBe(400);
    expect(payload.error?.code).toBe('USER_NOT_VOTED');
  });

  it('rejects an unknown bitmap kind through the declared path contract', async () => {
    const { sessionId, capabilityToken } = await createSession();
    completeFinalization();

    const response = mockApiFetch(
      `http://localhost/api/sessions/${sessionId}/finalizations/current/bitmap-proofs/unknown/0`,
      { headers: { 'X-Session-Capability': capabilityToken } },
    );
    const payload = (await response.json()) as MockErrorPayload;

    expect(response.status).toBe(400);
    expect(payload.error?.code).toBe('INVALID_REQUEST');
  });

  it.each([
    '/api/bulletin',
    '/api/bulletin/consistency-proof?oldSize=0&newSize=0',
    '/api/bulletin/11111111-1111-4111-8111-111111111111/proof',
    '/api/sth',
    '/api/bitmap-proof?i=0&kind=included',
    '/api/zkvm-input-hash?sessionId=session-auth',
  ])('does not mount the replaced evidence route %s', async (path) => {
    const response = mockApiFetch(`http://localhost${path}`);
    const payload = (await response.json()) as MockErrorPayload;

    expect(response.status).toBe(404);
    expect(payload.error?.code).toBe('MOCK_NOT_FOUND');
  });

  it('does not treat an obsolete session identity header as authorization', async () => {
    const { sessionId } = await createSession();
    const response = mockApiFetch(`http://localhost/api/sessions/${sessionId}/bulletin`, {
      headers: { 'X-Session-ID': sessionId },
    });
    const payload = (await response.json()) as MockErrorPayload;

    expect(response.status).toBe(401);
    expect(payload.error?.code).toBe('SESSION_CAPABILITY_REQUIRED');
  });

  it.each([
    (sessionId: string) => `/api/sessions/${sessionId}/bulletin/consistency-proof?oldSize=0&newSize=0`,
    (sessionId: string) => `/api/sessions/${sessionId}/bulletin/sth?auditor=legacy`,
    (sessionId: string) =>
      `/api/sessions/${sessionId}/finalizations/current/bitmap-proofs/included/0?i=0&kind=included`,
    (sessionId: string) => `/api/sessions/${sessionId}/finalizations/current/input-commitment?sessionId=${sessionId}`,
  ])('rejects a replaced evidence query alias', async (buildPath) => {
    const { sessionId, capabilityToken } = await createSession();
    const response = mockApiFetch(`http://localhost${buildPath(sessionId)}`, {
      headers: { 'X-Session-Capability': capabilityToken },
    });
    const payload = (await response.json()) as MockErrorPayload;

    expect(response.status).toBe(400);
    expect(payload.error?.code).toBe('INVALID_REQUEST');
  });

  it('rejects a bitmap proof request for an index other than the session user vote', async () => {
    const { sessionId, capabilityToken } = await createSession();
    updateMockState((current) => {
      current.bulletinIndex = 0;
      current.voteId = '11111111-1111-4111-8111-111111111111';
    });
    completeFinalization();

    const response = mockApiFetch(
      `http://localhost/api/sessions/${sessionId}/finalizations/current/bitmap-proofs/included/1`,
      { headers: { 'X-Session-Capability': capabilityToken } },
    );
    const payload = (await response.json()) as MockErrorPayload;

    expect(response.status).toBe(400);
    expect(payload.error?.code).toBe('INVALID_BITMAP_PROOF_REQUEST');
  });

  it.each(['true', '1', 'yes'])(
    'strictly rejects private input selector %s on input commitment',
    async (includeData) => {
      const { sessionId, capabilityToken } = await createSession();
      const response = mockApiFetch(
        `http://localhost/api/sessions/${sessionId}/finalizations/current/input-commitment?includeData=${includeData}`,
        {
          headers: { 'X-Session-Capability': capabilityToken },
        },
      );
      const payload = (await response.json()) as MockErrorPayload;

      expect(response.status).toBe(400);
      expect(payload.error?.code).toBe('INVALID_REQUEST');
    },
  );

  it('accepts the verification resource with capability-only path authority', async () => {
    const { sessionId, capabilityToken } = await createSession();
    completeFinalization();

    const response = mockApiFetch(verificationUrl(sessionId), {
      method: 'GET',
      headers: {
        'X-Session-Capability': capabilityToken,
      },
    });

    expect(response.status).toBe(200);
    expect(VerificationResourceResponseSchema.safeParse(await response.json()).success).toBe(true);
  });

  it('does not let an obsolete identity header override verification path scope', async () => {
    const { sessionId, capabilityToken } = await createSession();
    completeFinalization();

    const response = mockApiFetch(verificationUrl('other-session'), {
      method: 'GET',
      headers: {
        'X-Session-ID': sessionId,
        'X-Session-Capability': capabilityToken,
      },
    });
    const payload = (await response.json()) as MockErrorPayload;

    expect(response.status).toBe(404);
    expect(payload.error?.code).toBe('SESSION_NOT_FOUND');
  });

  it('returns a canonical current journal for include=journal', async () => {
    const { sessionId, capabilityToken } = await createSession();
    completeFinalization();

    const response = mockApiFetch(`${verificationUrl(sessionId)}?include=journal`, {
      method: 'GET',
      headers: {
        'X-Session-Capability': capabilityToken,
      },
    });
    const payload = VerificationResourceResponseSchema.parse(await response.json());

    expect(response.status).toBe(200);
    expect(payload.data.availability).toBe('available');
    if (payload.data.availability !== 'available' || payload.data.journal.representation !== 'included') {
      throw new Error('Expected included verification journal');
    }
    expect(payload.data.journal.value.methodVersion).toBe(CURRENT_METHOD_VERSION);
    expect(payload.data.journal.value.bulletinRoot).toBe(payload.data.proofAuthority.bulletinRoot);
    expect(payload.data.journal.value.missingSlots).toBe(payload.data.proofAuthority.missingSlots);
    expect(payload.data.journal.value).not.toHaveProperty('missingIndices');
  });

  it('rejects undocumented verification query flags in browser mock mode', async () => {
    const response = mockApiFetch(
      `http://localhost/api/sessions/session-auth/finalizations/${MOCK_FINALIZATION_ID}/verification?includeJournal=1`,
    );
    const payload = (await response.json()) as MockErrorPayload;

    expect(response.status).toBe(400);
    expect(payload.error?.code).toBe('INVALID_REQUEST');
  });

  it('rejects unexpected bulletin query fields in browser mock mode', async () => {
    const { sessionId, capabilityToken } = await createSession();
    const response = mockApiFetch(`http://localhost/api/sessions/${sessionId}/bulletin?offset=0&unexpected=1`, {
      headers: { 'X-Session-Capability': capabilityToken },
    });
    const payload = (await response.json()) as MockErrorPayload;

    expect(response.status).toBe(400);
    expect(payload.error?.code).toBe('INVALID_REQUEST');
  });

  it('accepts zero-size consistency proofs in browser mock mode', async () => {
    const { sessionId, capabilityToken } = await createSession();

    const response = mockApiFetch(
      `http://localhost/api/sessions/${sessionId}/bulletin/consistency-proof?fromTreeSize=0&toTreeSize=0`,
      {
        headers: {
          'X-Session-Capability': capabilityToken,
        },
      },
    );
    const payload = (await response.json()) as { data?: { fromTreeSize?: number; toTreeSize?: number } };

    expect(response.status).toBe(200);
    expect(payload.data?.fromTreeSize).toBe(0);
    expect(payload.data?.toTreeSize).toBe(0);
  });

  it('returns a canonical current journal through the canonical finalization resource flow', async () => {
    const { sessionId, capabilityToken } = await createSession();
    const finalizeResponse = mockApiFetch(`http://localhost/api/sessions/${sessionId}/finalizations`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Session-Capability': capabilityToken,
      },
      body: JSON.stringify({ scenarioId: 'S0' }),
    });
    expect(finalizeResponse.status).toBe(202);
    const now = Date.now();
    updateMockState((current) => {
      current.finalizationQueuedAtMs = now - 22000;
      current.finalizationStartedAtMs = now - 20000;
      current.finalizationCompletedAtMs = now - 1000;
    });

    const statusResponse = mockApiFetch(`http://localhost/api/sessions/${sessionId}/finalizations/current`, {
      headers: {
        'X-Session-Capability': capabilityToken,
      },
    });
    const payload = (await statusResponse.json()) as {
      data?: {
        result?: {
          authority?: {
            journal?: {
              methodVersion?: number;
              bulletinRoot?: string;
              excludedSlots?: number;
              seenIndicesCount?: number;
            };
          };
          presentation?: {
            bulletinRoot?: string;
            excludedSlots?: number;
            seenIndicesCount?: number;
          };
        };
      };
    };
    const journal = payload.data?.result?.authority?.journal;
    const presentation = payload.data?.result?.presentation;

    expect(statusResponse.status).toBe(200);
    expect(journal?.methodVersion).toBe(CURRENT_METHOD_VERSION);
    expect(journal?.bulletinRoot).toBe(presentation?.bulletinRoot);
    expect(journal?.excludedSlots).toBe(presentation?.excludedSlots);
    expect(journal).not.toHaveProperty('excludedCount');
    expect(journal?.seenIndicesCount).toBe(presentation?.seenIndicesCount);
  });

  it('serves the S5 mock finalization and verification resources with current-contract metrics', async () => {
    const { sessionId, capabilityToken } = await createSession();

    const finalizeResponse = mockApiFetch(`http://localhost/api/sessions/${sessionId}/finalizations`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Session-Capability': capabilityToken,
      },
      body: JSON.stringify({ scenarioId: 'S5' }),
    });
    expect(finalizeResponse.status).toBe(202);

    const now = Date.now();
    updateMockState((current) => {
      current.finalizationQueuedAtMs = now - 22000;
      current.finalizationStartedAtMs = now - 20000;
      current.finalizationCompletedAtMs = now - 1000;
    });

    const statusResponse = mockApiFetch(`http://localhost/api/sessions/${sessionId}/finalizations/current`, {
      method: 'GET',
      headers: {
        'X-Session-Capability': capabilityToken,
      },
    });
    const statusPayload = (await statusResponse.json()) as {
      data?: {
        result?: {
          presentation?: {
            missingSlots?: number;
            excludedSlots?: number;
          };
          authority?: {
            journal?: {
              validVotes?: number;
            };
          };
        } | null;
      };
    };
    const statusResult = statusPayload.data?.result;

    expect(statusResponse.status).toBe(200);
    expect(statusResult?.presentation?.missingSlots).toBe(4);
    expect(statusResult?.authority?.journal?.validVotes).toBe(60);
    expect(statusResult?.presentation?.excludedSlots).toBe(4);

    const verificationResponse = mockApiFetch(verificationUrl(sessionId), {
      method: 'GET',
      headers: {
        'X-Session-Capability': capabilityToken,
      },
    });
    const verificationPayload = VerificationResourceResponseSchema.parse(await verificationResponse.json());

    expect(verificationResponse.status).toBe(200);
    expect(verificationPayload.data.availability).toBe('available');
    if (verificationPayload.data.availability !== 'available') {
      throw new Error('Expected available S5 verification resource');
    }
    expect(verificationPayload.data.proofAuthority.missingSlots).toBe(4);
    expect(verificationPayload.data.proofAuthority.verifiedTally.reduce((sum, count) => sum + count, 0)).toBe(60);
    expect(verificationPayload.data.proofAuthority.excludedSlots).toBe(4);
    expect(verificationPayload.data.presentation.policy.fullyVerifiedLabelEligible).toBe(false);
  });
});
