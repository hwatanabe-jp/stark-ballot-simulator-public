import type {
  FinalizationResultAuthority,
  FinalizeSyncPayload,
} from '@stark-ballot/application/finalize/finalization-types';
import type { FinalizationBitmapData } from '@stark-ballot/application/finalize/finalization-store';
import type { FinalizationResource, FinalizationResult } from '@stark-ballot/api-contract/schemas/finalizations';
import type { AwsVerificationDeliveryMetadataInput } from '@stark-ballot/aws-adapters/finalize/finalizationDeliveryMetadataStore';
import { addHexPrefix, isValidHexString, normalizeHexString } from '@stark-ballot/crypto-primitives';
import { sanitizeFinalizationResultVerificationStatus } from '@stark-ballot/verification/fail-closed-status';
import { sanitizeVerificationReportForPublicResponse } from '@stark-ballot/verification/public-result';
import type { VerificationResult } from '@stark-ballot/verification/shared/types';
import { toPublicZkvmJournal } from '@stark-ballot/zkvm-contract/zkvm/public-journal';
import { omitUndefinedProperties } from '@stark-ballot/validation/definedProperties';

interface FinalizationResultProjectionEvidence {
  verificationResult?: VerificationResult;
  deliveryMetadata?: AwsVerificationDeliveryMetadataInput;
  bitmapData?: FinalizationBitmapData;
}

function normalizeHex32(value: string | undefined, label: string): string {
  if (!isValidHexString(value ?? '', 32)) {
    throw new Error(`Invalid ${label} (expected 32-byte hex)`);
  }
  return addHexPrefix(normalizeHexString(value ?? ''));
}

function assertSameHex32(left: string, right: string, label: string): void {
  if (normalizeHex32(left, label) !== normalizeHex32(right, label)) {
    throw new Error(`${label} does not match canonical journal authority`);
  }
}

function projectPublicReceiptMetadata(
  metadata: NonNullable<FinalizationResultAuthority['receipt']>['metadata'],
): { isFake: boolean } | undefined {
  return typeof metadata?.isFake === 'boolean' ? { isFake: metadata.isFake } : undefined;
}

function deriveArtifactAvailability(
  evidence: FinalizationResultProjectionEvidence,
): FinalizationResult['artifactAvailability'] {
  const { verificationResult, deliveryMetadata } = evidence;
  return {
    bundle: deliveryMetadata?.s3BundleKey || verificationResult ? 'available' : 'unavailable',
    report: verificationResult?.report ? 'available' : 'unavailable',
    includedBitmap: evidence.bitmapData?.includedBitmap ? 'available' : 'unavailable',
    seenBitmap: evidence.bitmapData?.seenBitmap ? 'available' : 'unavailable',
  };
}

function assertResultMirrorsMatchJournal(result: FinalizationResultAuthority): void {
  const journal = toPublicZkvmJournal(result.journal);
  if (journal.imageId !== undefined) {
    assertSameHex32(result.imageId, journal.imageId, 'imageId');
  }
  if (result.receipt?.imageId !== undefined) {
    assertSameHex32(result.imageId, result.receipt.imageId, 'receipt imageId');
  }
  if (result.bitmapData) {
    assertSameHex32(result.bitmapData.includedBitmapRoot, journal.includedBitmapRoot, 'includedBitmapRoot');
    if (result.bitmapData.treeSize !== journal.treeSize) {
      throw new Error('bitmap treeSize does not match canonical journal authority');
    }
    if (result.bitmapData.seenBitmapRoot !== undefined) {
      assertSameHex32(result.bitmapData.seenBitmapRoot, journal.seenBitmapRoot, 'seenBitmapRoot');
    }
  }
}

