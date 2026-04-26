import {
  buildUnsupportedCurrentArtifactDetails,
  CorruptOrUnreadableFinalizedStateBoundaryError,
  hasConsistentFinalizationLocatorAuthority,
  hasSessionFinalizationBranch,
  isFailClosedCurrentArtifactState,
  resolveSessionFinalizationArtifactState,
  UnsupportedCurrentArtifactBoundaryError,
} from '@/lib/contract';
import type { FinalizationState, SessionData } from '@/types/server';

function hasOwnPatchKey<T extends object>(value: T, key: keyof T): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function hasCorruptFinalizationLocatorAuthority(
  session:
    | (Pick<SessionData, 'finalizationResult'> & {
        sessionId?: string;
      })
    | null
    | undefined,
): boolean {
  if (!session?.finalizationResult) {
    return false;
  }

  return (
    typeof session.sessionId !== 'string' ||
    !hasConsistentFinalizationLocatorAuthority(session.sessionId, session.finalizationResult)
  );
}

export function isFinalizationBranchPatch(data: Partial<SessionData>): boolean {
  return (
    hasOwnPatchKey(data, 'finalizationResult') ||
    hasOwnPatchKey(data, 'finalizationState') ||
    hasOwnPatchKey(data, 'finalizationScenarioContext') ||
    hasOwnPatchKey(data, 'finalized') ||
    hasOwnPatchKey(data, 'finalizationContractGeneration') ||
    hasOwnPatchKey(data, 'finalizationArtifactState')
  );
}

export function canRecoverFinalizationArtifactWithPatch(
  session: SessionData | null | undefined,
  patch: Partial<SessionData>,
): boolean {
  if (!session || !isFinalizationBranchPatch(patch)) {
    return false;
  }

  const prospectiveSession = {
    ...session,
    ...patch,
    finalizationState: hasOwnPatchKey(patch, 'finalizationState')
      ? patch.finalizationState
      : isUnsupportedCurrentFinalizationState(session.finalizationState)
        ? undefined
        : session.finalizationState,
    finalizationArtifactState: undefined,
  };
  const recoveredState = resolveSessionFinalizationArtifactState(prospectiveSession);

  if (recoveredState !== null && recoveredState !== 'supported') {
    return false;
  }

  if (hasCorruptFinalizationLocatorAuthority(prospectiveSession)) {
    return false;
  }

  return true;
}

export function assertWritableFinalizationArtifact(
  session: SessionData | null | undefined,
  carriedContractGeneration?: string,
): void {
  if (!session) {
    return;
  }

  const artifactState = resolveSessionFinalizationArtifactState(session);
  if (artifactState === 'unsupported_current_artifact') {
    throw new UnsupportedCurrentArtifactBoundaryError(
      buildUnsupportedCurrentArtifactDetails(session, carriedContractGeneration),
    );
  }
  if (artifactState === 'corrupt_or_unreadable') {
    throw new CorruptOrUnreadableFinalizedStateBoundaryError(
      buildUnsupportedCurrentArtifactDetails(session, carriedContractGeneration),
    );
  }

  if (hasCorruptFinalizationLocatorAuthority(session)) {
    throw new CorruptOrUnreadableFinalizedStateBoundaryError(
      buildUnsupportedCurrentArtifactDetails(session, carriedContractGeneration),
    );
  }
}

export function assertAdmissibleFinalizationArtifactPatch(
  session: SessionData | null | undefined,
  patch: Partial<SessionData>,
  carriedContractGeneration?: string,
): void {
  const prospectiveSession = {
    finalized: false,
    ...(session ?? {}),
    ...patch,
    finalizationArtifactState: undefined,
  };
  const artifactState = resolveSessionFinalizationArtifactState(prospectiveSession);

  if (artifactState === 'unsupported_current_artifact') {
    throw new UnsupportedCurrentArtifactBoundaryError(
      buildUnsupportedCurrentArtifactDetails(prospectiveSession, carriedContractGeneration),
    );
  }

  if (artifactState === 'corrupt_or_unreadable') {
    throw new CorruptOrUnreadableFinalizedStateBoundaryError(
      buildUnsupportedCurrentArtifactDetails(prospectiveSession, carriedContractGeneration),
    );
  }

  if (hasCorruptFinalizationLocatorAuthority(prospectiveSession)) {
    throw new CorruptOrUnreadableFinalizedStateBoundaryError(
      buildUnsupportedCurrentArtifactDetails(prospectiveSession, carriedContractGeneration),
    );
  }
}

