import { beforeEach, describe, expect, it, vi } from 'vitest';
import sessionFixture from '@stark-ballot/web/mock-api/fixtures/json/sessions.post.json';
import voteFixture from '@stark-ballot/web/mock-api/fixtures/json/sessions.votes.post.json';
import progressFixture from '@stark-ballot/web/mock-api/fixtures/json/sessions.progress.get.json';
import verificationRunFixture from '@stark-ballot/web/mock-api/fixtures/json/verification.post.json';
import { apiFetch } from './apiFetch';
import { createSession } from './sessions';
import { submitVote } from './votes';
import { getProgress } from './progress';
import { getBulletin, getBulletinConsistencyProof, getBulletinVoteProof, getSameOriginSth } from './bulletin';
import { cancelFinalization, fetchCurrentFinalization, startFinalization } from './finalizations';
import { getVerification, recordVerificationObservation, runVerification } from './verification';
import { getBitmapProof, getInputCommitment } from './artifacts';
import { deriveVerificationPresentationPolicy } from '@stark-ballot/verification/presentation-policy';
import { resolveEligibleRenderedVerificationStatus } from '@stark-ballot/web/routes/verify/lib/verification-presentation';

vi.mock('./apiFetch', () => ({
  apiFetch: vi.fn(),
}));

