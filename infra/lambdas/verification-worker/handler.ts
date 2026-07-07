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
import { isTargetAwsRuntime } from '@stark-ballot/runtime-config/env/targetRuntime';
import { logger } from '@stark-ballot/diagnostics/logger';
import { SAFE_VERIFIER_SEGMENT_PATTERN } from '@stark-ballot/validation/safe-verifier-segment';
import type { VerificationStatus } from '@stark-ballot/verification/shared/types';
import { addHexPrefix, isValidHexString, normalizeHexString } from '@stark-ballot/domain/utils/hex';
import { omitUndefinedProperties } from '@stark-ballot/validation/definedProperties';
import { uploadVerificationBundleToS3 } from './verificationBundleS3Upload.js';

const INVALID_PAYLOAD_DETAILS = 'Invalid verifier invocation payload';
const VERIFIER_EXECUTION_FAILURE_DETAILS = 'Verifier service execution failed';

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
  Records?: Array<{
    messageId?: string;
    body?: string;
    attributes?: {
      ApproximateReceiveCount?: string;
    };
  }>;
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
    const bundleKey = validateAsyncProverBundleKey(input.sessionId, input.executionId, input.bundleKey);
    const bundlePath = path.join(workDir, input.sessionId, input.executionId);
    await fs.mkdir(bundlePath, { recursive: true });

    const zipBuffer = await downloadFromS3(bundleKey);
    await extractZipFromBuffer(zipBuffer, { destination: bundlePath });

    const reportPath = path.join(bundlePath, 'verification.json');
    const invocation = await invokeVerifierService({
      bundlePath,
      expectedImageId: input.expectedImageId,
      reportPath,
    });

    let s3Result: Awaited<ReturnType<typeof uploadVerificationBundleToS3>> | undefined;
    if (input.options?.uploadToS3 ?? true) {
      s3Result = await uploadVerificationBundleToS3(bundlePath, input.sessionId, input.executionId);
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
        sessionId: input.sessionId,
        executionId: input.executionId,
        bundleKey: input.bundleKey,
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

function isSqsEvent(value: unknown): value is SqsEvent {
  return (
    typeof value === 'object' &&
    value !== null &&
    Array.isArray((value as { Records?: unknown }).Records) &&
    ((value as SqsEvent).Records ?? []).some((record) => typeof record.body === 'string')
  );
}

function toVerificationStatus(value: string): VerificationStatus {
  return value === 'success' || value === 'failed' || value === 'dev_mode' || value === 'not_run' || value === 'running'
    ? value
    : 'failed';
}

function isTerminalVerificationStatus(status: VerificationStatus | undefined): boolean {
  return status === 'success' || status === 'failed' || status === 'dev_mode';
}

function parseApproximateReceiveCount(record: NonNullable<SqsEvent['Records']>[number]): number {
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
): Promise<void> {
  await store.completeVerificationResult(message.sessionId, {
    executionId: message.executionId,
    verificationResult: {
      status: 'failed',
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

  for (const record of rawEvent.Records ?? []) {
    const itemIdentifier = record.messageId ?? '';
    let parsedMessage: ReturnType<typeof parseVerificationWorkMessage> | undefined;
    try {
      const message = parseVerificationWorkMessage(JSON.parse(record.body ?? '{}'));
      parsedMessage = message;
      const workKey = `${message.sessionId}/${message.executionId}`;
      if (processedWorkKeys.has(workKey)) {
        continue;
      }
      processedWorkKeys.add(workKey);
      const disposition = await resolveVerificationWorkDisposition(store, message.sessionId, message.executionId);
      if (disposition !== 'process') {
        logger.info('[VerificationWorker] Skipping idempotent SQS verification work', {
          sessionId: message.sessionId,
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
        },
      });
    } catch (error) {
      logger.error('[VerificationWorker] SQS verification work failed', { itemIdentifier }, error);
      if (parsedMessage && parseApproximateReceiveCount(record) >= VERIFICATION_WORK_MAX_RECEIVE_COUNT) {
        try {
          await persistTerminalFailureAfterRetryExhaustion(store, parsedMessage);
        } catch (persistenceError) {
          logger.error(
            '[VerificationWorker] Failed to persist terminal verification failure after retry exhaustion',
            {
              itemIdentifier,
              sessionId: parsedMessage.sessionId,
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
  await ensureAwsRuntimeConfigReferencesLoaded('verification_worker');
  validateEnv();

  if (isSqsEvent(rawEvent)) {
    return await handleSqsEvent(rawEvent);
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
