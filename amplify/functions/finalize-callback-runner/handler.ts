import { z } from 'zod';
import { fromNodeProviderChain } from '@aws-sdk/credential-providers';
import type { SignatureV4 } from '@smithy/signature-v4';
import { restoreReceiptFromS3 } from '../../../src/lib/aws/bundle-restore.js';
import { createAppSyncSigner, signedAppSyncFetch } from '../../../src/lib/aws/appsyncSignedFetch.js';
import { resolveAppSyncRegion } from '../../../src/lib/aws/appsyncRegionResolver.js';
import { generateBundlePresignedUrl } from '../../../src/lib/aws/presigned-url.js';
import {
  classifyAuthoritativeWriteContract,
  isFailClosedCurrentArtifactState,
  resolveCurrentContractGeneration,
  resolveSessionFinalizationArtifactState,
} from '../../../src/lib/contract/index.js';
import {
  buildFinalizationResultFromJournal,
  canonicalizeFinalizationResult,
} from '../../../src/lib/finalize/finalization-result.js';
import {
  parseStoredFinalizationEnvelope,
  parseStoredFinalizationPayload,
  serializeStoredFinalizationPayload,
} from '../../../src/lib/store/amplify/finalization.js';
import type { ZkVMJournal } from '../../../src/lib/zkvm/types.js';
import { isSupportedZkVMJournal } from '../../../src/lib/zkvm/journal-guards.js';
import type { FinalizationState, FinalizationStoragePayload } from '../../../src/types/server.js';
import { getNumberProperty, getRecordProperty, getStringProperty, isRecord } from '../../../src/lib/utils/guards.js';

type CallbackStatus = 'SUCCEEDED' | 'FAILED' | 'TIMED_OUT';

const eventSchema = z.object({
  status: z.enum(['SUCCEEDED', 'FAILED', 'TIMED_OUT']),
  payload: z.object({
    sessionId: z.string().uuid(),
    executionId: z.string().min(1),
    contractGeneration: z.string().min(1),
    queuedAt: z.number(),
    expectedImageId: z.string().optional(),
  }),
  executionArn: z.string().optional(),
  proverResult: z.unknown().optional(),
  error: z.unknown().optional(),
});

