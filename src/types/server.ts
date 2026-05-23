import type { VoteChoice } from '@/shared/constants';
import type { FailClosedCurrentArtifactState } from '@/lib/contract/currentArtifact';
import type { ZkVMJournal } from '@/lib/zkvm/types';
import type { ReceiptWithImageId } from '@/lib/verification/image-id-types';
import type { CloseStatement, ElectionManifest } from '@/lib/verification/public-audit-artifacts';
import type { SupportedPublicInputArtifact } from '@/lib/verification/public-input-contract';
import type { ElectionConfig } from '@/lib/zkvm/election-config';
import type { SimpleBulletinBoard } from '@/lib/bulletin/simple-bulletin-board';
import type { ScenarioTamperMode } from '@/types/scenario';

export type VerificationStatus = 'success' | 'failed' | 'dev_mode' | 'not_run' | 'running';

export interface VerificationReport {
  [key: string]: unknown;
  status: VerificationStatus;
  verifier_version: string;
  verified_at: string;
  duration_ms: number;
  expected_image_id: string;
  receipt_image_id: string | null;
  bundle_path: string;
  receipt_path: string;
  dev_mode_receipt: boolean;
  errors?: string[];
}

export interface VerificationResult {
  status: VerificationStatus;
  report?: VerificationReport;
  /** Durable S3 bundle key for authenticated delivery selectors. */
  s3BundleKey?: string;
  /** Durable S3 report key for authenticated delivery selectors. */
  s3ReportKey?: string;
  s3UploadedAt?: string;
  executionId?: string;
}

export interface PublicVerificationReport {
  status: VerificationStatus;
  verifier_version?: string;
  verified_at?: string;
  duration_ms?: number;
  expected_image_id?: string;
  receipt_image_id?: string | null;
  dev_mode_receipt?: boolean;
  errors?: string[];
}

export interface PublicVerificationResult {
  status: VerificationStatus;
  report?: PublicVerificationReport;
  executionId?: string;
}

export type BitmapProofSource = 'mock' | 'real';

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

export interface FinalizationResultAuthority {
  tally: FinalizationTally;
  /** Durable S3 verification bundle key metadata. */
  s3BundleKey?: string;
  s3UploadedAt?: string;
  /** Canonical zkVM receipt with ImageID binding (S3から復元される場合あり) */
  receipt?: ReceiptWithImageId;
  /** Raw zkVM receipt payload as produced by the host (S3から復元される場合あり) */
  receiptRaw?: unknown;
  /** Publication metadata when receipt stored on bulletin board */
  receiptPublication?: FinalizationReceiptPublication;
  /** Host-provided Image ID claim; comparison-only until verifier confirms receipt_image_id. */
  imageId: string;
  /** Presentation-only tamper signal derived from scenario state plus canonical journal counts. */
  tamperDetected?: boolean;
  /** Presentation-only scenario metadata; intentionally not proof-derived cache data. */
  scenarios?: string[];
  /**
   * Canonical proof-bound journal payload.
   * This is the only internal authority for journal-derived proof outputs.
   */
  journal: ZkVMJournal;
  /** Normalized input-side authority from the supported public-input artifact. */
  publicInputArtifact?: SupportedPublicInputArtifact;
  /** Election-config-derived public artifact used for verifier cross-checks. */
  electionManifest?: ElectionManifest;
  /** Hybrid input+journal public artifact used for verifier cross-checks. */
  closeStatement?: CloseStatement;
  /** Indicates bitmap proof source reliability */
  bitmapProofSource?: BitmapProofSource;
  /** Bitmap proof data for inclusion checks (server-side storage only) */
  bitmapData?: FinalizationBitmapData;
  verificationResult?: VerificationResult;
  verificationExecutionId?: string;
  tamperSummary?: FinalizationTamperSummary;
}

/**
 * Transitional compatibility shape still accepted at loose boundaries like
 * tests and browser-local caches. Internal server/storage authority should use
 * `FinalizationResultAuthority` instead.
 */
