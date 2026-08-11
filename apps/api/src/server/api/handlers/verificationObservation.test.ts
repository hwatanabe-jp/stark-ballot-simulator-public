import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { createSessionCapabilityToken } from '@stark-ballot/domain/security/sessionCapabilityToken';
import { SESSION_CAPABILITY_HEADER } from '@stark-ballot/domain/session/capability';
import { SimpleBulletinBoard } from '@stark-ballot/domain/bulletin/simple-bulletin-board';
import type {
  RecordVerificationObservationResult,
  VerificationObservationWrite,
} from '@stark-ballot/domain/types/verificationObservation';
import type { SessionReadModel } from '@stark-ballot/application/session/session-read-model';
import type { FinalizationResultAuthority } from '@stark-ballot/application/finalize/finalization-types';
import {
  VERIFICATION_CHECK_DEFINITIONS,
  type VerificationCheck,
  type VerificationCheckId,
} from '@stark-ballot/verification/checks';
import type { VerificationResult } from '@stark-ballot/verification/shared/types';
import type { VerificationObservationRequest } from '@stark-ballot/api-contract/schemas/verification';
import type { verificationRoute } from '@stark-ballot/api-contract/routes';
import { createTestJournal } from '@stark-ballot/test-support/testing/test-helpers';
import { createMockVoteStore, type MockVoteStore } from '../../__tests__/support/mockVoteStore';
import { localRuntimeProfile } from '@stark-ballot/runtime-config/env/__tests__/runtimeProfileFixtures';
import {
  getApiErrorCode,
  readJsonRecord,
  requireDataRecord,
} from '@stark-ballot/test-support/testing/response-helpers';
import { getStringProperty } from '@stark-ballot/validation/unknown-value-guards';
import type { ApiHandlerArguments, SessionAdmittedContext } from '../context';
import type { VerificationRunSummaryObservationInput } from './verificationObservability';

const dependencyMocks = vi.hoisted(() => ({
  getVerifyHandler:
    vi.fn<(arguments_: ApiHandlerArguments<typeof verificationRoute, SessionAdmittedContext>) => Promise<Response>>(),
  emitVerificationRunSummaryObservation: vi.fn<(input: VerificationRunSummaryObservationInput) => void>(),
}));

vi.mock('./verify', () => ({
  getVerifyHandler: dependencyMocks.getVerifyHandler,
}));

vi.mock('./verificationObservability', async (importOriginal) => {
  const original = await importOriginal<typeof import('./verificationObservability')>();
  return {
    ...original,
    emitVerificationRunSummaryObservation: dependencyMocks.emitVerificationRunSummaryObservation,
  };
});

import { buildObservedVerificationChecks, submitVerificationObservationHandler } from './verificationObservation';

const capabilitySecret = 'verification-observation-secret-0123456789abcdef';
const sessionId = 'session-verification-observation-1';
const finalizationId = 'execution-verification-observation-1';
const hex = `0x${'12'.repeat(32)}`;

const castStatuses = {
  cast_receipt_present: 'success',
  cast_choice_range: 'failed',
  cast_random_format: 'not_run',
  cast_commitment_match: 'success',
} as const;

function strictDefined<T>(value: T, label = 'value'): NonNullable<T> {
  if (value === undefined || value === null) {
    throw new Error(`Expected ${label} to be defined`);
  }
  return value;
}

function buildChecks(
  overrides: Partial<Record<VerificationCheckId, VerificationCheck['status']>> = {},
): VerificationCheck[] {
  return VERIFICATION_CHECK_DEFINITIONS.map((definition) => ({
    id: definition.id,
    status: overrides[definition.id] ?? (definition.id.startsWith('cast_') ? 'not_run' : 'success'),
    evidence: definition.evidence,
    inputs: definition.inputs,
    ...(definition.derivedFrom ? { derivedFrom: definition.derivedFrom } : {}),
  }));
}

