import { ListObjectsV2Command, PutObjectCommand } from '@aws-sdk/client-s3';
import { downloadRangeFromS3, headS3Object } from '@stark-ballot/aws-adapters/aws/s3-download';
import { restoreReceiptFromS3 } from '@stark-ballot/aws-adapters/aws/bundle-restore';
import { getS3Client, getS3Config } from '@stark-ballot/aws-adapters/aws/s3-client';
import type { ElectionConfig } from '@stark-ballot/zkvm-contract/zkvm/election-config';
import { serializeZkvmAggregatorInput } from '@stark-ballot/zkvm-contract/zkvm/host-io';
import type { ZkVMInput, ZkVMJournal } from '@stark-ballot/zkvm-contract/zkvm/types';
import { isSupportedZkVMJournal } from '@stark-ballot/zkvm-contract/zkvm/journal-guards';
import type { ReceiptWithImageId } from '@stark-ballot/verification/image-id-types';
import { buildFinalizationResultFromJournal } from '@stark-ballot/application/finalize/finalization-result';
import {
  PROVER_FAILURE_CATEGORY_VALUES,
  type FinalizationBitmapData,
  type ProverFailureCategory,
} from '@stark-ballot/application/finalize/finalization-types';
import type { FinalizationResultAuthority } from '@stark-ballot/application/finalize/finalization-types';
import { getObjectProperty, getStringProperty, isNonNullObject } from '@stark-ballot/validation/unknown-value-guards';
import { buildFinalizationArtifactS3Keys } from '@stark-ballot/aws-adapters/finalize/artifact-key-layout';
import type { ResolvedRuntimeProfile } from '@stark-ballot/runtime-config/env/runtimeProfile';

export interface AsyncProverArtifactKeys {
  inputS3Key: string;
  outputS3Prefix: string;
  bundleS3Key: string;
}

const PROVER_FAILURE_MARKER_FILENAME = 'failure-marker.json';
const MAX_PROVER_FAILURE_MARKER_BYTES = 256;
const PROVER_FAILURE_CATEGORIES = new Set<string>(PROVER_FAILURE_CATEGORY_VALUES);

export interface PersistAsyncProverInputOptions {
  profile: ResolvedRuntimeProfile;
  sessionId: string;
  finalizationId: string;
  zkvmInput: ZkVMInput;
  electionConfig: ElectionConfig;
}

export interface ValidateAsyncProverArtifactKeysOptions {
  profile: ResolvedRuntimeProfile;
  sessionId: string;
  finalizationId: string;
  inputS3Key: string;
  outputS3Prefix: string;
  bundleS3Key: string;
}

export function buildAsyncProverArtifactKeys(
  profile: ResolvedRuntimeProfile,
  sessionId: string,
  finalizationId: string,
): AsyncProverArtifactKeys {
  const { prefix } = getS3Config(profile);
  const keys = buildFinalizationArtifactS3Keys(sessionId, finalizationId, prefix);
  return {
    inputS3Key: keys.inputS3Key,
    outputS3Prefix: keys.outputS3Prefix,
    bundleS3Key: keys.bundleS3Key,
  };
}

export function buildAsyncProverFailureMarkerKey(
  profile: ResolvedRuntimeProfile,
  sessionId: string,
  finalizationId: string,
): string {
  const { outputS3Prefix } = buildAsyncProverArtifactKeys(profile, sessionId, finalizationId);
  return `${outputS3Prefix}/${PROVER_FAILURE_MARKER_FILENAME}`;
}

export function parseProverFailureMarker(input: Buffer): ProverFailureCategory | undefined {
  if (input.byteLength === 0 || input.byteLength > MAX_PROVER_FAILURE_MARKER_BYTES) {
    return undefined;
  }

  try {
    const parsed: unknown = JSON.parse(input.toString('utf8'));
    if (!isNonNullObject(parsed) || Object.keys(parsed).join(',') !== 'category') {
      return undefined;
    }
    const category = getStringProperty(parsed, 'category');
    return category && PROVER_FAILURE_CATEGORIES.has(category) ? (category as ProverFailureCategory) : undefined;
  } catch {
    return undefined;
  }
}