export interface FinalizationResult {
  tally: FinalizationTally;
  /** S3 verification bundle metadata */
  s3BundleUrl?: string;
  s3BundleKey?: string;
  s3UploadedAt?: string;
  s3BundleExpiresAt?: string;
  /** Canonical zkVM receipt with ImageID binding (S3から復元される場合あり) */
  receipt?: ReceiptWithImageId;
  /** Raw zkVM receipt payload as produced by the host (S3から復元される場合あり) */
  receiptRaw?: unknown;
  /** Publication metadata when receipt stored on bulletin board */
  receiptPublication?: FinalizationReceiptPublication;
  /** Host-provided Image ID claim; comparison-only until verifier confirms receipt_image_id. */
  imageId: string;
  /** Transitional top-level mirror of journal.verifiedTally for compatibility. */
  verifiedTally?: number[];
  tamperDetected?: boolean;
  scenarios?: string[];
  /**
   * Canonical proof-bound journal payload.
   * Journal-derived fields below are compatibility cache mirrors and must match this object.
   */
  journal?: ZkVMJournal;
  /** Transitional normalized input-side authority used during in-memory compatibility handling. */
  publicInputArtifact?: SupportedPublicInputArtifact;
  /** Election-config-derived public artifact used for verifier cross-checks. */
  electionManifest?: ElectionManifest;
  /** Hybrid input+journal public artifact used for verifier cross-checks. */
  closeStatement?: CloseStatement;
  /** Indicates bitmap proof source reliability */
  bitmapProofSource?: BitmapProofSource;
  /** Bitmap proof data for inclusion checks (server-side storage only) */
  bitmapData?: FinalizationBitmapData;
  /**
   * Transitional top-level mirrors of canonical journal values.
   * These fields remain for compatibility and must stay aligned with `journal`.
   */
  bulletinRoot?: string;
  sthDigest?: string;
  seenBitmapRoot?: string;
  includedBitmapRoot?: string;
  seenIndicesCount?: number;
  /** SHA-256 hash of the zkVM input for tamper-evident verification */
  inputCommitment?: string;
  /**
   * Current top-level count mirrors follow the v14 slot/record split.
   * `missingSlots`, `invalidPresentedSlots`, `rejectedRecords`, and
   * `excludedSlots` are the authoritative public mirrors of the journal.
   */
  missingSlots?: number;
  invalidPresentedSlots?: number;
  rejectedRecords?: number;
  excludedSlots?: number;
  /**
   * Legacy aliases retained for compatibility inside the app.
   * They now mirror slot-based public fields instead of the old mixed-unit
   * semantics and must stay aligned with the authoritative fields above.
   */
  /** Index-based count of bulletin indices not presented to the guest. */
  missingIndices?: number;
  /** Slot-based count of presented in-range indices that still failed counting. */
  invalidIndices?: number;
  /** Record-based count of presented records successfully counted. */
  countedIndices?: number;
  totalExpected?: number;
  treeSize?: number;
  /** Legacy alias of the authoritative slot-based `excludedSlots` signal. */
  excludedCount?: number;
  verificationResult?: VerificationResult;
  verificationExecutionId?: string;
  tamperSummary?: FinalizationTamperSummary;
}

export interface FinalizationResultPublicProjection {
  tally: FinalizationTally;
  /** Publication metadata when receipt stored on bulletin board */
  receiptPublication?: FinalizationReceiptPublication;
  /** Host-provided Image ID claim; comparison-only until verifier confirms receipt_image_id. */
  imageId: string;
  tamperDetected?: boolean;
  scenarios?: string[];
  /**
   * Canonical proof-bound journal payload used by public verification flows.
   * Server-only fields such as `receiptRaw` and `bitmapData` are intentionally omitted.
   */
  journal: ZkVMJournal;
  electionManifest?: ElectionManifest;
  closeStatement?: CloseStatement;
  bitmapProofSource?: BitmapProofSource;
  verificationResult?: PublicVerificationResult;
  verificationExecutionId?: string;
  tamperSummary?: FinalizationTamperSummary;
  bulletinRoot: string;
  verifiedTally: number[];
  missingSlots: number;
  invalidPresentedSlots: number;
  rejectedRecords: number;
  totalExpected: number;
  treeSize: number;
  excludedSlots: number;
  sthDigest: string;
  seenBitmapRoot?: string;
  includedBitmapRoot: string;
  inputCommitment: string;
  seenIndicesCount: number;
}

