import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import type { SessionData } from '@stark-ballot/domain/types/server';
import type { MockVoteStore } from '@stark-ballot/test-support/testing/mockVoteStore';
import {
  admitAwsPersistedFinalizationStateBranch,
  type AwsFinalizationRuntimeState,
} from '@stark-ballot/aws-adapters/finalize/finalizationPersistenceEnvelope';
import {
  SessionStatusResponseSchema,
  type SessionStatusResponse,
} from '@stark-ballot/api-contract/validation/apiSchemas';
import { createMockVoteStore } from '@stark-ballot/test-support/testing/mockVoteStore';
import { createSessionCapabilityToken } from '@stark-ballot/domain/security/sessionCapabilityToken';
import { SESSION_CAPABILITY_HEADER } from '@stark-ballot/domain/session/capability';
import { logger } from '@stark-ballot/diagnostics/logger';
import { resolveCurrentContractGeneration } from '@stark-ballot/domain/contract';
import { getSessionStatusHandler } from './sessionStatus';

const stepFunctionsMocks = vi.hoisted(() => ({
  describeFinalizationExecution: vi.fn(),
}));

vi.mock('../adapters/finalizationStepFunctions', () => ({
  describeFinalizationExecution: stepFunctionsMocks.describeFinalizationExecution,
}));

const capabilitySecret = 'session-status-handler-secret-0123456789abcdef';
const sessionId = 'session-status-1';
const executionId = 'exec-status-1';
const contractGeneration = resolveCurrentContractGeneration();
const fixedNow = 1_730_000_000_000;
const stateMachineArn =
  'arn:aws:states:ap-northeast-1:123456789012:stateMachine:stark-ballot-simulator-test-finalization';
const executionArn =
  'arn:aws:states:ap-northeast-1:123456789012:execution:stark-ballot-simulator-test-finalization:exec-status-1';
type RunningFinalizationState = Extract<AwsFinalizationRuntimeState, { status: 'running' }>;
type SucceededFinalizationState = Extract<AwsFinalizationRuntimeState, { status: 'succeeded' }>;

function buildSession(finalizationState: AwsFinalizationRuntimeState): SessionData {
  return {
    sessionId,
    contractGeneration,
    finalizationContractGeneration: contractGeneration,
    hasPersistedFinalizationBranch: true,
    votes: new Map(),
    botCount: 0,
    finalized: false,
    createdAt: fixedNow - 10_000,
    lastActivity: fixedNow - 1000,
    finalizationState: admitAwsPersistedFinalizationStateBranch(finalizationState),
  };
}

function buildPendingState(queuedAt: number): AwsFinalizationRuntimeState {
  return {
    status: 'pending',
    executionId,
    queuedAt,
  };
}

function buildRunningState(startedAt: number): RunningFinalizationState {
  return {
    status: 'running',
    executionId,
    queuedAt: startedAt - 1000,
    startedAt,
    stepFunctionsArn: executionArn,
  };
}

function buildFailedState(params: {
  queuedAt: number;
  startedAt?: number;
  failedAt: number;
  code: string;
  message: string;
}): AwsFinalizationRuntimeState {
  return {
    status: 'failed',
    executionId,
    queuedAt: params.queuedAt,
    ...(params.startedAt === undefined ? {} : { startedAt: params.startedAt }),
    failedAt: params.failedAt,
    error: {
      code: params.code,
      message: params.message,
    },
    stepFunctionsArn: executionArn,
  };
}

function buildTimedOutState(params: {
  queuedAt: number;
  startedAt?: number;
  timeoutAt: number;
}): AwsFinalizationRuntimeState {
  return {
    status: 'timeout',
    executionId,
    queuedAt: params.queuedAt,
    ...(params.startedAt === undefined ? {} : { startedAt: params.startedAt }),
    timeoutAt: params.timeoutAt,
    stepFunctionsArn: executionArn,
  };
}

function buildSucceededState(params: {
  queuedAt: number;
  startedAt: number;
  completedAt: number;
}): SucceededFinalizationState {
  return {
    status: 'succeeded',
    executionId,
    queuedAt: params.queuedAt,
    startedAt: params.startedAt,
    completedAt: params.completedAt,
    stepFunctionsArn: executionArn,
  };
}

