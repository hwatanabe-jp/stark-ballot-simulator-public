import {
  assembleDeploymentContext,
  assertMatchingSourcePins,
  assertPointerCompareAndSwap,
  canonicalJson,
  canonicalJsonSha256,
  canonicalRecordJson,
  classifyImmutablePublication,
  deepFreeze,
  hasControlCharacter,
  parseFullSourceSha,
  parseGitCommitSha,
  parseImmutableObjectReference,
  parseImageDigest,
  parseDigestPinnedImageReference,
  parseS3VersionId,
  parseSha256,
  requireExactKeys,
  requireGroupedLowercaseUuid,
  requireString,
  sha256Text,
  validateCanonicalSha256Binding,
} from './internal.js';
import rawDeploymentTargetConfiguration from '../deployment-targets.json' with { type: 'json' };

/**
 * @typedef {import('./canonical-json-value.js').CanonicalJsonValue} CanonicalJsonValue
 */

/**
 * @typedef {{
 *     readonly key: string;
 *     readonly versionId: string;
 *     readonly sha256: string;
 * }} ImmutableObjectReference
 */

/**
 * @typedef {{
 *     readonly expectedVersionOrEtag: string;
 *     readonly observedVersionOrEtag: string;
 * }} PointerCompareAndSwapInput
 */

/**
 * @typedef {{
 *     readonly requestedSourceSha: string;
 *     readonly sourceActionSourceSha: string;
 *     readonly resolvedSourceSha: string;
 * }} SourcePinComparison
 */

/**
 * @typedef {{
 *     readonly Account: string;
 *     readonly Arn: string;
 * }} AwsSsoCallerIdentity
 */

/**
 * @typedef {{
 *     readonly accountId: string;
 *     readonly arn: string;
 * }} ValidatedAwsSsoCallerIdentity
 */

/**
 * @typedef {{
 *     readonly namePrefix: string;
 *     readonly signingProfileName: string;
 *     readonly signingProfileArn: string;
 *     readonly repositories: {
 *         readonly prover: string;
 *         readonly toolchain: string;
 *     };
 * }} ImageSigningIdentity
 */

/**
 * @typedef {{
 *     readonly partition: 'aws';
 *     readonly accountId: string;
 *     readonly region: string;
 *     readonly repository: string;
 * }} DigestPinnedImagePolicy
 */

/**
 * @typedef {DigestPinnedImagePolicy & {
 *     readonly digest: string;
 *     readonly imageUri: string;
 * }} DigestPinnedImageReference
 */

/**
 * @typedef {{
 *     readonly observedSha256: string | undefined;
 *     readonly proposedSha256: string;
 * }} ImmutablePublicationInput
 */

/**
 * @typedef {{
 *     readonly appExecutionAuthoritySha256: string;
 *     readonly appSourceSha: string;
 *     readonly deployMode: 'normal';
 *     readonly pipelineExecutionId: string;
 * }} DeploymentIdentityInput
 */

/**
 * @typedef {{
 *     readonly identityType: 'app-deployment';
 *     readonly deploymentId: string;
 *     readonly authoritySha256: string;
 *     readonly authority: DeploymentIdentityInput;
 * }} DeploymentIdentity
 */

/**
 * @typedef {'stark-dev/develop' | 'stark-prod/main'} DeploymentTargetKey
 * @typedef {'app' | 'bootstrap' | 'foundation' | 'prover' | 'toolchain'} DeploymentLane
 */

/**
 * @typedef {{
 *     readonly targetKey: DeploymentTargetKey;
 *     readonly accountId: string;
 *     readonly projectId: string;
 *     readonly resourcePrefix: string;
 *     readonly stateNamespace: string;
 *     readonly artifactNamespace: string;
 *     readonly partition: 'aws';
 *     readonly accountLabel: string;
 *     readonly region: string;
 *     readonly environmentId: string;
 *     readonly environmentTier: string;
 *     readonly operatorPermissionSetName: string;
 *     readonly sourceProvider: 'github';
 *     readonly repository: string;
 *     readonly repositoryUrl: string;
 *     readonly sourceBranch: string;
 *     readonly sourceAction: string;
 * }} AllowedDeploymentTarget
 */

/**
 * @typedef {{
 *     readonly target: AllowedDeploymentTarget;
 *     readonly lane: DeploymentLane;
 *     readonly accountId: string;
 *     readonly requestedControlSourceSha: string;
 *     readonly selectedApplicationSourceSha: string;
 *     readonly frameworkSourceSha: string;
 * }} RenderDeploymentLaneContextInput
 */

/**
 * @typedef {{
 *     readonly acceptedDeploymentPointerKey: string;
 *     readonly pipeline: string;
 *     readonly sourceAction: string;
 *     readonly acceptedDeploymentPrefix: string;
 *     readonly appAcceptancePublisherRole: string;
 *     readonly appDeploymentStatusKey: string;
 *     readonly appDeploymentStatusPublisherProject: string;
 *     readonly appDeploymentStatusPublisherRole: string;
 *     readonly appExecutionAuthorityProject: string;
 *     readonly appExecutionAuthorityRole: string;
 *     readonly appRetainedArtifactBucket: string;
 *     readonly retainedAppSignaturePreflightApplyProject: string;
 *     readonly retainedAppSignaturePreflightPlanProject: string;
 *     readonly retainedAppSignaturePreflightVerifyProject: string;
 *     readonly retiredImageRetentionRole: string;
 *     readonly retiredImageRetentionBoundaryPolicy: string;
 *     readonly appSignatureStateRefreshApplyProject: string;
 *     readonly appSignatureStateRefreshApplyRole: string;
 *     readonly appSignatureStateRefreshPlanProject: string;
 *     readonly appStaticDeployProject: string;
 *     readonly appStaticDeployRole: string;
 *     readonly approvalEvidencePrefix: string;
 *     readonly artifactBucket: string;
 *     readonly artifactKmsAlias: string;
 *     readonly bootstrapTerraformAcceptancePublisherRole: string;
 *     readonly finalizationStateMachine: string;
 *     readonly foundationTerraformAcceptancePublisherRole: string;
 *     readonly foundationSigningAuthorityPrefix: string;
 *     readonly foundationSigningResolverProject: string;
 *     readonly foundationSigningResolverRole: string;
 *     readonly foundationAppNetworkingKey: string;
 *     readonly frontendBucket: string;
 *     readonly githubTriggerRole: string;
 *     readonly lambdaArtifactPrefix: string;
 *     readonly pipelineRole: string;
 *     readonly proofBucket: string;
 *     readonly proverEcsCluster: string;
 *     readonly proverEcsTaskFamily: string;
 *     readonly proverAcceptedPointerKey: string;
 *     readonly proverCandidateProject: string;
 *     readonly proverCandidateRole: string;
 *     readonly proverPointerProject: string;
 *     readonly proverPointerRole: string;
 *     readonly proverReleasePrefix: string;
 *     readonly proverRepository: string;
 *     readonly proverToolchainResolverProject: string;
 *     readonly proverToolchainResolverRole: string;
 *     readonly recoveryManifestPrefix: string;
 *     readonly releaseManifestBucket: string;
 *     readonly runtimeConfigReferencePrefix: string;
 *     readonly runtimeNamePrefix: string;
 *     readonly runtimeSecretReferencePrefix: string;
 *     readonly signatureRuntimeNamePrefix: string;
 *     readonly signaturePreflightPrefix: string;
 *     readonly signatureVerifierFunction: string;
 *     readonly signatureVerifierPermissionsBoundary: string;
 *     readonly signatureVerifierRole: string;
 *     readonly signerProfile: string;
 *     readonly smokeProject: string;
 *     readonly staticFrontendArtifactPrefix: string;
 *     readonly terraformAuthorityBucket: string;
 *     readonly terraformAuthorityKmsAlias: string;
 *     readonly terraformBaselinePrefix: string;
 *     readonly terraformApplyProject: string;
 *     readonly terraformApplyRole: string;
 *     readonly terraformDriftAppProject: string;
 *     readonly terraformDriftAppProviderCorePolicy: string;
 *     readonly terraformDriftAppProviderRuntimePolicy: string;
 *     readonly terraformDriftBootstrapProject: string;
 *     readonly terraformDriftCoordinatorAuthorityEnvironmentPolicy: string;
 *     readonly terraformDriftCoordinatorExecutionEnvironmentPolicy: string;
 *     readonly terraformDriftCoordinatorProject: string;
 *     readonly terraformDriftCoordinatorRequestShapePolicy: string;
 *     readonly terraformDriftCoordinatorRole: string;
 *     readonly terraformDriftFoundationProject: string;
 *     readonly terraformDriftReportPrefix: string;
 *     readonly terraformDriftRunnerRole: string;
 *     readonly terraformDriftSchedule: string;
 *     readonly terraformDriftScheduleRole: string;
 *     readonly terraformPlanProject: string;
 *     readonly terraformPlanRole: string;
 *     readonly terraformStateBucket: string;
 *     readonly terraformStateKmsAlias: string;
 *     readonly terraformSmokeRole: string;
 *     readonly toolchainAcceptedPointerKey: string;
 *     readonly toolchainArtifactPrefix: string;
 *     readonly toolchainCandidateProject: string;
 *     readonly toolchainCandidateRole: string;
 *     readonly toolchainPointerProject: string;
 *     readonly toolchainPointerRole: string;
 *     readonly toolchainRepository: string;
 *     readonly validateProject: string;
 *     readonly targetLambdaFunctions: {
 *         readonly finalizationWriter: string;
 *         readonly imageSignatureVerifier: string;
 *         readonly proofDispatcher: string;
 *         readonly publicApi: string;
 *         readonly semaphoreJanitor: string;
 *         readonly verificationWorker: string;
 *     };
 *     readonly targetLogGroups: {
 *         readonly finalizationWriter: string;
 *         readonly imageSignatureVerifier: string;
 *         readonly opsLedger: string;
 *         readonly proofDispatcher: string;
 *         readonly prover: string;
 *         readonly publicApi: string;
 *         readonly semaphoreJanitor: string;
 *         readonly verificationWorker: string;
 *     };
 * }} DeploymentContextNames
 */

