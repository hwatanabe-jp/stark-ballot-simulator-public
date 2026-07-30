import { DynamoDBClient, GetItemCommand, UpdateItemCommand, type AttributeValue } from '@aws-sdk/client-dynamodb';
import { CloudWatchLogsClient, CreateLogStreamCommand, PutLogEventsCommand } from '@aws-sdk/client-cloudwatch-logs';
import { DescribeExecutionCommand, SFNClient } from '@aws-sdk/client-sfn';
import { logger } from '@stark-ballot/diagnostics/logger';
import { assertSafeVerifierSegment } from '@stark-ballot/validation/safe-verifier-segment';
import { ensureAwsRuntimeConfigReferencesLoaded } from '@stark-ballot/aws-adapters/config/awsRuntimeConfigReferenceResolver';
import { validateTargetObservabilityEnv } from '@stark-ballot/runtime-config/env/observability';
import { RuntimeConfigValidationError, bootstrapLambdaRuntime, type RuntimeConfigName } from '../runtimeBootstrap.js';

const ddbClient = new DynamoDBClient({});
const sfnClient = new SFNClient({});
const logsClient = new CloudWatchLogsClient({});
const RESERVED_SEMAPHORE_ATTRIBUTES = new Set(['LockName', 'currentLockCount', 'limit']);
const TERMINAL_EXECUTION_STATUSES = new Set(['SUCCEEDED', 'FAILED', 'TIMED_OUT', 'ABORTED']);
const OPS_LEDGER_LOG_STREAM_NAME = 'normalized-events';
const OPS_LEDGER_EVENT_TYPES = new Set([
  'alarm_state_changed',
  'ecs_task_stopped',
  'pipeline_execution_changed',
  'deployment_accepted',
]);
const ALARM_STATES = new Set(['ALARM', 'OK', 'INSUFFICIENT_DATA']);
const PIPELINE_STATES = new Set([
  'STARTED',
  'SUCCEEDED',
  'RESUMED',
  'FAILED',
  'CANCELED',
  'SUPERSEDED',
  'STOPPING',
  'STOPPED',
]);
const MAX_OPS_LEDGER_EVENT_AGE_MILLIS = 25 * 60 * 60 * 1000;
const MAX_OPS_LEDGER_FUTURE_SKEW_MILLIS = 5 * 60 * 1000;
const CANONICAL_ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const DEPLOYMENT_ID_PATTERN = /^dep_[0-9a-f]{32}$/;
const SAFE_RESOURCE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;
const SAFE_RESOURCE_PREFIX_PATTERN = /^[a-z0-9][a-z0-9-]{2,127}$/;
const SAFE_PIPELINE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/;
const SAFE_OPS_LEDGER_LOG_GROUP_PATTERN = /^\/aws\/events\/[a-z0-9][a-z0-9-]{2,127}-ops-ledger$/;
const OPS_LEDGER_PIPELINE_SUFFIXES = [
  '',
  '-foundation',
  '-app',
  '-app-static-fast',
  '-toolchain-release',
  '-prover-release',
] as const;

export interface SemaphoreJanitorResult {
  released: number;
}

export interface OpsLedgerResult {
  recorded: true;
}

type OpsLedgerEventType =
  'alarm_state_changed' | 'ecs_task_stopped' | 'pipeline_execution_changed' | 'deployment_accepted';

interface NormalizedOpsLedgerEvent {
  ts: string;
  event_type: OpsLedgerEventType;
  env: string;
  deployment_id?: string;
  resource_name: string;
  state: string;
}

