import path from 'node:path';
import { promises as fs } from 'node:fs';
import { s, type Infer, type Schema } from '@stark-ballot/validation/schema';
import { downloadFromS3 } from '@stark-ballot/aws-adapters/aws/s3-download';
import { validateAsyncProverBundleKey } from '@stark-ballot/aws-adapters/finalize/async-prover-artifacts';
import { getGlobalStore } from '@stark-ballot/aws-adapters/store/storeInstance';
import { parseVerificationWorkMessage } from '@stark-ballot/aws-adapters/sqs/verificationWorkMessage';
import { extractZipFromBuffer } from '@stark-ballot/node-adapters/zip';
import { inspectVerificationBundleArchiveBuffer } from '@stark-ballot/node-adapters/verification-bundle';
import { invokeVerifierService } from '@stark-ballot/node-adapters/verifier-service-client';
import type { VerificationWorkerResponse } from '@stark-ballot/aws-adapters/lambda/verification-worker-contract';
import { ensureAwsRuntimeConfigReferencesLoaded } from '@stark-ballot/aws-adapters/config/awsRuntimeConfigReferenceResolver';
import { validateEnv } from '@stark-ballot/runtime-config/env/validate';
import { validateTargetObservabilityEnv } from '@stark-ballot/runtime-config/env/observability';
import {
  resolveRuntimeProfile,
  type ResolvedRuntimeProfile,
  validateRuntimeProfileSelection,
} from '@stark-ballot/runtime-config/env/runtimeProfile';
import { logger } from '@stark-ballot/diagnostics/logger';
import { hashKeyPrefixForLogging, hashSessionIdForLogging } from '@stark-ballot/diagnostics/logging';
import { SAFE_VERIFIER_SEGMENT_PATTERN } from '@stark-ballot/validation/safe-verifier-segment';
import { resolvePublicBundlePolicy } from '@stark-ballot/verification/public-bundle-manifest';
import type {
  VerificationFailureCategory,
  VerificationResult,
  VerificationStatus,
} from '@stark-ballot/verification/shared/types';
import { addHexPrefix, isValidHexString, normalizeHexString } from '@stark-ballot/crypto-primitives';
import { omitUndefinedProperties } from '@stark-ballot/validation/definedProperties';
import type { SessionId } from '@stark-ballot/domain/types/identifiers';
import type { FinalizationId } from '@stark-ballot/application/finalize/finalization-types';
import { uploadVerificationBundleToS3 } from './verificationBundleS3Upload.js';
import { RuntimeConfigValidationError, bootstrapLambdaRuntime } from '../runtimeBootstrap.js';

const INVALID_PAYLOAD_DETAILS = 'Invalid verifier invocation payload';
const VERIFIER_EXECUTION_FAILURE_DETAILS = 'Verifier service execution failed';
const MAX_VERIFIER_STDERR_DIAGNOSTIC_BYTES = 4 * 1024;
const VERIFIER_STDERR_DIAGNOSTIC_CATEGORIES = new Set(['none', 'present', 'truncated']);
const ASYNC_PUBLIC_BUNDLE_POLICY = resolvePublicBundlePolicy('async');
let resolvedRuntimeProfile: ResolvedRuntimeProfile | undefined;
type InfrastructureVerificationFailureCategory = Exclude<VerificationFailureCategory, 'none'>;

class VerificationInfrastructureError extends Error {
  readonly failureCategory: InfrastructureVerificationFailureCategory;

  constructor(failureCategory: InfrastructureVerificationFailureCategory) {
    super('Verification infrastructure stage failed');
    this.name = 'VerificationInfrastructureError';
    this.failureCategory = failureCategory;
  }
}

function readErrorIdentity(error: unknown): ReadonlySet<string> {
  if (typeof error !== 'object' || error === null) {
    return new Set();
  }
  const candidate = error as { name?: unknown; code?: unknown };
  return new Set([candidate.name, candidate.code].filter((value): value is string => typeof value === 'string'));
}

function classifyS3Failure(error: unknown): InfrastructureVerificationFailureCategory {
  const identities = readErrorIdentity(error);
  if (identities.has('AccessDenied') || identities.has('Forbidden')) {
    return 's3_denied';
  }
  if (identities.has('NoSuchKey') || identities.has('NotFound')) {
    return 's3_missing';
  }
  if (
    identities.has('TimeoutError') ||
    identities.has('RequestTimeout') ||
    identities.has('RequestTimeoutException') ||
    identities.has('ETIMEDOUT')
  ) {
    return 'timeout';
  }
  return 'unknown';
}

