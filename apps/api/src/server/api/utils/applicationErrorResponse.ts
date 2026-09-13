import { ApplicationErrorCode, type ApplicationExpectedError } from '@stark-ballot/application';
import { ApiError, ErrorCode, type ErrorDetails } from '@stark-ballot/api-contract/errors/apiErrors';
import type { ApiRouteContract } from '@stark-ballot/api-contract/routes';
import type { RouteBoundResponse } from '../context';
import { errorResponse } from '../../http/response';
import { admitRouteErrorResponse } from './responseSchema';

interface ApplicationErrorProjection {
  readonly code: ErrorCode;
  readonly status: number;
  readonly message?: string;
  readonly details?: ErrorDetails;
}

/** The sole application-outcome to public HTTP projection. */
export function projectApplicationError(error: ApplicationExpectedError): ApplicationErrorProjection {
  switch (error.code) {
    case ApplicationErrorCode.INTERNAL_ERROR:
      return { code: ErrorCode.INTERNAL_ERROR, status: 500, details: error.details };
    case ApplicationErrorCode.SESSION_NOT_FOUND:
      return { code: ErrorCode.SESSION_NOT_FOUND, status: 404 };
    case ApplicationErrorCode.SESSION_LIMIT_EXCEEDED:
      return { code: ErrorCode.SESSION_LIMIT_EXCEEDED, status: 503 };
    case ApplicationErrorCode.ALREADY_VOTED:
      return { code: ErrorCode.ALREADY_VOTED, status: 400 };
    case ApplicationErrorCode.SESSION_FINALIZED:
      return { code: ErrorCode.SESSION_FINALIZED, status: 400 };
    case ApplicationErrorCode.INVALID_COMMITMENT:
      return { code: ErrorCode.INVALID_COMMITMENT, status: 400 };
    case ApplicationErrorCode.DUPLICATE_VOTE:
      return {
        code: ErrorCode.DUPLICATE_VOTE,
        status: 409,
        message:
          error.details.duplicateKind === 'voteId'
            ? 'Vote ID already exists. This may be a system error. Please try again.'
            : 'This commitment has already been submitted. Please ensure your vote is unique.',
      };
    case ApplicationErrorCode.SESSION_ALREADY_FINALIZED:
      return { code: ErrorCode.SESSION_ALREADY_FINALIZED, status: 400 };
    case ApplicationErrorCode.USER_NOT_VOTED:
      return { code: ErrorCode.USER_NOT_VOTED, status: 400 };
    case ApplicationErrorCode.VOTING_NOT_COMPLETE:
      return { code: ErrorCode.VOTING_NOT_COMPLETE, status: 400 };
    case ApplicationErrorCode.INVALID_FINALIZATION_ARTIFACT:
      return { code: ErrorCode.INVALID_FINALIZATION_ARTIFACT, status: 500, details: error.details };
    case ApplicationErrorCode.VERIFICATION_FAILED:
      return { code: ErrorCode.VERIFICATION_FAILED, status: 400, details: error.details };
  }
}

/** Serialize and then runtime-admit the projected error against the exact route declaration. */
export async function respondWithApplicationError<TRoute extends ApiRouteContract>(
  route: TRoute,
  error: ApplicationExpectedError,
): Promise<RouteBoundResponse<TRoute>> {
  const projection = projectApplicationError(error);
  return admitRouteErrorResponse(
    route,
    errorResponse(new ApiError(projection.code, projection.status, projection.message, projection.details)),
  );
}