function buildFinalizationResult(): FinalizationResultAuthority {
  const journal = createTestJournal({
    validVotes: 1,
    totalExpected: 1,
    seenIndicesCount: 1,
  });
  return {
    tally: {
      counts: { A: 1, B: 0, C: 0, D: 0, E: 0 },
      totalVotes: 1,
      tamperedCount: 0,
    },
    imageId: hex,
    journal,
    scenarios: ['S2'],
  };
}

function buildVerificationResult(devMode = false): VerificationResult {
  return {
    status: devMode ? 'dev_mode' : 'success',
    report: {
      status: devMode ? 'dev_mode' : 'success',
      verifier_version: '0.1.0',
      verified_at: '2026-07-28T00:00:00.000Z',
      duration_ms: 42,
      expected_image_id: hex,
      receipt_image_id: hex,
      dev_mode_receipt: devMode,
      errors: [],
    },
  };
}

function buildSession(): SessionReadModel {
  const now = Date.now();
  return {
    identity: {
      sessionId,
      electionId: '550e8400-e29b-41d4-a716-446655440000',
      electionConfigHash: hex,
      electionConfig: {
        totalExpected: 1,
        choices: ['A', 'B', 'C', 'D', 'E'],
        version: '1.0',
        botCount: 0,
        merkleTreeDepth: 1,
      },
      logId: hex,
      createdAtMs: now,
    },
    voting: {
      sessionId,
      votes: new Map(),
      bulletin: new SimpleBulletinBoard(hex),
      bulletinRootHistory: [],
      botCount: 0,
      userParticipation: { status: 'not_cast' },
      lastActivityMs: now,
    },
    finalization: {
      sessionId,
      finalizationId,
      scenarioContext: {
        scenarios: ['S2'],
        tamperMode: 'claim',
        claimedCounts: { A: 1, B: 0, C: 0, D: 0, E: 0 },
        claimedTotalVotes: 1,
        summary: {
          ignoredCount: 0,
          recountedCount: 1,
          userRecountChoice: null,
        },
      },
      state: {
        status: 'succeeded',
        finalizationId,
        queuedAtMs: now - 2_000,
        startedAtMs: now - 1_000,
        completedAtMs: now,
      },
      finalizationResult: {
        finalizationId,
        ...buildFinalizationResult(),
      },
    },
  };
}

function createObservationStore(
  overrides: Partial<MockVoteStore> = {},
  verificationResult: VerificationResult = buildVerificationResult(),
): MockVoteStore {
  return createMockVoteStore({
    getVerificationResultRecord: () =>
      Promise.resolve({
        sessionId,
        finalizationId,
        verificationResult,
      }),
    ...overrides,
  });
}

function buildVerifyResponse(checks = buildChecks()): Response {
  return new Response(
    JSON.stringify({
      data: {
        availability: 'available',
        finalizationId,
        proofAuthority: {
          electionId: 'election-1',
          electionConfigHash: hex,
          logId: 'log-1',
          bulletinRoot: hex,
          imageId: hex,
          verifiedTally: [1, 0, 0, 0, 0],
          missingSlots: 0,
          invalidPresentedSlots: 0,
          rejectedRecords: 0,
          totalExpected: 1,
          treeSize: 1,
          excludedSlots: 0,
          sthDigest: hex,
          includedBitmapRoot: hex,
          inputCommitment: hex,
          seenIndicesCount: 1,
        },
        presentation: {
          tally: {
            counts: { A: 1, B: 0, C: 0, D: 0, E: 0 },
            totalVotes: 1,
            tamperedCount: 0,
          },
          scenarioId: 'S2',
          tamperDetected: true,
          policy: {
            summary: {
              status: 'published_tally_mismatch',
              tone: 'failed',
            },
            stageStatuses: {
              cast_as_intended: 'not_run',
              recorded_as_cast: 'success',
              counted_as_recorded: 'success',
              stark_verification: 'success',
            },
            evidenceFullyVerified: false,
            fullyVerifiedLabelEligible: false,
            display: {
              readiness: 'ready',
              source: 'summary',
              status: 'failed',
              renderedStatus: 'failed',
            },
            publishedTallyMismatch: true,
            devModeEvidence: false,
            missingEvidence: false,
          },
        },
        verifierResult: {
          status: 'success',
        },
        verification: {
          checks,
          steps: [
            { id: 'cast_as_intended', status: 'not_run' },
            { id: 'recorded_as_cast', status: 'success' },
            { id: 'counted_as_recorded', status: 'success' },
            { id: 'stark_verification', status: 'success' },
          ],
        },
        voterEvidence: {
          availability: 'unavailable',
          reason: 'exact_proof_unavailable',
          userVote: {
            commitment: hex,
          },
        },
        journal: {
          representation: 'omitted',
        },
      },
      meta: {
        requestId: 'verification-observation-verify-request',
      },
    }),
    {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    },
  );
}

