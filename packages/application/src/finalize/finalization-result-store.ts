import type { VerificationReport, VerificationResult } from '@stark-ballot/verification/shared/types';
import type { FinalizationExecutionId } from './finalization-types';

export interface MarkVerificationRunningPayload {
  executionId: FinalizationExecutionId;
  report?: VerificationReport;
  verificationWorkQueuedAt?: string;
}

export interface RollbackVerificationResultPayload {
  executionId: FinalizationExecutionId;
}

export interface CompleteVerificationResultPayload {
  executionId: FinalizationExecutionId;
  verificationResult: VerificationResult;
}

export interface FinalizationResultStore {
  repairFinalizationResult(sessionId: string): Promise<void>;
  markVerificationRunning(sessionId: string, payload: MarkVerificationRunningPayload): Promise<void>;
  rollbackVerificationResult(sessionId: string, payload: RollbackVerificationResultPayload): Promise<void>;
  completeVerificationResult(sessionId: string, payload: CompleteVerificationResultPayload): Promise<void>;
}
