/**
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';

const sfnSendMock = vi.hoisted(() => vi.fn());
const getSessionMock = vi.hoisted(() => vi.fn());
const markAwsFinalizationRunningMock = vi.hoisted(() => vi.fn());
const emitCanonicalEventMock = vi.hoisted(() => vi.fn());

vi.mock('@stark-ballot/diagnostics/canonicalEvents', () => ({
  emitCanonicalEvent: emitCanonicalEventMock,
}));

vi.mock('@aws-sdk/client-sfn', () => {
  class MockSFNClient {
    send = sfnSendMock;
  }

  class MockStartExecutionCommand {
    input: unknown;

    constructor(input: unknown) {
      this.input = input;
    }
  }

  class MockDescribeExecutionCommand {
    input: unknown;

    constructor(input: unknown) {
      this.input = input;
    }
  }

  return {
    DescribeExecutionCommand: MockDescribeExecutionCommand,
    SFNClient: MockSFNClient,
    StartExecutionCommand: MockStartExecutionCommand,
  };
});

vi.mock('@stark-ballot/aws-adapters/config/awsRuntimeConfigReferenceResolver', () => ({
  ensureAwsRuntimeConfigReferencesLoaded: vi.fn(async () => await Promise.resolve(undefined)),
}));

vi.mock('@stark-ballot/runtime-config/env/validate', () => ({
  validateEnv: vi.fn(),
}));

vi.mock('@stark-ballot/runtime-config/env/observability', () => ({
  collectInvalidTargetObservabilityEnvNames: vi.fn(() => []),
  validateTargetObservabilityEnv: vi.fn(),
}));

vi.mock('@stark-ballot/aws-adapters/store/storeInstance', () => ({
  getGlobalStore: vi.fn(() => ({
    getSession: getSessionMock,
    markAwsFinalizationRunning: markAwsFinalizationRunningMock,
    markAwsFinalizationSucceeded: vi.fn(),
    markAwsFinalizationFailed: vi.fn(),
    markAwsFinalizationTimedOut: vi.fn(),
  })),
}));

vi.mock('@stark-ballot/aws-adapters/finalize/async-prover-artifacts', () => ({
  validateAsyncProverArtifactKeys: vi.fn(
    ({
      sessionId,
      executionId,
      inputS3Key,
      outputS3Prefix,
      bundleS3Key,
    }: {
      sessionId: string;
      executionId: string;
      inputS3Key: string;
      outputS3Prefix: string;
      bundleS3Key: string;
    }) => {
      const expected = {
        inputS3Key: `sessions/${sessionId}/${executionId}/input.json`,
        outputS3Prefix: `sessions/${sessionId}/${executionId}`,
        bundleS3Key: `sessions/${sessionId}/${executionId}/bundle.zip`,
      };
      if (
        inputS3Key !== expected.inputS3Key ||
        outputS3Prefix !== expected.outputS3Prefix ||
        bundleS3Key !== expected.bundleS3Key
      ) {
        throw new Error('Async prover artifact keys must match the canonical session/execution S3 layout');
      }
      return expected;
    },
  ),
  persistAsyncProverInputToS3: vi.fn(() =>
    Promise.resolve({
      inputS3Key: 'sessions/generated/input.json',
      outputS3Prefix: 'sessions/generated',
      bundleS3Key: 'sessions/generated/bundle.zip',
    }),
  ),
}));

const artifactsModule = await import('@stark-ballot/aws-adapters/finalize/async-prover-artifacts');
const resolverModule = await import('@stark-ballot/aws-adapters/config/awsRuntimeConfigReferenceResolver');
const envModule = await import('@stark-ballot/runtime-config/env/validate');
const { parseAwsFinalizationRuntimeState } =
  await import('@stark-ballot/aws-adapters/finalize/finalizationPersistenceEnvelope');
const { logger } = await import('@stark-ballot/diagnostics/logger');
const { hashSessionIdForLogging } = await import('@stark-ballot/diagnostics/logging');
const { handler } = await import('./handler');

const DEFAULT_SESSION_ID = '550e8400-e29b-41d4-a716-446655440000';
const DEFAULT_EXECUTION_ID = '01HZ3JQ4ABXYZ7890DEF123456';
const DEFAULT_QUEUED_AT = 1_700_000_000_000;

function hex(byte: string): string {
  return `0x${byte.repeat(64)}`;
}

interface DispatchTestMessage extends Record<string, unknown> {
  sessionId: string;
  contractGeneration: string;
  executionId: string;
  queuedAt: number;
  inputS3Key: string;
  outputS3Prefix: string;
  bundleS3Key: string;
}

interface StartExecutionCommandLike {
  input: {
    stateMachineArn?: string;
    name?: string;
    input?: string;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isStartExecutionCommandLike(value: unknown): value is StartExecutionCommandLike {
  return isRecord(value) && isRecord(value['input']);
}

function buildMessage(overrides: Record<string, unknown> = {}): DispatchTestMessage {
  return {
    messageVersion: 'v1.1',
    sessionId: DEFAULT_SESSION_ID,
    contractGeneration: '2026-04-zkvm-current-v1',
    executionId: DEFAULT_EXECUTION_ID,
    queuedAt: DEFAULT_QUEUED_AT,
    expectedImageId: hex('1'),
    inputS3Key: `sessions/${DEFAULT_SESSION_ID}/${DEFAULT_EXECUTION_ID}/input.json`,
    outputS3Prefix: `sessions/${DEFAULT_SESSION_ID}/${DEFAULT_EXECUTION_ID}`,
    bundleS3Key: `sessions/${DEFAULT_SESSION_ID}/${DEFAULT_EXECUTION_ID}/bundle.zip`,
    scenarios: [],
    simulateTampering: false,
    ...overrides,
  };
}

function buildSessionWithFinalizationState(finalizationState: Record<string, unknown>): Record<string, unknown> {
  const parsedState = parseAwsFinalizationRuntimeState(finalizationState);
  if (!parsedState) {
    throw new Error('Expected test finalization state to parse as an AWS runtime state');
  }
  return {
    sessionId: DEFAULT_SESSION_ID,
    finalizationState: parsedState,
  };
}

function expectNoDispatchSideEffects(): void {
  expect(artifactsModule.persistAsyncProverInputToS3).not.toHaveBeenCalled();
  expect(sfnSendMock).not.toHaveBeenCalled();
  expect(markAwsFinalizationRunningMock).not.toHaveBeenCalled();
}

function expectDispatchDropped(
  message: DispatchTestMessage,
  reason: 'session_missing' | 'not_pending' | 'already_dispatched' | 'already_processed' | 'malformed',
): void {
  expect(emitCanonicalEventMock).toHaveBeenCalledWith({
    event: 'dispatch_dropped',
    reason,
    session_id_hash: hashSessionIdForLogging(message.sessionId),
    execution_id: message.executionId,
  });
  expect(JSON.stringify(emitCanonicalEventMock.mock.calls)).not.toContain(message.sessionId);
  expect(JSON.stringify(emitCanonicalEventMock.mock.calls)).not.toContain(message.inputS3Key);
}

describe('target proof-dispatcher handler', () => {
  const originalEnv = { ...process.env };
  let infoSpy: MockInstance<typeof logger.info>;
  let warnSpy: MockInstance<typeof logger.warn>;
  let errorSpy: MockInstance<typeof logger.error>;

  beforeEach(() => {
    vi.clearAllMocks();
    infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => {});
    warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});
    process.env['PROVER_STATE_MACHINE_ARN'] =
      'arn:aws:states:ap-northeast-1:123456789012:stateMachine:stark-ballot-simulator-stark-dev-develop-finalization';
    process.env['TARGET_AWS_RUNTIME'] = '1';
    sfnSendMock.mockResolvedValue({
      executionArn:
        'arn:aws:states:ap-northeast-1:123456789012:execution:stark-ballot-simulator-stark-dev-develop-finalization:01HZ3JQ4ABXYZ7890DEF123456',
    });
    getSessionMock.mockResolvedValue(
      buildSessionWithFinalizationState({
        status: 'pending',
        executionId: DEFAULT_EXECUTION_ID,
        queuedAt: DEFAULT_QUEUED_AT,
      }),
    );
  });

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) {
        delete process.env[key];
      }
    }
    Object.assign(process.env, originalEnv);
    infoSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('starts the configured state machine with the execution id as name without marking finalization running', async () => {
    const message = buildMessage();

    await expect(handler({ Records: [{ body: JSON.stringify(message) }] })).resolves.toEqual({
      batchItemFailures: [],
    });

    expect(sfnSendMock).toHaveBeenCalledTimes(1);
    const commandPayload: unknown = sfnSendMock.mock.calls[0]?.[0];
    expect(isStartExecutionCommandLike(commandPayload)).toBe(true);
    if (!isStartExecutionCommandLike(commandPayload) || !commandPayload.input.input) {
      throw new Error('Expected StartExecutionCommand-like payload');
    }
    expect(commandPayload.input.stateMachineArn).toBe(process.env['PROVER_STATE_MACHINE_ARN']);
    expect(commandPayload.input.name).toBe(message.executionId);

    const stepFunctionInput: unknown = JSON.parse(commandPayload.input.input);
    expect(stepFunctionInput).toEqual(
      expect.objectContaining({
        sessionId: message.sessionId,
        executionId: message.executionId,
        inputS3Key: message.inputS3Key,
        outputS3Prefix: message.outputS3Prefix,
        bundleS3Key: message.bundleS3Key,
      }),
    );
    expect(stepFunctionInput).not.toHaveProperty('zkvmInput');
    expect(stepFunctionInput).not.toHaveProperty('electionConfig');
    expect(stepFunctionInput).not.toHaveProperty('requestMeta');
    expect(JSON.stringify(stepFunctionInput)).not.toContain(hex('e'));
    expect(markAwsFinalizationRunningMock).not.toHaveBeenCalled();
    expect(emitCanonicalEventMock).toHaveBeenCalledWith({
      event: 'finalize_transition_attempted',
      to: 'running',
      source: 'proof_dispatcher',
      reason: 'DISPATCH_REQUESTED',
      session_id_hash: hashSessionIdForLogging(message.sessionId),
      execution_id: message.executionId,
    });
    expect(JSON.stringify(emitCanonicalEventMock.mock.calls)).not.toContain(message.sessionId);
  });

  it('drops a message whose session finalization state is failed for the message execution id', async () => {
    const message = buildMessage();
    getSessionMock.mockResolvedValueOnce(
      buildSessionWithFinalizationState({
        status: 'failed',
        executionId: message.executionId,
        queuedAt: message.queuedAt,
        failedAt: message.queuedAt + 1_000,
        error: {
          code: 'USER_CANCELLED',
          message: 'User cancelled finalization',
        },
      }),
    );

    await expect(handler({ Records: [{ body: JSON.stringify(message) }] })).resolves.toEqual({
      batchItemFailures: [],
    });

    expect(sfnSendMock).not.toHaveBeenCalled();
    expect(markAwsFinalizationRunningMock).not.toHaveBeenCalled();
    expectDispatchDropped(message, 'not_pending');
  });

  it('drops a message whose session finalization state belongs to a different execution id', async () => {
    const message = buildMessage();
    getSessionMock.mockResolvedValueOnce(
      buildSessionWithFinalizationState({
        status: 'pending',
        executionId: '01HZ3JQ4ABXYZ7890DEF999999',
        queuedAt: message.queuedAt,
      }),
    );

    await expect(handler({ Records: [{ body: JSON.stringify(message) }] })).resolves.toEqual({
      batchItemFailures: [],
    });

    expect(sfnSendMock).not.toHaveBeenCalled();
    expect(markAwsFinalizationRunningMock).not.toHaveBeenCalled();
    expectDispatchDropped(message, 'already_processed');
  });

  it('drops a message whose session finalization state is running for the same execution id', async () => {
    const message = buildMessage();
    getSessionMock.mockResolvedValueOnce(
      buildSessionWithFinalizationState({
        status: 'running',
        executionId: message.executionId,
        queuedAt: message.queuedAt,
        startedAt: message.queuedAt + 1_000,
      }),
    );

    await expect(handler({ Records: [{ body: JSON.stringify(message) }] })).resolves.toEqual({
      batchItemFailures: [],
    });

    expect(sfnSendMock).not.toHaveBeenCalled();
    expect(markAwsFinalizationRunningMock).not.toHaveBeenCalled();
    expect(infoSpy).toHaveBeenCalledWith(
      '[ProofDispatcher] Dropping stale finalization work item',
      expect.objectContaining({
        session_id_hash: hashSessionIdForLogging(message.sessionId),
        executionId: message.executionId,
        currentExecutionId: message.executionId,
        currentStatus: 'running',
        reason: 'finalization_state_not_pending_for_execution',
      }),
    );
    expect(warnSpy).not.toHaveBeenCalled();
    expectDispatchDropped(message, 'already_dispatched');
  });

  it('drops a message with a distinct unparsable-state warning when finalizationState is present but invalid', async () => {
    const message = buildMessage();
    getSessionMock.mockResolvedValueOnce({
      sessionId: message.sessionId,
      finalizationState: {
        status: 'pending',
        executionId: message.executionId,
        queuedAt: message.queuedAt,
        unexpectedLegacyField: true,
      },
    });

    await expect(handler({ Records: [{ body: JSON.stringify(message) }] })).resolves.toEqual({
      batchItemFailures: [],
    });

    expect(sfnSendMock).not.toHaveBeenCalled();
    expect(markAwsFinalizationRunningMock).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      '[ProofDispatcher] Dropping finalization work item with unparsable finalization state',
      expect.objectContaining({
        session_id_hash: hashSessionIdForLogging(message.sessionId),
        executionId: message.executionId,
        reason: 'finalization_state_unparsable',
      }),
    );
    expect(infoSpy).not.toHaveBeenCalledWith(
      '[ProofDispatcher] Dropping stale finalization work item',
      expect.objectContaining({
        reason: 'finalization_state_not_pending_for_execution',
      }),
    );
    expectDispatchDropped(message, 'malformed');
  });

  it('drops a message whose session no longer exists', async () => {
    const message = buildMessage();
    getSessionMock.mockResolvedValueOnce(null);

    await expect(handler({ Records: [{ body: JSON.stringify(message) }] })).resolves.toEqual({
      batchItemFailures: [],
    });

    expect(sfnSendMock).not.toHaveBeenCalled();
    expect(markAwsFinalizationRunningMock).not.toHaveBeenCalled();
    expectDispatchDropped(message, 'session_missing');
  });

  it('proceeds when the session is still pending for the message execution id', async () => {
    const message = buildMessage();
    getSessionMock.mockResolvedValueOnce(
      buildSessionWithFinalizationState({
        status: 'pending',
        executionId: message.executionId,
        queuedAt: message.queuedAt,
      }),
    );

    await expect(handler({ Records: [{ body: JSON.stringify(message) }] })).resolves.toEqual({
      batchItemFailures: [],
    });

    expect(sfnSendMock).toHaveBeenCalledTimes(1);
    expect(markAwsFinalizationRunningMock).not.toHaveBeenCalled();
  });

  it('drops ExecutionAlreadyExists when a fresh session read shows the outcome was recorded', async () => {
    const message = buildMessage();
    const error = new Error('execution already exists');
    error.name = 'ExecutionAlreadyExists';
    sfnSendMock.mockRejectedValueOnce(error);
    getSessionMock
      .mockResolvedValueOnce(
        buildSessionWithFinalizationState({
          status: 'pending',
          executionId: message.executionId,
          queuedAt: message.queuedAt,
        }),
      )
      .mockResolvedValueOnce(
        buildSessionWithFinalizationState({
          status: 'failed',
          executionId: message.executionId,
          queuedAt: message.queuedAt,
          failedAt: message.queuedAt + 2_000,
          error: {
            code: 'USER_CANCELLED',
            message: 'User cancelled finalization',
          },
        }),
      );

    await expect(handler({ Records: [{ body: JSON.stringify(message) }] })).resolves.toEqual({
      batchItemFailures: [],
    });

    expect(sfnSendMock).toHaveBeenCalledTimes(1);
    expect(getSessionMock).toHaveBeenCalledTimes(2);
    expect(markAwsFinalizationRunningMock).not.toHaveBeenCalled();
    expect(infoSpy).toHaveBeenCalledWith(
      '[ProofDispatcher] Treating existing Step Functions execution as processed after state re-read',
      expect.objectContaining({
        session_id_hash: hashSessionIdForLogging(message.sessionId),
        executionId: message.executionId,
        currentStatus: 'failed',
      }),
    );
    expectDispatchDropped(message, 'already_processed');
  });

  it('drops ExecutionAlreadyExists when a fresh session read is still pending but the execution is open', async () => {
    const message = buildMessage();
    const error = new Error('execution already exists');
    error.name = 'ExecutionAlreadyExists';
    sfnSendMock.mockRejectedValueOnce(error).mockResolvedValueOnce({
      status: 'RUNNING',
    });
    getSessionMock.mockResolvedValue(
      buildSessionWithFinalizationState({
        status: 'pending',
        executionId: message.executionId,
        queuedAt: message.queuedAt,
      }),
    );

    await expect(handler({ Records: [{ body: JSON.stringify(message) }] })).resolves.toEqual({
      batchItemFailures: [],
    });

    expect(sfnSendMock).toHaveBeenCalledTimes(2);
    expect(getSessionMock).toHaveBeenCalledTimes(2);
    expect(markAwsFinalizationRunningMock).not.toHaveBeenCalled();
    expect(infoSpy).toHaveBeenCalledWith(
      '[ProofDispatcher] Treating existing open Step Functions execution as already dispatched',
      expect.objectContaining({
        session_id_hash: hashSessionIdForLogging(message.sessionId),
        executionId: message.executionId,
        currentStatus: 'pending',
      }),
    );
    expectDispatchDropped(message, 'already_dispatched');
  });

  it.each(['SUCCEEDED', 'FAILED'])(
    'throws ExecutionAlreadyExists when a fresh session read is still pending but the execution is %s',
    async (status) => {
      const message = buildMessage();
      const error = new Error('execution already exists');
      error.name = 'ExecutionAlreadyExists';
      sfnSendMock.mockRejectedValueOnce(error).mockResolvedValueOnce({ status });
      getSessionMock.mockResolvedValue(
        buildSessionWithFinalizationState({
          status: 'pending',
          executionId: message.executionId,
          queuedAt: message.queuedAt,
        }),
      );

      await expect(handler({ Records: [{ body: JSON.stringify(message) }] })).rejects.toThrow(
        'execution already exists',
      );

      expect(sfnSendMock).toHaveBeenCalledTimes(2);
      expect(getSessionMock).toHaveBeenCalledTimes(2);
      expect(markAwsFinalizationRunningMock).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledWith(
        '[ProofDispatcher] Step Functions execution already exists but finalization is still pending and execution is closed',
        expect.objectContaining({
          session_id_hash: hashSessionIdForLogging(message.sessionId),
          executionId: message.executionId,
          currentStatus: 'pending',
          executionStatus: status,
        }),
      );
      expect(emitCanonicalEventMock).toHaveBeenCalledWith({
        event: 'finalize_transition_attempted',
        to: 'running',
        source: 'proof_dispatcher',
        reason: 'STEP_FUNCTIONS_EXECUTION_CLOSED',
        session_id_hash: hashSessionIdForLogging(message.sessionId),
        execution_id: message.executionId,
      });
    },
  );

  it('rejects malformed SQS bodies before starting Step Functions', async () => {
    await expect(handler({ Records: [{ body: '{"messageVersion":' }] })).rejects.toThrow('Invalid SQS invocation');

    expect(sfnSendMock).not.toHaveBeenCalled();
    expect(markAwsFinalizationRunningMock).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith('Invocation payload is invalid', {
      event: 'invocation_invalid',
      source_kind: 'sqs',
      reason: 'record_body_invalid',
    });
    expect(emitCanonicalEventMock).toHaveBeenCalledWith({
      event: 'dispatch_dropped',
      reason: 'malformed',
    });
  });

  it('rejects malformed SQS envelopes without logging attacker-controlled values', async () => {
    const privateUri = 's3://private-bucket/sessions/raw-session/input.json';

    await expect(handler({ Records: privateUri })).rejects.toThrow('Invalid SQS invocation');

    expect(warnSpy).toHaveBeenCalledWith('Invocation payload is invalid', {
      event: 'invocation_invalid',
      source_kind: 'sqs',
      reason: 'event_shape_invalid',
    });
    expect(JSON.stringify(warnSpy.mock.calls)).not.toContain(privateUri);
    expect(emitCanonicalEventMock).toHaveBeenCalledWith({
      event: 'dispatch_dropped',
      reason: 'malformed',
    });
    expect(JSON.stringify(emitCanonicalEventMock.mock.calls)).not.toContain(privateUri);
    expectNoDispatchSideEffects();
  });

  it('emits runtime reference names only when cold-start resolution fails', async () => {
    const secretValue = 'never-log-this-resolved-secret';
    const resolutionError = new Error(`resolver failure: ${secretValue}`);
    vi.mocked(resolverModule.ensureAwsRuntimeConfigReferencesLoaded).mockImplementationOnce(
      async (_entrypoint, options) => {
        if (!options) throw new Error('Expected runtime-reference resolver options');
        options.invalidNameCollector?.add('SESSION_CAPABILITY_TTL_SECONDS_REF');
        await Promise.reject(resolutionError);
      },
    );

    await expect(handler({ Records: [] })).rejects.toMatchObject({
      name: 'RuntimeConfigValidationError',
      message: 'Runtime configuration validation failed',
      invalidNames: ['SESSION_CAPABILITY_TTL_SECONDS_REF'],
    });

    expect(errorSpy).toHaveBeenCalledWith('Runtime configuration is invalid', {
      event: 'config_invalid',
      invalid_names: ['SESSION_CAPABILITY_TTL_SECONDS_REF'],
    });
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain(secretValue);
    expect(envModule.validateEnv).not.toHaveBeenCalled();
    expectNoDispatchSideEffects();
  });

  it.each(['bad/segment-123', 'bad.segment-123', 'https://example.invalid/execution'])(
    'rejects unsafe execution id %s before dispatch side effects',
    async (executionId) => {
      await expect(
        handler({
          Records: [
            {
              body: JSON.stringify(
                buildMessage({
                  executionId,
                  inputS3Key: `sessions/550e8400-e29b-41d4-a716-446655440000/${executionId}/input.json`,
                  outputS3Prefix: `sessions/550e8400-e29b-41d4-a716-446655440000/${executionId}`,
                  bundleS3Key: `sessions/550e8400-e29b-41d4-a716-446655440000/${executionId}/bundle.zip`,
                }),
              ),
            },
          ],
        }),
      ).rejects.toThrow();

      expectNoDispatchSideEffects();
      expect(emitCanonicalEventMock).toHaveBeenCalledWith({
        event: 'dispatch_dropped',
        reason: 'malformed',
      });
    },
  );

  it.each([
    ['unset', undefined],
    ['non-1', '0'],
  ])('rejects when TARGET_AWS_RUNTIME is %s before dispatch side effects', async (_label, value) => {
    if (value === undefined) {
      delete process.env['TARGET_AWS_RUNTIME'];
    } else {
      process.env['TARGET_AWS_RUNTIME'] = value;
    }

    await expect(handler({ Records: [{ body: JSON.stringify(buildMessage()) }] })).rejects.toThrow(
      'Runtime configuration validation failed',
    );

    expect(envModule.validateEnv).not.toHaveBeenCalled();
    expectNoDispatchSideEffects();
    expect(errorSpy).toHaveBeenCalledWith('Runtime configuration is invalid', {
      event: 'config_invalid',
      invalid_names: ['TARGET_AWS_RUNTIME'],
    });
  });

  it('fails closed when target prover messages omit required S3 artifact keys', async () => {
    const message = buildMessage({
      zkvmInput: {
        electionId: '550e8400-e29b-41d4-a716-446655440001',
        bulletinRoot: hex('a'),
        treeSize: 1,
        logId: hex('b'),
        timestamp: 1_700_000_000_000,
        totalExpected: 1,
        electionConfigHash: hex('c'),
        votes: [
          {
            commitment: hex('d'),
            choice: 0,
            random: hex('e'),
            index: 0,
            merklePath: [hex('f')],
          },
        ],
      },
      electionConfig: {
        totalExpected: 1,
        choices: ['A'],
        version: '2026-demo',
        botCount: 0,
        merkleTreeDepth: 1,
      },
      inputS3Key: undefined,
      outputS3Prefix: undefined,
      bundleS3Key: undefined,
    });

    await expect(handler({ Records: [{ body: JSON.stringify(message) }] })).rejects.toThrow(
      'Target prover work message requires inputS3Key, outputS3Prefix, and bundleS3Key',
    );

    expectNoDispatchSideEffects();
    expectDispatchDropped(message, 'malformed');
  });

  it.each([
    [
      'wrong session',
      {
        inputS3Key: 'sessions/550e8400-e29b-41d4-a716-446655440999/01HZ3JQ4ABXYZ7890DEF123456/input.json',
      },
    ],
    [
      'wrong execution',
      {
        bundleS3Key: 'sessions/550e8400-e29b-41d4-a716-446655440000/01HZ3JQ4ABXYZ7890DEF123457/bundle.zip',
      },
    ],
    [
      'wrong prefix',
      {
        outputS3Prefix: 'archive/550e8400-e29b-41d4-a716-446655440000/01HZ3JQ4ABXYZ7890DEF123456',
      },
    ],
  ])('fails closed when target prover messages use a %s artifact key', async (_label, overrides) => {
    const message = buildMessage(overrides);
    await expect(handler({ Records: [{ body: JSON.stringify(message) }] })).rejects.toThrow(
      'Async prover artifact keys must match the canonical session/execution S3 layout',
    );

    expectNoDispatchSideEffects();
    expectDispatchDropped(message, 'malformed');
  });

  it('rejects missing state-machine configuration before reading records', async () => {
    delete process.env['PROVER_STATE_MACHINE_ARN'];

    await expect(handler({ Records: [{ body: JSON.stringify(buildMessage()) }] })).rejects.toThrow(
      'Runtime configuration validation failed',
    );

    expectNoDispatchSideEffects();
    expect(errorSpy).toHaveBeenCalledWith('Runtime configuration is invalid', {
      event: 'config_invalid',
      invalid_names: ['PROVER_STATE_MACHINE_ARN'],
    });
  });

  it('does not mark finalization running when Step Functions start fails', async () => {
    const message = buildMessage();
    getSessionMock.mockResolvedValueOnce(
      buildSessionWithFinalizationState({
        status: 'pending',
        executionId: message.executionId,
        queuedAt: message.queuedAt,
      }),
    );
    sfnSendMock.mockRejectedValueOnce(new Error('start failed'));

    await expect(handler({ Records: [{ body: JSON.stringify(message) }] })).rejects.toThrow('start failed');

    expect(sfnSendMock).toHaveBeenCalledTimes(1);
    expect(markAwsFinalizationRunningMock).not.toHaveBeenCalled();
    expect(emitCanonicalEventMock).toHaveBeenCalledWith({
      event: 'finalize_transition_attempted',
      to: 'running',
      source: 'proof_dispatcher',
      reason: 'DISPATCH_REQUESTED',
      session_id_hash: hashSessionIdForLogging(message.sessionId),
      execution_id: message.executionId,
    });
  });
});
