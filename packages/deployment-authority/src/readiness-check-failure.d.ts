export const ROLLBACK_READINESS_CHECK_FAILURE_STAGES: readonly [
  'authority-admission',
  'candidate-admission',
  'baseline-admission',
  'dependency-admission',
  'identity-admission',
  'provider-initialization',
  'runner-runtime',
  'plan-input-preparation',
  'terraform-plan',
  'plan-summary',
];

export const DYNAMODB_RECOVERY_READINESS_CHECK_FAILURE_STAGES: readonly [
  'authority-admission',
  'baseline-admission',
  'dependency-admission',
  'identity-admission',
  'manifest-admission',
  'provider-initialization',
  'runner-runtime',
  'terraform-plan',
  'plan-summary',
];

export type RollbackReadinessCheckFailureStage = (typeof ROLLBACK_READINESS_CHECK_FAILURE_STAGES)[number];
export type DynamoDbRecoveryReadinessCheckFailureStage =
  (typeof DYNAMODB_RECOVERY_READINESS_CHECK_FAILURE_STAGES)[number];

interface ReadinessCheckFailureEvidenceBase {
  readonly targetKey: 'stark-dev/develop';
  readonly controlSourceSha: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly result: 'check-failed';
  readonly planSummary: null;
  readonly reportOnly: true;
}

export interface RollbackReadinessCheckFailureEvidence extends ReadinessCheckFailureEvidenceBase {
  readonly evidenceType: 'app-rollback-readiness-check-failed';
  readonly failureStage: RollbackReadinessCheckFailureStage;
}

export interface DynamoDbRecoveryReadinessCheckFailureEvidence extends ReadinessCheckFailureEvidenceBase {
  readonly evidenceType: 'dynamodb-recovery-readiness-check-failed';
  readonly failureStage: DynamoDbRecoveryReadinessCheckFailureStage;
}

export type ReadinessCheckFailureEvidence =
  RollbackReadinessCheckFailureEvidence | DynamoDbRecoveryReadinessCheckFailureEvidence;

export function validateReadinessCheckFailureEvidence(value: unknown): ReadinessCheckFailureEvidence;
