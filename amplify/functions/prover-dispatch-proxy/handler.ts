import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { SFNClient, StartExecutionCommand } from '@aws-sdk/client-sfn';
import { fromNodeProviderChain } from '@aws-sdk/credential-providers';
import type { SignatureV4 } from '@smithy/signature-v4';
import { createAppSyncSigner, signedAppSyncFetch } from '../../../src/lib/aws/appsyncSignedFetch.js';
import { resolveAppSyncRegion } from '../../../src/lib/aws/appsyncRegionResolver.js';
import {
  classifyAuthoritativeWriteContract,
  isFailClosedCurrentArtifactState,
  resolveCurrentContractGeneration,
  resolveSessionFinalizationArtifactState,
} from '../../../src/lib/contract/index.js';
import { parseProverWorkMessage } from '../../../src/lib/finalize/types.js';
import {
  parseStoredFinalizationEnvelope,
  parseStoredFinalizationPayload,
  serializeStoredFinalizationPayload,
} from '../../../src/lib/store/amplify/finalization.js';
import type { FinalizationState, FinalizationStoragePayload } from '../../../src/types/server.js';
import { buildInputUploadPayload } from './input-storage.js';
import {
  evaluateDispatchPreconditions,
  type DispatchPreconditionCode,
  type DispatchSessionSnapshot,
} from './dispatch-guard.js';

type LogLevel = 'INFO' | 'WARN' | 'ERROR';
type LogAction =
  | 'receive'
  | 'parse'
  | 'validate_dispatch'
  | 'upload_input'
  | 'start_execution'
  | 'mark_running'
  | 'error';

const COMPONENT = 'prover-dispatch-proxy';
const METRIC_NAMESPACE = 'stark-ballot-simulator/prover-dispatch-proxy';
const ENVIRONMENT_NAME = process.env.ENV_NAME ?? 'develop';
const stateMachineArn = process.env.PROVER_STATE_MACHINE_ARN;
const DEFAULT_PROOF_BUCKET = 'stark-ballot-simulator-proof-bundles-develop';
const proofBucketName = resolveProofBucketName();
const proofPrefix = process.env.S3_PROOF_PREFIX ?? 'sessions/';

if (!stateMachineArn) {
  throw new Error('PROVER_STATE_MACHINE_ARN environment variable is required');
}

const sfnClient = new SFNClient({});
const s3Client = new S3Client({});

type PersistedFinalizationSnapshot = {
  sessionContractGeneration?: string;
  finalizationContractGeneration?: string;
  finalizationArtifactState?: 'unsupported_current_artifact' | 'corrupt_or_unreadable' | null;
  hasPersistedFinalizationBranch: boolean;
  finalized: boolean;
  payloadReadable: boolean;
  finalizationResult: FinalizationStoragePayload['finalizationResult'];
  finalizationState: FinalizationState | null;
  finalizationScenarioContext: FinalizationStoragePayload['finalizationScenarioContext'];
  executionId: string | null;
};

function buildUnsupportedCurrentState(input: {
  executionId: string;
  queuedAt: number;
  carriedContractGeneration?: string | null;
  persistedContractGeneration?: string | null;
  startedAt?: number;
  stepFunctionsArn?: string;
}): FinalizationState {
  return {
    status: 'failed',
    executionId: input.executionId,
    queuedAt: input.queuedAt,
    ...(input.startedAt !== undefined ? { startedAt: input.startedAt } : {}),
    failedAt: Date.now(),
    error: {
      code: 'UNSUPPORTED_CURRENT_ARTIFACT',
      message: 'Finalization execution no longer matches the current contract generation',
      details: {
        runtimeContractGeneration: resolveCurrentContractGeneration(),
        persistedContractGeneration: input.persistedContractGeneration ?? null,
        carriedContractGeneration: input.carriedContractGeneration ?? null,
      },
    },
    ...(input.stepFunctionsArn ? { stepFunctionsArn: input.stepFunctionsArn } : {}),
  };
}

function resolveStoredContractGeneration(snapshot: PersistedFinalizationSnapshot): string | undefined {
  return snapshot.hasPersistedFinalizationBranch
    ? snapshot.finalizationContractGeneration
    : snapshot.sessionContractGeneration;
}

