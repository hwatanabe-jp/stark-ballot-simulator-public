export type TerraformBaselineRoot = 'bootstrap' | 'foundation' | 'app';
export type TerraformBaselinePlatform = 'linux_amd64' | 'linux_arm64';
export type TerraformBaselineSecretReferenceSource = 'ssm-parameter' | 'secrets-manager-secret';

export interface TerraformBaselineImmutableObjectReference {
  readonly key: string;
  readonly versionId: string;
  readonly sha256: string;
}

export interface TerraformBaselineSecretReference {
  readonly inputName: string;
  readonly source: TerraformBaselineSecretReferenceSource;
  readonly reference: string;
}

export interface TerraformBaselineNonsecretInputFile {
  readonly path: string;
  readonly sha256: string;
  readonly contentBase64: string;
}

export interface TerraformBaselineNonsecretInputs {
  readonly evidenceType: 'terraform-baseline-nonsecret-inputs';
  readonly root: TerraformBaselineRoot;
  readonly files: readonly TerraformBaselineNonsecretInputFile[];
  readonly secretValuesIncluded: false;
}

export interface TerraformBackendAuthority {
  readonly bucketName: string;
  readonly backendKey: string;
  readonly kmsKeyArn: string;
  readonly region: string;
}

export interface TerraformBaselineInputIdentityOptions {
  readonly deploymentMode?: 'normal' | 'rollback';
  readonly stateBucketName?: string;
  readonly stateKmsAlias?: string;
  readonly stateKmsKeyArn?: string;
  readonly terraformVersion?: string;
}

export type CodeBuildRuntimeProjectKey = 'terraformPlanProject' | 'appSignaturePreflightPlanProject';

export interface CodeBuildRuntimeEvidenceOptions {
  readonly projectKey: CodeBuildRuntimeProjectKey;
}

export interface CodeBuildRuntimeEvidence {
  readonly evidenceType: 'codebuild-runtime';
  readonly targetKey: 'stark-dev/develop';
  readonly lane: TerraformBaselineRoot;
  readonly stateIdentity: string;
  readonly sourceSha: string;
  readonly project: {
    readonly key: CodeBuildRuntimeProjectKey;
    readonly name: string;
    readonly arn: string;
    readonly buildId: string;
  };
  readonly runtime: {
    readonly configuredImage: 'aws/codebuild/standard:8.0';
    readonly observedImage: 'aws/codebuild/standard:8.0';
    readonly computeType: 'BUILD_GENERAL1_SMALL';
    readonly environmentType: 'LINUX_CONTAINER';
    readonly privilegedMode: false;
  };
}

export interface TerraformBaselineIdentityEvidence {
  readonly terraformVersion: string;
  readonly platform: 'linux_amd64';
  readonly terraformOutdated: boolean;
  readonly providerSelections: Readonly<{ 'registry.terraform.io/hashicorp/aws': string }>;
}

interface TerraformBaselineRootAuthority {
  readonly root: TerraformBaselineRoot;
  readonly stateIdentity: string;
  readonly backendKey: string;
}

interface TerraformBaselineSourceAuthority extends TerraformBaselineRootAuthority {
  readonly controlSourceSha: string;
  readonly frameworkSourceSha: string;
  readonly targetContext: TerraformBaselineImmutableObjectReference;
}

export interface TerraformBaselineInputManifest extends TerraformBaselineSourceAuthority {
  readonly evidenceType: 'terraform-baseline-input-manifest';
  readonly nonsecretInputs: TerraformBaselineImmutableObjectReference;
  readonly secretReferences: readonly TerraformBaselineSecretReference[];
  readonly secretValuesIncluded: false;
}

export interface TerraformBaselineProviderEvidence extends TerraformBaselineSourceAuthority {
  readonly evidenceType: 'terraform-baseline-provider-evidence';
  readonly providerLock: TerraformBaselineImmutableObjectReference;
  readonly providerSelections: TerraformBaselineImmutableObjectReference;
  readonly runtimeEvidence: TerraformBaselineImmutableObjectReference;
  readonly terraformVersion: string;
  readonly platform: TerraformBaselinePlatform;
}

export interface TerraformBaselineAcceptanceEvidence extends TerraformBaselineRootAuthority {
  readonly evidenceType: 'terraform-baseline-acceptance';
  readonly controlSourceSha: string;
  readonly frameworkSourceSha: string;
  readonly acceptedPlanChecksum: string;
  readonly pipelineExecutionId: string;
  readonly stageName: 'ManualApproval';
  readonly actionName: 'ApproveInitialDevelopmentApply' | 'ApproveFoundationApply';
  readonly actionExecutionId: string;
  readonly sourceSha: string;
  readonly accountId: string;
  readonly deploymentEnvironment: string;
  readonly reviewedPlanChecksum: string;
  readonly approver: string;
  readonly approvalTimestamp: string;
}

