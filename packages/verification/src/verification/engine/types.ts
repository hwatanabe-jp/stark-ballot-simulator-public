import type { VerificationStepStatus } from '../step-types';
import type {
  BitmapProofSource,
  VerificationFailureCategory,
  VoteReceipt,
} from '@stark-ballot/verification/shared/types';
import type { VoteChoice } from '@stark-ballot/verification/shared/constants';
import type { VerifiedTally, ZkVMJournal } from '@stark-ballot/zkvm-contract/zkvm/types';
import type { SupportedPublicInputArtifact } from '@stark-ballot/verification/public-input';
import type { CloseStatement, ElectionManifest } from '@stark-ballot/verification/public-audit-artifacts';
import type { BitmapProofResponse } from '../bitmap-proof-types';
import type { AdmittedConsistencyProof } from '../consistency-proof-types';
import type { EvidenceAcquisition } from '../evidence-acquisition';
import type { SthVerificationResult } from '../sth-verifier';
import type { VerificationCheckId, VerificationCheckNoteKey } from '../verification-checks';

export type { AdmittedConsistencyProof } from '../consistency-proof-types';
export type { BitmapProofResponse } from '../bitmap-proof-types';
export type { EvidenceAcquisition } from '../evidence-acquisition';

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

export type VerificationPublicInputAuthority = SupportedPublicInputArtifact['typedAuthority'] & {
  source: SupportedPublicInputArtifact['provenance']['source'];
  finalizationId?: string;
  bundleKey?: string;
};

/** Typed inputs whose values have already been admitted by their owning boundary. */
export interface VerificationIdentityInput {
  electionId?: string;
  electionConfigHash?: string;
  logId?: string;
  sthSourcesConfigured?: boolean;
  claimedImageId?: string;
  comparisonImageId?: string;
  allowDevModeVerification?: boolean;
}

/** Evidence supplied by the voter rather than the finalized public bundle. */
export interface VerificationUserReceiptInput {
  voteReceipt?: VoteReceipt;
  userVote?: UserVoteInput;
}

/** Public and authenticated artifacts acquired for the verification attempt. */
export interface VerificationArtifactInput {
  journal?: ZkVMJournal;
  electionManifest?: ElectionManifest;
  closeStatement?: CloseStatement;
  sthDigest?: string;
  sthVerification?: SthVerificationResult;
  bulletinRoot?: string;
  treeSize?: number;
  publicInputAuthority?: VerificationPublicInputAuthority;
  seenBitmapRoot?: string;
  includedBitmapRoot?: string;
  bitmapProofSource?: BitmapProofSource;
  consistencyProof?: EvidenceAcquisition<AdmittedConsistencyProof>;
  includedBitmapProof?: EvidenceAcquisition<BitmapProofResponse>;
  seenBitmapProof?: EvidenceAcquisition<BitmapProofResponse>;
}

/** Tally facts projected from admitted public artifacts and the zkVM journal. */
export interface VerificationTallyInput {
  missingSlots?: number;
  invalidPresentedSlots?: number;
  rejectedRecords?: number;
  excludedSlots?: number;
  tally?: {
    counts?: Record<VoteChoice, number>;
    totalVotes?: number;
  };
  verifiedTally?: VerifiedTally;
  totalExpected?: number;
  inputCommitment?: string;
}

export type VerificationSuccessReportEvidence = Readonly<{
  status: 'success';
  expected_image_id?: string;
  receipt_image_id?: string;
  dev_mode_receipt: false;
}>;

export type VerificationDevModeReportEvidence = Readonly<{
  status: 'dev_mode';
  expected_image_id?: string;
  receipt_image_id?: string | null;
  dev_mode_receipt: true;
}>;

export type VerificationFailedReportEvidence = Readonly<{
  status: 'failed';
  expected_image_id?: string;
  receipt_image_id?: string | null;
  dev_mode_receipt: boolean;
}>;

export type VerificationComparisonReportEvidence = Readonly<{
  /** Comparison-only synthetic evidence has no verifier terminal status. */
  status?: never;
  expected_image_id: string;
  receipt_image_id: string | null;
  dev_mode_receipt?: never;
}>;

export type VerificationReportEvidence =
  | VerificationSuccessReportEvidence
  | VerificationDevModeReportEvidence
  | VerificationFailedReportEvidence
  | VerificationComparisonReportEvidence;

type InfrastructureFailureCategory = Exclude<VerificationFailureCategory, 'none'>;

