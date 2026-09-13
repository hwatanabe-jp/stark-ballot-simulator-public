import { types as utilTypes } from 'node:util';
import { snapshotDataTree, snapshotDenseArray, snapshotExactRecord } from './descriptor-snapshot.js';
import { deepFreeze, parseGitCommitSha, parseSha256, requireGroupedLowercaseUuid, sha256Text } from './internal.js';
import {
  canonicalRecordJson,
  parseDeploymentLaneContext,
  resolveAllowedDeploymentTarget,
  resolveDeploymentLaneAuthority,
} from './index.js';

const ACCOUNT_ID_PATTERN = /^[0-9]{12}$/u;
const REGION_PATTERN = /^[a-z]{2}(?:-gov)?-[a-z]+-[0-9]$/u;
const PROJECT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{1,149}$/u;
const ROLE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_+=,.@-]{0,63}$/u;
const BUILDSPEC_PATH_PATTERN = /^(?!\/)[A-Za-z0-9._/-]+\.ya?ml$/u;
const ENVIRONMENT_VARIABLE_NAME_PATTERN = /^[A-Z][A-Za-z0-9_]{0,127}$/u;
const MANAGED_CODEBUILD_IMAGE_PATTERN = /^aws\/codebuild\/(?:standard|amazonlinux2-aarch64-standard):[0-9]+\.[0-9]+$/u;

/** @param {unknown} value @returns {value is string} */
export function isManagedCodeBuildImageIdentifier(value) {
  return typeof value === 'string' && value.length <= 512 && MANAGED_CODEBUILD_IMAGE_PATTERN.test(value);
}

export const CODEBUILD_PROJECT_FAMILIES = Object.freeze([
  'bootstrap',
  'foundation',
  'image-signature-preflight',
  'app',
  'static-fast',
  'release',
  'terraform-drift',
]);

export const CODEBUILD_EXECUTION_CODE_AUTHORITIES = Object.freeze([
  'pipeline-source-path',
  'configured-source-path',
  'terraform-rendered',
]);

/**
 * @typedef {'app' | 'bootstrap' | 'foundation' | 'image-signature-preflight' | 'release' | 'static-fast' | 'terraform-drift'} CodeBuildProjectFamily
 */

/**
 * @typedef {'configured-source-path' | 'pipeline-source-path' | 'terraform-rendered'} ExecutionCodeAuthority
 */

/**
 * @typedef {Readonly<{
 *   executionCodeAuthority: ExecutionCodeAuthority;
 *   family: CodeBuildProjectFamily;
 *   privilegedMode: boolean;
 *   projectName: string;
 * }>} CodeBuildProjectMembership
 */

/**
 * @typedef {Readonly<{
 *   accountId: string;
 *   buildspecPath: string;
 *   computeType: string;
 *   environmentType: string;
 *   partition: 'aws';
 *   privilegedMode: boolean;
 *   projectName: string;
 *   region: string;
 *   roleName: string;
 *   sourceType: 'CODEPIPELINE';
 * }>} SourcePathProjectAuthority
 */

/**
 * @typedef {Readonly<{
 *   name: string;
 *   type: string;
 *   value: string;
 * }>} BuildActionEnvironmentVariable
 */

/**
 * @typedef {Readonly<{
 *   actionName: string;
 *   environmentVariables: readonly BuildActionEnvironmentVariable[];
 *   inputArtifacts: readonly string[];
 *   outputArtifacts: readonly string[];
 *   primarySource: string;
 *   projectName: string;
 *   region: string;
 *   runOrder: number;
 * }>} SourcePathBuildActionAuthority
 */

/**
 * @typedef {Readonly<{
 *   artifactsType: string;
 *   buildspecPath: string;
 *   computeType: string;
 *   configuredManagedImage: string;
 *   environmentType: string;
 *   imagePullCredentialsType: string;
 *   privilegedMode: boolean;
 *   projectArn: string;
 *   projectName: string;
 *   serviceRoleArn: string;
 *   sourceType: string;
 * }>} SourcePathProjectObservation
 */

/**
 * @typedef {Readonly<{
 *   EnvironmentVariables?: readonly BuildActionEnvironmentVariable[];
 *   PrimarySource: string;
 *   ProjectName: string;
 * }>} AdmittedBuildActionConfiguration
 */

/**
 * @typedef {Readonly<{
 *   actionName: string;
 *   category: string;
 *   configuration: AdmittedBuildActionConfiguration;
 *   inputArtifacts: readonly string[];
 *   outputArtifacts: readonly string[];
 *   owner: string;
 *   provider: string;
 *   region: string;
 *   runOrder: number;
 *   version: string;
 * }>} SourcePathBuildActionObservation
 */

/**
 * Exact top-level request fields currently accepted by the AWS CodeBuild
 * StartBuild API. Keep this inventory in lockstep with the official API
 * reference before changing override enforcement.
 */
export const START_BUILD_REQUEST_FIELDS = Object.freeze([
  'artifactsOverride',
  'autoRetryLimitOverride',
  'buildStatusConfigOverride',
  'buildspecOverride',
  'cacheOverride',
  'certificateOverride',
  'computeTypeOverride',
  'debugSessionEnabled',
  'encryptionKeyOverride',
  'environmentTypeOverride',
  'environmentVariablesOverride',
  'fleetOverride',
  'gitCloneDepthOverride',
  'gitSubmodulesConfigOverride',
  'hostKernelOverride',
  'idempotencyToken',
  'imageOverride',
  'imagePullCredentialsTypeOverride',
  'insecureSslOverride',
  'logsConfigOverride',
  'privilegedModeOverride',
  'projectName',
  'queuedTimeoutInMinutesOverride',
  'registryCredentialOverride',
  'reportBuildStatusOverride',
  'secondaryArtifactsOverride',
  'secondarySourcesOverride',
  'secondarySourcesVersionOverride',
  'serviceRoleOverride',
  'sourceAuthOverride',
  'sourceLocationOverride',
  'sourceTypeOverride',
  'sourceVersion',
  'timeoutInMinutesOverride',
]);

/**
 * Exact condition keys currently listed for codebuild:StartBuild in the AWS
 * Service Authorization Reference. These are service semantics, not inferred
 * names derived from the API request fields.
 */
export const START_BUILD_CONDITION_KEYS = Object.freeze([
  'aws:ResourceTag/${TagKey}',
  'codebuild:artifacts',
  'codebuild:artifacts.bucketOwnerAccess',
  'codebuild:artifacts.encryptionDisabled',
  'codebuild:artifacts.location',
  'codebuild:autoRetryLimit',
  'codebuild:cache',
  'codebuild:cache.location',
  'codebuild:cache.modes',
  'codebuild:cache.type',
  'codebuild:encryptionKey',
  'codebuild:environment',
  'codebuild:environment.certificate',
  'codebuild:environment.computeType',
  'codebuild:environment.environmentVariables',
  'codebuild:environment.environmentVariables.name',
  'codebuild:environment.environmentVariables.value',
  'codebuild:environment.environmentVariables/${name}.value',
  'codebuild:environment.fleet.fleetArn',
  'codebuild:environment.image',
  'codebuild:environment.imagePullCredentialsType',
  'codebuild:environment.privilegedMode',
  'codebuild:environment.registryCredential',
  'codebuild:environment.registryCredential.credential',
  'codebuild:environment.registryCredential.credentialProvider',
  'codebuild:environment.type',
  'codebuild:logsConfig',
  'codebuild:logsConfig.s3Logs',
  'codebuild:logsConfig.s3Logs.bucketOwnerAccess',
  'codebuild:logsConfig.s3Logs.encryptionDisabled',
  'codebuild:logsConfig.s3Logs.location',
  'codebuild:logsConfig.s3Logs.status',
  'codebuild:secondaryArtifacts',
  'codebuild:secondaryArtifacts.artifactIdentifier',
  'codebuild:secondaryArtifacts.bucketOwnerAccess',
  'codebuild:secondaryArtifacts.encryptionDisabled',
  'codebuild:secondaryArtifacts.location',
  'codebuild:secondaryArtifacts/${artifactIdentifier}.bucketOwnerAccess',
  'codebuild:secondaryArtifacts/${artifactIdentifier}.encryptionDisabled',
  'codebuild:secondaryArtifacts/${artifactIdentifier}.location',
  'codebuild:secondarySources',
  'codebuild:secondarySources.auth.resource',
  'codebuild:secondarySources.auth.type',
  'codebuild:secondarySources.buildStatusConfig.context',
  'codebuild:secondarySources.buildStatusConfig.targetUrl',
  'codebuild:secondarySources.buildspec',
  'codebuild:secondarySources.insecureSsl',
  'codebuild:secondarySources.location',
  'codebuild:secondarySources.sourceIdentifier',
  'codebuild:secondarySources/${sourceIdentifier}.auth.resource',
  'codebuild:secondarySources/${sourceIdentifier}.auth.type',
  'codebuild:secondarySources/${sourceIdentifier}.buildStatusConfig.context',
  'codebuild:secondarySources/${sourceIdentifier}.buildStatusConfig.targetUrl',
  'codebuild:secondarySources/${sourceIdentifier}.buildspec',
  'codebuild:secondarySources/${sourceIdentifier}.insecureSsl',
  'codebuild:secondarySources/${sourceIdentifier}.location',
  'codebuild:serviceRole',
  'codebuild:source',
  'codebuild:source.auth.resource',
  'codebuild:source.auth.type',
  'codebuild:source.buildStatusConfig.context',
  'codebuild:source.buildStatusConfig.targetUrl',
  'codebuild:source.buildspec',
  'codebuild:source.insecureSsl',
  'codebuild:source.location',
]);

