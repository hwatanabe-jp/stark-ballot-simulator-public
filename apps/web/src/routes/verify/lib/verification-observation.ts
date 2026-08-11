import type { VerificationObservationRequest } from '@stark-ballot/api-contract/schemas/verification';
import {
  LOCAL_CAST_CHECK_IDS,
  type LocalCastCheckId,
  type LocalCastCheckStatus,
} from '@stark-ballot/verification/local-cast-checks';
import type { VerificationCheck } from '@stark-ballot/verification/checks';
import { isSafeVerifierSegment } from '@stark-ballot/validation/safe-verifier-segment';

export interface VerificationObservationSubmission {
  finalizationId: string;
  request: VerificationObservationRequest;
}

function isObservationStatus(status: VerificationCheck['status']): status is LocalCastCheckStatus {
  return status === 'success' || status === 'failed' || status === 'not_run';
}

export function buildVerificationObservationSubmission(input: {
  finalizationId?: string;
  verificationChecks?: readonly VerificationCheck[];
}): VerificationObservationSubmission | null {
  if (!input.finalizationId || !isSafeVerifierSegment(input.finalizationId) || !input.verificationChecks) {
    return null;
  }

  const statuses = new Map<LocalCastCheckId, LocalCastCheckStatus>();
  for (const check of input.verificationChecks) {
    if (!LOCAL_CAST_CHECK_IDS.includes(check.id as LocalCastCheckId)) {
      continue;
    }
    const id = check.id as LocalCastCheckId;
    if (statuses.has(id) || !isObservationStatus(check.status)) {
      return null;
    }
    statuses.set(id, check.status);
  }

  const castReceiptPresent = statuses.get('cast_receipt_present');
  const castChoiceRange = statuses.get('cast_choice_range');
  const castRandomFormat = statuses.get('cast_random_format');
  const castCommitmentMatch = statuses.get('cast_commitment_match');
  if (!castReceiptPresent || !castChoiceRange || !castRandomFormat || !castCommitmentMatch) {
    return null;
  }

  return {
    finalizationId: input.finalizationId,
    request: {
      castChecks: {
        cast_receipt_present: castReceiptPresent,
        cast_choice_range: castChoiceRange,
        cast_random_format: castRandomFormat,
        cast_commitment_match: castCommitmentMatch,
      },
    },
  };
}
