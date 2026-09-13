import type { FinalizationId } from './finalize/finalization-types';
import type { VerificationResult } from '@stark-ballot/verification/shared/types';

/** Closed expected application outcomes; transport status and messages remain API-owned. */
export const ApplicationErrorCode = {
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  SESSION_NOT_FOUND: 'SESSION_NOT_FOUND',
  SESSION_LIMIT_EXCEEDED: 'SESSION_LIMIT_EXCEEDED',
  ALREADY_VOTED: 'ALREADY_VOTED',
  SESSION_FINALIZED: 'SESSION_FINALIZED',
  INVALID_COMMITMENT: 'INVALID_COMMITMENT',
  DUPLICATE_VOTE: 'DUPLICATE_VOTE',
  SESSION_ALREADY_FINALIZED: 'SESSION_ALREADY_FINALIZED',
  USER_NOT_VOTED: 'USER_NOT_VOTED',
  VOTING_NOT_COMPLETE: 'VOTING_NOT_COMPLETE',
  INVALID_FINALIZATION_ARTIFACT: 'INVALID_FINALIZATION_ARTIFACT',
  VERIFICATION_FAILED: 'VERIFICATION_FAILED',
} as const;

export type ApplicationErrorCode = (typeof ApplicationErrorCode)[keyof typeof ApplicationErrorCode];

export interface ApplicationDiagnosticDetails {
  readonly details: string;
}

export interface ApplicationCtProofFailureDetails extends ApplicationDiagnosticDetails {
  readonly reason: string;
  readonly voteIndex: number;
  readonly expectedTreeSize: number;
  readonly actualTreeSize: number;
}

type DevModeVerificationReport = Extract<NonNullable<VerificationResult['report']>, { status: 'dev_mode' }>;
type FailedVerificationReport = Extract<NonNullable<VerificationResult['report']>, { status: 'failed' }>;

export type ApplicationVerifierFailureDetails =
  | Readonly<{
      status: 'dev_mode';
      finalizationId: FinalizationId;
      verificationReport: DevModeVerificationReport;
    }>
  | Readonly<{
      status: 'failed';
      finalizationId: FinalizationId;
      verificationReport: FailedVerificationReport;
    }>;

export type ApplicationVerificationFailureDetails =
  | ApplicationDiagnosticDetails
  | ApplicationCtProofFailureDetails
  | ApplicationVerifierFailureDetails;

export interface DuplicateVoteDetails {
  readonly duplicateKind: 'voteId' | 'commitment';
}

export type ApplicationExpectedError =
  | { readonly code: typeof ApplicationErrorCode.INTERNAL_ERROR; readonly details: ApplicationDiagnosticDetails }
  | { readonly code: typeof ApplicationErrorCode.SESSION_NOT_FOUND; readonly details?: never }
  | { readonly code: typeof ApplicationErrorCode.SESSION_LIMIT_EXCEEDED; readonly details?: never }
  | { readonly code: typeof ApplicationErrorCode.ALREADY_VOTED; readonly details?: never }
  | { readonly code: typeof ApplicationErrorCode.SESSION_FINALIZED; readonly details?: never }
  | { readonly code: typeof ApplicationErrorCode.INVALID_COMMITMENT; readonly details?: never }
  | { readonly code: typeof ApplicationErrorCode.DUPLICATE_VOTE; readonly details: DuplicateVoteDetails }
  | { readonly code: typeof ApplicationErrorCode.SESSION_ALREADY_FINALIZED; readonly details?: never }
  | { readonly code: typeof ApplicationErrorCode.USER_NOT_VOTED; readonly details?: never }
  | { readonly code: typeof ApplicationErrorCode.VOTING_NOT_COMPLETE; readonly details?: never }
  | {
      readonly code: typeof ApplicationErrorCode.INVALID_FINALIZATION_ARTIFACT;
      readonly details: ApplicationDiagnosticDetails;
    }
  | {
      readonly code: typeof ApplicationErrorCode.VERIFICATION_FAILED;
      readonly details: ApplicationVerificationFailureDetails;
    };

export type ApplicationExpectedErrorOf<TCode extends ApplicationErrorCode> = Extract<
  ApplicationExpectedError,
  { readonly code: TCode }
>;
