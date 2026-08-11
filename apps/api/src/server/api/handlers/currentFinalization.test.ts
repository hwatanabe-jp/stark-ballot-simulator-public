import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FinalizationRecord } from '@stark-ballot/application/finalize/finalization-record';
import type {
  FinalizationScenarioContext,
  FinalizationState,
} from '@stark-ballot/application/finalize/finalization-types';
import type { SessionReadModel } from '@stark-ballot/application/session/session-read-model';
import type { MockVoteStore } from '../../__tests__/support/mockVoteStore';
import {
  CurrentFinalizationResponseSchema,
  type CurrentFinalizationResponse,
} from '@stark-ballot/api-contract/schemas/finalizations';
import { createMockVoteStore } from '../../__tests__/support/mockVoteStore';
import { buildFinalizationResultFromJournal } from '@stark-ballot/application/finalize/finalization-result';
import { createTestJournal } from '@stark-ballot/test-support/testing/test-helpers';
import { computeIncludedBitmapRoot } from '@stark-ballot/zkvm-contract/zkvm/bitmap';
import { createSessionCapabilityToken } from '@stark-ballot/domain/security/sessionCapabilityToken';
import { SESSION_CAPABILITY_HEADER } from '@stark-ballot/domain/session/capability';
import { SimpleBulletinBoard } from '@stark-ballot/domain/bulletin/simple-bulletin-board';
import type { SessionIdentityRecord, SessionVotingRecord } from '@stark-ballot/domain/types/sessionRecords';
import { logger } from '@stark-ballot/diagnostics/logger';
import { hashSessionIdForLogging } from '@stark-ballot/diagnostics/logging';
import {
  localRuntimeProfile,
  targetRuntimeProfile,
  targetRuntimeProfileEnv,
} from '@stark-ballot/runtime-config/env/__tests__/runtimeProfileFixtures';
import { resolveRuntimeProfile, type ResolvedRuntimeProfile } from '@stark-ballot/runtime-config/env/runtimeProfile';
import { getCurrentFinalizationHandler } from './currentFinalization';

const stepFunctionsMocks = vi.hoisted(() => ({
  describeFinalizationExecution: vi.fn(),
}));
const emitCanonicalEventMock = vi.hoisted(() => vi.fn());

vi.mock('../adapters/finalizationStepFunctions', () => ({
  describeFinalizationExecution: stepFunctionsMocks.describeFinalizationExecution,
}));

vi.mock('@stark-ballot/diagnostics/canonicalEvents', () => ({
  emitCanonicalEvent: emitCanonicalEventMock,
}));

const capabilitySecret = 'session-status-handler-secret-0123456789abcdef';
const sessionId = 'session-status-1';
const finalizationId = 'exec-status-1';
const fixedNow = 1_730_000_000_000;
const logId = `0x${'2'.repeat(64)}`;
const scenarioContext: FinalizationScenarioContext = {
  scenarios: [],
  tamperMode: 'none',
  claimedCounts: { A: 0, B: 0, C: 0, D: 0, E: 0 },
  claimedTotalVotes: 0,
  summary: {
    ignoredCount: 0,
    recountedCount: 0,
    userRecountChoice: null,
  },
};

type TargetRuntimeProfile = Extract<ResolvedRuntimeProfile, { readonly target: { readonly kind: 'aws' } }>;
type ReconciliationState = Exclude<FinalizationState, { status: 'succeeded' }>;
type RunningFinalizationState = Extract<FinalizationState, { status: 'running' }>;

function isTargetRuntimeProfile(profile: ResolvedRuntimeProfile): profile is TargetRuntimeProfile {
  return profile.name === 'target-aws-async' || profile.name === 'target-aws-async-quiesced';
}

function requireTargetRuntimeProfile(profile: ResolvedRuntimeProfile): TargetRuntimeProfile {
  if (!isTargetRuntimeProfile(profile)) {
    throw new Error('Expected target AWS runtime profile');
  }
  return profile;
}

const asyncRuntimeProfile = requireTargetRuntimeProfile(targetRuntimeProfile());
const quiescedAsyncRuntimeProfile = requireTargetRuntimeProfile(
  resolveRuntimeProfile({
    ...targetRuntimeProfileEnv(),
    RUNTIME_PROFILE: 'target-aws-async-quiesced',
  }),
);
const stateMachineArn = asyncRuntimeProfile.external.asyncRuntime.proverStateMachineArn;
const executionArn = `${stateMachineArn.replace(':stateMachine:', ':execution:')}:${finalizationId}`;

function buildIdentity(): SessionIdentityRecord {
  return {
    sessionId,
    electionId: '550e8400-e29b-41d4-a716-446655440000',
    electionConfigHash: `0x${'1'.repeat(64)}`,
    electionConfig: {
      totalExpected: 1,
      choices: ['A', 'B', 'C', 'D', 'E'],
      version: 'test-v1',
      botCount: 0,
      merkleTreeDepth: 1,
    },
    logId,
    createdAtMs: fixedNow - 10_000,
  };
}