export function clearRecoveredFinalizationArtifactState(
  session: SessionData | null | undefined,
  patch: Partial<SessionData>,
): void {
  if (!session || !isFinalizationBranchPatch(patch)) {
    return;
  }

  if (
    hasOwnPatchKey(patch, 'finalizationArtifactState') &&
    isFailClosedCurrentArtifactState(patch.finalizationArtifactState)
  ) {
    return;
  }

  if (!isFailClosedCurrentArtifactState(session.finalizationArtifactState)) {
    if (
      hasOwnPatchKey(patch, 'finalizationState') ||
      !isUnsupportedCurrentFinalizationState(session.finalizationState)
    ) {
      return;
    }
  }

  if (canRecoverFinalizationArtifactWithPatch(session, patch)) {
    delete session.finalizationArtifactState;
    if (
      !hasOwnPatchKey(patch, 'finalizationState') &&
      isUnsupportedCurrentFinalizationState(session.finalizationState)
    ) {
      delete session.finalizationState;
    }
  }
}

export function assertWritableBitmapSidecarOwner(
  session: SessionData | null | undefined,
): asserts session is SessionData & {
  finalizationResult: NonNullable<SessionData['finalizationResult']>;
} {
  assertWritableFinalizationArtifact(session);

  if (!session) {
    throw new Error('Session not found');
  }

  if (!hasSessionFinalizationBranch(session) || !session.finalizationResult) {
    throw new Error('Session finalization wrapper is not available');
  }
}

type FinalizationWritePayload = {
  executionId: string;
  queuedAt: number;
  contractGeneration?: string;
  startedAt?: number;
  stepFunctionsArn?: string;
};

export function isUnsupportedCurrentFinalizationState(
  value: unknown,
): value is Extract<FinalizationState, { status: 'failed' }> {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const record = value as {
    status?: unknown;
    error?: {
      code?: unknown;
    };
  };

  return record.status === 'failed' && record.error?.code === 'UNSUPPORTED_CURRENT_ARTIFACT';
}

export function resolveFailClosedFinalizationArtifactState(
  session: SessionData | null | undefined,
): SessionData['finalizationArtifactState'] | null {
  if (!session) {
    return null;
  }

  if (hasCorruptFinalizationLocatorAuthority(session)) {
    return 'corrupt_or_unreadable';
  }

  const artifactState = resolveSessionFinalizationArtifactState(session);
  return isFailClosedCurrentArtifactState(artifactState) ? artifactState : null;
}

export function buildFailClosedFinalizationState(
  session: SessionData,
  payload: FinalizationWritePayload,
  artifactState: NonNullable<SessionData['finalizationArtifactState']>,
  failedAt: number,
): FinalizationState {
  const currentState = session.finalizationState;
  const executionId = currentState?.executionId ?? payload.executionId;
  const queuedAt = currentState?.queuedAt ?? payload.queuedAt;
  const startedAt =
    currentState?.status === 'running' ||
    currentState?.status === 'succeeded' ||
    currentState?.status === 'failed' ||
    currentState?.status === 'timeout'
      ? currentState.startedAt
      : payload.startedAt;
  const stepFunctionsArn = currentState?.stepFunctionsArn ?? payload.stepFunctionsArn;
  const details = buildUnsupportedCurrentArtifactDetails(session, payload.contractGeneration);

  return {
    status: 'failed',
    executionId,
    queuedAt,
    ...(startedAt !== undefined ? { startedAt } : {}),
    failedAt,
    error: {
      code:
        artifactState === 'unsupported_current_artifact'
          ? 'UNSUPPORTED_CURRENT_ARTIFACT'
          : 'CORRUPT_OR_UNREADABLE_FINALIZED_STATE',
      message:
        artifactState === 'unsupported_current_artifact'
          ? 'Finalization execution no longer matches the current contract generation'
          : 'Finalization state is corrupt or unreadable for the current contract generation',
      details,
    },
    ...(stepFunctionsArn ? { stepFunctionsArn } : {}),
  };
}