export function projectFinalizationResultForPublicResponse(
  result: FinalizationResultAuthority,
  voterEvidence: FinalizationResult['voterEvidence'] = {
    state: 'verification-gated',
    ...omitUndefinedProperties({ receiptPublication: result.receiptPublication }),
  },
  evidence: FinalizationResultProjectionEvidence = {},
): FinalizationResult {
  assertResultMirrorsMatchJournal(result);
  const sanitized = sanitizeFinalizationResultVerificationStatus({
    ...result,
    ...omitUndefinedProperties({ verificationResult: evidence.verificationResult }),
  });
  const journal = toPublicZkvmJournal(sanitized.journal);
  const verificationResult = sanitized.verificationResult;
  const imageId = normalizeHex32(sanitized.imageId, 'imageId');

  return {
    authority: {
      imageId,
      journal,
      ...omitUndefinedProperties({
        receipt: sanitized.receipt
          ? {
              imageId: normalizeHex32(sanitized.receipt.imageId ?? sanitized.imageId, 'receipt imageId'),
              seal: sanitized.receipt.seal,
              ...omitUndefinedProperties({
                journal: typeof sanitized.receipt.journal === 'string' ? sanitized.receipt.journal : undefined,
                metadata: projectPublicReceiptMetadata(sanitized.receipt.metadata),
              }),
            }
          : undefined,
        electionManifest: sanitized.electionManifest
          ? {
              ...sanitized.electionManifest,
              choices: [...sanitized.electionManifest.choices],
            }
          : undefined,
        closeStatement: sanitized.closeStatement,
      }),
    },
    presentation: {
      tally: sanitized.tally,
      verifiedTally: [...journal.verifiedTally],
      ...omitUndefinedProperties({
        tamperDetected: sanitized.tamperDetected,
        scenarios: sanitized.scenarios,
        tamperSummary: sanitized.tamperSummary,
      }),
      bulletinRoot: normalizeHex32(journal.bulletinRoot, 'bulletinRoot'),
      missingSlots: journal.missingSlots,
      invalidPresentedSlots: journal.invalidPresentedSlots,
      rejectedRecords: journal.rejectedRecords,
      totalExpected: journal.totalExpected,
      treeSize: journal.treeSize,
      excludedSlots: journal.excludedSlots,
      sthDigest: normalizeHex32(journal.sthDigest, 'sthDigest'),
      seenBitmapRoot: normalizeHex32(journal.seenBitmapRoot, 'seenBitmapRoot'),
      includedBitmapRoot: normalizeHex32(journal.includedBitmapRoot, 'includedBitmapRoot'),
      inputCommitment: normalizeHex32(journal.inputCommitment, 'inputCommitment'),
      seenIndicesCount: journal.seenIndicesCount,
      ...omitUndefinedProperties({ bitmapProofSource: sanitized.bitmapProofSource }),
      verificationStatus: verificationResult?.status ?? 'not_run',
      ...omitUndefinedProperties({
        verificationReport: sanitizeVerificationReportForPublicResponse(verificationResult?.report),
      }),
    },
    voterEvidence,
    artifactAvailability: deriveArtifactAvailability(evidence),
  };
}

function projectVoteReceiptForPublicFinalizeResponse(
  voteReceipt: FinalizeSyncPayload['voteReceipt'],
): Extract<FinalizationResult['voterEvidence'], { state: 'available' }>['voteReceipt'] {
  return {
    voteId: voteReceipt.voteId,
    commitment: voteReceipt.commitment,
    bulletinIndex: voteReceipt.bulletinIndex,
    bulletinRootAtCast: voteReceipt.bulletinRootAtCast,
    castAtMs: voteReceipt.timestamp,
    ...omitUndefinedProperties({ inputCommitment: voteReceipt.inputCommitment }),
  };
}

export function projectFinalizeSyncPayloadForResponse(payload: FinalizeSyncPayload): FinalizationResource {
  if (payload.state.finalizationId !== payload.finalizationId) {
    throw new Error('Synchronous finalization state identity mismatch');
  }

  const journal = toPublicZkvmJournal(payload.finalizationResult.journal);
  assertSameHex32(payload.bulletinRoot, journal.bulletinRoot, 'bulletinRoot');
  assertSameHex32(payload.inputCommitment, journal.inputCommitment, 'inputCommitment');

  const finalizationResult = projectFinalizationResultForPublicResponse(
    payload.finalizationResult,
    {
      state: 'available',
      voteReceipt: projectVoteReceiptForPublicFinalizeResponse(payload.voteReceipt),
      userVote: payload.userVote,
      ...omitUndefinedProperties({ receiptPublication: payload.finalizationResult.receiptPublication }),
    },
    {
      verificationResult: payload.verificationResult,
      ...(payload.bitmapDisposition.availability === 'available'
        ? {
            bitmapData: {
              sessionId: payload.sessionId,
              finalizationId: payload.finalizationId,
              ...payload.bitmapDisposition.data,
            },
          }
        : {}),
    },
  );

  return {
    ...payload.state,
    runtimeDiagnostics: {
      asyncMode: 'disabled',
    },
    result: finalizationResult,
  };
}
