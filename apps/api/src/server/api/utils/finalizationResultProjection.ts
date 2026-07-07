import type {
  FinalizationResultAuthority,
  FinalizeSyncPayload,
} from '@stark-ballot/application/finalize/finalization-types';
import type { AwsPersistedFinalizationResult } from '@stark-ballot/aws-adapters/finalize/finalizationPersistenceEnvelope';
import type { FinalizeSyncResponse } from '@stark-ballot/api-contract/validation/apiSchemas';
import type { PublicVerificationResult, VerificationResult } from '@stark-ballot/verification/shared/types';
import { sanitizeFinalizationPayloadVerificationStatus } from '@stark-ballot/verification/fail-closed-status';
import { sanitizeVerificationReportForPublicResponse } from '@stark-ballot/verification/public-result';
import { addHexPrefix, isValidHexString, normalizeHexString } from '@stark-ballot/domain/utils/hex';
import { toPublicZkvmJournal } from '@stark-ballot/zkvm-contract/zkvm/public-journal';
import { omitUndefinedProperties } from '@stark-ballot/validation/definedProperties';

type PublicVerificationResultProjection = PublicVerificationResult & {
  executionId?: string;
};

interface FinalizationResultPublicProjection {
  tally: FinalizationResultAuthority['tally'];
  receiptPublication?: FinalizationResultAuthority['receiptPublication'];
  imageId: string;
  tamperDetected?: boolean;
  scenarios?: string[];
  journal: ReturnType<typeof toPublicZkvmJournal>;
  electionManifest?: FinalizationResultAuthority['electionManifest'];
  closeStatement?: FinalizationResultAuthority['closeStatement'];
  bitmapProofSource?: FinalizationResultAuthority['bitmapProofSource'];
  verificationResult?: PublicVerificationResultProjection;
  verificationExecutionId?: string;
  tamperSummary?: FinalizationResultAuthority['tamperSummary'];
  bulletinRoot: string;
  verifiedTally: number[];
  missingSlots: number;
  invalidPresentedSlots: number;
  rejectedRecords: number;
  totalExpected: number;
  treeSize: number;
  excludedSlots: number;
  sthDigest: string;
  seenBitmapRoot?: string;
  includedBitmapRoot: string;
  inputCommitment: string;
  seenIndicesCount: number;
}

type VerificationResultProjectionInput = VerificationResult & {
  executionId?: string | undefined;
};

type FinalizationResultProjectionInput = Omit<FinalizationResultAuthority, 'verificationResult'> &
  Pick<Partial<AwsPersistedFinalizationResult>, 'verificationExecutionId'> & {
    verificationResult?: VerificationResultProjectionInput;
  };

function asVerificationResult(value: unknown): VerificationResultProjectionInput | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  const status = (value as { status?: unknown }).status;
  if (
    status !== 'success' &&
    status !== 'failed' &&
    status !== 'dev_mode' &&
    status !== 'not_run' &&
    status !== 'running'
  ) {
    return undefined;
  }
  return value as VerificationResultProjectionInput;
}

function nonEmptyString(value: string | undefined): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function projectVerificationResultForPublicResponse(
  result?: VerificationResultProjectionInput,
): PublicVerificationResultProjection | undefined {
  if (!result) {
    return undefined;
  }

  return {
    status: result.status,
    ...omitUndefinedProperties({ report: sanitizeVerificationReportForPublicResponse(result.report) }),
    ...omitUndefinedProperties({ executionId: nonEmptyString(result.executionId) }),
  };
}