function resolveSnapshotArtifactState(
  snapshot: PersistedFinalizationSnapshot | null,
): 'unsupported_current_artifact' | 'corrupt_or_unreadable' | null {
  if (!snapshot) {
    return null;
  }

  const artifactState = resolveSessionFinalizationArtifactState({
    finalized: snapshot.finalized,
    hasPersistedFinalizationBranch: snapshot.hasPersistedFinalizationBranch,
    contractGeneration: snapshot.sessionContractGeneration,
    finalizationContractGeneration: snapshot.finalizationContractGeneration,
    finalizationArtifactState: snapshot.finalizationArtifactState,
    finalizationResult: snapshot.finalizationResult,
    finalizationState: snapshot.finalizationState,
    finalizationScenarioContext: snapshot.finalizationScenarioContext,
  });

  return isFailClosedCurrentArtifactState(artifactState) ? artifactState : null;
}

class AmplifySessionClient {
  private readonly endpoint: string;
  private readonly endpointUrl: URL;
  private readonly region: string;
  private readonly ttlSeconds: number;
  private readonly verificationTtlSeconds: number;
  private signer: SignatureV4 | null = null;

  constructor() {
    const endpoint = process.env.AMPLIFY_DATA_ENDPOINT;
    if (!endpoint) {
      throw new Error('AMPLIFY_DATA_ENDPOINT is required for AmplifySessionClient');
    }
    this.endpoint = endpoint;
    this.endpointUrl = new URL(endpoint);

    const resolvedRegion = resolveAppSyncRegion(this.endpointUrl, process.env);
    if (!resolvedRegion) {
      throw new Error(`Unable to resolve AWS region from endpoint: ${this.endpointUrl.hostname}`);
    }
    this.region = resolvedRegion;

    const ttlParsed = parseInt(process.env.AMPLIFY_DATA_TTL_SECONDS ?? '', 10);
    this.ttlSeconds = Number.isFinite(ttlParsed) && ttlParsed > 0 ? ttlParsed : 1800;

    const verificationParsed = parseInt(process.env.AMPLIFY_DATA_VERIFICATION_TTL_SECONDS ?? '', 10);
    const verificationSeconds =
      Number.isFinite(verificationParsed) && verificationParsed > 0 ? verificationParsed : 86400;
    this.verificationTtlSeconds = Math.max(this.ttlSeconds, verificationSeconds);
  }

  async markFinalizationRunning(input: {
    sessionId: string;
    executionId: string;
    contractGeneration: string;
    queuedAt: number;
    startedAt: number;
    stepFunctionsArn: string;
    scenarioContext?: FinalizationStoragePayload['finalizationScenarioContext'];
  }): Promise<FinalizationState> {
    const current = await this.fetchFinalizationPayload(input.sessionId);
    if (!current) {
      throw new Error(`Session not found while marking running: ${input.sessionId}`);
    }

    if (current.executionId !== input.executionId) {
      log('WARN', 'mark_running', input, {
        message: 'Execution ID mismatch while marking running; existing state preserved',
        existingExecutionId: current.executionId,
      });
      return (
        current.finalizationState ??
        buildUnsupportedCurrentState({
          executionId: input.executionId,
          queuedAt: input.queuedAt,
          carriedContractGeneration: input.contractGeneration,
          persistedContractGeneration: resolveStoredContractGeneration(current),
          startedAt: input.startedAt,
          stepFunctionsArn: input.stepFunctionsArn,
        })
      );
    }

    if (
      classifyAuthoritativeWriteContract({
        persistedContractGeneration: resolveStoredContractGeneration(current),
        carriedContractGeneration: input.contractGeneration,
      }) !== 'supported'
    ) {
      return this.failUnsupportedCurrentExecution({
        sessionId: input.sessionId,
        executionId: input.executionId,
        queuedAt: input.queuedAt,
        carriedContractGeneration: input.contractGeneration,
        startedAt: input.startedAt,
        stepFunctionsArn: input.stepFunctionsArn,
        scenarioContext: input.scenarioContext,
      });
    }

    const nextState: FinalizationState = {
      status: 'running',
      executionId: input.executionId,
      queuedAt: input.queuedAt,
      startedAt: input.startedAt,
      stepFunctionsArn: input.stepFunctionsArn,
    };

    const serialized = this.serializePayload({
      contractGeneration: resolveStoredContractGeneration(current),
      finalizationResult: current.finalizationResult ?? null,
      finalizationState: nextState,
      finalizationScenarioContext: input.scenarioContext ?? current.finalizationScenarioContext ?? null,
    });

    const now = Date.now();
    const ttl = Math.floor(now / 1000) + this.ttlSeconds;

    await this.executeGraphQL(UPDATE_SESSION_MUTATION, {
      input: {
        id: input.sessionId,
        finalizationResultJson: serialized,
        finalizationArtifactState: null,
        lastActivity: new Date(now).toISOString(),
        ttl,
      },
    });

    return nextState;
  }

