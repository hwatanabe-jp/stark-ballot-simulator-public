export type CanonicalJsonValue =
  null | boolean | number | string | readonly CanonicalJsonValue[] | { readonly [key: string]: CanonicalJsonValue };

export interface ImmutableObjectReference {
  readonly key: string;
  readonly versionId: string;
  readonly sha256: string;
}

export interface PointerCompareAndSwapInput {
  readonly expectedVersionOrEtag: string;
  readonly observedVersionOrEtag: string;
}

export interface SourcePinComparison {
  readonly requestedSourceSha: string;
  readonly sourceActionSourceSha: string;
  readonly resolvedSourceSha: string;
}

export interface AwsSsoCallerIdentity {
  readonly Account: string;
  readonly Arn: string;
}

export interface ValidatedAwsSsoCallerIdentity {
  readonly accountId: string;
  readonly arn: string;
}

export interface ImageSigningIdentity {
  readonly namePrefix: string;
  readonly signingProfileName: string;
  readonly signingProfileArn: string;
  readonly repositories: {
    readonly prover: string;
    readonly toolchain: string;
  };
}

export interface DigestPinnedImagePolicy {
  readonly partition: 'aws';
  readonly accountId: string;
  readonly region: string;
  readonly repository: string;
}

export interface DigestPinnedImageReference extends DigestPinnedImagePolicy {
  readonly digest: string;
  readonly imageUri: string;
}

export interface ImmutablePublicationInput {
  readonly observedSha256: string | undefined;
  readonly proposedSha256: string;
}

export interface DeploymentIdentityInput {
  readonly appDeploymentRecordSha256: string;
  readonly appSourceSha: string;
  readonly deployMode: 'normal' | 'rollback';
  readonly pipelineExecutionId: string;
}

export interface DeploymentIdentity {
  readonly identityType: 'app-deployment';
  readonly deploymentId: string;
  readonly authoritySha256: string;
  readonly authority: DeploymentIdentityInput;
}

export type DeploymentLane = 'app' | 'bootstrap' | 'foundation' | 'prover' | 'static-fast' | 'toolchain';

export interface AllowedDeploymentTarget {
  readonly targetKey: 'stark-dev/develop';
  readonly accountId: string;
  readonly projectId: string;
  readonly resourcePrefix: string;
  readonly stateNamespace: string;
  readonly artifactNamespace: string;
  readonly partition: 'aws';
  readonly accountLabel: string;
  readonly region: string;
  readonly environmentId: string;
  readonly environmentTier: string;
  readonly operatorPermissionSetName: string;
  readonly sourceProvider: 'github';
  readonly repository: string;
  readonly repositoryUrl: string;
  readonly sourceBranch: string;
  readonly sourceAction: string;
}

export interface RenderDeploymentLaneContextInput {
  readonly target: AllowedDeploymentTarget;
  readonly lane: DeploymentLane;
  readonly accountId: string;
  readonly requestedControlSourceSha: string;
  readonly selectedApplicationSourceSha: string;
  readonly frameworkSourceSha: string;
}