/**
 * A caller may intentionally provide status-only mock/synthetic evidence, but
 * a status-bearing report and infrastructure category must agree with that
 * single status discriminator.
 */
export type VerificationOutcomeInput =
  | Readonly<{
      status: 'not_run' | 'running';
      report?: never;
      failureCategory?: 'none';
    }>
  | Readonly<{
      status: 'success';
      report?: VerificationSuccessReportEvidence | VerificationComparisonReportEvidence;
      failureCategory?: 'none';
    }>
  | Readonly<{
      status: 'dev_mode';
      report?: VerificationDevModeReportEvidence | VerificationComparisonReportEvidence;
      failureCategory?: 'none';
    }>
  | Readonly<{
      status: 'failed';
      report?: VerificationFailedReportEvidence | VerificationComparisonReportEvidence;
      failureCategory?: InfrastructureFailureCategory;
    }>;

/** Explicit availability replaces optional-property matrices after composition. */
export type AdmittedEvidence<T> =
  | Readonly<{ availability: 'unavailable'; value?: never }>
  | Readonly<{ availability: 'available'; value: T }>;

export type AdmittedVerifierOutcome =
  | Readonly<{
      status: 'not_run' | 'running';
      report: AdmittedEvidence<never>;
      failureCategory: 'none';
    }>
  | Readonly<{
      status: 'success';
      report: AdmittedEvidence<VerificationSuccessReportEvidence | VerificationComparisonReportEvidence>;
      failureCategory: 'none';
    }>
  | Readonly<{
      status: 'dev_mode';
      report: AdmittedEvidence<VerificationDevModeReportEvidence | VerificationComparisonReportEvidence>;
      failureCategory: 'none';
    }>
  | Readonly<{
      status: 'failed';
      report: AdmittedEvidence<VerificationFailedReportEvidence | VerificationComparisonReportEvidence>;
      failureCategory: InfrastructureFailureCategory;
    }>;

export type VerificationEvaluationInput = VerificationIdentityInput &
  VerificationUserReceiptInput &
  VerificationArtifactInput &
  VerificationTallyInput &
  Readonly<{ verifierOutcome?: VerificationOutcomeInput }>;

type AdmittedFields<T> = { readonly [K in keyof Required<T>]: AdmittedEvidence<Exclude<T[K], undefined>> };

export interface AdmittedVerificationEvidence {
  readonly identity: AdmittedFields<VerificationIdentityInput>;
  readonly userReceipt: AdmittedFields<VerificationUserReceiptInput>;
  readonly artifacts: Omit<
    AdmittedFields<VerificationArtifactInput>,
    'consistencyProof' | 'includedBitmapProof' | 'seenBitmapProof'
  > &
    Readonly<{
      consistencyProof: EvidenceAcquisition<AdmittedConsistencyProof>;
      includedBitmapProof: EvidenceAcquisition<BitmapProofResponse>;
      seenBitmapProof: EvidenceAcquisition<BitmapProofResponse>;
    }>;
  readonly tally: AdmittedFields<VerificationTallyInput>;
  readonly verifierOutcome: AdmittedVerifierOutcome;
}

type NoCheckEvidence = Readonly<Record<PropertyKey, never>>;
type Maybe<T> = T | undefined;

