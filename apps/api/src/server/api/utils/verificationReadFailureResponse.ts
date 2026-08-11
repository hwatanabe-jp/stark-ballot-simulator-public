import { verificationRoute } from '@stark-ballot/api-contract/routes';
import type { VerificationReadFailure } from '@stark-ballot/application/verification/prepare-verification-read';
import { respondWithRoute } from './responseSchema';

function describeVerificationReadFailure(failure: VerificationReadFailure): string {
  switch (failure.reason) {
    case 'finalization_not_current':
      return 'Requested finalization is not the current finalized authority';
    case 'user_vote_unavailable':
      return 'User vote authority is unavailable for verification';
    case 'invalid_artifact':
      return 'Finalized verification authority is invalid';
    case 'incomplete_session_authority':
      return 'Session verification authority is incomplete';
    case 'session_identity_mismatch':
      return 'Session verification authority does not match the requested session';
    case 'voter_evidence_mismatch':
      return 'Recorded voter evidence does not match the current session authority';
  }
}

export function buildVerificationReadFailureResponse(
  finalizationId: string,
  failure: VerificationReadFailure,
): Response {
  const data =
    failure.availability === 'unavailable'
      ? {
          availability: failure.availability,
          finalizationId,
          reason: failure.reason,
          message: describeVerificationReadFailure(failure),
        }
      : {
          availability: failure.availability,
          finalizationId,
          reason: failure.reason,
          message: describeVerificationReadFailure(failure),
        };
  return respondWithRoute(
    verificationRoute,
    {
      status: 200,
      content: 'json',
      body: {
        data,
      },
    },
    {
      headers: {
        'Cache-Control': 'no-store',
      },
    },
  );
}