  async getDispatchSessionSnapshot(sessionId: string): Promise<DispatchSessionSnapshot | null> {
    const current = await this.fetchFinalizationPayload(sessionId);
    if (!current) {
      return null;
    }

    return {
      sessionId,
      sessionContractGeneration: current.sessionContractGeneration ?? null,
      finalizationContractGeneration: current.finalizationContractGeneration ?? null,
      finalizationArtifactState: resolveSnapshotArtifactState(current),
      finalizationState: current.finalizationState
        ? {
            status: current.finalizationState.status,
            executionId: current.finalizationState.executionId,
          }
        : null,
    };
  }

  private serializePayload(payload: FinalizationStoragePayload): string | null {
    return serializeStoredFinalizationPayload(payload);
  }

  async failUnsupportedCurrentExecution(input: {
    sessionId: string;
    executionId: string;
    queuedAt: number;
    carriedContractGeneration?: string | null;
    startedAt?: number;
    stepFunctionsArn?: string;
    scenarioContext?: FinalizationStoragePayload['finalizationScenarioContext'];
  }): Promise<FinalizationState> {
    const nextState = await this.persistArtifactTombstone({
      ...input,
      artifactState: 'unsupported_current_artifact',
    });
    if (!nextState) {
      throw new Error(`Unsupported-current tombstone did not produce a finalization state: ${input.sessionId}`);
    }
    return nextState;
  }

  async persistArtifactTombstone(input: {
    sessionId: string;
    executionId: string;
    queuedAt: number;
    artifactState: 'unsupported_current_artifact' | 'corrupt_or_unreadable';
    carriedContractGeneration?: string | null;
    startedAt?: number;
    stepFunctionsArn?: string;
    scenarioContext?: FinalizationStoragePayload['finalizationScenarioContext'];
  }): Promise<FinalizationState | null> {
    const current = await this.fetchFinalizationPayload(input.sessionId);
    if (!current) {
      throw new Error(`Session not found while persisting artifact tombstone: ${input.sessionId}`);
    }

    const storedContractGeneration = resolveStoredContractGeneration(current);
    const nextState =
      input.artifactState === 'unsupported_current_artifact'
        ? buildUnsupportedCurrentState({
            executionId: input.executionId,
            queuedAt: input.queuedAt,
            carriedContractGeneration: input.carriedContractGeneration,
            persistedContractGeneration: storedContractGeneration,
            startedAt: input.startedAt,
            stepFunctionsArn: input.stepFunctionsArn,
          })
        : null;

    const now = Date.now();
    const ttl = Math.floor(now / 1000) + (current.finalized ? this.verificationTtlSeconds : this.ttlSeconds);
    const updateInput: Record<string, unknown> = {
      id: input.sessionId,
      finalizationArtifactState: input.artifactState,
      lastActivity: new Date(now).toISOString(),
      ttl,
    };

    if (storedContractGeneration && nextState) {
      updateInput.finalizationResultJson = this.serializePayload({
        contractGeneration: storedContractGeneration,
        finalizationResult: current.finalizationResult ?? null,
        finalizationState: nextState,
        finalizationScenarioContext: input.scenarioContext ?? current.finalizationScenarioContext ?? null,
      });
    }

    await this.executeGraphQL(UPDATE_SESSION_MUTATION, {
      input: updateInput,
    });

    return nextState ?? current.finalizationState ?? null;
  }