/**
 * Data structure for individual votes in the STARK Ballot Simulator system
 */
export interface VoteData {
  /** Unique vote identifier (UUID v4) for tracking and auditing */
  voteId?: string;
  /** The voter's choice (A, B, C, D, or E) */
  vote: VoteChoice;
  /** Random value used in commitment generation */
  rand: string;
  /** Domain-separated SHA-256 commitment (v1.0) */
  commit: string;
  /** Merkle tree path for inclusion proof */
  path: string[];
  /** Unix timestamp when the vote was cast */
  timestamp?: number;
  /** Bulletin board root snapshot at the moment of casting */
  rootAtCast?: string;
  /** Tree size associated with the proof (required for CT proofs) */
  treeSize?: number;
}

/**
 * Root snapshot for bulletin board history tracking
 */
export interface RootSnapshot {
  timestamp: number;
  root: string;
  treeSize: number;
  signature?: string;
}

export interface SessionData {
  sessionId: string;
  contractGeneration?: string;
  finalizationContractGeneration?: string;
  hasPersistedFinalizationBranch?: boolean;
  finalizationArtifactState?: FailClosedCurrentArtifactState;
  /** Election identifier (UUID v4) for this voting session */
  electionId?: string;
  /** Hash of election configuration (includes totalExpected) */
  electionConfigHash?: string;
  /** Canonical election configuration when available for manifest generation */
  electionConfig?: ElectionConfig;
  /** Log identifier for bulletin board (RFC 6962) */
  logId?: string;
  votes: Map<number, VoteData>;
  /** Public bulletin board for recording all vote commitments */
  bulletin?: SimpleBulletinBoard;
  botCount: number;
  finalized: boolean;
  createdAt: number;
  lastActivity: number;
  userVoteIndex?: number;
  /** History of Merkle root snapshots for append-only verification */
  bulletinRootHistory?: RootSnapshot[];
  finalizationResult?: FinalizationResultAuthority;

  /**
   * Async finalize state machine (pending → running → terminal).
   */
  finalizationState?: FinalizationState;

  /**
   * Scenario context persisted during async finalization (claimed tally, summary, mode).
   */
  finalizationScenarioContext?: FinalizationScenarioContext;
}

/**
 * Async finalization lifecycle captured on each session.
 */
export type FinalizationState =
  | {
      status: 'pending';
      executionId: string;
      queuedAt: number;
      stepFunctionsArn?: string;
    }
  | {
      status: 'running';
      executionId: string;
      queuedAt: number;
      startedAt: number;
      stepFunctionsArn?: string;
    }
  | {
      status: 'succeeded';
      executionId: string;
      queuedAt: number;
      startedAt: number;
      completedAt: number;
      stepFunctionsArn?: string;
      bundleMetadata?: {
        s3BundleKey?: string;
        s3UploadedAt?: string;
      };
    }
  | {
      status: 'failed';
      executionId: string;
      queuedAt: number;
      startedAt?: number;
      failedAt: number;
      error: {
        code: string;
        message: string;
        details?: unknown;
      };
      stepFunctionsArn?: string;
    }
  | {
      status: 'timeout';
      executionId: string;
      queuedAt: number;
      startedAt?: number;
      timeoutAt: number;
      stepFunctionsArn?: string;
    };

export type FinalizationStoragePayload = {
  contractGeneration: string;
  finalizationResult: FinalizationResultAuthority | null;
  finalizationState: FinalizationState | null;
  finalizationScenarioContext?: FinalizationScenarioContext | null;
};

export interface AddVoteResult {
  leafIndex: number;
  merklePath: string[];
  bulletinRootAtCast: string;
}
