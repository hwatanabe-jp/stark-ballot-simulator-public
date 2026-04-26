import type { VerificationStepStatus } from '@/lib/knowledge';
import type { VoteReceipt } from '@/types/receipt';
import type { VoteChoice } from '@/shared/constants';
import type { ZkVMJournal } from '@/lib/zkvm/types';
import type { ConsistencyProof } from '@/lib/merkle/consistency-proof';
import type { BitmapProofSource } from '@/types/server';
import type { SupportedPublicInputArtifact } from '@/lib/verification/public-input-contract';
import type { CloseStatement, ElectionManifest } from '@/lib/verification/public-audit-artifacts';

export type VerificationStatus = 'success' | 'failed' | 'dev_mode' | 'not_run' | 'running' | 'pending';

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
  sthBaseUrl?: string;
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
  verificationStatus?: VerificationStatus;
  verificationReportStatus?: VerificationStatus;
  verificationReport?: {
    expected_image_id?: string;
    receipt_image_id?: string | null;
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
  noteKey?: string;
  details?: Record<string, unknown>;
}
