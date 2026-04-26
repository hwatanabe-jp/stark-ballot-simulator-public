export type DispatchPreconditionCode =
  | 'SESSION_NOT_FOUND'
  | 'SESSION_ID_MISMATCH'
  | 'FINALIZATION_STATE_MISSING'
  | 'EXECUTION_ID_MISMATCH'
  | 'FINALIZATION_NOT_PENDING';

export type DispatchSessionSnapshot = {
  sessionId: string;
  sessionContractGeneration?: string | null;
  finalizationContractGeneration?: string | null;
  finalizationArtifactState?: 'unsupported_current_artifact' | 'corrupt_or_unreadable' | null;
  finalizationState: {
    status: 'pending' | 'running' | 'succeeded' | 'failed' | 'timeout';
    executionId: string;
  } | null;
};

export type DispatchPreconditionResult = { ok: true } | { ok: false; code: DispatchPreconditionCode; message: string };

export function evaluateDispatchPreconditions(
  expected: {
    sessionId: string;
    executionId: string;
  },
  snapshot: DispatchSessionSnapshot | null,
): DispatchPreconditionResult {
  if (!snapshot) {
    return {
      ok: false,
      code: 'SESSION_NOT_FOUND',
      message: 'Session not found',
    };
  }

  if (snapshot.sessionId !== expected.sessionId) {
    return {
      ok: false,
      code: 'SESSION_ID_MISMATCH',
      message: 'Session ID mismatch',
    };
  }

  if (!snapshot.finalizationState) {
    return {
      ok: false,
      code: 'FINALIZATION_STATE_MISSING',
      message: 'Finalization state missing',
    };
  }

  if (snapshot.finalizationState.executionId !== expected.executionId) {
    return {
      ok: false,
      code: 'EXECUTION_ID_MISMATCH',
      message: 'Execution ID mismatch',
    };
  }

  if (snapshot.finalizationState.status !== 'pending') {
    return {
      ok: false,
      code: 'FINALIZATION_NOT_PENDING',
      message: `Finalization state must be pending before dispatch (actual: ${snapshot.finalizationState.status})`,
    };
  }

  return { ok: true };
}
