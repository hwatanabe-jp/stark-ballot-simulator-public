import path from 'node:path';
import { promises as fs } from 'node:fs';
import { s, type Schema } from '@stark-ballot/validation/schema';
import { downloadFromS3 } from '@stark-ballot/aws-adapters/aws/s3-download';
import { validateAsyncProverBundleKey } from '@stark-ballot/aws-adapters/finalize/async-prover-artifacts';
import { getGlobalStore } from '@stark-ballot/aws-adapters/store/storeInstance';
import { parseAwsPersistedFinalizationResult } from '@stark-ballot/aws-adapters/finalize/finalizationPersistenceEnvelope';
import { parseVerificationWorkMessage } from '@stark-ballot/aws-adapters/sqs/verificationWorkMessage';
import { extractZipFromBuffer } from '@stark-ballot/node-adapters/zip';
import { invokeVerifierService } from '@stark-ballot/node-adapters/verifier-service-client';
import type { VerificationWorkerResponse } from '@stark-ballot/aws-adapters/lambda/verification-worker-contract';
import { ensureAwsRuntimeConfigReferencesLoaded } from '@stark-ballot/aws-adapters/config/awsRuntimeConfigReferenceResolver';
import { validateEnv } from '@stark-ballot/runtime-config/env/validate';
import { validateTargetObservabilityEnv } from '@stark-ballot/runtime-config/env/observability';
import { isTargetAwsRuntime } from '@stark-ballot/runtime-config/env/targetRuntime';
import { logger } from '@stark-ballot/diagnostics/logger';
import { hashKeyPrefixForLogging, hashSessionIdForLogging } from '@stark-ballot/diagnostics/logging';
import { SAFE_VERIFIER_SEGMENT_PATTERN } from '@stark-ballot/validation/safe-verifier-segment';
import type { VerificationFailureCategory, VerificationStatus } from '@stark-ballot/verification/shared/types';
import { addHexPrefix, isValidHexString, normalizeHexString } from '@stark-ballot/domain/utils/hex';
import { omitUndefinedProperties } from '@stark-ballot/validation/definedProperties';
import { uploadVerificationBundleToS3 } from './verificationBundleS3Upload.js';
import { RuntimeConfigValidationError, bootstrapLambdaRuntime, type RuntimeConfigName } from '../runtimeBootstrap.js';

const INVALID_PAYLOAD_DETAILS = 'Invalid verifier invocation payload';
const VERIFIER_EXECUTION_FAILURE_DETAILS = 'Verifier service execution failed';
const MAX_VERIFIER_STDERR_DIAGNOSTIC_BYTES = 4 * 1024;
const VERIFIER_STDERR_DIAGNOSTIC_CATEGORIES = new Set(['none', 'present', 'truncated']);

class VerificationInfrastructureError extends Error {
  readonly failureCategory: VerificationFailureCategory;

  constructor(failureCategory: VerificationFailureCategory) {
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

function classifyS3Failure(error: unknown): VerificationFailureCategory {
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

function classifyVerifierFailure(error: unknown): VerificationFailureCategory {
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

function infrastructureFailure(failureCategory: VerificationFailureCategory): VerificationInfrastructureError {
  return new VerificationInfrastructureError(failureCategory);
}

function resolveInfrastructureFailureCategory(error: unknown): VerificationFailureCategory {
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
  input: Pick<HandlerEvent, 'sessionId' | 'executionId'>,
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
    execution_id: input.executionId,
    stderr_category: valid ? category : 'none',
    stderr_bytes: valid ? bytes : 0,
    stderr_truncated: valid ? truncated : false,
  });
}

type HandlerEvent = {
  mode: 's3_bundle';
  sessionId: string;
  executionId: string;
  bundleKey: string;
  expectedImageId: string;
  options?: {
    uploadToS3?: boolean;
    workDir?: string;
  };
};

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

type VerificationWorkDisposition = 'process' | 'duplicate_terminal' | 'stale_execution';

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
    executionId: s.string().regex(SAFE_VERIFIER_SEGMENT_PATTERN),
    bundleKey: s.string().min(1),
    expectedImageId: hexStringSchema(32, 'expectedImageId'),
    options: runnerOptionsSchema,
  })
  .strict();

const eventSchema: Schema<HandlerEvent> = s.typed(s3BundleSchema);

function rejectUnsafeTargetOptions(input: HandlerEvent): VerificationWorkerResponse | null {
  if (!isTargetAwsRuntime()) {
    return null;
  }

  if (input.options?.workDir) {
    return {
      status: 'error',
      message: 'Invalid verifier invocation payload',
      details: 'workDir is not allowed when TARGET_AWS_RUNTIME=1',
    };
  }

  if (input.options?.uploadToS3 === false) {
    return {
      status: 'error',
      message: 'Invalid verifier invocation payload',
      details: 'uploadToS3=false is not allowed when TARGET_AWS_RUNTIME=1',
    };
  }

  return null;
}

