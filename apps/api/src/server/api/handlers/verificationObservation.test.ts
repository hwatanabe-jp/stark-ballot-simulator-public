import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { resolveCurrentContractGeneration } from '@stark-ballot/domain/contract';
import { createSessionCapabilityToken } from '@stark-ballot/domain/security/sessionCapabilityToken';
import { SESSION_CAPABILITY_HEADER, SESSION_ID_HEADER } from '@stark-ballot/domain/session/capability';
import type { SessionData } from '@stark-ballot/domain/types/server';
import type {
  RecordVerificationObservationResult,
  VerificationObservation,
} from '@stark-ballot/domain/types/verificationObservation';
import {
  admitAwsPersistedFinalizationResultBranch,
  type AwsPersistedFinalizationResult,
} from '@stark-ballot/aws-adapters/finalize/finalizationPersistenceEnvelope';
import {
  VERIFICATION_CHECK_DEFINITIONS,
  type VerificationCheck,
  type VerificationCheckId,
} from '@stark-ballot/verification/checks';
import { createTestJournal } from '@stark-ballot/test-support/testing/test-helpers';
import { createMockVoteStore } from '@stark-ballot/test-support/testing/mockVoteStore';
import { readJsonRecord, requireDataRecord } from '@stark-ballot/test-support/testing/response-helpers';
import { getStringProperty } from '@stark-ballot/domain/utils/guards';
import type { ApiContext } from '../context';
import type { VerificationRunSummaryObservationInput } from './verificationObservability';