  private async fetchFinalizationPayload(sessionId: string): Promise<PersistedFinalizationSnapshot | null> {
    const response = await this.executeGraphQL(GET_SESSION_QUERY, { id: sessionId });
    const session = response.getVotingSession;
    if (!session) {
      log('WARN', 'mark_running', { sessionId }, { message: 'Session not found while marking running' });
      return null;
    }
    if (!session.finalizationResultJson) {
      return {
        sessionContractGeneration: session.contractGeneration ?? undefined,
        finalizationContractGeneration: undefined,
        finalizationArtifactState: isFailClosedCurrentArtifactState(session.finalizationArtifactState)
          ? session.finalizationArtifactState
          : undefined,
        hasPersistedFinalizationBranch: Boolean(session.finalized),
        finalized: session.finalized ?? false,
        payloadReadable: !session.finalized,
        finalizationResult: null,
        finalizationState: null,
        finalizationScenarioContext: null,
        executionId: null,
      };
    }

    const envelope = parseStoredFinalizationEnvelope(session.finalizationResultJson);
    const parsed = parseStoredFinalizationPayload(session.finalizationResultJson);
    if (!envelope && !parsed) {
      log('WARN', 'mark_running', { sessionId }, { message: 'Failed to parse finalizationResultJson' });
    }
    const boundaryArtifactState = isFailClosedCurrentArtifactState(session.finalizationArtifactState)
      ? session.finalizationArtifactState
      : undefined;
    return {
      sessionContractGeneration: session.contractGeneration ?? undefined,
      finalizationContractGeneration: parsed?.contractGeneration ?? envelope?.contractGeneration,
      finalizationArtifactState: boundaryArtifactState,
      hasPersistedFinalizationBranch: true,
      finalized: session.finalized ?? false,
      payloadReadable: parsed !== undefined,
      finalizationResult: parsed?.finalizationResult ?? null,
      finalizationState: parsed?.finalizationState ?? null,
      finalizationScenarioContext: parsed?.finalizationScenarioContext ?? null,
      executionId: parsed?.finalizationState?.executionId ?? null,
    };
  }

  private async executeGraphQL<T>(
    query: string,
    variables: Record<string, unknown>,
  ): Promise<{ [K in keyof T]: T[K] }> {
    const body = JSON.stringify({ query, variables });

    if (!this.signer) {
      this.signer = createAppSyncSigner({
        credentials: fromNodeProviderChain(),
        region: this.region,
      });
    }
    const response = await signedAppSyncFetch({
      endpoint: this.endpointUrl,
      body,
      signer: this.signer,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`GraphQL request failed with ${response.status}: ${text}`);
    }

    const json = (await response.json()) as GraphQLResponse<T>;
    if (json.errors?.length) {
      throw new Error(`GraphQL responded with errors: ${JSON.stringify(json.errors)}`);
    }
    if (!json.data) {
      throw new Error('GraphQL response missing data');
    }
    return json.data;
  }
}

const sessionClient = new AmplifySessionClient();

interface GraphQLResponse<T> {
  data?: { [K in keyof T]: T[K] };
  errors?: Array<{ message: string }>;
}

const GET_SESSION_QUERY = /* GraphQL */ `
  query GetVotingSession($id: ID!) {
    getVotingSession(id: $id) {
      id
      contractGeneration
      finalizationArtifactState
      finalized
      finalizationResultJson
    }
  }
`;

const UPDATE_SESSION_MUTATION = /* GraphQL */ `
  mutation UpdateVotingSession($input: UpdateVotingSessionInput!) {
    updateVotingSession(input: $input) {
      id
    }
  }
`;

export const handler = async (event: SqsEvent): Promise<void> => {
  for (const record of event.Records) {
    await processRecord(record);
  }
};

