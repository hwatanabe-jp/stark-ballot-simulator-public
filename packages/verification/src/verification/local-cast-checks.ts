import {
  VERIFICATION_CHECK_DEFINITIONS,
  type VerificationCheck,
  type VerificationCheckId,
} from '@stark-ballot/verification/checks';
import { VOTE_CHOICES, type VoteChoice } from '@stark-ballot/verification/shared/constants';
import { isValidHexString, normalizeHexString } from '@stark-ballot/crypto-primitives';
import type { VoteReceipt } from '@stark-ballot/verification/shared/types';
import { computeCommitment } from '@stark-ballot/zkvm-contract/zkvm/types';

export const LOCAL_CAST_CHECK_IDS = [
  'cast_receipt_present',
  'cast_choice_range',
  'cast_random_format',
  'cast_commitment_match',
] as const satisfies readonly VerificationCheckId[];

export type LocalCastCheckId = (typeof LOCAL_CAST_CHECK_IDS)[number];
export type LocalCastCheckStatus = 'success' | 'failed' | 'not_run';

export type LocalCastCheckResult =
  | Readonly<{ status: 'success' }>
  | Readonly<{ status: 'not_run' }>
  | Readonly<{ status: 'failed'; error?: string }>;

export type LocalCastCheckResults = Readonly<Record<LocalCastCheckId, LocalCastCheckResult>>;
export type LocalCastStatuses = Readonly<Record<LocalCastCheckId, LocalCastCheckStatus>>;

export interface LocalCastCheckInput {
  electionId?: string;
  voteReceipt?: Partial<VoteReceipt>;
  choice?: VoteChoice;
  random?: string;
}

const LOCAL_CAST_CHECK_ID_SET = new Set<VerificationCheckId>(LOCAL_CAST_CHECK_IDS);
const CHECK_DEFINITION_BY_ID = new Map(
  VERIFICATION_CHECK_DEFINITIONS.map((definition) => [definition.id, definition] as const),
);

function resolveCastReceiptPresent(voteReceipt: LocalCastCheckInput['voteReceipt']): LocalCastCheckResult {
  if (!voteReceipt) {
    return { status: 'not_run' };
  }
  if (!voteReceipt.voteId || !voteReceipt.commitment) {
    return { status: 'failed', error: 'Invalid receipt: missing commitment or voteId' };
  }
  return { status: 'success' };
}

function resolveCastChoiceRange(choice: LocalCastCheckInput['choice']): LocalCastCheckResult {
  if (!choice) {
    return { status: 'not_run' };
  }
  if (!VOTE_CHOICES.includes(choice)) {
    return { status: 'failed', error: `Unknown vote choice "${choice}".` };
  }
  return { status: 'success' };
}

function resolveCastRandomFormat(random: LocalCastCheckInput['random']): LocalCastCheckResult {
  if (!random) {
    return { status: 'not_run' };
  }
  return isValidHexString(random, 32)
    ? { status: 'success' }
    : { status: 'failed', error: 'Random value must be a 32-byte hex string.' };
}

function resolveCastCommitmentMatch(input: LocalCastCheckInput): LocalCastCheckResult {
  const { electionId, voteReceipt, choice, random } = input;
  if (!electionId || !voteReceipt?.commitment || !choice || !random) {
    return { status: 'not_run' };
  }

  const normalizedCommitment = normalizeHexString(voteReceipt.commitment);
  if (!normalizedCommitment) {
    return { status: 'failed', error: 'Receipt commitment is malformed.' };
  }

  const choiceIndex = VOTE_CHOICES.indexOf(choice);
  if (choiceIndex === -1) {
    return { status: 'failed', error: `Unknown vote choice "${choice}".` };
  }

  try {
    const recomputed = computeCommitment(electionId, choiceIndex, random);
    const normalizedRecomputed = normalizeHexString(recomputed);
    if (normalizedCommitment !== normalizedRecomputed) {
      return { status: 'failed', error: 'Commitment mismatch between receipt and recomputed value.' };
    }
    return { status: 'success' };
  } catch (error) {
    return {
      status: 'failed',
      error:
        error instanceof Error
          ? `Failed to recompute commitment: ${error.message}`
          : 'Failed to recompute commitment due to invalid input.',
    };
  }
}

export function evaluateLocalCastChecks(input: LocalCastCheckInput): LocalCastCheckResults {
  return {
    cast_receipt_present: resolveCastReceiptPresent(input.voteReceipt),
    cast_choice_range: resolveCastChoiceRange(input.choice),
    cast_random_format: resolveCastRandomFormat(input.random),
    cast_commitment_match: resolveCastCommitmentMatch(input),
  };
}

export function overlayLocalCastChecks(
  serverChecks: readonly VerificationCheck[],
  localResults: LocalCastCheckResults,
): VerificationCheck[] | null {
  if (serverChecks.length !== VERIFICATION_CHECK_DEFINITIONS.length) {
    return null;
  }

  const seen = new Set<VerificationCheckId>();
  for (const check of serverChecks) {
    if (!CHECK_DEFINITION_BY_ID.has(check.id) || seen.has(check.id)) {
      return null;
    }
    seen.add(check.id);
  }
  if (seen.size !== VERIFICATION_CHECK_DEFINITIONS.length) {
    return null;
  }

  return serverChecks.map((check) => {
    if (!LOCAL_CAST_CHECK_ID_SET.has(check.id)) {
      return check;
    }
    const id = check.id as LocalCastCheckId;
    const definition = CHECK_DEFINITION_BY_ID.get(id);
    if (!definition) {
      throw new Error(`Missing local cast check definition: ${id}`);
    }
    return {
      id,
      status: localResults[id].status,
      evidence: definition.evidence,
      inputs: [...definition.inputs],
      ...(definition.derivedFrom ? { derivedFrom: definition.derivedFrom } : {}),
    };
  });
}

export function projectLocalCastStatuses(results: LocalCastCheckResults): LocalCastStatuses {
  return {
    cast_receipt_present: results.cast_receipt_present.status,
    cast_choice_range: results.cast_choice_range.status,
    cast_random_format: results.cast_random_format.status,
    cast_commitment_match: results.cast_commitment_match.status,
  };
}