const CONDITION_ADDRESSABLE_FIELDS = Object.freeze([
  'artifactsOverride',
  'autoRetryLimitOverride',
  'buildStatusConfigOverride',
  'buildspecOverride',
  'cacheOverride',
  'certificateOverride',
  'computeTypeOverride',
  'encryptionKeyOverride',
  'environmentTypeOverride',
  'environmentVariablesOverride',
  'fleetOverride',
  'imageOverride',
  'imagePullCredentialsTypeOverride',
  'insecureSslOverride',
  'logsConfigOverride',
  'privilegedModeOverride',
  'registryCredentialOverride',
  'secondaryArtifactsOverride',
  'secondarySourcesOverride',
  'serviceRoleOverride',
  'sourceAuthOverride',
  'sourceLocationOverride',
  'sourceTypeOverride',
]);

const COMPOSITION_EXCLUDED_FIELDS = Object.freeze([
  'debugSessionEnabled',
  'gitCloneDepthOverride',
  'gitSubmodulesConfigOverride',
  'hostKernelOverride',
  'queuedTimeoutInMinutesOverride',
  'reportBuildStatusOverride',
  'secondarySourcesVersionOverride',
  'sourceVersion',
  'timeoutInMinutesOverride',
]);

/** @type {Readonly<Record<string, readonly string[]>>} */
const START_BUILD_OVERRIDE_GUARDS = Object.freeze({
  artifactsOverride: Object.freeze(['codebuild:artifacts']),
  autoRetryLimitOverride: Object.freeze(['codebuild:autoRetryLimit']),
  buildStatusConfigOverride: Object.freeze([
    'codebuild:source.buildStatusConfig.context',
    'codebuild:source.buildStatusConfig.targetUrl',
  ]),
  buildspecOverride: Object.freeze(['codebuild:source.buildspec']),
  cacheOverride: Object.freeze(['codebuild:cache']),
  certificateOverride: Object.freeze(['codebuild:environment.certificate']),
  computeTypeOverride: Object.freeze(['codebuild:environment.computeType']),
  encryptionKeyOverride: Object.freeze(['codebuild:encryptionKey']),
  environmentTypeOverride: Object.freeze(['codebuild:environment.type']),
  environmentVariablesOverride: Object.freeze(['codebuild:environment.environmentVariables']),
  fleetOverride: Object.freeze(['codebuild:environment.fleet.fleetArn']),
  imageOverride: Object.freeze(['codebuild:environment.image']),
  imagePullCredentialsTypeOverride: Object.freeze(['codebuild:environment.imagePullCredentialsType']),
  insecureSslOverride: Object.freeze(['codebuild:source.insecureSsl']),
  logsConfigOverride: Object.freeze(['codebuild:logsConfig']),
  privilegedModeOverride: Object.freeze(['codebuild:environment.privilegedMode']),
  registryCredentialOverride: Object.freeze(['codebuild:environment.registryCredential']),
  secondaryArtifactsOverride: Object.freeze(['codebuild:secondaryArtifacts']),
  secondarySourcesOverride: Object.freeze(['codebuild:secondarySources']),
  serviceRoleOverride: Object.freeze(['codebuild:serviceRole']),
  sourceAuthOverride: Object.freeze(['codebuild:source.auth.resource', 'codebuild:source.auth.type']),
  sourceLocationOverride: Object.freeze(['codebuild:source.location']),
  sourceTypeOverride: Object.freeze(['codebuild:source']),
});

/** @returns {{readonly compositionExcluded: readonly string[], readonly conditionAddressable: readonly string[], readonly requestMetadata: readonly string[], readonly resourceEnforced: readonly string[]}} */
export function classifyStartBuildRequestFields() {
  return Object.freeze({
    compositionExcluded: COMPOSITION_EXCLUDED_FIELDS,
    conditionAddressable: CONDITION_ADDRESSABLE_FIELDS,
    requestMetadata: Object.freeze(['idempotencyToken']),
    resourceEnforced: Object.freeze(['projectName']),
  });
}

/**
 * @param {unknown} input
 * @returns {readonly Readonly<{action: 'codebuild:StartBuild', condition: Readonly<{test: 'ForAnyValue:StringNotEquals' | 'Null', values: readonly string[], variable: string}>, effect: 'Deny', resources: readonly string[]}>[]}
 */
export function buildStartBuildOverrideDenyStatements(input) {
  return buildStartBuildOverrideDenyStatementsForAuthority(input);
}

/**
 * @param {unknown} input
 * @returns {readonly Readonly<{action: 'codebuild:StartBuild', condition: Readonly<{test: 'ForAnyValue:StringNotEquals' | 'Null', values: readonly string[], variable: string}>, effect: 'Deny', resources: readonly string[]}>[]}
 */
function buildStartBuildOverrideDenyStatementsForAuthority(input) {
  const request = safeSnapshotExactRecord(
    input,
    ['allowedEnvironmentVariableNames', 'projectArns'],
    'StartBuild override-deny input',
  );
  const allowedEnvironmentVariableNames = safeSnapshotDenseArray(
    request['allowedEnvironmentVariableNames'],
    'allowed StartBuild environment variable names',
  ).map((value, index) =>
    requireEnvironmentVariableName(value, `allowed StartBuild environment variable name ${index}`),
  );
  if (new Set(allowedEnvironmentVariableNames).size !== allowedEnvironmentVariableNames.length) {
    throw new Error('allowed StartBuild environment variable names must be unique.');
  }
  const projectArns = safeSnapshotDenseArray(request['projectArns'], 'StartBuild project ARNs')
    .map((value, index) =>
      requirePatternString(
        value,
        /^arn:aws:codebuild:[a-z]{2}(?:-gov)?-[a-z]+-[0-9]:[0-9]{12}:project\/[A-Za-z0-9][A-Za-z0-9_-]{1,149}$/u,
        `StartBuild project ARN ${index}`,
        256,
      ),
    )
    .sort();
  if (projectArns.length === 0 || new Set(projectArns).size !== projectArns.length) {
    throw new Error('StartBuild project ARNs must contain unique exact resources.');
  }
  const frozenProjectArns = Object.freeze(projectArns);

  const deniedConditionKeys = CONDITION_ADDRESSABLE_FIELDS.flatMap((field) => {
    if (field === 'environmentVariablesOverride' && allowedEnvironmentVariableNames.length > 0) {
      return [];
    }
    const guards = START_BUILD_OVERRIDE_GUARDS[field];
    if (guards === undefined) {
      throw new Error('StartBuild override guard inventory is incomplete.');
    }
    return guards;
  }).sort();
  if (new Set(deniedConditionKeys).size !== deniedConditionKeys.length) {
    throw new Error('StartBuild override guard keys must be unique.');
  }

  const statements = deniedConditionKeys.map((variable) =>
    freezeDenyStatement(freezeCondition('Null', variable, Object.freeze(['false'])), frozenProjectArns),
  );
  if (allowedEnvironmentVariableNames.length > 0) {
    statements.push(
      freezeDenyStatement(
        freezeCondition(
          'ForAnyValue:StringNotEquals',
          'codebuild:environment.environmentVariables.name',
          Object.freeze([...allowedEnvironmentVariableNames]),
        ),
        frozenProjectArns,
      ),
    );
  }
  return Object.freeze(statements);
}

/**
 * @param {unknown} input
 * @returns {SourcePathProjectObservation}
 */
export function admitSourcePathBuildProject(input) {
  const request = safeSnapshotExactRecord(input, ['authority', 'observation'], 'source-path build project input');
  const authority = admitProjectAuthority(request['authority']);
  const observation = safeSnapshotExactRecord(
    request['observation'],
    [
      'artifactsType',
      'buildspecPath',
      'computeType',
      'environmentType',
      'imagePullCredentialsType',
      'configuredManagedImage',
      'privilegedMode',
      'projectArn',
      'projectName',
      'serviceRoleArn',
      'sourceType',
    ],
    'source-path build project observation',
  );

  const expectedProjectArn = `arn:${authority.partition}:codebuild:${authority.region}:${authority.accountId}:project/${authority.projectName}`;
  const expectedRoleArn = `arn:${authority.partition}:iam::${authority.accountId}:role/${authority.roleName}`;
  const admitted = {
    artifactsType: requireExactString(observation['artifactsType'], 'CODEPIPELINE', 'project artifact type'),
    buildspecPath: requireExactString(observation['buildspecPath'], authority.buildspecPath, 'project buildspec path'),
    computeType: requireExactString(observation['computeType'], authority.computeType, 'project compute type'),
    environmentType: requireExactString(
      observation['environmentType'],
      authority.environmentType,
      'project environment type',
    ),
    imagePullCredentialsType: requireExactString(
      observation['imagePullCredentialsType'],
      'CODEBUILD',
      'project image-pull credentials type',
    ),
    configuredManagedImage: requireManagedCodeBuildImageIdentifier(
      observation['configuredManagedImage'],
      'configured managed image',
    ),
    privilegedMode: requireExactBoolean(
      observation['privilegedMode'],
      authority.privilegedMode,
      'project privileged mode',
    ),
    projectArn: requireExactString(observation['projectArn'], expectedProjectArn, 'project ARN'),
    projectName: requireExactString(observation['projectName'], authority.projectName, 'project name'),
    serviceRoleArn: requireExactString(observation['serviceRoleArn'], expectedRoleArn, 'project service-role ARN'),
    sourceType: requireExactString(observation['sourceType'], 'CODEPIPELINE', 'project source type'),
  };
  return Object.freeze(admitted);
}