function isMissingS3Object(error: unknown): boolean {
  if (!isNonNullObject(error)) {
    return false;
  }
  const name = getStringProperty(error, 'name');
  const code = getStringProperty(error, 'code');
  const metadata = getObjectProperty(error, '$metadata');
  return (
    name === 'NoSuchKey' ||
    name === 'NotFound' ||
    code === 'NoSuchKey' ||
    code === 'NotFound' ||
    metadata?.['httpStatusCode'] === 404
  );
}

export async function readAsyncProverFailureCategory(
  profile: ResolvedRuntimeProfile,
  sessionId: string,
  finalizationId: string,
): Promise<ProverFailureCategory | undefined> {
  const markerKey = buildAsyncProverFailureMarkerKey(profile, sessionId, finalizationId);
  const { bucket, expectedBucketOwner } = getS3Config(profile);
  // A task that never starts cannot publish a marker. HEAD alone returns 403
  // for absence without unrestricted ListBucket permission, so observe only
  // this complete key prefix before reading. Listing errors must still retry.
  const listing = await getS3Client(profile).send(
    new ListObjectsV2Command({
      Bucket: bucket,
      ExpectedBucketOwner: expectedBucketOwner,
      Prefix: markerKey,
      MaxKeys: 1,
    }),
  );
  if (listing.CommonPrefixes?.length) {
    throw new Error('Unexpected failure marker listing');
  }
  if (listing.KeyCount === 0 && !listing.Contents?.length && listing.IsTruncated === false) {
    return undefined;
  }
  if (
    listing.KeyCount !== 1 ||
    listing.Contents?.length !== 1 ||
    listing.Contents[0]?.Key !== markerKey ||
    typeof listing.IsTruncated !== 'boolean'
  ) {
    throw new Error('Unexpected failure marker listing');
  }
  try {
    const { contentLength } = await headS3Object(profile, markerKey);
    if (contentLength <= 0 || contentLength > MAX_PROVER_FAILURE_MARKER_BYTES) {
      return undefined;
    }
    const { body } = await downloadRangeFromS3(profile, markerKey, { start: 0, end: contentLength - 1 });
    return parseProverFailureMarker(body);
  } catch (error) {
    if (isMissingS3Object(error)) {
      return undefined;
    }
    throw error;
  }
}

export function validateAsyncProverArtifactKeys(
  options: ValidateAsyncProverArtifactKeysOptions,
): AsyncProverArtifactKeys {
  const expected = buildAsyncProverArtifactKeys(options.profile, options.sessionId, options.finalizationId);
  if (
    options.inputS3Key !== expected.inputS3Key ||
    options.outputS3Prefix !== expected.outputS3Prefix ||
    options.bundleS3Key !== expected.bundleS3Key
  ) {
    throw new Error('Async prover artifact keys must match the canonical session/finalization S3 layout');
  }
  return expected;
}

export function validateAsyncProverBundleKey(
  profile: ResolvedRuntimeProfile,
  sessionId: string,
  finalizationId: string,
  bundleS3Key: string,
): string {
  const expected = buildAsyncProverArtifactKeys(profile, sessionId, finalizationId).bundleS3Key;
  if (bundleS3Key !== expected) {
    throw new Error('Async prover bundle key must match the canonical session/finalization S3 layout');
  }
  return expected;
}

function buildAsyncProverInputPayload(options: PersistAsyncProverInputOptions): Record<string, unknown> {
  const serializedInput = serializeZkvmAggregatorInput(options.zkvmInput);
  return {
    ...serializedInput,
    election_config: options.electionConfig,
  };
}

