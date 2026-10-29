import { CloudWatchLogsClient, CreateLogStreamCommand, PutLogEventsCommand } from '@aws-sdk/client-cloudwatch-logs';
import { logger } from '@stark-ballot/diagnostics/logger';
import { ensureAwsRuntimeConfigReferencesLoaded } from '@stark-ballot/aws-adapters/config/awsRuntimeConfigReferenceResolver';
import { validateTargetObservabilityEnv } from '@stark-ballot/runtime-config/env/observability';
import {
  resolveRuntimeProfile,
  type ResolvedRuntimeProfile,
  validateRuntimeProfileSelection,
} from '@stark-ballot/runtime-config/env/runtimeProfile';
import { RuntimeConfigValidationError, bootstrapLambdaRuntime, type RuntimeConfigName } from '../runtimeBootstrap.js';

const OPS_LEDGER_LOG_STREAM_NAME = 'normalized-events';
const OPS_LEDGER_EVENT_TYPES = new Set([
  'alarm_state_changed',
  'prover_job_finished',
  'pipeline_execution_changed',
  'deployment_accepted',
]);
let resolvedRuntimeProfile: ResolvedRuntimeProfile | undefined;
let resolvedAwsClients: OpsLedgerAwsClients | undefined;
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
const DEPLOYMENT_MODES = new Set(['normal', 'rollback']);
const PLAN_DISPOSITIONS = new Set(['changed', 'empty']);
const MAX_OPS_LEDGER_EVENT_AGE_MILLIS = 25 * 60 * 60 * 1000;
const MAX_OPS_LEDGER_FUTURE_SKEW_MILLIS = 5 * 60 * 1000;
const CANONICAL_ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const DEPLOYMENT_ID_PATTERN = /^dep_[0-9a-f]{32}$/;
const PIPELINE_EXECUTION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SAFE_RESOURCE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;
const SAFE_RESOURCE_PREFIX_PATTERN = /^[a-z0-9][a-z0-9-]{2,127}$/;
const SAFE_PIPELINE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/;
const SAFE_OPS_LEDGER_LOG_GROUP_PATTERN = /^\/aws\/events\/[a-z0-9][a-z0-9-]{2,127}-ops-ledger$/;
const OPS_LEDGER_PIPELINE_SUFFIXES = ['', '-foundation', '-app', '-toolchain-release', '-prover-release'] as const;

export interface OpsLedgerResult {
  recorded: true;
}

type OpsLedgerEventType =
  | 'alarm_state_changed'
  | 'prover_job_finished'
  | 'pipeline_execution_changed'
  | 'deployment_accepted';

interface NormalizedOpsLedgerEvent {
  ts: string;
  event_type: OpsLedgerEventType;
  env: string;
  deployment_id?: string;
  deployment_mode?: string;
  pipeline_execution_id?: string;
  plan_disposition?: string;
  resource_name: string;
  state: string;
}

interface OpsLedgerConfig {
  opsLedgerLogGroupName: string;
  opsLedgerResourcePrefix: string;
  opsLedgerPipelineNames: ReadonlySet<string>;
  deploymentEnvironment: string;
}