/**
 * @param {unknown} input
 * @returns {Readonly<{
 *   artifactsType: string;
 *   authResourceArn: string;
 *   authType: string;
 *   buildspecPath: string;
 *   computeType: string;
 *   configuredManagedImage: string;
 *   configuredSourceSha: string;
 *   environmentType: string;
 *   gitCloneDepth: number;
 *   gitSubmodulesFetch: boolean;
 *   imagePullCredentialsType: string;
 *   insecureSsl: boolean;
 *   privilegedMode: boolean;
 *   projectArn: string;
 *   projectName: string;
 *   reportBuildStatus: boolean;
 *   repositoryUrl: string;
 *   secondaryArtifacts: readonly unknown[];
 *   secondarySources: readonly unknown[];
 *   serviceRoleArn: string;
 *   sourceType: string;
 * }>}
 */
export function admitConfiguredSourcePathBuildProject(input) {
  const request = safeSnapshotExactRecord(input, ['authority', 'observation'], 'configured-source build project input');
  const authority = admitConfiguredSourceProjectAuthority(request['authority']);
  const observation = safeSnapshotExactRecord(
    request['observation'],
    [
      'artifactsType',
      'authResourceArn',
      'authType',
      'buildspecPath',
      'computeType',
      'configuredManagedImage',
      'configuredSourceSha',
      'environmentType',
      'gitCloneDepth',
      'gitSubmodulesFetch',
      'imagePullCredentialsType',
      'insecureSsl',
      'privilegedMode',
      'projectArn',
      'projectName',
      'reportBuildStatus',
      'repositoryUrl',
      'secondaryArtifacts',
      'secondarySources',
      'serviceRoleArn',
      'sourceType',
    ],
    'configured-source build project observation',
  );
  const projectArn = `arn:${authority.partition}:codebuild:${authority.region}:${authority.accountId}:project/${authority.projectName}`;
  const serviceRoleArn = `arn:${authority.partition}:iam::${authority.accountId}:role/${authority.roleName}`;
  return Object.freeze({
    artifactsType: requireExactString(observation['artifactsType'], 'NO_ARTIFACTS', 'project artifact type'),
    authResourceArn: requireExactString(
      observation['authResourceArn'],
      authority.authResourceArn,
      'project source auth resource ARN',
    ),
    authType: requireExactString(observation['authType'], 'CODECONNECTIONS', 'project source auth type'),
    buildspecPath: requireExactString(observation['buildspecPath'], authority.buildspecPath, 'project buildspec path'),
    computeType: requireExactString(observation['computeType'], authority.computeType, 'project compute type'),
    configuredManagedImage: requireManagedCodeBuildImageIdentifier(
      observation['configuredManagedImage'],
      'configured managed image',
    ),
    configuredSourceSha: requireExactString(
      observation['configuredSourceSha'],
      authority.configuredSourceSha,
      'configured source SHA',
    ),
    environmentType: requireExactString(
      observation['environmentType'],
      authority.environmentType,
      'project environment type',
    ),
    gitCloneDepth: requireExactNonnegativeInteger(observation['gitCloneDepth'], 0, 'project Git clone depth'),
    gitSubmodulesFetch: requireExactBoolean(observation['gitSubmodulesFetch'], false, 'project Git submodule fetching'),
    imagePullCredentialsType: requireExactString(
      observation['imagePullCredentialsType'],
      'CODEBUILD',
      'project image-pull credentials type',
    ),
    insecureSsl: requireExactBoolean(observation['insecureSsl'], false, 'project source TLS posture'),
    privilegedMode: requireExactBoolean(observation['privilegedMode'], false, 'project privileged mode'),
    projectArn: requireExactString(observation['projectArn'], projectArn, 'project ARN'),
    projectName: requireExactString(observation['projectName'], authority.projectName, 'project name'),
    reportBuildStatus: requireExactBoolean(observation['reportBuildStatus'], false, 'project build-status reporting'),
    repositoryUrl: requireExactString(
      observation['repositoryUrl'],
      authority.repositoryUrl,
      'project source repository',
    ),
    secondaryArtifacts: admitEmptyArray(observation['secondaryArtifacts'], 'project secondary artifacts'),
    secondarySources: admitEmptyArray(observation['secondarySources'], 'project secondary sources'),
    serviceRoleArn: requireExactString(observation['serviceRoleArn'], serviceRoleArn, 'project service-role ARN'),
    sourceType: requireExactString(observation['sourceType'], 'GITHUB', 'project source type'),
  });
}

/**
 * Admit the exact direct-build request shape and the source SHA resolved by
 * the resulting build. This is a composition boundary, not an IAM claim.
 *
 * @param {unknown} input
 * @returns {Readonly<{
 *   accountId: string;
 *   buildId: string;
 *   buildspecPath: string;
 *   callerArn: string;
 *   computeType: string;
 *   configuredManagedImage: string;
 *   environmentType: string;
 *   environmentVariablesOverride: readonly BuildActionEnvironmentVariable[];
 *   privilegedMode: boolean;
 *   projectArn: string;
 *   projectName: string;
 *   region: string;
 *   resolvedSourceSha: string;
 *   runningManagedImage: string;
 *   serviceRoleArn: string;
 * }>}
 */
export function admitConfiguredSourceBuildExecution(input) {
  const execution = safeSnapshotExactRecord(
    input,
    ['authority', 'request', 'runtime'],
    'configured-source build execution input',
  );
  const authority = safeSnapshotExactRecord(
    execution['authority'],
    ['environmentVariables', 'project'],
    'configured-source build execution authority',
  );
  const projectAuthority = admitConfiguredSourceProjectAuthority(authority['project']);
  const environmentVariables = admitActionEnvironmentVariables(
    authority['environmentVariables'],
    'configured-source build execution environment variables',
  );
  const requestKeys =
    environmentVariables.length === 0 ? ['projectName'] : ['environmentVariablesOverride', 'projectName'];
  const request = safeSnapshotExactRecord(execution['request'], requestKeys, 'configured-source direct-build request');
  requireExactString(
    request['projectName'],
    projectAuthority.projectName,
    'configured-source direct-build project name',
  );
  if (environmentVariables.length !== 0) {
    const observedEnvironmentVariables = admitActionEnvironmentVariables(
      request['environmentVariablesOverride'],
      'configured-source direct-build environment variables',
    );
    if (JSON.stringify(observedEnvironmentVariables) !== JSON.stringify(environmentVariables)) {
      throw new Error('configured-source direct-build environment variables do not match their authority.');
    }
  }
  const runtime = safeSnapshotExactRecord(
    execution['runtime'],
    ['accountId', 'buildId', 'callerArn', 'project', 'region', 'resolvedSourceSha', 'runningManagedImage'],
    'configured-source build runtime',
  );
  const project = admitConfiguredSourcePathBuildProject({
    authority: projectAuthority,
    observation: runtime['project'],
  });
  const accountId = requireExactString(runtime['accountId'], projectAuthority.accountId, 'build account ID');
  const region = requireExactString(runtime['region'], projectAuthority.region, 'build region');
  const resolvedSourceSha = requireExactString(
    runtime['resolvedSourceSha'],
    projectAuthority.configuredSourceSha,
    'configured-source build resolved SHA',
  );
  const callerArn = requireBoundedString(runtime['callerArn'], 'build caller ARN', 2048);
  const expectedCallerPrefix = `arn:${projectAuthority.partition}:sts::${accountId}:assumed-role/${projectAuthority.roleName}/`;
  const callerSession = callerArn.slice(expectedCallerPrefix.length);
  if (!callerArn.startsWith(expectedCallerPrefix) || !/^[A-Za-z0-9+=,.@_-]{2,64}$/u.test(callerSession)) {
    throw new Error('build caller ARN does not match the accepted project role.');
  }
  const buildId = requireBoundedString(runtime['buildId'], 'CodeBuild build ID', 512);
  const expectedBuildIdPattern = new RegExp(
    `^${escapeRegExp(projectAuthority.projectName)}:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`,
    'u',
  );
  if (!expectedBuildIdPattern.test(buildId)) {
    throw new Error('CodeBuild build ID does not match the accepted project.');
  }
  const runningManagedImage = requireManagedCodeBuildImageIdentifier(
    runtime['runningManagedImage'],
    'running managed image',
  );
  return Object.freeze({
    accountId,
    buildId,
    buildspecPath: project['buildspecPath'],
    callerArn,
    computeType: project['computeType'],
    configuredManagedImage: project['configuredManagedImage'],
    environmentType: project['environmentType'],
    environmentVariablesOverride: environmentVariables,
    privilegedMode: project['privilegedMode'],
    projectArn: project['projectArn'],
    projectName: project['projectName'],
    region,
    resolvedSourceSha,
    runningManagedImage,
    serviceRoleArn: project['serviceRoleArn'],
  });
}

/**
 * @param {unknown} input
 * @returns {SourcePathBuildActionObservation}
 */
