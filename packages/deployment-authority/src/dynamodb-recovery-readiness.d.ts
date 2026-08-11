import type { DynamoDbRecoveryPhase, DynamoDbRecoverySelection } from './dynamodb-recovery-phase.js';
import type { DeploymentLaneContext, ImmutableObjectReference } from './index.js';
import type { TerraformDriftSummary } from './terraform-drift.js';

export const DYNAMODB_RECOVERY_READINESS_CHECK_CATEGORIES: readonly [
  'cleanup-authorization',
  'data-validation',
  'drain',
  'owner',
  'primary-sessions',
  'primary-votes',
  'quiescing',
  'read-only-iam',
  'replacement-sessions',
  'replacement-votes',
  'smoke',
  'wrong-capability',
];

export type DynamoDbRecoveryReadinessCheck = (typeof DYNAMODB_RECOVERY_READINESS_CHECK_CATEGORIES)[number];
export type DynamoDbRecoveryTableKind = 'sessions' | 'votes';
export type DynamoDbRecoveryTableRole = 'primary' | 'replacement';

export interface DynamoDbRecoveryIdentity {
  readonly planType: 'dynamodb-recovery';
  readonly recoveryPoint: string;
  readonly accountAlias: string;
  readonly deploymentEnvironment: string;
  readonly accountId: string;
  readonly region: string;
  readonly sessionsSourceTableArn: string;
  readonly votesSourceTableArn: string;
  readonly sessionsReplacementTableName: string;
  readonly votesReplacementTableName: string;
}

export interface DynamoDbRecoveryManifestKeyAttribute {
  readonly attributeName: string;
  readonly attributeType: 'S' | 'N';
}

export interface DynamoDbRecoveryObservedKeyAttribute extends DynamoDbRecoveryManifestKeyAttribute {
  readonly keyType: 'HASH' | 'RANGE';
}

export interface DynamoDbRecoveryGlobalSecondaryIndex {
  readonly indexName: string;
  readonly partitionKey: string;
  readonly attributeType: 'S' | 'N';
  readonly projectionType: 'KEYS_ONLY' | 'ALL' | 'INCLUDE';
}

export interface DynamoDbRecoveryRequiredTags {
  readonly Project: string;
  readonly AccountAlias: string;
  readonly Environment: string;
  readonly DataClass: 'session-authority' | 'session-owned-votes';
}

export interface DynamoDbRecoveryManifestOperationalControls {
  readonly billingMode: 'PAY_PER_REQUEST';
  readonly deletionProtectionEnabled: true;
  readonly pointInTimeRecoveryEnabled: true;
  readonly ttlAttribute: 'expiresAt';
  readonly requiredTags: DynamoDbRecoveryRequiredTags;
}

export interface DynamoDbRecoveryManifestTable {
  readonly sourceTableArn: string;
  readonly replacementTableArn: string;
  readonly replacementTableName: string;
  readonly keySchema: readonly DynamoDbRecoveryManifestKeyAttribute[];
  readonly globalSecondaryIndexes: readonly DynamoDbRecoveryGlobalSecondaryIndex[];
  readonly operationalControls: DynamoDbRecoveryManifestOperationalControls;
}

export interface DynamoDbRecoveryReadinessManifest {
  readonly reference: ImmutableObjectReference;
  readonly bodySha256: string;
  readonly manifestType: 'dynamodb-recovery-activation';
  readonly validationStatus: 'validated';
  readonly recoveryId: string;
  readonly recoveryPoint: string;
  readonly accountAlias: string;
  readonly deploymentEnvironment: string;
  readonly accountId: string;
  readonly region: string;
  readonly kmsKeyArn: string;
  readonly tables: {
    readonly sessions: DynamoDbRecoveryManifestTable;
    readonly votes: DynamoDbRecoveryManifestTable;
  };
}

export interface DynamoDbRecoveryRestoreSummary {
  readonly sourceTableArn: string;
  readonly recoveryPoint: string;
  readonly restoreInProgress: boolean;
}

export interface DynamoDbRecoveryDescribeTableObservation {
  readonly tableArn: string;
  readonly tableName: string;
  readonly tableStatus:
    | 'ACTIVE'
    | 'CREATING'
    | 'UPDATING'
    | 'DELETING'
    | 'ARCHIVING'
    | 'ARCHIVED'
    | 'INACCESSIBLE_ENCRYPTION_CREDENTIALS'
    | 'REPLICATION_NOT_AUTHORIZED';
  readonly keySchema: readonly DynamoDbRecoveryObservedKeyAttribute[];
  readonly globalSecondaryIndexes: readonly DynamoDbRecoveryGlobalSecondaryIndex[];
  readonly localSecondaryIndexCount: number;
  readonly billingMode: 'PAY_PER_REQUEST' | 'PROVISIONED';
  readonly deletionProtectionEnabled: boolean;
  readonly sseStatus: 'ENABLED' | 'ENABLING' | 'DISABLED' | 'DISABLING' | 'UPDATING';
  readonly kmsKeyArn: string | null;
  readonly streamEnabled: boolean;
  readonly streamViewType: 'KEYS_ONLY' | 'NEW_IMAGE' | 'OLD_IMAGE' | 'NEW_AND_OLD_IMAGES' | null;
  readonly restoreSummary: DynamoDbRecoveryRestoreSummary | null;
}

