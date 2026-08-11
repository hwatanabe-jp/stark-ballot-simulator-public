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
} from './internal.js';
import rawDeploymentTargetConfiguration from '../deployment-targets.json' with { type: 'json' };

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
};

const ACCOUNT_ID_PATTERN = /^[0-9]{12}$/u;
const OPERATIONAL_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/+,-]{0,1023}$/u;

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
const ALLOWED_TARGET_KEYS = ['stark-dev/develop'];
const DEPLOYMENT_LANES = ['app', 'bootstrap', 'foundation', 'prover', 'static-fast', 'toolchain'];
const DEPLOYMENT_LANE_SCOPES = Object.freeze({
  app: 'app',
  bootstrap: 'bootstrap',
  foundation: 'foundation',
  prover: 'foundation',
  'static-fast': 'app',
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
const TARGET_LAMBDA_FUNCTION_KEYS = [
  'finalizationWriter',
  'imageSignatureVerifier',
  'proofDispatcher',
  'publicApi',
  'semaphoreJanitor',
  'verificationWorker',
];
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
  'appDeploymentRecordProject',
  'appDeploymentRecordRole',
  'appRetainedArtifactBucket',
  'appSignaturePreflightApplyProject',
  'appSignaturePreflightApplyRole',
  'appSignaturePreflightInvokeProject',
  'appSignaturePreflightInvokerRole',
  'appSignaturePreflightPlanProject',
  'appSignaturePreflightPlanRole',
  'appSignatureStateRefreshApplyProject',
  'appSignatureStateRefreshApplyRole',
  'appSignatureStateRefreshPlanProject',
  'appStaticDeployProject',
  'appStaticDeployRole',
  'appStaticFastDeployProject',
  'appStaticFastDeployRole',
  'appStaticFastGateProject',
  'appStaticFastGateRole',
  'appStaticFastPipelineRole',
  'appStaticFastSmokeProject',
  'appStaticFastSmokeRole',
  'approvalEvidencePrefix',
  'artifactBucket',
  'artifactKmsAlias',
  'deploymentRecordPrefix',
  'ecrRetentionFunction',
  'ecrRetentionLogGroup',
  'ecrRetentionPermissionsBoundary',
  'ecrRetentionRole',
  'ecrRetentionSchedule',
  'finalizationStateMachine',
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
  'recoveryReadinessProject',
  'recoveryReadinessReportPrefix',
  'recoveryReadinessRole',
  'releaseManifestBucket',
  'rollbackReadinessProject',
  'rollbackReadinessReportPrefix',
  'rollbackReadinessRole',
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
const TERRAFORM_DRIFT_MANAGED_POLICY_NAME_KEYS = [
  'terraformDriftAppProviderCorePolicy',
  'terraformDriftAppProviderRuntimePolicy',
  'terraformDriftCoordinatorAuthorityEnvironmentPolicy',
  'terraformDriftCoordinatorExecutionEnvironmentPolicy',
  'terraformDriftCoordinatorRequestShapePolicy',
];
const SHARED_NAME_KEYS = NAME_KEYS.filter((key) => key !== 'sourceAction' && !DEPLOYMENT_LANE_NAME_KEYS.includes(key));
const ALLOWED_DEPLOYMENT_TARGET_KEYS = DEPLOYMENT_TARGET_KEYS.filter((key) => key !== 'lanes' && key !== 'sharedNames');
const S3_CONTEXT_NAME_KEYS = [
  'acceptedDeploymentPointerKey',
  'acceptedDeploymentPrefix',
  'approvalEvidencePrefix',
  'deploymentRecordPrefix',
  'foundationAppNetworkingKey',
  'foundationSigningAuthorityPrefix',
  'lambdaArtifactPrefix',
  'proverAcceptedPointerKey',
  'proverReleasePrefix',
  'recoveryManifestPrefix',
  'recoveryReadinessReportPrefix',
  'signaturePreflightPrefix',
  'staticFrontendArtifactPrefix',
  'terraformBaselinePrefix',
  'terraformDriftReportPrefix',
  'rollbackReadinessReportPrefix',
  'toolchainAcceptedPointerKey',
  'toolchainArtifactPrefix',
];
const MAXIMUM_UUID_SEGMENT = '0'.repeat(36);
const MAXIMUM_SHA256_SEGMENT = '0'.repeat(64);
const MAXIMUM_SOURCE_SHA_SEGMENT = '0'.repeat(40);
const S3_PREFIX_DERIVED_SUFFIXES = Object.freeze({
  acceptedDeploymentPrefix: `/executions/${MAXIMUM_UUID_SEGMENT}/attempts/${MAXIMUM_UUID_SEGMENT}/authoritative-app-deployment.json`,
  approvalEvidencePrefix: `/${MAXIMUM_UUID_SEGMENT}.json`,
  deploymentRecordPrefix: `/${MAXIMUM_SOURCE_SHA_SEGMENT}/${MAXIMUM_SHA256_SEGMENT}.json`,
  foundationSigningAuthorityPrefix: `/${MAXIMUM_SOURCE_SHA_SEGMENT}/authority.json`,
  lambdaArtifactPrefix: `/${MAXIMUM_SOURCE_SHA_SEGMENT}/image-signature-verifier.zip`,
  proverReleasePrefix: `/${MAXIMUM_UUID_SEGMENT}/manifest.json`,
  recoveryManifestPrefix: `/${MAXIMUM_SHA256_SEGMENT}.json`,
  signaturePreflightPrefix: `/executions/${MAXIMUM_UUID_SEGMENT}/attempts/${MAXIMUM_SHA256_SEGMENT}/verification.json`,
  staticFrontendArtifactPrefix: `/${MAXIMUM_SOURCE_SHA_SEGMENT}/dep_${'0'.repeat(32)}/dist.tar.gz`,
  toolchainArtifactPrefix: `/${MAXIMUM_UUID_SEGMENT}/manifest.json`,
});

function parseConfiguredNames(value, expectedKeys, label) {
  const record = requireExactKeys(value, expectedKeys, label);
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

function assertConfiguredContextNames(names) {
  requireExactKeys(names, NAME_KEYS, 'deployment target context names');
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
  for (const key of NAME_KEYS.filter((key) => key.endsWith('Role'))) {
    assertGeneratedIamName(names[key], key);
  }
  for (const key of NAME_KEYS.filter((key) => key.endsWith('Project'))) {
    assertGeneratedCodeBuildName(names[key]);
  }
  for (const functionName of Object.values(names.targetLambdaFunctions)) {
    assertGeneratedLambdaName(functionName);
  }
  for (const logGroupName of Object.values(names.targetLogGroups)) {
    assertGeneratedCloudWatchLogGroupName(logGroupName);
  }
  assertGeneratedLambdaName(names.ecrRetentionFunction);
  assertGeneratedCloudWatchLogGroupName(names.ecrRetentionLogGroup);
  assertGeneratedLambdaName(names.signatureVerifierFunction);
  assertGeneratedIamPolicyName(names.signatureVerifierPermissionsBoundary, 'signatureVerifierPermissionsBoundary');
  for (const key of NAME_KEYS.filter((key) => key.endsWith('Policy'))) {
    assertGeneratedIamPolicyName(names[key], key);
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
  assertGeneratedEventBridgeRuleName(names.ecrRetentionSchedule);
  assertGeneratedEventBridgeRuleName(names.terraformDriftSchedule);
  assertGeneratedCloudFrontFunctionName(`${names.runtimeNamePrefix}-frontend-spa-fallback`);
  assertGeneratedIamName(
    `${names.signatureRuntimeNamePrefix}-image-signature-verifier-role`,
    'image signature verifier role',
  );
  assertGeneratedIamPolicyName(names.ecrRetentionPermissionsBoundary, 'ecrRetentionPermissionsBoundary');
  assertGeneratedLambdaName(`${names.signatureRuntimeNamePrefix}-image-signature-verifier`);
  for (const key of S3_CONTEXT_NAME_KEYS) {
    assertGeneratedS3Key(names[key], key);
  }
  for (const [key, suffix] of Object.entries(S3_PREFIX_DERIVED_SUFFIXES)) {
    assertGeneratedS3Key(`${names[key]}${suffix}`, `${key} derived`);
  }
}

function parseDeploymentLaneConfiguration(value, lane, sharedNames, sourceAction, target) {
  const record = requireExactKeys(value, DEPLOYMENT_LANE_CONFIGURATION_KEYS, `deployment target lane ${lane}`);
  const scope = requireString(record.scope, `deployment target lane ${lane} scope`);
  const expectedScope = DEPLOYMENT_LANE_SCOPES[lane];
  if (scope !== expectedScope) {
    throw new Error(`deployment target lane ${lane} scope must be ${expectedScope}`);
  }
  const policy = requireExactKeys(record.policy, POLICY_KEYS, `deployment target lane ${lane} policy`);
  if (typeof policy.signatureVerificationRequired !== 'boolean') {
    throw new Error(`deployment target lane ${lane} signature verification policy is invalid`);
  }
  const names = parseConfiguredNames(record.names, DEPLOYMENT_LANE_NAME_KEYS, `deployment target lane ${lane} names`);
  assertConfiguredContextNames({ sourceAction, ...sharedNames, ...names });
  const stateIdentity = requireString(record.stateIdentity, `deployment target lane ${lane} state identity`);
  if (stateIdentity !== `${target.accountLabel}/${target.environmentId}/${scope}`) {
    throw new Error(`deployment target lane ${lane} state identity does not match its target and scope`);
  }
  const backendKey = requireString(record.backendKey, `deployment target lane ${lane} backend key`);
  if (backendKey !== `${target.stateNamespace}/${scope}/terraform.tfstate`) {
    throw new Error(`deployment target lane ${lane} backend key does not match its target and scope`);
  }
  return {
    scope,
    stateIdentity,
    backendKey,
    policy: { signatureVerificationRequired: policy.signatureVerificationRequired },
    names,
  };
}

function parseAllowedDeploymentTarget(value, targetKey) {
  const record = requireExactKeys(value, DEPLOYMENT_TARGET_KEYS, 'deployment allowed target');
  const target = Object.fromEntries(
    ALLOWED_DEPLOYMENT_TARGET_KEYS.map((key) => [key, requireString(record[key], `deployment target ${key}`)]),
  );
  if (!/^[a-z][a-z0-9-]{1,62}$/u.test(target.accountLabel)) {
    throw new Error('deployment target accountLabel is invalid');
  }
  if (!/^[a-z][a-z0-9-]{1,31}$/u.test(target.environmentId)) {
    throw new Error('deployment target environmentId is invalid');
  }
  if (!['development', 'production'].includes(target.environmentTier)) {
    throw new Error('deployment target environmentTier is invalid');
  }
  if (!/^[A-Za-z0-9+=,.@_-]{1,32}$/u.test(target.operatorPermissionSetName)) {
    throw new Error('deployment target operatorPermissionSetName is invalid');
  }
  if (target.targetKey !== `${target.accountLabel}/${target.environmentId}`) {
    throw new Error('deployment target key does not match accountLabel/environmentId');
  }
  if (target.targetKey !== targetKey) {
    throw new Error('deployment target key does not match its allowed-target entry');
  }
  if (!ACCOUNT_ID_PATTERN.test(target.accountId)) {
    throw new Error('deployment target accountId is invalid');
  }
  if (target.partition !== 'aws') {
    throw new Error('deployment target partition is invalid');
  }
  if (target.sourceProvider !== 'github') {
    throw new Error('deployment target sourceProvider is invalid');
  }
  if (!/^[a-z]{2}(?:-gov)?-[a-z]+-[0-9]$/u.test(target.region)) {
    throw new Error('deployment target region is invalid');
  }
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(target.repository)) {
    throw new Error('deployment target repository is invalid');
  }
  if (target.repositoryUrl !== `https://github.com/${target.repository}`) {
    throw new Error('deployment target repositoryUrl must match repository');
  }
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$/u.test(target.sourceBranch) ||
    target.sourceBranch.includes('..') ||
    target.sourceBranch.includes('//') ||
    target.sourceBranch.endsWith('.lock')
  ) {
    throw new Error('deployment target sourceBranch is invalid');
  }
  if (!/^[a-z0-9][a-z0-9-]{1,62}$/u.test(target.projectId)) {
    throw new Error('deployment target projectId is invalid');
  }
  if (target.resourcePrefix !== `${target.projectId}-${target.accountLabel}-${target.environmentId}`) {
    throw new Error('deployment target resourcePrefix does not match project/account/environment');
  }
  const expectedNamespace = `${target.projectId}/${target.accountLabel}/${target.environmentId}`;
  if (target.stateNamespace !== expectedNamespace) {
    throw new Error('deployment target stateNamespace does not match project/account/environment');
  }
  if (target.artifactNamespace !== expectedNamespace) {
    throw new Error('deployment target artifactNamespace does not match project/account/environment');
  }
  const sharedNames = parseConfiguredNames(record.sharedNames, SHARED_NAME_KEYS, 'deployment target shared names');
  const laneRecords = requireExactKeys(record.lanes, DEPLOYMENT_LANES, 'deployment target lanes');
  const lanes = Object.fromEntries(
    DEPLOYMENT_LANES.map((lane) => [
      lane,
      parseDeploymentLaneConfiguration(laneRecords[lane], lane, sharedNames, target.sourceAction, target),
    ]),
  );
  if (sharedNames.signatureVerifierFunction !== sharedNames.targetLambdaFunctions.imageSignatureVerifier) {
    throw new Error('deployment target signatureVerifierFunction must match its target Lambda function');
  }
  if (sharedNames.signatureVerifierRole !== `${sharedNames.signatureRuntimeNamePrefix}-image-signature-verifier-role`) {
    throw new Error('deployment target signatureVerifierRole must match its signatureRuntimeNamePrefix');
  }
  if (
    sharedNames.signatureVerifierPermissionsBoundary !==
    `${target.projectId}-image-signature-verifier-boundary-${target.accountLabel}-${target.environmentId}`
  ) {
    throw new Error('deployment target signatureVerifierPermissionsBoundary must match its target');
  }
  const expectedLambdaFunctions = {
    finalizationWriter: `${sharedNames.runtimeNamePrefix}-finalization-writer`,
    imageSignatureVerifier: `${sharedNames.signatureRuntimeNamePrefix}-image-signature-verifier`,
    proofDispatcher: `${sharedNames.runtimeNamePrefix}-proof-dispatcher`,
    publicApi: `${sharedNames.runtimeNamePrefix}-public-api`,
    semaphoreJanitor: `${sharedNames.runtimeNamePrefix}-semaphore-janitor`,
    verificationWorker: `${sharedNames.runtimeNamePrefix}-verification-worker`,
  };
  for (const functionKey of TARGET_LAMBDA_FUNCTION_KEYS) {
    if (sharedNames.targetLambdaFunctions[functionKey] !== expectedLambdaFunctions[functionKey]) {
      throw new Error(`deployment target Lambda function ${functionKey} must match its governed name prefix`);
    }
  }
  if (
    sharedNames.ecrRetentionRole !== `sbs-ecr-retention-${target.accountLabel}-${target.environmentId}` ||
    sharedNames.ecrRetentionPermissionsBoundary !==
      `sbs-ecr-retention-boundary-${target.accountLabel}-${target.environmentId}` ||
    sharedNames.ecrRetentionFunction !== `${sharedNames.runtimeNamePrefix}-ecr-retention` ||
    sharedNames.ecrRetentionLogGroup !== `/aws/lambda/${sharedNames.ecrRetentionFunction}` ||
    sharedNames.ecrRetentionSchedule !== `${sharedNames.runtimeNamePrefix}-ecr-retention-daily` ||
    sharedNames.finalizationStateMachine !== `${sharedNames.runtimeNamePrefix}-finalization` ||
    sharedNames.proverEcsCluster !== `${sharedNames.runtimeNamePrefix}-prover` ||
    sharedNames.proverEcsTaskFamily !== `${sharedNames.runtimeNamePrefix}-prover`
  ) {
    throw new Error('deployment target ECR retention runtime names must match the governed runtime prefix');
  }
  for (const functionKey of TARGET_LAMBDA_FUNCTION_KEYS) {
    if (sharedNames.targetLogGroups[functionKey] !== `/aws/lambda/${sharedNames.targetLambdaFunctions[functionKey]}`) {
      throw new Error(`deployment target log group ${functionKey} must match its target Lambda function`);
    }
  }
  if (sharedNames.targetLogGroups.prover !== `/aws/ecs/${target.resourcePrefix}-prover`) {
    throw new Error('deployment target Prover log group must match its resourcePrefix');
  }
  if (sharedNames.targetLogGroups.opsLedger !== `/aws/events/${target.resourcePrefix}-ops-ledger`) {
    throw new Error('deployment target operations-ledger log group must match its resourcePrefix');
  }
  if (sharedNames.acceptedDeploymentPointerKey !== `${sharedNames.acceptedDeploymentPrefix}/current.json`) {
    throw new Error('deployment target acceptedDeploymentPointerKey must match its acceptedDeploymentPrefix');
  }
  if (
    sharedNames.rollbackReadinessReportPrefix !==
      `${sharedNames.terraformDriftReportPrefix}/${target.targetKey}/rollback-readiness` ||
    sharedNames.recoveryReadinessReportPrefix !==
      `${sharedNames.terraformDriftReportPrefix}/${target.targetKey}/recovery-readiness`
  ) {
    throw new Error('deployment target readiness report prefixes must match the governed target and drift prefix');
  }
  if (sharedNames.appStaticFastPipelineRole !== lanes['static-fast'].names.pipelineRole) {
    throw new Error('deployment target appStaticFastPipelineRole must match the static-fast lane pipelineRole');
  }
  const staticFastDeployProjectPeers = [
    sharedNames.appDeploymentRecordProject,
    sharedNames.appSignaturePreflightApplyProject,
    sharedNames.appSignaturePreflightInvokeProject,
    sharedNames.appSignaturePreflightPlanProject,
    sharedNames.appSignatureStateRefreshApplyProject,
    sharedNames.appSignatureStateRefreshPlanProject,
    sharedNames.appStaticDeployProject,
    sharedNames.appStaticFastGateProject,
    sharedNames.appStaticFastSmokeProject,
    lanes.app.names.smokeProject,
    lanes.app.names.terraformApplyProject,
    lanes.app.names.terraformPlanProject,
    lanes.app.names.validateProject,
  ];
  if (staticFastDeployProjectPeers.includes(sharedNames.appStaticFastDeployProject)) {
    throw new Error('deployment target static-fast deploy project must differ from every governed App project');
  }
  const staticFastDeployRolePeers = [
    sharedNames.appDeploymentRecordRole,
    sharedNames.appSignaturePreflightApplyRole,
    sharedNames.appSignaturePreflightInvokerRole,
    sharedNames.appSignaturePreflightPlanRole,
    sharedNames.appSignatureStateRefreshApplyRole,
    sharedNames.appStaticDeployRole,
    sharedNames.appStaticFastGateRole,
    sharedNames.appStaticFastPipelineRole,
    sharedNames.appStaticFastSmokeRole,
    sharedNames.signatureVerifierRole,
    lanes.app.names.githubTriggerRole,
    lanes.app.names.pipelineRole,
    lanes.app.names.terraformApplyRole,
    lanes.app.names.terraformPlanRole,
    lanes.app.names.terraformSmokeRole,
  ];
  if (staticFastDeployRolePeers.includes(sharedNames.appStaticFastDeployRole)) {
    throw new Error('deployment target static-fast deploy role must differ from every governed App role');
  }
  if (
    new Set(TERRAFORM_DRIFT_MANAGED_POLICY_NAME_KEYS.map((key) => sharedNames[key])).size !==
    TERRAFORM_DRIFT_MANAGED_POLICY_NAME_KEYS.length
  ) {
    throw new Error('deployment target Terraform drift managed policy names must be pairwise distinct');
  }
  if (
    new Set([
      sharedNames.appRetainedArtifactBucket,
      lanes.app.names.artifactBucket,
      lanes['static-fast'].names.artifactBucket,
    ]).size !== 3
  ) {
    throw new Error('deployment target App retained and execution artifact buckets must be pairwise distinct');
  }
  if (lanes.app.names.artifactKmsAlias !== lanes['static-fast'].names.artifactKmsAlias) {
    throw new Error('deployment target App execution lanes must share the governed artifact KMS alias');
  }
  if (lanes.bootstrap.names.terraformSmokeRole === lanes.bootstrap.names.terraformPlanRole) {
    throw new Error('deployment target Bootstrap terraformSmokeRole must differ from terraformPlanRole');
  }
  return { ...target, sharedNames, lanes };
}

export function parseDeploymentTargetConfiguration(value) {
  const record = requireExactKeys(value, ['allowedTargets', 'configurationType'], 'deployment target configuration');
  if (record.configurationType !== 'deployment-target-configuration') {
    throw new Error('deployment target configurationType must be deployment-target-configuration');
  }
  const allowedTargetRecords = requireExactKeys(
    record.allowedTargets,
    ALLOWED_TARGET_KEYS,
    'deployment allowed targets',
  );
  const allowedTargets = Object.fromEntries(
    ALLOWED_TARGET_KEYS.map((targetKey) => [
      targetKey,
      parseAllowedDeploymentTarget(allowedTargetRecords[targetKey], targetKey),
    ]),
  );
  return deepFreeze({ configurationType: 'deployment-target-configuration', allowedTargets });
}

function selectAllowedDeploymentTarget(targetEntry) {
  return deepFreeze(Object.fromEntries(ALLOWED_DEPLOYMENT_TARGET_KEYS.map((key) => [key, targetEntry[key]])));
}

const DEPLOYMENT_TARGET_CONFIGURATION = parseDeploymentTargetConfiguration(rawDeploymentTargetConfiguration);
const ALLOWED_TARGET_ENTRIES = DEPLOYMENT_TARGET_CONFIGURATION.allowedTargets;
const ALLOWED_TARGETS = deepFreeze(
  Object.fromEntries(
    ALLOWED_TARGET_KEYS.map((targetKey) => [
      targetKey,
      selectAllowedDeploymentTarget(ALLOWED_TARGET_ENTRIES[targetKey]),
    ]),
  ),
);

export function immutableObjectReferencesEqual(leftValue, rightValue) {
  const left = parseImmutableObjectReference(leftValue);
  const right = parseImmutableObjectReference(rightValue);
  return left.key === right.key && left.versionId === right.versionId && left.sha256 === right.sha256;
}

function normalizeDeploymentIdentityInput(input) {
  let record;
  try {
    record = requireExactKeys(
      input,
      ['appDeploymentRecordSha256', 'appSourceSha', 'deployMode', 'pipelineExecutionId'],
      'deployment identity input',
    );
  } catch {
    throw new Error('deployment identity input is invalid');
  }
  const deployMode = record.deployMode;
  if (deployMode !== 'normal' && deployMode !== 'rollback') {
    throw new Error('deployMode must be normal or rollback');
  }
  const pipelineExecutionId = requireGroupedLowercaseUuid(record.pipelineExecutionId, 'pipelineExecutionId');
  return deepFreeze({
    appDeploymentRecordSha256: parseSha256(record.appDeploymentRecordSha256, 'appDeploymentRecordSha256'),
    appSourceSha: parseFullSourceSha(record.appSourceSha, 'appSourceSha'),
    deployMode,
    pipelineExecutionId,
  });
}

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
  if (identity.identityType !== 'app-deployment') {
    throw new Error('identityType is invalid');
  }
  const derived = deriveDeploymentIdentity(identity.authority);
  if (identity.authoritySha256 !== derived.authoritySha256) {
    throw new Error('authoritySha256 does not match the canonical deployment authority');
  }
  if (identity.deploymentId !== derived.deploymentId) {
    throw new Error('deploymentId does not match the deployment authority');
  }
  return derived;
}

export function assertFirstPublication(observedVersionId) {
  if (observedVersionId !== undefined) {
    throw new Error('immutable object already exists');
  }
}

export function validateAcceptedReleasePointer(value, imageKind) {
  if (imageKind !== 'toolchain' && imageKind !== 'prover') {
    throw new Error('Accepted release pointer image kind is invalid.');
  }
  const recordPrefix = imageKind === 'toolchain' ? 'artifactRecord' : 'releaseRecord';
  const label = `${imageKind} accepted pointer`;
  let record;
  try {
    record = requireExactKeys(
      value,
      [
        'compareAndSwapEvidenceId',
        'pointerType',
        'previousVersionOrEtag',
        'promotionExecutionId',
        `${recordPrefix}Key`,
        `${recordPrefix}Sha256`,
        `${recordPrefix}VersionId`,
      ],
      label,
    );
  } catch {
    throw new Error(`${label} must use the exact current shape.`);
  }
  if (record.pointerType !== `${imageKind}-accepted-pointer`) {
    throw new Error(`${imageKind} accepted pointer type is invalid.`);
  }
  const key = requireString(
    record[`${recordPrefix}Key`],
    `${imageKind} accepted pointer record key`,
    /^[A-Za-z0-9][A-Za-z0-9._/@+-]{1,1023}$/u,
  );
  const configuredPrefix =
    imageKind === 'toolchain'
      ? ALLOWED_TARGET_ENTRIES['stark-dev/develop'].sharedNames.toolchainArtifactPrefix
      : ALLOWED_TARGET_ENTRIES['stark-dev/develop'].sharedNames.proverReleasePrefix;
  if (!key.startsWith(`${configuredPrefix}/`)) {
    throw new Error(`${imageKind} accepted pointer record key is outside its immutable prefix.`);
  }
  parseS3VersionId(record[`${recordPrefix}VersionId`], `${imageKind} accepted pointer record VersionId`);
  parseSha256(record[`${recordPrefix}Sha256`], `${imageKind} accepted pointer record SHA-256`);
  requireString(
    record.promotionExecutionId,
    `${imageKind} accepted pointer promotion execution`,
    OPERATIONAL_IDENTIFIER_PATTERN,
  );
  requireString(
    record.previousVersionOrEtag,
    `${imageKind} accepted pointer previous version or ETag`,
    OPERATIONAL_IDENTIFIER_PATTERN,
  );
  requireString(
    record.compareAndSwapEvidenceId,
    `${imageKind} accepted pointer CAS evidence`,
    OPERATIONAL_IDENTIFIER_PATTERN,
  );
  return deepFreeze({ ...record });
}

export function resolveAllowedDeploymentTarget(targetKey) {
  if (typeof targetKey !== 'string' || !Object.hasOwn(ALLOWED_TARGETS, targetKey)) {
    throw new Error(`deployment target "${String(targetKey)}" is not authorized`);
  }
  return ALLOWED_TARGETS[targetKey];
}

export function validateAwsSsoCallerIdentity(value, target) {
  const allowedTarget = assertAllowedTarget(target);
  let identity;
  try {
    identity = requireExactKeys(value, ['Account', 'Arn'], 'AWS caller identity');
  } catch {
    throw new Error('AWS caller identity must use exact Account and Arn fields.');
  }
  const accountId = requireString(identity.Account, 'AWS caller account', ACCOUNT_ID_PATTERN);
  const arn = requireString(identity.Arn, 'AWS caller ARN');
  if (accountId !== allowedTarget.accountId) {
    throw new Error('AWS caller account does not match the reviewed deployment target.');
  }
  const permissionSetName = allowedTarget.operatorPermissionSetName.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const expectedArn = new RegExp(
    `^arn:${allowedTarget.partition}:sts::${allowedTarget.accountId}:assumed-role/AWSReservedSSO_${permissionSetName}_[0-9a-f]{16}/[A-Za-z0-9+=,.@_-]+$`,
    'u',
  );
  if (!expectedArn.test(arn)) {
    throw new Error('AWS caller role does not match the reviewed operator permission set.');
  }
  return deepFreeze({ accountId, arn });
}

export function resolveImageSigningIdentity(target) {
  const allowedTarget = assertAllowedTarget(target);
  const names = ALLOWED_TARGET_ENTRIES[allowedTarget.targetKey].sharedNames;
  return deepFreeze({
    namePrefix: allowedTarget.resourcePrefix,
    signingProfileName: names.signerProfile,
    signingProfileArn: `arn:${allowedTarget.partition}:signer:${allowedTarget.region}:${allowedTarget.accountId}:/signing-profiles/${names.signerProfile}`,
    repositories: {
      prover: names.proverRepository,
      toolchain: names.toolchainRepository,
    },
  });
}

function assertAllowedTarget(target) {
  const allowedTarget = ALLOWED_TARGETS['stark-dev/develop'];
  if (canonicalJson(target) !== canonicalJson(allowedTarget)) {
    throw new Error('deployment target does not match the reviewed allowed-target configuration');
  }
  return allowedTarget;
}

function requireSourceSha(value, label) {
  return parseFullSourceSha(value, label);
}

function requireLane(value) {
  if (typeof value !== 'string' || !Object.hasOwn(ALLOWED_TARGET_ENTRIES['stark-dev/develop'].lanes, value)) {
    throw new Error('deployment lane is not authorized');
  }
  return value;
}

function assertGeneratedPipelineName(value) {
  if (!/^[A-Za-z0-9.@_-]{1,100}$/u.test(value)) {
    throw new Error('generated CodePipeline name is invalid');
  }
}

function assertGeneratedCodePipelineActionName(value) {
  if (!/^[A-Za-z0-9.@_-]{1,100}$/u.test(value)) {
    throw new Error('generated CodePipeline action name is invalid');
  }
}

function assertGeneratedEcrRepository(value) {
  if (value.length > 256 || !/^[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*$/u.test(value)) {
    throw new Error('generated ECR repository name is invalid');
  }
}

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

function assertGeneratedBucketName(value) {
  if (
    value.length < 3 ||
    value.length > 63 ||
    !/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/u.test(value) ||
    value.includes('..') ||
    value.includes('.-') ||
    value.includes('-.') ||
    /^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/u.test(value) ||
    /^(?:xn--|sthree-|amzn_s3_demo_)/u.test(value) ||
    /(?:-s3alias|--ol-s3|\.mrap|--x-s3|--table-s3)$/u.test(value)
  ) {
    throw new Error('generated S3 bucket name is invalid');
  }
}

function assertGeneratedIamName(value, label) {
  if (!/^[A-Za-z0-9+=,.@_-]{1,64}$/u.test(value)) {
    throw new Error(`generated ${label} IAM name is invalid`);
  }
}

function assertGeneratedIamPolicyName(value, label) {
  if (!/^[A-Za-z0-9+=,.@_-]{1,128}$/u.test(value)) {
    throw new Error(`generated ${label} IAM policy name is invalid`);
  }
}

function assertGeneratedCodeBuildName(value) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{1,254}$/u.test(value)) {
    throw new Error('generated CodeBuild project name is invalid');
  }
}

