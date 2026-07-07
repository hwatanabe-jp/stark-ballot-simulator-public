import { DynamoDBClient, GetItemCommand, UpdateItemCommand, type AttributeValue } from '@aws-sdk/client-dynamodb';
import { DescribeExecutionCommand, SFNClient } from '@aws-sdk/client-sfn';
import { logger } from '@stark-ballot/diagnostics/logger';
import { assertSafeVerifierSegment } from '@stark-ballot/validation/safe-verifier-segment';

const ddbClient = new DynamoDBClient({});
const sfnClient = new SFNClient({});
const RESERVED_SEMAPHORE_ATTRIBUTES = new Set(['LockName', 'currentLockCount', 'limit']);
const TERMINAL_EXECUTION_STATUSES = new Set(['SUCCEEDED', 'FAILED', 'TIMED_OUT', 'ABORTED']);

export interface SemaphoreJanitorResult {
  released: number;
}

interface SemaphoreJanitorConfig {
  tableName: string;
  lockName: string;
  staleMillis: number;
  stateMachineArn: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function getStringProperty(value: Record<string, unknown>, key: string): string | undefined {
  const candidate = value[key];
  return typeof candidate === 'string' ? candidate : undefined;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required for semaphore janitor`);
  }
  return value;
}

function resolveConfig(): SemaphoreJanitorConfig {
  if (process.env['TARGET_AWS_RUNTIME'] !== '1') {
    throw new Error('TARGET_AWS_RUNTIME=1 is required for semaphore janitor');
  }

  const staleSeconds = Number(requireEnv('PROVER_SEMAPHORE_STALE_SECONDS'));
  if (!Number.isFinite(staleSeconds) || staleSeconds <= 0) {
    throw new Error('PROVER_SEMAPHORE_STALE_SECONDS must be a positive number');
  }

  return {
    tableName: requireEnv('PROVER_SEMAPHORE_TABLE_NAME'),
    lockName: requireEnv('PROVER_SEMAPHORE_LOCK_NAME'),
    staleMillis: Math.floor(staleSeconds * 1000),
    stateMachineArn: requireEnv('PROVER_STATE_MACHINE_ARN'),
  };
}

function isConditionalCheckFailed(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }
  const name = (error as { name?: unknown }).name;
  const message = error instanceof Error ? error.message : undefined;
  return name === 'ConditionalCheckFailedException' || message?.includes('ConditionalCheckFailedException') === true;
}

function isExecutionDoesNotExist(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }
  const name = (error as { name?: unknown }).name;
  const message = error instanceof Error ? error.message : undefined;
  return name === 'ExecutionDoesNotExist' || message?.includes('ExecutionDoesNotExist') === true;
}

function buildExecutionArn(stateMachineArn: string, executionName: string): string {
  return `${stateMachineArn.replace(':stateMachine:', ':execution:')}:${executionName}`;
}

function resolveExecutionName(executionArn: string): string {
  const segments = executionArn.split(':');
  const executionName = segments[segments.length - 1];
  assertSafeVerifierSegment(executionName ?? '', 'executionId');
  return executionName ?? '';
}

async function isExecutionReleasable(config: SemaphoreJanitorConfig, executionId: string): Promise<boolean> {
  const executionArn = buildExecutionArn(config.stateMachineArn, executionId);
  try {
    const response = await sfnClient.send(
      new DescribeExecutionCommand({
        executionArn,
      }),
    );
    return response.status !== 'RUNNING';
  } catch (error) {
    if (isExecutionDoesNotExist(error)) {
      return true;
    }
    throw error;
  }
}

async function releaseOwner(
  config: SemaphoreJanitorConfig,
  executionId: string,
  observedAcquiredAt?: string,
): Promise<number> {
  const expressionAttributeValues: Record<string, AttributeValue> = {
    ':one': { N: '1' },
    ...(observedAcquiredAt !== undefined ? { ':observedAcquiredAt': { S: observedAcquiredAt } } : {}),
  };
  const conditionExpression =
    observedAcquiredAt !== undefined
      ? 'attribute_exists(#owner) AND #owner = :observedAcquiredAt AND currentLockCount >= :one'
      : 'attribute_exists(#owner) AND currentLockCount >= :one';

  try {
    await ddbClient.send(
      new UpdateItemCommand({
        TableName: config.tableName,
        Key: {
          LockName: { S: config.lockName },
        },
        UpdateExpression: 'SET currentLockCount = currentLockCount - :one REMOVE #owner',
        ConditionExpression: conditionExpression,
        ExpressionAttributeNames: {
          '#owner': executionId,
        },
        ExpressionAttributeValues: expressionAttributeValues,
      }),
    );
    return 1;
  } catch (error) {
    if (isConditionalCheckFailed(error)) {
      logger.info('[SemaphoreJanitor] Semaphore owner already released', {
        executionId,
      });
      return 0;
    }
    throw error;
  }
}

async function handleExecutionStatusEvent(
  config: SemaphoreJanitorConfig,
  event: Record<string, unknown>,
): Promise<SemaphoreJanitorResult> {
  const detail = isRecord(event['detail']) ? event['detail'] : {};
  const status = getStringProperty(detail, 'status');
  if (!status || !TERMINAL_EXECUTION_STATUSES.has(status)) {
    return { released: 0 };
  }

  const stateMachineArn = getStringProperty(detail, 'stateMachineArn');
  if (stateMachineArn !== config.stateMachineArn) {
    logger.info('[SemaphoreJanitor] Ignoring Step Functions event for a different state machine', {
      expectedStateMachineArn: config.stateMachineArn,
      actualStateMachineArn: stateMachineArn,
    });
    return { released: 0 };
  }

  const resources = Array.isArray(event['resources']) ? event['resources'] : [];
  const resourceArn = resources.find((value): value is string => typeof value === 'string');
  const executionArn = getStringProperty(detail, 'executionArn') ?? resourceArn;
  if (!executionArn) {
    logger.info('[SemaphoreJanitor] Ignoring Step Functions event without an execution ARN', {
      stateMachineArn,
      status,
    });
    return { released: 0 };
  }

  return {
    released: await releaseOwner(config, resolveExecutionName(executionArn)),
  };
}

function parseOwnerAcquiredAt(executionId: string, value: AttributeValue): string | undefined {
  const acquiredAt = 'S' in value ? value.S : undefined;
  const parsedMillis = typeof acquiredAt === 'string' ? Date.parse(acquiredAt) : NaN;
  if (!Number.isFinite(parsedMillis)) {
    logger.warn('[SemaphoreJanitor] Skipping semaphore owner with invalid acquiredAt timestamp', {
      executionId,
    });
    return undefined;
  }
  return acquiredAt;
}

async function handleScheduledSweep(config: SemaphoreJanitorConfig): Promise<SemaphoreJanitorResult> {
  const response = await ddbClient.send(
    new GetItemCommand({
      TableName: config.tableName,
      Key: {
        LockName: { S: config.lockName },
      },
      ConsistentRead: true,
    }),
  );

  const item = response.Item ?? {};
  const now = Date.now();
  let released = 0;

  for (const [executionId, value] of Object.entries(item)) {
    if (RESERVED_SEMAPHORE_ATTRIBUTES.has(executionId)) {
      continue;
    }
    try {
      assertSafeVerifierSegment(executionId, 'executionId');
    } catch {
      logger.warn('[SemaphoreJanitor] Skipping semaphore owner with unsafe execution name', {
        executionId,
      });
      continue;
    }

    const acquiredAt = parseOwnerAcquiredAt(executionId, value);
    if (!acquiredAt) {
      continue;
    }
    if (now - Date.parse(acquiredAt) < config.staleMillis) {
      continue;
    }
    if (!(await isExecutionReleasable(config, executionId))) {
      logger.info('[SemaphoreJanitor] Keeping stale semaphore owner for running execution', {
        executionId,
      });
      continue;
    }

    released += await releaseOwner(config, executionId, acquiredAt);
  }

  return { released };
}

export const handler = async (event: unknown): Promise<SemaphoreJanitorResult> => {
  const config = resolveConfig();
  if (!isRecord(event)) {
    logger.info('[SemaphoreJanitor] Ignoring unsupported semaphore janitor event', {});
    return { released: 0 };
  }

  const source = getStringProperty(event, 'source');
  const detailType = getStringProperty(event, 'detail-type');
  if (source === 'aws.states') {
    return handleExecutionStatusEvent(config, event);
  }
  if (source === 'aws.events' && detailType === 'Scheduled Event') {
    return handleScheduledSweep(config);
  }

  logger.info('[SemaphoreJanitor] Ignoring unsupported semaphore janitor event', {
    source,
    detailType,
  });
  return { released: 0 };
};