export async function persistAsyncProverInputToS3(
  options: PersistAsyncProverInputOptions,
): Promise<AsyncProverArtifactKeys> {
  const { bucket, expectedBucketOwner } = getS3Config(options.profile);
  const keys = buildAsyncProverArtifactKeys(options.profile, options.sessionId, options.finalizationId);
  const client = getS3Client(options.profile);

  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: keys.inputS3Key,
      Body: JSON.stringify(buildAsyncProverInputPayload(options), null, 2),
      ContentType: 'application/json',
      ExpectedBucketOwner: expectedBucketOwner,
      Metadata: {
        sessionId: options.sessionId,
        finalizationId: options.finalizationId,
      },
    }),
  );

  return keys;
}

function isReceiptWithImageId(value: unknown): value is ReceiptWithImageId {
  if (!isNonNullObject(value)) {
    return false;
  }
  const seal = getStringProperty(value, 'seal');
  const journal = value['journal'];
  return typeof seal === 'string' && (typeof journal === 'string' || isNonNullObject(journal));
}

function receiptImageId(value: unknown): string | undefined {
  return getStringProperty(value, 'imageId') ?? getStringProperty(value, 'image_id');
}

function resolveImageId(restoredReceipt: unknown, restoredRaw: unknown, journal: ZkVMJournal): string {
  if (typeof journal.imageId === 'string') return journal.imageId;
  const fromReceipt = receiptImageId(restoredReceipt);
  if (fromReceipt) return fromReceipt;
  const fromRaw = receiptImageId(restoredRaw);
  if (fromRaw) return fromRaw;
  return receiptImageId(getObjectProperty(restoredRaw, 'receipt')) || '';
}

function buildBitmapData(
  restored: Awaited<ReturnType<typeof restoreReceiptFromS3>>,
  finalizedAtMs: number,
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
    finalizedAtMs,
  };
}

export async function buildFinalizationResultFromS3Bundle(options: {
  profile: ResolvedRuntimeProfile;
  bundleS3Key: string;
  finalizationId: string;
  finalizedAtMs?: number;
}): Promise<FinalizationResultAuthority> {
  const restored = await restoreReceiptFromS3(options.profile, options.bundleS3Key);
  if (!isSupportedZkVMJournal(restored.journal)) {
    throw new Error('Restored bundle journal is missing or unsupported');
  }
  if (
    restored.publicInputArtifact?.provenance.finalizationId !== undefined &&
    restored.publicInputArtifact.provenance.finalizationId !== options.finalizationId
  ) {
    throw new Error('Restored bundle finalization identity does not match the requested finalization');
  }
  if (
    restored.publicInputArtifact?.provenance.bundleKey !== undefined &&
    restored.publicInputArtifact.provenance.bundleKey !== options.bundleS3Key
  ) {
    throw new Error('Restored bundle provenance does not match the requested S3 object');
  }

  const finalizedAtMs = options.finalizedAtMs ?? Date.now();
  const hasAnyPublicAuditArtifact = Boolean(
    restored.publicInputArtifact || restored.electionManifest || restored.closeStatement,
  );
  if (
    hasAnyPublicAuditArtifact &&
    !(restored.publicInputArtifact && restored.electionManifest && restored.closeStatement)
  ) {
    throw new Error('Restored bundle contains an incomplete public audit artifact group');
  }
  const baseResult = buildFinalizationResultFromJournal({
    journal: restored.journal,
    imageId: resolveImageId(restored.receipt, restored.receiptRaw, restored.journal),
    ...(restored.publicInputArtifact && restored.electionManifest && restored.closeStatement
      ? {
          publicAuditArtifacts: {
            availability: 'available' as const,
            publicInputArtifact: restored.publicInputArtifact,
            electionManifest: restored.electionManifest,
            closeStatement: restored.closeStatement,
          },
        }
      : {}),
  });
  const bitmapData = buildBitmapData(restored, finalizedAtMs);

  return {
    ...baseResult,
    artifacts: {
      ...baseResult.artifacts,
      ...(isReceiptWithImageId(restored.receipt)
        ? { receipt: { availability: 'available' as const, receipt: restored.receipt } }
        : {}),
      ...(bitmapData
        ? { bitmap: { availability: 'available' as const, proofSource: 'real' as const, data: bitmapData } }
        : {}),
    },
  };
}
