import type { VoteChoice } from '@stark-ballot/domain/shared/constants';
import type { ScenarioTamperMode } from '@stark-ballot/domain/types/scenario';
import type { CloseStatement, ElectionManifest } from '@stark-ballot/verification/public-audit-artifacts';
import type { ReceiptWithImageId } from '@stark-ballot/verification/image-id-types';
import type { SupportedPublicInputArtifact } from '@stark-ballot/verification/public-input';
import type { VerificationResult } from '@stark-ballot/verification/shared/types';
import type { ZkVMJournal } from '@stark-ballot/zkvm-contract/zkvm/types';
import type { SessionId } from '@stark-ballot/domain/types/identifiers';

export interface FinalizationScenarioContext {
  scenarios: string[];
  tamperMode: ScenarioTamperMode;
  claimedCounts: Record<VoteChoice, number>;
  claimedTotalVotes: number;
  summary: {
    ignoredCount: number;
    recountedCount: number;
    userRecountChoice: VoteChoice | null;
    affectedBotIds?: number[];
  };
}
export type BitmapProofSource = 'mock' | 'real';

/**
 * Application-owned lifecycle identifier for one finalization attempt.
 * It gates stale async updates. Concrete delivery/runtime envelopes that carry
 * locators are owned by adapter/API/Lambda boundaries.
 */
declare const finalizationIdBrand: unique symbol;

export type FinalizationId = string & {
  readonly [finalizationIdBrand]: 'FinalizationId';
};

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

interface FinalizationBitmapDataBase {
  includedBitmap: boolean[];
  includedBitmapRoot: string;
  treeSize: number;
  finalizedAtMs: number;
}

export type FinalizationSeenBitmapEvidence =
  | { seenBitmap?: never; seenBitmapRoot?: never }
  | { seenBitmap: boolean[]; seenBitmapRoot: string };

export type FinalizationBitmapData = FinalizationBitmapDataBase & FinalizationSeenBitmapEvidence;

export type FinalizationBitmapDisposition =
  | { availability: 'available'; data: FinalizationBitmapData }
  | { availability: 'unavailable' };

export interface FinalizationTamperSummary {
  ignoredVotes: number;
  recountedVotes: number;
  userRecountedTo: VoteChoice | null;
  affectedBotIds?: number[];
}

export type FinalizationPublicAuditArtifactsState =
  | {
      availability: 'unavailable';
    }
  | {
      availability: 'available';
      publicInputArtifact: SupportedPublicInputArtifact;
      electionManifest: ElectionManifest;
      closeStatement: CloseStatement;
    };

export type FinalizationReceiptState =
  | {
      availability: 'unavailable';
    }
  | {
      availability: 'available';
      receipt: ReceiptWithImageId;
    };

export type FinalizationReceiptPublicationState =
  | {
      availability: 'unavailable';
    }
  | {
      availability: 'available';
      publication: FinalizationReceiptPublication;
    };

export type FinalizationBitmapEvidenceState =
  | {
      availability: 'unavailable';
    }
  | {
      availability: 'available';
      proofSource: BitmapProofSource;
      data: FinalizationBitmapData;
    };

export interface FinalizationArtifactAvailability {
  publicAudit: FinalizationPublicAuditArtifactsState;
  receipt: FinalizationReceiptState;
  receiptPublication: FinalizationReceiptPublicationState;
  bitmap: FinalizationBitmapEvidenceState;
}

export function createUnavailableFinalizationArtifacts(): FinalizationArtifactAvailability {
  return {
    publicAudit: { availability: 'unavailable' },
    receipt: { availability: 'unavailable' },
    receiptPublication: { availability: 'unavailable' },
    bitmap: { availability: 'unavailable' },
  };
}

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

export interface FinalizationPendingState {
  status: 'pending';
  finalizationId: FinalizationId;
  queuedAtMs: number;
}

export interface FinalizationRunningState {
  status: 'running';
  finalizationId: FinalizationId;
  queuedAtMs: number;
  startedAtMs: number;
}

export interface FinalizationSucceededState {
  status: 'succeeded';
  finalizationId: FinalizationId;
  queuedAtMs: number;
  startedAtMs: number;
  completedAtMs: number;
}

export interface FinalizationFailedState {
  status: 'failed';
  finalizationId: FinalizationId;
  queuedAtMs: number;
  startedAtMs?: number;
  failedAtMs: number;
  error: {
    code: string;
    message: string;
    category?: FinalizationFailureCategory;
    details?: unknown;
  };
}

export interface FinalizationTimeoutState {
  status: 'timeout';
  finalizationId: FinalizationId;
  queuedAtMs: number;
  startedAtMs?: number;
  timeoutAtMs: number;
}

export type FinalizationState =
  | FinalizationPendingState
  | FinalizationRunningState
  | FinalizationSucceededState
  | FinalizationFailedState
  | FinalizationTimeoutState;

export interface FinalizationResultAuthority {
  tally: FinalizationTally;
  imageId: string;
  journal: ZkVMJournal;
  artifacts: FinalizationArtifactAvailability;
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
  finalizationId: FinalizationId;
  state: FinalizationState;
};

export type FinalizeSyncPayload = {
  sessionId: SessionId;
  finalizationId: FinalizationId;
  state: Extract<FinalizationState, { status: 'succeeded' }>;
  finalizationResult: FinalizationResultAuthority;
  verificationResult: VerificationResult;
  bitmapDisposition: FinalizationBitmapDisposition;
  bulletinRoot: string;
  voteReceipt: VoteReceiptPayload;
  receipt: ReceiptWithImageId;
  receiptJournal: string;
  userVote: UserVotePayload;
  inputCommitment: string;
};