function buildStore(
  finalizationState: AwsFinalizationRuntimeState,
  overrides: Partial<MockVoteStore> = {},
): MockVoteStore {
  return createMockVoteStore({
    getSession: () => Promise.resolve(buildSession(finalizationState)),
    ...overrides,
  });
}

function authRequest(): Request {
  return new Request(`http://localhost/api/sessions/${sessionId}/status`, {
    headers: {
      [SESSION_CAPABILITY_HEADER]: createSessionCapabilityToken({ sessionId }, capabilitySecret),
    },
  });
}

async function readStatusResponse(response: Response): Promise<SessionStatusResponse> {
  const body: unknown = await response.json();
  return SessionStatusResponseSchema.parse(body);
}

function executionDoesNotExistError(): Error {
  const error = new Error('execution does not exist');
  error.name = 'ExecutionDoesNotExist';
  return error;
}

async function requestStatus(store: MockVoteStore): Promise<SessionStatusResponse> {
  const response = await getSessionStatusHandler({
    request: authRequest(),
    params: { sessionId },
    store,
  });
  expect(response.status).toBe(200);
  return readStatusResponse(response);
}

describe('getSessionStatusHandler finalization reconciliation', () => {
  let loggerWarnSpy: MockInstance<typeof logger.warn>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(fixedNow);
    vi.stubEnv('SESSION_CAPABILITY_SECRET', capabilitySecret);
    vi.stubEnv('FINALIZE_ASYNC_MODE', 'true');
    vi.stubEnv('PROVER_STEP_FUNCTIONS_ENABLED', 'true');
    vi.stubEnv('PROVER_STATE_MACHINE_ARN', stateMachineArn);
    vi.stubEnv('PROVER_WORK_QUEUE_URL', 'https://sqs.ap-northeast-1.amazonaws.com/123456789012/prover-work');
    stepFunctionsMocks.describeFinalizationExecution.mockReset();
    loggerWarnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    loggerWarnSpy.mockRestore();
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it('persists FINALIZATION_DISPATCH_TIMEOUT when an old pending execution is not found beyond the deadline', async () => {
    vi.stubEnv('FINALIZE_PENDING_DISPATCH_DEADLINE_SECONDS', '900');
    const pendingState = buildPendingState(fixedNow - 1_000_000);
    const failedState = buildFailedState({
      queuedAt: pendingState.queuedAt,
      failedAt: fixedNow,
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
      executionId,
      queuedAt: pendingState.queuedAt,
      contractGeneration,
      failedAt: fixedNow,
      error: {
        code: 'FINALIZATION_DISPATCH_TIMEOUT',
      },
    });
    expect(failedCall[1].error.message).toContain('900');
    expect(failedCall[1].error.details).toEqual(expect.objectContaining({ ageSeconds: 1000 }));
    expect(failedCall[1]).not.toHaveProperty('stepFunctionsArn');
    expect(payload.finalizationState?.status).toBe('failed');
    expect(payload.finalizationState?.executionId).toBe(executionId);
    expect(payload.finalizationState?.status === 'failed' ? payload.finalizationState.error.code : null).toBe(
      'FINALIZATION_DISPATCH_TIMEOUT',
    );
  });

  it('keeps a not-found pending execution pending at the dispatch deadline and fails just past it', async () => {
    vi.stubEnv('FINALIZE_PENDING_DISPATCH_DEADLINE_SECONDS', '900');
    const markAtDeadline = vi.fn<MockVoteStore['markAwsFinalizationFailed']>();
    const atDeadlineState = buildPendingState(fixedNow - 900_000);
    stepFunctionsMocks.describeFinalizationExecution.mockRejectedValueOnce(executionDoesNotExistError());

    const atDeadlinePayload = await requestStatus(
      buildStore(atDeadlineState, { markAwsFinalizationFailed: markAtDeadline }),
    );

    expect(atDeadlinePayload.finalizationState?.status).toBe('pending');
    expect(markAtDeadline).not.toHaveBeenCalled();

    const justPastDeadlineState = buildPendingState(fixedNow - 901_000);
    const justPastFailedState = buildFailedState({
      queuedAt: justPastDeadlineState.queuedAt,
      failedAt: fixedNow,
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

    expect(justPastPayload.finalizationState?.status).toBe('failed');
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
    expect(payload.finalizationState?.status).toBe('pending');
    expect(payload.finalizationState?.executionId).toBe(executionId);
  });

  it('describes a pending execution exactly at the initial grace boundary', async () => {
    const pendingState = buildPendingState(fixedNow - 60_000);
    const markFailed = vi.fn<MockVoteStore['markAwsFinalizationFailed']>();
    stepFunctionsMocks.describeFinalizationExecution.mockResolvedValueOnce({
      status: 'RUNNING',
      startTime: fixedNow - 1000,
      stopTime: null,
    });

    const payload = await requestStatus(buildStore(pendingState, { markAwsFinalizationFailed: markFailed }));

    expect(stepFunctionsMocks.describeFinalizationExecution).toHaveBeenCalledWith(executionArn);
    expect(markFailed).not.toHaveBeenCalled();
    expect(payload.finalizationState?.status).toBe('pending');
  });

  it('keeps an old pending execution pending when Step Functions reports RUNNING', async () => {
    const pendingState = buildPendingState(fixedNow - 120_000);
    const markFailed = vi.fn<MockVoteStore['markAwsFinalizationFailed']>();
    stepFunctionsMocks.describeFinalizationExecution.mockResolvedValueOnce({
      status: 'RUNNING',
      startTime: fixedNow - 60_000,
      stopTime: null,
    });

    const payload = await requestStatus(buildStore(pendingState, { markAwsFinalizationFailed: markFailed }));

    expect(stepFunctionsMocks.describeFinalizationExecution).toHaveBeenCalledWith(executionArn);
    expect(markFailed).not.toHaveBeenCalled();
    expect(payload.finalizationState?.status).toBe('pending');
    expect(payload.finalizationState?.executionId).toBe(executionId);
  });

  it('keeps a beyond-deadline pending execution pending when Step Functions reports RUNNING', async () => {
    vi.stubEnv('FINALIZE_PENDING_DISPATCH_DEADLINE_SECONDS', '900');
    const pendingState = buildPendingState(fixedNow - 1_000_000);
    const markFailed = vi.fn<MockVoteStore['markAwsFinalizationFailed']>();
    stepFunctionsMocks.describeFinalizationExecution.mockResolvedValueOnce({
      status: 'RUNNING',
      startTime: fixedNow - 60_000,
      stopTime: null,
    });

    const payload = await requestStatus(buildStore(pendingState, { markAwsFinalizationFailed: markFailed }));

    expect(stepFunctionsMocks.describeFinalizationExecution).toHaveBeenCalledWith(executionArn);
    expect(markFailed).not.toHaveBeenCalled();
    expect(payload.finalizationState?.status).toBe('pending');
  });

  it.each(['SUCCEEDED', 'FAILED', 'TIMED_OUT', 'ABORTED'] as const)(
    'persists FINALIZATION_OUTCOME_UNRECORDED when a pending execution closed as %s',
    async (executionStatus) => {
      const pendingState = buildPendingState(fixedNow - 120_000);
      const failedState = buildFailedState({
        queuedAt: pendingState.queuedAt,
        failedAt: fixedNow,
        code: 'FINALIZATION_OUTCOME_UNRECORDED',
        message: `Finalization execution ${executionStatus} before recording an outcome.`,
      });
      const markFailed = vi.fn<MockVoteStore['markAwsFinalizationFailed']>().mockResolvedValue(failedState);
      stepFunctionsMocks.describeFinalizationExecution.mockResolvedValueOnce({
        status: executionStatus,
        startTime: fixedNow - 60_000,
        stopTime: fixedNow - 10_000,
      });

      const payload = await requestStatus(buildStore(pendingState, { markAwsFinalizationFailed: markFailed }));

      expect(stepFunctionsMocks.describeFinalizationExecution).toHaveBeenCalledWith(executionArn);
      expect(markFailed).toHaveBeenCalledTimes(1);
      const failedCall = markFailed.mock.calls[0];
      if (!failedCall) {
        throw new Error('Expected markAwsFinalizationFailed to be called.');
      }
      expect(failedCall[1]).toMatchObject({
        executionId,
        queuedAt: pendingState.queuedAt,
        contractGeneration,
        failedAt: fixedNow,
        error: {
          code: 'FINALIZATION_OUTCOME_UNRECORDED',
          details: {
            executionStatus,
          },
        },
      });
      expect(payload.finalizationState?.status).toBe('failed');
      expect(payload.finalizationState?.status === 'failed' ? payload.finalizationState.error.code : null).toBe(
        'FINALIZATION_OUTCOME_UNRECORDED',
      );
    },
  );

  it('does not describe a pending execution during the initial grace period', async () => {
    const pendingState = buildPendingState(fixedNow - 30_000);
    const markFailed = vi.fn<MockVoteStore['markAwsFinalizationFailed']>();

    const payload = await requestStatus(buildStore(pendingState, { markAwsFinalizationFailed: markFailed }));

    expect(stepFunctionsMocks.describeFinalizationExecution).not.toHaveBeenCalled();
    expect(markFailed).not.toHaveBeenCalled();
    expect(payload.finalizationState?.status).toBe('pending');
  });

  it.each([
    ['FINALIZE_ASYNC_MODE off', 'FINALIZE_ASYNC_MODE', 'false'],
    ['PROVER_STEP_FUNCTIONS_ENABLED off', 'PROVER_STEP_FUNCTIONS_ENABLED', 'false'],
  ])('does not describe stale pending executions when %s', async (_label, envName, envValue) => {
    vi.stubEnv(envName, envValue);
    const pendingState = buildPendingState(fixedNow - 1_000_000);
    const markFailed = vi.fn<MockVoteStore['markAwsFinalizationFailed']>();

    const payload = await requestStatus(buildStore(pendingState, { markAwsFinalizationFailed: markFailed }));

    expect(stepFunctionsMocks.describeFinalizationExecution).not.toHaveBeenCalled();
    expect(markFailed).not.toHaveBeenCalled();
    expect(payload.finalizationState?.status).toBe('pending');
  });

  it('warns and leaves stale pending state unchanged when the Step Functions ARN cannot be constructed', async () => {
    vi.stubEnv('PROVER_STATE_MACHINE_ARN', 'not-a-state-machine-arn');
    const pendingState = buildPendingState(fixedNow - 1_000_000);
    const markFailed = vi.fn<MockVoteStore['markAwsFinalizationFailed']>();

    const payload = await requestStatus(buildStore(pendingState, { markAwsFinalizationFailed: markFailed }));

    expect(stepFunctionsMocks.describeFinalizationExecution).not.toHaveBeenCalled();
    expect(markFailed).not.toHaveBeenCalled();
    expect(loggerWarnSpy).toHaveBeenCalledWith(
      '[Status API] Cannot reconcile pending finalization without a valid Step Functions ARN',
      expect.objectContaining({
        sessionId,
        executionId,
        configuredStateMachineArn: 'not-a-state-machine-arn',
      }),
    );
    expect(payload.finalizationState?.status).toBe('pending');
  });

  it('keeps an old pending execution pending when Step Functions describe fails with an unexpected error', async () => {
    const pendingState = buildPendingState(fixedNow - 120_000);
    const markFailed = vi.fn<MockVoteStore['markAwsFinalizationFailed']>();
    stepFunctionsMocks.describeFinalizationExecution.mockRejectedValueOnce(
      new Error('temporary Step Functions outage'),
    );

    const payload = await requestStatus(buildStore(pendingState, { markAwsFinalizationFailed: markFailed }));

    expect(stepFunctionsMocks.describeFinalizationExecution).toHaveBeenCalledWith(executionArn);
    expect(markFailed).not.toHaveBeenCalled();
    expect(payload.finalizationState?.status).toBe('pending');
  });

  it('falls back to a schema-valid display projection when failed-state persistence throws', async () => {
    const runningState = buildRunningState(fixedNow - 120_000);
    const markFailed = vi.fn<MockVoteStore['markAwsFinalizationFailed']>().mockRejectedValue(new Error('write failed'));
    stepFunctionsMocks.describeFinalizationExecution.mockResolvedValueOnce({
      status: 'FAILED',
      startTime: runningState.startedAt,
      stopTime: fixedNow - 5000,
    });

    const payload = await requestStatus(buildStore(runningState, { markAwsFinalizationFailed: markFailed }));

    expect(markFailed).toHaveBeenCalledTimes(1);
    expect(payload.finalizationState?.status).toBe('failed');
    expect(payload.finalizationState?.status === 'failed' ? payload.finalizationState.error.code : null).toBe(
      'STEP_FUNCTIONS_EXECUTION_FAILED',
    );
  });

  it('uses a terminal state returned by the store when a sticky guard wins the reconciliation race', async () => {
    const runningState = buildRunningState(fixedNow - 120_000);
    const succeededState = buildSucceededState({
      queuedAt: runningState.queuedAt,
      startedAt: runningState.startedAt,
      completedAt: fixedNow - 2500,
    });
    const markFailed = vi.fn<MockVoteStore['markAwsFinalizationFailed']>().mockResolvedValue(succeededState);
    stepFunctionsMocks.describeFinalizationExecution.mockResolvedValueOnce({
      status: 'FAILED',
      startTime: runningState.startedAt,
      stopTime: fixedNow - 5000,
    });

    const payload = await requestStatus(buildStore(runningState, { markAwsFinalizationFailed: markFailed }));

    expect(markFailed).toHaveBeenCalledTimes(1);
    expect(payload.finalizationState?.status).toBe('succeeded');
    expect(payload.finalizationState?.executionId).toBe(executionId);
  });

  it('persists PROVER_EXECUTION_FAILED when a running execution closed as FAILED', async () => {
    const runningState = buildRunningState(fixedNow - 120_000);
    const failedState = buildFailedState({
      queuedAt: runningState.queuedAt,
      startedAt: runningState.startedAt,
      failedAt: fixedNow - 5000,
      code: 'PROVER_EXECUTION_FAILED',
      message: 'Finalization Step Functions execution failed.',
    });
    const markFailed = vi.fn<MockVoteStore['markAwsFinalizationFailed']>().mockResolvedValue(failedState);
    stepFunctionsMocks.describeFinalizationExecution.mockResolvedValueOnce({
      status: 'FAILED',
      startTime: runningState.startedAt,
      stopTime: fixedNow - 5000,
    });

    const payload = await requestStatus(buildStore(runningState, { markAwsFinalizationFailed: markFailed }));

    expect(markFailed).toHaveBeenCalledTimes(1);
    const failedCall = markFailed.mock.calls[0];
    if (!failedCall) {
      throw new Error('Expected markAwsFinalizationFailed to be called.');
    }
    expect(failedCall[1]).toMatchObject({
      executionId,
      queuedAt: runningState.queuedAt,
      startedAt: runningState.startedAt,
      contractGeneration,
      failedAt: fixedNow - 5000,
      error: {
        code: 'PROVER_EXECUTION_FAILED',
      },
      stepFunctionsArn: executionArn,
    });
    expect(payload.finalizationState?.status).toBe('failed');
    expect(payload.finalizationState?.status === 'failed' ? payload.finalizationState.error.code : null).toBe(
      'PROVER_EXECUTION_FAILED',
    );
  });

  it('persists timeout when a running execution closed as TIMED_OUT', async () => {
    const runningState = buildRunningState(fixedNow - 120_000);
    const timedOutState = buildTimedOutState({
      queuedAt: runningState.queuedAt,
      startedAt: runningState.startedAt,
      timeoutAt: fixedNow - 5000,
    });
    const markTimedOut = vi.fn<MockVoteStore['markAwsFinalizationTimedOut']>().mockResolvedValue(timedOutState);
    stepFunctionsMocks.describeFinalizationExecution.mockResolvedValueOnce({
      status: 'TIMED_OUT',
      startTime: runningState.startedAt,
      stopTime: fixedNow - 5000,
    });

    const payload = await requestStatus(buildStore(runningState, { markAwsFinalizationTimedOut: markTimedOut }));

    expect(markTimedOut).toHaveBeenCalledTimes(1);
    const timedOutCall = markTimedOut.mock.calls[0];
    if (!timedOutCall) {
      throw new Error('Expected markAwsFinalizationTimedOut to be called.');
    }
    expect(timedOutCall[1]).toMatchObject({
      executionId,
      queuedAt: runningState.queuedAt,
      startedAt: runningState.startedAt,
      contractGeneration,
      timeoutAt: fixedNow - 5000,
      stepFunctionsArn: executionArn,
    });
    expect(payload.finalizationState?.status).toBe('timeout');
  });

  it('persists PROVER_EXECUTION_ABORTED when a running execution closed as ABORTED', async () => {
    const runningState = buildRunningState(fixedNow - 120_000);
    const failedState = buildFailedState({
      queuedAt: runningState.queuedAt,
      startedAt: runningState.startedAt,
      failedAt: fixedNow - 5000,
      code: 'PROVER_EXECUTION_ABORTED',
      message: 'Finalization Step Functions execution was aborted.',
    });
    const markFailed = vi.fn<MockVoteStore['markAwsFinalizationFailed']>().mockResolvedValue(failedState);
    stepFunctionsMocks.describeFinalizationExecution.mockResolvedValueOnce({
      status: 'ABORTED',
      startTime: runningState.startedAt,
      stopTime: fixedNow - 5000,
    });

    const payload = await requestStatus(buildStore(runningState, { markAwsFinalizationFailed: markFailed }));

    expect(markFailed).toHaveBeenCalledTimes(1);
    const failedCall = markFailed.mock.calls[0];
    if (!failedCall) {
      throw new Error('Expected markAwsFinalizationFailed to be called.');
    }
    expect(failedCall[1]).toMatchObject({
      executionId,
      queuedAt: runningState.queuedAt,
      startedAt: runningState.startedAt,
      contractGeneration,
      failedAt: fixedNow - 5000,
      error: {
        code: 'PROVER_EXECUTION_ABORTED',
      },
      stepFunctionsArn: executionArn,
    });
    expect(payload.finalizationState?.status).toBe('failed');
    expect(payload.finalizationState?.status === 'failed' ? payload.finalizationState.error.code : null).toBe(
      'PROVER_EXECUTION_ABORTED',
    );
  });

  it('persists FINALIZATION_OUTCOME_UNRECORDED when a running execution closed as SUCCEEDED', async () => {
    const runningState = buildRunningState(fixedNow - 120_000);
    const failedState = buildFailedState({
      queuedAt: runningState.queuedAt,
      startedAt: runningState.startedAt,
      failedAt: fixedNow - 5000,
      code: 'FINALIZATION_OUTCOME_UNRECORDED',
      message: 'Finalization Step Functions execution succeeded without recording the finalization result.',
    });
    const markFailed = vi.fn<MockVoteStore['markAwsFinalizationFailed']>().mockResolvedValue(failedState);
    stepFunctionsMocks.describeFinalizationExecution.mockResolvedValueOnce({
      status: 'SUCCEEDED',
      startTime: runningState.startedAt,
      stopTime: fixedNow - 5000,
    });

    const payload = await requestStatus(buildStore(runningState, { markAwsFinalizationFailed: markFailed }));

    expect(markFailed).toHaveBeenCalledTimes(1);
    const failedCall = markFailed.mock.calls[0];
    if (!failedCall) {
      throw new Error('Expected markAwsFinalizationFailed to be called.');
    }
    expect(failedCall[1]).toMatchObject({
      executionId,
      queuedAt: runningState.queuedAt,
      startedAt: runningState.startedAt,
      contractGeneration,
      failedAt: fixedNow - 5000,
      error: {
        code: 'FINALIZATION_OUTCOME_UNRECORDED',
        details: {
          executionStatus: 'SUCCEEDED',
        },
      },
      stepFunctionsArn: executionArn,
    });
    expect(payload.finalizationState?.status).toBe('failed');
    expect(payload.finalizationState?.status === 'failed' ? payload.finalizationState.error.code : null).toBe(
      'FINALIZATION_OUTCOME_UNRECORDED',
    );
  });
});