/**
 * @typedef {DeploymentContextNames} DeploymentLaneAuthorityNames
 */

/**
 * @typedef {Pick<DeploymentContextNames, 'artifactBucket' | 'artifactKmsAlias' | 'githubTriggerRole' | 'pipeline' | 'pipelineRole' | 'smokeProject' | 'terraformApplyProject' | 'terraformApplyRole' | 'terraformPlanProject' | 'terraformPlanRole' | 'terraformSmokeRole' | 'validateProject'>} DeploymentTargetLaneNames
 */

/**
 * @typedef {Omit<DeploymentContextNames, keyof DeploymentTargetLaneNames | 'sourceAction'>} SharedDeploymentTargetNames
 */

/**
 * @typedef {{
 *     readonly scope: 'app' | 'bootstrap' | 'foundation';
 *     readonly stateIdentity: string;
 *     readonly backendKey: string;
 *     readonly policy: Readonly<{
 *         signatureVerificationRequired: boolean;
 *     }>;
 *     readonly names: DeploymentTargetLaneNames;
 * }} DeploymentTargetLaneConfiguration
 */

/**
 * @typedef {{
 *     readonly foundationPublicSubnetException: 'accepted-for-production-prover-egress';
 * }} ProductionDeploymentPolicy
 */

/**
 * @typedef {AllowedDeploymentTarget & {
 *     readonly sharedNames: SharedDeploymentTargetNames;
 *     readonly lanes: Readonly<Record<DeploymentLane, DeploymentTargetLaneConfiguration>>;
 * } & (
 *     { readonly targetKey: 'stark-dev/develop'; readonly productionPolicy?: never }
 *     | { readonly targetKey: 'stark-prod/main'; readonly productionPolicy: ProductionDeploymentPolicy }
 * )} ReviewedDeploymentTarget
 */

/**
 * @typedef {{
 *     readonly configurationType: 'deployment-target-configuration';
 *     readonly allowedTargets: Readonly<{
 *         'stark-dev/develop': ReviewedDeploymentTarget;
 *         'stark-prod/main'?: ReviewedDeploymentTarget;
 *     }>;
 * }} DeploymentTargetConfiguration
 */

/**
 * @typedef {{
 *     readonly contextType: 'deployment-lane-context';
 *     readonly project: {
 *         readonly projectId: string;
 *         readonly resourcePrefix: string;
 *         readonly stateNamespace: string;
 *         readonly artifactNamespace: string;
 *     };
 *     readonly target: {
 *         readonly partition: 'aws';
 *         readonly accountId: string;
 *         readonly accountLabel: string;
 *         readonly region: string;
 *         readonly environmentId: string;
 *         readonly environmentTier: string;
 *         readonly operatorPermissionSetName: string;
 *     };
 *     readonly root: {
 *         readonly lane: DeploymentLane;
 *         readonly scope: 'app' | 'bootstrap' | 'foundation';
 *         readonly stateIdentity: string;
 *         readonly backendKey: string;
 *     };
 *     readonly source: {
 *         readonly branch: string;
 *         readonly provider: 'github';
 *         readonly repository: string;
 *         readonly repositoryUrl: string;
 *         readonly requestedControlSourceSha: string;
 *         readonly selectedApplicationSourceSha: string;
 *         readonly frameworkSourceSha: string;
 *     };
 *     readonly names: DeploymentContextNames;
 *     readonly policy: {
 *         readonly signatureVerificationRequired: boolean;
 *     };
 *     readonly targetConfigurationSha256: string;
 * }} DeploymentLaneContext
 */

/**
 * @typedef {{
 *     readonly lane: DeploymentLane;
 *     readonly scope: 'app' | 'bootstrap' | 'foundation';
 *     readonly stateIdentity: string;
 *     readonly backendKey: string;
 *     readonly names: DeploymentLaneAuthorityNames;
 *     readonly policy: DeploymentLaneContext['policy'];
 * }} DeploymentLaneAuthority
 */

export {
  assertMatchingSourcePins,
  assertPointerCompareAndSwap,
  canonicalJson,
  canonicalJsonSha256,
  canonicalRecordJson,
  classifyImmutablePublication,
  parseDigestPinnedImageReference,
  parseFullSourceSha,
  parseGitCommitSha,
  parseImmutableObjectReference,
  parseImageDigest,
  parseS3VersionId,
  parseSha256,
  validateCanonicalSha256Binding,
};

const ACCOUNT_ID_PATTERN = /^[0-9]{12}$/u;

const DEPLOYMENT_TARGET_KEYS = [
  'accountId',
  'accountLabel',
  'artifactNamespace',
  'environmentId',
  'environmentTier',
  'lanes',
  'operatorPermissionSetName',
  'partition',
  'projectId',
  'region',
  'repository',
  'repositoryUrl',
  'resourcePrefix',
  'sharedNames',
  'sourceAction',
  'sourceBranch',
  'sourceProvider',
  'stateNamespace',
  'targetKey',
];
const ALLOWED_TARGET_KEYS = ['stark-dev/develop', 'stark-prod/main'];
/** @type {readonly DeploymentLane[]} */
const DEPLOYMENT_LANES = ['app', 'bootstrap', 'foundation', 'prover', 'toolchain'];
const DEPLOYMENT_LANE_SCOPES = Object.freeze({
  app: 'app',
  bootstrap: 'bootstrap',
  foundation: 'foundation',
  prover: 'foundation',
  toolchain: 'foundation',
});
const DEPLOYMENT_LANE_CONFIGURATION_KEYS = ['backendKey', 'names', 'policy', 'scope', 'stateIdentity'];
const DEPLOYMENT_LANE_NAME_KEYS = [
  'artifactBucket',
  'artifactKmsAlias',
  'githubTriggerRole',
  'pipeline',
  'pipelineRole',
  'smokeProject',
  'terraformApplyProject',
  'terraformApplyRole',
  'terraformPlanProject',
  'terraformPlanRole',
  'terraformSmokeRole',
  'validateProject',
];
/** @type {readonly (keyof DeploymentContextNames['targetLambdaFunctions'])[]} */
const TARGET_LAMBDA_FUNCTION_KEYS = [
  'finalizationWriter',
  'imageSignatureVerifier',
  'proofDispatcher',
  'publicApi',
  'semaphoreJanitor',
  'verificationWorker',
];
/** @type {readonly (keyof DeploymentContextNames['targetLogGroups'])[]} */
const TARGET_LOG_GROUP_KEYS = [
  'finalizationWriter',
  'imageSignatureVerifier',
  'opsLedger',
  'proofDispatcher',
  'prover',
  'publicApi',
  'semaphoreJanitor',
  'verificationWorker',
];

