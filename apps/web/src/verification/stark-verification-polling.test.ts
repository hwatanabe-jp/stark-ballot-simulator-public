import { admitSessionIdentity } from '@stark-ballot/web/session/identity';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VerificationStatus } from '@stark-ballot/verification/shared/types';
import {
  VERIFICATION_CHECK_DEFINITIONS,
  getVerificationStepInputs,
  type VerificationCheck,
} from '@stark-ballot/verification/checks';
import { deriveVerificationPresentationPolicy } from '@stark-ballot/verification/presentation-policy';
import { resolveCanonicalFinalizationPayload } from '@stark-ballot/web/finalize/client-finalization-result';
import verificationFixture from '@stark-ballot/web/mock-api/fixtures/json/verification.get.S0.json';
import { createTestJournal } from '@stark-ballot/test-support/testing/test-helpers';
import {
  getStarkVerificationSnapshot,
  startStarkVerificationPolling,
  stopStarkVerificationPolling,
} from './stark-verification-polling';

vi.mock('@stark-ballot/web/api/apiFetch', () => ({
  apiFetch: vi.fn(),
}));

vi.mock('@stark-ballot/web/api/apiBaseUrl', () => ({
  resolveApiUrl: (path: string) => path,
}));

vi.mock('@stark-ballot/web/session', () => ({
  captureSessionIdentity: vi.fn((session?: { sessionId?: string; capabilityToken?: string } | null) =>
    session?.sessionId && session.capabilityToken
      ? admitSessionIdentity({ sessionId: session.sessionId, capabilityToken: session.capabilityToken })
      : null,
  ),
  clearSession: vi.fn(),
  getSessionData: vi.fn(),
}));

const apiModule = await import('@stark-ballot/web/api/apiFetch');
const sessionModule = await import('@stark-ballot/web/session');
const mockApiFetch = vi.mocked(apiModule.apiFetch);
const mockGetSessionData = vi.mocked(sessionModule.getSessionData);

const HEX_A = `0x${'a'.repeat(64)}`;
const HEX_B = `0x${'b'.repeat(64)}`;
const HEX_C = `0x${'c'.repeat(64)}`;
const VERIFICATION_STEP_IDS = [
  'cast_as_intended',
  'recorded_as_cast',
  'counted_as_recorded',
  'stark_verification',
] as const;
const ZK_GATE_CHECK_IDS = new Set<VerificationCheck['id']>([
  'counted_tally_consistent',
  'counted_missing_indices_zero',
  'counted_expected_vs_tree_size',
  'counted_election_manifest_consistent',
  'counted_close_statement_consistent',
  'counted_my_vote_included',
  'counted_input_commitment_match',
]);

function response(data: unknown, status = 200): Response {
  return new Response(
    JSON.stringify({
      data,
      meta: { requestId: 'request-1' },
    }),
    { status },
  );
}

function verificationResource(status: VerificationStatus) {
  const checks: VerificationCheck[] = VERIFICATION_CHECK_DEFINITIONS.map((definition) => {
    let checkStatus: VerificationCheck['status'] = 'success';
    if (definition.category === 'cast_as_intended') {
      checkStatus = 'not_run';
    } else if (definition.id === 'stark_image_id_match') {
      checkStatus = status === 'running' ? 'running' : 'not_run';
    } else if (definition.id === 'stark_receipt_verify') {
      checkStatus = status === 'dev_mode' ? 'success' : status;
    } else if (status === 'running' && ZK_GATE_CHECK_IDS.has(definition.id)) {
      checkStatus = 'pending';
    }

    return {
      id: definition.id,
      status: checkStatus,
      evidence: definition.evidence,
      inputs: [...definition.inputs],
      ...(definition.derivedFrom ? { derivedFrom: definition.derivedFrom } : {}),
    };
  });
  const policy = deriveVerificationPresentationPolicy({
    availability: 'available',
    checks,
    context: {
      missingSlots: 0,
      invalidPresentedSlots: 0,
      rejectedRecords: 0,
      excludedSlots: 0,
      sthSourcesConfigured: true,
    },
    verificationStatus: status,
  });

  return {
    ...verificationFixture.data,
    finalizationId: 'finalization-1',
    presentation: {
      ...verificationFixture.data.presentation,
      policy,
    },
    verifierResult: { status },
    verification: {
      checks,
      steps: VERIFICATION_STEP_IDS.map((id) => ({
        id,
        status: policy.stageStatuses[id],
        inputs: getVerificationStepInputs(id),
      })),
    },
  };
}