const DEFAULT_PROOF_PREFIX = 'sessions/';

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
      throw new Error('AMPLIFY_DATA_ENDPOINT is required for finalize-callback-runner');
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

  getTtlSeconds(finalized: boolean): number {
    return finalized ? this.verificationTtlSeconds : this.ttlSeconds;
  }

  async fetchFinalizationPayload(sessionId: string): Promise<PersistedFinalizationSnapshot | null> {
    const response = await this.executeGraphQL(GET_SESSION_QUERY, { id: sessionId });
    const session = response.getVotingSession;
    if (!session) {
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

  async updateFinalization(
    sessionId: string,
    payload: FinalizationStoragePayload,
    options: { finalized: boolean },
  ): Promise<void> {
    const serialized = serializeStoredFinalizationPayload(payload);
    const now = Date.now();
    const ttl = Math.floor(now / 1000) + this.getTtlSeconds(options.finalized);

    await this.executeGraphQL(UPDATE_SESSION_MUTATION, {
      input: {
        id: sessionId,
        finalizationResultJson: serialized,
        finalizationArtifactState: null,
        finalized: options.finalized,
        lastActivity: new Date(now).toISOString(),
        ttl,
      },
    });
  }

  async persistArtifactTombstone(input: {
    sessionId: string;
    executionId: string;
    queuedAt: number;
    artifactState: 'unsupported_current_artifact' | 'corrupt_or_unreadable';
    carriedContractGeneration?: string | null;
    startedAt?: number;
    stepFunctionsArn?: string;
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
    const ttl = Math.floor(now / 1000) + this.getTtlSeconds(current.finalized);
    const updateInput: Record<string, unknown> = {
      id: input.sessionId,
      finalizationArtifactState: input.artifactState,
      lastActivity: new Date(now).toISOString(),
      ttl,
    };

    if (storedContractGeneration && nextState) {
      updateInput.finalizationResultJson = serializeStoredFinalizationPayload({
        contractGeneration: storedContractGeneration,
        finalizationResult: current.finalizationResult ?? null,
        finalizationState: nextState,
        finalizationScenarioContext: current.finalizationScenarioContext ?? null,
      });
    }

    await this.executeGraphQL(UPDATE_SESSION_MUTATION, { input: updateInput });

    return nextState ?? current.finalizationState ?? null;
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
      finalizationResultJson
      finalized
    }
  }
`;

const sessionClient = new AmplifySessionClient();

function normalizePrefix(prefix: string): string {
  const trimmed = prefix.trim().replace(/^\/+/, '');
  if (!trimmed) {
    return '';
  }
  return trimmed.endsWith('/') ? trimmed : `${trimmed}/`;
}

function resolveEpochMillis(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? undefined : parsed;
  }
  return undefined;
}

function resolveTimestampFromProverResult(result: unknown, field: string): number | undefined {
  if (!isRecord(result)) {
    return undefined;
  }
  const raw = getNumberProperty(result, field) ?? getStringProperty(result, field);
  return resolveEpochMillis(raw);
}

function resolveImageIdClaim(receiptRaw: unknown, receiptPayload: unknown): string {
  const fromRaw = isRecord(receiptRaw)
    ? (getStringProperty(receiptRaw, 'imageId') ?? getStringProperty(receiptRaw, 'image_id'))
    : undefined;
  const fromPayload = isRecord(receiptPayload)
    ? (getStringProperty(receiptPayload, 'imageId') ?? getStringProperty(receiptPayload, 'image_id'))
    : undefined;
  return fromRaw ?? fromPayload ?? '';
}

function extractJournal(candidate: unknown): ZkVMJournal | null {
  if (isSupportedZkVMJournal(candidate)) {
    return candidate;
  }
  if (isRecord(candidate)) {
    const nested = getRecordProperty(candidate, 'journal');
    if (isSupportedZkVMJournal(nested)) {
      return nested;
    }
  }
  return null;
}

function buildErrorDetails(
  status: CallbackStatus,
  rawError: unknown,
): { code: string; message: string; details?: unknown } {
  if (status === 'TIMED_OUT') {
    return { code: 'TIMED_OUT', message: 'Finalization timed out' };
  }
  if (isRecord(rawError)) {
    const code = getStringProperty(rawError, 'Error') ?? 'FINALIZATION_FAILED';
    const message = getStringProperty(rawError, 'Cause') ?? 'Finalization failed';
    return { code, message, details: rawError };
  }
  return { code: 'FINALIZATION_FAILED', message: 'Finalization failed', details: rawError };
}

export const handler = async (
  rawEvent: unknown,
): Promise<{ status: string; sessionId: string; executionId: string }> => {
  const event = eventSchema.parse(rawEvent);
  const { status, payload } = event;

  const sessionId = payload.sessionId;
  const executionId = payload.executionId;
  const queuedAt = payload.queuedAt;

  const existing = await sessionClient.fetchFinalizationPayload(sessionId);
  const artifactState = resolveSnapshotArtifactState(existing);
  if (artifactState) {
    await sessionClient.persistArtifactTombstone({
      sessionId,
      executionId,
      queuedAt,
      artifactState,
      carriedContractGeneration: payload.contractGeneration,
      stepFunctionsArn: event.executionArn,
    });
    return { status: 'ok', sessionId, executionId };
  }

  if (existing?.executionId && existing.executionId !== executionId) {
    return { status: 'ignored', sessionId, executionId };
  }

  if (
    classifyAuthoritativeWriteContract({
      persistedContractGeneration: existing ? resolveStoredContractGeneration(existing) : undefined,
      carriedContractGeneration: payload.contractGeneration,
    }) !== 'supported'
  ) {
    await sessionClient.persistArtifactTombstone({
      sessionId,
      executionId,
      queuedAt,
      artifactState: 'unsupported_current_artifact',
      carriedContractGeneration: payload.contractGeneration,
      stepFunctionsArn: event.executionArn,
    });
    return { status: 'ok', sessionId, executionId };
  }

  if (existing?.finalizationState?.status === 'succeeded' && status === 'SUCCEEDED') {
    return { status: 'ok', sessionId, executionId };
  }

  const stepFunctionsArn = event.executionArn;
  const startedAt = resolveTimestampFromProverResult(event.proverResult, 'StartedAt') ?? queuedAt;
  const storedContractGeneration = existing ? resolveStoredContractGeneration(existing) : undefined;
  if (!storedContractGeneration) {
    return { status: 'ignored', sessionId, executionId };
  }

  try {
    if (status === 'SUCCEEDED') {
      const prefix = normalizePrefix(process.env.S3_PROOF_PREFIX ?? DEFAULT_PROOF_PREFIX);
      const s3BundleKey = `${prefix}${sessionId}/${executionId}/bundle.zip`;

      const presigned = await generateBundlePresignedUrl(sessionId, executionId);
      const bundleMetadata = {
        s3BundleKey,
        s3BundleUrl: presigned.success ? presigned.url : undefined,
        s3BundleExpiresAt: presigned.success ? presigned.expiresAt : undefined,
        s3UploadedAt: new Date().toISOString(),
      };

      const restored = await restoreReceiptFromS3(s3BundleKey);
      const journal = extractJournal(restored.journal);
      if (!journal) {
        throw new Error('Failed to parse zkVM journal from bundle');
      }

      const imageId = resolveImageIdClaim(restored.receiptRaw, restored.receipt);
      const resultFromJournal = buildFinalizationResultFromJournal({
        journal,
        imageId,
        verificationExecutionId: executionId,
        bundleMetadata,
        scenarioContext: existing?.finalizationScenarioContext ?? null,
        electionManifest: restored.electionManifest,
        closeStatement: restored.closeStatement,
      });
      if (restored.publicInputArtifact) {
        resultFromJournal.publicInputArtifact = restored.publicInputArtifact;
      }
      if (restored.includedBitmapArtifact) {
        resultFromJournal.bitmapData = {
          includedBitmap: [...restored.includedBitmapArtifact.includedBitmap],
          includedBitmapRoot: restored.includedBitmapArtifact.includedBitmapRoot,
          ...(restored.seenBitmapArtifact
            ? {
                seenBitmap: [...restored.seenBitmapArtifact.seenBitmap],
                seenBitmapRoot: restored.seenBitmapArtifact.seenBitmapRoot,
              }
            : {}),
          treeSize: restored.includedBitmapArtifact.treeSize,
          finalizedAt: Date.now(),
        };
        resultFromJournal.bitmapProofSource = 'real';
      } else {
        console.warn('[Finalize Callback] Exact included bitmap artifact unavailable; proof disabled', {
          sessionId,
          executionId,
        });
      }
      const finalizationResult = canonicalizeFinalizationResult(
        resultFromJournal,
        existing?.finalizationScenarioContext ?? null,
      );
      if (!finalizationResult) {
        await sessionClient.persistArtifactTombstone({
          sessionId,
          executionId,
          queuedAt,
          artifactState: 'corrupt_or_unreadable',
          carriedContractGeneration: payload.contractGeneration,
          startedAt,
          stepFunctionsArn,
        });
        return { status: 'ok', sessionId, executionId };
      }

      const completedAt =
        resolveTimestampFromProverResult(event.proverResult, 'ExecutionStoppedAt') ??
        resolveTimestampFromProverResult(event.proverResult, 'StoppedAt') ??
        Date.now();

      const finalizationState: FinalizationState = {
        status: 'succeeded',
        executionId,
        queuedAt,
        startedAt,
        completedAt,
        stepFunctionsArn,
        bundleMetadata,
      };

      await sessionClient.updateFinalization(
        sessionId,
        {
          contractGeneration: storedContractGeneration,
          finalizationResult,
          finalizationState,
          finalizationScenarioContext: existing?.finalizationScenarioContext ?? null,
        },
        { finalized: true },
      );

      return { status: 'ok', sessionId, executionId };
    }

    const errorDetails = buildErrorDetails(status, event.error);
    const failedAt = Date.now();

    const finalizationState: FinalizationState =
      status === 'TIMED_OUT'
        ? {
            status: 'timeout',
            executionId,
            queuedAt,
            startedAt,
            timeoutAt: failedAt,
            stepFunctionsArn,
          }
        : {
            status: 'failed',
            executionId,
            queuedAt,
            startedAt,
            failedAt,
            error: errorDetails,
            stepFunctionsArn,
          };

    await sessionClient.updateFinalization(
      sessionId,
      {
        contractGeneration: storedContractGeneration,
        finalizationResult: existing?.finalizationResult ?? null,
        finalizationState,
        finalizationScenarioContext: existing?.finalizationScenarioContext ?? null,
      },
      { finalized: false },
    );

    return { status: 'ok', sessionId, executionId };
  } catch (error) {
    const failedAt = Date.now();
    const errorDetails = {
      code: 'CALLBACK_FAILED',
      message: error instanceof Error ? error.message : 'Callback failed',
      details: error,
    };

    const finalizationState: FinalizationState = {
      status: 'failed',
      executionId,
      queuedAt,
      startedAt,
      failedAt,
      error: errorDetails,
      stepFunctionsArn,
    };

    await sessionClient.updateFinalization(
      sessionId,
      {
        contractGeneration: storedContractGeneration,
        finalizationResult: existing?.finalizationResult ?? null,
        finalizationState,
        finalizationScenarioContext: existing?.finalizationScenarioContext ?? null,
      },
      { finalized: false },
    );

    return { status: 'error', sessionId, executionId };
  }
};