async function processRecord(record: SqsRecord): Promise<void> {
  const baseContext = {
    messageId: record.messageId,
  };
  log('INFO', 'receive', baseContext, { message: 'Received SQS message' });

  let parsedMessage: ReturnType<typeof parseProverWorkMessage>;
  try {
    const body = JSON.parse(record.body);
    parsedMessage = parseProverWorkMessage(body);
  } catch (error) {
    log('ERROR', 'parse', baseContext, {
      message: 'Failed to parse SQS message',
      error,
    });
    throw error instanceof Error ? error : new Error('Invalid SQS message payload');
  }

  const inputContext = {
    ...baseContext,
    sessionId: parsedMessage.sessionId,
    executionId: parsedMessage.executionId,
  };

  let dispatchSnapshot: DispatchSessionSnapshot | null;
  try {
    dispatchSnapshot = await sessionClient.getDispatchSessionSnapshot(parsedMessage.sessionId);
  } catch (error) {
    log('ERROR', 'validate_dispatch', inputContext, {
      message: 'Failed to load session snapshot for dispatch preconditions',
      error,
    });
    throw error instanceof Error ? error : new Error('Failed to load session snapshot for dispatch preconditions');
  }

  if (dispatchSnapshot?.finalizationArtifactState) {
    await sessionClient.persistArtifactTombstone({
      sessionId: parsedMessage.sessionId,
      executionId: parsedMessage.executionId,
      queuedAt: parsedMessage.queuedAt,
      artifactState: dispatchSnapshot.finalizationArtifactState,
      carriedContractGeneration: parsedMessage.contractGeneration,
      scenarioContext: parsedMessage.scenarioContext,
    });
    log('WARN', 'validate_dispatch', inputContext, {
      message: 'Dispatch aborted because the persisted artifact is already fail-closed',
      artifactState: dispatchSnapshot.finalizationArtifactState,
    });
    return;
  }

  const dispatchPrecondition = evaluateDispatchPreconditions(
    {
      sessionId: parsedMessage.sessionId,
      executionId: parsedMessage.executionId,
    },
    dispatchSnapshot,
  );
  if (!dispatchPrecondition.ok) {
    const retryable = shouldRetryDispatchPreconditionFailure(dispatchPrecondition.code, record);
    log('WARN', 'validate_dispatch', inputContext, {
      message: 'Dispatch precondition failed; skipping expensive execution path',
      code: dispatchPrecondition.code,
      reason: dispatchPrecondition.message,
      retryable,
    });
    emitMetric('DispatchPreconditionFailed', 1, 'Count');
    if (retryable) {
      throw new Error(`${dispatchPrecondition.code}: ${dispatchPrecondition.message}`);
    }
    return;
  }

  if (
    classifyAuthoritativeWriteContract({
      persistedContractGeneration: dispatchSnapshot?.finalizationState
        ? dispatchSnapshot.finalizationContractGeneration
        : dispatchSnapshot?.sessionContractGeneration,
      carriedContractGeneration: parsedMessage.contractGeneration,
    }) !== 'supported'
  ) {
    const state = await sessionClient.failUnsupportedCurrentExecution({
      sessionId: parsedMessage.sessionId,
      executionId: parsedMessage.executionId,
      queuedAt: parsedMessage.queuedAt,
      carriedContractGeneration: parsedMessage.contractGeneration,
      scenarioContext: parsedMessage.scenarioContext,
    });
    log('WARN', 'validate_dispatch', inputContext, {
      message: 'Dispatch generation boundary rejected the current execution',
      status: state.status,
    });
    return;
  }

  let inputS3Key: string;
  try {
    inputS3Key = await uploadInputPayload(parsedMessage, inputContext);
  } catch (error) {
    log('ERROR', 'error', inputContext, {
      message: 'Failed to upload zkVM input payload',
      error,
    });
    throw error instanceof Error ? error : new Error('Failed to upload zkVM input payload');
  }

  const startInput = {
    stateMachineArn,
    executionName: parsedMessage.executionId,
    payload: {
      ...parsedMessage,
      inputS3Key,
    },
    messageId: record.messageId,
  };

  const startTime = Date.now();
  let executionArn: string;
  try {
    executionArn = await startStepFunctionsExecution(startInput);
    emitMetric('StartExecutionSuccess', 1, 'Count');
    emitMetric('StartExecutionLatency', Date.now() - startTime, 'Milliseconds');
    log(
      'INFO',
      'start_execution',
      { ...baseContext, sessionId: parsedMessage.sessionId, executionId: parsedMessage.executionId },
      {
        message: 'Step Functions execution started',
        executionArn,
      },
    );
  } catch (error) {
    const recoverable = isThrottleError(error);
    log(
      recoverable ? 'WARN' : 'ERROR',
      'error',
      { ...baseContext, sessionId: parsedMessage.sessionId, executionId: parsedMessage.executionId },
      {
        message: 'Failed to start Step Functions execution',
        error,
        recoverable,
      },
    );
    if (recoverable) {
      throw error;
    }
    throw error instanceof Error ? error : new Error('Unknown Step Functions error');
  }

  try {
    const state = await sessionClient.markFinalizationRunning({
      sessionId: parsedMessage.sessionId,
      executionId: parsedMessage.executionId,
      contractGeneration: parsedMessage.contractGeneration,
      queuedAt: parsedMessage.queuedAt,
      startedAt: Date.now(),
      stepFunctionsArn: executionArn,
      scenarioContext: parsedMessage.scenarioContext,
    });
    log(
      'INFO',
      'mark_running',
      { ...baseContext, sessionId: parsedMessage.sessionId, executionId: parsedMessage.executionId },
      {
        message: 'Session finalization state updated',
        status: state.status,
      },
    );
  } catch (error) {
    log(
      'ERROR',
      'mark_running',
      { ...baseContext, sessionId: parsedMessage.sessionId, executionId: parsedMessage.executionId },
      {
        message: 'Failed to update finalization state',
        error,
      },
    );
    throw error instanceof Error ? error : new Error('Unknown Dynamo/AppSync error');
  }
}