function buildVotingRecord(): SessionVotingRecord {
  return {
    sessionId,
    votes: new Map(),
    bulletin: new SimpleBulletinBoard(logId),
    bulletinRootHistory: [],
    botCount: 0,
    userParticipation: { status: 'not_cast' },
    lastActivityMs: fixedNow - 1000,
  };
}

function buildFinalizationRecord(state: ReconciliationState): FinalizationRecord {
  return {
    sessionId,
    finalizationId,
    scenarioContext,
    state,
  };
}

function buildPendingState(queuedAtMs: number): Extract<FinalizationState, { status: 'pending' }> {
  return {
    status: 'pending',
    finalizationId,
    queuedAtMs,
  };
}

function buildRunningState(startedAtMs: number): RunningFinalizationState {
  return {
    status: 'running',
    finalizationId,
    queuedAtMs: startedAtMs - 1000,
    startedAtMs,
  };
}

function buildFailedState(params: {
  queuedAtMs: number;
  startedAtMs?: number;
  failedAtMs: number;
  code: string;
  message: string;
}): Extract<FinalizationState, { status: 'failed' }> {
  return {
    status: 'failed',
    finalizationId,
    queuedAtMs: params.queuedAtMs,
    ...(params.startedAtMs === undefined ? {} : { startedAtMs: params.startedAtMs }),
    failedAtMs: params.failedAtMs,
    error: {
      code: params.code,
      message: params.message,
    },
  };
}

function buildTimedOutState(params: {
  queuedAtMs: number;
  startedAtMs?: number;
  timeoutAtMs: number;
}): Extract<FinalizationState, { status: 'timeout' }> {
  return {
    status: 'timeout',
    finalizationId,
    queuedAtMs: params.queuedAtMs,
    ...(params.startedAtMs === undefined ? {} : { startedAtMs: params.startedAtMs }),
    timeoutAtMs: params.timeoutAtMs,
  };
}

function buildStore(finalizationState: ReconciliationState, overrides: Partial<MockVoteStore> = {}): MockVoteStore {
  const identity = buildIdentity();
  const voting = buildVotingRecord();
  const finalization = buildFinalizationRecord(finalizationState);
  return createMockVoteStore({
    getSessionIdentity: (requestedSessionId) => Promise.resolve(requestedSessionId === sessionId ? identity : null),
    getVotingRecord: (requestedSessionId) => Promise.resolve(requestedSessionId === sessionId ? voting : null),
    getCurrentFinalizationRecord: (requestedSessionId) =>
      Promise.resolve(requestedSessionId === sessionId ? finalization : null),
    getAwsFinalizationRuntimeMetadata: (requestedSessionId, requestedFinalizationId) =>
      Promise.resolve(
        requestedSessionId === sessionId &&
          requestedFinalizationId === finalizationId &&
          finalizationState.status === 'running'
          ? { stepFunctionsArn: executionArn }
          : undefined,
      ),
    ...overrides,
  });
}

async function readStatusResponse(response: Response): Promise<CurrentFinalizationResponse['data']> {
  const body: unknown = await response.json();
  return CurrentFinalizationResponseSchema.parse(body).data;
}

function executionDoesNotExistError(): Error {
  const error = new Error('execution does not exist');
  error.name = 'ExecutionDoesNotExist';
  return error;
}

async function loadSessionReadModel(store: MockVoteStore): Promise<SessionReadModel> {
  const [identity, voting, finalization] = await Promise.all([
    store.getSessionIdentity(sessionId),
    store.getVotingRecord(sessionId),
    store.getCurrentFinalizationRecord(sessionId),
  ]);
  if (!identity || !voting) {
    throw new Error('Expected exact status test records to exist.');
  }
  return { identity, voting, finalization };
}

async function requestStatusResponse(
  store: MockVoteStore,
  runtimeProfile: ResolvedRuntimeProfile = asyncRuntimeProfile,
): Promise<Response> {
  const session = await loadSessionReadModel(store);
  return getCurrentFinalizationHandler({
    input: {
      params: { sessionId },
      headers: {
        [SESSION_CAPABILITY_HEADER]: createSessionCapabilityToken({ sessionId }, capabilitySecret),
      },
    },
    context: {
      store,
      requestId: 'session-status-test-request',
      requestOrigin: 'http://localhost',
      operatorGatedDevelop: false,
      runtimeProfile,
      sessionId,
      session,
      finalizationDependencies: {
        describeFinalizationExecution: stepFunctionsMocks.describeFinalizationExecution,
      },
    },
  });
}