export interface DeploymentContextNames {
  readonly acceptedDeploymentPointerKey: string;
  readonly pipeline: string;
  readonly sourceAction: string;
  readonly acceptedDeploymentPrefix: string;
  readonly appDeploymentRecordProject: string;
  readonly appDeploymentRecordRole: string;
  readonly appRetainedArtifactBucket: string;
  readonly appSignaturePreflightApplyProject: string;
  readonly appSignaturePreflightApplyRole: string;
  readonly appSignaturePreflightInvokeProject: string;
  readonly appSignaturePreflightInvokerRole: string;
  readonly appSignaturePreflightPlanProject: string;
  readonly appSignaturePreflightPlanRole: string;
  readonly appSignatureStateRefreshApplyProject: string;
  readonly appSignatureStateRefreshApplyRole: string;
  readonly appSignatureStateRefreshPlanProject: string;
  readonly appStaticDeployProject: string;
  readonly appStaticDeployRole: string;
  readonly appStaticFastDeployProject: string;
  readonly appStaticFastDeployRole: string;
  readonly appStaticFastGateProject: string;
  readonly appStaticFastGateRole: string;
  readonly appStaticFastPipelineRole: string;
  readonly appStaticFastSmokeProject: string;
  readonly appStaticFastSmokeRole: string;
  readonly approvalEvidencePrefix: string;
  readonly artifactBucket: string;
  readonly artifactKmsAlias: string;
  readonly deploymentRecordPrefix: string;
  readonly ecrRetentionFunction: string;
  readonly ecrRetentionLogGroup: string;
  readonly ecrRetentionPermissionsBoundary: string;
  readonly ecrRetentionRole: string;
  readonly ecrRetentionSchedule: string;
  readonly finalizationStateMachine: string;
  readonly foundationSigningAuthorityPrefix: string;
  readonly foundationSigningResolverProject: string;
  readonly foundationSigningResolverRole: string;
  readonly foundationAppNetworkingKey: string;
  readonly frontendBucket: string;
  readonly githubTriggerRole: string;
  readonly lambdaArtifactPrefix: string;
  readonly pipelineRole: string;
  readonly proofBucket: string;
  readonly proverEcsCluster: string;
  readonly proverEcsTaskFamily: string;
  readonly proverAcceptedPointerKey: string;
  readonly proverCandidateProject: string;
  readonly proverCandidateRole: string;
  readonly proverPointerProject: string;
  readonly proverPointerRole: string;
  readonly proverReleasePrefix: string;
  readonly proverRepository: string;
  readonly proverToolchainResolverProject: string;
  readonly proverToolchainResolverRole: string;
  readonly recoveryManifestPrefix: string;
  readonly recoveryReadinessProject: string;
  readonly recoveryReadinessReportPrefix: string;
  readonly recoveryReadinessRole: string;
  readonly releaseManifestBucket: string;
  readonly rollbackReadinessProject: string;
  readonly rollbackReadinessReportPrefix: string;
  readonly rollbackReadinessRole: string;
  readonly runtimeConfigReferencePrefix: string;
  readonly runtimeNamePrefix: string;
  readonly runtimeSecretReferencePrefix: string;
  readonly signatureRuntimeNamePrefix: string;
  readonly signaturePreflightPrefix: string;
  readonly signatureVerifierFunction: string;
  readonly signatureVerifierPermissionsBoundary: string;
  readonly signatureVerifierRole: string;
  readonly signerProfile: string;
  readonly smokeProject: string;
  readonly staticFrontendArtifactPrefix: string;
  readonly terraformAuthorityBucket: string;
  readonly terraformAuthorityKmsAlias: string;
  readonly terraformBaselinePrefix: string;
  readonly terraformApplyProject: string;
  readonly terraformApplyRole: string;
  readonly terraformDriftAppProject: string;
  readonly terraformDriftAppProviderCorePolicy: string;
  readonly terraformDriftAppProviderRuntimePolicy: string;
  readonly terraformDriftBootstrapProject: string;
  readonly terraformDriftCoordinatorAuthorityEnvironmentPolicy: string;
  readonly terraformDriftCoordinatorExecutionEnvironmentPolicy: string;
  readonly terraformDriftCoordinatorProject: string;
  readonly terraformDriftCoordinatorRequestShapePolicy: string;
  readonly terraformDriftCoordinatorRole: string;
  readonly terraformDriftFoundationProject: string;
  readonly terraformDriftReportPrefix: string;
  readonly terraformDriftRunnerRole: string;
  readonly terraformDriftSchedule: string;
  readonly terraformDriftScheduleRole: string;
  readonly terraformPlanProject: string;
  readonly terraformPlanRole: string;
  readonly terraformStateBucket: string;
  readonly terraformStateKmsAlias: string;
  readonly terraformSmokeRole: string;
  readonly toolchainAcceptedPointerKey: string;
  readonly toolchainArtifactPrefix: string;
  readonly toolchainCandidateProject: string;
  readonly toolchainCandidateRole: string;
  readonly toolchainPointerProject: string;
  readonly toolchainPointerRole: string;
  readonly toolchainRepository: string;
  readonly validateProject: string;
  readonly targetLambdaFunctions: {
    readonly finalizationWriter: string;
    readonly imageSignatureVerifier: string;
    readonly proofDispatcher: string;
    readonly publicApi: string;
    readonly semaphoreJanitor: string;
    readonly verificationWorker: string;
  };
  readonly targetLogGroups: {
    readonly finalizationWriter: string;
    readonly imageSignatureVerifier: string;
    readonly opsLedger: string;
    readonly proofDispatcher: string;
    readonly prover: string;
    readonly publicApi: string;
    readonly semaphoreJanitor: string;
    readonly verificationWorker: string;
  };
}

export type DeploymentLaneAuthorityNames = DeploymentContextNames;

export type DeploymentTargetLaneNames = Pick<
  DeploymentContextNames,
  | 'artifactBucket'
  | 'artifactKmsAlias'
  | 'githubTriggerRole'
  | 'pipeline'
  | 'pipelineRole'
  | 'smokeProject'
  | 'terraformApplyProject'
  | 'terraformApplyRole'
  | 'terraformPlanProject'
  | 'terraformPlanRole'
  | 'terraformSmokeRole'
  | 'validateProject'
>;

