import { ApplicationErrorCode, type ApplicationExpectedError, type Result } from '@stark-ballot/application';

const duplicateVote: ApplicationExpectedError = {
  code: ApplicationErrorCode.DUPLICATE_VOTE,
  details: { duplicateKind: 'commitment' },
};
const successful: Result<number, ApplicationExpectedError> = { ok: true, value: 1 };
const rejected: Result<number, ApplicationExpectedError> = { ok: false, error: duplicateVote };

void successful;
void rejected;

// @ts-expect-error duplicate-vote outcomes require the closed duplicate discriminator
const duplicateWithoutDetails: ApplicationExpectedError = { code: ApplicationErrorCode.DUPLICATE_VOTE };
// @ts-expect-error no unknown application error codes are admitted
const unknownCode: ApplicationExpectedError = { code: 'UNKNOWN_APPLICATION_ERROR' };
// @ts-expect-error session-finalized outcomes cannot carry diagnostic details
const finalizedWithDetails: ApplicationExpectedError = {
  code: ApplicationErrorCode.SESSION_FINALIZED,
  details: { details: 'unsafe transport detail' },
};

void duplicateWithoutDetails;
void unknownCode;
void finalizedWithDetails;