export interface DynamoDbRecoveryContinuousBackupsObservation {
  readonly status: 'ENABLED' | 'DISABLED';
  readonly earliestRestorableAt: string | null;
  readonly latestRestorableAt: string | null;
}

export interface DynamoDbRecoveryTimeToLiveObservation {
  readonly status: 'ENABLED' | 'DISABLED' | 'ENABLING' | 'DISABLING';
  readonly attributeName: string | null;
}

export interface DynamoDbRecoveryTableObservation {
  readonly availability: 'available' | 'missing';
  readonly describeTable: DynamoDbRecoveryDescribeTableObservation | null;
  readonly continuousBackups: DynamoDbRecoveryContinuousBackupsObservation | null;
  readonly timeToLive: DynamoDbRecoveryTimeToLiveObservation | null;
  readonly tags: DynamoDbRecoveryRequiredTags | null;
}

export interface DynamoDbRecoveryCurrentAuthorityInput {
  readonly body: Readonly<Record<string, unknown>>;
  readonly pointerBefore: ImmutableObjectReference;
  readonly pointerAfter: ImmutableObjectReference;
}

export interface DynamoDbRecoveryCurrentAuthorityProjection {
  readonly authorityType: 'app-accepted-deployment-authority';
  readonly stateIdentity: string;
  readonly pointer: ImmutableObjectReference;
  readonly bodySha256: string;
  readonly pipelineExecutionId: string;
  readonly acceptanceAttemptId: string;
  readonly sourceSha: string;
  readonly controlSourceSha: string;
  readonly dynamodbRecoveryPhase: DynamoDbRecoveryPhase;
  readonly dynamodbRecoveryManifest: ImmutableObjectReference | null;
}

export interface DynamoDbRecoveryAcceptedBaselineInput {
  readonly recordType: 'accepted-terraform-baseline';
  readonly reference: ImmutableObjectReference;
  readonly pipelineExecutionId: string;
  readonly acceptanceAttemptId: string;
  readonly acceptedPlanChecksum: string;
  readonly sourceSha: string;
  readonly controlSourceSha: string;
  readonly stateIdentity: string;
  readonly backendKey: string;
  readonly dynamodbRecoveryPhase: DynamoDbRecoveryPhase;
  readonly dynamodbRecoveryManifest: ImmutableObjectReference | null;
}

export interface DynamoDbRecoveryPrerequisiteChecks {
  readonly quiescing: {
    readonly admissionClosed: boolean;
    readonly proverEventSourceMappingDisabled: boolean;
    readonly verificationEventSourceMappingDisabled: boolean;
  };
  readonly drain: {
    readonly finalizationsDrained: boolean;
    readonly proverQueueDrained: boolean;
    readonly verificationQueueDrained: boolean;
    readonly inFlightExecutionsDrained: boolean;
  };
  readonly wrongCapability: {
    readonly stateReadDenied: boolean;
    readonly mutationDenied: boolean;
  };
  readonly dataValidation: {
    readonly requiredBeforeActivation: boolean;
    readonly schemaCheckRequired: boolean;
    readonly countCheckRequired: boolean;
    readonly checksumCheckRequired: boolean;
  };
  readonly smoke: {
    readonly currentAcceptedPhasePassed: boolean;
    readonly requestedPhaseRequired: boolean;
  };
}

export interface DynamoDbRecoveryRetainedPrerequisiteEvidence {
  readonly reference: ImmutableObjectReference;
  readonly bodySha256: string;
  readonly evidenceType: 'dynamodb-recovery-prerequisites';
  readonly acceptedBaseline: ImmutableObjectReference;
  readonly checks: DynamoDbRecoveryPrerequisiteChecks;
  readonly controlSourceSha: string;
  readonly currentAcceptedAuthority: {
    readonly pointer: ImmutableObjectReference;
    readonly phase: DynamoDbRecoveryPhase;
    readonly manifest: ImmutableObjectReference | null;
  };
  readonly observedAt: string;
  readonly requestedRecovery: DynamoDbRecoverySelection;
  readonly targetContextSha256: string;
}

export interface DynamoDbRecoveryReadinessPrerequisites {
  readonly owner: {
    readonly accountMatched: boolean;
    readonly regionMatched: boolean;
  };
  readonly retainedEvidence: DynamoDbRecoveryRetainedPrerequisiteEvidence | null;
}

export interface DynamoDbRecoveryManagedPolicyContract {
  readonly policyArn: string;
  readonly documentSha256: string;
}

