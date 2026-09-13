import type { FinalizationTransitionMetadata } from '@stark-ballot/diagnostics/canonicalEvents';
import type { FinalizationRecord } from './finalization-record';
import type {
  FinalizationBitmapDisposition,
  FinalizationBitmapData,
  FinalizationId,
  FinalizationReceiptPublication,
  FinalizationResultAuthority,
  FinalizationScenarioContext,
  FinalizationState,
} from './finalization-types';
import type { VerificationResult } from '@stark-ballot/verification/shared/types';
import type { SessionId } from '@stark-ballot/domain/types/identifiers';
import type { FinalizationTransitionCommand } from './finalization-transition-policy';

export type FinalizationFailedError = Extract<FinalizationState, { status: 'failed' }>['error'];
export type FinalizationSucceededState = Extract<FinalizationState, { status: 'succeeded' }>;

export type FinalizationQueuedPayload = {
  finalizationId: FinalizationId;
  queuedAtMs: number;
  scenarioContext: FinalizationScenarioContext;
  observability?: FinalizationTransitionMetadata;
};

export type FinalizationRunningPayload = {
  finalizationId: FinalizationId;
  queuedAtMs: number;
  startedAtMs: number;
  scenarioContext?: FinalizationScenarioContext;
  observability?: FinalizationTransitionMetadata;
};

export type FinalizationSucceededPayload = {
  finalizationId: FinalizationId;
  queuedAtMs: number;
  startedAtMs: number;
  completedAtMs: number;
  scenarioContext?: FinalizationScenarioContext;
  finalizationResult: FinalizationResultAuthority;
  observability?: FinalizationTransitionMetadata;
};

export type FinalizationFailedPayload = {
  finalizationId: FinalizationId;
  queuedAtMs: number;
  startedAtMs?: number;
  failedAtMs: number;
  scenarioContext?: FinalizationScenarioContext;
  error: FinalizationFailedError;
  observability?: FinalizationTransitionMetadata;
};

export type FinalizationTimedOutPayload = {
  finalizationId: FinalizationId;
  queuedAtMs: number;
  startedAtMs?: number;
  timeoutAtMs: number;
  scenarioContext?: FinalizationScenarioContext;
  observability?: FinalizationTransitionMetadata;
};

/** Project lifecycle payloads into semantic commands without adapter metadata. */
export function buildFinalizationCommand(
  sessionId: SessionId,
  ...[kind, payload]:
    | [kind: 'queue', payload: FinalizationQueuedPayload]
    | [kind: 'start', payload: FinalizationRunningPayload]
    | [kind: 'succeed', payload: FinalizationSucceededPayload]
    | [kind: 'fail', payload: FinalizationFailedPayload]
    | [kind: 'time_out', payload: FinalizationTimedOutPayload]
): FinalizationTransitionCommand {
  const reason = payload.observability?.reason;
  const common = {
    sessionId,
    finalizationId: payload.finalizationId,
    queuedAtMs: payload.queuedAtMs,
    ...(payload.scenarioContext ? { scenarioContext: payload.scenarioContext } : {}),
    ...(reason ? { reason } : {}),
  };
  switch (kind) {
    case 'queue':
      return { ...common, kind, scenarioContext: payload.scenarioContext };
    case 'start':
      return { ...common, kind, startedAtMs: payload.startedAtMs };
    case 'succeed':
      return {
        ...common,
        kind,
        startedAtMs: payload.startedAtMs,
        completedAtMs: payload.completedAtMs,
        finalizationResult: payload.finalizationResult,
      };
    case 'fail': {
      const failure = {
        ...common,
        ...(payload.startedAtMs === undefined ? {} : { startedAtMs: payload.startedAtMs }),
        failedAtMs: payload.failedAtMs,
      };
      return payload.error.code === 'USER_CANCELLED'
        ? { ...failure, kind: 'cancel', message: payload.error.message }
        : { ...failure, kind, error: payload.error };
    }
    case 'time_out':
      return {
        ...common,
        kind,
        ...(payload.startedAtMs === undefined ? {} : { startedAtMs: payload.startedAtMs }),
        timeoutAtMs: payload.timeoutAtMs,
      };
  }
}

export function requestedFinalizationStatus(command: FinalizationTransitionCommand): FinalizationState['status'] {
  switch (command.kind) {
    case 'queue':
      return 'pending';
    case 'start':
      return 'running';
    case 'succeed':
      return 'succeeded';
    case 'fail':
    case 'cancel':
      return 'failed';
    case 'time_out':
      return 'timeout';
  }
}

/**
 * Application-facing lifecycle capability. Adapters implement these commands
 * through the revisioned transition coordinator and exact FinalizationRecord
 * persistence.
 */
export interface FinalizationLifecycleStore {
  getCurrentFinalizationRecord(sessionId: SessionId): Promise<FinalizationRecord | null>;

  getFinalizationRecord(sessionId: SessionId, finalizationId: FinalizationId): Promise<FinalizationRecord | null>;

  markFinalizationQueued(sessionId: SessionId, payload: FinalizationQueuedPayload): Promise<FinalizationRecord>;

  markFinalizationRunning(sessionId: SessionId, payload: FinalizationRunningPayload): Promise<FinalizationRecord>;

  markFinalizationSucceeded(sessionId: SessionId, payload: FinalizationSucceededPayload): Promise<FinalizationRecord>;

  markFinalizationFailed(sessionId: SessionId, payload: FinalizationFailedPayload): Promise<FinalizationRecord>;

  markFinalizationTimedOut(sessionId: SessionId, payload: FinalizationTimedOutPayload): Promise<FinalizationRecord>;
}

export interface SuccessfulFinalizationCommitInput {
  record: Extract<FinalizationRecord, { state: { status: 'succeeded' } }>;
  receipt?: { receipt: string; timestamp: number };
  bitmap: FinalizationBitmapDisposition;
  verificationResult?: VerificationResult;
  observability?: FinalizationTransitionMetadata;
}

export interface SuccessfulFinalizationCommitResult {
  record: Extract<FinalizationRecord, { state: { status: 'succeeded' } }>;
  bitmap: FinalizationBitmapDisposition;
  receiptPublication?: FinalizationReceiptPublication;
}

export interface SuccessfulFinalizationStore {
  commitSuccessfulFinalization(input: SuccessfulFinalizationCommitInput): Promise<SuccessfulFinalizationCommitResult>;
}

export type FinalizationBitmapRecord = FinalizationBitmapData & {
  sessionId: SessionId;
  finalizationId: FinalizationId;
};

export interface FinalizationBitmapStore {
  getBitmapData(sessionId: SessionId, finalizationId: FinalizationId): Promise<FinalizationBitmapRecord | null>;
}

export type FinalizationStore = FinalizationLifecycleStore & FinalizationBitmapStore & SuccessfulFinalizationStore;
