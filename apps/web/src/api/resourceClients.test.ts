import { admitSessionIdentity } from '@stark-ballot/web/session/identity';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import sessionFixture from '@stark-ballot/web/mock-api/fixtures/json/sessions.post.json';
import voteFixture from '@stark-ballot/web/mock-api/fixtures/json/sessions.votes.post.json';
import progressFixture from '@stark-ballot/web/mock-api/fixtures/json/sessions.progress.get.json';
import verificationRunFixture from '@stark-ballot/web/mock-api/fixtures/json/verification.post.json';
import verificationFixture from '@stark-ballot/web/mock-api/fixtures/json/verification.get.S0.json';
import { apiFetch } from './apiFetch';
import { createSession } from './sessions';
import { submitVote } from './votes';
import { getProgress } from './progress';
import { cancelFinalization, fetchCurrentFinalization, startFinalization } from './finalizations';
import { getVerification, recordVerificationObservation, runVerification } from './verification';
import { deriveVerificationPresentationPolicy } from '@stark-ballot/verification/presentation-policy';
import { resolveEligibleRenderedVerificationStatus } from '@stark-ballot/web/routes/verify/lib/verification-presentation';

vi.mock('./apiFetch', () => ({
  apiFetch: vi.fn(),
}));

const SESSION = admitSessionIdentity({ sessionId: 'session/one', capabilityToken: 'capability-token' });
const requestMeta = { requestId: 'request-id' } as const;
const pendingFinalization = {
  finalizationId: 'finalization-1',
  status: 'pending' as const,
  queuedAtMs: 1730000000000,
  runtimeDiagnostics: {
    asyncMode: 'enabled' as const,
    queue: {
      concurrencyLimit: 2,
      estimatedDurationMs: 360000,
    },
  },
};

