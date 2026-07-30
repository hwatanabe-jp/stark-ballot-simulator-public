import type { FinalizationScenarioContext as DomainFinalizationScenarioContext } from '@stark-ballot/domain/types/server';
import type { VoteChoice } from '@stark-ballot/domain/shared/constants';
import type { CloseStatement, ElectionManifest } from '@stark-ballot/verification/public-audit-artifacts';
import type { ReceiptWithImageId } from '@stark-ballot/verification/image-id-types';
import type { SupportedPublicInputArtifact } from '@stark-ballot/verification/public-input';
import type { VerificationResult } from '@stark-ballot/verification/shared/types';
import type { ZkVMJournal } from '@stark-ballot/zkvm-contract/zkvm/types';

export type FinalizationScenarioContext = DomainFinalizationScenarioContext;
export type BitmapProofSource = 'mock' | 'real';

/**
 * Application-owned lifecycle identifier for one finalization attempt.
 * It gates stale async updates. Concrete delivery/runtime envelopes that carry
 * locators are owned by adapter/API/Lambda boundaries.
 */
export type FinalizationExecutionId = string;

export interface FinalizationTally {
  counts: Record<VoteChoice, number>;
  totalVotes: number;
  tamperedCount: number;
}

export interface FinalizationReceiptPublication {
  receiptHash: string;
  boardIndex: number;
  timestamp?: number;
}

export interface FinalizationBitmapData {
  includedBitmap: boolean[];
  includedBitmapRoot: string;
  seenBitmap?: boolean[];
  seenBitmapRoot?: string;
  treeSize: number;
  finalizedAt: number;
}

export interface FinalizationTamperSummary {
  ignoredVotes: number;
  recountedVotes: number;
  userRecountedTo: VoteChoice | null;
  affectedBotIds?: number[];
}

export const ApplicationErrorCode = {
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  SESSION_ALREADY_FINALIZED: 'SESSION_ALREADY_FINALIZED',
  USER_NOT_VOTED: 'USER_NOT_VOTED',
  VOTING_NOT_COMPLETE: 'VOTING_NOT_COMPLETE',
  UNSUPPORTED_CURRENT_ARTIFACT: 'UNSUPPORTED_CURRENT_ARTIFACT',
  CORRUPT_OR_UNREADABLE_FINALIZED_STATE: 'CORRUPT_OR_UNREADABLE_FINALIZED_STATE',
  VERIFICATION_FAILED: 'VERIFICATION_FAILED',
} as const;

export type ApplicationErrorCode = (typeof ApplicationErrorCode)[keyof typeof ApplicationErrorCode];

export type ApplicationErrorDetails = unknown;

export const FinalizationFailureCategory = {
  CONFIGURATION: 'configuration',
  INPUT: 'input',
  PROVER_EXECUTION: 'prover_execution',
  INFRASTRUCTURE_INTERRUPTION: 'infrastructure_interruption',
  IMAGE_SIGNATURE: 'image_signature',
  CAPACITY: 'capacity',
  ARTIFACT: 'artifact',
  UPLOAD: 'upload',
  TIMEOUT: 'timeout',
  UNKNOWN: 'unknown',
} as const;

export type FinalizationFailureCategory =
  (typeof FinalizationFailureCategory)[keyof typeof FinalizationFailureCategory];

export const PROVER_FAILURE_CATEGORY_VALUES = [
  FinalizationFailureCategory.CONFIGURATION,
  FinalizationFailureCategory.INPUT,
  FinalizationFailureCategory.PROVER_EXECUTION,
  FinalizationFailureCategory.INFRASTRUCTURE_INTERRUPTION,
  FinalizationFailureCategory.ARTIFACT,
  FinalizationFailureCategory.UPLOAD,
  FinalizationFailureCategory.TIMEOUT,
  FinalizationFailureCategory.UNKNOWN,
] as const;
export type ProverFailureCategory = (typeof PROVER_FAILURE_CATEGORY_VALUES)[number];

export type FinalizationState =
  | {
      status: 'pending';
      executionId: FinalizationExecutionId;
      queuedAt: number;
    }
  | {
      status: 'running';
      executionId: FinalizationExecutionId;
      queuedAt: number;
      startedAt: number;
    }
  | {
      status: 'succeeded';
      executionId: FinalizationExecutionId;
      queuedAt: number;
      startedAt: number;
      completedAt: number;
    }
  | {
      status: 'failed';
      executionId: FinalizationExecutionId;
      queuedAt: number;
      startedAt?: number;
      failedAt: number;
      error: {
        code: string;
        message: string;
        category?: FinalizationFailureCategory;
        details?: unknown;
      };
    }
  | {
      status: 'timeout';
      executionId: FinalizationExecutionId;
      queuedAt: number;
      startedAt?: number;
      timeoutAt: number;
    };

export interface FinalizationResultAuthority {
  tally: FinalizationTally;
  receipt?: ReceiptWithImageId;
  receiptPublication?: FinalizationReceiptPublication;
  imageId: string;
  journal: ZkVMJournal;
  publicInputArtifact?: SupportedPublicInputArtifact;
  electionManifest?: ElectionManifest;
  closeStatement?: CloseStatement;
  bitmapProofSource?: BitmapProofSource;
  bitmapData?: FinalizationBitmapData;
  verificationResult?: VerificationResult;
  tamperDetected?: boolean;
  scenarios?: string[];
  tamperSummary?: FinalizationTamperSummary;
}

export type VoteReceiptPayload = {
  voteId: string;
  commitment: string;
  bulletinIndex: number;
  bulletinRootAtCast: string;
  inputCommitment?: string;
  timestamp: number;
  signature?: string;
};

export type UserVotePayload = {
  commitment: string;
  voteId: string;
  proof: {
    leafIndex: number;
    merklePath: string[];
    treeSize: number;
    bulletinRootAtCast: string;
  };
};

export type FinalizeAcceptedPayload = {
  executionId: FinalizationExecutionId;
  state: FinalizationState;
};

export type FinalizeSyncPayload = {
  sessionId: string;
  verificationExecutionId: FinalizationExecutionId;
  finalizationResult: FinalizationResultAuthority;
  bulletinRoot: string;
  voteReceipt: VoteReceiptPayload;
  receipt: ReceiptWithImageId;
  receiptJournal: string;
  userVote: UserVotePayload;
  inputCommitment: string;
};