function classifyVerifierFailure(error: unknown): InfrastructureVerificationFailureCategory {
  const identities = readErrorIdentity(error);
  if (
    identities.has('TimeoutError') ||
    identities.has('AbortError') ||
    identities.has('RequestTimeout') ||
    identities.has('ETIMEDOUT') ||
    identities.has('ERR_CHILD_PROCESS_TIMEOUT')
  ) {
    return 'timeout';
  }
  return 'verifier_crash';
}

function infrastructureFailure(
  failureCategory: InfrastructureVerificationFailureCategory,
): VerificationInfrastructureError {
  return new VerificationInfrastructureError(failureCategory);
}

function resolveInfrastructureFailureCategory(error: unknown): InfrastructureVerificationFailureCategory {
  return error instanceof VerificationInfrastructureError ? error.failureCategory : 'unknown';
}

function readOwnDataProperty(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }

  try {
    return Object.getOwnPropertyDescriptor(value, key)?.value;
  } catch {
    return undefined;
  }
}

function emitVerifierServiceDiagnostics(
  input: Pick<HandlerEvent, 'sessionId' | 'finalizationId'>,
  diagnostics: unknown,
): void {
  const category = readOwnDataProperty(diagnostics, 'stderrCategory');
  const bytes = readOwnDataProperty(diagnostics, 'stderrBytes');
  const truncated = readOwnDataProperty(diagnostics, 'stderrTruncated');
  const valid =
    typeof category === 'string' &&
    VERIFIER_STDERR_DIAGNOSTIC_CATEGORIES.has(category) &&
    typeof bytes === 'number' &&
    Number.isInteger(bytes) &&
    bytes >= 0 &&
    bytes <= MAX_VERIFIER_STDERR_DIAGNOSTIC_BYTES &&
    typeof truncated === 'boolean';

  logger.info('[VerificationWorker] verifier-service diagnostics', {
    event: 'verifier_service_diagnostic',
    session_id_hash: hashSessionIdForLogging(input.sessionId),
    finalization_id: input.finalizationId,
    stderr_category: valid ? category : 'none',
    stderr_bytes: valid ? bytes : 0,
    stderr_truncated: valid ? truncated : false,
  });
}

type SqsEvent = {
  Records: unknown[];
};

type SqsRecord = {
  messageId?: string;
  body?: string;
  attributes?: {
    ApproximateReceiveCount?: string;
  };
};

type SqsBatchResponse = {
  status?: never;
  batchItemFailures: Array<{ itemIdentifier: string }>;
};

interface RunVerificationPayloadOptions {
  retryInfrastructureErrors?: boolean;
}

type VerificationWorkDisposition = 'process' | 'duplicate_terminal' | 'stale_finalization';

const VERIFICATION_WORK_MAX_RECEIVE_COUNT = 3;

function hexStringSchema(bytes: number, label: string): Schema<string> {
  return s
    .string({ required_error: `${label} is required` })
    .min(1, `${label} must not be empty`)
    .transform((value) => addHexPrefix(normalizeHexString(value)))
    .superRefine((value, ctx) => {
      if (!isValidHexString(value, bytes)) {
        ctx.addIssue({
          message: `${label} must be a ${bytes * 2}-character hex string`,
        });
      }
    });
}

const runnerOptionsSchema = s
  .object({
    uploadToS3: s.boolean().optional(),
    workDir: s.string().min(1).optional(),
  })
  .strict()
  .optional();

const s3BundleSchema = s
  .object({
    mode: s.literal('s3_bundle'),
    sessionId: s.string().uuid().regex(SAFE_VERIFIER_SEGMENT_PATTERN),
    finalizationId: s.string().regex(SAFE_VERIFIER_SEGMENT_PATTERN),
    bundleKey: s.string().min(1),
    expectedImageId: hexStringSchema(32, 'expectedImageId'),
    options: runnerOptionsSchema,
  })
  .strict();

type HandlerEvent = Infer<typeof s3BundleSchema>;
const eventSchema = s3BundleSchema;