export function admitSourcePathBuildAction(input) {
  const request = safeSnapshotExactRecord(input, ['authority', 'observation'], 'source-path build action input');
  const authority = admitActionAuthority(request['authority']);
  const observation = safeSnapshotExactRecord(
    request['observation'],
    [
      'actionName',
      'category',
      'configuration',
      'inputArtifacts',
      'outputArtifacts',
      'owner',
      'provider',
      'region',
      'runOrder',
      'version',
    ],
    'source-path build action observation',
  );
  const configurationKeys =
    authority.environmentVariables.length === 0
      ? ['PrimarySource', 'ProjectName']
      : ['EnvironmentVariables', 'PrimarySource', 'ProjectName'];
  const configuration = safeSnapshotExactRecord(
    observation['configuration'],
    configurationKeys,
    'source-path build action configuration',
  );
  const observedInputArtifacts = admitStringArray(observation['inputArtifacts'], 'build action input artifacts');
  const observedOutputArtifacts = admitStringArray(observation['outputArtifacts'], 'build action output artifacts');
  assertExactArray(observedInputArtifacts, authority.inputArtifacts, 'build action input artifacts');
  assertExactArray(observedOutputArtifacts, authority.outputArtifacts, 'build action output artifacts');
  if (!observedInputArtifacts.includes(authority.primarySource)) {
    throw new Error('build action primary source must be one of its exact input artifacts.');
  }

  /** @type {AdmittedBuildActionConfiguration} */
  const admittedConfiguration = Object.freeze({
    ...(authority.environmentVariables.length === 0
      ? {}
      : {
          EnvironmentVariables: admitActionEnvironmentJson(
            configuration['EnvironmentVariables'],
            authority.environmentVariables,
          ),
        }),
    PrimarySource: requireExactString(
      configuration['PrimarySource'],
      authority.primarySource,
      'build action primary source',
    ),
    ProjectName: requireExactString(configuration['ProjectName'], authority.projectName, 'build action project name'),
  });

  return Object.freeze({
    actionName: requireExactString(observation['actionName'], authority.actionName, 'build action name'),
    category: requireExactString(observation['category'], 'Build', 'build action category'),
    configuration: admittedConfiguration,
    inputArtifacts: observedInputArtifacts,
    outputArtifacts: observedOutputArtifacts,
    owner: requireExactString(observation['owner'], 'AWS', 'build action owner'),
    provider: requireExactString(observation['provider'], 'CodeBuild', 'build action provider'),
    region: requireExactString(observation['region'], authority.region, 'build action region'),
    runOrder: requireExactInteger(observation['runOrder'], authority.runOrder, 'build action run order'),
    version: requireExactString(observation['version'], '1', 'CodePipeline CodeBuild action version'),
  });
}

/**
 * @param {unknown} input
 * @returns {Readonly<{pipelineName: string, stages: readonly Readonly<{
 *   actionName: string;
 *   category: string;
 *   inputArtifacts: readonly string[];
 *   outputArtifacts: readonly string[];
 *   owner: string;
 *   primarySource: string | null;
 *   projectName: string | null;
 *   projectRoleName: string | null;
 *   provider: string;
 *   runOrder: number;
 *   stageName: string;
 *   version: string;
 * }>[]}>}
 */
export function admitFoundationPlanComposition(input) {
  const request = safeSnapshotExactRecord(
    input,
    ['observation', 'targetKey'],
    'Foundation saved-plan composition input',
  );
  const target = resolveInventoryTarget(request['targetKey']);
  const observation = safeSnapshotExactRecord(
    request['observation'],
    ['pipelineName', 'stages'],
    'Foundation saved-plan composition',
  );
  const pipelineName = requirePatternString(
    observation['pipelineName'],
    PROJECT_NAME_PATTERN,
    'Foundation pipeline name',
    150,
  );
  const stages = safeSnapshotDenseArray(observation['stages'], 'Foundation pipeline actions').map((stage, index) =>
    admitFoundationAction(stage, index),
  );
  const expected = buildFoundationPlanComposition(target);
  if (pipelineName !== expected.pipelineName || JSON.stringify(stages) !== JSON.stringify(expected.stages)) {
    throw new Error('Foundation saved-plan composition does not match its exact action authority.');
  }
  return Object.freeze({ pipelineName, stages: Object.freeze(stages) });
}

/**
 * @param {unknown} input
 * @returns {Readonly<{
 *   accountId: string;
 *   buildId: string;
 *   buildspecPath: string;
 *   callerArn: string;
 *   computeType: string;
 *   configuredManagedImage: string;
 *   environmentType: string;
 *   privilegedMode: boolean;
 *   projectArn: string;
 *   projectName: string;
 *   region: string;
 *   resolvedSourceSha: string;
 *   runningManagedImage: string;
 *   serviceRoleArn: string;
 * }>}
 */
export function admitBuildRuntimePosture(input) {
  const request = safeSnapshotExactRecord(input, ['authority', 'observation'], 'build runtime posture input');
  const authority = safeSnapshotExactRecord(request['authority'], ['project', 'sourceSha'], 'build runtime authority');
  const projectAuthority = admitProjectAuthority(authority['project']);
  const expectedSourceSha = parseGitCommitSha(authority['sourceSha'], 'expected source SHA');
  const observation = safeSnapshotExactRecord(
    request['observation'],
    ['accountId', 'buildId', 'callerArn', 'project', 'region', 'resolvedSourceSha', 'runningManagedImage'],
    'build runtime observation',
  );
  const project = admitSourcePathBuildProject({ authority: projectAuthority, observation: observation['project'] });
  const accountId = requireExactString(observation['accountId'], projectAuthority.accountId, 'build account ID');
  const region = requireExactString(observation['region'], projectAuthority.region, 'build region');
  const resolvedSourceSha = requireExactString(
    observation['resolvedSourceSha'],
    expectedSourceSha,
    'build resolved source SHA',
  );
  const callerArn = requireBoundedString(observation['callerArn'], 'build caller ARN', 2048);
  const expectedCallerPrefix = `arn:${projectAuthority.partition}:sts::${accountId}:assumed-role/${projectAuthority.roleName}/`;
  const callerSession = callerArn.slice(expectedCallerPrefix.length);
  if (!callerArn.startsWith(expectedCallerPrefix) || !/^[A-Za-z0-9+=,.@_-]{2,64}$/u.test(callerSession)) {
    throw new Error('build caller ARN does not match the accepted project role.');
  }
  const buildId = requireBoundedString(observation['buildId'], 'CodeBuild build ID', 512);
  const expectedBuildIdPattern = new RegExp(
    `^${escapeRegExp(projectAuthority.projectName)}:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`,
    'u',
  );
  if (!expectedBuildIdPattern.test(buildId)) {
    throw new Error('CodeBuild build ID does not match the accepted project.');
  }
  const runningManagedImage = requireManagedCodeBuildImageIdentifier(
    observation['runningManagedImage'],
    'running managed image',
  );

  return Object.freeze({
    accountId,
    buildId,
    buildspecPath: project['buildspecPath'],
    callerArn,
    computeType: project['computeType'],
    environmentType: project['environmentType'],
    configuredManagedImage: project['configuredManagedImage'],
    privilegedMode: project['privilegedMode'],
    projectArn: project['projectArn'],
    projectName: project['projectName'],
    region,
    resolvedSourceSha,
    runningManagedImage,
    serviceRoleArn: project['serviceRoleArn'],
  });
}

/**
 * @param {unknown} input
 * @returns {Readonly<{privilegedProjectNames: readonly string[]} >}
 */
export function assertPrivilegedProjectInventory(input) {
  const request = safeSnapshotExactRecord(input, ['projects', 'targetKey'], 'privileged project inventory input');
  const target = resolveInventoryTarget(request['targetKey']);
  const toolchain = resolveDeploymentLaneAuthority(target, 'toolchain');
  const prover = resolveDeploymentLaneAuthority(target, 'prover');
  const privilegedProjectNames = Object.freeze([
    requirePatternString(
      toolchain.names.toolchainCandidateProject,
      PROJECT_NAME_PATTERN,
      'Toolchain candidate project name',
      150,
    ),
    requirePatternString(
      prover.names.proverCandidateProject,
      PROJECT_NAME_PATTERN,
      'Prover candidate project name',
      150,
    ),
  ]);

  const projectValues = safeSnapshotDenseArray(request['projects'], 'CodeBuild project privilege inventory');
  const seen = new Set();
  const observedPrivileged = [];
  for (let index = 0; index < projectValues.length; index += 1) {
    const project = safeSnapshotExactRecord(
      projectValues[index],
      ['privilegedMode', 'projectName'],
      `CodeBuild project privilege inventory entry ${index}`,
    );
    const projectName = requirePatternString(
      project['projectName'],
      PROJECT_NAME_PATTERN,
      'CodeBuild project name',
      150,
    );
    if (seen.has(projectName)) {
      throw new Error('CodeBuild project privilege inventory contains a duplicate project.');
    }
    seen.add(projectName);
    if (typeof project['privilegedMode'] !== 'boolean') {
      throw new Error('CodeBuild project privileged mode must be a boolean.');
    }
    if (project['privilegedMode']) {
      observedPrivileged.push(projectName);
    }
  }
  const expected = [...privilegedProjectNames].sort();
  const observed = observedPrivileged.sort();
  assertExactArray(observed, expected, 'privileged CodeBuild projects');
  for (const projectName of expected) {
    if (!seen.has(projectName)) {
      throw new Error('every privileged candidate project must be present in the project inventory.');
    }
  }
  return Object.freeze({ privilegedProjectNames: Object.freeze(observed) });
}

/**
 * @param {unknown} input
 * @returns {Readonly<{family: CodeBuildProjectFamily, projects: readonly CodeBuildProjectMembership[]}>}
 */
export function admitCodeBuildProjectFamily(input) {
  const request = safeSnapshotExactRecord(input, ['family', 'projects', 'targetKey'], 'CodeBuild project family input');
  const target = resolveInventoryTarget(request['targetKey']);
  const family = requireCodeBuildProjectFamily(request['family']);
  const expected = buildExpectedCodeBuildProjectMembership(target).filter((entry) => entry.family === family);
  if (expected.length === 0) {
    throw new Error('CodeBuild project family is not authorized for the selected target.');
  }
  const projects = safeSnapshotDenseArray(request['projects'], `${family} CodeBuild projects`).map((entry, index) =>
    admitCodeBuildProjectMembership(entry, `${family} CodeBuild project ${index}`),
  );
  assertExactProjectMembership(projects, expected, `${family} CodeBuild projects`);
  return Object.freeze({ family, projects: Object.freeze(projects) });
}

