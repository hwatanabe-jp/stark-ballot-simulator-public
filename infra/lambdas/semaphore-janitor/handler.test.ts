/**
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';

const ddbSendMock = vi.hoisted(() => vi.fn());
const sfnSendMock = vi.hoisted(() => vi.fn());

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

const { logger } = await import('@stark-ballot/diagnostics/logger');
const { handler } = await import('./handler');

const TABLE_NAME = 'stark-dev-develop-prover-semaphore';
const LOCK_NAME = 'prover-fargate';
const STATE_MACHINE_ARN =
  'arn:aws:states:ap-northeast-1:123456789012:stateMachine:stark-ballot-simulator-stark-dev-develop-finalization';
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

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
    infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => {});
    warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    process.env['TARGET_AWS_RUNTIME'] = '1';
    process.env['PROVER_SEMAPHORE_TABLE_NAME'] = TABLE_NAME;
    process.env['PROVER_SEMAPHORE_LOCK_NAME'] = LOCK_NAME;
    process.env['PROVER_SEMAPHORE_STALE_SECONDS'] = '300';
    process.env['PROVER_STATE_MACHINE_ARN'] = STATE_MACHINE_ARN;
    ddbSendMock.mockResolvedValue({});
    sfnSendMock.mockResolvedValue({ status: 'SUCCEEDED' });
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

    await expect(handler(buildExecutionStatusEvent())).rejects.toThrow(
      'TARGET_AWS_RUNTIME=1 is required for semaphore janitor',
    );

    expect(ddbSendMock).not.toHaveBeenCalled();
  });

  it('resolves unknown EventBridge shapes as no-op without DynamoDB side effects', async () => {
    await expect(
      handler({
        source: 'stark-ballot.local',
        detail: {
          status: 'SUCCEEDED',
        },
      }),
    ).resolves.toEqual({ released: 0 });

    expect(ddbSendMock).not.toHaveBeenCalled();
    expect(infoSpy).toHaveBeenCalledWith(
      '[SemaphoreJanitor] Ignoring unsupported semaphore janitor event',
      expect.objectContaining({
        source: 'stark-ballot.local',
      }),
    );
  });

  it('rethrows non-conditional DynamoDB errors so EventBridge retries preserve evidence', async () => {
    ddbSendMock.mockRejectedValueOnce(new Error('DynamoDB unavailable'));

    await expect(handler(buildExecutionStatusEvent())).rejects.toThrow('DynamoDB unavailable');
  });
});
