import { isCurrentContractGeneration, resolveCurrentContractGeneration } from './contractGeneration';
import { isSafeVerifierSegment } from '@/lib/finalize/finalize-urls';

export type CurrentArtifactState = 'supported' | 'unsupported_current_artifact' | 'corrupt_or_unreadable';
export type FailClosedCurrentArtifactState = Exclude<CurrentArtifactState, 'supported'>;
export type UnsupportedCurrentArtifactDetails = {
  runtimeContractGeneration: string;
  persistedContractGeneration: string | null;
  carriedContractGeneration: string | null;
};

export class UnsupportedCurrentArtifactBoundaryError extends Error {
  readonly artifactState = 'unsupported_current_artifact' as const;
  readonly code = 'UNSUPPORTED_CURRENT_ARTIFACT' as const;
  readonly details: UnsupportedCurrentArtifactDetails;

  constructor(details: UnsupportedCurrentArtifactDetails) {
    super('Current artifact is unsupported for the active contract generation');
    this.name = 'UnsupportedCurrentArtifactBoundaryError';
    this.details = details;
  }
}

export class CorruptOrUnreadableFinalizedStateBoundaryError extends Error {
  readonly artifactState = 'corrupt_or_unreadable' as const;
  readonly code = 'CORRUPT_OR_UNREADABLE_FINALIZED_STATE' as const;
  readonly details: UnsupportedCurrentArtifactDetails;

  constructor(details: UnsupportedCurrentArtifactDetails) {
    super('Finalized state is corrupt or unreadable for the active contract generation boundary');
    this.name = 'CorruptOrUnreadableFinalizedStateBoundaryError';
    this.details = details;
  }
}

export type CurrentArtifactBoundaryError =
  | UnsupportedCurrentArtifactBoundaryError
  | CorruptOrUnreadableFinalizedStateBoundaryError;

