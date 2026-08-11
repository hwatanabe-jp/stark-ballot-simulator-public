import type { DynamoDbRecoveryPhase } from './dynamodb-recovery-phase.js';
import type { ImmutableObjectReference } from './index.js';

export const PENDING_MANIFEST_VERSION_ID: '__PENDING_APP_ACCEPTANCE_PUBLICATION__';
export const CURRENT_AUTHORITY_KEYS: readonly string[];
export const CURRENT_AUTHORITY_ENTRY_KEYS: readonly string[];
export const SMOKE_DENIAL_KEYS: readonly string[];
export class ExactSemanticShapeError extends Error {
  constructor(message: string, options?: ErrorOptions);
}
export const RETAINED_DEPLOYMENT_ARTIFACT_BASENAMES: Readonly<{
  appDeploymentRecordGenerationPath: 'app-deployment-record-generation.json';
  applyOutputsPath: 'apply-outputs.json';
  denialSmokePath: 'app-smoke-denial-evidence.json';
  deploymentIdentityPath: 'deployment-identity.json';
  dynamodbDataPlaneSmokePath: 'app-smoke-dynamodb-data-plane-evidence.json';
  dynamodbRecoveryPhaseSmokePath: 'app-smoke-dynamodb-recovery-phase-evidence.json';
  dynamodbRecoverySelectionPath: 'dynamodb-recovery-selection.json';
  imageSignatureVerifierApplyIdentityPath: 'image-signature-verifier-apply-identity.json';
  imageSignatureVerifierPlanIdentityPath: 'image-signature-verifier-plan-identity.json';
  imageSignatureVerifierSmokeIdentityPath: 'image-signature-verifier-smoke-identity.json';
  mutationDenialSimulationPath: 'app-smoke-mutation-denial-simulation.json';
  planChecksumPath: 'tfplan.sha256';
  planEmptyPath: 'app-plan-empty.json';
  planJsonPath: 'tfplan.json';
  planPath: 'tfplan';
  planSummaryPath: 'tfplan.txt';
  rollbackSelectionPath: 'rollback-selection.json';
  smokeCallerPath: 'app-smoke-caller.json';
  smokeDeclaredBlocksPath: 'app-smoke-declared-blocks.txt';
  smokeReportPath: 'app-smoke-report.json';
  smokeTerraformFilesPath: 'app-smoke-terraform-files.txt';
  sourcePreflightPath: 'source-preflight.json';
  stateDenialSimulationPath: 'app-smoke-state-denial-simulation.json';
  staticFrontendDeployPath: 'static-frontend-deploy.json';
  targetLambdaArtifactsPath: 'target-lambda-artifacts.json';
  terraformProvidersPath: 'terraform-providers.txt';
  terraformVersionPath: 'terraform-version.json';
}>;

export type RetainedDeploymentArtifactField = keyof typeof RETAINED_DEPLOYMENT_ARTIFACT_BASENAMES;
export type RetainedDeploymentArtifacts = Readonly<
  Record<RetainedDeploymentArtifactField, string> & { approvalEvidencePath: string }
>;

export interface RetainedLambdaArtifact {
  readonly s3_bucket: string;
  readonly s3_key: string;
  readonly s3_object_version: string;
  readonly source_code_hash: string;
  readonly sha256: string;
}

export interface RetainedImageSignatureVerifierArtifact extends RetainedLambdaArtifact {
  readonly asset_manifest_sha256: string;
  readonly trust_root_sha256: string;
}

export interface RetainedLambdaArtifactSet {
  readonly manifestType: 'app-lambda-artifact-set';
  readonly sourceSha: string;
  readonly bucket: string;
  readonly prefix: string;
  readonly artifacts: Readonly<{
    public_api: RetainedLambdaArtifact;
    finalization_writer: RetainedLambdaArtifact;
    proof_dispatcher: RetainedLambdaArtifact;
    verification_worker: RetainedLambdaArtifact;
    image_signature_verifier: RetainedImageSignatureVerifierArtifact;
    semaphore_janitor: RetainedLambdaArtifact;
  }>;
  readonly proverImageUri: string;
  readonly expectedImageId: string;
  readonly imageIdMappingEvidence: Readonly<{ mappingSha256: string }>;
}