interface OpsLedgerAwsClients {
  logs: CloudWatchLogsClient;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function throwInvalidOpsLedgerInvocation(): never {
  logger.warn('Invocation payload is invalid', {
    event: 'invocation_invalid',
    source_kind: 'ops_ledger',
    reason: 'event_shape_invalid',
  });
  throw new Error('Invalid ops ledger invocation');
}

function addInvalidLedgerConfig(names: RuntimeConfigName[], name: RuntimeConfigName): void {
  if (!names.includes(name)) names.push(name);
}

function missingLedgerConfig(profile: ResolvedRuntimeProfile, env: NodeJS.ProcessEnv): RuntimeConfigName[] {
  const invalidNames: RuntimeConfigName[] = [];
  if (profile.target.kind !== 'aws' || profile.external.kind !== 'aws') {
    invalidNames.push('RUNTIME_PROFILE');
  }
  for (const name of [
    'OPS_LEDGER_LOG_GROUP_NAME',
    'OPS_LEDGER_PIPELINE_BASE_NAME',
    'OPS_LEDGER_RESOURCE_PREFIX',
  ] as const satisfies readonly RuntimeConfigName[]) {
    if (!env[name]?.trim()) {
      invalidNames.push(name);
    }
  }

  return invalidNames;
}

function readLedgerResourceConfig(env: NodeJS.ProcessEnv, invalidNames: RuntimeConfigName[]) {
  const opsLedgerResourcePrefix = env['OPS_LEDGER_RESOURCE_PREFIX']?.trim() ?? '';
  if (!SAFE_RESOURCE_PREFIX_PATTERN.test(opsLedgerResourcePrefix)) {
    addInvalidLedgerConfig(invalidNames, 'OPS_LEDGER_RESOURCE_PREFIX');
  }
  const opsLedgerLogGroupName = env['OPS_LEDGER_LOG_GROUP_NAME']?.trim() ?? '';
  if (
    !SAFE_OPS_LEDGER_LOG_GROUP_PATTERN.test(opsLedgerLogGroupName) ||
    (SAFE_RESOURCE_PREFIX_PATTERN.test(opsLedgerResourcePrefix) &&
      opsLedgerLogGroupName !== `/aws/events/${opsLedgerResourcePrefix}-ops-ledger`)
  ) {
    addInvalidLedgerConfig(invalidNames, 'OPS_LEDGER_LOG_GROUP_NAME');
  }
  return { opsLedgerResourcePrefix, opsLedgerLogGroupName };
}

function isLedgerPipelineIdentity(
  basePipelineName: string,
  pipelineIdentitySuffix: string,
  expectedPipelineNames: readonly string[],
): boolean {
  return !(
    !SAFE_PIPELINE_NAME_PATTERN.test(basePipelineName) ||
    !pipelineIdentitySuffix ||
    !basePipelineName.endsWith(pipelineIdentitySuffix) ||
    basePipelineName.length <= pipelineIdentitySuffix.length ||
    expectedPipelineNames.some((name) => !SAFE_PIPELINE_NAME_PATTERN.test(name))
  );
}

function readLedgerPipelineNames(
  deploymentEnvironment: string,
  env: NodeJS.ProcessEnv,
  invalidNames: RuntimeConfigName[],
): ReadonlySet<string> {
  const accountAlias =
    deploymentEnvironment === 'develop' ? 'stark-dev' : deploymentEnvironment === 'main' ? 'stark-prod' : '';
  const basePipelineName = env['OPS_LEDGER_PIPELINE_BASE_NAME']?.trim() ?? '';
  const pipelineIdentitySuffix = accountAlias ? `-pipeline-${accountAlias}-${deploymentEnvironment}` : '';
  const expectedPipelineNames = OPS_LEDGER_PIPELINE_SUFFIXES.map((suffix) => `${basePipelineName}${suffix}`);
  if (!isLedgerPipelineIdentity(basePipelineName, pipelineIdentitySuffix, expectedPipelineNames)) {
    addInvalidLedgerConfig(invalidNames, 'OPS_LEDGER_PIPELINE_BASE_NAME');
  }
  return new Set(expectedPipelineNames);
}

function assertLedgerConfig(invalidNames: RuntimeConfigName[]): void {
  if (invalidNames.length > 0) {
    const message = invalidNames.includes('RUNTIME_PROFILE')
      ? 'RUNTIME_PROFILE=target-aws-async is required for semaphore janitor'
      : `${invalidNames[0]} is required for operations ledger`;
    throw new RuntimeConfigValidationError(invalidNames, undefined, message);
  }
}

function resolveConfig(profile: ResolvedRuntimeProfile, env: NodeJS.ProcessEnv): OpsLedgerConfig {
  const invalidNames = missingLedgerConfig(profile, env);
  const resource = readLedgerResourceConfig(env, invalidNames);
  const deploymentEnvironment = profile.target.kind === 'aws' ? profile.target.deploymentEnvironment : '';
  const opsLedgerPipelineNames = readLedgerPipelineNames(deploymentEnvironment, env, invalidNames);
  assertLedgerConfig(invalidNames);
  return { ...resource, opsLedgerPipelineNames, deploymentEnvironment };
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
  return isRetainedLedgerTimestamp(millis) ? millis : undefined;
}

function isRetainedLedgerTimestamp(millis: number): boolean {
  const now = Date.now();
  return millis >= now - MAX_OPS_LEDGER_EVENT_AGE_MILLIS && millis <= now + MAX_OPS_LEDGER_FUTURE_SKEW_MILLIS;
}

interface LedgerEventRequirements {
  needsDeploymentId: boolean;
  needsPipelineExecutionId: boolean;
  needsAcceptanceDisposition: boolean;
}

function ledgerEventRequirements(eventType: string): LedgerEventRequirements {
  const needsDeploymentId = eventType === 'prover_job_finished' || eventType === 'deployment_accepted';
  const needsPipelineExecutionId = eventType === 'pipeline_execution_changed' || eventType === 'deployment_accepted';
  const needsAcceptanceDisposition = eventType === 'deployment_accepted';
  return { needsDeploymentId, needsPipelineExecutionId, needsAcceptanceDisposition };
}

function ledgerEventKeys({
  needsDeploymentId,
  needsPipelineExecutionId,
  needsAcceptanceDisposition,
}: LedgerEventRequirements): string[] {
  const expectedKeys = [
    'ts',
    'event_type',
    'env',
    ...(needsDeploymentId ? ['deployment_id'] : []),
    ...(needsAcceptanceDisposition ? ['deployment_mode'] : []),
    ...(needsPipelineExecutionId ? ['pipeline_execution_id'] : []),
    ...(needsAcceptanceDisposition ? ['plan_disposition'] : []),
    'resource_name',
    'state',
  ];
  return expectedKeys;
}

function readLedgerFields(candidate: Record<string, unknown>) {
  const resourceName = candidate['resource_name'];
  const state = candidate['state'];
  const deploymentId = candidate['deployment_id'];
  const deploymentMode = candidate['deployment_mode'];
  const pipelineExecutionId = candidate['pipeline_execution_id'];
  const planDisposition = candidate['plan_disposition'];
  return { resourceName, state, deploymentId, deploymentMode, pipelineExecutionId, planDisposition };
}

type LedgerFields = ReturnType<typeof readLedgerFields>;
type LedgerResourceFields = LedgerFields & { resourceName: string; state: string };

function hasValidLedgerEnvelope(
  config: OpsLedgerConfig,
  candidate: Record<string, unknown>,
  timestamp: number | undefined,
  fields: LedgerFields,
): fields is LedgerResourceFields {
  return (
    candidate['env'] === config.deploymentEnvironment &&
    timestamp !== undefined &&
    typeof fields.resourceName === 'string' &&
    SAFE_RESOURCE_NAME_PATTERN.test(fields.resourceName) &&
    typeof fields.state === 'string'
  );
}

function matchesLedgerString(value: unknown, pattern: RegExp): boolean {
  return typeof value === 'string' && pattern.test(value);
}

function hasAcceptanceDisposition(fields: LedgerFields): boolean {
  return (
    typeof fields.deploymentMode === 'string' &&
    DEPLOYMENT_MODES.has(fields.deploymentMode) &&
    typeof fields.planDisposition === 'string' &&
    PLAN_DISPOSITIONS.has(fields.planDisposition)
  );
}

function hasValidLedgerCorrelations(fields: LedgerFields, requirements: LedgerEventRequirements): boolean {
  return (
    (!requirements.needsDeploymentId || matchesLedgerString(fields.deploymentId, DEPLOYMENT_ID_PATTERN)) &&
    (!requirements.needsPipelineExecutionId ||
      matchesLedgerString(fields.pipelineExecutionId, PIPELINE_EXECUTION_ID_PATTERN)) &&
    (!requirements.needsAcceptanceDisposition || hasAcceptanceDisposition(fields))
  );
}

const ledgerSourceRules = new Map<string, (config: OpsLedgerConfig, resourceName: string, state: string) => boolean>([
  [
    'alarm_state_changed',
    (config, resourceName, state) =>
      resourceName.startsWith(`${config.opsLedgerResourcePrefix}-`) && ALARM_STATES.has(state),
  ],
  [
    'prover_job_finished',
    (_config, resourceName, state) => resourceName === 'prover-job' && (state === 'SUCCEEDED' || state === 'FAILED'),
  ],
  [
    'pipeline_execution_changed',
    (config, resourceName, state) => config.opsLedgerPipelineNames.has(resourceName) && PIPELINE_STATES.has(state),
  ],
  ['deployment_accepted', (_config, resourceName, state) => resourceName === 'app' && state === 'ACCEPTED'],
]);

function normalizedLedgerEvent(
  config: OpsLedgerConfig,
  eventType: OpsLedgerEventType,
  timestamp: number,
  fields: LedgerResourceFields,
  requirements: LedgerEventRequirements,
): NormalizedOpsLedgerEvent {
  const { resourceName, state, deploymentId, deploymentMode, pipelineExecutionId, planDisposition } = fields;
  const { needsDeploymentId, needsPipelineExecutionId, needsAcceptanceDisposition } = requirements;
  return {
    ts: new Date(timestamp).toISOString(),
    event_type: eventType,
    env: config.deploymentEnvironment,
    ...(needsDeploymentId ? { deployment_id: deploymentId as string } : {}),
    ...(needsAcceptanceDisposition ? { deployment_mode: deploymentMode as string } : {}),
    ...(needsPipelineExecutionId ? { pipeline_execution_id: pipelineExecutionId as string } : {}),
    ...(needsAcceptanceDisposition ? { plan_disposition: planDisposition as string } : {}),
    resource_name: resourceName,
    state,
  };
}

function isOpsLedgerEventType(value: unknown): value is OpsLedgerEventType {
  return typeof value === 'string' && OPS_LEDGER_EVENT_TYPES.has(value);
}

function parseOpsLedgerEvent(
  config: OpsLedgerConfig,
  candidate: Record<string, unknown>,
): { event: NormalizedOpsLedgerEvent; timestamp: number } | undefined {
  const eventType = candidate['event_type'];
  if (!isOpsLedgerEventType(eventType)) {
    return undefined;
  }
  const requirements = ledgerEventRequirements(eventType);
  const expectedKeys = ledgerEventKeys(requirements);
  if (!hasExactKeys(candidate, expectedKeys)) {
    return undefined;
  }

  const timestamp = parseCanonicalOpsLedgerTimestamp(candidate['ts']);
  const fields = readLedgerFields(candidate);
  if (
    !hasValidLedgerEnvelope(config, candidate, timestamp, fields) ||
    !hasValidLedgerCorrelations(fields, requirements)
  )
    return undefined;

  if (!ledgerSourceRules.get(eventType)?.(config, fields.resourceName, fields.state)) return undefined;

  if (timestamp === undefined) return undefined;
  return { timestamp, event: normalizedLedgerEvent(config, eventType, timestamp, fields, requirements) };
}

function isResourceAlreadyExists(error: unknown): boolean {
  return isRecord(error) && error['name'] === 'ResourceAlreadyExistsException';
}

async function writeOpsLedgerEvent(
  logsClient: CloudWatchLogsClient,
  config: OpsLedgerConfig,
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

export const handler = async (event: unknown): Promise<OpsLedgerResult> => {
  const env = process.env;
  const runtimeProfile = (resolvedRuntimeProfile ??= resolveRuntimeProfile(env));
  let config: OpsLedgerConfig | undefined;
  await bootstrapLambdaRuntime({
    serviceName: 'semaphore-janitor',
    runtimeProfile,
    resolveRuntimeReferences: async (invalidNameCollector) => {
      await ensureAwsRuntimeConfigReferencesLoaded('semaphore_janitor', {
        profile: runtimeProfile,
        invalidNameCollector,
        env,
      });
    },
    validationSteps: [
      {
        validate: () => validateRuntimeProfileSelection(runtimeProfile, env),
      },
      {
        validate: () => validateTargetObservabilityEnv(runtimeProfile, env),
      },
      {
        validate: () => {
          config = resolveConfig(runtimeProfile, env);
        },
      },
    ],
    env,
  });
  if (!config) {
    throw new Error('Operations ledger configuration was not initialized');
  }
  if (runtimeProfile.external.kind !== 'aws') {
    throw new Error('Target operations ledger runtime profile was not resolved');
  }
  const awsClientConfig = { region: runtimeProfile.external.region };
  const clients = (resolvedAwsClients ??= {
    logs: new CloudWatchLogsClient(awsClientConfig),
  });
  if (!isRecord(event)) {
    throwInvalidOpsLedgerInvocation();
  }
  const parsed = parseOpsLedgerEvent(config, event);
  if (!parsed) {
    throwInvalidOpsLedgerInvocation();
  }
  return writeOpsLedgerEvent(clients.logs, config, parsed.event, parsed.timestamp);
};
