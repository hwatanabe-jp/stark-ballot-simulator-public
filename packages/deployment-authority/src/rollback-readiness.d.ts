import type { DeploymentLaneContext, ImmutableObjectReference } from './index.js';
import type { TerraformDriftSummary } from './terraform-drift.js';

export const ROLLBACK_READINESS_DEPENDENCY_CATEGORIES: readonly [
  'accepted-baseline',
  'app-deployment-record',
  'approval',
  'candidate-record',
  'foundation-handoff',
  'image-id-method',
  'lambda-finalization-writer',
  'lambda-image-signature-verifier',
  'lambda-proof-dispatcher',
  'lambda-public-api',
  'lambda-semaphore-janitor',
  'lambda-verification-worker',
  'plan-inputs',
  'prover-image-digest',
  'prover-image-signature',
  'prover-release',
  'rollback-history',
  'smoke',
  'static-archive',
  'toolchain-release',
  'verifier-authority',
];

export type RollbackReadinessDependencyCategory = (typeof ROLLBACK_READINESS_DEPENDENCY_CATEGORIES)[number];
export type RollbackReadinessDependencyStatus = 'available' | 'missing' | 'rejected';

export interface RollbackReadinessDependencyObservation {
  readonly category: RollbackReadinessDependencyCategory;
  readonly status: RollbackReadinessDependencyStatus;
  readonly reference: ImmutableObjectReference | null;
  readonly observedReference: ImmutableObjectReference | null;
  readonly expectedValueSha256: string | null;
  readonly observedValueSha256: string | null;
}

export interface RollbackReadinessCandidateInput {
  readonly recordType: 'app-accepted-deployment';
  readonly reference: ImmutableObjectReference;
  readonly pipelineExecutionId: string;
  readonly acceptanceAttemptId: string;
  readonly accountId: string;
  readonly region: string;
  readonly deploymentEnvironment: string;
  readonly stateIdentity: string;
  readonly backendKey: string;
  readonly controlSourceSha: string;
  readonly sourceSha: string;
  readonly selectedSourceSha: string;
  readonly planChecksum: string;
}

export interface RollbackReadinessAcceptedBaselineInput {
  readonly recordType: 'accepted-terraform-baseline';
  readonly reference: ImmutableObjectReference;
  readonly pipelineExecutionId: string;
  readonly acceptanceAttemptId: string;
  readonly acceptedPlanChecksum: string;
  readonly controlSourceSha: string;
  readonly stateIdentity: string;
  readonly backendKey: string;
}

export interface RollbackReadinessInput {
  readonly targetContext: DeploymentLaneContext;
  readonly currentAuthority: {
    readonly body: Readonly<Record<string, unknown>>;
    readonly pointerBefore: ImmutableObjectReference;
    readonly pointerAfter: ImmutableObjectReference;
  };
  readonly candidate: RollbackReadinessCandidateInput;
  readonly acceptedBaseline: RollbackReadinessAcceptedBaselineInput;
  readonly reviewedControlSourceSha: string;
  readonly currentControlSourceSha: string;
  readonly dependencies: readonly RollbackReadinessDependencyObservation[];
  readonly planSummary: TerraformDriftSummary | null;
  readonly startedAt: string;
  readonly finishedAt: string;
}

export interface RollbackReadinessEvidence {
  readonly evidenceType: 'app-rollback-readiness';
  readonly target: {
    readonly targetKey: string;
    readonly accountId: string;
    readonly region: string;
    readonly deploymentEnvironment: string;
    readonly stateIdentity: string;
    readonly backendKey: string;
    readonly targetContextSha256: string;
  };
  readonly currentAcceptedAuthority: {
    readonly pointer: ImmutableObjectReference;
    readonly bodySha256: string;
    readonly currentHead: ImmutableObjectReference;
  };
  readonly candidate: {
    readonly reference: ImmutableObjectReference;
    readonly pipelineExecutionId: string;
    readonly acceptanceAttemptId: string;
    readonly selectedSourceSha: string;
  };
  readonly acceptedAppBaseline: ImmutableObjectReference;
  readonly controlSourceSha: string;
  readonly dependencies: readonly RollbackReadinessDependencyObservation[];
  readonly planSummary: TerraformDriftSummary | null;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly result: 'ready' | 'not-ready';
  readonly rejectedDependencies: readonly RollbackReadinessDependencyCategory[];
  readonly reportOnly: true;
}

export function evaluateRollbackReadiness(value: unknown): RollbackReadinessEvidence;
export function deriveRollbackHistoryDependencyObservation(
  currentHead: unknown,
  candidate: unknown,
): RollbackReadinessDependencyObservation;
export function validateRollbackReadinessEvidence(value: unknown): RollbackReadinessEvidence;