const CONTEXT_KEYS = [
  'contextType',
  'names',
  'policy',
  'project',
  'root',
  'source',
  'target',
  'targetConfigurationSha256',
];
const PROJECT_KEYS = ['artifactNamespace', 'projectId', 'resourcePrefix', 'stateNamespace'];
const TARGET_KEYS = [
  'accountId',
  'accountLabel',
  'environmentId',
  'environmentTier',
  'operatorPermissionSetName',
  'partition',
  'region',
];
const ROOT_KEYS = ['backendKey', 'lane', 'scope', 'stateIdentity'];
const SOURCE_KEYS = [
  'branch',
  'frameworkSourceSha',
  'provider',
  'repository',
  'repositoryUrl',
  'requestedControlSourceSha',
  'selectedApplicationSourceSha',
];
const NAME_KEYS = [
  'acceptedDeploymentPointerKey',
  'acceptedDeploymentPrefix',
  'appAcceptancePublisherRole',
  'appDeploymentStatusKey',
  'appDeploymentStatusPublisherProject',
  'appDeploymentStatusPublisherRole',
  'appExecutionAuthorityProject',
  'appExecutionAuthorityRole',
  'appRetainedArtifactBucket',
  'retainedAppSignaturePreflightApplyProject',
  'retainedAppSignaturePreflightPlanProject',
  'retainedAppSignaturePreflightVerifyProject',
  'retiredImageRetentionRole',
  'retiredImageRetentionBoundaryPolicy',
  'appSignatureStateRefreshApplyProject',
  'appSignatureStateRefreshApplyRole',
  'appSignatureStateRefreshPlanProject',
  'appStaticDeployProject',
  'appStaticDeployRole',
  'approvalEvidencePrefix',
  'artifactBucket',
  'artifactKmsAlias',
  'bootstrapTerraformAcceptancePublisherRole',
  'finalizationStateMachine',
  'foundationTerraformAcceptancePublisherRole',
  'foundationSigningAuthorityPrefix',
  'foundationSigningResolverProject',
  'foundationSigningResolverRole',
  'foundationAppNetworkingKey',
  'frontendBucket',
  'githubTriggerRole',
  'lambdaArtifactPrefix',
  'pipeline',
  'pipelineRole',
  'proofBucket',
  'proverEcsCluster',
  'proverEcsTaskFamily',
  'proverAcceptedPointerKey',
  'proverCandidateProject',
  'proverCandidateRole',
  'proverPointerProject',
  'proverPointerRole',
  'proverReleasePrefix',
  'proverRepository',
  'proverToolchainResolverProject',
  'proverToolchainResolverRole',
  'recoveryManifestPrefix',
  'releaseManifestBucket',
  'runtimeConfigReferencePrefix',
  'runtimeNamePrefix',
  'runtimeSecretReferencePrefix',
  'signatureRuntimeNamePrefix',
  'signaturePreflightPrefix',
  'signatureVerifierFunction',
  'signatureVerifierPermissionsBoundary',
  'signatureVerifierRole',
  'signerProfile',
  'smokeProject',
  'sourceAction',
  'staticFrontendArtifactPrefix',
  'terraformAuthorityBucket',
  'terraformAuthorityKmsAlias',
  'targetLambdaFunctions',
  'targetLogGroups',
  'terraformBaselinePrefix',
  'terraformApplyProject',
  'terraformApplyRole',
  'terraformDriftAppProject',
  'terraformDriftAppProviderCorePolicy',
  'terraformDriftAppProviderRuntimePolicy',
  'terraformDriftBootstrapProject',
  'terraformDriftCoordinatorAuthorityEnvironmentPolicy',
  'terraformDriftCoordinatorExecutionEnvironmentPolicy',
  'terraformDriftCoordinatorProject',
  'terraformDriftCoordinatorRequestShapePolicy',
  'terraformDriftCoordinatorRole',
  'terraformDriftFoundationProject',
  'terraformDriftReportPrefix',
  'terraformDriftRunnerRole',
  'terraformDriftSchedule',
  'terraformDriftScheduleRole',
  'terraformPlanProject',
  'terraformPlanRole',
  'terraformStateBucket',
  'terraformStateKmsAlias',
  'terraformSmokeRole',
  'toolchainAcceptedPointerKey',
  'toolchainArtifactPrefix',
  'toolchainCandidateProject',
  'toolchainCandidateRole',
  'toolchainPointerProject',
  'toolchainPointerRole',
  'toolchainRepository',
  'validateProject',
];
const POLICY_KEYS = ['signatureVerificationRequired'];
/** @type {readonly (keyof SharedDeploymentTargetNames)[]} */
const TERRAFORM_DRIFT_MANAGED_POLICY_NAME_KEYS = [
  'terraformDriftAppProviderCorePolicy',
  'terraformDriftAppProviderRuntimePolicy',
  'terraformDriftCoordinatorAuthorityEnvironmentPolicy',
  'terraformDriftCoordinatorExecutionEnvironmentPolicy',
  'terraformDriftCoordinatorRequestShapePolicy',
];
const SHARED_NAME_KEYS = NAME_KEYS.filter((key) => key !== 'sourceAction' && !DEPLOYMENT_LANE_NAME_KEYS.includes(key));
const S3_CONTEXT_NAME_KEYS = [
  'acceptedDeploymentPointerKey',
  'acceptedDeploymentPrefix',
  'appDeploymentStatusKey',
  'approvalEvidencePrefix',
  'foundationAppNetworkingKey',
  'foundationSigningAuthorityPrefix',
  'lambdaArtifactPrefix',
  'proverAcceptedPointerKey',
  'proverReleasePrefix',
  'recoveryManifestPrefix',
  'signaturePreflightPrefix',
  'staticFrontendArtifactPrefix',
  'terraformBaselinePrefix',
  'terraformDriftReportPrefix',
  'toolchainAcceptedPointerKey',
  'toolchainArtifactPrefix',
];
const APP_RETAINED_ARTIFACT_S3_NAME_KEYS = /** @type {const} */ ([
  'acceptedDeploymentPointerKey',
  'acceptedDeploymentPrefix',
  'approvalEvidencePrefix',
  'lambdaArtifactPrefix',
  'recoveryManifestPrefix',
  'signaturePreflightPrefix',
  'staticFrontendArtifactPrefix',
]);
const MAXIMUM_UUID_SEGMENT = '0'.repeat(36);
const MAXIMUM_SHA256_SEGMENT = '0'.repeat(64);
const MAXIMUM_SOURCE_SHA_SEGMENT = '0'.repeat(40);
const S3_PREFIX_DERIVED_SUFFIXES = Object.freeze({
  acceptedDeploymentPrefix: `/acceptances/${MAXIMUM_SHA256_SEGMENT}.json`,
  approvalEvidencePrefix: `/${MAXIMUM_UUID_SEGMENT}.json`,
  foundationSigningAuthorityPrefix: `/${MAXIMUM_SOURCE_SHA_SEGMENT}/authority.json`,
  lambdaArtifactPrefix: `/${MAXIMUM_SOURCE_SHA_SEGMENT}/image-signature-verifier.zip`,
  proverReleasePrefix: `/${MAXIMUM_UUID_SEGMENT}/manifest.json`,
  recoveryManifestPrefix: `/${MAXIMUM_SHA256_SEGMENT}.json`,
  signaturePreflightPrefix: `/executions/${MAXIMUM_UUID_SEGMENT}/attempts/${MAXIMUM_SHA256_SEGMENT}/verification.json`,
  staticFrontendArtifactPrefix: `/${MAXIMUM_SOURCE_SHA_SEGMENT}/dep_${'0'.repeat(32)}/dist.tar.gz`,
  toolchainArtifactPrefix: `/${MAXIMUM_UUID_SEGMENT}/manifest.json`,
});

/**
 * @param {unknown} value
 * @param {readonly string[]} expectedKeys
 * @param {string} label
 * @returns {Record<string, unknown>}
 */
function parseConfiguredNames(value, expectedKeys, label) {
  const record = requireExactKeys(value, expectedKeys, label);
  /** @type {Record<string, unknown>} */
  const names = {};
  for (const key of expectedKeys) {
    if (key === 'targetLambdaFunctions' || key === 'targetLogGroups') {
      const nestedKeys = key === 'targetLambdaFunctions' ? TARGET_LAMBDA_FUNCTION_KEYS : TARGET_LOG_GROUP_KEYS;
      const nestedNames = requireExactKeys(
        record[key],
        nestedKeys,
        key === 'targetLambdaFunctions' ? 'deployment target Lambda functions' : 'deployment target log groups',
      );
      names[key] = Object.fromEntries(
        nestedKeys.map((nestedKey) => [
          nestedKey,
          requireString(
            nestedNames[nestedKey],
            key === 'targetLambdaFunctions'
              ? `deployment target Lambda function ${nestedKey}`
              : `deployment target log group ${nestedKey}`,
          ),
        ]),
      );
      continue;
    }
    names[key] = requireString(record[key], `deployment target name ${key}`);
  }
  return names;
}

/**
 * @param {DeploymentContextNames} names
 * @returns {void}
 */
function assertConfiguredContextNames(names) {
  const nameKeys = NAME_KEYS;
  const configuredNames = requireExactKeys(names, nameKeys, 'deployment target context names');
  assertGeneratedPipelineName(names.pipeline);
  assertGeneratedCodePipelineActionName(names.sourceAction);
  assertGeneratedEcrRepository(names.proverRepository);
  assertGeneratedEcrRepository(names.toolchainRepository);
  assertGeneratedBucketName(names.artifactBucket);
  assertGeneratedBucketName(names.appRetainedArtifactBucket);
  assertGeneratedBucketName(names.releaseManifestBucket);
  assertGeneratedBucketName(names.proofBucket);
  assertGeneratedBucketName(names.frontendBucket);
  assertGeneratedBucketName(names.terraformAuthorityBucket);
  assertGeneratedBucketName(names.terraformStateBucket);
  for (const key of nameKeys.filter((key) => key.endsWith('Role'))) {
    assertGeneratedIamName(requireString(configuredNames[key], `deployment target name ${key}`), key);
  }
  for (const key of nameKeys.filter((key) => key.endsWith('Project'))) {
    assertGeneratedCodeBuildName(requireString(configuredNames[key], `deployment target name ${key}`));
  }
  for (const functionName of Object.values(names.targetLambdaFunctions)) {
    assertGeneratedLambdaName(functionName);
  }
  for (const logGroupName of Object.values(names.targetLogGroups)) {
    assertGeneratedCloudWatchLogGroupName(logGroupName);
  }
  assertGeneratedLambdaName(names.signatureVerifierFunction);
  assertGeneratedIamPolicyName(names.signatureVerifierPermissionsBoundary, 'signatureVerifierPermissionsBoundary');
  for (const key of nameKeys.filter((key) => key.endsWith('Policy'))) {
    assertGeneratedIamPolicyName(requireString(configuredNames[key], `deployment target name ${key}`), key);
  }
  assertGeneratedKmsAlias(names.artifactKmsAlias);
  assertGeneratedKmsAlias(names.terraformAuthorityKmsAlias);
  assertGeneratedKmsAlias(names.terraformStateKmsAlias);
  assertGeneratedSignerProfileName(names.signerProfile);
  assertGeneratedSsmParameterPrefix(names.runtimeConfigReferencePrefix);
  assertGeneratedSsmParameterPrefix(`${names.runtimeConfigReferencePrefix}/session-capability-ttl-seconds`);
  assertGeneratedSecretsManagerPrefix(names.runtimeSecretReferencePrefix);
  assertGeneratedSecretsManagerPrefix(`${names.runtimeSecretReferencePrefix}/vote-secret-encryption-key`);
  assertGeneratedResourceNamePrefix(names.runtimeNamePrefix, 'runtime');
  assertGeneratedResourceNamePrefix(names.signatureRuntimeNamePrefix, 'signature runtime');
  assertGeneratedEventBridgeRuleName(`${names.runtimeNamePrefix}-semaphore-janitor-sweep`);
  assertGeneratedEventBridgeRuleName(`${names.runtimeNamePrefix}-finalization-sweep`);
  assertGeneratedEventBridgeRuleName(names.terraformDriftSchedule);
  assertGeneratedCloudFrontFunctionName(`${names.runtimeNamePrefix}-frontend-spa-fallback`);
  assertGeneratedIamName(
    `${names.signatureRuntimeNamePrefix}-image-signature-verifier-role`,
    'image signature verifier role',
  );
  assertGeneratedLambdaName(`${names.signatureRuntimeNamePrefix}-image-signature-verifier`);
  for (const key of S3_CONTEXT_NAME_KEYS) {
    assertGeneratedS3Key(requireString(configuredNames[key], `deployment target name ${key}`), key);
  }
  for (const [key, suffix] of Object.entries(S3_PREFIX_DERIVED_SUFFIXES)) {
    assertGeneratedS3Key(
      `${requireString(configuredNames[key], `deployment target name ${key}`)}${suffix}`,
      `${key} derived`,
    );
  }
}