function hasPersistedContractGeneration(value: string | null | undefined): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isExplicitUnsupportedCurrentExecutionState(value: unknown): boolean {
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

function hasSafeSupportedVerificationExecutionId(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const record = value as {
    verificationExecutionId?: unknown;
  };

  return typeof record.verificationExecutionId === 'string' && isSafeVerifierSegment(record.verificationExecutionId);
}

export function hasSessionFinalizationBranch(session: {
  finalized: boolean;
  hasPersistedFinalizationBranch?: boolean;
  finalizationContractGeneration?: string | null;
  finalizationResult?: unknown;
  finalizationState?: unknown;
  finalizationScenarioContext?: unknown;
}): boolean {
  return (
    session.hasPersistedFinalizationBranch === true ||
    session.finalized ||
    session.finalizationContractGeneration != null ||
    session.finalizationResult != null ||
    session.finalizationState != null ||
    session.finalizationScenarioContext != null
  );
}

export function resolveAuthoritativeWriteContractGeneration(session: {
  finalized: boolean;
  hasPersistedFinalizationBranch?: boolean;
  contractGeneration?: string | null;
  finalizationContractGeneration?: string | null;
  finalizationResult?: unknown;
  finalizationState?: unknown;
  finalizationScenarioContext?: unknown;
}): string | null | undefined {
  return hasSessionFinalizationBranch(session) ? session.finalizationContractGeneration : session.contractGeneration;
}

export function buildUnsupportedCurrentArtifactDetails(
  session: {
    finalized: boolean;
    hasPersistedFinalizationBranch?: boolean;
    contractGeneration?: string | null;
    finalizationContractGeneration?: string | null;
    finalizationResult?: unknown;
    finalizationState?: unknown;
    finalizationScenarioContext?: unknown;
  },
  carriedContractGeneration?: string | null,
): UnsupportedCurrentArtifactDetails {
  return {
    runtimeContractGeneration: resolveCurrentContractGeneration(),
    persistedContractGeneration: resolveAuthoritativeWriteContractGeneration(session) ?? null,
    carriedContractGeneration: carriedContractGeneration ?? null,
  };
}

export function classifyLiveSessionContract(options: {
  finalized: boolean;
  contractGeneration?: string | null;
}): Exclude<CurrentArtifactState, 'corrupt_or_unreadable'> | null {
  if (options.finalized) {
    return null;
  }

  return isCurrentContractGeneration(options.contractGeneration) ? 'supported' : 'unsupported_current_artifact';
}

export function isUnsupportedLiveSessionContract(options: {
  finalized: boolean;
  contractGeneration?: string | null;
}): boolean {
  return classifyLiveSessionContract(options) === 'unsupported_current_artifact';
}

export function classifyFinalizedArtifactContract(options: {
  finalized: boolean;
  hasPersistedFinalizationBranch?: boolean;
  payloadReadable: boolean;
  persistedContractGeneration?: string | null;
  hasAuthoritativeFinalizationResult?: boolean;
}): CurrentArtifactState | null {
  const hasPersistedFinalizationBranch = options.hasPersistedFinalizationBranch ?? options.finalized;
  if (!hasPersistedFinalizationBranch) {
    return options.finalized ? 'corrupt_or_unreadable' : null;
  }

  if (!hasPersistedContractGeneration(options.persistedContractGeneration)) {
    return 'corrupt_or_unreadable';
  }

  if (!options.payloadReadable && isCurrentContractGeneration(options.persistedContractGeneration)) {
    return 'corrupt_or_unreadable';
  }

  if (options.finalized && options.hasAuthoritativeFinalizationResult === false) {
    return isCurrentContractGeneration(options.persistedContractGeneration)
      ? 'corrupt_or_unreadable'
      : 'unsupported_current_artifact';
  }

  return isCurrentContractGeneration(options.persistedContractGeneration)
    ? 'supported'
    : 'unsupported_current_artifact';
}

export function classifyAuthoritativeWriteContract(options: {
  persistedContractGeneration?: string | null;
  carriedContractGeneration?: string | null;
}): Exclude<CurrentArtifactState, 'corrupt_or_unreadable'> {
  if (!hasPersistedContractGeneration(options.persistedContractGeneration)) {
    return 'unsupported_current_artifact';
  }

  if (!isCurrentContractGeneration(options.persistedContractGeneration)) {
    return 'unsupported_current_artifact';
  }

  if (!hasPersistedContractGeneration(options.carriedContractGeneration)) {
    return 'unsupported_current_artifact';
  }

  return options.carriedContractGeneration === options.persistedContractGeneration
    ? 'supported'
    : 'unsupported_current_artifact';
}

export function isSupportedCurrentArtifactState(state: CurrentArtifactState | null | undefined): boolean {
  return state === 'supported';
}

export function isFailClosedCurrentArtifactState(state: unknown): state is FailClosedCurrentArtifactState {
  return state === 'unsupported_current_artifact' || state === 'corrupt_or_unreadable';
}

export function isUnsupportedCurrentArtifactBoundaryError(
  error: unknown,
): error is UnsupportedCurrentArtifactBoundaryError {
  return error instanceof UnsupportedCurrentArtifactBoundaryError;
}

export function isCorruptOrUnreadableFinalizedStateBoundaryError(
  error: unknown,
): error is CorruptOrUnreadableFinalizedStateBoundaryError {
  return error instanceof CorruptOrUnreadableFinalizedStateBoundaryError;
}

export function isCurrentArtifactBoundaryError(error: unknown): error is CurrentArtifactBoundaryError {
  return isUnsupportedCurrentArtifactBoundaryError(error) || isCorruptOrUnreadableFinalizedStateBoundaryError(error);
}

export function resolveSessionFinalizationArtifactState(session: {
  finalized: boolean;
  hasPersistedFinalizationBranch?: boolean;
  contractGeneration?: string | null;
  finalizationContractGeneration?: string | null;
  finalizationArtifactState?: CurrentArtifactState | null;
  finalizationResult?: unknown;
  finalizationState?: unknown;
  finalizationScenarioContext?: unknown;
}): CurrentArtifactState | null {
  if (isFailClosedCurrentArtifactState(session.finalizationArtifactState)) {
    return session.finalizationArtifactState;
  }

  if (isExplicitUnsupportedCurrentExecutionState(session.finalizationState)) {
    return 'unsupported_current_artifact';
  }

  const classified = classifyFinalizedArtifactContract({
    finalized: session.finalized,
    hasPersistedFinalizationBranch: hasSessionFinalizationBranch(session),
    payloadReadable:
      session.finalizationResult != null ||
      session.finalizationState != null ||
      session.finalizationScenarioContext != null,
    persistedContractGeneration: session.finalizationContractGeneration,
    hasAuthoritativeFinalizationResult: session.finalized ? session.finalizationResult != null : undefined,
  });

  if (
    classified === 'supported' &&
    session.finalized &&
    !hasSafeSupportedVerificationExecutionId(session.finalizationResult)
  ) {
    return 'corrupt_or_unreadable';
  }

  return classified;
}

export function isRecoverableCurrentLiveSession(session: {
  finalized: boolean;
  hasPersistedFinalizationBranch?: boolean;
  contractGeneration?: string | null;
  finalizationContractGeneration?: string | null;
  finalizationArtifactState?: CurrentArtifactState | null;
  finalizationResult?: unknown;
  finalizationState?: unknown;
  finalizationScenarioContext?: unknown;
}): boolean {
  if (session.finalized || !isCurrentContractGeneration(session.contractGeneration)) {
    return false;
  }

  const artifactState = resolveSessionFinalizationArtifactState(session);
  return artifactState === null || artifactState === 'supported';
}
