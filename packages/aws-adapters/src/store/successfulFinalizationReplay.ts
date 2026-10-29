import { admitPersistedFinalizationBitmapData } from '@stark-ballot/application/finalize/finalization-bitmap-admission';
import { parseVerificationResultRecord } from '@stark-ballot/application/finalize/finalization-result-store';
import { isDeepStrictEqual } from 'node:util';
import type { FinalizationRecord } from '@stark-ballot/application/finalize/finalization-record';
import type {
  FinalizationBitmapRecord,
  SuccessfulFinalizationCommitResult,
} from '@stark-ballot/application/finalize/finalization-store';
import type { VerificationResultRecord } from '@stark-ballot/application/finalize/finalization-result-store';
import type {
  SuccessfulFinalizationRecord,
  SuccessfulFinalizationReceipt,
} from '@stark-ballot/application/finalize/successful-finalization-commit-admission';
import type { AwsFinalizationRuntimeMetadata } from '../finalize/finalizationRuntimeStore';
import type { AwsVerificationDeliveryMetadataInput } from '../finalize/finalizationDeliveryMetadataStore';

interface SuccessfulCommitEvidence {
  receipt: SuccessfulFinalizationReceipt | undefined;
  verification: VerificationResultRecord | undefined;
  runtimeMetadata: AwsFinalizationRuntimeMetadata | undefined;
  deliveryMetadata: AwsVerificationDeliveryMetadataInput | undefined;
}

/** Replays must match terminal authority; omitted optional updates leave stored metadata intact. */
export function assertSuccessfulFinalizationReplay(
  stored: SuccessfulCommitEvidence & { record: FinalizationRecord; bitmap: FinalizationBitmapRecord | undefined },
  requested: SuccessfulCommitEvidence & {
    record: SuccessfulFinalizationRecord;
    bitmap: SuccessfulFinalizationCommitResult['bitmap'];
  },
): void {
  const expectedBitmap =
    requested.bitmap.availability === 'available'
      ? {
          sessionId: requested.record.sessionId,
          finalizationId: requested.record.finalizationId,
          ...requested.bitmap.data,
        }
      : undefined;
  if (
    !isDeepStrictEqual(stored.record, requested.record) ||
    !isDeepStrictEqual(stored.receipt, requested.receipt) ||
    !isDeepStrictEqual(stored.bitmap, expectedBitmap) ||
    (requested.verification !== undefined && !isDeepStrictEqual(stored.verification, requested.verification)) ||
    (requested.runtimeMetadata !== undefined &&
      !isDeepStrictEqual(stored.runtimeMetadata, requested.runtimeMetadata)) ||
    (requested.deliveryMetadata !== undefined &&
      !isDeepStrictEqual(stored.deliveryMetadata, requested.deliveryMetadata))
  ) {
    throw new Error('Successful finalization commit conflicts with existing authority');
  }
}

/** Map presence matters: a present but invalid sidecar cannot become missing evidence. */
export function admitReplayArtifacts(
  current: SuccessfulFinalizationRecord,
  bitmap: { present: boolean; value: unknown },
  verification: { present: boolean; value: unknown },
) {
  const existingBitmap = bitmap.present ? admitPersistedFinalizationBitmapData(current, bitmap.value) : undefined;
  if (bitmap.present && !existingBitmap) throw new Error('Invalid persisted finalization bitmap');
  const existingVerification = verification.present ? parseVerificationResultRecord(verification.value) : undefined;
  if (verification.present && !existingVerification) throw new Error('Invalid persisted verification result record');
  return { existingBitmap, existingVerification };
}

/** Terminal authority must precede stored success evidence. */
export function assertNoPrematureCommitArtifacts(
  bitmapActive: boolean,
  verificationActive: boolean,
  receiptPresent = false,
): void {
  if (bitmapActive || verificationActive)
    throw new Error('Successful finalization artifacts exist before terminal authority');
  if (receiptPresent) throw new Error('Successful finalization receipt exists before terminal authority');
}