/**
 * @param {unknown} value
 * @param {DeploymentLane} lane
 * @param {SharedDeploymentTargetNames} sharedNames
 * @param {string} sourceAction
 * @param {AllowedDeploymentTarget} target
 * @returns {DeploymentTargetLaneConfiguration}
 */
function parseDeploymentLaneConfiguration(value, lane, sharedNames, sourceAction, target) {
  const record = requireExactKeys(value, DEPLOYMENT_LANE_CONFIGURATION_KEYS, `deployment target lane ${lane}`);
  const scope = requireString(record['scope'], `deployment target lane ${lane} scope`);
  const expectedScope = DEPLOYMENT_LANE_SCOPES[lane];
  if (scope !== expectedScope) {
    throw new Error(`deployment target lane ${lane} scope must be ${expectedScope}`);
  }
  const policy = requireExactKeys(record['policy'], POLICY_KEYS, `deployment target lane ${lane} policy`);
  if (typeof policy['signatureVerificationRequired'] !== 'boolean') {
    throw new Error(`deployment target lane ${lane} signature verification policy is invalid`);
  }
  const names = /** @type {DeploymentTargetLaneNames} */ (
    parseConfiguredNames(record['names'], DEPLOYMENT_LANE_NAME_KEYS, `deployment target lane ${lane} names`)
  );
  assertConfiguredContextNames(/** @type {DeploymentContextNames} */ ({ sourceAction, ...sharedNames, ...names }));
  const stateIdentity = requireString(record['stateIdentity'], `deployment target lane ${lane} state identity`);
  if (stateIdentity !== `${target.accountLabel}/${target.environmentId}/${scope}`) {
    throw new Error(`deployment target lane ${lane} state identity does not match its target and scope`);
  }
  const backendKey = requireString(record['backendKey'], `deployment target lane ${lane} backend key`);
  if (backendKey !== `${target.stateNamespace}/${scope}/terraform.tfstate`) {
    throw new Error(`deployment target lane ${lane} backend key does not match its target and scope`);
  }
  return {
    scope: expectedScope,
    stateIdentity,
    backendKey,
    policy: { signatureVerificationRequired: policy['signatureVerificationRequired'] },
    names,
  };
}

/**
 * @param {string} parsedTargetKey
 * @param {string} targetKey
 * @param {string} accountLabel
 * @param {string} environmentId
 * @returns {DeploymentTargetKey}
 */
function admitDeploymentTargetKey(parsedTargetKey, targetKey, accountLabel, environmentId) {
  if (parsedTargetKey !== `${accountLabel}/${environmentId}`) {
    throw new Error('deployment target key does not match accountLabel/environmentId');
  }
  if (
    parsedTargetKey !== targetKey ||
    (parsedTargetKey !== 'stark-dev/develop' && parsedTargetKey !== 'stark-prod/main')
  ) {
    throw new Error('deployment target key does not match its allowed-target entry');
  }
  return parsedTargetKey;
}

/**
 * @param {unknown} value
 * @param {string} targetKey
 * @returns {ReviewedDeploymentTarget}
 */
function parseAllowedDeploymentTarget(value, targetKey) {
  const record = requireExactKeys(
    value,
    targetKey === 'stark-prod/main' ? [...DEPLOYMENT_TARGET_KEYS, 'productionPolicy'] : DEPLOYMENT_TARGET_KEYS,
    'deployment allowed target',
  );
  const accountId = requireString(record['accountId'], 'deployment target accountId');
  const accountLabel = requireString(record['accountLabel'], 'deployment target accountLabel');
  const artifactNamespace = requireString(record['artifactNamespace'], 'deployment target artifactNamespace');
  const environmentId = requireString(record['environmentId'], 'deployment target environmentId');
  const environmentTier = requireString(record['environmentTier'], 'deployment target environmentTier');
  const operatorPermissionSetName = requireString(
    record['operatorPermissionSetName'],
    'deployment target operatorPermissionSetName',
  );
  const partition = requireString(record['partition'], 'deployment target partition');
  const projectId = requireString(record['projectId'], 'deployment target projectId');
  const region = requireString(record['region'], 'deployment target region');
  const repository = requireString(record['repository'], 'deployment target repository');
  const repositoryUrl = requireString(record['repositoryUrl'], 'deployment target repositoryUrl');
  const resourcePrefix = requireString(record['resourcePrefix'], 'deployment target resourcePrefix');
  const sourceAction = requireString(record['sourceAction'], 'deployment target sourceAction');
  const sourceBranch = requireString(record['sourceBranch'], 'deployment target sourceBranch');
  const sourceProvider = requireString(record['sourceProvider'], 'deployment target sourceProvider');
  const stateNamespace = requireString(record['stateNamespace'], 'deployment target stateNamespace');
  const rawTargetKey = requireString(record['targetKey'], 'deployment target targetKey');
  assertDeploymentTargetLabels(accountLabel, environmentId, environmentTier, operatorPermissionSetName);
  const parsedTargetKey = admitDeploymentTargetKey(rawTargetKey, targetKey, accountLabel, environmentId);
  if (!ACCOUNT_ID_PATTERN.test(accountId)) {
    throw new Error('deployment target accountId is invalid');
  }
  if (partition !== 'aws') {
    throw new Error('deployment target partition is invalid');
  }
  if (sourceProvider !== 'github') {
    throw new Error('deployment target sourceProvider is invalid');
  }
  if (!/^[a-z]{2}(?:-gov)?-[a-z]+-[0-9]$/u.test(region)) {
    throw new Error('deployment target region is invalid');
  }
  assertDeploymentSource({ repository, repositoryUrl, sourceBranch, environmentTier, targetKey: parsedTargetKey });
  assertDeploymentNamespaces({
    projectId,
    resourcePrefix,
    accountLabel,
    environmentId,
    stateNamespace,
    artifactNamespace,
  });
  /** @type {AllowedDeploymentTarget} */
  const target = {
    targetKey: parsedTargetKey,
    accountId,
    projectId,
    resourcePrefix,
    stateNamespace,
    artifactNamespace,
    partition,
    accountLabel,
    region,
    environmentId,
    environmentTier,
    operatorPermissionSetName,
    sourceProvider,
    repository,
    repositoryUrl,
    sourceBranch,
    sourceAction,
  };
  const sharedNames = /** @type {SharedDeploymentTargetNames} */ (
    parseConfiguredNames(record['sharedNames'], SHARED_NAME_KEYS, 'deployment target shared names')
  );
  const admittedLanes = DEPLOYMENT_LANES;
  const laneRecords = requireExactKeys(record['lanes'], admittedLanes, 'deployment target lanes');
  const lanes = /** @type {ReviewedDeploymentTarget['lanes']} */ (
    Object.fromEntries(
      admittedLanes.map((lane) => [
        lane,
        parseDeploymentLaneConfiguration(laneRecords[lane], lane, sharedNames, target['sourceAction'], target),
      ]),
    )
  );
  assertAcceptanceAndSignatureNames(target, sharedNames, lanes);
  assertDeploymentRuntimeNames(target, sharedNames);
  assertRetainedDeploymentNames(sharedNames, lanes);
  if (target.targetKey === 'stark-dev/develop') {
    return { ...target, targetKey: 'stark-dev/develop', sharedNames, lanes };
  }
  const productionPolicy = requireExactKeys(
    record['productionPolicy'],
    ['foundationPublicSubnetException'],
    'deployment production policy',
  );
  if (productionPolicy['foundationPublicSubnetException'] !== 'accepted-for-production-prover-egress') {
    throw new Error('deployment production policy does not match its reviewed approval and networking contract');
  }
  return {
    ...target,
    targetKey: 'stark-prod/main',
    sharedNames,
    lanes,
    productionPolicy: {
      foundationPublicSubnetException: productionPolicy['foundationPublicSubnetException'],
    },
  };
}

