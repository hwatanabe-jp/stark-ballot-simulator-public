import type { SessionData } from '@stark-ballot/domain/types/server';
import type { FinalizationTransitionMetadata } from '@stark-ballot/diagnostics/canonicalEvents';
import type { FinalizationExecutionId, FinalizationResultAuthority, FinalizationState } from './finalization-types';

export type FinalizationFailedError = Extract<FinalizationState, { status: 'failed' }>['error'];

export type FinalizationQueuedPayload = {
  executionId: FinalizationExecutionId;
  queuedAt: number;
  contractGeneration: string;
  observability?: FinalizationTransitionMetadata;
};

export type FinalizationRunningPayload = FinalizationQueuedPayload & {
  startedAt: number;
};

export type FinalizationSucceededPayload = FinalizationRunningPayload & {
  completedAt: number;
  finalizationResult: FinalizationResultAuthority;
};

export type FinalizationFailedPayload = FinalizationQueuedPayload & {
  startedAt?: number;
  failedAt: number;
  error: FinalizationFailedError;
};

export type FinalizationTimedOutPayload = FinalizationQueuedPayload & {
  startedAt?: number;
  timeoutAt: number;
};

export interface FinalizationLifecycleStore {
  finalizeSession(
    sessionId: string,
    result: FinalizationResultAuthority,
    contractGeneration: string,
    executionId: FinalizationExecutionId,
  ): Promise<void>;

  markFinalizationQueued(
    sessionId: string,
    payload: FinalizationQueuedPayload & {
      scenarioContext?: SessionData['finalizationScenarioContext'] | null;
    },
  ): Promise<FinalizationState>;

  markFinalizationRunning(
    sessionId: string,
    payload: FinalizationRunningPayload & {
      scenarioContext?: SessionData['finalizationScenarioContext'] | null;
    },
  ): Promise<FinalizationState>;

  markFinalizationSucceeded(sessionId: string, payload: FinalizationSucceededPayload): Promise<FinalizationState>;

  markFinalizationFailed(sessionId: string, payload: FinalizationFailedPayload): Promise<FinalizationState>;

  markFinalizationTimedOut(sessionId: string, payload: FinalizationTimedOutPayload): Promise<FinalizationState>;
}

export interface FinalizationReceiptBoardStore {
  finalizeSessionWithReceiptPublication?(
    sessionId: string,
    result: FinalizationResultAuthority,
    contractGeneration: string,
    receipt: { receipt: string; timestamp: number },
    executionId: FinalizationExecutionId,
  ): Promise<{ receiptHash: string; boardIndex: number }>;
}

export interface FinalizationArtifactMetadataStore {
  updateFinalizationArtifactMetadata(
    sessionId: string,
    metadata: {
      finalizationContractGeneration?: string;
      hasPersistedFinalizationBranch?: boolean;
      finalizationArtifactState?: SessionData['finalizationArtifactState'];
    },
  ): Promise<SessionData | void>;
}

export interface FinalizationBitmapData {
  sessionId: string;
  includedBitmap: boolean[];
  includedBitmapRoot: string;
  seenBitmap?: boolean[];
  seenBitmapRoot?: string;
  treeSize: number;
  finalizedAt: number;
}

export type FinalizationBitmapWrite = Omit<FinalizationBitmapData, 'sessionId'>;

export interface FinalizationBitmapStore {
  saveBitmapData?(sessionId: string, bitmapData: FinalizationBitmapWrite): Promise<void>;

  getBitmapData?(sessionId: string): Promise<FinalizationBitmapData | null>;
}

export type FinalizationStore = FinalizationLifecycleStore &
  FinalizationReceiptBoardStore &
  FinalizationBitmapStore &
  FinalizationArtifactMetadataStore;
