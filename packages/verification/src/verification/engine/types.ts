import type { VerificationStepStatus } from '../step-types';
import type { VoteReceipt } from '@stark-ballot/verification/shared/types';
import type { VoteChoice } from '@stark-ballot/verification/shared/constants';
import type { ZkVMJournal } from '@stark-ballot/zkvm-contract/zkvm/types';
import type { ConsistencyProof } from '@stark-ballot/merkle/consistency-proof';
import type { BitmapProofSource } from '@stark-ballot/verification/shared/types';
import type { SupportedPublicInputArtifact } from '@stark-ballot/verification/public-input';
import type { CloseStatement, ElectionManifest } from '@stark-ballot/verification/public-audit-artifacts';
import type { BitmapProofProvider } from '../bitmap-verifier';
import type { SthVerificationResult } from '../sth-verifier';
import type { VerificationStatus } from '@stark-ballot/verification/shared/types';
import type { VerificationCheckNoteKey } from '../verification-checks';

export type { VerificationStatus };

export interface UserVoteInput {
  vote?: VoteChoice;
  random?: string;
  commitment?: string;
  voteId?: string;
  proof?: {
    leafIndex?: number;
    treeSize?: number;
    merklePath?: string[];
    bulletinRootAtCast?: string;
  };
}

export interface BulletinConsistencyProvider {
  getConsistencyProof(oldSize: number, newSize: number): ConsistencyProof;
  getRootAtSize(size: number): string;
  getSize(): number;
  verifyConsistency(oldRoot: string, newRoot: string, proof: ConsistencyProof): boolean;
}

export type VerificationPublicInputAuthority = SupportedPublicInputArtifact['typedAuthority'] & {
  source: SupportedPublicInputArtifact['provenance']['source'];
  executionId?: string;
  bundleKey?: string;
};

export interface VerificationContext {
  electionId?: string;
  electionConfigHash?: string;
  logId?: string;
  voteReceipt?: VoteReceipt;
  userVote?: UserVoteInput;
  journal?: ZkVMJournal;
  electionManifest?: ElectionManifest;
  closeStatement?: CloseStatement;
  sthDigest?: string;
  sthSources?: string[];
  sthMinMatchingSources?: number;
  sthBaseUrl?: string;
  sthVerification?: SthVerificationResult;
  missingSlots?: number;
  invalidPresentedSlots?: number;
  rejectedRecords?: number;
  excludedSlots?: number;
  bulletinRoot?: string;
  treeSize?: number;
  tally?: {
    counts?: Record<VoteChoice, number>;
    totalVotes?: number;
  };
  verifiedTally?: number[];
  totalExpected?: number;
  inputCommitment?: string;
  seenBitmapRoot?: string;
  publicInputAuthority?: VerificationPublicInputAuthority;
  includedBitmapRoot?: string;
  bitmapProofSource?: BitmapProofSource;
  bitmapProofEndpoint?: string;
  bitmapProofProvider?: BitmapProofProvider;
  verificationStatus?: VerificationStatus;
  verificationReportStatus?: VerificationStatus;
  verificationReport?: {
    status?: VerificationStatus;
    expected_image_id?: string;
    receipt_image_id?: string | null;
    dev_mode_receipt?: boolean;
  };
  claimedImageId?: string;
  comparisonImageId?: string;
  allowDevModeVerification?: boolean;
  bulletin?: BulletinConsistencyProvider;
  sessionId?: string;
  sessionAuthHeaders?: Record<string, string>;
}

export interface CheckResult {
  status: VerificationStepStatus;
  error?: string;
  noteKey?: VerificationCheckNoteKey;
  details?: Record<string, unknown>;
}
