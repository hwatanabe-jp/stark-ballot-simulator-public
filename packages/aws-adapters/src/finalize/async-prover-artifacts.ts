import { PutObjectCommand } from '@aws-sdk/client-s3';
import { restoreReceiptFromS3 } from '@stark-ballot/aws-adapters/aws/bundle-restore';
import { getS3Client, getS3Config } from '@stark-ballot/aws-adapters/aws/s3-client';
import type { ElectionConfig } from '@stark-ballot/zkvm-contract/zkvm/election-config';
import { serializeZkvmAggregatorInput } from '@stark-ballot/zkvm-contract/zkvm/host-io';
import type { ZkVMInput, ZkVMJournal } from '@stark-ballot/zkvm-contract/zkvm/types';
import { isSupportedZkVMJournal } from '@stark-ballot/zkvm-contract/zkvm/journal-guards';
import type { ReceiptWithImageId } from '@stark-ballot/verification/image-id-types';
import { buildFinalizationResultFromJournal } from '@stark-ballot/application/finalize/finalization-result';
import type { FinalizationBitmapData } from '@stark-ballot/application/finalize/finalization-types';
import type { AwsPersistedFinalizationResult } from '@stark-ballot/aws-adapters/finalize/finalizationPersistenceEnvelope';
import { getRecordProperty, getStringProperty, isRecord } from '@stark-ballot/domain/utils/guards';
import { buildFinalizationArtifactS3Keys } from '@stark-ballot/aws-adapters/finalize/artifact-key-layout';
import { omitUndefinedProperties } from '@stark-ballot/validation/definedProperties';

export interface AsyncProverArtifactKeys {
  inputS3Key: string;
  outputS3Prefix: string;
  bundleS3Key: string;
}

export interface PersistAsyncProverInputOptions {
  sessionId: string;
  executionId: string;
  contractGeneration: string;
  zkvmInput: ZkVMInput;
  electionConfig: ElectionConfig;
}

export interface ValidateAsyncProverArtifactKeysOptions {
  sessionId: string;
  executionId: string;
  inputS3Key: string;
  outputS3Prefix: string;
  bundleS3Key: string;
}

export function buildAsyncProverArtifactKeys(sessionId: string, executionId: string): AsyncProverArtifactKeys {
  const { prefix } = getS3Config();
  const keys = buildFinalizationArtifactS3Keys(sessionId, executionId, prefix);
  return {
    inputS3Key: keys.inputS3Key,
    outputS3Prefix: keys.outputS3Prefix,
    bundleS3Key: keys.bundleS3Key,
  };
}

export function validateAsyncProverArtifactKeys(
  options: ValidateAsyncProverArtifactKeysOptions,
): AsyncProverArtifactKeys {
  const expected = buildAsyncProverArtifactKeys(options.sessionId, options.executionId);
  if (
    options.inputS3Key !== expected.inputS3Key ||
    options.outputS3Prefix !== expected.outputS3Prefix ||
    options.bundleS3Key !== expected.bundleS3Key
  ) {
    throw new Error('Async prover artifact keys must match the canonical session/execution S3 layout');
  }
  return expected;
}

export function validateAsyncProverBundleKey(sessionId: string, executionId: string, bundleS3Key: string): string {
  const expected = buildAsyncProverArtifactKeys(sessionId, executionId).bundleS3Key;
  if (bundleS3Key !== expected) {
    throw new Error('Async prover bundle key must match the canonical session/execution S3 layout');
  }
  return expected;
}

function buildAsyncProverInputPayload(options: PersistAsyncProverInputOptions): Record<string, unknown> {
  const serializedInput = serializeZkvmAggregatorInput(options.zkvmInput);
  return {
    ...serializedInput,
    contract_generation: options.contractGeneration,
    contractGeneration: options.contractGeneration,
    election_config: options.electionConfig,
    electionConfig: options.electionConfig,
  };
}