export type SharedDeploymentTargetNames = Omit<
  DeploymentContextNames,
  keyof DeploymentTargetLaneNames | 'sourceAction'
>;

export interface DeploymentTargetLaneConfiguration {
  readonly scope: 'app' | 'bootstrap' | 'foundation';
  readonly stateIdentity: string;
  readonly backendKey: string;
  readonly policy: Readonly<{ signatureVerificationRequired: boolean }>;
  readonly names: DeploymentTargetLaneNames;
}

export interface ReviewedDeploymentTarget extends AllowedDeploymentTarget {
  readonly sharedNames: SharedDeploymentTargetNames;
  readonly lanes: Readonly<Record<DeploymentLane, DeploymentTargetLaneConfiguration>>;
}

export interface DeploymentTargetConfiguration {
  readonly configurationType: 'deployment-target-configuration';
  readonly allowedTargets: Readonly<{ 'stark-dev/develop': ReviewedDeploymentTarget }>;
}

export interface DeploymentLaneContext {
  readonly contextType: 'deployment-lane-context';
  readonly project: {
    readonly projectId: string;
    readonly resourcePrefix: string;
    readonly stateNamespace: string;
    readonly artifactNamespace: string;
  };
  readonly target: {
    readonly partition: 'aws';
    readonly accountId: string;
    readonly accountLabel: string;
    readonly region: string;
    readonly environmentId: string;
    readonly environmentTier: string;
    readonly operatorPermissionSetName: string;
  };
  readonly root: {
    readonly lane: DeploymentLane;
    readonly scope: 'app' | 'bootstrap' | 'foundation';
    readonly stateIdentity: string;
    readonly backendKey: string;
  };
  readonly source: {
    readonly branch: string;
    readonly provider: 'github';
    readonly repository: string;
    readonly repositoryUrl: string;
    readonly requestedControlSourceSha: string;
    readonly selectedApplicationSourceSha: string;
    readonly frameworkSourceSha: string;
  };
  readonly names: DeploymentContextNames;
  readonly policy: {
    readonly signatureVerificationRequired: boolean;
  };
  readonly targetConfigurationSha256: string;
}

export interface DeploymentLaneAuthority {
  readonly lane: DeploymentLane;
  readonly scope: 'app' | 'bootstrap' | 'foundation';
  readonly stateIdentity: string;
  readonly backendKey: string;
  readonly names: DeploymentLaneAuthorityNames;
  readonly policy: DeploymentLaneContext['policy'];
}

export function canonicalJson(value: unknown): string;
export function canonicalJsonSha256(value: unknown): string;
export function canonicalRecordJson(value: unknown): string;
export function parseFullSourceSha(value: unknown, label?: string): string;
export function parseGitCommitSha(value: unknown, label?: string): string;
export function parseSha256(value: unknown, label?: string): string;
export function parseImageDigest(value: unknown, label?: string): string;
export function parseS3VersionId(value: unknown, label?: string): string;
export function assertMatchingSourcePins(value: SourcePinComparison): void;
export function parseDigestPinnedImageReference(
  value: unknown,
  policy: DigestPinnedImagePolicy,
): DigestPinnedImageReference;
export function classifyImmutablePublication(value: ImmutablePublicationInput): 'create' | 'idempotent-retry';
export function immutableObjectReferencesEqual(left: unknown, right: unknown): boolean;
export function deriveDeploymentIdentity(input: unknown): DeploymentIdentity;
export function validateDeploymentIdentity(value: unknown): DeploymentIdentity;
export function parseImmutableObjectReference(value: unknown): ImmutableObjectReference;
export function assertFirstPublication(observedVersionId: string | undefined): void;
export function assertPointerCompareAndSwap(value: PointerCompareAndSwapInput): void;
export function validateAcceptedReleasePointer(
  value: unknown,
  imageKind: 'toolchain' | 'prover',
): Readonly<Record<string, unknown>>;
export function parseDeploymentTargetConfiguration(value: unknown): DeploymentTargetConfiguration;
export function resolveAllowedDeploymentTarget(targetKey: string): AllowedDeploymentTarget;
export function validateAwsSsoCallerIdentity(
  value: unknown,
  target: AllowedDeploymentTarget,
): ValidatedAwsSsoCallerIdentity;
export function resolveImageSigningIdentity(target: AllowedDeploymentTarget): ImageSigningIdentity;
export function resolveDeploymentLaneAuthority(
  target: AllowedDeploymentTarget,
  lane: DeploymentLane,
): DeploymentLaneAuthority;
export function renderDeploymentLaneContext(input: unknown): DeploymentLaneContext;
export function parseDeploymentLaneContext(value: unknown): DeploymentLaneContext;