async function invokeObservation(
  store: MockVoteStore,
  requestedFinalizationId = finalizationId,
  overrides: Partial<VerificationObservationRequest> = {},
  session: SessionReadModel = buildSession(),
): Promise<Response> {
  const body: VerificationObservationRequest = {
    castChecks: castStatuses,
    ...overrides,
  };

  return submitVerificationObservationHandler({
    input: {
      params: {
        sessionId,
        finalizationId: requestedFinalizationId,
      },
      headers: {
        [SESSION_CAPABILITY_HEADER]: createSessionCapabilityToken({ sessionId }, capabilitySecret),
      },
      body,
    },
    context: {
      runtimeProfile: localRuntimeProfile(),
      store,
      requestId: 'verification-observation-test-request',
      requestOrigin: 'http://localhost',
      operatorGatedDevelop: false,
      sessionId,
      session,
    },
  });
}

describe('buildObservedVerificationChecks', () => {
  it('replaces exactly the four browser-local statuses while retaining server authority for all other checks', () => {
    const serverChecks = buildChecks({ counted_input_sanity: 'failed' });

    const observed = buildObservedVerificationChecks(serverChecks, castStatuses);

    expect(observed).toHaveLength(VERIFICATION_CHECK_DEFINITIONS.length);
    expect(Object.fromEntries(observed?.map((check) => [check.id, check.status]) ?? [])).toMatchObject({
      ...castStatuses,
      counted_input_sanity: 'failed',
      stark_receipt_verify: 'success',
    });
  });

  it('refuses incomplete or duplicate server check authority', () => {
    const checks = buildChecks();

    expect(buildObservedVerificationChecks(checks.slice(1), castStatuses)).toBeNull();
    expect(buildObservedVerificationChecks([...checks, strictDefined(checks[0])], castStatuses)).toBeNull();
  });
});