/**
 * @param {unknown} input
 * @returns {readonly CodeBuildProjectMembership[]}
 */
export function buildCodeBuildProjectInventory(input) {
  const request = safeSnapshotExactRecord(input, ['families', 'targetKey'], 'CodeBuild project inventory input');
  const target = resolveInventoryTarget(request['targetKey']);
  const targetKey = target.targetKey;
  const expectedFamilies = CODEBUILD_PROJECT_FAMILIES.filter(
    (family) => family !== 'static-fast' || target.environmentTier === 'development',
  );
  const families = safeSnapshotDenseArray(request['families'], 'CodeBuild project families');
  if (families.length !== expectedFamilies.length) {
    throw new Error('CodeBuild project inventory must contain every exact family.');
  }
  const inventory = [];
  for (let index = 0; index < families.length; index += 1) {
    const familyRecord = safeSnapshotExactRecord(
      families[index],
      ['family', 'projects'],
      `CodeBuild project family ${index}`,
    );
    const expectedFamily = expectedFamilies[index];
    if (expectedFamily === undefined) {
      throw new Error('CodeBuild project family inventory is inconsistent.');
    }
    requireExactString(familyRecord['family'], expectedFamily, `CodeBuild project family ${index}`);
    const admitted = admitCodeBuildProjectFamily({
      family: expectedFamily,
      projects: familyRecord['projects'],
      targetKey,
    });
    inventory.push(...admitted.projects);
  }
  const expected = buildExpectedCodeBuildProjectMembership(target);
  assertExactProjectMembership(inventory, expected, 'CodeBuild project inventory');
  if (new Set(inventory.map(({ projectName }) => projectName)).size !== inventory.length) {
    throw new Error('CodeBuild project inventory must contain unique project names.');
  }
  return Object.freeze(inventory);
}

/** @param {unknown} value @returns {ReturnType<typeof resolveAllowedDeploymentTarget>} */
function resolveInventoryTarget(value) {
  if (typeof value !== 'string') throw new Error('deployment target must be a string.');
  return resolveAllowedDeploymentTarget(value);
}

/**
 * @param {ReturnType<typeof resolveAllowedDeploymentTarget>} target
 * @returns {readonly CodeBuildProjectMembership[]}
 */
function buildExpectedCodeBuildProjectMembership(target) {
  const bootstrap = resolveDeploymentLaneAuthority(target, 'bootstrap').names;
  const foundation = resolveDeploymentLaneAuthority(target, 'foundation').names;
  const app = resolveDeploymentLaneAuthority(target, 'app').names;
  const staticFast =
    target.environmentTier === 'development' ? resolveDeploymentLaneAuthority(target, 'static-fast').names : null;
  return Object.freeze([
    projectMembership(bootstrap.terraformPlanProject, 'bootstrap', 'pipeline-source-path', false),
    projectMembership(bootstrap.terraformApplyProject, 'bootstrap', 'pipeline-source-path', false),
    projectMembership(bootstrap.smokeProject, 'bootstrap', 'pipeline-source-path', false),
    projectMembership(foundation.terraformPlanProject, 'foundation', 'pipeline-source-path', false),
    projectMembership(foundation.terraformApplyProject, 'foundation', 'pipeline-source-path', false),
    projectMembership(foundation.smokeProject, 'foundation', 'pipeline-source-path', false),
    projectMembership(foundation.foundationSigningResolverProject, 'foundation', 'pipeline-source-path', false),
    projectMembership(app.appSignaturePreflightPlanProject, 'image-signature-preflight', 'pipeline-source-path', false),
    projectMembership(
      app.appSignaturePreflightApplyProject,
      'image-signature-preflight',
      'pipeline-source-path',
      false,
    ),
    projectMembership(
      app.appSignaturePreflightInvokeProject,
      'image-signature-preflight',
      'pipeline-source-path',
      false,
    ),
    projectMembership(app.appExecutionAuthorityProject, 'app', 'pipeline-source-path', false),
    projectMembership(app.terraformPlanProject, 'app', 'pipeline-source-path', false),
    projectMembership(app.terraformApplyProject, 'app', 'pipeline-source-path', false),
    projectMembership(app.appStaticDeployProject, 'app', 'pipeline-source-path', false),
    projectMembership(app.smokeProject, 'app', 'pipeline-source-path', false),
    projectMembership(app.appDeploymentStatusPublisherProject, 'app', 'pipeline-source-path', false),
    ...(staticFast === null
      ? []
      : [
          projectMembership(staticFast.appStaticFastGateProject, 'static-fast', 'pipeline-source-path', false),
          projectMembership(staticFast.appStaticFastDeployProject, 'static-fast', 'pipeline-source-path', false),
          projectMembership(staticFast.appStaticFastSmokeProject, 'static-fast', 'pipeline-source-path', false),
        ]),
    projectMembership(bootstrap.toolchainCandidateProject, 'release', 'pipeline-source-path', true),
    projectMembership(bootstrap.toolchainPointerProject, 'release', 'pipeline-source-path', false),
    projectMembership(bootstrap.proverToolchainResolverProject, 'release', 'pipeline-source-path', false),
    projectMembership(bootstrap.proverCandidateProject, 'release', 'pipeline-source-path', true),
    projectMembership(bootstrap.proverPointerProject, 'release', 'pipeline-source-path', false),
    projectMembership(bootstrap.terraformDriftBootstrapProject, 'terraform-drift', 'configured-source-path', false),
    projectMembership(bootstrap.terraformDriftFoundationProject, 'terraform-drift', 'configured-source-path', false),
    projectMembership(bootstrap.terraformDriftAppProject, 'terraform-drift', 'configured-source-path', false),
  ]);
}

/**
 * @param {string} projectName
 * @param {CodeBuildProjectFamily} family
 * @param {ExecutionCodeAuthority} executionCodeAuthority
 * @param {boolean} privilegedMode
 * @returns {CodeBuildProjectMembership}
 */
function projectMembership(projectName, family, executionCodeAuthority, privilegedMode) {
  return Object.freeze({ executionCodeAuthority, family, privilegedMode, projectName });
}

/** @param {unknown} value @returns {CodeBuildProjectFamily} */
function requireCodeBuildProjectFamily(value) {
  if (typeof value !== 'string' || !CODEBUILD_PROJECT_FAMILIES.includes(value)) {
    throw new Error('CodeBuild project family is invalid.');
  }
  return /** @type {CodeBuildProjectFamily} */ (value);
}

/** @param {unknown} value @returns {ExecutionCodeAuthority} */
function requireExecutionCodeAuthority(value) {
  if (typeof value !== 'string' || !CODEBUILD_EXECUTION_CODE_AUTHORITIES.includes(value)) {
    throw new Error('CodeBuild execution-code authority is invalid.');
  }
  return /** @type {ExecutionCodeAuthority} */ (value);
}

/** @param {unknown} value @param {string} label @returns {CodeBuildProjectMembership} */
function admitCodeBuildProjectMembership(value, label) {
  const record = safeSnapshotExactRecord(
    value,
    ['executionCodeAuthority', 'family', 'privilegedMode', 'projectName'],
    label,
  );
  if (typeof record['privilegedMode'] !== 'boolean') {
    throw new Error(`${label} privileged mode must be a boolean.`);
  }
  return projectMembership(
    requirePatternString(record['projectName'], PROJECT_NAME_PATTERN, `${label} name`, 150),
    requireCodeBuildProjectFamily(record['family']),
    requireExecutionCodeAuthority(record['executionCodeAuthority']),
    record['privilegedMode'],
  );
}

/**
 * @param {readonly CodeBuildProjectMembership[]} observed
 * @param {readonly CodeBuildProjectMembership[]} expected
 * @param {string} label
 * @returns {void}
 */
function assertExactProjectMembership(observed, expected, label) {
  if (observed.length !== expected.length) {
    throw new Error(`${label} do not match exact target membership.`);
  }
  for (let index = 0; index < expected.length; index += 1) {
    const actual = observed[index];
    const authority = expected[index];
    if (
      actual === undefined ||
      authority === undefined ||
      actual.executionCodeAuthority !== authority.executionCodeAuthority ||
      actual.family !== authority.family ||
      actual.privilegedMode !== authority.privilegedMode ||
      actual.projectName !== authority.projectName
    ) {
      throw new Error(`${label} do not match exact target membership.`);
    }
  }
}

/**
 * @typedef {Readonly<{
 *   actionName: string;
 *   category: string;
 *   inputArtifacts: readonly string[];
 *   outputArtifacts: readonly string[];
 *   owner: string;
 *   primarySource: string | null;
 *   projectName: string | null;
 *   projectRoleName: string | null;
 *   provider: string;
 *   runOrder: number;
 *   stageName: string;
 *   version: string;
 * }>} FoundationPipelineAction
 */

/**
 * @param {ReturnType<typeof resolveAllowedDeploymentTarget>} target
 * @returns {Readonly<{pipelineName: string, stages: readonly FoundationPipelineAction[]}>}
 */