function assertGeneratedLambdaName(value) {
  if (!/^[A-Za-z0-9_-]{1,64}$/u.test(value)) {
    throw new Error('generated Lambda function name is invalid');
  }
}

function assertGeneratedCloudWatchLogGroupName(value) {
  if (value.length > 512 || !/^[A-Za-z0-9_./#-]+$/u.test(value) || value.startsWith('aws/')) {
    throw new Error('generated CloudWatch Logs log-group name is invalid');
  }
}

function assertGeneratedEventBridgeRuleName(value) {
  if (!/^[A-Za-z0-9_.-]{1,64}$/u.test(value)) {
    throw new Error('generated EventBridge rule name is invalid');
  }
}

function assertGeneratedCloudFrontFunctionName(value) {
  if (!/^[A-Za-z0-9_-]{1,64}$/u.test(value)) {
    throw new Error('generated CloudFront function name is invalid');
  }
}

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

function assertGeneratedSignerProfileName(value) {
  if (!/^[A-Za-z0-9_]{2,64}$/u.test(value)) {
    throw new Error('generated Signer profile name is invalid');
  }
}

function assertGeneratedSsmParameterPrefix(value) {
  if (value.length > 1011 || !/^\/(?!aws(?:\/|$)|ssm(?:\/|$))[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/iu.test(value)) {
    throw new Error('generated SSM parameter prefix is invalid');
  }
}

function assertGeneratedSecretsManagerPrefix(value) {
  if (value.length > 512 || !/^\/[A-Za-z0-9_+=.@-]+(?:\/[A-Za-z0-9_+=.@-]+)*$/u.test(value)) {
    throw new Error('generated Secrets Manager prefix is invalid');
  }
}

function assertGeneratedResourceNamePrefix(value, label) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u.test(value)) {
    throw new Error(`generated ${label} name prefix is invalid`);
  }
}

