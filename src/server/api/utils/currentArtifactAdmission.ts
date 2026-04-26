import {
  hasConsistentFinalizationLocatorAuthority,
  resolveSessionFinalizationArtifactState,
  type CurrentArtifactState,
} from '@/lib/contract';
import { canonicalizeFinalizationResult } from '@/lib/finalize/finalization-result';
import type { SessionData } from '@/types/server';
import type { FinalizationResultAuthority } from '@/types/server';
import type { ErrorCode } from '@/lib/errors/apiErrors';
import { errorResponse, jsonResponse } from '@/server/http/response';
import { describeCurrentArtifactError, resolveCurrentArtifactErrorCode } from './currentArtifactErrors';

export type UnsupportedFinalizedArtifactState = Exclude<CurrentArtifactState, 'supported'>;

export interface SupportedFinalizedReadResolution {
  artifactState: UnsupportedFinalizedArtifactState | null;
  finalizationResult: FinalizationResultAuthority | null;
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

  const finalizationResult = canonicalizeFinalizationResult(
    session.finalizationResult,
    session.finalizationScenarioContext,
  );
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
  return jsonResponse(buildCurrentArtifactPayload(state), {
    status: 200,
    headers: {
      'Cache-Control': 'no-store',
    },
  });
}

export function buildFailClosedDownloadResponse(state: UnsupportedFinalizedArtifactState): Response {
  return jsonResponse(buildCurrentArtifactPayload(state), {
    status: 404,
    headers: {
      'Cache-Control': 'no-store',
    },
  });
}