/** @param {Pick<AllowedDeploymentTarget, 'repository' | 'repositoryUrl' | 'sourceBranch' | 'environmentTier' | 'targetKey'>} source */
function assertDeploymentSource(source) {
  const { repository, repositoryUrl, sourceBranch, environmentTier, targetKey: parsedTargetKey } = source;
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository)) {
    throw new Error('deployment target repository is invalid');
  }
  if (repositoryUrl !== `https://github.com/${repository}`) {
    throw new Error('deployment target repositoryUrl must match repository');
  }
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$/u.test(sourceBranch) ||
    sourceBranch.includes('..') ||
    sourceBranch.includes('//') ||
    sourceBranch.endsWith('.lock')
  ) {
    throw new Error('deployment target sourceBranch is invalid');
  }
  assertDeploymentSourceTarget(parsedTargetKey, environmentTier, sourceBranch);
}

/** @param {Pick<AllowedDeploymentTarget, 'projectId' | 'resourcePrefix' | 'accountLabel' | 'environmentId' | 'stateNamespace' | 'artifactNamespace'>} identity */
function assertDeploymentNamespaces(identity) {
  const { projectId, resourcePrefix, accountLabel, environmentId, stateNamespace, artifactNamespace } = identity;
  if (!/^[a-z0-9][a-z0-9-]{1,62}$/u.test(projectId)) {
    throw new Error('deployment target projectId is invalid');
  }
  if (resourcePrefix !== `${projectId}-${accountLabel}-${environmentId}`) {
    throw new Error('deployment target resourcePrefix does not match project/account/environment');
  }
  const expectedNamespace = `${projectId}/${accountLabel}/${environmentId}`;
  if (stateNamespace !== expectedNamespace) {
    throw new Error('deployment target stateNamespace does not match project/account/environment');
  }
  if (artifactNamespace !== expectedNamespace) {
    throw new Error('deployment target artifactNamespace does not match project/account/environment');
  }
}

/**
 * @param {AllowedDeploymentTarget} target
 * @param {SharedDeploymentTargetNames} sharedNames
 * @param {ReviewedDeploymentTarget['lanes']} lanes
 */
function assertAcceptanceAndSignatureNames(target, sharedNames, lanes) {
  if (sharedNames['signatureVerifierFunction'] !== sharedNames['targetLambdaFunctions'].imageSignatureVerifier) {
    throw new Error('deployment target signatureVerifierFunction must match its target Lambda function');
  }
  if (
    sharedNames['appAcceptancePublisherRole'] !==
      `sbs-app-acceptance-publisher-${target['accountLabel']}-${target['environmentId']}` ||
    sharedNames['appAcceptancePublisherRole'] === lanes['app'].names['terraformSmokeRole']
  ) {
    throw new Error('deployment target appAcceptancePublisherRole must match its target');
  }
  if (
    sharedNames['bootstrapTerraformAcceptancePublisherRole'] !==
      `sbs-terraform-acceptance-publisher-${target['accountLabel']}-${target['environmentId']}-bootstrap` ||
    sharedNames['bootstrapTerraformAcceptancePublisherRole'] === lanes['bootstrap'].names['terraformSmokeRole']
  ) {
    throw new Error('deployment target bootstrapTerraformAcceptancePublisherRole must match its target');
  }
  if (
    sharedNames['foundationTerraformAcceptancePublisherRole'] !==
      `sbs-terraform-acceptance-publisher-${target['accountLabel']}-${target['environmentId']}-foundation` ||
    sharedNames['foundationTerraformAcceptancePublisherRole'] === lanes['foundation'].names['terraformSmokeRole']
  ) {
    throw new Error('deployment target foundationTerraformAcceptancePublisherRole must match its target');
  }
  assertSignatureVerifierNames(target, sharedNames);
}

/** @param {AllowedDeploymentTarget} target @param {SharedDeploymentTargetNames} sharedNames */
function assertDeploymentRuntimeNames(target, sharedNames) {
  const expectedLambdaFunctions = {
    finalizationWriter: `${sharedNames['runtimeNamePrefix']}-finalization-writer`,
    imageSignatureVerifier: `${sharedNames['signatureRuntimeNamePrefix']}-image-signature-verifier`,
    proofDispatcher: `${sharedNames['runtimeNamePrefix']}-proof-dispatcher`,
    publicApi: `${sharedNames['runtimeNamePrefix']}-public-api`,
    semaphoreJanitor: `${sharedNames['runtimeNamePrefix']}-semaphore-janitor`,
    verificationWorker: `${sharedNames['runtimeNamePrefix']}-verification-worker`,
  };
  for (const functionKey of TARGET_LAMBDA_FUNCTION_KEYS) {
    if (sharedNames['targetLambdaFunctions'][functionKey] !== expectedLambdaFunctions[functionKey]) {
      throw new Error(`deployment target Lambda function ${functionKey} must match its governed name prefix`);
    }
  }
  if (
    sharedNames['finalizationStateMachine'] !== `${sharedNames['runtimeNamePrefix']}-finalization` ||
    sharedNames['proverEcsCluster'] !== `${sharedNames['runtimeNamePrefix']}-prover` ||
    sharedNames['proverEcsTaskFamily'] !== `${sharedNames['runtimeNamePrefix']}-prover`
  ) {
    throw new Error('deployment target prover runtime names must match the governed runtime prefix');
  }
  assertDeploymentLogGroupNames(target, sharedNames);
}

/**
 * @param {SharedDeploymentTargetNames} sharedNames
 * @param {ReviewedDeploymentTarget['lanes']} lanes
 * @param {'Project' | 'Role'} kind
 */
function hasStatusPublisherNameCollision(sharedNames, lanes, kind) {
  const publisherKey = kind === 'Project' ? 'appDeploymentStatusPublisherProject' : 'appDeploymentStatusPublisherRole';
  const publisherName = sharedNames[publisherKey];
  return (
    Object.entries(sharedNames).some(
      ([name, value]) => name !== publisherKey && name.endsWith(kind) && value === publisherName,
    ) ||
    Object.values(lanes).some((lane) =>
      Object.entries(lane.names).some(([name, value]) => name.endsWith(kind) && value === publisherName),
    )
  );
}

/** @param {SharedDeploymentTargetNames} sharedNames @param {ReviewedDeploymentTarget['lanes']} lanes */
function assertRetainedDeploymentNames(sharedNames, lanes) {
  if (sharedNames['acceptedDeploymentPointerKey'] !== `${sharedNames['acceptedDeploymentPrefix']}/current.json`) {
    throw new Error('deployment target acceptedDeploymentPointerKey must match its acceptedDeploymentPrefix');
  }
  if (sharedNames['appDeploymentStatusKey'] !== 'status/current.json') {
    throw new Error('deployment target appDeploymentStatusKey must be the exact current status key');
  }
  if (
    APP_RETAINED_ARTIFACT_S3_NAME_KEYS.some((key) => {
      const retainedName = sharedNames[key];
      return (
        retainedName === sharedNames['appDeploymentStatusKey'] ||
        retainedName.startsWith(`${sharedNames['appDeploymentStatusKey']}/`) ||
        sharedNames['appDeploymentStatusKey'].startsWith(`${retainedName}/`)
      );
    })
  ) {
    throw new Error('deployment target appDeploymentStatusKey must differ from every governed retained App key family');
  }
  const statusPublisherProjectCollides = hasStatusPublisherNameCollision(sharedNames, lanes, 'Project');
  if (statusPublisherProjectCollides) {
    throw new Error('deployment target status publisher project must differ from every other governed project');
  }
  const statusPublisherRoleCollides = hasStatusPublisherNameCollision(sharedNames, lanes, 'Role');
  if (statusPublisherRoleCollides) {
    throw new Error('deployment target status publisher role must differ from every other governed role');
  }
  if (
    new Set(TERRAFORM_DRIFT_MANAGED_POLICY_NAME_KEYS.map((key) => sharedNames[key])).size !==
    TERRAFORM_DRIFT_MANAGED_POLICY_NAME_KEYS.length
  ) {
    throw new Error('deployment target Terraform drift managed policy names must be pairwise distinct');
  }
  if (new Set([sharedNames['appRetainedArtifactBucket'], lanes['app'].names['artifactBucket']]).size !== 2) {
    throw new Error('deployment target App retained and execution artifact buckets must be pairwise distinct');
  }
  if (lanes['bootstrap'].names['terraformSmokeRole'] === lanes['bootstrap'].names['terraformPlanRole']) {
    throw new Error('deployment target Bootstrap terraformSmokeRole must differ from terraformPlanRole');
  }
}

/**
 * @param {unknown} value
 * @returns {DeploymentTargetConfiguration}
 */
export function parseDeploymentTargetConfiguration(value) {
  const record = requireExactKeys(value, ['allowedTargets', 'configurationType'], 'deployment target configuration');
  if (record['configurationType'] !== 'deployment-target-configuration') {
    throw new Error('deployment target configurationType must be deployment-target-configuration');
  }
  const configuredTargets = record['allowedTargets'];
  const hasProduction =
    typeof configuredTargets === 'object' &&
    configuredTargets !== null &&
    Object.hasOwn(configuredTargets, 'stark-prod/main');
  const allowedTargetRecords = requireExactKeys(
    configuredTargets,
    hasProduction ? ALLOWED_TARGET_KEYS : ['stark-dev/develop'],
    'deployment allowed targets',
  );
  const development = parseAllowedDeploymentTarget(allowedTargetRecords['stark-dev/develop'], 'stark-dev/develop');
  const production = hasProduction
    ? parseAllowedDeploymentTarget(allowedTargetRecords['stark-prod/main'], 'stark-prod/main')
    : undefined;
  if (production !== undefined && production.accountId === development.accountId) {
    throw new Error('deployment targets must use distinct development and production accounts');
  }
  const allowedTargets = {
    'stark-dev/develop': development,
    ...(production === undefined ? {} : { 'stark-prod/main': production }),
  };
  return deepFreeze({ configurationType: 'deployment-target-configuration', allowedTargets });
}