export interface RetainedStaticFrontend {
  readonly bucket: string;
  readonly key: string;
  readonly versionId: string;
  readonly sha256: string;
  readonly artifactSha256: string;
}

export interface RetainedDeployables {
  readonly lambdaArtifacts: RetainedLambdaArtifactSet;
  readonly staticFrontend: RetainedStaticFrontend;
}

export type AcceptedDynamoDbRecoverySelection =
  | Readonly<{
      selectionType: 'dynamodb-recovery';
      phase: 'primary_active';
      quiesced: false;
      servesReplacement: false;
      enabled: false;
    }>
  | Readonly<{
      selectionType: 'dynamodb-recovery';
      phase: Exclude<DynamoDbRecoveryPhase, 'primary_active'>;
      quiesced: boolean;
      servesReplacement: boolean;
      enabled: true;
      manifest: ImmutableObjectReference;
    }>;

export interface DynamoDbRecoveryPhaseManifestEvidence extends ImmutableObjectReference {
  readonly recoveryId: string;
  readonly recoveryPoint: string;
  readonly replacement: Readonly<{
    sessionsTableArn: string;
    votesTableArn: string;
  }>;
}

export interface DynamoDbRecoveryPhaseEvidence {
  readonly evidenceType: 'dynamodb-recovery-phase-smoke';
  readonly phase: DynamoDbRecoveryPhase;
  readonly quiesced: boolean;
  readonly servesReplacement: boolean;
  readonly admissionEnabled: boolean;
  readonly eventSourceMappingsEnabled: boolean;
  readonly manifest: DynamoDbRecoveryPhaseManifestEvidence | null;
  readonly checks: Readonly<{
    selectionMatchesOutput: true;
    servedPairMatchesPhase: true;
    admissionMatchesPhase: true;
    liveAdmissionMatchesOutput: true;
    manifestMatchesSelectionAndOutput: true;
    liveStoreLambdaConfigsMatchServedPair: true;
    eventSourceMappingDesiredStateMatchesPhase: true;
    liveEventSourceMappingsMatchDesiredState: true;
  }>;
}

export interface StaticFrontendDeploymentSummary {
  readonly path: string;
  readonly frontendBucketName: string;
  readonly cloudfrontDistributionId: string;
  readonly cloudfrontDistributionDomain: string;
  readonly operatorGateEnabled: true;
  readonly artifactSha256: string;
  readonly publicFrontendConfigSha256: string;
  readonly imageIdMapping: Readonly<{
    deployedPath: '/imageId-mapping.json';
    cacheControl: 'no-cache';
    sha256: string;
  }>;
  readonly stablePublicAssets: Readonly<{
    paths: readonly ['/patterns/*', '/textures/*'];
    cacheControl: 'public,max-age=300';
    cloudFrontCachePolicy: 'frontend_app_shell';
  }>;
  readonly invalidationId: string;
}

export interface AcceptedDeploymentRecord {
  readonly recordType: 'app-accepted-deployment';
  readonly sourceSha: string;
  readonly selectedSourceSha: string;
  readonly controlSourceSha: string;
  readonly deploymentMode: 'normal' | 'rollback';
  readonly dynamodbRecoveryPhase: DynamoDbRecoveryPhase;
  readonly deploymentEnvironment: string;
  readonly pipelineExecutionId: string;
  readonly acceptanceAttemptId: string;
  readonly deploymentId: string;
  readonly deploymentIdentityAuthoritySha256: string;
  readonly accountId: string;
  readonly stateIdentity: string;
  readonly backendKey: string;
  readonly accepted: true;
  readonly acceptedAfter: readonly string[];
  readonly planChecksum: string;
  readonly planEmpty: boolean;
  readonly resourceChangeCount: number;
  readonly outputChangeCount: number;
  readonly movedResourceChangeCount: number;
  readonly importingResourceChangeCount: number;
  readonly manualApprovalSkipped: boolean;
  readonly approvalReason: 'empty-plan' | 'manual-approval';
  readonly approvalEvidence: Readonly<{ path: string; versionId: string; sha256: string }>;
  readonly releaseAuthority: Readonly<Record<string, unknown>>;
  readonly retainedDeployables: RetainedDeployables;
  readonly retainedDeploymentArtifacts: RetainedDeploymentArtifacts;
  readonly dynamodbRecoverySelection: AcceptedDynamoDbRecoverySelection;
  readonly dynamodbRecoveryPhaseEvidence: DynamoDbRecoveryPhaseEvidence;
  readonly rollbackSelection: Readonly<Record<string, unknown>> | null;
  readonly staticFrontendDeploy: StaticFrontendDeploymentSummary;
}