const SESSION = {
  sessionId: 'session/one',
  capabilityToken: 'capability-token',
};
const requestMeta = { requestId: 'request-id' } as const;
const HEX_A = `0x${'a'.repeat(64)}`;
const HEX_B = `0x${'b'.repeat(64)}`;
const HEX_C = `0x${'c'.repeat(64)}`;
const HEX_D = `0x${'d'.repeat(64)}`;
const HEX_E = `0x${'e'.repeat(64)}`;
const HEX_F = `0x${'f'.repeat(64)}`;
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
    availability: 'available' as const,
    finalizationId,
    proofAuthority: {
      electionId: 'election-1',
      electionConfigHash: HEX_A,
      logId: HEX_B,
      imageId: HEX_C,
      bulletinRoot: HEX_D,
      verifiedTally: [1, 0, 0, 0, 0],
      missingSlots: 0,
      invalidPresentedSlots: 0,
      rejectedRecords: 0,
      totalExpected: 1,
      treeSize: 1,
      excludedSlots: 0,
      sthDigest: HEX_E,
      includedBitmapRoot: HEX_F,
      inputCommitment: HEX_A,
      seenIndicesCount: 1,
    },
    presentation: {
      tally: {
        counts: { A: 1, B: 0, C: 0, D: 0, E: 0 },
        totalVotes: 1,
        tamperedCount: 0,
      },
      scenarioId: 'S0' as const,
      policy: {
        summary: {
          status: 'fully_verified' as const,
          tone: 'verified' as const,
        },
        stageStatuses: {
          cast_as_intended: 'success' as const,
          recorded_as_cast: 'success' as const,
          counted_as_recorded: 'success' as const,
          stark_verification: 'success' as const,
        },
        evidenceFullyVerified: true,
        fullyVerifiedLabelEligible: true,
        display: {
          readiness: 'ready' as const,
          source: 'summary' as const,
          status: 'verified' as const,
          renderedStatus: 'verified' as const,
        },
        publishedTallyMismatch: false,
        devModeEvidence: false,
        missingEvidence: false,
      },
    },
    verifierResult: {
      status: 'success' as const,
    },
    verification: {
      checks: [],
      steps: [],
    },
    voterEvidence: {
      availability: 'unavailable' as const,
      reason: 'exact_proof_unavailable' as const,
      userVote: {
        commitment: HEX_B,
      },
    },
    journal: {
      representation: 'omitted' as const,
    },
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

  it('serializes parsed bulletin query values through the route contract', async () => {
    const payload = {
      commitments: [],
      bulletinRoot: `0x${'0'.repeat(64)}`,
      treeSize: 0,
      generatedAtMs: 0,
    };
    vi.mocked(apiFetch).mockResolvedValue(
      jsonResponse({
        data: payload,
        meta: {
          ...requestMeta,
          page: {
            nextOffset: null,
            hasMore: false,
          },
        },
      }),
    );

    const result = await getBulletin(SESSION, { offset: 2, limit: 50 });

    expect(apiFetch).toHaveBeenCalledWith('/api/sessions/session%2Fone/bulletin?offset=2&limit=50', {
      headers: {
        'X-Session-Capability': SESSION.capabilityToken,
      },
      method: 'GET',
    });
    expect(result).toEqual({
      data: payload,
      page: {
        nextOffset: null,
        hasMore: false,
      },
    });
  });

  it('uses canonical bulletin proof routes with path-scoped session authority', async () => {
    const hex = `0x${'a'.repeat(64)}`;
    vi.mocked(apiFetch)
      .mockResolvedValueOnce(
        jsonResponse(
          successEnvelope({
            voteId: 'vote/one',
            proof: {
              leafIndex: 0,
              merklePath: [],
              treeSize: 1,
              bulletinRootAtCast: hex,
            },
          }),
        ),
      )
      .mockResolvedValueOnce(
        jsonResponse(
          successEnvelope({
            fromTreeSize: 0,
            toTreeSize: 1,
            rootAtFromTreeSize: hex,
            rootAtToTreeSize: hex,
            proofNodes: [],
            generatedAtMs: 1,
          }),
        ),
      );

    await getBulletinVoteProof(SESSION, 'vote/one');
    await getBulletinConsistencyProof(SESSION, { fromTreeSize: 0, toTreeSize: 1 });

    expect(apiFetch).toHaveBeenNthCalledWith(1, '/api/sessions/session%2Fone/votes/vote%2Fone/inclusion-proof', {
      headers: {
        'X-Session-Capability': SESSION.capabilityToken,
      },
      method: 'GET',
    });
    expect(apiFetch).toHaveBeenNthCalledWith(
      2,
      '/api/sessions/session%2Fone/bulletin/consistency-proof?fromTreeSize=0&toTreeSize=1',
      {
        headers: {
          'X-Session-Capability': SESSION.capabilityToken,
        },
        method: 'GET',
      },
    );
  });

  it('uses canonical finalization evidence routes and their declared capability scopes', async () => {
    const hex = `0x${'a'.repeat(64)}`;
    vi.mocked(apiFetch)
      .mockResolvedValueOnce(
        jsonResponse(
          successEnvelope({
            sth: {
              sthDigest: hex,
              bulletinRoot: hex,
              treeSize: 1,
              timestamp: 1,
              logId: 'log-1',
            },
          }),
        ),
      )
      .mockResolvedValueOnce(jsonResponse(successEnvelope({ leafChunk: hex, auditPath: [] })))
      .mockResolvedValueOnce(jsonResponse(successEnvelope({ inputCommitment: hex })));

    await getSameOriginSth(SESSION, { auditorId: 'browser' });
    await getBitmapProof(SESSION, { kind: 'seen', voteIndex: 3 });
    await getInputCommitment(SESSION);

    expect(apiFetch).toHaveBeenNthCalledWith(1, '/api/sessions/session%2Fone/bulletin/sth?auditorId=browser', {
      headers: {
        'X-Session-Capability': SESSION.capabilityToken,
      },
      method: 'GET',
    });
    expect(apiFetch).toHaveBeenNthCalledWith(
      2,
      '/api/sessions/session%2Fone/finalizations/current/bitmap-proofs/seen/3',
      {
        headers: {
          'X-Session-Capability': SESSION.capabilityToken,
        },
        method: 'GET',
      },
    );
    expect(apiFetch).toHaveBeenNthCalledWith(3, '/api/sessions/session%2Fone/finalizations/current/input-commitment', {
      headers: {
        'X-Session-Capability': SESSION.capabilityToken,
      },
      method: 'GET',
    });
  });

  it('does not resolve the same-origin STH client against an external base URL', async () => {
    const hex = `0x${'a'.repeat(64)}`;
    vi.mocked(apiFetch).mockResolvedValue(
      jsonResponse(
        successEnvelope({
          sth: {
            sthDigest: hex,
            bulletinRoot: hex,
            treeSize: 1,
            timestamp: 1,
            logId: 'log-1',
          },
        }),
      ),
    );
    await expect(getSameOriginSth(SESSION, {}, { baseUrl: 'https://auditor.example' })).rejects.toThrow(
      'Same-origin STH requests cannot override the API base URL',
    );
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it('sends a conditional bitmap request and admits an empty-body 304', async () => {
    vi.mocked(apiFetch).mockResolvedValue(
      new Response(null, {
        status: 304,
        headers: { ETag: 'W/"bitmap-etag"' },
      }),
    );

    const result = await getBitmapProof(
      SESSION,
      { kind: 'included', voteIndex: 3 },
      { ifNoneMatch: 'W/"bitmap-etag"' },
    );

    expect(result).toEqual({ status: 304, etag: 'W/"bitmap-etag"' });
    expect(apiFetch).toHaveBeenCalledWith(
      '/api/sessions/session%2Fone/finalizations/current/bitmap-proofs/included/3',
      {
        headers: {
          'If-None-Match': 'W/"bitmap-etag"',
          'X-Session-Capability': SESSION.capabilityToken,
        },
        method: 'GET',
      },
    );
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