function buildFoundationPlanComposition(target) {
  const foundation = resolveDeploymentLaneAuthority(target, 'foundation').names;
  return Object.freeze({
    pipelineName: foundation.pipeline,
    stages: Object.freeze([
      foundationAction(
        target.sourceAction,
        target.sourceAction,
        'Source',
        'CodeStarSourceConnection',
        [],
        ['SourceOutput'],
      ),
      foundationAction(
        'TerraformPlan',
        'PlanFoundationState',
        'Build',
        'CodeBuild',
        ['SourceOutput'],
        ['PlanOutput'],
        foundation.terraformPlanProject,
        'SourceOutput',
        foundation.terraformPlanRole,
      ),
      foundationAction('ManualApproval', 'ApproveFoundationApply', 'Approval', 'Manual', [], []),
      foundationAction(
        'TerraformApply',
        'ApplyReviewedFoundationPlan',
        'Build',
        'CodeBuild',
        ['SourceOutput', 'PlanOutput'],
        ['ApplyOutput'],
        foundation.terraformApplyProject,
        'SourceOutput',
        foundation.terraformApplyRole,
      ),
      foundationAction(
        'PostApplySmoke',
        'FoundationStateAbsenceOfAppRuntime',
        'Build',
        'CodeBuild',
        ['SourceOutput', 'PlanOutput', 'ApplyOutput'],
        ['FoundationSmokeOutput'],
        foundation.smokeProject,
        'SourceOutput',
        foundation.terraformSmokeRole,
      ),
    ]),
  });
}

/**
 * @param {string} stageName
 * @param {string} actionName
 * @param {'Approval' | 'Build' | 'Source'} category
 * @param {'CodeBuild' | 'CodeStarSourceConnection' | 'Manual'} provider
 * @param {readonly string[]} inputArtifacts
 * @param {readonly string[]} outputArtifacts
 * @param {string | null} [projectName]
 * @param {string | null} [primarySource]
 * @param {string | null} [projectRoleName]
 * @returns {FoundationPipelineAction}
 */
function foundationAction(
  stageName,
  actionName,
  category,
  provider,
  inputArtifacts,
  outputArtifacts,
  projectName = null,
  primarySource = null,
  projectRoleName = null,
) {
  return Object.freeze({
    actionName,
    category,
    inputArtifacts: Object.freeze([...inputArtifacts]),
    outputArtifacts: Object.freeze([...outputArtifacts]),
    owner: 'AWS',
    primarySource,
    projectName,
    projectRoleName,
    provider,
    runOrder: 1,
    stageName,
    version: '1',
  });
}

/** @param {unknown} value @param {number} index @returns {FoundationPipelineAction} */
function admitFoundationAction(value, index) {
  const record = safeSnapshotExactRecord(
    value,
    [
      'actionName',
      'category',
      'inputArtifacts',
      'outputArtifacts',
      'owner',
      'primarySource',
      'projectName',
      'projectRoleName',
      'provider',
      'runOrder',
      'stageName',
      'version',
    ],
    `Foundation pipeline action ${index}`,
  );
  const projectName = requireNullablePatternString(
    record['projectName'],
    PROJECT_NAME_PATTERN,
    `Foundation pipeline action ${index} project name`,
    150,
  );
  const projectRoleName = requireNullablePatternString(
    record['projectRoleName'],
    ROLE_NAME_PATTERN,
    `Foundation pipeline action ${index} project role`,
    64,
  );
  const primarySource = requireNullablePatternString(
    record['primarySource'],
    /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/u,
    `Foundation pipeline action ${index} primary source`,
    100,
  );
  return Object.freeze({
    actionName: requireBoundedString(record['actionName'], `Foundation pipeline action ${index} name`, 100),
    category: requireBoundedString(record['category'], `Foundation pipeline action ${index} category`, 32),
    inputArtifacts: admitStringArray(record['inputArtifacts'], `Foundation pipeline action ${index} inputs`),
    outputArtifacts: admitStringArray(record['outputArtifacts'], `Foundation pipeline action ${index} outputs`),
    owner: requireExactString(record['owner'], 'AWS', `Foundation pipeline action ${index} owner`),
    primarySource,
    projectName,
    projectRoleName,
    provider: requireBoundedString(record['provider'], `Foundation pipeline action ${index} provider`, 64),
    runOrder: requirePositiveInteger(record['runOrder'], `Foundation pipeline action ${index} run order`),
    stageName: requireBoundedString(record['stageName'], `Foundation pipeline action ${index} stage`, 100),
    version: requireExactString(record['version'], '1', `Foundation pipeline action ${index} external version`),
  });
}

/**
 * @typedef {Readonly<{
 *   accountId: string;
 *   authResourceArn: string;
 *   buildspecPath: string;
 *   computeType: string;
 *   configuredSourceSha: string;
 *   environmentType: string;
 *   partition: 'aws';
 *   privilegedMode: false;
 *   projectName: string;
 *   region: string;
 *   repositoryUrl: string;
 *   roleName: string;
 *   sourceType: 'GITHUB';
 * }>} ConfiguredSourceProjectAuthority
 */

/** @param {unknown} value @returns {ConfiguredSourceProjectAuthority} */
function admitConfiguredSourceProjectAuthority(value) {
  const authority = safeSnapshotExactRecord(
    value,
    [
      'accountId',
      'authResourceArn',
      'buildspecPath',
      'computeType',
      'configuredSourceSha',
      'environmentType',
      'partition',
      'privilegedMode',
      'projectName',
      'region',
      'repositoryUrl',
      'roleName',
      'sourceType',
    ],
    'configured-source build project authority',
  );
  requireExactString(authority['partition'], 'aws', 'project partition');
  const accountId = requirePatternString(authority['accountId'], ACCOUNT_ID_PATTERN, 'project account ID', 12);
  const region = requirePatternString(authority['region'], REGION_PATTERN, 'project region', 32);
  const projectName = requirePatternString(authority['projectName'], PROJECT_NAME_PATTERN, 'project name', 150);
  const roleName = requirePatternString(authority['roleName'], ROLE_NAME_PATTERN, 'project role name', 64);
  const buildspecPath = requireCanonicalBuildspecPath(authority['buildspecPath'], 'project buildspec path');
  const computeType = requirePatternString(
    authority['computeType'],
    /^[A-Z][A-Z0-9_]{1,63}$/u,
    'project compute type',
    64,
  );
  const environmentType = requirePatternString(
    authority['environmentType'],
    /^[A-Z][A-Z0-9_]{1,63}$/u,
    'project environment type',
    64,
  );
  requireExactBoolean(authority['privilegedMode'], false, 'project privileged mode');
  requireExactString(authority['sourceType'], 'GITHUB', 'project source type');
  const repositoryUrl = requirePatternString(
    authority['repositoryUrl'],
    /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u,
    'project source repository',
    512,
  );
  const authResourceArn = requirePatternString(
    authority['authResourceArn'],
    new RegExp(
      `^arn:aws:codeconnections:${escapeRegExp(region)}:${escapeRegExp(accountId)}:connection/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`,
      'u',
    ),
    'project source auth resource ARN',
    256,
  );
  return Object.freeze({
    accountId,
    authResourceArn,
    buildspecPath,
    computeType,
    configuredSourceSha: parseGitCommitSha(authority['configuredSourceSha'], 'configured source SHA'),
    environmentType,
    partition: 'aws',
    privilegedMode: false,
    projectName,
    region,
    repositoryUrl,
    roleName,
    sourceType: 'GITHUB',
  });
}

/** @param {unknown} value @returns {SourcePathProjectAuthority} */
function admitProjectAuthority(value) {
  const authority = safeSnapshotExactRecord(
    value,
    [
      'accountId',
      'buildspecPath',
      'computeType',
      'environmentType',
      'partition',
      'privilegedMode',
      'projectName',
      'region',
      'roleName',
      'sourceType',
    ],
    'source-path build project authority',
  );
  requireExactString(authority['partition'], 'aws', 'project partition');
  const partition = 'aws';
  const accountId = requirePatternString(authority['accountId'], ACCOUNT_ID_PATTERN, 'project account ID', 12);
  const region = requirePatternString(authority['region'], REGION_PATTERN, 'project region', 32);
  const projectName = requirePatternString(authority['projectName'], PROJECT_NAME_PATTERN, 'project name', 150);
  const roleName = requirePatternString(authority['roleName'], ROLE_NAME_PATTERN, 'project role name', 64);
  const buildspecPath = requireCanonicalBuildspecPath(authority['buildspecPath'], 'project buildspec path');
  const computeType = requirePatternString(
    authority['computeType'],
    /^[A-Z][A-Z0-9_]{1,63}$/u,
    'project compute type',
    64,
  );
  const environmentType = requirePatternString(
    authority['environmentType'],
    /^[A-Z][A-Z0-9_]{1,63}$/u,
    'project environment type',
    64,
  );
  if (typeof authority['privilegedMode'] !== 'boolean') {
    throw new Error('project privileged mode must be a boolean.');
  }
  requireExactString(authority['sourceType'], 'CODEPIPELINE', 'project source type');
  return Object.freeze({
    accountId,
    buildspecPath,
    computeType,
    environmentType,
    partition,
    privilegedMode: authority['privilegedMode'],
    projectName,
    region,
    roleName,
    sourceType: 'CODEPIPELINE',
  });
}