/** Every evaluator receives fixed keys for only the evidence it can inspect. */
export interface VerificationCheckContextMap {
  cast_receipt_present: NoCheckEvidence;
  cast_choice_range: NoCheckEvidence;
  cast_random_format: NoCheckEvidence;
  cast_commitment_match: NoCheckEvidence;
  recorded_commitment_in_bulletin: NoCheckEvidence;
  recorded_index_in_range: Readonly<{
    voteReceipt: Maybe<VoteReceipt>;
    treeSize: Maybe<number>;
  }>;
  recorded_root_at_cast_consistent: NoCheckEvidence;
  recorded_inclusion_proof: Readonly<{
    voteReceipt: Maybe<VoteReceipt>;
    userVote: Maybe<UserVoteInput>;
  }>;
  recorded_consistency_proof: Readonly<{
    voteReceipt: Maybe<VoteReceipt>;
    userVote: Maybe<UserVoteInput>;
    bulletinRoot: Maybe<string>;
    treeSize: Maybe<number>;
    consistencyProof: EvidenceAcquisition<AdmittedConsistencyProof>;
  }>;
  recorded_sth_third_party: Readonly<{
    journal: Maybe<ZkVMJournal>;
    sthDigest: Maybe<string>;
    bulletinRoot: Maybe<string>;
    treeSize: Maybe<number>;
    sthSourcesConfigured: Maybe<boolean>;
    sthVerification: Maybe<SthVerificationResult>;
  }>;
  counted_input_sanity: Readonly<{ publicInputAuthority: Maybe<VerificationPublicInputAuthority> }>;
  counted_unique_indices: Readonly<{ publicInputAuthority: Maybe<VerificationPublicInputAuthority> }>;
  counted_unique_commitments: Readonly<{ publicInputAuthority: Maybe<VerificationPublicInputAuthority> }>;
  counted_tally_consistent: Readonly<{
    journal: Maybe<ZkVMJournal>;
    tally: Maybe<VerificationTallyInput['tally']>;
    verifiedTally: Maybe<VerifiedTally>;
  }>;
  counted_missing_indices_zero: Readonly<{
    journal: Maybe<ZkVMJournal>;
    missingSlots: Maybe<number>;
    invalidPresentedSlots: Maybe<number>;
    excludedSlots: Maybe<number>;
  }>;
  counted_expected_vs_tree_size: Readonly<{
    journal: Maybe<ZkVMJournal>;
    totalExpected: Maybe<number>;
    treeSize: Maybe<number>;
  }>;
  counted_election_manifest_consistent: Readonly<{
    electionManifest: Maybe<ElectionManifest>;
    electionId: Maybe<string>;
    electionConfigHash: Maybe<string>;
    publicInputAuthority: Maybe<VerificationPublicInputAuthority>;
    journal: Maybe<ZkVMJournal>;
  }>;
  counted_close_statement_consistent: Readonly<{
    closeStatement: Maybe<CloseStatement>;
    publicInputAuthority: Maybe<VerificationPublicInputAuthority>;
    logId: Maybe<string>;
    treeSize: Maybe<number>;
    journal: Maybe<ZkVMJournal>;
    bulletinRoot: Maybe<string>;
    sthDigest: Maybe<string>;
  }>;
  counted_my_vote_included: Readonly<{
    journal: Maybe<ZkVMJournal>;
    includedBitmapRoot: Maybe<string>;
    seenBitmapRoot: Maybe<string>;
    treeSize: Maybe<number>;
    voteReceipt: Maybe<VoteReceipt>;
    bitmapProofSource: Maybe<BitmapProofSource>;
    includedBitmapProof: EvidenceAcquisition<BitmapProofResponse>;
    seenBitmapProof: EvidenceAcquisition<BitmapProofResponse>;
    missingSlots: Maybe<number>;
    invalidPresentedSlots: Maybe<number>;
    excludedSlots: Maybe<number>;
  }>;
  counted_input_commitment_match: Readonly<{
    journal: Maybe<ZkVMJournal>;
    inputCommitment: Maybe<string>;
    publicInputAuthority: Maybe<VerificationPublicInputAuthority>;
  }>;
  stark_image_id_match: Readonly<{
    claimedImageId: Maybe<string>;
    comparisonImageId: Maybe<string>;
    verificationReport: Maybe<VerificationReportEvidence>;
  }>;
  stark_receipt_verify: NoCheckEvidence;
}

type MissingCheckContext = Exclude<VerificationCheckId, keyof VerificationCheckContextMap>;
type UnexpectedCheckContext = Exclude<keyof VerificationCheckContextMap, VerificationCheckId>;
export type VerificationCheckContextCoverage = [MissingCheckContext, UnexpectedCheckContext] extends [never, never]
  ? true
  : never;
export type VerificationCheckContext<Id extends VerificationCheckId> = VerificationCheckContextMap[Id];

type NonterminalCheckStatus = Extract<VerificationStepStatus, 'pending' | 'running'>;

/**
 * A check result is intentionally status-specific. Diagnostics are terminal
 * failure data, while explanatory notes belong only to unavailable or failed
 * evidence. This prevents callers from constructing a successful check that
 * still carries contradictory failure state.
 */
export type CheckResult =
  | Readonly<{ status: 'success'; error?: never; noteKey?: never }>
  | Readonly<{ status: NonterminalCheckStatus; error?: never; noteKey?: never }>
  | Readonly<{ status: 'not_run'; error?: never; noteKey?: VerificationCheckNoteKey }>
  | Readonly<{ status: 'failed'; error?: string; noteKey?: VerificationCheckNoteKey }>;
