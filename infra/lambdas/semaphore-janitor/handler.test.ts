/**
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';
import { RuntimeConfigValidationError } from '@stark-ballot/runtime-config/env/configValidationError';

const ddbSendMock = vi.hoisted(() => vi.fn());
const sfnSendMock = vi.hoisted(() => vi.fn());
const logsSendMock = vi.hoisted(() => vi.fn());

vi.mock('@aws-sdk/client-cloudwatch-logs', () => {
  class MockCloudWatchLogsClient {
    send = logsSendMock;
  }

  class MockCreateLogStreamCommand {
    input: unknown;

    constructor(input: unknown) {
      this.input = input;
    }
  }

  class MockPutLogEventsCommand {
    input: unknown;

    constructor(input: unknown) {
      this.input = input;
    }
  }

  return {
    CloudWatchLogsClient: MockCloudWatchLogsClient,
    CreateLogStreamCommand: MockCreateLogStreamCommand,
    PutLogEventsCommand: MockPutLogEventsCommand,
  };
});

vi.mock('@aws-sdk/client-dynamodb', () => {
  class MockDynamoDBClient {
    send = ddbSendMock;
  }

  class MockUpdateItemCommand {
    input: unknown;

    constructor(input: unknown) {
      this.input = input;
    }
  }

  class MockGetItemCommand {
    input: unknown;

    constructor(input: unknown) {
      this.input = input;
    }
  }

  return {
    DynamoDBClient: MockDynamoDBClient,
    GetItemCommand: MockGetItemCommand,
    UpdateItemCommand: MockUpdateItemCommand,
  };
});

vi.mock('@aws-sdk/client-sfn', () => {
  class MockSFNClient {
    send = sfnSendMock;
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

const resolverModule = await import('@stark-ballot/aws-adapters/config/awsRuntimeConfigReferenceResolver');
const observabilityModule = await import('@stark-ballot/runtime-config/env/observability');
const { logger } = await import('@stark-ballot/diagnostics/logger');
const { handler } = await import('./handler');

const TABLE_NAME = 'stark-dev-develop-prover-semaphore';
const LOCK_NAME = 'prover-fargate';
const STATE_MACHINE_ARN =
  'arn:aws:states:ap-northeast-1:123456789012:stateMachine:stark-ballot-simulator-stark-dev-develop-finalization';
const RESOURCE_PREFIX = 'stark-ballot-simulator-stark-dev-develop';
const OPS_LEDGER_LOG_GROUP_NAME = `/aws/events/${RESOURCE_PREFIX}-ops-ledger`;
const PIPELINE_NAMES = [
  'stark-ballot-simulator-pipeline-stark-dev-develop',
  'stark-ballot-simulator-pipeline-stark-dev-develop-foundation',
  'stark-ballot-simulator-pipeline-stark-dev-develop-app',
  'stark-ballot-simulator-pipeline-stark-dev-develop-app-static-fast',
  'stark-ballot-simulator-pipeline-stark-dev-develop-toolchain-release',
  'stark-ballot-simulator-pipeline-stark-dev-develop-prover-release',
] as const;
const DEPLOYMENT_ID = `dep_${'a'.repeat(32)}`;
const EXECUTION_ID = '01HZ3JQ4ABXYZ7890DEF123456';
const EXECUTION_ARN = `${STATE_MACHINE_ARN.replace(':stateMachine:', ':execution:')}:${EXECUTION_ID}`;
const NOW = '2026-07-06T00:00:00.000Z';
const STALE_ACQUIRED_AT = '2026-07-05T23:40:00.000Z';
const FRESH_ACQUIRED_AT = '2026-07-05T23:59:30.000Z';

interface CommandLike {
  input: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isCommandLike(value: unknown): value is CommandLike {
  return isRecord(value) && isRecord(value['input']);
}

function commandInputAt(index: number): Record<string, unknown> {
  const command: unknown = ddbSendMock.mock.calls[index]?.[0];
  if (!isCommandLike(command)) {
    throw new Error(`Expected DynamoDB command at call ${index}`);
  }
  return command.input;
}

function sfnCommandInputAt(index: number): Record<string, unknown> {
  const command: unknown = sfnSendMock.mock.calls[index]?.[0];
  if (!isCommandLike(command)) {
    throw new Error(`Expected Step Functions command at call ${index}`);
  }
  return command.input;
}

function logsCommandInputAt(index: number): Record<string, unknown> {
  const command: unknown = logsSendMock.mock.calls[index]?.[0];
  if (!isCommandLike(command)) {
    throw new Error(`Expected CloudWatch Logs command at call ${index}`);
  }
  return command.input;
}

function buildExecutionStatusEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: '0',
    id: 'janitor-event-1',
    'detail-type': 'Step Functions Execution Status Change',
    source: 'aws.states',
    account: '123456789012',
    time: NOW,
    region: 'ap-northeast-1',
    resources: [EXECUTION_ARN],
    detail: {
      status: 'SUCCEEDED',
      stateMachineArn: STATE_MACHINE_ARN,
      executionArn: EXECUTION_ARN,
    },
    ...overrides,
  };
}

function buildScheduledEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: '0',
    id: 'janitor-sweep-1',
    'detail-type': 'Scheduled Event',
    source: 'aws.events',
    account: '123456789012',
    time: NOW,
    region: 'ap-northeast-1',
    resources: [],
    detail: {},
    ...overrides,
  };
}

function buildOpsLedgerEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const event: Record<string, unknown> = {
    ts: NOW,
    event_type: 'deployment_accepted',
    env: 'develop',
    deployment_id: DEPLOYMENT_ID,
    resource_name: 'app',
    state: 'ACCEPTED',
    ...overrides,
  };
  for (const key of Object.keys(event)) {
    if (event[key] === undefined) {
      delete event[key];
    }
  }
  return event;
}

function conditionalCheckFailed(): Error & { name: string } {
  return Object.assign(new Error('ConditionalCheckFailedException'), {
    name: 'ConditionalCheckFailedException',
  });
}

function expectReleaseCommand(input: Record<string, unknown>, ownerName: string): void {
  expect(input['TableName']).toBe(TABLE_NAME);
  expect(input['Key']).toEqual({
    LockName: { S: LOCK_NAME },
  });
  expect(input['ExpressionAttributeNames']).toEqual(
    expect.objectContaining({
      '#owner': ownerName,
    }),
  );
  expect(String(input['UpdateExpression'])).toContain('REMOVE #owner');
  expect(String(input['UpdateExpression'])).toContain('currentLockCount');
  expect(String(input['ConditionExpression'])).toContain('attribute_exists(#owner)');
  expect(String(input['ConditionExpression'])).toContain('currentLockCount >= :one');
  expect(input['ExpressionAttributeValues']).toEqual(
    expect.objectContaining({
      ':one': { N: '1' },
    }),
  );
}

describe('target semaphore janitor handler', () => {
  const originalEnv = { ...process.env };
  let infoSpy: MockInstance<typeof logger.info>;
  let warnSpy: MockInstance<typeof logger.warn>;
  let errorSpy: MockInstance<typeof logger.error>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
    infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => {});
    warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});
    process.env['TARGET_AWS_RUNTIME'] = '1';
    process.env['PROVER_SEMAPHORE_TABLE_NAME'] = TABLE_NAME;
    process.env['PROVER_SEMAPHORE_LOCK_NAME'] = LOCK_NAME;
    process.env['PROVER_SEMAPHORE_STALE_SECONDS'] = '300';
    process.env['PROVER_STATE_MACHINE_ARN'] = STATE_MACHINE_ARN;
    process.env['OPS_LEDGER_LOG_GROUP_NAME'] = OPS_LEDGER_LOG_GROUP_NAME;
    process.env['OPS_LEDGER_PIPELINE_BASE_NAME'] = PIPELINE_NAMES[0];
    process.env['OPS_LEDGER_RESOURCE_PREFIX'] = RESOURCE_PREFIX;
    process.env['RUNTIME_DEPLOYMENT_ENV'] = 'develop';
    ddbSendMock.mockResolvedValue({});
    sfnSendMock.mockResolvedValue({ status: 'SUCCEEDED' });
    logsSendMock.mockResolvedValue({});
  });

  afterEach(() => {
    vi.useRealTimers();
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

  it.each(['SUCCEEDED', 'FAILED', 'TIMED_OUT', 'ABORTED'])(
    'releases the semaphore owner for terminal Step Functions status %s',
    async (status) => {
      await expect(
        handler(
          buildExecutionStatusEvent({
            detail: {
              status,
              stateMachineArn: STATE_MACHINE_ARN,
              executionArn: EXECUTION_ARN,
            },
          }),
        ),
      ).resolves.toEqual({ released: 1 });

      expect(ddbSendMock).toHaveBeenCalledTimes(1);
      expectReleaseCommand(commandInputAt(0), EXECUTION_ID);
    },
  );

  it('treats ConditionalCheckFailedException during event release as already released', async () => {
    ddbSendMock.mockRejectedValueOnce(conditionalCheckFailed());

    await expect(handler(buildExecutionStatusEvent())).resolves.toEqual({ released: 0 });

    expect(ddbSendMock).toHaveBeenCalledTimes(1);
    expect(infoSpy).toHaveBeenCalledWith(
      '[SemaphoreJanitor] Semaphore owner already released',
      expect.objectContaining({
        executionId: EXECUTION_ID,
      }),
    );
  });

  it('does not touch DynamoDB for non-terminal Step Functions statuses', async () => {
    await expect(
      handler(
        buildExecutionStatusEvent({
          detail: {
            status: 'RUNNING',
            stateMachineArn: STATE_MACHINE_ARN,
            executionArn: EXECUTION_ARN,
          },
        }),
      ),
    ).resolves.toEqual({ released: 0 });

    expect(ddbSendMock).not.toHaveBeenCalled();
  });

  it('skips terminal events for a different state machine ARN', async () => {
    await expect(
      handler(
        buildExecutionStatusEvent({
          detail: {
            status: 'FAILED',
            stateMachineArn: `${STATE_MACHINE_ARN}-other`,
            executionArn: EXECUTION_ARN,
          },
        }),
      ),
    ).resolves.toEqual({ released: 0 });

    expect(ddbSendMock).not.toHaveBeenCalled();
    expect(infoSpy).toHaveBeenCalledWith(
      '[SemaphoreJanitor] Ignoring Step Functions event for a different state machine',
      expect.objectContaining({
        expectedStateMachineArn: STATE_MACHINE_ARN,
      }),
    );
  });

  it('scheduled sweep releases only stale owners with a value-pinned condition', async () => {
    ddbSendMock.mockResolvedValueOnce({
      Item: {
        LockName: { S: LOCK_NAME },
        currentLockCount: { N: '2' },
        limit: { N: '2' },
        [EXECUTION_ID]: { S: STALE_ACQUIRED_AT },
        '01HZ3JQ4ABXYZ7890DEF999999': { S: FRESH_ACQUIRED_AT },
      },
    });

    await expect(handler(buildScheduledEvent())).resolves.toEqual({ released: 1 });

    expect(ddbSendMock).toHaveBeenCalledTimes(2);
    const getInput = commandInputAt(0);
    expect(getInput).toEqual(
      expect.objectContaining({
        TableName: TABLE_NAME,
        Key: {
          LockName: { S: LOCK_NAME },
        },
        ConsistentRead: true,
      }),
    );

    const updateInput = commandInputAt(1);
    expectReleaseCommand(updateInput, EXECUTION_ID);
    expect(String(updateInput['ConditionExpression'])).toContain('#owner = :observedAcquiredAt');
    expect(updateInput['ExpressionAttributeValues']).toEqual(
      expect.objectContaining({
        ':observedAcquiredAt': { S: STALE_ACQUIRED_AT },
      }),
    );
  });

  it('scheduled sweep does not release a stale owner while its execution is still running', async () => {
    ddbSendMock.mockResolvedValueOnce({
      Item: {
        LockName: { S: LOCK_NAME },
        currentLockCount: { N: '1' },
        limit: { N: '2' },
        [EXECUTION_ID]: { S: STALE_ACQUIRED_AT },
      },
    });
    sfnSendMock.mockResolvedValueOnce({ status: 'RUNNING' });

    await expect(handler(buildScheduledEvent())).resolves.toEqual({ released: 0 });

    expect(ddbSendMock).toHaveBeenCalledTimes(1);
    expect(sfnSendMock).toHaveBeenCalledTimes(1);
    expect(sfnCommandInputAt(0)).toEqual({
      executionArn: EXECUTION_ARN,
    });
  });

  it('scheduled sweep keeps a stale owner while its execution is pending redrive', async () => {
    ddbSendMock.mockResolvedValueOnce({
      Item: {
        LockName: { S: LOCK_NAME },
        currentLockCount: { N: '1' },
        limit: { N: '2' },
        [EXECUTION_ID]: { S: STALE_ACQUIRED_AT },
      },
    });
    sfnSendMock.mockResolvedValueOnce({ status: 'PENDING_REDRIVE' });

    await expect(handler(buildScheduledEvent())).resolves.toEqual({ released: 0 });

    expect(ddbSendMock).toHaveBeenCalledTimes(1);
    expect(sfnSendMock).toHaveBeenCalledTimes(1);
    expect(sfnCommandInputAt(0)).toEqual({
      executionArn: EXECUTION_ARN,
    });
  });

  it('scheduled sweep releases a stale owner once its execution is closed', async () => {
    ddbSendMock.mockResolvedValueOnce({
      Item: {
        LockName: { S: LOCK_NAME },
        currentLockCount: { N: '1' },
        limit: { N: '2' },
        [EXECUTION_ID]: { S: STALE_ACQUIRED_AT },
      },
    });
    sfnSendMock.mockResolvedValueOnce({ status: 'FAILED' });

    await expect(handler(buildScheduledEvent())).resolves.toEqual({ released: 1 });

    expect(sfnSendMock).toHaveBeenCalledTimes(1);
    expect(ddbSendMock).toHaveBeenCalledTimes(2);
    expectReleaseCommand(commandInputAt(1), EXECUTION_ID);
  });

  it('scheduled sweep treats a missing execution as releasable stale owner evidence', async () => {
    const notFound = Object.assign(new Error('execution not found'), {
      name: 'ExecutionDoesNotExist',
    });
    ddbSendMock.mockResolvedValueOnce({
      Item: {
        LockName: { S: LOCK_NAME },
        currentLockCount: { N: '1' },
        limit: { N: '2' },
        [EXECUTION_ID]: { S: STALE_ACQUIRED_AT },
      },
    });
    sfnSendMock.mockRejectedValueOnce(notFound);

    await expect(handler(buildScheduledEvent())).resolves.toEqual({ released: 1 });

    expect(sfnSendMock).toHaveBeenCalledTimes(1);
    expect(ddbSendMock).toHaveBeenCalledTimes(2);
    expectReleaseCommand(commandInputAt(1), EXECUTION_ID);
  });

  it('rethrows DescribeExecution failures during sweep before releasing the owner', async () => {
    ddbSendMock.mockResolvedValueOnce({
      Item: {
        LockName: { S: LOCK_NAME },
        currentLockCount: { N: '1' },
        limit: { N: '2' },
        [EXECUTION_ID]: { S: STALE_ACQUIRED_AT },
      },
    });
    sfnSendMock.mockRejectedValueOnce(new Error('Step Functions unavailable'));

    await expect(handler(buildScheduledEvent())).rejects.toThrow('Step Functions unavailable');

    expect(sfnSendMock).toHaveBeenCalledTimes(1);
    expect(ddbSendMock).toHaveBeenCalledTimes(1);
  });

  it('scheduled sweep skips reserved semaphore attributes and malformed owner timestamps', async () => {
    ddbSendMock.mockResolvedValueOnce({
      Item: {
        LockName: { S: LOCK_NAME },
        currentLockCount: { N: '1' },
        limit: { N: '2' },
        '01HZ3JQ4ABXYZ7890DEFBADTS': { S: 'not-an-iso-date' },
      },
    });

    await expect(handler(buildScheduledEvent())).resolves.toEqual({ released: 0 });

    expect(ddbSendMock).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      '[SemaphoreJanitor] Skipping semaphore owner with invalid acquiredAt timestamp',
      expect.objectContaining({
        executionId: '01HZ3JQ4ABXYZ7890DEFBADTS',
      }),
    );
  });

  it('scheduled sweep logs and skips unsafe owner attribute names without aborting the sweep', async () => {
    ddbSendMock.mockResolvedValueOnce({
      Item: {
        LockName: { S: LOCK_NAME },
        currentLockCount: { N: '1' },
        limit: { N: '2' },
        '../unsafe-owner': { S: STALE_ACQUIRED_AT },
      },
    });

    await expect(handler(buildScheduledEvent())).resolves.toEqual({ released: 0 });

    expect(ddbSendMock).toHaveBeenCalledTimes(1);
    expect(sfnSendMock).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      '[SemaphoreJanitor] Skipping semaphore owner with unsafe execution name',
      expect.objectContaining({
        executionId: '../unsafe-owner',
      }),
    );
  });

  it('rejects unsafe execution names before issuing an UpdateItem', async () => {
    const unsafeExecutionArn = `${STATE_MACHINE_ARN.replace(':stateMachine:', ':execution:')}:../unsafe`;

    await expect(
      handler(
        buildExecutionStatusEvent({
          resources: [unsafeExecutionArn],
          detail: {
            status: 'SUCCEEDED',
            stateMachineArn: STATE_MACHINE_ARN,
            executionArn: unsafeExecutionArn,
          },
        }),
      ),
    ).rejects.toThrow('executionId must be a safe single path segment');

    expect(ddbSendMock).not.toHaveBeenCalled();
  });

  it('fails closed outside TARGET_AWS_RUNTIME before any DynamoDB side effect', async () => {
    process.env['TARGET_AWS_RUNTIME'] = '0';

    await expect(handler(buildExecutionStatusEvent())).rejects.toThrow('Runtime configuration validation failed');

    expect(ddbSendMock).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith('Runtime configuration is invalid', {
      event: 'config_invalid',
      invalid_names: ['TARGET_AWS_RUNTIME'],
    });
  });

  it.each([
    'PROVER_SEMAPHORE_TABLE_NAME',
    'PROVER_SEMAPHORE_LOCK_NAME',
    'PROVER_SEMAPHORE_STALE_SECONDS',
    'PROVER_STATE_MACHINE_ARN',
  ])('reports the exact missing component variable %s', async (name) => {
    delete process.env[name];

    await expect(handler(buildScheduledEvent())).rejects.toThrow();

    expect(errorSpy).toHaveBeenCalledWith('Runtime configuration is invalid', {
      event: 'config_invalid',
      invalid_names: [name],
    });
    expect(ddbSendMock).not.toHaveBeenCalled();
  });

  it('fails before DynamoDB when the target observability contract is invalid', async () => {
    const observabilityError = new RuntimeConfigValidationError(
      ['DEPLOYMENT_ID'],
      undefined,
      'invalid target observability contract',
    );
    vi.mocked(observabilityModule.validateTargetObservabilityEnv).mockImplementationOnce(() => {
      throw observabilityError;
    });

    await expect(handler(buildExecutionStatusEvent())).rejects.toMatchObject({
      name: 'RuntimeConfigValidationError',
      message: 'Runtime configuration validation failed',
      invalidNames: ['DEPLOYMENT_ID'],
    });

    const resolverCall = vi.mocked(resolverModule.ensureAwsRuntimeConfigReferencesLoaded).mock.calls.at(-1);
    expect(resolverCall?.[0]).toBe('semaphore_janitor');
    expect(typeof resolverCall?.[1]?.invalidNameCollector?.add).toBe('function');
    expect(ddbSendMock).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith('Runtime configuration is invalid', {
      event: 'config_invalid',
      invalid_names: ['DEPLOYMENT_ID'],
    });
  });

  it('rejects unknown EventBridge shapes without logging attacker-controlled values', async () => {
    const privateUri = 's3://private-bucket/sessions/raw-session/input.json';
    await expect(
      handler({
        source: 'stark-ballot.local',
        detail: {
          status: privateUri,
        },
      }),
    ).rejects.toThrow('Invalid EventBridge invocation');

    expect(ddbSendMock).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith('Invocation payload is invalid', {
      event: 'invocation_invalid',
      source_kind: 'eventbridge',
      reason: 'event_shape_invalid',
    });
    expect(JSON.stringify(warnSpy.mock.calls)).not.toContain(privateUri);
  });

  it('rejects terminal Step Functions events without an execution ARN', async () => {
    await expect(
      handler(
        buildExecutionStatusEvent({
          resources: [],
          detail: {
            status: 'FAILED',
            stateMachineArn: STATE_MACHINE_ARN,
          },
        }),
      ),
    ).rejects.toThrow('Invalid EventBridge invocation');

    expect(ddbSendMock).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith('Invocation payload is invalid', {
      event: 'invocation_invalid',
      source_kind: 'eventbridge',
      reason: 'event_shape_invalid',
    });
  });

  it('emits names only when the log-salt reference cannot be resolved', async () => {
    const secretValue = 'never-log-this-resolved-secret';
    const resolutionError = new Error(`resolution failed: ${secretValue}`);
    vi.mocked(resolverModule.ensureAwsRuntimeConfigReferencesLoaded).mockImplementationOnce(
      async (_entrypoint, options) => {
        if (!options) throw new Error('Expected runtime-reference resolver options');
        options.invalidNameCollector?.add('LOG_IP_HASH_SALT_REF');
        await Promise.reject(resolutionError);
      },
    );

    await expect(handler(buildScheduledEvent())).rejects.toMatchObject({
      name: 'RuntimeConfigValidationError',
      message: 'Runtime configuration validation failed',
      invalidNames: ['LOG_IP_HASH_SALT_REF'],
    });

    expect(errorSpy).toHaveBeenCalledWith('Runtime configuration is invalid', {
      event: 'config_invalid',
      invalid_names: ['LOG_IP_HASH_SALT_REF'],
    });
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain(secretValue);
    expect(observabilityModule.validateTargetObservabilityEnv).not.toHaveBeenCalled();
    expect(ddbSendMock).not.toHaveBeenCalled();
  });

  it.each([
    {
      event: buildOpsLedgerEvent({
        ts: '2026-07-06T00:00:00Z',
        event_type: 'alarm_state_changed',
        deployment_id: undefined,
        resource_name: `${RESOURCE_PREFIX}-public-api-errors`,
        state: 'ALARM',
      }),
      expectedEventType: 'alarm_state_changed',
    },
    {
      event: buildOpsLedgerEvent({
        event_type: 'ecs_task_stopped',
        resource_name: 'prover-task',
        state: 'STOPPED',
      }),
      expectedEventType: 'ecs_task_stopped',
    },
    {
      event: buildOpsLedgerEvent({
        event_type: 'pipeline_execution_changed',
        deployment_id: undefined,
        resource_name: PIPELINE_NAMES[2],
        state: 'SUCCEEDED',
      }),
      expectedEventType: 'pipeline_execution_changed',
    },
    {
      event: buildOpsLedgerEvent(),
      expectedEventType: 'deployment_accepted',
    },
  ])('writes one exact common-schema $expectedEventType record', async ({ event, expectedEventType }) => {
    await expect(handler(event)).resolves.toEqual({ recorded: true });

    expect(ddbSendMock).not.toHaveBeenCalled();
    expect(logsSendMock).toHaveBeenCalledTimes(2);
    expect(logsCommandInputAt(0)).toEqual({
      logGroupName: OPS_LEDGER_LOG_GROUP_NAME,
      logStreamName: 'normalized-events',
    });
    const putInput = logsCommandInputAt(1);
    expect(putInput['logGroupName']).toBe(OPS_LEDGER_LOG_GROUP_NAME);
    expect(putInput['logStreamName']).toBe('normalized-events');
    const logEvents = putInput['logEvents'];
    expect(Array.isArray(logEvents)).toBe(true);
    const logEvent = (logEvents as Array<Record<string, unknown>>)[0];
    expect(logEvent?.['timestamp']).toBe(Date.parse(NOW));
    expect(typeof logEvent?.['message']).toBe('string');
    const stored = JSON.parse(String(logEvent?.['message'])) as Record<string, unknown>;
    expect(stored['event_type']).toBe(expectedEventType);
    expect(stored['ts']).toBe(NOW);
    expect(Object.keys(stored).sort()).toEqual(Object.keys(event).sort());
    expect(JSON.stringify(stored)).not.toMatch(/(?:arn:aws|image_uri|stoppedReason|reason|detail|resources)/i);
  });

  it('treats an existing normalized ledger stream as ready without weakening delivery', async () => {
    logsSendMock
      .mockRejectedValueOnce(Object.assign(new Error('exists'), { name: 'ResourceAlreadyExistsException' }))
      .mockResolvedValueOnce({});

    await expect(handler(buildOpsLedgerEvent())).resolves.toEqual({ recorded: true });

    expect(logsSendMock).toHaveBeenCalledTimes(2);
  });

  it.each([
    buildOpsLedgerEvent({ raw_event: { detail: 'must-not-pass' } }),
    buildOpsLedgerEvent({ event_type: 'ecs_task_stopped', resource_name: 'prover-task', state: 'FAILED' }),
    buildOpsLedgerEvent({
      event_type: 'pipeline_execution_changed',
      deployment_id: undefined,
      resource_name: 'unrelated-pipeline',
    }),
    buildOpsLedgerEvent({
      event_type: 'pipeline_execution_changed',
      deployment_id: undefined,
      resource_name: 'stark-ballot-simulator-pipeline-stark-dev-develop-release-candidate',
      state: 'SUCCEEDED',
    }),
    buildOpsLedgerEvent({
      event_type: 'alarm_state_changed',
      deployment_id: undefined,
      resource_name: 'other-alarm',
    }),
    buildOpsLedgerEvent({ deployment_id: 'dep_not-valid' }),
    buildOpsLedgerEvent({ env: 'main' }),
    buildOpsLedgerEvent({ ts: 'not-a-timestamp' }),
    buildOpsLedgerEvent({ ts: '2026-07-06T00:00:00.00Z' }),
    buildOpsLedgerEvent({ ts: '2026-07-04T21:59:59.999Z' }),
    buildOpsLedgerEvent({ ts: '2026-07-06T00:05:00.001Z' }),
  ])('rejects an invalid or non-allowlisted normalized ledger record', async (event) => {
    await expect(handler(event)).rejects.toThrow('Invalid ops ledger invocation');

    expect(logsSendMock).not.toHaveBeenCalled();
    expect(ddbSendMock).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith('Invocation payload is invalid', {
      event: 'invocation_invalid',
      source_kind: 'ops_ledger',
      reason: 'event_shape_invalid',
    });
  });

  it.each(['OPS_LEDGER_LOG_GROUP_NAME', 'OPS_LEDGER_PIPELINE_BASE_NAME', 'OPS_LEDGER_RESOURCE_PREFIX'])(
    'fails closed when %s is missing',
    async (name) => {
      delete process.env[name];

      await expect(handler(buildOpsLedgerEvent())).rejects.toEqual(
        expect.objectContaining({
          name: 'RuntimeConfigValidationError',
          invalidNames: [name],
        }),
      );

      expect(logsSendMock).not.toHaveBeenCalled();
    },
  );

  it('fails the invocation when CloudWatch Logs rejects the normalized log event', async () => {
    logsSendMock.mockResolvedValueOnce({}).mockResolvedValueOnce({
      rejectedLogEventsInfo: {
        tooNewLogEventStartIndex: 0,
      },
    });

    await expect(handler(buildOpsLedgerEvent())).rejects.toThrow(
      'CloudWatch Logs rejected normalized ops ledger event',
    );

    expect(logsSendMock).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain(DEPLOYMENT_ID);
  });

  it('rethrows non-conditional DynamoDB errors so EventBridge retries preserve evidence', async () => {
    ddbSendMock.mockRejectedValueOnce(new Error('DynamoDB unavailable'));

    await expect(handler(buildExecutionStatusEvent())).rejects.toThrow('DynamoDB unavailable');
  });
});