function resolveContextNames(target, laneAuthority) {
  const targetEntry = ALLOWED_TARGET_ENTRIES[target.targetKey];
  const laneConfiguration = targetEntry.lanes[laneAuthority.lane];
  const names = {
    sourceAction: target.sourceAction,
    ...targetEntry.sharedNames,
    ...laneConfiguration.names,
  };
  assertConfiguredContextNames(names);
  return deepFreeze(names);
}

export function resolveDeploymentLaneAuthority(target, selectedLane) {
  const allowedTarget = assertAllowedTarget(target);
  const lane = requireLane(selectedLane);
  const targetEntry = ALLOWED_TARGET_ENTRIES[allowedTarget.targetKey];
  const laneConfiguration = targetEntry.lanes[lane];
  const names = resolveContextNames(allowedTarget, { lane });
  return deepFreeze({
    lane,
    scope: laneConfiguration.scope,
    stateIdentity: laneConfiguration.stateIdentity,
    backendKey: laneConfiguration.backendKey,
    names,
    policy: laneConfiguration.policy,
  });
}

export function renderDeploymentLaneContext(input) {
  const record = requireExactKeys(
    input,
    ['accountId', 'frameworkSourceSha', 'lane', 'requestedControlSourceSha', 'selectedApplicationSourceSha', 'target'],
    'deployment context input',
  );
  const target = assertAllowedTarget(record.target);
  const laneAuthority = resolveDeploymentLaneAuthority(target, record.lane);
  const accountId = requireString(record.accountId, 'AWS account ID', ACCOUNT_ID_PATTERN);
  if (accountId !== target.accountId) {
    throw new Error('AWS account ID does not match the reviewed allowed target');
  }
  const requestedControlSourceSha = requireSourceSha(record.requestedControlSourceSha, 'requested control source SHA');
  const selectedApplicationSourceSha = requireSourceSha(
    record.selectedApplicationSourceSha,
    'selected application source SHA',
  );
  const frameworkSourceSha = requireSourceSha(record.frameworkSourceSha, 'framework source SHA');
  if (requestedControlSourceSha !== frameworkSourceSha) {
    throw new Error('requested control source SHA must match framework source SHA');
  }
  const resourcePrefix = target.resourcePrefix;
  const names = resolveContextNames(target, laneAuthority);

  return assembleDeploymentContext({
    contextType: 'deployment-lane-context',
    project: {
      projectId: target.projectId,
      resourcePrefix,
      stateNamespace: target.stateNamespace,
      artifactNamespace: target.artifactNamespace,
    },
    target: {
      partition: target.partition,
      accountId,
      accountLabel: target.accountLabel,
      region: target.region,
      environmentId: target.environmentId,
      environmentTier: target.environmentTier,
      operatorPermissionSetName: target.operatorPermissionSetName,
    },
    root: {
      lane: laneAuthority.lane,
      scope: laneAuthority.scope,
      stateIdentity: laneAuthority.stateIdentity,
      backendKey: laneAuthority.backendKey,
    },
    source: {
      branch: target.sourceBranch,
      provider: target.sourceProvider,
      repository: target.repository,
      repositoryUrl: target.repositoryUrl,
      requestedControlSourceSha,
      selectedApplicationSourceSha,
      frameworkSourceSha,
    },
    names,
    policy: laneAuthority.policy,
    targetConfigurationSha256: canonicalJsonSha256(ALLOWED_TARGET_ENTRIES[target.targetKey]),
  });
}