function rejectUnsafeTargetOptions(
  profile: ResolvedRuntimeProfile,
  input: HandlerEvent,
): VerificationWorkerResponse | null {
  if (profile.target.kind !== 'aws') {
    return null;
  }

  if (input.options?.workDir) {
    return {
      status: 'error',
      message: 'Invalid verifier invocation payload',
      details: 'workDir is not allowed by the target AWS runtime profile',
    };
  }

  if (input.options?.uploadToS3 === false) {
    return {
      status: 'error',
      message: 'Invalid verifier invocation payload',
      details: 'uploadToS3=false is not allowed by the target AWS runtime profile',
    };
  }

  return null;
}

async function runVerificationPayload(
  profile: ResolvedRuntimeProfile,
  input: HandlerEvent,
  options: RunVerificationPayloadOptions = {},
): Promise<VerificationWorkerResponse> {
  const unsafeOptions = rejectUnsafeTargetOptions(profile, input);
  if (unsafeOptions) {
    return unsafeOptions;
  }

  const workDir = input.options?.workDir ?? path.join('/tmp', 'verifier-work');
  process.env['VERIFIER_WORK_DIR'] = workDir;

  try {
    let bundleKey: string;
    try {
      bundleKey = validateAsyncProverBundleKey(profile, input.sessionId, input.finalizationId, input.bundleKey);
    } catch {
      throw infrastructureFailure('corrupt_bundle');
    }
    const bundlePath = path.join(workDir, input.sessionId, input.finalizationId);
    try {
      await fs.mkdir(bundlePath, { recursive: true });
    } catch {
      throw infrastructureFailure('unknown');
    }

    let zipBuffer: Buffer;
    try {
      zipBuffer = await downloadFromS3(profile, bundleKey);
    } catch (error) {
      throw infrastructureFailure(classifyS3Failure(error));
    }
    try {
      await inspectVerificationBundleArchiveBuffer(zipBuffer, ASYNC_PUBLIC_BUNDLE_POLICY);
      await extractZipFromBuffer(zipBuffer, { destination: bundlePath });
    } catch {
      throw infrastructureFailure('corrupt_bundle');
    }

    const reportPath = path.join(bundlePath, 'verification.json');
    let invocation: Awaited<ReturnType<typeof invokeVerifierService>>;
    try {
      invocation = await invokeVerifierService({
        bundlePath,
        expectedImageId: input.expectedImageId,
        reportPath,
      });
    } catch (error) {
      emitVerifierServiceDiagnostics(input, readOwnDataProperty(error, 'diagnostics'));
      throw infrastructureFailure(classifyVerifierFailure(error));
    }
    emitVerifierServiceDiagnostics(input, invocation.diagnostics);

    let s3Result: Awaited<ReturnType<typeof uploadVerificationBundleToS3>> | undefined;
    if (input.options?.uploadToS3 ?? true) {
      try {
        s3Result = await uploadVerificationBundleToS3(profile, bundlePath, input.sessionId, input.finalizationId);
      } catch (error) {
        throw infrastructureFailure(classifyS3Failure(error));
      }
    }

    const commonResponse = {
      status: 'success' as const,
      sessionId: input.sessionId,
      finalizationId: input.finalizationId,
      ...(s3Result
        ? {
            s3: omitUndefinedProperties({
              bundleKey: s3Result.s3BundleKey,
              reportKey: s3Result.s3ReportKey,
              uploadedAtMs: s3Result.s3UploadedAtMs,
            }),
          }
        : {}),
    };
    switch (invocation.status) {
      case 'success':
        return { ...commonResponse, verifierStatus: 'success', verificationReport: invocation.report };
      case 'dev_mode':
        return { ...commonResponse, verifierStatus: 'dev_mode', verificationReport: invocation.report };
      case 'failed':
        return { ...commonResponse, verifierStatus: 'failed', verificationReport: invocation.report };
      default:
        throw new Error('Verifier service returned an unsupported status');
    }
  } catch (error) {
    logger.error(
      '[VerificationWorker] Verifier service execution failed',
      {
        session_id_hash: hashSessionIdForLogging(input.sessionId),
        finalizationId: input.finalizationId,
        bundle_key_prefix: hashKeyPrefixForLogging(input.bundleKey),
        failure_category: resolveInfrastructureFailureCategory(error),
      },
      error,
    );
    if (options.retryInfrastructureErrors) {
      throw error;
    }
    return {
      status: 'error',
      message: 'verifier-service execution failed',
      details: VERIFIER_EXECUTION_FAILURE_DETAILS,
    };
  } finally {
    try {
      await fs.rm(workDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors after the invocation result is already determined.
    }
  }
}

function hasSqsRecordsField(value: unknown): boolean {
  return typeof value === 'object' && value !== null && Object.prototype.hasOwnProperty.call(value, 'Records');
}

function isSqsEvent(value: unknown): value is SqsEvent {
  return typeof value === 'object' && value !== null && Array.isArray((value as { Records?: unknown }).Records);
}

function isSqsRecord(value: unknown): value is SqsRecord {
  return typeof value === 'object' && value !== null && typeof (value as { body?: unknown }).body === 'string';
}

function logInvalidSqsInvocation(reason: 'event_shape_invalid' | 'record_body_invalid'): void {
  logger.warn('Invocation payload is invalid', {
    event: 'invocation_invalid',
    source_kind: 'sqs',
    reason,
  });
}

function validateVerificationWorkerConfig(profile: ResolvedRuntimeProfile): void {
  if (profile.name !== 'target-aws-async') {
    throw new RuntimeConfigValidationError(
      ['RUNTIME_PROFILE'],
      undefined,
      'RUNTIME_PROFILE=target-aws-async is required for verification worker execution',
    );
  }
}

function isTerminalVerificationStatus(status: VerificationStatus | undefined): boolean {
  return status === 'success' || status === 'failed' || status === 'dev_mode';
}

function parseApproximateReceiveCount(record: SqsRecord): number {
  const rawValue = record.attributes?.ApproximateReceiveCount;
  if (!rawValue) {
    return 1;
  }
  const parsed = Number.parseInt(rawValue, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 1;
}

async function persistTerminalFailureAfterRetryExhaustion(
  store: ReturnType<typeof getGlobalStore>,
  message: {
    sessionId: SessionId;
    finalizationId: FinalizationId;
  },
  failureCategory: InfrastructureVerificationFailureCategory,
): Promise<void> {
  await store.completeVerificationResult(message.sessionId, message.finalizationId, {
    status: 'failed',
    failureCategory,
  });
}

async function resolveVerificationWorkDisposition(
  store: ReturnType<typeof getGlobalStore>,
  sessionId: SessionId,
  finalizationId: FinalizationId,
): Promise<VerificationWorkDisposition> {
  const currentFinalization = await store.getCurrentFinalizationRecord(sessionId);
  if (!currentFinalization) {
    return 'process';
  }
  if (currentFinalization.finalizationId !== finalizationId) {
    return 'stale_finalization';
  }
  const verificationRecord = await store.getVerificationResultRecord(sessionId, finalizationId);
  if (isTerminalVerificationStatus(verificationRecord?.verificationResult.status)) {
    return 'duplicate_terminal';
  }
  return 'process';
}

async function handleSqsEvent(profile: ResolvedRuntimeProfile, rawEvent: SqsEvent): Promise<SqsBatchResponse> {
  const batchItemFailures: Array<{ itemIdentifier: string }> = [];
  const processedWorkKeys = new Set<string>();
  const store = getGlobalStore(profile);

  for (const rawRecord of rawEvent.Records) {
    if (!isSqsRecord(rawRecord)) {
      logInvalidSqsInvocation('record_body_invalid');
      throw new Error('Invalid SQS invocation');
    }
    const record = rawRecord;
    const itemIdentifier = record.messageId ?? '';
    let parsedMessage: ReturnType<typeof parseVerificationWorkMessage>;
    try {
      parsedMessage = parseVerificationWorkMessage(JSON.parse(record.body ?? '{}'));
    } catch {
      logInvalidSqsInvocation('record_body_invalid');
      if (itemIdentifier) {
        batchItemFailures.push({ itemIdentifier });
        continue;
      }
      throw new Error('Invalid SQS invocation');
    }

    try {
      const message = parsedMessage;
      const workKey = `${message.sessionId}/${message.finalizationId}`;
      if (processedWorkKeys.has(workKey)) {
        continue;
      }
      processedWorkKeys.add(workKey);
      const disposition = await resolveVerificationWorkDisposition(store, message.sessionId, message.finalizationId);
      if (disposition !== 'process') {
        logger.info('[VerificationWorker] Skipping idempotent SQS verification work', {
          session_id_hash: hashSessionIdForLogging(message.sessionId),
          finalizationId: message.finalizationId,
          disposition,
        });
        continue;
      }
      const response = await runVerificationPayload(
        profile,
        {
          mode: 's3_bundle',
          sessionId: message.sessionId,
          finalizationId: message.finalizationId,
          bundleKey: message.bundleKey,
          expectedImageId: message.expectedImageId,
        },
        {
          retryInfrastructureErrors: true,
        },
      );

      if (response.status !== 'success') {
        await store.completeVerificationResult(message.sessionId, message.finalizationId, {
          status: 'failed',
          failureCategory: 'unknown',
        });
        continue;
      }

      await store.recordAwsVerificationDeliveryMetadata(message.sessionId, message.finalizationId, {
        s3BundleKey: response.s3?.bundleKey ?? message.bundleKey,
        ...(response.s3?.reportKey ? { s3ReportKey: response.s3.reportKey } : {}),
        ...(response.s3?.uploadedAtMs ? { s3UploadedAtMs: response.s3.uploadedAtMs } : {}),
      });
      let completedVerificationResult: VerificationResult;
      switch (response.verifierStatus) {
        case 'success':
          completedVerificationResult = {
            status: 'success',
            report: response.verificationReport,
            failureCategory: 'none',
          };
          break;
        case 'dev_mode':
          completedVerificationResult = {
            status: 'dev_mode',
            report: response.verificationReport,
            failureCategory: 'none',
          };
          break;
        case 'failed':
          completedVerificationResult = { status: 'failed', report: response.verificationReport };
          break;
      }
      await store.completeVerificationResult(message.sessionId, message.finalizationId, completedVerificationResult);
    } catch (error) {
      logger.error('[VerificationWorker] SQS verification work failed', { itemIdentifier }, error);
      if (parseApproximateReceiveCount(record) >= VERIFICATION_WORK_MAX_RECEIVE_COUNT) {
        try {
          await persistTerminalFailureAfterRetryExhaustion(
            store,
            parsedMessage,
            resolveInfrastructureFailureCategory(error),
          );
        } catch (persistenceError) {
          logger.error(
            '[VerificationWorker] Failed to persist terminal verification failure after retry exhaustion',
            {
              itemIdentifier,
              session_id_hash: hashSessionIdForLogging(parsedMessage.sessionId),
              finalizationId: parsedMessage.finalizationId,
            },
            persistenceError,
          );
        }
      }
      if (itemIdentifier) {
        batchItemFailures.push({ itemIdentifier });
      }
    }
  }

  return { batchItemFailures };
}

export const handler = async (rawEvent: unknown): Promise<VerificationWorkerResponse | SqsBatchResponse> => {
  const env = process.env;
  const runtimeProfile = (resolvedRuntimeProfile ??= resolveRuntimeProfile(env));
  await bootstrapLambdaRuntime({
    serviceName: 'verification-worker',
    runtimeProfile,
    resolveRuntimeReferences: async (invalidNameCollector) => {
      await ensureAwsRuntimeConfigReferencesLoaded('verification_worker', {
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
        validate: () => validateVerificationWorkerConfig(runtimeProfile),
      },
      {
        validate: () => validateEnv(runtimeProfile, env),
      },
    ],
    env,
  });

  if (isSqsEvent(rawEvent)) {
    return await handleSqsEvent(runtimeProfile, rawEvent);
  }
  if (hasSqsRecordsField(rawEvent)) {
    logInvalidSqsInvocation('event_shape_invalid');
    throw new Error('Invalid SQS invocation');
  }

  let input: HandlerEvent;

  try {
    input = eventSchema.parse(rawEvent);
  } catch (error) {
    logger.error('[VerificationWorker] Invalid invocation payload', error);
    return {
      status: 'error',
      message: 'Invalid verifier invocation payload',
      details: INVALID_PAYLOAD_DETAILS,
    };
  }

  return await runVerificationPayload(runtimeProfile, input);
};

export type { HandlerEvent };