/**
 * @param {ReviewedDeploymentTarget} targetEntry
 * @returns {AllowedDeploymentTarget}
 */
function selectAllowedDeploymentTarget(targetEntry) {
  return deepFreeze({
    targetKey: targetEntry.targetKey,
    accountId: targetEntry.accountId,
    projectId: targetEntry.projectId,
    resourcePrefix: targetEntry.resourcePrefix,
    stateNamespace: targetEntry.stateNamespace,
    artifactNamespace: targetEntry.artifactNamespace,
    partition: targetEntry.partition,
    accountLabel: targetEntry.accountLabel,
    region: targetEntry.region,
    environmentId: targetEntry.environmentId,
    environmentTier: targetEntry.environmentTier,
    operatorPermissionSetName: targetEntry.operatorPermissionSetName,
    sourceProvider: targetEntry.sourceProvider,
    repository: targetEntry.repository,
    repositoryUrl: targetEntry.repositoryUrl,
    sourceBranch: targetEntry.sourceBranch,
    sourceAction: targetEntry.sourceAction,
  });
}

const DEPLOYMENT_TARGET_CONFIGURATION = parseDeploymentTargetConfiguration(rawDeploymentTargetConfiguration);
const ALLOWED_TARGET_ENTRIES = DEPLOYMENT_TARGET_CONFIGURATION.allowedTargets;
const ALLOWED_TARGETS = deepFreeze(
  Object.fromEntries(
    Object.entries(ALLOWED_TARGET_ENTRIES).map(([key, entry]) => [key, selectAllowedDeploymentTarget(entry)]),
  ),
);

/** @param {DeploymentTargetKey} targetKey */
function reviewedTargetEntry(targetKey) {
  const entry = ALLOWED_TARGET_ENTRIES[targetKey];
  if (entry === undefined) {
    throw new Error('deployment target is absent from the reviewed configuration');
  }
  return entry;
}

/**
 * @param {unknown} leftValue
 * @param {unknown} rightValue
 * @returns {boolean}
 */
export function immutableObjectReferencesEqual(leftValue, rightValue) {
  const left = parseImmutableObjectReference(leftValue);
  const right = parseImmutableObjectReference(rightValue);
  return left.key === right.key && left.versionId === right.versionId && left.sha256 === right.sha256;
}

/**
 * @param {unknown} input
 * @returns {DeploymentIdentityInput}
 */
function normalizeDeploymentIdentityInput(input) {
  let record;
  try {
    record = requireExactKeys(
      input,
      ['appExecutionAuthoritySha256', 'appSourceSha', 'deployMode', 'pipelineExecutionId'],
      'deployment identity input',
    );
  } catch {
    throw new Error('deployment identity input is invalid');
  }
  const deployMode = record['deployMode'];
  if (deployMode !== 'normal') {
    throw new Error('deployMode must be normal');
  }
  const pipelineExecutionId = requireGroupedLowercaseUuid(record['pipelineExecutionId'], 'pipelineExecutionId');
  return deepFreeze({
    appExecutionAuthoritySha256: parseSha256(record['appExecutionAuthoritySha256'], 'appExecutionAuthoritySha256'),
    appSourceSha: parseFullSourceSha(record['appSourceSha'], 'appSourceSha'),
    deployMode,
    pipelineExecutionId,
  });
}

/**
 * @param {unknown} input
 * @returns {DeploymentIdentity}
 */
export function deriveDeploymentIdentity(input) {
  const authority = normalizeDeploymentIdentityInput(input);
  const authoritySha256 = sha256Text(`${canonicalJson(authority)}\n`);
  return deepFreeze({
    identityType: 'app-deployment',
    deploymentId: `dep_${authoritySha256.slice(0, 32)}`,
    authoritySha256,
    authority,
  });
}

/**
 * @param {unknown} value
 * @returns {DeploymentIdentity}
 */
export function validateDeploymentIdentity(value) {
  let identity;
  try {
    identity = requireExactKeys(
      value,
      ['authority', 'authoritySha256', 'deploymentId', 'identityType'],
      'deployment identity',
    );
  } catch {
    throw new Error('deployment identity is invalid');
  }
  if (identity['identityType'] !== 'app-deployment') {
    throw new Error('identityType is invalid');
  }
  const derived = deriveDeploymentIdentity(identity['authority']);
  if (identity['authoritySha256'] !== derived['authoritySha256']) {
    throw new Error('authoritySha256 does not match the canonical deployment authority');
  }
  if (identity['deploymentId'] !== derived['deploymentId']) {
    throw new Error('deploymentId does not match the deployment authority');
  }
  return derived;
}

/**
 * @param {string | undefined} observedVersionId
 * @returns {void}
 */
export function assertFirstPublication(observedVersionId) {
  if (observedVersionId !== undefined) {
    throw new Error('immutable object already exists');
  }
}

/**
 * @template {string} T
 * @param {T} targetKey
 * @returns {AllowedDeploymentTarget & {readonly targetKey: T}}
 */
export function resolveAllowedDeploymentTarget(targetKey) {
  if (typeof targetKey !== 'string' || !Object.hasOwn(ALLOWED_TARGETS, targetKey)) {
    throw new Error(`deployment target "${String(targetKey)}" is not authorized`);
  }
  const target = ALLOWED_TARGETS[targetKey];
  if (target === undefined || target.targetKey !== targetKey) {
    throw new Error('deployment target is detached from its reviewed key');
  }
  return /** @type {AllowedDeploymentTarget & {readonly targetKey: T}} */ (target);
}

/**
 * @param {unknown} value
 * @param {AllowedDeploymentTarget} target
 * @returns {ValidatedAwsSsoCallerIdentity}
 */
export function validateAwsSsoCallerIdentity(value, target) {
  try {
    return validateAwsSsoCallerIdentityForPermissionSet(
      value,
      target,
      assertAllowedTarget(target).operatorPermissionSetName,
    );
  } catch (error) {
    if (error instanceof Error && error.message === 'AWS caller role does not match the reviewed permission set.') {
      throw new Error('AWS caller role does not match the reviewed operator permission set.');
    }
    throw error;
  }
}

/**
 * @param {unknown} value
 * @param {AllowedDeploymentTarget} target
 * @param {unknown} permissionSetName
 * @returns {ValidatedAwsSsoCallerIdentity}
 */
export function validateAwsSsoCallerIdentityForPermissionSet(value, target, permissionSetName) {
  const allowedTarget = assertAllowedTarget(target);
  let identity;
  try {
    identity = requireExactKeys(value, ['Account', 'Arn'], 'AWS caller identity');
  } catch {
    throw new Error('AWS caller identity must use exact Account and Arn fields.');
  }
  const accountId = requireString(identity['Account'], 'AWS caller account', ACCOUNT_ID_PATTERN);
  const arn = requireString(identity['Arn'], 'AWS caller ARN');
  if (accountId !== allowedTarget['accountId']) {
    throw new Error('AWS caller account does not match the reviewed deployment target.');
  }
  const admittedPermissionSetName = requireString(permissionSetName, 'AWS caller permission set');
  if (!/^[A-Za-z0-9+=,.@_-]{1,32}$/u.test(admittedPermissionSetName)) {
    throw new Error('AWS caller permission-set authority is invalid.');
  }
  const escapedPermissionSetName = admittedPermissionSetName.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const expectedArn = new RegExp(
    `^arn:${allowedTarget['partition']}:sts::${allowedTarget['accountId']}:assumed-role/AWSReservedSSO_${escapedPermissionSetName}_[0-9a-f]{16}/[A-Za-z0-9+=,.@_-]+$`,
    'u',
  );
  if (!expectedArn.test(arn)) {
    throw new Error('AWS caller role does not match the reviewed permission set.');
  }
  return deepFreeze({ accountId, arn });
}

/**
 * @param {AllowedDeploymentTarget} target
 * @returns {ImageSigningIdentity}
 */
export function resolveImageSigningIdentity(target) {
  const allowedTarget = assertAllowedTarget(target);
  const names = reviewedTargetEntry(allowedTarget.targetKey).sharedNames;
  return deepFreeze({
    namePrefix: allowedTarget['resourcePrefix'],
    signingProfileName: names.signerProfile,
    signingProfileArn: `arn:${allowedTarget['partition']}:signer:${allowedTarget['region']}:${allowedTarget['accountId']}:/signing-profiles/${names.signerProfile}`,
    repositories: {
      prover: names.proverRepository,
      toolchain: names.toolchainRepository,
    },
  });
}

/**
 * @param {AllowedDeploymentTarget} target
 * @returns {'accepted-for-develop-prover-egress' | 'accepted-for-production-prover-egress'}
 */
