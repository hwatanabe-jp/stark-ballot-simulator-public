import { describe, expect, it } from 'vitest';
import { ApplicationErrorCode, type ApplicationExpectedError } from '@stark-ballot/application';
import { ErrorCode, getErrorMessage } from '@stark-ballot/api-contract/errors/apiErrors';
import { submitVoteRoute } from '@stark-ballot/api-contract/routes';
import { runWithLogContext } from '@stark-ballot/diagnostics/requestLogContext';
import { projectApplicationError, respondWithApplicationError } from './applicationErrorResponse';

describe('application error response', () => {
  it.each<readonly [ApplicationExpectedError, ErrorCode, number]>([
    [{ code: ApplicationErrorCode.SESSION_NOT_FOUND }, ErrorCode.SESSION_NOT_FOUND, 404],
    [{ code: ApplicationErrorCode.SESSION_LIMIT_EXCEEDED }, ErrorCode.SESSION_LIMIT_EXCEEDED, 503],
    [{ code: ApplicationErrorCode.ALREADY_VOTED }, ErrorCode.ALREADY_VOTED, 400],
    [{ code: ApplicationErrorCode.SESSION_FINALIZED }, ErrorCode.SESSION_FINALIZED, 400],
    [{ code: ApplicationErrorCode.INVALID_COMMITMENT }, ErrorCode.INVALID_COMMITMENT, 400],
    [{ code: ApplicationErrorCode.SESSION_ALREADY_FINALIZED }, ErrorCode.SESSION_ALREADY_FINALIZED, 400],
    [{ code: ApplicationErrorCode.USER_NOT_VOTED }, ErrorCode.USER_NOT_VOTED, 400],
    [{ code: ApplicationErrorCode.VOTING_NOT_COMPLETE }, ErrorCode.VOTING_NOT_COMPLETE, 400],
  ])('owns the default projection for %s', (error, code, status) => {
    expect(projectApplicationError(error)).toMatchObject({ code, status });
  });

  it('preserves the existing commitment-duplicate message without exposing internal details', async () => {
    const response = await runWithLogContext({ requestId: 'application-error-request-id' }, () =>
      respondWithApplicationError(submitVoteRoute, {
        code: ApplicationErrorCode.DUPLICATE_VOTE,
        details: { duplicateKind: 'commitment' },
      }),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: ErrorCode.DUPLICATE_VOTE,
        message: 'This commitment has already been submitted. Please ensure your vote is unique.',
      },
      meta: { requestId: 'application-error-request-id' },
    });
  });

  it('uses the catalog message for no-detail application outcomes', async () => {
    const response = await runWithLogContext({ requestId: 'default-error-request-id' }, () =>
      respondWithApplicationError(submitVoteRoute, { code: ApplicationErrorCode.ALREADY_VOTED }),
    );

    await expect(response.json()).resolves.toEqual({
      error: {
        code: ErrorCode.ALREADY_VOTED,
        message: getErrorMessage(ErrorCode.ALREADY_VOTED),
      },
      meta: { requestId: 'default-error-request-id' },
    });
  });
});
