import type { VerificationResult } from '@stark-ballot/verification/shared/types';
import { ApplicationErrorCode, type ApplicationExpectedError } from '@stark-ballot/application';
import type { FinalizationId } from './finalization-types';

declare const failedVerificationReport: Extract<NonNullable<VerificationResult['report']>, { status: 'failed' }>;
declare const devModeVerificationReport: Extract<NonNullable<VerificationResult['report']>, { status: 'dev_mode' }>;
declare const finalizationId: FinalizationId;

const internalFailure = {
  code: ApplicationErrorCode.INTERNAL_ERROR,
  details: { details: 'bounded diagnostic' },
} satisfies ApplicationExpectedError;

const expectedSessionOutcome = {
  code: ApplicationErrorCode.SESSION_ALREADY_FINALIZED,
} satisfies ApplicationExpectedError;

const verifierFailure = {
  code: ApplicationErrorCode.VERIFICATION_FAILED,
  details: {
    status: 'failed',
    finalizationId,
    verificationReport: failedVerificationReport,
  },
} satisfies ApplicationExpectedError;

const devModeVerifierFailure = {
  code: ApplicationErrorCode.VERIFICATION_FAILED,
  details: {
    status: 'dev_mode',
    finalizationId,
    verificationReport: devModeVerificationReport,
  },
} satisfies ApplicationExpectedError;

void internalFailure;
void expectedSessionOutcome;
void verifierFailure;
void devModeVerifierFailure;

// @ts-expect-error Internal failures require their bounded diagnostic detail.
const missingInternalDetails = { code: ApplicationErrorCode.INTERNAL_ERROR } satisfies ApplicationExpectedError;

// @ts-expect-error Session lifecycle outcomes cannot smuggle delivery details.
const sessionWithDetails: ApplicationExpectedError = {
  code: ApplicationErrorCode.USER_NOT_VOTED,
  details: { details: 'unexpected' },
};

const verifierWithUnknownDetails: ApplicationExpectedError = {
  code: ApplicationErrorCode.VERIFICATION_FAILED,
  // @ts-expect-error Verifier failures accept only the named verifier projection shapes.
  details: { privatePath: '/private/verifier/report.json' },
};

const verifierWithMismatchedReport = {
  code: ApplicationErrorCode.VERIFICATION_FAILED,
  // @ts-expect-error Verifier failure status and report status are one correlated outcome.
  details: {
    status: 'success',
    finalizationId,
    verificationReport: failedVerificationReport,
  },
} satisfies ApplicationExpectedError;

const verifierWithRunningStatus = {
  code: ApplicationErrorCode.VERIFICATION_FAILED,
  // @ts-expect-error Nonterminal verifier states cannot carry terminal failure reports.
  details: {
    status: 'running',
    finalizationId,
    verificationReport: failedVerificationReport,
  },
} satisfies ApplicationExpectedError;

const verifierWithAllowedStatusButMismatchedReport = {
  code: ApplicationErrorCode.VERIFICATION_FAILED,
  // @ts-expect-error Each allowed failure status admits only its matching report variant.
  details: {
    status: 'failed',
    finalizationId,
    verificationReport: devModeVerificationReport,
  },
} satisfies ApplicationExpectedError;

void missingInternalDetails;
void sessionWithDetails;
void verifierWithUnknownDetails;
void verifierWithMismatchedReport;
void verifierWithRunningStatus;
void verifierWithAllowedStatusButMismatchedReport;
