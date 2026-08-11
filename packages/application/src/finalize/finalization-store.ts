import type { FinalizationTransitionMetadata } from '@stark-ballot/diagnostics/canonicalEvents';
import type { FinalizationRecord } from './finalization-record';
import type {
  FinalizationBitmapDisposition,
  FinalizationId,
  FinalizationReceiptPublication,
  FinalizationResultAuthority,
  FinalizationScenarioContext,
  FinalizationState,
} from './finalization-types';
import type { VerificationResult } from '@stark-ballot/verification/shared/types';

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

/**
 * Application-facing lifecycle capability. Adapters implement these commands
 * through the revisioned transition coordinator and exact FinalizationRecord
 * persistence.
 */
export interface FinalizationLifecycleStore {
  getCurrentFinalizationRecord(sessionId: string): Promise<FinalizationRecord | null>;

  getFinalizationRecord(sessionId: string, finalizationId: FinalizationId): Promise<FinalizationRecord | null>;

  markFinalizationQueued(sessionId: string, payload: FinalizationQueuedPayload): Promise<FinalizationRecord>;

  markFinalizationRunning(sessionId: string, payload: FinalizationRunningPayload): Promise<FinalizationRecord>;

  markFinalizationSucceeded(sessionId: string, payload: FinalizationSucceededPayload): Promise<FinalizationRecord>;

  markFinalizationFailed(sessionId: string, payload: FinalizationFailedPayload): Promise<FinalizationRecord>;

  markFinalizationTimedOut(sessionId: string, payload: FinalizationTimedOutPayload): Promise<FinalizationRecord>;
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

export interface FinalizationBitmapData {
  sessionId: string;
  finalizationId: FinalizationId;
  includedBitmap: boolean[];
  includedBitmapRoot: string;
  seenBitmap?: boolean[];
  seenBitmapRoot?: string;
  treeSize: number;
  finalizedAtMs: number;
}

export interface FinalizationBitmapStore {
  getBitmapData(sessionId: string, finalizationId: FinalizationId): Promise<FinalizationBitmapData | null>;
}

export type FinalizationStore = FinalizationLifecycleStore & FinalizationBitmapStore & SuccessfulFinalizationStore;