/** @param {unknown} value @returns {SourcePathBuildActionAuthority} */
function admitActionAuthority(value) {
  const authority = safeSnapshotExactRecord(
    value,
    [
      'actionName',
      'environmentVariables',
      'inputArtifacts',
      'outputArtifacts',
      'primarySource',
      'projectName',
      'region',
      'runOrder',
    ],
    'source-path build action authority',
  );
  const inputArtifacts = admitStringArray(authority['inputArtifacts'], 'expected build action input artifacts');
  const outputArtifacts = admitStringArray(authority['outputArtifacts'], 'expected build action output artifacts');
  const primarySource = requireBoundedString(authority['primarySource'], 'expected build action primary source', 100);
  if (!inputArtifacts.includes(primarySource)) {
    throw new Error('expected build action primary source must be one of its input artifacts.');
  }
  return Object.freeze({
    actionName: requireBoundedString(authority['actionName'], 'expected build action name', 100),
    environmentVariables: admitActionEnvironmentVariables(
      authority['environmentVariables'],
      'expected build action environment variables',
    ),
    inputArtifacts,
    outputArtifacts,
    primarySource,
    projectName: requirePatternString(authority['projectName'], PROJECT_NAME_PATTERN, 'expected project name', 150),
    region: requirePatternString(authority['region'], REGION_PATTERN, 'expected build action region', 32),
    runOrder: requirePositiveInteger(authority['runOrder'], 'expected build action run order'),
  });
}

/** @param {unknown} value @param {string} label @returns {readonly string[]} */
function admitStringArray(value, label) {
  const entries = safeSnapshotDenseArray(value, label).map((entry, index) =>
    requireBoundedString(entry, `${label} entry ${index}`, 100),
  );
  if (new Set(entries).size !== entries.length) {
    throw new Error(`${label} must contain unique values.`);
  }
  return Object.freeze(entries);
}

/** @param {unknown} value @param {string} label @returns {readonly unknown[]} */
function admitEmptyArray(value, label) {
  const entries = safeSnapshotDenseArray(value, label);
  if (entries.length !== 0) {
    throw new Error(`${label} must be empty.`);
  }
  return entries;
}

/** @param {unknown} value @param {string} label @returns {readonly BuildActionEnvironmentVariable[]} */
function admitActionEnvironmentVariables(value, label) {
  const entries = safeSnapshotDenseArray(value, label).map((entry, index) => {
    const variable = safeSnapshotExactRecord(entry, ['name', 'type', 'value'], `${label} entry ${index}`);
    const type = requireBoundedString(variable['type'], `${label} entry ${index} type`, 32);
    if (!['PARAMETER_STORE', 'PLAINTEXT', 'SECRETS_MANAGER'].includes(type)) {
      throw new Error(`${label} entry ${index} type is not supported.`);
    }
    return Object.freeze({
      name: requireEnvironmentVariableName(variable['name'], `${label} entry ${index} name`),
      type,
      value: requireBoundedString(variable['value'], `${label} entry ${index} value`, 4096),
    });
  });
  const names = entries.map(({ name }) => name);
  if (new Set(names).size !== names.length) {
    throw new Error(`${label} must contain unique names.`);
  }
  return Object.freeze(entries);
}

/** @param {unknown} value @param {readonly BuildActionEnvironmentVariable[]} expected @returns {readonly BuildActionEnvironmentVariable[]} */
function admitActionEnvironmentJson(value, expected) {
  const body = requireBoundedString(value, 'build action environment variable JSON', 1_000);
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch (error) {
    throw new Error('build action environment variable JSON is invalid.', { cause: error });
  }
  const admitted = admitActionEnvironmentVariables(parsed, 'build action environment variables');
  if (JSON.stringify(admitted) !== JSON.stringify(expected)) {
    throw new Error('build action environment variables do not match their authority.');
  }
  return admitted;
}

/** @param {unknown} value @param {string} label @returns {string} */
function requireEnvironmentVariableName(value, label) {
  const name = requirePatternString(value, ENVIRONMENT_VARIABLE_NAME_PATTERN, label, 128);
  if (name.startsWith('AWS_') || name.startsWith('CODEBUILD_')) {
    throw new Error(`${label} uses a reserved prefix.`);
  }
  return name;
}

/** @param {unknown} value @param {string} expected @param {string} label @returns {string} */
function requireExactString(value, expected, label) {
  const admitted = requireBoundedString(value, label, Math.max(expected.length, 1));
  if (admitted !== expected) {
    throw new Error(`${label} does not match its authority.`);
  }
  return admitted;
}

/** @param {unknown} value @param {boolean} expected @param {string} label @returns {boolean} */
function requireExactBoolean(value, expected, label) {
  if (typeof value !== 'boolean' || value !== expected) {
    throw new Error(`${label} does not match its authority.`);
  }
  return value;
}

/** @param {unknown} value @param {number} expected @param {string} label @returns {number} */
function requireExactInteger(value, expected, label) {
  const admitted = requirePositiveInteger(value, label);
  if (admitted !== expected) {
    throw new Error(`${label} does not match its authority.`);
  }
  return admitted;
}

/** @param {unknown} value @param {number} expected @param {string} label @returns {number} */
function requireExactNonnegativeInteger(value, expected, label) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value !== expected) {
    throw new Error(`${label} does not match its authority.`);
  }
  return value;
}

/** @param {unknown} value @param {string} label @returns {number} */
function requirePositiveInteger(value, label) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

/** @param {unknown} value @param {RegExp} pattern @param {string} label @param {number} maximumLength @returns {string} */
function requirePatternString(value, pattern, label, maximumLength) {
  const admitted = requireBoundedString(value, label, maximumLength);
  if (!pattern.test(admitted)) {
    throw new Error(`${label} is invalid.`);
  }
  return admitted;
}

/**
 * @param {unknown} value
 * @param {RegExp} pattern
 * @param {string} label
 * @param {number} maximumLength
 * @returns {string | null}
 */
function requireNullablePatternString(value, pattern, label, maximumLength) {
  if (value === null) {
    return null;
  }
  return requirePatternString(value, pattern, label, maximumLength);
}

/** @param {unknown} value @param {string} label @returns {string} */
function requireCanonicalBuildspecPath(value, label) {
  const buildspecPath = requirePatternString(value, BUILDSPEC_PATH_PATTERN, label, 512);
  const segments = buildspecPath.split('/');
  if (segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')) {
    throw new Error(`${label} must be canonical.`);
  }
  return buildspecPath;
}

/** @param {unknown} value @param {string} label @param {number} maximumLength @returns {string} */
function requireBoundedString(value, label, maximumLength) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maximumLength ||
    [...value].some((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint !== undefined && (codePoint <= 31 || codePoint === 127);
    })
  ) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

/** @param {unknown} value @param {string} label @returns {string} */
function requireManagedCodeBuildImageIdentifier(value, label) {
  const image = requireBoundedString(value, label, 512);
  if (!isManagedCodeBuildImageIdentifier(image)) {
    throw new Error(`${label} is not an admitted AWS-managed CodeBuild image identifier.`);
  }
  return image;
}

/** @param {readonly string[]} observed @param {readonly string[]} expected @param {string} label @returns {void} */
function assertExactArray(observed, expected, label) {
  if (observed.length !== expected.length || observed.some((entry, index) => entry !== expected[index])) {
    throw new Error(`${label} do not match their authority.`);
  }
}

/** @param {unknown} value @param {readonly string[]} expectedKeys @param {string} label */
function safeSnapshotExactRecord(value, expectedKeys, label) {
  rejectProxy(value, label);
  return snapshotExactRecord(value, expectedKeys, label);
}

/** @param {unknown} value @param {string} label */
function safeSnapshotDenseArray(value, label) {
  rejectProxy(value, label);
  return snapshotDenseArray(value, label);
}

/** @param {unknown} value @param {string} label @returns {void} */
function rejectProxy(value, label) {
  if (typeof value === 'object' && value !== null && utilTypes.isProxy(value)) {
    throw new Error(`${label} must not be a Proxy.`);
  }
}

/** @param {string} value @returns {string} */
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

/** @param {'ForAnyValue:StringNotEquals' | 'Null'} test @param {string} variable @param {readonly string[]} values */
function freezeCondition(test, variable, values) {
  return Object.freeze({ test, values, variable });
}

/** @param {Readonly<{test: 'ForAnyValue:StringNotEquals' | 'Null', values: readonly string[], variable: string}>} condition @param {readonly string[]} resources */
function freezeDenyStatement(condition, resources) {
  return Object.freeze({
    action: 'codebuild:StartBuild',
    condition,
    effect: 'Deny',
    resources,
  });
}

/**
 * @typedef {Readonly<{
 *   evidenceType: 'bootstrap-codebuild-log-group-inventory';
 *   targetKey: 'stark-prod/main';
 *   stateIdentity: string;
 *   backendKey: string;
 *   controlSourceSha: string;
 *   frameworkSourceSha: string;
 *   acceptedPlanChecksum: string;
 *   pipelineExecutionId: string;
 *   inventorySha256: string;
 *   stateJsonSha256: string;
 *   expectedProjectCount: number;
 *   verifiedProjectCount: number;
 *   unexpectedLogGroupCount: 0;
 *   remoteIdentityMismatchCount: 0;
 *   retentionMismatchCount: 0;
 *   projectLoggingMismatchCount: 0;
 * }>} BootstrapLogGroupInventoryEvidence
 */

const EVIDENCE_KEYS = [
  'acceptedPlanChecksum',
  'backendKey',
  'controlSourceSha',
  'evidenceType',
  'expectedProjectCount',
  'frameworkSourceSha',
  'inventorySha256',
  'pipelineExecutionId',
  'projectLoggingMismatchCount',
  'remoteIdentityMismatchCount',
  'retentionMismatchCount',
  'stateIdentity',
  'stateJsonSha256',
  'targetKey',
  'unexpectedLogGroupCount',
  'verifiedProjectCount',
];
const MODULE_BY_FAMILY = Object.freeze({
  bootstrap: 'bootstrap_pipeline_codebuild_log_groups',
  foundation: 'foundation_pipeline_codebuild_log_groups',
  release: 'foundation_pipeline_codebuild_log_groups',
  app: 'app_pipeline_codebuild_log_groups',
  'image-signature-preflight': 'app_pipeline_codebuild_log_groups',
  'terraform-drift': 'terraform_drift_codebuild_log_groups',
});

