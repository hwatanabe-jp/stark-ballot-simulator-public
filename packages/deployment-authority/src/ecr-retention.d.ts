import type { DigestPinnedImagePolicy, ImmutableObjectReference } from './index.js';

export const ECR_SUBJECT_RETENTION_COUNTS: Readonly<{ develop: 10; main: 10 }>;

export interface ToolchainArtifactRecord {
  readonly recordType: 'toolchain-artifact';
  readonly pipelineExecutionId: string;
  readonly sourceSha: string;
  readonly candidateExecutionId: string;
  readonly candidateMetadataSha256: string;
  readonly imageUri: string;
  readonly imageDigest: string;
  readonly imageTag: string;
  readonly risc0Version: string;
  readonly rustVersion: string;
  readonly rustToolchainTag: string;
  readonly scanStatus: 'PASS' | 'FINDINGS_PRESENT';
  readonly criticalHighCount: number;
  readonly approvals: Readonly<{
    buildApprovalEvidenceId: string;
    promotionApprovalEvidenceId: string;
  }>;
}

export interface ProverReleaseRecord {
  readonly recordType: 'prover-release';
  readonly pipelineExecutionId: string;
  readonly sourceSha: string;
  readonly candidateExecutionId: string;
  readonly candidateMetadataSha256: string;
  readonly failureMarkerContractSha256: string;
  readonly failureMarkerSmokeStatus: 'PASS';
  readonly selectedToolchain: ImmutableObjectReference & {
    readonly imageUri: string;
    readonly imageDigest: string;
  };
  readonly imageUri: string;
  readonly imageDigest: string;
  readonly expectedImageId: string;
  readonly zkvmContractHash: string;
  readonly methodVersion: number;
  readonly imageIdVariant: 'default';
  readonly scanStatus: 'PASS';
  readonly approvals: Readonly<{
    buildApprovalEvidenceId: string;
    promotionApprovalEvidenceId: string;
  }>;
  readonly evidence: Readonly<{
    prePushImageId: string;
    postPushImageId: string;
    methodVersionEvidenceId: string;
  }>;
}

export interface EcrRetentionImage {
  readonly artifactMediaType: string;
  readonly imageDigest: string;
  readonly imageManifestMediaType: string;
  readonly imagePushedAt: string;
  readonly imageStatus: string;
}

export interface EcrRetentionReferrer {
  readonly artifactDigest: string;
  readonly artifactStatus: string;
  readonly artifactType: string;
  readonly mediaType: string;
}

export interface EcrRetentionSubjectReferrers {
  readonly paginationComplete: boolean;
  readonly referrers: readonly EcrRetentionReferrer[];
  readonly subjectDigest: string;
}

export interface EcrRetentionRepositorySnapshot {
  readonly images: readonly EcrRetentionImage[];
  readonly paginationComplete: boolean;
  readonly protectedDigests: readonly string[];
  readonly referrers: readonly EcrRetentionSubjectReferrers[];
  readonly repositoryName: string;
}

export interface EcrSubjectRetentionInput {
  readonly environmentId: 'develop' | 'main';
  readonly repositories: Readonly<{
    prover: EcrRetentionRepositorySnapshot;
    toolchain: EcrRetentionRepositorySnapshot;
  }>;
}

export type EcrRetentionBlocker =
  | 'DUPLICATE_IMAGE_DIGEST'
  | 'DUPLICATE_PROTECTED_DIGEST'
  | 'DUPLICATE_REFERRER_DIGEST'
  | 'INCOMPLETE_IMAGE_PAGINATION'
  | 'INCOMPLETE_REFERRER_PAGINATION'
  | 'PROTECTED_SUBJECT_MISSING'
  | 'REFERRER_COVERAGE_INCOMPLETE'
  | 'REFERRER_INVENTORY_MISMATCH'
  | 'UNKNOWN_IMAGE_MEDIA'
  | 'UNKNOWN_IMAGE_STATUS'
  | 'UNKNOWN_REFERRER_MEDIA'
  | 'UNKNOWN_REFERRER_STATUS';

export interface EcrRetentionRepositoryPlan {
  readonly repositoryName: string;
  readonly subjectCount: number;
  readonly protectedSubjectCount: number;
  readonly protectedSubjectDigests: readonly string[];
  readonly targetSubjectCount: number;
  readonly retainedSubjectCount: number;
  readonly deleteReferrerDigests: readonly string[];
  readonly deleteSubjectDigests: readonly string[];
}

export interface EcrSubjectRetentionPlan {
  readonly disposition: 'blocked' | 'delete' | 'no-change';
  readonly blockers: readonly EcrRetentionBlocker[];
  readonly environmentId: 'develop' | 'main';
  readonly snapshotSha256: string;
  readonly repositories: Readonly<{
    prover: EcrRetentionRepositoryPlan;
    toolchain: EcrRetentionRepositoryPlan;
  }>;
}

export function validateToolchainArtifactRecord(
  value: unknown,
  imagePolicy: DigestPinnedImagePolicy,
): ToolchainArtifactRecord;
export function validateProverReleaseRecord(
  value: unknown,
  imagePolicies: Readonly<{
    prover: DigestPinnedImagePolicy;
    toolchain: DigestPinnedImagePolicy;
  }>,
): ProverReleaseRecord;
export function planEcrSubjectRetention(value: unknown): EcrSubjectRetentionPlan;