export function parseDeploymentLaneContext(value) {
  const context = requireExactKeys(value, CONTEXT_KEYS, 'deployment lane context');
  requireExactKeys(context.project, PROJECT_KEYS, 'deployment context project');
  const target = requireExactKeys(context.target, TARGET_KEYS, 'deployment context target');
  const root = requireExactKeys(context.root, ROOT_KEYS, 'deployment context root');
  const source = requireExactKeys(context.source, SOURCE_KEYS, 'deployment context source');
  requireExactKeys(context.names, NAME_KEYS, 'deployment context names');
  requireExactKeys(context.policy, POLICY_KEYS, 'deployment context policy');
  if (context.contextType !== 'deployment-lane-context') {
    throw new Error('deployment contextType must be deployment-lane-context');
  }
  const rendered = renderDeploymentLaneContext({
    target: resolveAllowedDeploymentTarget('stark-dev/develop'),
    lane: root.lane,
    accountId: target.accountId,
    requestedControlSourceSha: source.requestedControlSourceSha,
    selectedApplicationSourceSha: source.selectedApplicationSourceSha,
    frameworkSourceSha: source.frameworkSourceSha,
  });
  if (canonicalJson(rendered) !== canonicalJson(context)) {
    throw new Error('deployment lane context does not match the canonical allowed target');
  }
  return rendered;
}