/** @param {unknown} value @param {string} label @returns {Readonly<Record<string, unknown>>} */
function record(value, label) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be a record.`);
  }
  return /** @type {Readonly<Record<string, unknown>>} */ (value);
}

/** @param {unknown} contextValue */
function productionBootstrapContext(contextValue) {
  const context = parseDeploymentLaneContext(snapshotDataTree(contextValue, 'Bootstrap log-group context'));
  const target = resolveAllowedDeploymentTarget(`${context.target.accountLabel}/${context.target.environmentId}`);
  const lane = resolveDeploymentLaneAuthority(target, 'bootstrap');
  if (
    target.targetKey !== 'stark-prod/main' ||
    context.root.lane !== 'bootstrap' ||
    context.root.stateIdentity !== lane.stateIdentity
  ) {
    throw new Error('Bootstrap log-group inventory requires the production Bootstrap context.');
  }
  return { context, target };
}

/** @param {unknown} contextValue */
export function resolveBootstrapLogGroupInventory(contextValue) {
  const { target } = productionBootstrapContext(contextValue);
  const inventory = buildExpectedCodeBuildProjectMembership(target).map(({ family, projectName }) => {
    if (family === 'static-fast') throw new Error('Production Bootstrap cannot own static-fast log groups.');
    const moduleName = MODULE_BY_FAMILY[family];
    return {
      address: `module.${moduleName}.aws_cloudwatch_log_group.this[${JSON.stringify(projectName)}]`,
      moduleAddress: `module.${moduleName}`,
      projectName,
      remoteId: `/aws/codebuild/${projectName}`,
      // The reviewed main policy in Bootstrap storage_retention.tf is 365 days for all four modules.
      retentionInDays: 365,
    };
  });
  return deepFreeze(
    inventory.sort((left, right) => (left.address < right.address ? -1 : left.address > right.address ? 1 : 0)),
  );
}

/** @param {unknown} moduleValue @returns {Readonly<Record<string, unknown>>[]} */
function collectResources(moduleValue) {
  const module = record(moduleValue, 'Terraform state module');
  const resources =
    module['resources'] === undefined ? [] : snapshotDenseArray(module['resources'], 'Terraform state resources');
  const children =
    module['child_modules'] === undefined
      ? []
      : snapshotDenseArray(module['child_modules'], 'Terraform state child modules');
  return [
    ...resources.map((resource) => record(resource, 'Terraform state resource')),
    ...children.flatMap((child) => collectResources(child)),
  ];
}

/**
 * @param {unknown} value
 * @param {unknown} contextValue
 * @param {unknown} acceptedPlanChecksumValue
 * @param {unknown} pipelineExecutionIdValue
 * @returns {BootstrapLogGroupInventoryEvidence}
 */
export function admitBootstrapLogGroupInventoryEvidence(
  value,
  contextValue,
  acceptedPlanChecksumValue,
  pipelineExecutionIdValue,
) {
  const { context } = productionBootstrapContext(contextValue);
  const acceptedPlanChecksum = parseSha256(acceptedPlanChecksumValue, 'Bootstrap log-group accepted plan checksum');
  const pipelineExecutionId = requireGroupedLowercaseUuid(
    pipelineExecutionIdValue,
    'Bootstrap log-group pipeline execution ID',
  );
  const evidence = snapshotExactRecord(value, EVIDENCE_KEYS, 'Bootstrap log-group inventory evidence');
  const inventory = resolveBootstrapLogGroupInventory(context);
  const expected = {
    evidenceType: 'bootstrap-codebuild-log-group-inventory',
    targetKey: 'stark-prod/main',
    stateIdentity: context.root.stateIdentity,
    backendKey: context.root.backendKey,
    controlSourceSha: context.source.requestedControlSourceSha,
    frameworkSourceSha: context.source.frameworkSourceSha,
    acceptedPlanChecksum,
    pipelineExecutionId,
    inventorySha256: sha256Text(canonicalRecordJson(inventory)),
    stateJsonSha256: parseSha256(evidence['stateJsonSha256'], 'Bootstrap log-group state JSON SHA-256'),
    expectedProjectCount: inventory.length,
    verifiedProjectCount: inventory.length,
    unexpectedLogGroupCount: 0,
    remoteIdentityMismatchCount: 0,
    retentionMismatchCount: 0,
    projectLoggingMismatchCount: 0,
  };
  if (canonicalRecordJson(evidence) !== canonicalRecordJson(expected)) {
    throw new Error('Bootstrap log-group inventory evidence is detached from its complete reviewed inventory.');
  }
  return /** @type {BootstrapLogGroupInventoryEvidence} */ (deepFreeze(expected));
}

/**
 * Verify the complete managed project/log-group inventory in post-Apply state.
 * State is transient input; only hashes and bounded counts are returned.
 * @param {unknown} stateBody
 * @param {unknown} contextValue
 * @param {unknown} acceptedPlanChecksum
 * @param {unknown} pipelineExecutionId
 * @returns {BootstrapLogGroupInventoryEvidence}
 */
export function createBootstrapLogGroupInventoryEvidence(
  stateBody,
  contextValue,
  acceptedPlanChecksum,
  pipelineExecutionId,
) {
  const { context } = productionBootstrapContext(contextValue);
  if (
    typeof stateBody !== 'string' ||
    stateBody.length === 0 ||
    Buffer.byteLength(stateBody, 'utf8') > 128 * 1024 * 1024
  ) {
    throw new Error('Bootstrap log-group Terraform state JSON is empty or oversized.');
  }
  let parsedState;
  try {
    parsedState = JSON.parse(stateBody);
  } catch {
    throw new Error('Bootstrap log-group Terraform state JSON is not valid JSON.');
  }
  const state = record(parsedState, 'Terraform state');
  const resources = collectResources(record(state['values'], 'Terraform state values')['root_module']);
  const inventory = resolveBootstrapLogGroupInventory(context);
  if (new Set(resources.map((resource) => resource['address'])).size !== resources.length) {
    throw new Error('Terraform state has duplicate resource addresses.');
  }
  const logGroups = resources.filter(
    (resource) => resource['mode'] === 'managed' && resource['type'] === 'aws_cloudwatch_log_group',
  );
  const projects = resources.filter(
    (resource) => resource['mode'] === 'managed' && resource['type'] === 'aws_codebuild_project',
  );
  if (logGroups.length !== inventory.length || projects.length !== inventory.length) {
    throw new Error('Bootstrap state must contain the complete exact CodeBuild project and log-group inventory.');
  }
  for (const expected of inventory) {
    const matches = logGroups.filter((resource) => resource['address'] === expected.address);
    const logGroup = matches[0];
    if (
      matches.length !== 1 ||
      logGroup === undefined ||
      logGroup['name'] !== 'this' ||
      logGroup['index'] !== expected.projectName
    ) {
      throw new Error('Bootstrap state is missing an exact managed log-group address or index.');
    }
    const values = record(logGroup['values'], 'Bootstrap log-group values');
    if (values['name'] !== expected.remoteId || values['id'] !== expected.remoteId) {
      throw new Error('Bootstrap log-group remote identity differs from its reviewed project.');
    }
    if (values['retention_in_days'] !== expected.retentionInDays) {
      throw new Error('Bootstrap log-group retention differs from its reviewed policy.');
    }
    const projectMatches = projects.filter(
      (resource) => record(resource['values'], 'CodeBuild project values')['name'] === expected.projectName,
    );
    if (projectMatches.length !== 1 || projectMatches[0] === undefined) {
      throw new Error('Bootstrap state is missing exactly one reviewed CodeBuild project.');
    }
    const project = record(projectMatches[0]['values'], 'CodeBuild project values');
    const logs = snapshotDenseArray(project['logs_config'], 'CodeBuild logging configuration');
    const cloudwatch =
      logs.length === 1
        ? snapshotDenseArray(record(logs[0], 'CodeBuild logging')['cloudwatch_logs'], 'CodeBuild CloudWatch logging')
        : [];
    if (
      cloudwatch.length !== 1 ||
      record(cloudwatch[0], 'CodeBuild CloudWatch log group')['group_name'] !== expected.remoteId ||
      record(cloudwatch[0], 'CodeBuild CloudWatch log group')['status'] !== 'ENABLED'
    ) {
      throw new Error('CodeBuild project logging is detached from its reviewed log group.');
    }
  }
  return admitBootstrapLogGroupInventoryEvidence(
    {
      evidenceType: 'bootstrap-codebuild-log-group-inventory',
      targetKey: 'stark-prod/main',
      stateIdentity: context.root.stateIdentity,
      backendKey: context.root.backendKey,
      controlSourceSha: context.source.requestedControlSourceSha,
      frameworkSourceSha: context.source.frameworkSourceSha,
      acceptedPlanChecksum,
      pipelineExecutionId,
      inventorySha256: sha256Text(canonicalRecordJson(inventory)),
      stateJsonSha256: sha256Text(stateBody),
      expectedProjectCount: inventory.length,
      verifiedProjectCount: inventory.length,
      unexpectedLogGroupCount: 0,
      remoteIdentityMismatchCount: 0,
      retentionMismatchCount: 0,
      projectLoggingMismatchCount: 0,
    },
    context,
    acceptedPlanChecksum,
    pipelineExecutionId,
  );
}
