import { resolveSessionFinalizationArtifactState, type CurrentArtifactState } from '@stark-ballot/domain/contract';
import { hasConsistentFinalizationLocatorAuthority } from '@stark-ballot/aws-adapters/finalize/finalizationLocatorAuthority';
import { parseAwsPersistedFinalizationResult } from '@stark-ballot/aws-adapters/finalize/finalizationPersistenceEnvelope';
import type { SessionData } from '@stark-ballot/domain/types/server';
import type { AwsPersistedFinalizationResult } from '@stark-ballot/aws-adapters/finalize/finalizationPersistenceEnvelope';
import { ApiError, type ErrorCode } from '@stark-ballot/api-contract/errors/apiErrors';
import { errorResponse } from '../../http/response';
import { VerifyFailClosedResponseSchema } from '@stark-ballot/api-contract/validation/apiSchemas';
import { respondWithSchema } from './responseSchema';
import { describeCurrentArtifactError, resolveCurrentArtifactErrorCode } from './currentArtifactErrors';

export type UnsupportedFinalizedArtifactState = Exclude<CurrentArtifactState, 'supported'>;

export interface SupportedFinalizedReadResolution {
  artifactState: UnsupportedFinalizedArtifactState | null;
  finalizationResult: AwsPersistedFinalizationResult | null;
}

export function resolveUnsupportedSessionArtifactState(session: SessionData): UnsupportedFinalizedArtifactState | null {
  const artifactState = resolveSessionFinalizationArtifactState(session);
  if (!artifactState || artifactState === 'supported') {
    return null;
  }

  return artifactState;
}

export function resolveUnsupportedFinalizedArtifactState(
  session: SessionData,
): UnsupportedFinalizedArtifactState | null {
  if (!session.finalized) {
    return null;
  }

  return resolveUnsupportedSessionArtifactState(session);
}

export function resolveSupportedFinalizedRead(session: SessionData): SupportedFinalizedReadResolution {
  const artifactState = resolveUnsupportedFinalizedArtifactState(session);
  if (artifactState) {
    return {
      artifactState,
      finalizationResult: null,
    };
  }

  if (!session.finalized) {
    return {
      artifactState: null,
      finalizationResult: null,
    };
  }

  if (!session.finalizationResult) {
    return {
      artifactState: 'corrupt_or_unreadable',
      finalizationResult: null,
    };
  }

  const finalizationResult = parseAwsPersistedFinalizationResult(session.finalizationResult);
  if (!finalizationResult) {
    return {
      artifactState: 'corrupt_or_unreadable',
      finalizationResult: null,
    };
  }

  if (!hasConsistentFinalizationLocatorAuthority(session.sessionId, finalizationResult)) {
    return {
      artifactState: 'corrupt_or_unreadable',
      finalizationResult: null,
    };
  }

  return {
    artifactState: null,
    finalizationResult,
  };
}

export function buildUnsupportedFinalizedArtifactResponse(state: UnsupportedFinalizedArtifactState): Response {
  return errorResponse(resolveCurrentArtifactErrorCode(state), {
    details: describeCurrentArtifactError(state),
    artifactState: state,
  });
}

export function buildCurrentArtifactPayload(state: UnsupportedFinalizedArtifactState): {
  error: ErrorCode;
  message: string;
  artifactState: UnsupportedFinalizedArtifactState;
} {
  return {
    error: resolveCurrentArtifactErrorCode(state),
    message: describeCurrentArtifactError(state),
    artifactState: state,
  };
}

export function buildFailClosedVerifyResponse(state: UnsupportedFinalizedArtifactState): Response {
  return respondWithSchema(VerifyFailClosedResponseSchema, buildCurrentArtifactPayload(state), {
    status: 200,
    headers: {
      'Cache-Control': 'no-store',
    },
  });
}

export function buildFailClosedDownloadResponse(state: UnsupportedFinalizedArtifactState): Response {
  return errorResponse(
    new ApiError(resolveCurrentArtifactErrorCode(state), 404, describeCurrentArtifactError(state), {
      artifactState: state,
    }),
    undefined,
    {
      headers: {
        'Cache-Control': 'no-store',
      },
    },
  );
}