type SqsRecord = {
  body: string;
  messageId: string;
  attributes?: {
    ApproximateReceiveCount?: string;
  };
};

type SqsEvent = {
  Records: SqsRecord[];
};

async function startStepFunctionsExecution(input: {
  stateMachineArn: string;
  executionName: string;
  payload: unknown;
  messageId: string;
}): Promise<string> {
  const command = new StartExecutionCommand({
    stateMachineArn: input.stateMachineArn,
    name: input.executionName,
    input: JSON.stringify({
      payload: input.payload,
      messageId: input.messageId,
      receivedAt: Date.now(),
    }),
  });

  try {
    const response = await sfnClient.send(command);
    if (!response.executionArn) {
      throw new Error('StartExecution succeeded without returning executionArn');
    }
    return response.executionArn;
  } catch (error) {
    if (isExecutionAlreadyExistsError(error)) {
      return buildExecutionArn(input.stateMachineArn, input.executionName);
    }
    throw error;
  }
}

async function uploadInputPayload(
  message: ReturnType<typeof ProverWorkMessageSchema.parse>,
  context: Record<string, unknown>,
): Promise<string> {
  const payload = buildInputUploadPayload(message, proofPrefix);
  const startTime = Date.now();

  await s3Client.send(
    new PutObjectCommand({
      Bucket: proofBucketName,
      Key: payload.key,
      Body: payload.body,
      ContentType: payload.contentType,
      Metadata: payload.metadata,
    }),
  );

  emitMetric('InputUploadSuccess', 1, 'Count');
  emitMetric('InputUploadLatency', Date.now() - startTime, 'Milliseconds');
  log('INFO', 'upload_input', context, {
    message: 'Uploaded zkVM input payload to S3',
    bucket: proofBucketName,
    key: payload.key,
  });

  return payload.key;
}

function isExecutionAlreadyExistsError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === 'ExecutionAlreadyExists' ||
      error.name === 'ExecutionAlreadyExistsFault' ||
      /ExecutionAlreadyExists/.test(error.message))
  );
}

function isThrottleError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === 'ThrottlingException' ||
      error.name === 'TooManyRequestsException' ||
      /Rate exceeded/.test(error.message))
  );
}

function buildExecutionArn(stateMachine: string, executionName: string): string {
  const [prefix, machineName] = stateMachine.split(':stateMachine:');
  if (!prefix || !machineName) {
    throw new Error(`Invalid state machine ARN: ${stateMachine}`);
  }
  return `${prefix}:execution:${machineName}:${executionName}`;
}

function shouldRetryDispatchPreconditionFailure(code: DispatchPreconditionCode, record: SqsRecord): boolean {
  if (code !== 'SESSION_NOT_FOUND' && code !== 'FINALIZATION_STATE_MISSING') {
    return false;
  }

  const receiveCountRaw = record.attributes?.ApproximateReceiveCount;
  if (!receiveCountRaw) {
    return false;
  }

  const receiveCount = Number.parseInt(receiveCountRaw, 10);
  if (!Number.isFinite(receiveCount) || receiveCount < 1) {
    return false;
  }

  return receiveCount < 3;
}

function resolveProofBucketName(): string {
  return process.env.S3_PROOF_BUCKET ?? DEFAULT_PROOF_BUCKET;
}

function log(
  level: LogLevel,
  action: LogAction,
  context: Record<string, unknown>,
  extra?: Record<string, unknown>,
): void {
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    component: COMPONENT,
    environment: ENVIRONMENT_NAME,
    action,
    ...context,
    ...(extra ?? {}),
  };
  console.log(JSON.stringify(entry));
}

function emitMetric(name: string, value: number, unit: 'Count' | 'Milliseconds'): void {
  const timestamp = Date.now();
  console.log(
    JSON.stringify({
      _aws: {
        Timestamp: timestamp,
        CloudWatchMetrics: [
          {
            Namespace: METRIC_NAMESPACE,
            Dimensions: [['Environment']],
            Metrics: [{ Name: name, Unit: unit }],
          },
        ],
      },
      Environment: ENVIRONMENT_NAME,
      [name]: value,
    }),
  );
}