export function resolveFoundationPublicSubnetException(target) {
  const entry = reviewedTargetEntry(assertAllowedTarget(target).targetKey);
  return entry.targetKey === 'stark-dev/develop'
    ? 'accepted-for-develop-prover-egress'
    : entry.productionPolicy.foundationPublicSubnetException;
}

/**
 * Select a reviewed target from the independently observed CodeBuild identity.
 * This selection does not replace source, installed-project, or runtime admission.
 *
 * @param {unknown} value
 * @returns {AllowedDeploymentTarget}
 */
export function resolveCodeBuildDeploymentTarget(value) {
  const input = requireExactKeys(
    value,
    ['buildArn', 'buildId', 'callerIdentity', 'lane', 'projectKey', 'region', 'roleKey'],
    'CodeBuild target selection',
  );
  const caller = requireExactKeys(input['callerIdentity'], ['Account', 'Arn', 'UserId'], 'CodeBuild target caller');
  const accountId = requireString(caller['Account'], 'CodeBuild target account', /^[0-9]{12}$/u);
  const region = requireString(input['region'], 'CodeBuild target region');
  const candidates = Object.values(ALLOWED_TARGETS).filter(
    (target) => target.accountId === accountId && target.region === region,
  );
  if (candidates.length !== 1 || candidates[0] === undefined) {
    throw new Error('CodeBuild identity does not select exactly one reviewed deployment target.');
  }
  const target = candidates[0];
  const lane = requireLane(input['lane']);
  const authority = resolveDeploymentLaneAuthority(target, lane);
  const projectKey = requireString(input['projectKey'], 'CodeBuild target project key', /^[a-zA-Z]+Project$/u);
  const roleKey = requireString(input['roleKey'], 'CodeBuild target role key', /^[a-zA-Z]+Role$/u);
  const names = /** @type {Readonly<Record<string, unknown>>} */ (authority.names);
  if (!Object.hasOwn(names, projectKey) || !Object.hasOwn(names, roleKey)) {
    throw new Error('CodeBuild target role or project key is outside the reviewed lane.');
  }
  const project = requireString(names[projectKey], 'CodeBuild target project');
  const role = requireString(names[roleKey], 'CodeBuild target role');
  const buildId = requireString(input['buildId'], 'CodeBuild target build ID');
  const prefix = `${project}:`;
  if (!buildId.startsWith(prefix)) throw new Error('CodeBuild target project does not match the running build.');
  requireGroupedLowercaseUuid(buildId.slice(prefix.length), 'CodeBuild target build execution ID');
  if (input['buildArn'] !== `arn:${target.partition}:codebuild:${region}:${accountId}:build/${buildId}`) {
    throw new Error('CodeBuild target build ARN does not match its account, region, and build ID.');
  }
  const callerArn = requireString(caller['Arn'], 'CodeBuild target caller ARN');
  const rolePrefix = `arn:${target.partition}:sts::${accountId}:assumed-role/${role}/`;
  if (!callerArn.startsWith(rolePrefix)) throw new Error('CodeBuild target caller does not match its reviewed role.');
  const sessionName = requireString(
    callerArn.slice(rolePrefix.length),
    'CodeBuild target role session',
    /^[A-Za-z0-9+=,.@_-]{2,64}$/u,
  );
  const userId = requireString(
    caller['UserId'],
    'CodeBuild target caller user ID',
    /^AROA[A-Z0-9]{17}:[A-Za-z0-9+=,.@_-]{2,64}$/u,
  );
  if (!userId.endsWith(`:${sessionName}`)) throw new Error('CodeBuild target caller session is inconsistent.');
  return target;
}

/**
 * @param {unknown} target
 * @returns {AllowedDeploymentTarget}
 */
function assertAllowedTarget(target) {
  const encoded = canonicalJson(target);
  const allowedTarget = Object.values(ALLOWED_TARGETS).find((entry) => canonicalJson(entry) === encoded);
  if (allowedTarget === undefined) {
    throw new Error('deployment target does not match the reviewed allowed-target configuration');
  }
  return allowedTarget;
}

/**
 * @param {unknown} value
 * @param {string} label
 * @returns {string}
 */
function requireSourceSha(value, label) {
  return parseFullSourceSha(value, label);
}

/**
 * @param {unknown} value
 * @returns {DeploymentLane}
 */
function requireLane(value) {
  switch (value) {
    case 'app':
    case 'bootstrap':
    case 'foundation':
    case 'prover':
    case 'toolchain':
      return value;
    default:
      throw new Error('deployment lane is not authorized');
  }
}

/**
 * @param {string} value
 * @returns {void}
 */
function assertGeneratedPipelineName(value) {
  if (!/^[A-Za-z0-9.@_-]{1,100}$/u.test(value)) {
    throw new Error('generated CodePipeline name is invalid');
  }
}

/**
 * @param {string} value
 * @returns {void}
 */
function assertGeneratedCodePipelineActionName(value) {
  if (!/^[A-Za-z0-9.@_-]{1,100}$/u.test(value)) {
    throw new Error('generated CodePipeline action name is invalid');
  }
}

/**
 * @param {string} value
 * @returns {void}
 */
function assertGeneratedEcrRepository(value) {
  if (value.length > 256 || !/^[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*$/u.test(value)) {
    throw new Error('generated ECR repository name is invalid');
  }
}

/**
 * @param {string} value
 * @param {string} label
 * @returns {void}
 */
function assertGeneratedS3Key(value, label) {
  if (
    value.length === 0 ||
    Buffer.byteLength(value, 'utf8') > 1024 ||
    hasControlCharacter(value) ||
    value.startsWith('/') ||
    value.includes('..')
  ) {
    throw new Error(`generated ${label} S3 key is invalid`);
  }
}

/**
 * @param {string} value
 * @returns {void}
 */
function assertGeneratedBucketName(value) {
  if (
    value.length < 3 ||
    value.length > 63 ||
    !/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/u.test(value) ||
    value.includes('..') ||
    value.includes('.-') ||
    value.includes('-.') ||
    isReservedBucketName(value)
  ) {
    throw new Error('generated S3 bucket name is invalid');
  }
}

/**
 * @param {string} value
 * @param {string} label
 * @returns {void}
 */
function assertGeneratedIamName(value, label) {
  if (!/^[A-Za-z0-9+=,.@_-]{1,64}$/u.test(value)) {
    throw new Error(`generated ${label} IAM name is invalid`);
  }
}

/**
 * @param {string} value
 * @param {string} label
 * @returns {void}
 */
function assertGeneratedIamPolicyName(value, label) {
  if (!/^[A-Za-z0-9+=,.@_-]{1,128}$/u.test(value)) {
    throw new Error(`generated ${label} IAM policy name is invalid`);
  }
}

/**
 * @param {string} value
 * @returns {void}
 */
function assertGeneratedCodeBuildName(value) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{1,254}$/u.test(value)) {
    throw new Error('generated CodeBuild project name is invalid');
  }
}

/**
 * @param {string} value
 * @returns {void}
 */
function assertGeneratedLambdaName(value) {
  if (!/^[A-Za-z0-9_-]{1,64}$/u.test(value)) {
    throw new Error('generated Lambda function name is invalid');
  }
}

/**
 * @param {string} value
 * @returns {void}
 */
function assertGeneratedCloudWatchLogGroupName(value) {
  if (value.length > 512 || !/^[A-Za-z0-9_./#-]+$/u.test(value) || value.startsWith('aws/')) {
    throw new Error('generated CloudWatch Logs log-group name is invalid');
  }
}

/**
 * @param {string} value
 * @returns {void}
 */
function assertGeneratedEventBridgeRuleName(value) {
  if (!/^[A-Za-z0-9_.-]{1,64}$/u.test(value)) {
    throw new Error('generated EventBridge rule name is invalid');
  }
}

/**
 * @param {string} value
 * @returns {void}
 */
function assertGeneratedCloudFrontFunctionName(value) {
  if (!/^[A-Za-z0-9_-]{1,64}$/u.test(value)) {
    throw new Error('generated CloudFront function name is invalid');
  }
}

/**
 * @param {string} value
 * @returns {void}
 */
function assertGeneratedKmsAlias(value) {
  if (
    value.length > 256 ||
    !/^alias\/[A-Za-z0-9/_-]+$/u.test(value) ||
    value.startsWith('alias/aws/') ||
    value.endsWith('/')
  ) {
    throw new Error('generated KMS alias is invalid');
  }
}

/**
 * @param {string} value
 * @returns {void}
 */
function assertGeneratedSignerProfileName(value) {
  if (!/^[A-Za-z0-9_]{2,64}$/u.test(value)) {
    throw new Error('generated Signer profile name is invalid');
  }
}

/**
 * @param {string} value
 * @returns {void}
 */
function assertGeneratedSsmParameterPrefix(value) {
  if (value.length > 1011 || !/^\/(?!aws(?:\/|$)|ssm(?:\/|$))[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/iu.test(value)) {
    throw new Error('generated SSM parameter prefix is invalid');
  }
}

/**
 * @param {string} value
 * @returns {void}
 */
function assertGeneratedSecretsManagerPrefix(value) {
  if (value.length > 512 || !/^\/[A-Za-z0-9_+=.@-]+(?:\/[A-Za-z0-9_+=.@-]+)*$/u.test(value)) {
    throw new Error('generated Secrets Manager prefix is invalid');
  }
}

/**
 * @param {string} value
 * @param {string} label
 * @returns {void}
 */
function assertGeneratedResourceNamePrefix(value, label) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u.test(value)) {
    throw new Error(`generated ${label} name prefix is invalid`);
  }
}