function successEnvelope<T>(data: T) {
  return { data, meta: requestMeta };
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function availableVerificationData(finalizationId: string) {
  return {
    ...verificationFixture.data,
    finalizationId,
  };
}

describe('web API resource clients', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('creates a session through the canonical path and admits the response', async () => {
    vi.mocked(apiFetch).mockResolvedValue(jsonResponse(successEnvelope(sessionFixture.data)));

    const result = await createSession({});

    expect(apiFetch).toHaveBeenCalledWith('/api/sessions', {
      body: '{}',
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
    });
    expect(result).toEqual(sessionFixture.data);
  });

  it('submits a vote with path-scoped session authority', async () => {
    vi.mocked(apiFetch).mockResolvedValue(jsonResponse(successEnvelope(voteFixture.data)));
    const body = {
      commitment: `0x${'1'.repeat(64)}`,
      vote: 'A' as const,
      rand: `0x${'2'.repeat(64)}`,
    };

    const result = await submitVote(SESSION, body);

    expect(apiFetch).toHaveBeenCalledWith('/api/sessions/session%2Fone/votes', {
      body: JSON.stringify(body),
      headers: {
        'Content-Type': 'application/json',
        'X-Session-Capability': SESSION.capabilityToken,
      },
      method: 'POST',
    });
    expect(result).toEqual(voteFixture.data);
  });

  it('reads progress and admits the complete resource payload', async () => {
    vi.mocked(apiFetch).mockResolvedValue(jsonResponse(successEnvelope(progressFixture.data)));

    const result = await getProgress(SESSION);

    expect(apiFetch).toHaveBeenCalledWith('/api/sessions/session%2Fone/progress', {
      headers: {
        'X-Session-Capability': SESSION.capabilityToken,
      },
      method: 'GET',
    });
    expect(result).toEqual(progressFixture.data);
  });

  it('uses encoded path authority and only the declared capability header for current finalization', async () => {
    vi.mocked(apiFetch).mockResolvedValue(jsonResponse(successEnvelope(pendingFinalization)));

    const result = await fetchCurrentFinalization(SESSION);

    expect(apiFetch).toHaveBeenCalledWith('/api/sessions/session%2Fone/finalizations/current', {
      headers: {
        'X-Session-Capability': SESSION.capabilityToken,
      },
      method: 'GET',
    });
    expect(result).toEqual(pendingFinalization);
  });

  it('returns a status-discriminated accepted finalization', async () => {
    vi.mocked(apiFetch).mockResolvedValue(jsonResponse(successEnvelope(pendingFinalization), 202));

    const result = await startFinalization(SESSION, { scenarioId: 'S0' });

    expect(apiFetch).toHaveBeenCalledWith('/api/sessions/session%2Fone/finalizations', {
      body: JSON.stringify({ scenarioId: 'S0' }),
      headers: {
        'Content-Type': 'application/json',
        'X-Session-Capability': SESSION.capabilityToken,
      },
      method: 'POST',
    });
    expect(result).toEqual({ status: 202, data: pendingFinalization });
  });

  it('rejects an undeclared successful finalization status', async () => {
    vi.mocked(apiFetch).mockResolvedValue(jsonResponse(successEnvelope(pendingFinalization), 201));

    await expect(startFinalization(SESSION, { scenarioId: 'S0' })).rejects.toThrow(
      'Undeclared response status 201 for sessions.finalizations.post',
    );
  });

  it('cancels by canonical resource path without repeating the finalization ID in the body', async () => {
    const failedFinalization = {
      ...pendingFinalization,
      status: 'failed' as const,
      failedAtMs: 1730000005000,
      error: { code: 'USER_CANCELLED', message: 'Cancelled by user request' },
    };
    vi.mocked(apiFetch).mockResolvedValue(jsonResponse(successEnvelope(failedFinalization)));

    await expect(cancelFinalization(SESSION, 'finalization-one', { reason: 'operator request' })).resolves.toEqual(
      failedFinalization,
    );
    expect(apiFetch).toHaveBeenCalledWith('/api/sessions/session%2Fone/finalizations/finalization-one/cancel', {
      body: JSON.stringify({ reason: 'operator request' }),
      headers: {
        'Content-Type': 'application/json',
        'X-Session-Capability': SESSION.capabilityToken,
      },
      method: 'POST',
    });
  });

  it('admits available and fail-closed verification resources at the shared 200 status', async () => {
    const verificationData = availableVerificationData('finalization-1');
    vi.mocked(apiFetch)
      .mockResolvedValueOnce(jsonResponse(successEnvelope(verificationData)))
      .mockResolvedValueOnce(
        jsonResponse(
          successEnvelope({
            availability: 'unavailable',
            finalizationId: 'finalization-1',
            message: 'Unsupported finalized state',
            reason: 'finalization_not_current',
          }),
        ),
      );

    const normal = await getVerification(SESSION, 'finalization-1');
    const failClosed = await getVerification(SESSION, 'finalization-1');

    expect(normal.availability).toBe('available');
    expect(failClosed).toEqual({
      availability: 'unavailable',
      finalizationId: 'finalization-1',
      message: 'Unsupported finalized state',
      reason: 'finalization_not_current',
    });
  });

  it('maps an unknown verification response to corrupt input that cannot render Verified', async () => {
    vi.mocked(apiFetch).mockResolvedValue(
      jsonResponse(
        successEnvelope({
          availability: 'future-success',
          finalizationId: 'finalization-1',
          fullyVerifiedLabelEligible: true,
        }),
      ),
    );

    const resource = await getVerification(SESSION, 'finalization-1');
    const policy = deriveVerificationPresentationPolicy({
      availability: resource.availability,
      verificationStarted: true,
      sequenceComplete: true,
    });

    expect(resource).toMatchObject({
      availability: 'corrupt',
      finalizationId: 'finalization-1',
      reason: 'invalid_artifact',
    });
    expect(policy.fullyVerifiedLabelEligible).toBe(false);
    expect(resolveEligibleRenderedVerificationStatus(policy)).not.toBe('verified');
  });

  it('uses finalization-scoped verification routes with capability-only path authority', async () => {
    const verificationData = availableVerificationData('finalization-one');
    const observation = {
      castChecks: {
        cast_receipt_present: 'success' as const,
        cast_choice_range: 'success' as const,
        cast_random_format: 'success' as const,
        cast_commitment_match: 'success' as const,
      },
    };
    vi.mocked(apiFetch)
      .mockResolvedValueOnce(jsonResponse(successEnvelope(verificationData)))
      .mockResolvedValueOnce(
        jsonResponse(successEnvelope({ ...verificationRunFixture.data, finalizationId: 'finalization-one' })),
      )
      .mockResolvedValueOnce(jsonResponse(successEnvelope({ status: 'recorded' })));

    await getVerification(SESSION, 'finalization-one', { include: 'journal' });
    await runVerification(SESSION, 'finalization-one');
    await recordVerificationObservation(SESSION, 'finalization-one', observation);

    expect(apiFetch).toHaveBeenNthCalledWith(
      1,
      '/api/sessions/session%2Fone/finalizations/finalization-one/verification?include=journal',
      {
        headers: {
          'X-Session-Capability': SESSION.capabilityToken,
        },
        method: 'GET',
      },
    );
    expect(apiFetch).toHaveBeenNthCalledWith(
      2,
      '/api/sessions/session%2Fone/finalizations/finalization-one/verification',
      {
        body: '{}',
        headers: {
          'Content-Type': 'application/json',
          'X-Session-Capability': SESSION.capabilityToken,
        },
        method: 'POST',
      },
    );
    expect(apiFetch).toHaveBeenNthCalledWith(
      3,
      '/api/sessions/session%2Fone/finalizations/finalization-one/verification/observations',
      {
        body: JSON.stringify(observation),
        headers: {
          'Content-Type': 'application/json',
          'X-Session-Capability': SESSION.capabilityToken,
        },
        method: 'POST',
      },
    );
  });

  it('admits verification-run success before returning it to callers', async () => {
    const runData = { ...verificationRunFixture.data } as Record<string, unknown>;
    runData['finalizationId'] = 'mock-finalization-001';
    vi.mocked(apiFetch)
      .mockResolvedValueOnce(jsonResponse(successEnvelope(runData)))
      .mockResolvedValueOnce(jsonResponse(successEnvelope({ verificationStatus: 'running' })));

    await expect(runVerification(SESSION, 'mock-finalization-001')).resolves.toEqual(runData);
    await expect(runVerification(SESSION, 'mock-finalization-001')).rejects.toThrow(
      'Invalid verification run response payload',
    );
  });
});