export interface DynamoDbRecoveryManagedPolicyObservation extends DynamoDbRecoveryManagedPolicyContract {
  readonly defaultVersionId: string;
}

export interface DynamoDbRecoveryInlinePolicyContract {
  readonly policyName: string;
  readonly documentSha256: string;
}

export interface DynamoDbRecoveryReviewedIamContract {
  readonly roleArn: string;
  readonly trustPolicySha256: string;
  readonly permissionsBoundary: DynamoDbRecoveryManagedPolicyContract;
  readonly attachedPolicies: readonly DynamoDbRecoveryManagedPolicyContract[];
  readonly inlinePolicies: readonly DynamoDbRecoveryInlinePolicyContract[];
}

export interface DynamoDbRecoveryObservedIamEvidence {
  readonly roleArn: string;
  readonly trustPolicySha256: string;
  readonly permissionsBoundary: DynamoDbRecoveryManagedPolicyObservation;
  readonly attachedPolicies: readonly DynamoDbRecoveryManagedPolicyObservation[];
  readonly inlinePolicies: readonly DynamoDbRecoveryInlinePolicyContract[];
}

export interface DynamoDbRecoveryReadinessIamEvidence {
  readonly reviewed: DynamoDbRecoveryReviewedIamContract;
  readonly observed: DynamoDbRecoveryObservedIamEvidence | null;
}

export interface DynamoDbRecoveryCleanupSelection {
  readonly requested: boolean;
  readonly authorization: ImmutableObjectReference | null;
}

export interface DynamoDbRecoveryReadinessInput {
  readonly targetContext: DeploymentLaneContext;
  readonly currentAuthority: DynamoDbRecoveryCurrentAuthorityInput;
  readonly acceptedBaseline: DynamoDbRecoveryAcceptedBaselineInput;
  readonly reviewedControlSourceSha: string;
  readonly currentControlSourceSha: string;
  readonly requestedRecovery: DynamoDbRecoverySelection;
  readonly manifest: DynamoDbRecoveryReadinessManifest;
  readonly tables: {
    readonly primary: {
      readonly sessions: DynamoDbRecoveryTableObservation;
      readonly votes: DynamoDbRecoveryTableObservation;
    };
    readonly replacement: {
      readonly sessions: DynamoDbRecoveryTableObservation;
      readonly votes: DynamoDbRecoveryTableObservation;
    };
  };
  readonly prerequisites: DynamoDbRecoveryReadinessPrerequisites;
  readonly iam: DynamoDbRecoveryReadinessIamEvidence;
  readonly cleanup: DynamoDbRecoveryCleanupSelection;
  readonly planSummary: TerraformDriftSummary | null;
  readonly startedAt: string;
  readonly finishedAt: string;
}

export interface DynamoDbRecoveryReadinessEvidence {
  readonly evidenceType: 'dynamodb-recovery-readiness';
  readonly target: {
    readonly targetKey: string;
    readonly accountId: string;
    readonly region: string;
    readonly deploymentEnvironment: string;
    readonly stateIdentity: string;
    readonly backendKey: string;
    readonly targetContextSha256: string;
  };
  readonly currentAcceptedAuthority: DynamoDbRecoveryCurrentAuthorityProjection;
  readonly acceptedAppBaseline: DynamoDbRecoveryAcceptedBaselineInput;
  readonly controlSourceSha: string;
  readonly recovery: {
    readonly currentPhase: DynamoDbRecoveryPhase;
    readonly requestedPhase: DynamoDbRecoveryPhase;
    readonly transitionDisposition: 'idempotent' | 'forward' | 'reverse';
    readonly manifest: ImmutableObjectReference;
    readonly allowedNextPhases: readonly DynamoDbRecoveryPhase[];
  };
  readonly manifest: DynamoDbRecoveryReadinessManifest;
  readonly tables: DynamoDbRecoveryReadinessInput['tables'];
  readonly prerequisites: DynamoDbRecoveryReadinessPrerequisites;
  readonly iam: DynamoDbRecoveryReadinessIamEvidence;
  readonly cleanup: DynamoDbRecoveryCleanupSelection;
  readonly planSummary: TerraformDriftSummary | null;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly result: 'ready' | 'not-ready';
  readonly rejectedChecks: readonly DynamoDbRecoveryReadinessCheck[];
  readonly reportOnly: true;
}

export function validateDynamoDbRecoveryActivationManifestSourceShape(
  value: unknown,
): Readonly<Record<string, unknown>>;
export function deriveDynamoDbRecoveryId(value: unknown): string;
export function validateDynamoDbRecoveryPrerequisiteEvidenceSourceShape(
  value: unknown,
): Readonly<Record<string, unknown>>;
export function evaluateDynamoDbRecoveryReadiness(value: unknown): DynamoDbRecoveryReadinessEvidence;
export function validateDynamoDbRecoveryReadinessEvidence(value: unknown): DynamoDbRecoveryReadinessEvidence;