/**
 * @param {AllowedDeploymentTarget} target
 * @param {Pick<DeploymentLaneAuthority, 'lane'>} laneAuthority
 * @returns {DeploymentContextNames}
 */
function resolveContextNames(target, laneAuthority) {
  const targetEntry = reviewedTargetEntry(target.targetKey);
  const laneConfiguration = targetEntry.lanes[laneAuthority.lane];
  if (laneConfiguration === undefined) {
    throw new Error('deployment lane is not authorized for the selected target');
  }
  const names = {
    sourceAction: target.sourceAction,
    ...targetEntry.sharedNames,
    ...laneConfiguration.names,
  };
  assertConfiguredContextNames(names);
  return deepFreeze(names);
}

/**
 * @template {DeploymentLane} L
 * @param {AllowedDeploymentTarget} target
 * @param {L} selectedLane
 * @returns {DeploymentLaneAuthority & {readonly lane: L, readonly names: DeploymentContextNames}}
 */
export function resolveDeploymentLaneAuthority(target, selectedLane) {
  const allowedTarget = assertAllowedTarget(target);
  const lane = requireLane(selectedLane);
  const targetEntry = reviewedTargetEntry(allowedTarget.targetKey);
  const laneConfiguration = targetEntry.lanes[lane];
  if (laneConfiguration === undefined) {
    throw new Error('deployment lane is not authorized for the selected target');
  }
  const names = resolveContextNames(allowedTarget, { lane });
  const authority = deepFreeze({
    lane,
    scope: laneConfiguration.scope,
    stateIdentity: laneConfiguration.stateIdentity,
    backendKey: laneConfiguration.backendKey,
    names,
    policy: laneConfiguration.policy,
  });
  return /** @type {DeploymentLaneAuthority & {readonly lane: L, readonly names: DeploymentContextNames}} */ (
    authority
  );
}

/**
 * @param {unknown} input
 * @returns {DeploymentLaneContext}
 */
export function renderDeploymentLaneContext(input) {
  const record = requireExactKeys(
    input,
    ['accountId', 'frameworkSourceSha', 'lane', 'requestedControlSourceSha', 'selectedApplicationSourceSha', 'target'],
    'deployment context input',
  );
  const target = assertAllowedTarget(record['target']);
  const laneAuthority = resolveDeploymentLaneAuthority(target, requireLane(record['lane']));
  const accountId = requireString(record['accountId'], 'AWS account ID', ACCOUNT_ID_PATTERN);
  if (accountId !== target['accountId']) {
    throw new Error('AWS account ID does not match the reviewed allowed target');
  }
  const requestedControlSourceSha = requireSourceSha(
    record['requestedControlSourceSha'],
    'requested control source SHA',
  );
  const selectedApplicationSourceSha = requireSourceSha(
    record['selectedApplicationSourceSha'],
    'selected application source SHA',
  );
  const frameworkSourceSha = requireSourceSha(record['frameworkSourceSha'], 'framework source SHA');
  if (requestedControlSourceSha !== frameworkSourceSha) {
    throw new Error('requested control source SHA must match framework source SHA');
  }
  const resourcePrefix = target['resourcePrefix'];
  const names = resolveContextNames(target, laneAuthority);

  return assembleDeploymentContext({
    contextType: 'deployment-lane-context',
    project: {
      projectId: target['projectId'],
      resourcePrefix,
      stateNamespace: target['stateNamespace'],
      artifactNamespace: target['artifactNamespace'],
    },
    target: {
      partition: target['partition'],
      accountId,
      accountLabel: target['accountLabel'],
      region: target['region'],
      environmentId: target['environmentId'],
      environmentTier: target['environmentTier'],
      operatorPermissionSetName: target['operatorPermissionSetName'],
    },
    root: {
      lane: laneAuthority.lane,
      scope: laneAuthority.scope,
      stateIdentity: laneAuthority.stateIdentity,
      backendKey: laneAuthority.backendKey,
    },
    source: {
      branch: target['sourceBranch'],
      provider: target['sourceProvider'],
      repository: target['repository'],
      repositoryUrl: target['repositoryUrl'],
      requestedControlSourceSha,
      selectedApplicationSourceSha,
      frameworkSourceSha,
    },
    names,
    policy: laneAuthority.policy,
    targetConfigurationSha256: canonicalJsonSha256(reviewedTargetEntry(target.targetKey)),
  });
}

/**
 * @param {unknown} value
 * @returns {DeploymentLaneContext}
 */
export function parseDeploymentLaneContext(value) {
  const context = requireExactKeys(value, CONTEXT_KEYS, 'deployment lane context');
  requireExactKeys(context['project'], PROJECT_KEYS, 'deployment context project');
  const target = requireExactKeys(context['target'], TARGET_KEYS, 'deployment context target');
  const root = requireExactKeys(context['root'], ROOT_KEYS, 'deployment context root');
  const source = requireExactKeys(context['source'], SOURCE_KEYS, 'deployment context source');
  const allowedTarget = resolveAllowedDeploymentTarget(
    `${requireString(target['accountLabel'], 'deployment context account label')}/${requireString(target['environmentId'], 'deployment context environment')}`,
  );
  requireExactKeys(context['names'], NAME_KEYS, 'deployment context names');
  requireExactKeys(context['policy'], POLICY_KEYS, 'deployment context policy');
  if (context['contextType'] !== 'deployment-lane-context') {
    throw new Error('deployment contextType must be deployment-lane-context');
  }
  const rendered = renderDeploymentLaneContext({
    target: allowedTarget,
    lane: root['lane'],
    accountId: target['accountId'],
    requestedControlSourceSha: source['requestedControlSourceSha'],
    selectedApplicationSourceSha: source['selectedApplicationSourceSha'],
    frameworkSourceSha: source['frameworkSourceSha'],
  });
  if (canonicalJson(rendered) !== canonicalJson(context)) {
    throw new Error('deployment lane context does not match the canonical allowed target');
  }
  return rendered;
}

/** @param {string} accountLabel @param {string} environmentId @param {string} environmentTier @param {string} operatorPermissionSetName */
function assertDeploymentTargetLabels(accountLabel, environmentId, environmentTier, operatorPermissionSetName) {
  if (!/^[a-z][a-z0-9-]{1,62}$/u.test(accountLabel)) {
    throw new Error('deployment target accountLabel is invalid');
  }
  if (!/^[a-z][a-z0-9-]{1,31}$/u.test(environmentId)) {
    throw new Error('deployment target environmentId is invalid');
  }
  if (environmentTier !== 'development' && environmentTier !== 'production') {
    throw new Error('deployment target environmentTier is invalid');
  }
  if (!/^[A-Za-z0-9+=,.@_-]{1,32}$/u.test(operatorPermissionSetName)) {
    throw new Error('deployment target operatorPermissionSetName is invalid');
  }
}

/** @param {DeploymentTargetKey} parsedTargetKey @param {string} environmentTier @param {string} sourceBranch */
function assertDeploymentSourceTarget(parsedTargetKey, environmentTier, sourceBranch) {
  if (
    (parsedTargetKey === 'stark-dev/develop' && (environmentTier !== 'development' || sourceBranch !== 'develop')) ||
    (parsedTargetKey === 'stark-prod/main' && (environmentTier !== 'production' || sourceBranch !== 'main'))
  ) {
    throw new Error('deployment target environment tier or source branch does not match its target');
  }
}

/** @param {AllowedDeploymentTarget} target @param {SharedDeploymentTargetNames} sharedNames */
function assertSignatureVerifierNames(target, sharedNames) {
  if (
    sharedNames['signatureVerifierRole'] !==
    `${sharedNames['signatureRuntimeNamePrefix']}-image-signature-verifier-role`
  ) {
    throw new Error('deployment target signatureVerifierRole must match its signatureRuntimeNamePrefix');
  }
  if (
    sharedNames['signatureVerifierPermissionsBoundary'] !==
    `${target['projectId']}-image-signature-verifier-boundary-${target['accountLabel']}-${target['environmentId']}`
  ) {
    throw new Error('deployment target signatureVerifierPermissionsBoundary must match its target');
  }
}

/** @param {AllowedDeploymentTarget} target @param {SharedDeploymentTargetNames} sharedNames */
function assertDeploymentLogGroupNames(target, sharedNames) {
  for (const functionKey of TARGET_LAMBDA_FUNCTION_KEYS) {
    if (
      sharedNames['targetLogGroups'][functionKey] !== `/aws/lambda/${sharedNames['targetLambdaFunctions'][functionKey]}`
    ) {
      throw new Error(`deployment target log group ${functionKey} must match its target Lambda function`);
    }
  }
  if (sharedNames['targetLogGroups'].prover !== `/aws/ecs/${target['resourcePrefix']}-prover`) {
    throw new Error('deployment target Prover log group must match its resourcePrefix');
  }
  if (sharedNames['targetLogGroups'].opsLedger !== `/aws/events/${target['resourcePrefix']}-ops-ledger`) {
    throw new Error('deployment target operations-ledger log group must match its resourcePrefix');
  }
}

/** @param {string} value */
function isReservedBucketName(value) {
  return (
    /^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/u.test(value) ||
    /^(?:xn--|sthree-|amzn_s3_demo_)/u.test(value) ||
    /(?:-s3alias|--ol-s3|\.mrap|--x-s3|--table-s3)$/u.test(value)
  );
}