export async function persistAsyncProverInputToS3(
  options: PersistAsyncProverInputOptions,
): Promise<AsyncProverArtifactKeys> {
  const { bucket, expectedBucketOwner } = getS3Config();
  const keys = buildAsyncProverArtifactKeys(options.sessionId, options.executionId);
  const client = getS3Client();

  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: keys.inputS3Key,
      Body: JSON.stringify(buildAsyncProverInputPayload(options), null, 2),
      ContentType: 'application/json',
      ExpectedBucketOwner: expectedBucketOwner,
      Metadata: {
        sessionId: options.sessionId,
        executionId: options.executionId,
        contractGeneration: options.contractGeneration,
      },
    }),
  );

  return keys;
}

function isReceiptWithImageId(value: unknown): value is ReceiptWithImageId {
  if (!isRecord(value)) {
    return false;
  }
  const seal = getStringProperty(value, 'seal');
  const journal = value['journal'];
  return typeof seal === 'string' && (typeof journal === 'string' || isRecord(journal));
}

function resolveImageId(restoredReceipt: unknown, restoredRaw: unknown, journal: ZkVMJournal): string {
  if (typeof journal.imageId === 'string') {
    return journal.imageId;
  }
  if (isRecord(restoredReceipt)) {
    const receiptImageId =
      getStringProperty(restoredReceipt, 'imageId') ?? getStringProperty(restoredReceipt, 'image_id');
    if (receiptImageId) {
      return receiptImageId;
    }
  }
  if (isRecord(restoredRaw)) {
    const rawImageId = getStringProperty(restoredRaw, 'imageId') ?? getStringProperty(restoredRaw, 'image_id');
    if (rawImageId) {
      return rawImageId;
    }
    const nestedReceipt = getRecordProperty(restoredRaw, 'receipt');
    const nestedImageId =
      nestedReceipt && (getStringProperty(nestedReceipt, 'imageId') ?? getStringProperty(nestedReceipt, 'image_id'));
    if (nestedImageId) {
      return nestedImageId;
    }
  }
  return '';
}

function buildBitmapData(
  restored: Awaited<ReturnType<typeof restoreReceiptFromS3>>,
  finalizedAt: number,
): FinalizationBitmapData | undefined {
  const included = restored.includedBitmapArtifact;
  if (!included) {
    return undefined;
  }

  return {
    includedBitmap: [...included.includedBitmap],
    includedBitmapRoot: included.includedBitmapRoot,
    ...(restored.seenBitmapArtifact
      ? {
          seenBitmap: [...restored.seenBitmapArtifact.seenBitmap],
          seenBitmapRoot: restored.seenBitmapArtifact.seenBitmapRoot,
        }
      : {}),
    treeSize: included.treeSize,
    finalizedAt,
  };
}

export async function buildFinalizationResultFromS3Bundle(options: {
  bundleS3Key: string;
  verificationExecutionId?: string;
  s3UploadedAt?: string;
  finalizedAt?: number;
}): Promise<AwsPersistedFinalizationResult> {
  const restored = await restoreReceiptFromS3(options.bundleS3Key);
  if (!isSupportedZkVMJournal(restored.journal)) {
    throw new Error('Restored bundle journal is missing or unsupported');
  }

  const finalizedAt = options.finalizedAt ?? Date.now();
  const baseResult = buildFinalizationResultFromJournal({
    journal: restored.journal,
    imageId: resolveImageId(restored.receipt, restored.receiptRaw, restored.journal),
    ...omitUndefinedProperties({
      electionManifest: restored.electionManifest,
      closeStatement: restored.closeStatement,
    }),
  });

  return omitUndefinedProperties({
    ...baseResult,
    ...(isReceiptWithImageId(restored.receipt) ? { receipt: restored.receipt } : {}),
    ...omitUndefinedProperties({ publicInputArtifact: restored.publicInputArtifact }),
    s3BundleKey: options.bundleS3Key,
    ...(options.verificationExecutionId ? { verificationExecutionId: options.verificationExecutionId } : {}),
    ...(options.s3UploadedAt ? { s3UploadedAt: options.s3UploadedAt } : {}),
    ...omitUndefinedProperties({ electionManifest: restored.electionManifest }),
    ...omitUndefinedProperties({
      closeStatement: restored.closeStatement,
      bitmapData: buildBitmapData(restored, finalizedAt),
      bitmapProofSource: restored.includedBitmapArtifact ? 'real' : baseResult.bitmapProofSource,
    }),
  });
}