export interface TerraformBaselineSmokeAdmission extends TerraformBaselineSourceAuthority {
  readonly evidenceType: 'terraform-baseline-smoke-admission';
  readonly acceptedPlanChecksum: string;
  readonly pipelineExecutionId: string;
  readonly specializedSmokeType: 'bootstrap-codebuild-log-group-state' | 'foundation-smoke' | 'app-smoke-report';
  readonly specializedSmokeSha256: string;
  readonly smokeResult: 'passed';
}

export interface AcceptedTerraformBaseline extends TerraformBaselineSourceAuthority {
  readonly recordType: 'accepted-terraform-baseline';
  readonly backend: TerraformBackendAuthority;
  readonly inputManifest: TerraformBaselineImmutableObjectReference;
  readonly providerEvidence: TerraformBaselineImmutableObjectReference;
  readonly acceptedPlanChecksum: string;
  readonly acceptanceEvidence: TerraformBaselineImmutableObjectReference;
  readonly smokeEvidence: TerraformBaselineImmutableObjectReference;
  readonly pipelineExecutionId: string;
  readonly publishedAt: string;
}

export interface AppTerraformBaselineConfiguration {
  readonly stateIdentity: string;
  readonly backendKey: string;
}

export interface AppTerraformBaselineCandidate {
  readonly pipelineExecutionId: string;
  readonly acceptanceAttemptId: string;
  readonly planChecksum: string;
  readonly controlSourceSha: string;
}

export interface AppTerraformBaselineManifest
  extends AppTerraformBaselineCandidate, AppTerraformBaselineConfiguration {}

export interface AdmittedAppTerraformBaselineBinding extends AppTerraformBaselineConfiguration {
  readonly root: TerraformBaselineRoot;
  readonly pipelineExecutionId: string;
  readonly acceptedPlanChecksum: string;
  readonly controlSourceSha: string;
}

export interface BindAdmittedAppTerraformBaselineInput {
  readonly baselinePrefix: string;
  readonly configuration: AppTerraformBaselineConfiguration;
  readonly candidate: AppTerraformBaselineCandidate;
  readonly manifest: AppTerraformBaselineManifest;
  readonly baseline: AdmittedAppTerraformBaselineBinding;
  readonly baselineReference: unknown;
  readonly fetchedBaselineSha256: string;
}

export interface CurrentTerraformBaselinePointer extends TerraformBaselineRootAuthority {
  readonly pointerType: 'current-terraform-baseline';
  readonly root: 'bootstrap' | 'foundation';
  readonly baseline: TerraformBaselineImmutableObjectReference;
}

export function buildTerraformBaselineSecretReferences(
  root: TerraformBaselineRoot,
  context: unknown,
): readonly TerraformBaselineSecretReference[];
export function validateTerraformBaselineInputManifest(value: unknown): TerraformBaselineInputManifest;
export function validateTerraformBackendAuthority(
  value: unknown,
  root: TerraformBaselineRoot,
): TerraformBackendAuthority;
export function validateTerraformBaselineNonsecretInputs(value: unknown): TerraformBaselineNonsecretInputs;
export function buildTerraformBaselineNonsecretInputs(
  root: TerraformBaselineRoot,
  terraformPlanDocument: unknown,
): TerraformBaselineNonsecretInputs;
export function decodeTerraformBaselineNonsecretInputValues(value: unknown): Readonly<Record<string, unknown>>;
export function validateTerraformBaselineInputIdentity(
  value: unknown,
  context: unknown,
  options?: TerraformBaselineInputIdentityOptions,
): TerraformBaselineNonsecretInputs;
export function validateCodeBuildBuildId(value: unknown, expectedProjectName: unknown): string;
export function validateCodeBuildRuntimeEvidence(
  value: unknown,
  context: unknown,
  options?: CodeBuildRuntimeEvidenceOptions,
): CodeBuildRuntimeEvidence;
export function validateTerraformBaselineIdentityEvidence(value: unknown): TerraformBaselineIdentityEvidence;
export function validateTerraformBaselineProviderSelections(
  value: unknown,
  terraformIdentity: unknown,
): TerraformBaselineIdentityEvidence['providerSelections'];
export function validateTerraformBaselineProviderLock(body: unknown, terraformIdentity: unknown): Uint8Array;
export function validateTerraformBaselineProviderEvidence(value: unknown): TerraformBaselineProviderEvidence;
export function validateTerraformBaselineAcceptanceEvidence(value: unknown): TerraformBaselineAcceptanceEvidence;
export function validateTerraformBaselineSmokeAdmission(value: unknown): TerraformBaselineSmokeAdmission;
export function validateAcceptedTerraformBaseline(value: unknown): AcceptedTerraformBaseline;
export function bindAdmittedAppTerraformBaseline(
  value: BindAdmittedAppTerraformBaselineInput,
): TerraformBaselineImmutableObjectReference;
export function validateCurrentTerraformBaselinePointer(value: unknown): CurrentTerraformBaselinePointer;