describe('submitVerificationObservationHandler', () => {
  beforeEach(() => {
    vi.stubEnv('SESSION_CAPABILITY_SECRET', capabilitySecret);
    dependencyMocks.getVerifyHandler.mockReset();
    dependencyMocks.emitVerificationRunSummaryObservation.mockReset();
    dependencyMocks.getVerifyHandler.mockResolvedValue(buildVerifyResponse());
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('durably records a bounded fingerprint before emitting one server-derived final summary', async () => {
    const recordVerificationObservation = vi.fn<
      (
        sessionId: string,
        finalizationId: string,
        observation: VerificationObservationWrite,
      ) => Promise<RecordVerificationObservationResult>
    >(() => Promise.resolve({ status: 'recorded' }));
    const store = createObservationStore({
      recordVerificationObservation,
    });

    const response = await invokeObservation(store);

    expect(response.status).toBe(200);
    expect(getStringProperty(requireDataRecord(await readJsonRecord(response)), 'status')).toBe('recorded');
    expect(recordVerificationObservation).toHaveBeenCalledOnce();
    const [recordedSessionId, recordedFinalizationId, observation] = strictDefined(
      recordVerificationObservation.mock.calls[0],
    );
    expect(recordedSessionId).toBe(sessionId);
    expect(recordedFinalizationId).toBe(finalizationId);
    expect(observation.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(Number.isSafeInteger(observation.observedAt)).toBe(true);
    expect(observation.fingerprint).toBe(
      createHash('sha256')
        .update(JSON.stringify([finalizationId, 'success', 'failed', 'not_run', 'success']))
        .digest('hex'),
    );
    expect(dependencyMocks.emitVerificationRunSummaryObservation).toHaveBeenCalledOnce();
    const emitted = strictDefined(dependencyMocks.emitVerificationRunSummaryObservation.mock.calls[0])[0];
    expect(Object.fromEntries(emitted.checks.map((check) => [check.id, check.status]))).toMatchObject({
      cast_choice_range: 'failed',
      stark_receipt_verify: 'success',
    });
    expect(emitted.summaryContext).toEqual({
      missingSlots: 0,
      invalidPresentedSlots: 0,
      rejectedRecords: 0,
      excludedSlots: 0,
      devModeEvidence: false,
      sthSourcesConfigured: false,
    });
    expect(emitted.persistedScenarios).toEqual(['S2']);
    expect(emitted.verificationResult?.status).toBe('success');
    expect(emitted.sessionId).toBe(sessionId);
    expect(emitted.finalizationId).toBe(finalizationId);
  });

  it('returns an idempotent success without emitting a duplicate event', async () => {
    const store = createObservationStore({
      recordVerificationObservation: () => Promise.resolve({ status: 'idempotent' }),
    });

    const response = await invokeObservation(store);

    expect(response.status).toBe(200);
    expect(getStringProperty(requireDataRecord(await readJsonRecord(response)), 'status')).toBe('idempotent');
    expect(dependencyMocks.emitVerificationRunSummaryObservation).not.toHaveBeenCalled();
  });

  it('uses the bounded persisted dev-mode receipt marker after the full report is discarded', async () => {
    const store = createObservationStore(
      {
        recordVerificationObservation: () => Promise.resolve({ status: 'recorded' }),
      },
      buildVerificationResult(true),
    );

    const response = await invokeObservation(store);

    expect(response.status).toBe(200);
    const emitted = strictDefined(dependencyMocks.emitVerificationRunSummaryObservation.mock.calls[0])[0];
    expect(emitted.devModeReceipt).toBe(true);
    expect(emitted.summaryContext).toMatchObject({ devModeEvidence: true });
  });

  it.each(['finalization_mismatch', 'fingerprint_mismatch'] as const)(
    'maps a durable %s conflict to a dedicated 409 without emitting',
    async (reason) => {
      const store = createObservationStore({
        recordVerificationObservation: () => Promise.resolve({ status: 'conflict', reason }),
      });

      const response = await invokeObservation(store);
      const payload = await readJsonRecord(response);

      expect(response.status).toBe(409);
      expect(getApiErrorCode(payload)).toBe('VERIFICATION_OBSERVATION_CONFLICT');
      expect(payload).not.toHaveProperty('statusCode');
      expect(dependencyMocks.emitVerificationRunSummaryObservation).not.toHaveBeenCalled();
    },
  );

  it('rejects a stale requested execution before rebuilding or recording an observation', async () => {
    const recordVerificationObservation = vi.fn();
    const store = createObservationStore({
      recordVerificationObservation,
    });

    const response = await invokeObservation(store, 'execution-stale');

    expect(response.status).toBe(409);
    expect(dependencyMocks.getVerifyHandler).not.toHaveBeenCalled();
    expect(recordVerificationObservation).not.toHaveBeenCalled();
  });

  it('fails closed without recording when server check authority is incomplete', async () => {
    dependencyMocks.getVerifyHandler.mockResolvedValueOnce(buildVerifyResponse(buildChecks().slice(1)));
    const recordVerificationObservation = vi.fn();
    const store = createObservationStore({
      recordVerificationObservation,
    });

    const response = await invokeObservation(store);

    expect(response.status).toBe(500);
    expect(recordVerificationObservation).not.toHaveBeenCalled();
    expect(dependencyMocks.emitVerificationRunSummaryObservation).not.toHaveBeenCalled();
  });
});