interface SemaphoreJanitorConfig {
  tableName: string;
  lockName: string;
  staleMillis: number;
  stateMachineArn: string;
  opsLedgerLogGroupName: string;
  opsLedgerResourcePrefix: string;
  opsLedgerPipelineNames: ReadonlySet<string>;
  deploymentEnvironment: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function getStringProperty(value: Record<string, unknown>, key: string): string | undefined {
  const candidate = value[key];
  return typeof candidate === 'string' ? candidate : undefined;
}

function logInvalidEventBridgeInvocation(): void {
  logger.warn('Invocation payload is invalid', {
    event: 'invocation_invalid',
    source_kind: 'eventbridge',
    reason: 'event_shape_invalid',
  });
}

function throwInvalidEventBridgeInvocation(): never {
  logInvalidEventBridgeInvocation();
  throw new Error('Invalid EventBridge invocation');
}

function throwInvalidOpsLedgerInvocation(): never {
  logger.warn('Invocation payload is invalid', {
    event: 'invocation_invalid',
    source_kind: 'ops_ledger',
    reason: 'event_shape_invalid',
  });
  throw new Error('Invalid ops ledger invocation');
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required for semaphore janitor`);
  }
  return value;
}

function resolveConfig(): SemaphoreJanitorConfig {
  const invalidNames: RuntimeConfigName[] = [];
  if (process.env['TARGET_AWS_RUNTIME'] !== '1') {
    invalidNames.push('TARGET_AWS_RUNTIME');
  }
  for (const name of [
    'PROVER_SEMAPHORE_TABLE_NAME',
    'PROVER_SEMAPHORE_LOCK_NAME',
    'PROVER_SEMAPHORE_STALE_SECONDS',
    'PROVER_STATE_MACHINE_ARN',
    'OPS_LEDGER_LOG_GROUP_NAME',
    'OPS_LEDGER_PIPELINE_BASE_NAME',
    'OPS_LEDGER_RESOURCE_PREFIX',
    'RUNTIME_DEPLOYMENT_ENV',
  ] as const satisfies readonly RuntimeConfigName[]) {
    if (!process.env[name]?.trim()) {
      invalidNames.push(name);
    }
  }

  const staleSeconds = Number(process.env['PROVER_SEMAPHORE_STALE_SECONDS']);
  if (!Number.isFinite(staleSeconds) || staleSeconds <= 0) {
    if (!invalidNames.includes('PROVER_SEMAPHORE_STALE_SECONDS')) {
      invalidNames.push('PROVER_SEMAPHORE_STALE_SECONDS');
    }
  }

  const opsLedgerResourcePrefix = process.env['OPS_LEDGER_RESOURCE_PREFIX']?.trim() ?? '';
  if (!SAFE_RESOURCE_PREFIX_PATTERN.test(opsLedgerResourcePrefix)) {
    if (!invalidNames.includes('OPS_LEDGER_RESOURCE_PREFIX')) {
      invalidNames.push('OPS_LEDGER_RESOURCE_PREFIX');
    }
  }
  const opsLedgerLogGroupName = process.env['OPS_LEDGER_LOG_GROUP_NAME']?.trim() ?? '';
  if (
    !SAFE_OPS_LEDGER_LOG_GROUP_PATTERN.test(opsLedgerLogGroupName) ||
    (SAFE_RESOURCE_PREFIX_PATTERN.test(opsLedgerResourcePrefix) &&
      opsLedgerLogGroupName !== `/aws/events/${opsLedgerResourcePrefix}-ops-ledger`)
  ) {
    if (!invalidNames.includes('OPS_LEDGER_LOG_GROUP_NAME')) {
      invalidNames.push('OPS_LEDGER_LOG_GROUP_NAME');
    }
  }
  const deploymentEnvironment = process.env['RUNTIME_DEPLOYMENT_ENV']?.trim() ?? '';
  const accountAlias =
    deploymentEnvironment === 'develop' ? 'stark-dev' : deploymentEnvironment === 'main' ? 'stark-prod' : '';
  const basePipelineName = process.env['OPS_LEDGER_PIPELINE_BASE_NAME']?.trim() ?? '';
  const pipelineIdentitySuffix = accountAlias ? `-pipeline-${accountAlias}-${deploymentEnvironment}` : '';
  const expectedPipelineNames = OPS_LEDGER_PIPELINE_SUFFIXES.map((suffix) => `${basePipelineName}${suffix}`);
  if (
    !SAFE_PIPELINE_NAME_PATTERN.test(basePipelineName) ||
    !pipelineIdentitySuffix ||
    !basePipelineName.endsWith(pipelineIdentitySuffix) ||
    basePipelineName.length <= pipelineIdentitySuffix.length ||
    expectedPipelineNames.some((name) => !SAFE_PIPELINE_NAME_PATTERN.test(name))
  ) {
    if (!invalidNames.includes('OPS_LEDGER_PIPELINE_BASE_NAME')) {
      invalidNames.push('OPS_LEDGER_PIPELINE_BASE_NAME');
    }
  }
  if (invalidNames.length > 0) {
    const message = invalidNames.includes('TARGET_AWS_RUNTIME')
      ? 'TARGET_AWS_RUNTIME=1 is required for semaphore janitor'
      : invalidNames[0] === 'PROVER_SEMAPHORE_STALE_SECONDS'
        ? 'PROVER_SEMAPHORE_STALE_SECONDS must be a positive number'
        : `${invalidNames[0]} is required for semaphore janitor`;
    throw new RuntimeConfigValidationError(invalidNames, undefined, message);
  }

  return {
    tableName: requireEnv('PROVER_SEMAPHORE_TABLE_NAME'),
    lockName: requireEnv('PROVER_SEMAPHORE_LOCK_NAME'),
    staleMillis: Math.floor(staleSeconds * 1000),
    stateMachineArn: requireEnv('PROVER_STATE_MACHINE_ARN'),
    opsLedgerLogGroupName,
    opsLedgerResourcePrefix,
    opsLedgerPipelineNames: new Set(expectedPipelineNames),
    deploymentEnvironment,
  };
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function parseCanonicalOpsLedgerTimestamp(value: unknown): number | undefined {
  if (typeof value !== 'string' || !CANONICAL_ISO_TIMESTAMP_PATTERN.test(value)) {
    return undefined;
  }
  const millis = Date.parse(value);
  const canonical = Number.isFinite(millis) ? new Date(millis).toISOString() : '';
  const canonicalWithoutZeroMillis = canonical.endsWith('.000Z') ? canonical.replace('.000Z', 'Z') : canonical;
  if (!Number.isFinite(millis) || (value !== canonical && value !== canonicalWithoutZeroMillis)) {
    return undefined;
  }
  const now = Date.now();
  if (millis < now - MAX_OPS_LEDGER_EVENT_AGE_MILLIS || millis > now + MAX_OPS_LEDGER_FUTURE_SKEW_MILLIS) {
    return undefined;
  }
  return millis;
}

function parseOpsLedgerEvent(
  config: SemaphoreJanitorConfig,
  candidate: Record<string, unknown>,
): { event: NormalizedOpsLedgerEvent; timestamp: number } | undefined {
  const eventType = candidate['event_type'];
  if (typeof eventType !== 'string' || !OPS_LEDGER_EVENT_TYPES.has(eventType)) {
    return undefined;
  }
  const needsDeploymentId = eventType === 'ecs_task_stopped' || eventType === 'deployment_accepted';
  const expectedKeys = [
    'ts',
    'event_type',
    'env',
    ...(needsDeploymentId ? ['deployment_id'] : []),
    'resource_name',
    'state',
  ];
  if (!hasExactKeys(candidate, expectedKeys)) {
    return undefined;
  }

  const timestamp = parseCanonicalOpsLedgerTimestamp(candidate['ts']);
  const resourceName = candidate['resource_name'];
  const state = candidate['state'];
  const deploymentId = candidate['deployment_id'];
  if (
    candidate['env'] !== config.deploymentEnvironment ||
    timestamp === undefined ||
    typeof resourceName !== 'string' ||
    !SAFE_RESOURCE_NAME_PATTERN.test(resourceName) ||
    typeof state !== 'string' ||
    (needsDeploymentId && (typeof deploymentId !== 'string' || !DEPLOYMENT_ID_PATTERN.test(deploymentId)))
  ) {
    return undefined;
  }

  const validSourceState =
    (eventType === 'alarm_state_changed' &&
      resourceName.startsWith(`${config.opsLedgerResourcePrefix}-`) &&
      ALARM_STATES.has(state)) ||
    (eventType === 'ecs_task_stopped' && resourceName === 'prover-task' && state === 'STOPPED') ||
    (eventType === 'pipeline_execution_changed' &&
      config.opsLedgerPipelineNames.has(resourceName) &&
      PIPELINE_STATES.has(state)) ||
    (eventType === 'deployment_accepted' && resourceName === 'app' && state === 'ACCEPTED');
  if (!validSourceState) {
    return undefined;
  }

  return {
    timestamp,
    event: {
      ts: new Date(timestamp).toISOString(),
      event_type: eventType,
      env: config.deploymentEnvironment,
      ...(needsDeploymentId ? { deployment_id: deploymentId as string } : {}),
      resource_name: resourceName,
      state,
    },
  };
}

function isResourceAlreadyExists(error: unknown): boolean {
  return isRecord(error) && error['name'] === 'ResourceAlreadyExistsException';
}

async function writeOpsLedgerEvent(
  config: SemaphoreJanitorConfig,
  event: NormalizedOpsLedgerEvent,
  timestamp: number,
): Promise<OpsLedgerResult> {
  try {
    await logsClient.send(
      new CreateLogStreamCommand({
        logGroupName: config.opsLedgerLogGroupName,
        logStreamName: OPS_LEDGER_LOG_STREAM_NAME,
      }),
    );
  } catch (error) {
    if (!isResourceAlreadyExists(error)) {
      throw error;
    }
  }

  const response = await logsClient.send(
    new PutLogEventsCommand({
      logGroupName: config.opsLedgerLogGroupName,
      logStreamName: OPS_LEDGER_LOG_STREAM_NAME,
      logEvents: [
        {
          timestamp,
          message: JSON.stringify(event),
        },
      ],
    }),
  );
  const rejected = response.rejectedLogEventsInfo;
  if (
    rejected?.expiredLogEventEndIndex !== undefined ||
    rejected?.tooNewLogEventStartIndex !== undefined ||
    rejected?.tooOldLogEventEndIndex !== undefined
  ) {
    throw new Error('CloudWatch Logs rejected normalized ops ledger event');
  }
  return { recorded: true };
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
    return response.status !== 'RUNNING' && response.status !== 'PENDING_REDRIVE';
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
    throwInvalidEventBridgeInvocation();
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

export const handler = async (event: unknown): Promise<SemaphoreJanitorResult | OpsLedgerResult> => {
  let config: SemaphoreJanitorConfig | undefined;
  await bootstrapLambdaRuntime({
    serviceName: 'semaphore-janitor',
    resolveRuntimeReferences: async (invalidNameCollector) => {
      await ensureAwsRuntimeConfigReferencesLoaded('semaphore_janitor', { invalidNameCollector });
    },
    validationSteps: [
      {
        validate: validateTargetObservabilityEnv,
      },
      {
        validate: () => {
          config = resolveConfig();
        },
      },
    ],
  });
  if (!config) {
    throw new Error('Semaphore janitor configuration was not initialized');
  }
  if (!isRecord(event)) {
    throwInvalidEventBridgeInvocation();
  }

  if (Object.hasOwn(event, 'event_type')) {
    const parsed = parseOpsLedgerEvent(config, event);
    if (!parsed) {
      throwInvalidOpsLedgerInvocation();
    }
    return writeOpsLedgerEvent(config, parsed.event, parsed.timestamp);
  }

  const source = getStringProperty(event, 'source');
  const detailType = getStringProperty(event, 'detail-type');
  if (source === 'aws.states') {
    const detail = isRecord(event['detail']) ? event['detail'] : undefined;
    if (
      detailType !== 'Step Functions Execution Status Change' ||
      !detail ||
      !getStringProperty(detail, 'status') ||
      !getStringProperty(detail, 'stateMachineArn')
    ) {
      throwInvalidEventBridgeInvocation();
    }
    return handleExecutionStatusEvent(config, event);
  }
  if (source === 'aws.events' && detailType === 'Scheduled Event') {
    return handleScheduledSweep(config);
  }

  throwInvalidEventBridgeInvocation();
};