export function projectFinalizationResultForPublicResponse(
  result: FinalizationResultProjectionInput,
): FinalizationResultPublicProjection {
  const journal = toPublicZkvmJournal(result.journal);
  const publicVerificationResult = projectVerificationResultForPublicResponse(
    asVerificationResult(result.verificationResult),
  );
  const projected: FinalizationResultPublicProjection = omitUndefinedProperties({
    tally: result.tally,
    imageId: result.imageId,
    ...omitUndefinedProperties({
      receiptPublication: result.receiptPublication,
      tamperDetected: result.tamperDetected,
      scenarios: result.scenarios,
      electionManifest: result.electionManifest,
      closeStatement: result.closeStatement,
      bitmapProofSource: result.bitmapProofSource,
      verificationResult: publicVerificationResult,
      verificationExecutionId: result.verificationExecutionId,
      tamperSummary: result.tamperSummary,
      seenBitmapRoot: journal.seenBitmapRoot,
    }),
    journal,
    bulletinRoot: journal.bulletinRoot,
    verifiedTally: [...journal.verifiedTally],
    missingSlots: journal.missingSlots,
    invalidPresentedSlots: journal.invalidPresentedSlots,
    rejectedRecords: journal.rejectedRecords,
    totalExpected: journal.totalExpected,
    treeSize: journal.treeSize,
    excludedSlots: journal.excludedSlots,
    sthDigest: journal.sthDigest,
    includedBitmapRoot: journal.includedBitmapRoot,
    inputCommitment: journal.inputCommitment,
    seenIndicesCount: journal.seenIndicesCount,
  });

  return sanitizeFinalizationPayloadVerificationStatus(projected);
}

function normalizeHex32(value: string | undefined, label: string): string {
  if (!isValidHexString(value ?? '', 32)) {
    throw new Error(`Invalid ${label} (expected 32-byte hex)`);
  }
  return addHexPrefix(normalizeHexString(value ?? ''));
}

function projectReceiptForPublicFinalizeResponse(
  payload: FinalizeSyncPayload,
  imageId: string,
): NonNullable<FinalizeSyncResponse['data']['receipt']> {
  const projected: NonNullable<FinalizeSyncResponse['data']['receipt']> = {
    imageId,
    seal: payload.receipt.seal,
    journal: payload.receiptJournal,
  };
  if (typeof payload.receipt.metadata?.isFake === 'boolean') {
    projected.metadata = { isFake: payload.receipt.metadata.isFake };
  }
  return projected;
}

export function projectFinalizeSyncPayloadForResponse(payload: FinalizeSyncPayload): FinalizeSyncResponse['data'] {
  const projected = projectFinalizationResultForPublicResponse(payload.finalizationResult);
  const verificationResult = projected.verificationResult;
  const journal = projected.journal;

  return {
    sessionId: payload.sessionId,
    tally: {
      counts: payload.finalizationResult.tally.counts,
      totalVotes: payload.finalizationResult.tally.totalVotes,
      tamperedCount: payload.finalizationResult.tally.tamperedCount,
    },
    bulletinRoot: payload.bulletinRoot,
    verifiedTally: projected.verifiedTally,
    voteReceipt: payload.voteReceipt,
    receipt: projectReceiptForPublicFinalizeResponse(payload, normalizeHex32(projected.imageId, 'imageId')),
    ...omitUndefinedProperties({ receiptPublication: payload.finalizationResult.receiptPublication }),
    imageId: normalizeHex32(projected.imageId, 'imageId'),
    userVote: payload.userVote,
    missingSlots: projected.missingSlots,
    invalidPresentedSlots: projected.invalidPresentedSlots,
    rejectedRecords: projected.rejectedRecords,
    totalExpected: projected.totalExpected,
    treeSize: projected.treeSize,
    excludedSlots: projected.excludedSlots,
    sthDigest: normalizeHex32(projected.sthDigest, 'sthDigest'),
    ...(projected.seenBitmapRoot ? { seenBitmapRoot: normalizeHex32(projected.seenBitmapRoot, 'seenBitmapRoot') } : {}),
    includedBitmapRoot: normalizeHex32(projected.includedBitmapRoot, 'includedBitmapRoot'),
    inputCommitment: payload.inputCommitment,
    seenIndicesCount: projected.seenIndicesCount,
    journal,
    verificationStatus: verificationResult?.status ?? 'not_run',
    ...omitUndefinedProperties({
      verificationReport: verificationResult?.report,
      verificationExecutionId: payload.verificationExecutionId,
    }),
    ...omitUndefinedProperties({ tamperSummary: payload.finalizationResult.tamperSummary }),
  };
}