const dependencyMocks = vi.hoisted(() => ({
  getVerifyHandler: vi.fn<(context: ApiContext) => Promise<Response>>(),
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
const executionId = 'execution-verification-observation-1';
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

function buildFinalizationResult(): AwsPersistedFinalizationResult {
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
    verificationExecutionId: executionId,
    scenarios: ['S2'],
    verificationResult: {
      status: 'success',
      report: {
        status: 'success',
        verifier_version: '0.1.0',
        verified_at: '2026-07-28T00:00:00.000Z',
        duration_ms: 42,
        expected_image_id: hex,
        receipt_image_id: hex,
        dev_mode_receipt: false,
        errors: [],
      },
    },
  };
}

function buildSession(): SessionData {
  const now = Date.now();
  return {
    sessionId,
    contractGeneration: resolveCurrentContractGeneration(),
    finalizationContractGeneration: resolveCurrentContractGeneration(),
    hasPersistedFinalizationBranch: true,
    votes: new Map(),
    botCount: 0,
    finalized: true,
    createdAt: now,
    lastActivity: now,
    finalizationResult: admitAwsPersistedFinalizationResultBranch(buildFinalizationResult()),
  };
}

function buildVerifyResponse(checks = buildChecks()): Response {
  return new Response(
    JSON.stringify({
      data: {
        electionId: 'election-1',
        electionConfigHash: hex,
        logId: 'log-1',
        tally: {
          counts: { A: 1, B: 0, C: 0, D: 0, E: 0 },
          totalVotes: 1,
          tamperedCount: 0,
        },
        bulletinRoot: hex,
        scenarioId: 'S2',
        verificationStatus: 'success',
        verificationChecks: checks,
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
        journalStatus: 'omitted',
        verificationExecutionId: executionId,
      },
    }),
    {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    },
  );
}

function request(overrides: Record<string, unknown> = {}): Request {
  return new Request('http://localhost/api/verification/observation', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      [SESSION_ID_HEADER]: sessionId,
      [SESSION_CAPABILITY_HEADER]: createSessionCapabilityToken({ sessionId }, capabilitySecret),
    },
    body: JSON.stringify({
      verificationExecutionId: executionId,
      castChecks: castStatuses,
      ...overrides,
    }),
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
      (sessionId: string, observation: VerificationObservation) => Promise<RecordVerificationObservationResult>
    >(() => Promise.resolve({ status: 'recorded' }));
    const store = createMockVoteStore({
      getSession: () => Promise.resolve(buildSession()),
      recordVerificationObservation,
    });

    const response = await submitVerificationObservationHandler({
      request: request(),
      store,
    });

    expect(response.status).toBe(200);
    expect(getStringProperty(requireDataRecord(await readJsonRecord(response)), 'status')).toBe('recorded');
    expect(recordVerificationObservation).toHaveBeenCalledOnce();
    const [recordedSessionId, observation] = strictDefined(recordVerificationObservation.mock.calls[0]);
    expect(recordedSessionId).toBe(sessionId);
    expect(observation.executionId).toBe(executionId);
    expect(observation.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(Number.isSafeInteger(observation.observedAt)).toBe(true);
    expect(observation.fingerprint).toBe(
      createHash('sha256')
        .update(JSON.stringify([executionId, 'success', 'failed', 'not_run', 'success']))
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
    expect(emitted.executionId).toBe(executionId);
  });

  it('returns an idempotent success without emitting a duplicate event', async () => {
    const store = createMockVoteStore({
      getSession: () => Promise.resolve(buildSession()),
      recordVerificationObservation: () => Promise.resolve({ status: 'idempotent' }),
    });

    const response = await submitVerificationObservationHandler({
      request: request(),
      store,
    });

    expect(response.status).toBe(200);
    expect(getStringProperty(requireDataRecord(await readJsonRecord(response)), 'status')).toBe('idempotent');
    expect(dependencyMocks.emitVerificationRunSummaryObservation).not.toHaveBeenCalled();
  });

  it('uses the bounded persisted dev-mode receipt marker after the full report is discarded', async () => {
    const finalizationResult = buildFinalizationResult();
    finalizationResult.verificationResult = {
      status: 'dev_mode',
      devModeReceipt: true,
      failureCategory: 'none',
    };
    const session = buildSession();
    session.finalizationResult = admitAwsPersistedFinalizationResultBranch(finalizationResult);
    const store = createMockVoteStore({
      getSession: () => Promise.resolve(session),
      recordVerificationObservation: () => Promise.resolve({ status: 'recorded' }),
    });

    const response = await submitVerificationObservationHandler({
      request: request(),
      store,
    });

    expect(response.status).toBe(200);
    const emitted = strictDefined(dependencyMocks.emitVerificationRunSummaryObservation.mock.calls[0])[0];
    expect(emitted.devModeReceipt).toBe(true);
    expect(emitted.summaryContext).toMatchObject({ devModeEvidence: true });
  });

  it.each(['execution_mismatch', 'fingerprint_mismatch'] as const)(
    'maps a durable %s conflict to a dedicated 409 without emitting',
    async (reason) => {
      const store = createMockVoteStore({
        getSession: () => Promise.resolve(buildSession()),
        recordVerificationObservation: () => Promise.resolve({ status: 'conflict', reason }),
      });

      const response = await submitVerificationObservationHandler({
        request: request(),
        store,
      });
      const payload = await readJsonRecord(response);

      expect(response.status).toBe(409);
      expect(getStringProperty(payload, 'error')).toBe('VERIFICATION_OBSERVATION_CONFLICT');
      expect(payload['statusCode']).toBe(409);
      expect(dependencyMocks.emitVerificationRunSummaryObservation).not.toHaveBeenCalled();
    },
  );

  it('rejects a stale requested execution before rebuilding or recording an observation', async () => {
    const recordVerificationObservation = vi.fn();
    const store = createMockVoteStore({
      getSession: () => Promise.resolve(buildSession()),
      recordVerificationObservation,
    });

    const response = await submitVerificationObservationHandler({
      request: request({ verificationExecutionId: 'execution-stale' }),
      store,
    });

    expect(response.status).toBe(409);
    expect(dependencyMocks.getVerifyHandler).not.toHaveBeenCalled();
    expect(recordVerificationObservation).not.toHaveBeenCalled();
  });

  it('fails closed without recording when server check authority is incomplete', async () => {
    dependencyMocks.getVerifyHandler.mockResolvedValueOnce(buildVerifyResponse(buildChecks().slice(1)));
    const recordVerificationObservation = vi.fn();
    const store = createMockVoteStore({
      getSession: () => Promise.resolve(buildSession()),
      recordVerificationObservation,
    });

    const response = await submitVerificationObservationHandler({
      request: request(),
      store,
    });

    expect(response.status).toBe(500);
    expect(recordVerificationObservation).not.toHaveBeenCalled();
    expect(dependencyMocks.emitVerificationRunSummaryObservation).not.toHaveBeenCalled();
  });
});