function createSessionWithFinalization(finalizationId = 'finalization-1') {
  const finalizeResult = resolveCanonicalFinalizationPayload({
    finalizationId,
    tally: {
      counts: { A: 1, B: 0, C: 0, D: 0, E: 0 },
      totalVotes: 1,
      tamperedCount: 0,
    },
    imageId: HEX_C,
    journal: createTestJournal({
      totalExpected: 1,
      validVotes: 1,
      missingSlots: 0,
      invalidPresentedSlots: 0,
      seenIndicesCount: 1,
    }),
  });
  if (!finalizeResult) {
    throw new Error('Failed to build finalization fixture');
  }
  return {
    ...admitSessionIdentity({ sessionId: 'session-1', capabilityToken: 'test-capability-token' }),
    electionId: '550e8400-e29b-41d4-a716-446655440000',
    electionConfigHash: HEX_A,
    logId: HEX_B,
    lastActivity: 1,
    expiresAt: 86_400_001,
    phase: 'verifying' as const,
    finalizeResult,
  };
}

describe('stark-verification-polling', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockApiFetch.mockReset();
    mockGetSessionData.mockReset();
    mockGetSessionData.mockReturnValue(createSessionWithFinalization());
  });

  afterEach(async () => {
    stopStarkVerificationPolling();
    await vi.runOnlyPendingTimersAsync();
    vi.useRealTimers();
  });

  it('polls the exact finalization path until a terminal resource arrives', async () => {
    const resources = [verificationResource('running'), verificationResource('success')];
    mockApiFetch.mockImplementation(() => Promise.resolve(response(resources.shift())));

    startStarkVerificationPolling({
      sessionId: 'session-1',
      finalizationId: 'finalization-1',
      intervalMs: 10,
      timeoutMs: 1000,
    });
    await vi.runAllTimersAsync();

    expect(mockApiFetch).toHaveBeenCalledTimes(2);
    expect(mockApiFetch).toHaveBeenCalledWith('/api/sessions/session-1/finalizations/finalization-1/verification', {
      headers: { 'X-Session-Capability': 'test-capability-token' },
      method: 'GET',
    });
    expect(getStarkVerificationSnapshot()).toMatchObject({
      sessionId: 'session-1',
      finalizationId: 'finalization-1',
      status: 'success',
      payload: { availability: 'available' },
    });
  });

  it('publishes unavailable data as a terminal fail-closed snapshot', async () => {
    mockApiFetch.mockResolvedValue(
      response({
        availability: 'unavailable',
        finalizationId: 'finalization-1',
        reason: 'finalization_not_current',
        message: 'Unsupported artifact',
      }),
    );

    startStarkVerificationPolling({
      sessionId: 'session-1',
      finalizationId: 'finalization-1',
      intervalMs: 10,
      timeoutMs: 1000,
    });
    await vi.runAllTimersAsync();

    expect(mockApiFetch).toHaveBeenCalledOnce();
    expect(getStarkVerificationSnapshot()).toMatchObject({
      status: 'failed',
      payload: { availability: 'unavailable' },
    });
  });

  it('turns a malformed successful response into a terminal corrupt snapshot', async () => {
    mockApiFetch.mockResolvedValue(response({ verificationStatus: 'success' }));

    startStarkVerificationPolling({
      sessionId: 'session-1',
      finalizationId: 'finalization-1',
      intervalMs: 10,
      timeoutMs: 1000,
    });
    await vi.runAllTimersAsync();

    expect(mockApiFetch).toHaveBeenCalledOnce();
    expect(getStarkVerificationSnapshot()).toMatchObject({
      status: 'failed',
      payload: {
        availability: 'corrupt',
        finalizationId: 'finalization-1',
      },
    });
  });

  it('does not poll when browser authority names another finalization', async () => {
    mockGetSessionData.mockReturnValue(createSessionWithFinalization('finalization-2'));

    startStarkVerificationPolling({
      sessionId: 'session-1',
      finalizationId: 'finalization-1',
      intervalMs: 10,
      timeoutMs: 1000,
    });
    await vi.runAllTimersAsync();

    expect(mockApiFetch).not.toHaveBeenCalled();
  });
});