async function requestStatus(
  store: MockVoteStore,
  runtimeProfile: ResolvedRuntimeProfile = asyncRuntimeProfile,
): Promise<CurrentFinalizationResponse['data']> {
  const response = await requestStatusResponse(store, runtimeProfile);
  expect(response.status).toBe(200);
  return readStatusResponse(response);
}

function expectReconcileAttempt(to: 'failed' | 'timeout', reason: string): void {
  expect(emitCanonicalEventMock).toHaveBeenCalledWith({
    event: 'finalize_transition_attempted',
    to,
    source: 'reconcile',
    reason,
    session_id_hash: hashSessionIdForLogging(sessionId),
    finalization_id: finalizationId,
  });
  expect(JSON.stringify(emitCanonicalEventMock.mock.calls)).not.toContain(sessionId);
  expect(JSON.stringify(emitCanonicalEventMock.mock.calls)).not.toContain(stateMachineArn);
}

describe('getCurrentFinalizationHandler finalization reconciliation', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(fixedNow);
    stepFunctionsMocks.describeFinalizationExecution.mockReset();
    emitCanonicalEventMock.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it('projects bitmap availability from the admitted finalization sidecar', async () => {
    const journal = createTestJournal({ totalExpected: 1, validVotes: 1 });
    journal.includedBitmapRoot = computeIncludedBitmapRoot([true]);
    const authority = buildFinalizationResultFromJournal({
      journal,
      imageId: `0x${'1'.repeat(64)}`,
    });
    const succeeded: FinalizationRecord = {
      sessionId,
      finalizationId,
      scenarioContext,
      state: {
        status: 'succeeded',
        finalizationId,
        queuedAtMs: fixedNow - 3000,
        startedAtMs: fixedNow - 2000,
        completedAtMs: fixedNow - 1000,
      },
      finalizationResult: { finalizationId, ...authority },
    };
    const getBitmapData = vi.fn().mockResolvedValue({
      sessionId,
      finalizationId,
      includedBitmap: [true],
      includedBitmapRoot: journal.includedBitmapRoot,
      treeSize: journal.treeSize,
      finalizedAtMs: fixedNow - 1000,
    });
    const store = createMockVoteStore({
      getSessionIdentity: () => Promise.resolve(buildIdentity()),
      getVotingRecord: () => Promise.resolve(buildVotingRecord()),
      getCurrentFinalizationRecord: () => Promise.resolve(succeeded),
      getBitmapData,
    });

    const payload = await requestStatus(store, localRuntimeProfile());

    expect(getBitmapData).toHaveBeenCalledWith(sessionId, finalizationId);
    expect(payload?.status).toBe('succeeded');
    expect(payload?.status === 'succeeded' ? payload.result.artifactAvailability.includedBitmap : null).toBe(
      'available',
    );
  });

  it.each([
    ['root', { includedBitmapRoot: `0x${'0'.repeat(64)}` }],
    ['treeSize', { treeSize: 2 }],
    ['length', { includedBitmap: [true, false] }],
  ])('keeps bitmap unavailable when persisted sidecar %s does not match the journal', async (_label, mismatch) => {
    const journal = createTestJournal({ totalExpected: 1, validVotes: 1 });
    journal.includedBitmapRoot = computeIncludedBitmapRoot([true]);
    const authority = buildFinalizationResultFromJournal({
      journal,
      imageId: `0x${'1'.repeat(64)}`,
    });
    const succeeded: FinalizationRecord = {
      sessionId,
      finalizationId,
      scenarioContext,
      state: {
        status: 'succeeded',
        finalizationId,
        queuedAtMs: fixedNow - 3000,
        startedAtMs: fixedNow - 2000,
        completedAtMs: fixedNow - 1000,
      },
      finalizationResult: { finalizationId, ...authority },
    };
    const store = createMockVoteStore({
      getSessionIdentity: () => Promise.resolve(buildIdentity()),
      getVotingRecord: () => Promise.resolve(buildVotingRecord()),
      getCurrentFinalizationRecord: () => Promise.resolve(succeeded),
      getBitmapData: () =>
        Promise.resolve({
          sessionId,
          finalizationId,
          includedBitmap: [true],
          includedBitmapRoot: journal.includedBitmapRoot,
          treeSize: journal.treeSize,
          finalizedAtMs: fixedNow - 1000,
          ...mismatch,
        }),
    });

    const payload = await requestStatus(store, localRuntimeProfile());

    expect(payload?.status === 'succeeded' ? payload.result.artifactAvailability.includedBitmap : null).toBe(
      'unavailable',
    );
  });

  it('persists FINALIZATION_DISPATCH_TIMEOUT when an old pending execution is not found beyond the deadline', async () => {
    vi.stubEnv('FINALIZE_PENDING_DISPATCH_DEADLINE_SECONDS', '900');
    const pendingState = buildPendingState(fixedNow - 1_000_000);
    const failedState = buildFailedState({
      queuedAtMs: pendingState.queuedAtMs,
      failedAtMs: fixedNow,
      code: 'FINALIZATION_DISPATCH_TIMEOUT',
      message: 'Finalization dispatch did not start within 900 seconds.',
    });
    const markFailed = vi.fn<MockVoteStore['markAwsFinalizationFailed']>().mockResolvedValue(failedState);
    stepFunctionsMocks.describeFinalizationExecution.mockRejectedValueOnce(executionDoesNotExistError());

    const payload = await requestStatus(buildStore(pendingState, { markAwsFinalizationFailed: markFailed }));

    expect(stepFunctionsMocks.describeFinalizationExecution).toHaveBeenCalledWith(executionArn);
    expect(markFailed).toHaveBeenCalledTimes(1);
    const failedCall = markFailed.mock.calls[0];
    if (!failedCall) {
      throw new Error('Expected markAwsFinalizationFailed to be called.');
    }
    expect(failedCall[0]).toBe(sessionId);
    expect(failedCall[1]).toMatchObject({
      finalizationId,
      queuedAtMs: pendingState.queuedAtMs,
      failedAtMs: fixedNow,
      error: {
        code: 'FINALIZATION_DISPATCH_TIMEOUT',
      },
      observability: {
        source: 'reconcile',
        reason: 'FINALIZATION_DISPATCH_TIMEOUT',
      },
    });
    expect(failedCall[1].error.message).toContain('900');
    expect(failedCall[1].error.details).toEqual(expect.objectContaining({ ageSeconds: 1000 }));
    expect(failedCall[1]).not.toHaveProperty('stepFunctionsArn');
    expect(payload?.status).toBe('failed');
    expect(payload?.finalizationId).toBe(finalizationId);
    expect(payload?.status === 'failed' ? payload.error.code : null).toBe('FINALIZATION_DISPATCH_TIMEOUT');
    expectReconcileAttempt('failed', 'FINALIZATION_DISPATCH_TIMEOUT');
  });

  it('keeps a not-found pending execution pending at the dispatch deadline and fails just past it', async () => {
    vi.stubEnv('FINALIZE_PENDING_DISPATCH_DEADLINE_SECONDS', '900');
    const markAtDeadline = vi.fn<MockVoteStore['markAwsFinalizationFailed']>();
    const atDeadlineState = buildPendingState(fixedNow - 900_000);
    stepFunctionsMocks.describeFinalizationExecution.mockRejectedValueOnce(executionDoesNotExistError());

    const atDeadlinePayload = await requestStatus(
      buildStore(atDeadlineState, { markAwsFinalizationFailed: markAtDeadline }),
    );

    expect(atDeadlinePayload?.status).toBe('pending');
    expect(markAtDeadline).not.toHaveBeenCalled();

    const justPastDeadlineState = buildPendingState(fixedNow - 901_000);
    const justPastFailedState = buildFailedState({
      queuedAtMs: justPastDeadlineState.queuedAtMs,
      failedAtMs: fixedNow,
      code: 'FINALIZATION_DISPATCH_TIMEOUT',
      message: 'Finalization dispatch did not start within 900 seconds.',
    });
    const markJustPastDeadline = vi
      .fn<MockVoteStore['markAwsFinalizationFailed']>()
      .mockResolvedValue(justPastFailedState);
    stepFunctionsMocks.describeFinalizationExecution.mockRejectedValueOnce(executionDoesNotExistError());

    const justPastPayload = await requestStatus(
      buildStore(justPastDeadlineState, { markAwsFinalizationFailed: markJustPastDeadline }),
    );

    expect(justPastPayload?.status).toBe('failed');
    expect(markJustPastDeadline).toHaveBeenCalledTimes(1);
    const failedCall = markJustPastDeadline.mock.calls[0];
    if (!failedCall) {
      throw new Error('Expected markAwsFinalizationFailed to be called.');
    }
    expect(failedCall[1]).not.toHaveProperty('stepFunctionsArn');
  });

  it('keeps an old pending execution pending when the execution is not found within the dispatch deadline', async () => {
    vi.stubEnv('FINALIZE_PENDING_DISPATCH_DEADLINE_SECONDS', '900');
    const pendingState = buildPendingState(fixedNow - 120_000);
    const markFailed = vi.fn<MockVoteStore['markAwsFinalizationFailed']>();
    stepFunctionsMocks.describeFinalizationExecution.mockRejectedValueOnce(executionDoesNotExistError());

    const payload = await requestStatus(buildStore(pendingState, { markAwsFinalizationFailed: markFailed }));

    expect(stepFunctionsMocks.describeFinalizationExecution).toHaveBeenCalledWith(executionArn);
    expect(markFailed).not.toHaveBeenCalled();
    expect(payload?.status).toBe('pending');
    expect(payload?.finalizationId).toBe(finalizationId);
  });

  it('describes a pending execution exactly at the initial grace boundary', async () => {
    const pendingState = buildPendingState(fixedNow - 60_000);
    const markFailed = vi.fn<MockVoteStore['markAwsFinalizationFailed']>();
    stepFunctionsMocks.describeFinalizationExecution.mockResolvedValueOnce({
      status: 'RUNNING',
      startTimeMs: fixedNow - 1000,
      stopTimeMs: null,
    });

    const payload = await requestStatus(buildStore(pendingState, { markAwsFinalizationFailed: markFailed }));

    expect(stepFunctionsMocks.describeFinalizationExecution).toHaveBeenCalledWith(executionArn);
    expect(markFailed).not.toHaveBeenCalled();
    expect(payload?.status).toBe('pending');
  });

  it('keeps an old pending execution pending when Step Functions reports RUNNING', async () => {
    const pendingState = buildPendingState(fixedNow - 120_000);
    const markFailed = vi.fn<MockVoteStore['markAwsFinalizationFailed']>();
    stepFunctionsMocks.describeFinalizationExecution.mockResolvedValueOnce({
      status: 'RUNNING',
      startTimeMs: fixedNow - 60_000,
      stopTimeMs: null,
    });

    const payload = await requestStatus(buildStore(pendingState, { markAwsFinalizationFailed: markFailed }));

    expect(stepFunctionsMocks.describeFinalizationExecution).toHaveBeenCalledWith(executionArn);
    expect(markFailed).not.toHaveBeenCalled();
    expect(payload?.status).toBe('pending');
    expect(payload?.finalizationId).toBe(finalizationId);
  });

  it('reconciles an old pending execution under the quiesced target profile', async () => {
    const pendingState = buildPendingState(fixedNow - 120_000);
    const markFailed = vi.fn<MockVoteStore['markAwsFinalizationFailed']>();
    stepFunctionsMocks.describeFinalizationExecution.mockResolvedValueOnce({
      status: 'RUNNING',
      startTimeMs: fixedNow - 60_000,
      stopTimeMs: null,
    });

    const payload = await requestStatus(
      buildStore(pendingState, { markAwsFinalizationFailed: markFailed }),
      quiescedAsyncRuntimeProfile,
    );

    expect(stepFunctionsMocks.describeFinalizationExecution).toHaveBeenCalledWith(executionArn);
    expect(markFailed).not.toHaveBeenCalled();
    expect(payload?.status).toBe('pending');
    expect(payload?.finalizationId).toBe(finalizationId);
  });

  it('keeps a beyond-deadline pending execution pending when Step Functions reports RUNNING', async () => {
    vi.stubEnv('FINALIZE_PENDING_DISPATCH_DEADLINE_SECONDS', '900');
    const pendingState = buildPendingState(fixedNow - 1_000_000);
    const markFailed = vi.fn<MockVoteStore['markAwsFinalizationFailed']>();
    stepFunctionsMocks.describeFinalizationExecution.mockResolvedValueOnce({
      status: 'RUNNING',
      startTimeMs: fixedNow - 60_000,
      stopTimeMs: null,
    });

    const payload = await requestStatus(buildStore(pendingState, { markAwsFinalizationFailed: markFailed }));

    expect(stepFunctionsMocks.describeFinalizationExecution).toHaveBeenCalledWith(executionArn);
    expect(markFailed).not.toHaveBeenCalled();
    expect(payload?.status).toBe('pending');
  });

  it.each(['SUCCEEDED', 'FAILED', 'TIMED_OUT', 'ABORTED'] as const)(
    'persists FINALIZATION_OUTCOME_UNRECORDED when a pending execution closed as %s',
    async (executionStatus) => {
      const pendingState = buildPendingState(fixedNow - 120_000);
      const failedState = buildFailedState({
        queuedAtMs: pendingState.queuedAtMs,
        failedAtMs: fixedNow,
        code: 'FINALIZATION_OUTCOME_UNRECORDED',
        message: `Finalization execution ${executionStatus} before recording an outcome.`,
      });
      const markFailed = vi.fn<MockVoteStore['markAwsFinalizationFailed']>().mockResolvedValue(failedState);
      stepFunctionsMocks.describeFinalizationExecution.mockResolvedValueOnce({
        status: executionStatus,
        startTimeMs: fixedNow - 60_000,
        stopTimeMs: fixedNow - 10_000,
      });

      const payload = await requestStatus(buildStore(pendingState, { markAwsFinalizationFailed: markFailed }));

      expect(stepFunctionsMocks.describeFinalizationExecution).toHaveBeenCalledWith(executionArn);
      expect(markFailed).toHaveBeenCalledTimes(1);
      const failedCall = markFailed.mock.calls[0];
      if (!failedCall) {
        throw new Error('Expected markAwsFinalizationFailed to be called.');
      }
      expect(failedCall[1]).toMatchObject({
        finalizationId,
        queuedAtMs: pendingState.queuedAtMs,
        failedAtMs: fixedNow,
        error: {
          code: 'FINALIZATION_OUTCOME_UNRECORDED',
          details: {
            executionStatus,
          },
        },
        observability: {
          source: 'reconcile',
          reason: 'FINALIZATION_OUTCOME_UNRECORDED',
        },
      });
      expect(payload?.status).toBe('failed');
      expect(payload?.status === 'failed' ? payload.error.code : null).toBe('FINALIZATION_OUTCOME_UNRECORDED');
      expectReconcileAttempt('failed', 'FINALIZATION_OUTCOME_UNRECORDED');
    },
  );

  it('does not describe a pending execution during the initial grace period', async () => {
    const pendingState = buildPendingState(fixedNow - 30_000);
    const markFailed = vi.fn<MockVoteStore['markAwsFinalizationFailed']>();

    const payload = await requestStatus(buildStore(pendingState, { markAwsFinalizationFailed: markFailed }));

    expect(stepFunctionsMocks.describeFinalizationExecution).not.toHaveBeenCalled();
    expect(markFailed).not.toHaveBeenCalled();
    expect(payload?.status).toBe('pending');
  });

  it.each([
    ['local-demo', localRuntimeProfile()],
    ['static-mock-e2e', localRuntimeProfile('static-mock-e2e')],
  ])('does not describe stale pending executions for injected %s profile', async (_label, runtimeProfile) => {
    const pendingState = buildPendingState(fixedNow - 1_000_000);
    const markFailed = vi.fn<MockVoteStore['markAwsFinalizationFailed']>();

    const payload = await requestStatus(
      buildStore(pendingState, { markAwsFinalizationFailed: markFailed }),
      runtimeProfile,
    );

    expect(stepFunctionsMocks.describeFinalizationExecution).not.toHaveBeenCalled();
    expect(markFailed).not.toHaveBeenCalled();
    expect(payload?.status).toBe('pending');
  });

  it('warns and leaves stale pending state unchanged when the Step Functions ARN cannot be constructed', async () => {
    const loggerWarnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const runtimeProfile: TargetRuntimeProfile = {
      ...asyncRuntimeProfile,
      external: {
        ...asyncRuntimeProfile.external,
        asyncRuntime: {
          ...asyncRuntimeProfile.external.asyncRuntime,
          proverStateMachineArn: 'not-a-state-machine-arn',
        },
      },
    };
    const pendingState = buildPendingState(fixedNow - 1_000_000);
    const markFailed = vi.fn<MockVoteStore['markAwsFinalizationFailed']>();

    const payload = await requestStatus(
      buildStore(pendingState, { markAwsFinalizationFailed: markFailed }),
      runtimeProfile,
    );

    expect(stepFunctionsMocks.describeFinalizationExecution).not.toHaveBeenCalled();
    expect(markFailed).not.toHaveBeenCalled();
    expect(loggerWarnSpy).toHaveBeenCalledTimes(1);
    expect(loggerWarnSpy).toHaveBeenCalledWith(
      '[Status API] Cannot reconcile pending finalization without a valid Step Functions ARN',
      expect.objectContaining({
        session_id_hash: hashSessionIdForLogging(sessionId),
        finalizationId,
        configuredStateMachineArn: 'not-a-state-machine-arn',
      }),
    );
    expect(payload?.status).toBe('pending');
  });

  it('keeps an old pending execution pending when Step Functions describe fails with an unexpected error', async () => {
    const loggerErrorSpy = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    const pendingState = buildPendingState(fixedNow - 120_000);
    const markFailed = vi.fn<MockVoteStore['markAwsFinalizationFailed']>();
    const describeError = new Error('temporary Step Functions outage');
    stepFunctionsMocks.describeFinalizationExecution.mockRejectedValueOnce(describeError);

    const payload = await requestStatus(buildStore(pendingState, { markAwsFinalizationFailed: markFailed }));

    expect(stepFunctionsMocks.describeFinalizationExecution).toHaveBeenCalledWith(executionArn);
    expect(markFailed).not.toHaveBeenCalled();
    expect(payload?.status).toBe('pending');
    expect(loggerErrorSpy).toHaveBeenCalledTimes(1);
    expect(loggerErrorSpy).toHaveBeenCalledWith(
      '[Status API] Failed to describe pending Step Functions execution',
      describeError,
    );
  });

  it('falls back to a schema-valid display projection when failed-state persistence throws', async () => {
    const loggerWarnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const runningState = buildRunningState(fixedNow - 120_000);
    const persistenceError = new Error('write failed');
    const markFailed = vi.fn<MockVoteStore['markAwsFinalizationFailed']>().mockRejectedValue(persistenceError);
    stepFunctionsMocks.describeFinalizationExecution.mockResolvedValueOnce({
      status: 'FAILED',
      startTimeMs: runningState.startedAtMs,
      stopTimeMs: fixedNow - 5000,
    });

    const payload = await requestStatus(buildStore(runningState, { markAwsFinalizationFailed: markFailed }));

    expect(markFailed).toHaveBeenCalledTimes(1);
    expect(payload?.status).toBe('failed');
    expect(payload?.status === 'failed' ? payload.error.code : null).toBe('STEP_FUNCTIONS_EXECUTION_FAILED');
    expect(loggerWarnSpy).toHaveBeenCalledTimes(1);
    expect(loggerWarnSpy).toHaveBeenCalledWith(
      '[Status API] Failed to persist reconciled failed finalization state',
      persistenceError,
    );
  });

  it('fails closed without fallback when a succeeded exact record is missing result authority', async () => {
    const runningState = buildRunningState(fixedNow - 120_000);
    const markFailed = vi.fn<MockVoteStore['markAwsFinalizationFailed']>();
    stepFunctionsMocks.describeFinalizationExecution.mockResolvedValueOnce({
      status: 'FAILED',
      startTimeMs: runningState.startedAtMs,
      stopTimeMs: fixedNow - 5000,
    });

    const invalidSucceededRecord = {
      sessionId,
      finalizationId,
      scenarioContext,
      state: {
        status: 'succeeded',
        finalizationId,
        queuedAtMs: runningState.queuedAtMs,
        startedAtMs: runningState.startedAtMs,
        completedAtMs: fixedNow - 5000,
      },
    } as unknown as FinalizationRecord;
    const store = buildStore(runningState, {
      getCurrentFinalizationRecord: () => Promise.resolve(invalidSucceededRecord),
      getAwsFinalizationRuntimeMetadata: () => Promise.resolve(undefined),
      markAwsFinalizationFailed: markFailed,
    });

    await expect(requestStatusResponse(store)).rejects.toThrow(
      'Succeeded finalization is missing canonical result authority',
    );

    expect(stepFunctionsMocks.describeFinalizationExecution).not.toHaveBeenCalled();
    expect(markFailed).not.toHaveBeenCalled();
  });

  it('persists PROVER_EXECUTION_FAILED when a running execution closed as FAILED', async () => {
    const runningState = buildRunningState(fixedNow - 120_000);
    const failedState = buildFailedState({
      queuedAtMs: runningState.queuedAtMs,
      startedAtMs: runningState.startedAtMs,
      failedAtMs: fixedNow - 5000,
      code: 'PROVER_EXECUTION_FAILED',
      message: 'Finalization Step Functions execution failed.',
    });
    const markFailed = vi.fn<MockVoteStore['markAwsFinalizationFailed']>().mockResolvedValue(failedState);
    stepFunctionsMocks.describeFinalizationExecution.mockResolvedValueOnce({
      status: 'FAILED',
      startTimeMs: runningState.startedAtMs,
      stopTimeMs: fixedNow - 5000,
    });

    const payload = await requestStatus(buildStore(runningState, { markAwsFinalizationFailed: markFailed }));

    expect(markFailed).toHaveBeenCalledTimes(1);
    const failedCall = markFailed.mock.calls[0];
    if (!failedCall) {
      throw new Error('Expected markAwsFinalizationFailed to be called.');
    }
    expect(failedCall[1]).toMatchObject({
      finalizationId,
      queuedAtMs: runningState.queuedAtMs,
      startedAtMs: runningState.startedAtMs,
      failedAtMs: fixedNow - 5000,
      error: {
        code: 'PROVER_EXECUTION_FAILED',
      },
      observability: {
        source: 'reconcile',
        reason: 'PROVER_EXECUTION_FAILED',
      },
      stepFunctionsArn: executionArn,
    });
    expect(payload?.status).toBe('failed');
    expect(payload?.status === 'failed' ? payload.error.code : null).toBe('PROVER_EXECUTION_FAILED');
    expectReconcileAttempt('failed', 'PROVER_EXECUTION_FAILED');
  });

  it('persists timeout when a running execution closed as TIMED_OUT', async () => {
    const runningState = buildRunningState(fixedNow - 120_000);
    const timedOutState = buildTimedOutState({
      queuedAtMs: runningState.queuedAtMs,
      startedAtMs: runningState.startedAtMs,
      timeoutAtMs: fixedNow - 5000,
    });
    const markTimedOut = vi.fn<MockVoteStore['markAwsFinalizationTimedOut']>().mockResolvedValue(timedOutState);
    stepFunctionsMocks.describeFinalizationExecution.mockResolvedValueOnce({
      status: 'TIMED_OUT',
      startTimeMs: runningState.startedAtMs,
      stopTimeMs: fixedNow - 5000,
    });

    const payload = await requestStatus(buildStore(runningState, { markAwsFinalizationTimedOut: markTimedOut }));

    expect(markTimedOut).toHaveBeenCalledTimes(1);
    const timedOutCall = markTimedOut.mock.calls[0];
    if (!timedOutCall) {
      throw new Error('Expected markAwsFinalizationTimedOut to be called.');
    }
    expect(timedOutCall[1]).toMatchObject({
      finalizationId,
      queuedAtMs: runningState.queuedAtMs,
      startedAtMs: runningState.startedAtMs,
      timeoutAtMs: fixedNow - 5000,
      stepFunctionsArn: executionArn,
      observability: {
        source: 'reconcile',
        reason: 'EXECUTION_TIMED_OUT',
      },
    });
    expect(payload?.status).toBe('timeout');
    expectReconcileAttempt('timeout', 'EXECUTION_TIMED_OUT');
  });

  it('persists PROVER_EXECUTION_ABORTED when a running execution closed as ABORTED', async () => {
    const runningState = buildRunningState(fixedNow - 120_000);
    const failedState = buildFailedState({
      queuedAtMs: runningState.queuedAtMs,
      startedAtMs: runningState.startedAtMs,
      failedAtMs: fixedNow - 5000,
      code: 'PROVER_EXECUTION_ABORTED',
      message: 'Finalization Step Functions execution was aborted.',
    });
    const markFailed = vi.fn<MockVoteStore['markAwsFinalizationFailed']>().mockResolvedValue(failedState);
    stepFunctionsMocks.describeFinalizationExecution.mockResolvedValueOnce({
      status: 'ABORTED',
      startTimeMs: runningState.startedAtMs,
      stopTimeMs: fixedNow - 5000,
    });

    const payload = await requestStatus(buildStore(runningState, { markAwsFinalizationFailed: markFailed }));

    expect(markFailed).toHaveBeenCalledTimes(1);
    const failedCall = markFailed.mock.calls[0];
    if (!failedCall) {
      throw new Error('Expected markAwsFinalizationFailed to be called.');
    }
    expect(failedCall[1]).toMatchObject({
      finalizationId,
      queuedAtMs: runningState.queuedAtMs,
      startedAtMs: runningState.startedAtMs,
      failedAtMs: fixedNow - 5000,
      error: {
        code: 'PROVER_EXECUTION_ABORTED',
      },
      observability: {
        source: 'reconcile',
        reason: 'PROVER_EXECUTION_ABORTED',
      },
      stepFunctionsArn: executionArn,
    });
    expect(payload?.status).toBe('failed');
    expect(payload?.status === 'failed' ? payload.error.code : null).toBe('PROVER_EXECUTION_ABORTED');
    expectReconcileAttempt('failed', 'PROVER_EXECUTION_ABORTED');
  });

  it('persists FINALIZATION_OUTCOME_UNRECORDED when a running execution closed as SUCCEEDED', async () => {
    const runningState = buildRunningState(fixedNow - 120_000);
    const failedState = buildFailedState({
      queuedAtMs: runningState.queuedAtMs,
      startedAtMs: runningState.startedAtMs,
      failedAtMs: fixedNow - 5000,
      code: 'FINALIZATION_OUTCOME_UNRECORDED',
      message: 'Finalization Step Functions execution succeeded without recording the finalization result.',
    });
    const markFailed = vi.fn<MockVoteStore['markAwsFinalizationFailed']>().mockResolvedValue(failedState);
    stepFunctionsMocks.describeFinalizationExecution.mockResolvedValueOnce({
      status: 'SUCCEEDED',
      startTimeMs: runningState.startedAtMs,
      stopTimeMs: fixedNow - 5000,
    });

    const payload = await requestStatus(buildStore(runningState, { markAwsFinalizationFailed: markFailed }));

    expect(markFailed).toHaveBeenCalledTimes(1);
    const failedCall = markFailed.mock.calls[0];
    if (!failedCall) {
      throw new Error('Expected markAwsFinalizationFailed to be called.');
    }
    expect(failedCall[1]).toMatchObject({
      finalizationId,
      queuedAtMs: runningState.queuedAtMs,
      startedAtMs: runningState.startedAtMs,
      failedAtMs: fixedNow - 5000,
      error: {
        code: 'FINALIZATION_OUTCOME_UNRECORDED',
        details: {
          executionStatus: 'SUCCEEDED',
        },
      },
      observability: {
        source: 'reconcile',
        reason: 'FINALIZATION_OUTCOME_UNRECORDED',
      },
      stepFunctionsArn: executionArn,
    });
    expect(payload?.status).toBe('failed');
    expect(payload?.status === 'failed' ? payload.error.code : null).toBe('FINALIZATION_OUTCOME_UNRECORDED');
    expectReconcileAttempt('failed', 'FINALIZATION_OUTCOME_UNRECORDED');
  });
});