export type AppApprovalEvidence = Readonly<
  {
    evidenceType: 'app-approval';
    pipelineExecutionId: string;
    deploymentMode: 'normal' | 'rollback';
    controlSourceSha: string;
    selectedSourceSha: string;
    sourceSha: string;
    accountId: string;
    deploymentEnvironment: string;
    reviewedPlanChecksum: string;
  } & (
    | {
        approvalMode: 'manual-approval';
        stageName: 'ManualApproval';
        actionName: 'ApproveTargetRuntimeApply';
        manualApprovalSkipped: false;
        approver: string;
        approvalTimestamp: string;
      }
    | {
        approvalMode: 'empty-plan-skip';
        manualApprovalSkipped: true;
        approver: null;
        approvalTimestamp: null;
        planEmptyEvidence: Readonly<{
          evidenceType: 'app-plan-empty';
          planEmpty: true;
          resourceChangeCount: 0;
          outputChangeCount: 0;
          movedResourceChangeCount: 0;
          importingResourceChangeCount: 0;
        }>;
      }
  )
>;

export type AppSmokeReport = Readonly<
  Record<string, unknown> & {
    reportType: 'app-smoke-report';
    pipelineExecutionId: string;
    acceptanceAttemptId: string;
    sourceSha: string;
    selectedSourceSha: string;
    controlSourceSha: string;
    planChecksum: string;
    checks: Readonly<Record<string, unknown>>;
  }
>;

export function exactKeys(value: unknown, expectedKeys: readonly string[], label: string): Record<string, unknown>;
export function validateAppApprovalEvidence(value: unknown): AppApprovalEvidence;
export function validateAppSmokeReport(value: unknown): AppSmokeReport;
export function validateAcceptedDeploymentCurrentAuthorityEntry(
  value: unknown,
  options?: Readonly<{ allowPendingManifestVersion?: boolean }>,
): Record<string, unknown>;
export function validateAcceptedDeploymentCurrentAuthority(
  value: unknown,
  options?: Readonly<{ allowPendingFirst?: boolean }>,
): Record<string, unknown>;
export function validateAcceptedDeploymentCurrentAuthorityUpdate(
  previousAuthority: unknown,
  candidateAuthority: unknown,
  options: Readonly<{ priorExists: boolean }>,
): Record<string, unknown>;
export function validateAcceptedDeploymentForwardProjection(
  previousAuthority: unknown,
  retainedAuthority: unknown,
  classificationEvidence: unknown,
  options: Readonly<{ expectedPredecessorAuthoritySha256: string }>,
): Readonly<{
  previous: Record<string, unknown>;
  retained: Record<string, unknown>;
  evidence: Record<string, unknown>;
}>;
export function validateAcceptedDeploymentRecord(value: unknown): AcceptedDeploymentRecord;
export function validateAcceptedDeploymentCurrentAuthorityProjection(
  acceptedValue: unknown,
  entryValue: unknown,
  options: Readonly<{
    expectedManifestSha256: string;
    allowPendingManifestVersion?: boolean;
    expectedApplyOutputsSha256?: string;
  }>,
): Readonly<{ accepted: AcceptedDeploymentRecord; entry: Record<string, unknown> }>;
export function validateSmokeDenialEvidence(value: unknown): Record<string, unknown>;