async function runVerificationPayload(
  input: HandlerEvent,
  options: RunVerificationPayloadOptions = {},
): Promise<VerificationWorkerResponse> {
  const unsafeOptions = rejectUnsafeTargetOptions(input);
  if (unsafeOptions) {
    return unsafeOptions;
  }

  const workDir = input.options?.workDir ?? path.join('/tmp', 'verifier-work');
  process.env['VERIFIER_WORK_DIR'] = workDir;

  try {
    let bundleKey: string;
    try {
      bundleKey = validateAsyncProverBundleKey(input.sessionId, input.executionId, input.bundleKey);
    } catch {
      throw infrastructureFailure('corrupt_bundle');
    }
    const bundlePath = path.join(workDir, input.sessionId, input.executionId);
    try {
      await fs.mkdir(bundlePath, { recursive: true });
    } catch {
      throw infrastructureFailure('unknown');
    }

    let zipBuffer: Buffer;
    try {
      zipBuffer = await downloadFromS3(bundleKey);
    } catch (error) {
      throw infrastructureFailure(classifyS3Failure(error));
    }
    try {
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
        s3Result = await uploadVerificationBundleToS3(bundlePath, input.sessionId, input.executionId);
      } catch (error) {
        throw infrastructureFailure(classifyS3Failure(error));
      }
    }

    return {
      status: 'success',
      sessionId: input.sessionId,
      executionId: input.executionId,
      verifierStatus: invocation.status,
      verificationReport: invocation.report,
      ...(s3Result
        ? {
            s3: omitUndefinedProperties({
              bundleKey: s3Result.s3BundleKey,
              reportKey: s3Result.s3ReportKey,
              uploadedAt: s3Result.s3UploadedAt,
            }),
          }
        : {}),
    };
  } catch (error) {
    logger.error(
      '[VerificationWorker] Verifier service execution failed',
      {
        session_id_hash: hashSessionIdForLogging(input.sessionId),
        executionId: input.executionId,
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

function validateVerificationWorkerConfig(): void {
  const invalidNames: RuntimeConfigName[] = [];
  const requireValue = (name: RuntimeConfigName): string | undefined => {
    const value = process.env[name]?.trim();
    if (!value) invalidNames.push(name);
    return value;
  };

  if (process.env['TARGET_AWS_RUNTIME'] !== '1') invalidNames.push('TARGET_AWS_RUNTIME');
  if (process.env['USE_MOCK_STORE'] !== 'false') invalidNames.push('USE_MOCK_STORE');
  if (process.env['USE_S3'] !== 'true') invalidNames.push('USE_S3');
  const accountId = requireValue('AWS_ACCOUNT_ID');
  if (accountId && !/^[0-9]{12}$/.test(accountId)) invalidNames.push('AWS_ACCOUNT_ID');
  if (!process.env['AWS_REGION']?.trim() && !process.env['AWS_DEFAULT_REGION']?.trim()) {
    invalidNames.push('AWS_REGION');
  }
  requireValue('DYNAMODB_SESSIONS_TABLE');
  requireValue('DYNAMODB_VOTES_TABLE');
  requireValue('S3_PROOF_BUCKET');
  requireValue('S3_PROOF_PREFIX');
  for (const [name, invalid] of [
    ['USE_MOCK_ZKVM', process.env['USE_MOCK_ZKVM'] === 'true'],
    ['RISC0_DEV_MODE', process.env['RISC0_DEV_MODE'] === '1'],
    ['FORCE_DEV_MODE', process.env['FORCE_DEV_MODE'] === '1' || process.env['FORCE_DEV_MODE'] === 'true'],
    [
      'ALLOW_INSECURE_ZKVM',
      process.env['ALLOW_INSECURE_ZKVM'] === '1' || process.env['ALLOW_INSECURE_ZKVM'] === 'true',
    ],
    [
      'ALLOW_DEV_MODE_VERIFICATION',
      process.env['ALLOW_DEV_MODE_VERIFICATION'] === '1' || process.env['ALLOW_DEV_MODE_VERIFICATION'] === 'true',
    ],
  ] as const satisfies ReadonlyArray<readonly [RuntimeConfigName, boolean]>) {
    if (invalid) {
      invalidNames.push(name);
    }
  }

  if (invalidNames.length > 0) {
    const primaryName = invalidNames[0];
    const messages: Partial<Record<RuntimeConfigName, string>> = {
      USE_MOCK_ZKVM: 'USE_MOCK_ZKVM=true is not allowed when TARGET_AWS_RUNTIME=1.',
      RISC0_DEV_MODE: 'RISC0_DEV_MODE=1 is not allowed when TARGET_AWS_RUNTIME=1.',
      FORCE_DEV_MODE: 'FORCE_DEV_MODE is not allowed when TARGET_AWS_RUNTIME=1.',
      ALLOW_INSECURE_ZKVM: 'ALLOW_INSECURE_ZKVM is not allowed when TARGET_AWS_RUNTIME=1.',
      ALLOW_DEV_MODE_VERIFICATION: 'ALLOW_DEV_MODE_VERIFICATION is not allowed when TARGET_AWS_RUNTIME=1.',
    };
    const message = messages[primaryName ?? ''] ?? 'Verification worker runtime configuration is invalid';
    throw new RuntimeConfigValidationError(invalidNames, undefined, message);
  }
}

function toVerificationStatus(value: string): VerificationStatus {
  return value === 'success' || value === 'failed' || value === 'dev_mode' || value === 'not_run' || value === 'running'
    ? value
    : 'failed';
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
    sessionId: string;
    executionId: string;
  },
  failureCategory: VerificationFailureCategory,
): Promise<void> {
  await store.completeVerificationResult(message.sessionId, {
    executionId: message.executionId,
    verificationResult: {
      status: 'failed',
      failureCategory,
    },
  });
}

async function resolveVerificationWorkDisposition(
  store: ReturnType<typeof getGlobalStore>,
  sessionId: string,
  executionId: string,
): Promise<VerificationWorkDisposition> {
  const session = await store.getSession(sessionId);
  const finalizationResult = parseAwsPersistedFinalizationResult(session?.finalizationResult);
  if (!finalizationResult) {
    return 'process';
  }
  const currentExecutionId =
    finalizationResult.verificationExecutionId ?? finalizationResult.verificationResult?.executionId;
  if (currentExecutionId && currentExecutionId !== executionId) {
    return 'stale_execution';
  }
  if (
    finalizationResult.verificationResult?.executionId === executionId &&
    isTerminalVerificationStatus(finalizationResult.verificationResult.status)
  ) {
    return 'duplicate_terminal';
  }
  return 'process';
}

async function handleSqsEvent(rawEvent: SqsEvent): Promise<SqsBatchResponse> {
  const batchItemFailures: Array<{ itemIdentifier: string }> = [];
  const processedWorkKeys = new Set<string>();
  const store = getGlobalStore();

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
      const workKey = `${message.sessionId}/${message.executionId}`;
      if (processedWorkKeys.has(workKey)) {
        continue;
      }
      processedWorkKeys.add(workKey);
      const disposition = await resolveVerificationWorkDisposition(store, message.sessionId, message.executionId);
      if (disposition !== 'process') {
        logger.info('[VerificationWorker] Skipping idempotent SQS verification work', {
          session_id_hash: hashSessionIdForLogging(message.sessionId),
          executionId: message.executionId,
          disposition,
        });
        continue;
      }
      const response = await runVerificationPayload(
        {
          mode: 's3_bundle',
          sessionId: message.sessionId,
          executionId: message.executionId,
          bundleKey: message.bundleKey,
          expectedImageId: message.expectedImageId,
        },
        {
          retryInfrastructureErrors: true,
        },
      );

      if (response.status !== 'success') {
        await store.completeVerificationResult(message.sessionId, {
          executionId: message.executionId,
          verificationResult: {
            status: 'failed',
            failureCategory: 'unknown',
          },
        });
        continue;
      }

      await store.recordAwsVerificationDeliveryMetadata(message.sessionId, message.executionId, {
        s3BundleKey: response.s3?.bundleKey ?? message.bundleKey,
        ...(response.s3?.reportKey ? { s3ReportKey: response.s3.reportKey } : {}),
        ...(response.s3?.uploadedAt ? { s3UploadedAt: response.s3.uploadedAt } : {}),
      });
      await store.completeVerificationResult(message.sessionId, {
        executionId: message.executionId,
        verificationResult: {
          status: toVerificationStatus(response.verifierStatus),
          report: response.verificationReport,
          failureCategory: 'none',
        },
      });
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
              executionId: parsedMessage.executionId,
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
  await bootstrapLambdaRuntime({
    serviceName: 'verification-worker',
    resolveRuntimeReferences: async (invalidNameCollector) => {
      await ensureAwsRuntimeConfigReferencesLoaded('verification_worker', { invalidNameCollector });
    },
    validationSteps: [
      {
        validate: validateTargetObservabilityEnv,
      },
      {
        validate: validateVerificationWorkerConfig,
      },
      {
        validate: validateEnv,
      },
    ],
  });

  if (isSqsEvent(rawEvent)) {
    return await handleSqsEvent(rawEvent);
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

  return await runVerificationPayload(input);
};

export type { HandlerEvent };
