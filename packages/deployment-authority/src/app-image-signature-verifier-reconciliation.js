import { Buffer } from 'node:buffer';
import { isDeepStrictEqual, types as utilTypes } from 'node:util';

import { snapshotDataTree } from './descriptor-snapshot.js';
import {
  canonicalJson,
  canonicalJsonSha256,
  deepFreeze,
  parseGitCommitSha,
  parseImageDigest,
  parseS3VersionId,
  parseSha256,
  requireExactKeys,
  requireString,
} from './internal.js';
import {
  resolveAllowedDeploymentTarget,
  resolveDeploymentLaneAuthority,
  resolveImageSigningIdentity,
} from './index.js';

/** @typedef {import('./index.js').AllowedDeploymentTarget} AllowedDeploymentTarget */
/** @typedef {import('./index.js').DeploymentLaneAuthority} DeploymentLaneAuthority */
/** @typedef {import('./index.js').ImageSigningIdentity} ImageSigningIdentity */
/** @typedef {string & {readonly __base64Sha256: never}} Base64Sha256 */
/** @typedef {string & {readonly __lambdaFunctionVersion: never}} LambdaFunctionVersion */

/**
 * @typedef {{
 *   readonly s3Bucket: string;
 *   readonly s3Key: string;
 *   readonly s3ObjectVersionId: string;
 * }} AppImageSignatureVerifierResolvedS3Object
 */

/**
 * @typedef {AppImageSignatureVerifierResolvedS3Object & {
 *   readonly assetManifestSha256: string;
 *   readonly codeSha256: Base64Sha256;
 *   readonly trustRootSha256: string;
 *   readonly zipSha256: string;
 * }} AppImageSignatureVerifierPackage
 */

/**
 * @typedef {{
 *   readonly IMAGE_SIGNATURE_VERIFIER_EXPECTED_ASSET_MANIFEST_SHA256: string;
 *   readonly IMAGE_SIGNATURE_VERIFIER_EXPECTED_IMAGE_DIGEST: string;
 *   readonly IMAGE_SIGNATURE_VERIFIER_EXPECTED_REGION: string;
 *   readonly IMAGE_SIGNATURE_VERIFIER_EXPECTED_REGISTRY_ID: string;
 *   readonly IMAGE_SIGNATURE_VERIFIER_EXPECTED_REPOSITORY_NAME: string;
 *   readonly IMAGE_SIGNATURE_VERIFIER_EXPECTED_SIGNING_PROFILE_ARN: string;
 *   readonly IMAGE_SIGNATURE_VERIFIER_EXPECTED_TRUST_ROOT_SHA256: string;
 *   readonly IMAGE_SIGNATURE_VERIFIER_HANDLER_DEADLINE_MS: string;
 *   readonly IMAGE_SIGNATURE_VERIFIER_STATUS_ATTEMPT_TIMEOUT_MS: string;
 *   readonly IMAGE_SIGNATURE_VERIFIER_STATUS_ATTEMPTS: string;
 *   readonly IMAGE_SIGNATURE_VERIFIER_STATUS_RETRY_DELAY_MS: string;
 *   readonly IMAGE_SIGNATURE_VERIFIER_TIMEOUT_MS: string;
 *   readonly NODE_ENV: string;
 * }} AppImageSignatureVerifierEnvironment
 */

/**
 * @typedef {{
 *   readonly application_log_level: string;
 *   readonly log_format: string;
 *   readonly log_group: string;
 *   readonly system_log_level: string;
 * }} AppImageSignatureVerifierLoggingConfiguration
 */

/**
 * @typedef {{
 *   readonly ipv6_allowed_for_dual_stack: boolean;
 *   readonly security_group_ids: readonly string[];
 *   readonly subnet_ids: readonly string[];
 *   readonly vpc_id: string | null;
 * }} AppImageSignatureVerifierVpcConfiguration
 */

/**
 * @typedef {{
 *   readonly architectures: readonly string[];
 *   readonly dead_letter_target_arn: string | null;
 *   readonly environment: AppImageSignatureVerifierEnvironment;
 *   readonly ephemeral_storage_mb: number;
 *   readonly handler: string;
 *   readonly kms_key_arn: string | null;
 *   readonly layers: readonly string[];
 *   readonly logging_config: AppImageSignatureVerifierLoggingConfiguration;
 *   readonly memory_size_mb: number;
 *   readonly package_type: string;
 *   readonly role_arn: string;
 *   readonly runtime: string;
 *   readonly timeout_seconds: number;
 *   readonly tracing_mode: string;
 *   readonly vpc_config: AppImageSignatureVerifierVpcConfiguration;
 * }} AppImageSignatureVerifierConfigurationAuthority
 */

/**
 * @typedef {Omit<AppImageSignatureVerifierConfigurationAuthority, 'architectures' | 'package_type'>}
 * AppImageSignatureVerifierConfigurationUpdate
 */

/**
 * @typedef {{
 *   readonly proverImageDigest: string;
 *   readonly proverRepositoryName: string;
 *   readonly signingProfileArn: string;
 * }} AppImageSignatureVerifierSignatureAuthority
 */

/**
 * @typedef {{
 *   readonly assetManifestSha256: string;
 *   readonly awsConfigSha256: Base64Sha256 | null;
 *   readonly codeSha256: Base64Sha256;
 *   readonly description: '';
 *   readonly functionConfigurationAuthority: AppImageSignatureVerifierConfigurationAuthority;
 *   readonly functionConfigurationSha256: string;
 *   readonly functionVersion: LambdaFunctionVersion;
 *   readonly resolvedS3Object: AppImageSignatureVerifierResolvedS3Object;
 *   readonly trustRootSha256: string;
 *   readonly zipSha256: string;
 * }} AppImageSignatureVerifierExactFunction
 */

/** @typedef {{readonly kind: 'reconciled-function'}} AppImageSignatureVerifierReconciledTarget */
/**
 * @typedef {{
 *   readonly function: AppImageSignatureVerifierExactFunction;
 *   readonly kind: 'retained-function';
 * }} AppImageSignatureVerifierRetainedTarget
 */
/**
 * @typedef {AppImageSignatureVerifierReconciledTarget | AppImageSignatureVerifierRetainedTarget}
 * AppImageSignatureVerifierAliasTarget
 */

/**
 * @typedef {{
 *   readonly aliasArn: string;
 *   readonly description: string;
 *   readonly name: 'preflight' | 'runtime';
 *   readonly target: AppImageSignatureVerifierAliasTarget;
 * }} AppImageSignatureVerifierDesiredAlias
 */

/**
 * @typedef {{
 *   readonly accountId: string;
 *   readonly aliases: Readonly<{
 *     preflight: AppImageSignatureVerifierDesiredAlias;
 *     runtime: AppImageSignatureVerifierDesiredAlias;
 *   }>;
 *   readonly functionArn: string;
 *   readonly functionConfigurationAuthority: AppImageSignatureVerifierConfigurationAuthority;
 *   readonly functionConfigurationSha256: string;
 *   readonly functionName: string;
 *   readonly package: AppImageSignatureVerifierPackage;
 *   readonly region: string;
 *   readonly signatureAuthority: AppImageSignatureVerifierSignatureAuthority;
 *   readonly sourceSha: string;
 *   readonly targetKey: string;
 * }} AppImageSignatureVerifierCandidateState
 */

/**
 * @typedef {AppImageSignatureVerifierCandidateState & {
 *   readonly expectedFunctionVersion: LambdaFunctionVersion;
 * }} AppImageSignatureVerifierDesiredState
 */

/**
 * @typedef {{
 *   readonly awsConfigSha256: Base64Sha256 | null;
 *   readonly awsRevisionId: string;
 *   readonly codeSha256: Base64Sha256;
 *   readonly description: string;
 *   readonly functionArn: string;
 *   readonly functionConfigurationAuthority: AppImageSignatureVerifierConfigurationAuthority;
 *   readonly functionConfigurationSha256: string;
 *   readonly functionName: string;
 *   readonly lastModified: string;
 *   readonly resolvedS3Object: AppImageSignatureVerifierResolvedS3Object | null;
 *   readonly state: 'Active' | 'Failed' | 'Inactive' | 'Pending';
 * }} AppImageSignatureVerifierObservedFunction
 */

/**
 * @typedef {AppImageSignatureVerifierObservedFunction & {
 *   readonly lastUpdateStatus: 'Failed' | 'InProgress' | 'Successful';
 * }} AppImageSignatureVerifierMutableFunction
 */

/**
 * @typedef {AppImageSignatureVerifierObservedFunction & {
 *   readonly functionVersion: LambdaFunctionVersion;
 * }} AppImageSignatureVerifierImmutableFunction
 */

/**
 * @typedef {{
 *   readonly aliasArn: string;
 *   readonly awsRevisionId: string;
 *   readonly description: string;
 *   readonly functionVersion: LambdaFunctionVersion;
 *   readonly name: 'preflight' | 'runtime';
 *   readonly routingWeights: Readonly<Record<string, never>>;
 * }} AppImageSignatureVerifierObservedAlias
 */

/**
 * @typedef {{
 *   readonly aliases: Readonly<{
 *     preflight: AppImageSignatureVerifierObservedAlias;
 *     runtime: AppImageSignatureVerifierObservedAlias;
 *   }>;
 *   readonly immutableFunctions: Readonly<{
 *     readonly items: readonly AppImageSignatureVerifierImmutableFunction[];
 *     readonly unreadNextMarker: null;
 *   }>;
 *   readonly mutableFunction: AppImageSignatureVerifierMutableFunction;
 * }} AppImageSignatureVerifierObservation
 */

/**
 * @typedef {{
 *   readonly description: '';
 *   readonly expectedAwsRevisionId: string;
 *   readonly functionConfiguration: AppImageSignatureVerifierConfigurationUpdate;
 *   readonly functionName: string;
 *   readonly kind: 'update-function-configuration';
 * }} AppImageSignatureVerifierUpdateConfigurationAction
 */

/**
 * @typedef {{
 *   readonly architectures: readonly string[];
 *   readonly expectedAwsRevisionId: string;
 *   readonly functionName: string;
 *   readonly kind: 'update-function-code';
 *   readonly package: AppImageSignatureVerifierPackage;
 *   readonly publish: false;
 * }} AppImageSignatureVerifierUpdateCodeAction
 */

/**
 * @typedef {{
 *   readonly codeSha256: Base64Sha256;
 *   readonly expectedAwsRevisionId: string;
 *   readonly expectedFunctionVersion: LambdaFunctionVersion;
 *   readonly functionName: string;
 *   readonly kind: 'publish-immutable-function';
 * }} AppImageSignatureVerifierPublishAction
 */

/**
 * @typedef {{
 *   readonly alias: Readonly<{
 *     readonly aliasArn: string;
 *     readonly description: string;
 *     readonly functionVersion: LambdaFunctionVersion;
 *     readonly name: 'preflight' | 'runtime';
 *   }>;
 *   readonly expectedAwsRevisionId: string;
 *   readonly functionName: string;
 *   readonly kind: 'update-alias';
 * }} AppImageSignatureVerifierUpdateAliasAction
 */

/**
 * @typedef {{
 *   readonly functionName: string;
 *   readonly kind: 'wait-for-function-readiness';
 * }} AppImageSignatureVerifierWaitAction
 */

/**
 * @typedef {{
 *   readonly aliases: AppImageSignatureVerifierObservation['aliases'];
 *   readonly kind: 'validate-live-state';
 *   readonly runtimeFunction: AppImageSignatureVerifierImmutableFunction;
 *   readonly selectedFunction: AppImageSignatureVerifierImmutableFunction;
 * }} AppImageSignatureVerifierValidateAction
 */

/**
 * @typedef {AppImageSignatureVerifierUpdateConfigurationAction | AppImageSignatureVerifierUpdateCodeAction | AppImageSignatureVerifierPublishAction | AppImageSignatureVerifierUpdateAliasAction | AppImageSignatureVerifierWaitAction | AppImageSignatureVerifierValidateAction} AppImageSignatureVerifierReconciliationAction
 */

/**
 * @typedef {{
 *   readonly app: DeploymentLaneAuthority;
 *   readonly signing: ImageSigningIdentity;
 *   readonly target: AllowedDeploymentTarget;
 * }} AppImageSignatureVerifierAliasAuthority
 */

/**
 * @typedef {{
 *   readonly app: DeploymentLaneAuthority;
 *   readonly proverImageDigest: string;
 *   readonly signatureAuthority: AppImageSignatureVerifierSignatureAuthority;
 *   readonly target: AllowedDeploymentTarget;
 *   readonly verifierPackage: AppImageSignatureVerifierPackage;
 * }} AppImageSignatureVerifierDesiredConfigurationAdmission
 */

/** @type {readonly (keyof AppImageSignatureVerifierCandidateState)[]} */
const CANDIDATE_DESIRED_KEYS = [
  'accountId',
  'aliases',
  'functionArn',
  'functionConfigurationAuthority',
  'functionConfigurationSha256',
  'functionName',
  'package',
  'region',
  'signatureAuthority',
  'sourceSha',
  'targetKey',
];
const DESIRED_KEYS = [...CANDIDATE_DESIRED_KEYS, 'expectedFunctionVersion'];
const PACKAGE_KEYS = [
  'assetManifestSha256',
  'codeSha256',
  's3Bucket',
  's3Key',
  's3ObjectVersionId',
  'trustRootSha256',
  'zipSha256',
];
const RESOLVED_S3_OBJECT_KEYS = ['s3Bucket', 's3Key', 's3ObjectVersionId'];
const SIGNATURE_AUTHORITY_KEYS = ['proverImageDigest', 'proverRepositoryName', 'signingProfileArn'];
const CONFIGURATION_KEYS = [
  'architectures',
  'dead_letter_target_arn',
  'environment',
  'ephemeral_storage_mb',
  'handler',
  'kms_key_arn',
  'layers',
  'logging_config',
  'memory_size_mb',
  'package_type',
  'role_arn',
  'runtime',
  'timeout_seconds',
  'tracing_mode',
  'vpc_config',
];
/** @type {readonly (keyof AppImageSignatureVerifierConfigurationUpdate)[]} */
const FUNCTION_CONFIGURATION_UPDATE_KEYS = [
  'dead_letter_target_arn',
  'environment',
  'ephemeral_storage_mb',
  'handler',
  'kms_key_arn',
  'layers',
  'logging_config',
  'memory_size_mb',
  'role_arn',
  'runtime',
  'timeout_seconds',
  'tracing_mode',
  'vpc_config',
];
const ENVIRONMENT_KEYS = [
  'IMAGE_SIGNATURE_VERIFIER_EXPECTED_ASSET_MANIFEST_SHA256',
  'IMAGE_SIGNATURE_VERIFIER_EXPECTED_IMAGE_DIGEST',
  'IMAGE_SIGNATURE_VERIFIER_EXPECTED_REGION',
  'IMAGE_SIGNATURE_VERIFIER_EXPECTED_REGISTRY_ID',
  'IMAGE_SIGNATURE_VERIFIER_EXPECTED_REPOSITORY_NAME',
  'IMAGE_SIGNATURE_VERIFIER_EXPECTED_SIGNING_PROFILE_ARN',
  'IMAGE_SIGNATURE_VERIFIER_EXPECTED_TRUST_ROOT_SHA256',
  'IMAGE_SIGNATURE_VERIFIER_HANDLER_DEADLINE_MS',
  'IMAGE_SIGNATURE_VERIFIER_STATUS_ATTEMPT_TIMEOUT_MS',
  'IMAGE_SIGNATURE_VERIFIER_STATUS_ATTEMPTS',
  'IMAGE_SIGNATURE_VERIFIER_STATUS_RETRY_DELAY_MS',
  'IMAGE_SIGNATURE_VERIFIER_TIMEOUT_MS',
  'NODE_ENV',
];
const LOGGING_CONFIG_KEYS = ['application_log_level', 'log_format', 'log_group', 'system_log_level'];
const VPC_CONFIG_KEYS = ['ipv6_allowed_for_dual_stack', 'security_group_ids', 'subnet_ids', 'vpc_id'];
const ALIAS_KEYS = ['aliasArn', 'description', 'name', 'target'];
const OBSERVED_ALIAS_KEYS = ['aliasArn', 'awsRevisionId', 'description', 'functionVersion', 'name', 'routingWeights'];
const MUTABLE_FUNCTION_KEYS = [
  'awsConfigSha256',
  'awsRevisionId',
  'codeSha256',
  'description',
  'functionArn',
  'functionConfigurationAuthority',
  'functionConfigurationSha256',
  'functionName',
  'lastModified',
  'lastUpdateStatus',
  'resolvedS3Object',
  'state',
];
const IMMUTABLE_FUNCTION_KEYS = [
  'awsConfigSha256',
  'awsRevisionId',
  'codeSha256',
  'description',
  'functionArn',
  'functionConfigurationAuthority',
  'functionConfigurationSha256',
  'functionName',
  'functionVersion',
  'lastModified',
  'resolvedS3Object',
  'state',
];
const EXACT_FUNCTION_KEYS = [
  'assetManifestSha256',
  'awsConfigSha256',
  'codeSha256',
  'description',
  'functionConfigurationAuthority',
  'functionConfigurationSha256',
  'functionVersion',
  'resolvedS3Object',
  'trustRootSha256',
  'zipSha256',
];
/**
 * @type {readonly (keyof AppImageSignatureVerifierImmutableFunction & keyof AppImageSignatureVerifierExactFunction)[]}
 */
const EXACT_OBSERVED_FUNCTION_KEYS = [
  'codeSha256',
  'description',
  'functionConfigurationAuthority',
  'functionConfigurationSha256',
  'functionVersion',
];
const MAXIMUM_IMMUTABLE_FUNCTIONS = 64;
const BASE64_SHA256_PATTERN = /^[A-Za-z0-9+/]{43}=$/u;
const POSITIVE_DECIMAL_PATTERN = /^[1-9][0-9]*$/u;
const ACCOUNT_ID_PATTERN = /^[0-9]{12}$/u;
const REGION_PATTERN = /^[a-z]{2}(?:-gov)?-[a-z]+-[0-9]$/u;
/** @type {readonly ('preflight' | 'runtime')[]} */
const ALIAS_NAMES = ['preflight', 'runtime'];

/**
 * Admit one exact, current App image-signature verifier target without any
 * filesystem, process, AWS, or other transport access. This module exposes no
 * import, removal, or state-adoption operation. Callers must not apply its
 * selected actions to a native Terraform-managed function unless the package
 * and Lambda FunctionVersion can be represented and adopted without imperative
 * state changes.
 *
 * @param {unknown} input
 * @returns {AppImageSignatureVerifierDesiredState}
 */
export function admitAppImageSignatureVerifierDesiredState(input) {
  const snapshot = captureAuthorityData(input, 'App image-signature verifier desired state');
  const desired = requireExactKeys(snapshot, DESIRED_KEYS, 'App image-signature verifier desired state');
  const candidate = /** @type {AppImageSignatureVerifierCandidateState} */ (
    Object.fromEntries(CANDIDATE_DESIRED_KEYS.map((key) => [key, desired[key]]))
  );
  admitCandidateState(candidate, 'App image-signature verifier desired state');
  requireFunctionVersion(desired['expectedFunctionVersion'], 'App image-signature verifier expected FunctionVersion');
  return /** @type {AppImageSignatureVerifierDesiredState} */ (snapshot);
}

/**
 * Admit the persisted result of an applied reconciliation without inventing
 * authority for an untouched prerequisite or a partially applied transition.
 * @param {unknown} value
 * @param {string} expectedTargetKey
 */
export function admitAppImageSignatureVerifierRetainedState(value, expectedTargetKey) {
  const state = requireExactKeys(
    captureAuthorityData(value, 'Terraform retained verifier reconciliation state'),
    ['input', 'output', 'triggers_replace'],
    'Terraform retained verifier reconciliation state',
  );
  const fields = ['desired_json', 'desired_sha256', 'expected_function_version'];
  const input = requireExactKeys(state['input'], fields, 'Terraform retained verifier reconciliation input');
  const output = requireExactKeys(state['output'], fields, 'Terraform retained verifier reconciliation output');
  if (state['triggers_replace'] !== null || !isDeepStrictEqual(input, output))
    throw new Error('Terraform retained verifier reconciliation input and output are detached.');
  const body = input['desired_json'];
  if (
    typeof body !== 'string' ||
    body.length === 0 ||
    body.includes('\0') ||
    Buffer.byteLength(body, 'utf8') > 256 * 1024
  )
    throw new Error('Terraform retained verifier reconciliation desired JSON is invalid.');
  let desired;
  try {
    desired = admitAppImageSignatureVerifierDesiredState(JSON.parse(body));
  } catch (error) {
    throw new Error('Terraform retained verifier reconciliation desired JSON is invalid.', { cause: error });
  }
  if (
    desired.targetKey !== expectedTargetKey ||
    canonicalJson(desired) !== body ||
    input['desired_sha256'] !== canonicalJsonSha256(desired) ||
    input['expected_function_version'] !== desired.expectedFunctionVersion
  )
    throw new Error('Terraform retained verifier reconciliation desired authority is detached.');
  return desired;
}

/**
 * Project both admitted immutable branches once for initial and recurring App
 * state readers. S3 coordinates remain those retained for each exact branch.
 * @param {unknown} value
 * @param {string} expectedTargetKey
 */
export function projectAppImageSignatureVerifierRuntimeBranches(value, expectedTargetKey) {
  const desired = admitAppImageSignatureVerifierDesiredState(value);
  if (desired.targetKey !== expectedTargetKey)
    throw new Error('Retained verifier authority is detached from the caller target.');
  const target = resolveAllowedDeploymentTarget(expectedTargetKey);
  const app = resolveDeploymentLaneAuthority(target, 'app');
  const runtime = desired.aliases.runtime.target;
  if (runtime.kind !== 'retained-function') throw new Error('Terraform retained verifier runtime target is invalid.');
  const fn = runtime.function;
  const candidateVersion = BigInt(desired.expectedFunctionVersion);
  const retainedVersion = BigInt(fn.functionVersion);
  if (candidateVersion < retainedVersion)
    throw new Error('Terraform retained verifier candidate FunctionVersion is older than retained authority.');
  if (
    candidateVersion === retainedVersion &&
    (desired.package.codeSha256 !== fn.codeSha256 ||
      desired.functionConfigurationSha256 !== fn.functionConfigurationSha256 ||
      !isDeepStrictEqual(desired.functionConfigurationAuthority, fn.functionConfigurationAuthority))
  )
    throw new Error('Terraform retained verifier authorities differ semantically at the same FunctionVersion.');
  const imagePrefix = `${target.accountId}.dkr.ecr.${target.region}.amazonaws.com/${app.names.proverRepository}@`;
  return deepFreeze({
    candidate: {
      functionVersion: desired.expectedFunctionVersion,
      package: desired.package,
      proverImageUri: `${imagePrefix}${desired.signatureAuthority.proverImageDigest}`,
    },
    retained: {
      functionVersion: fn.functionVersion,
      package: {
        ...fn.resolvedS3Object,
        assetManifestSha256: fn.assetManifestSha256,
        codeSha256: fn.codeSha256,
        trustRootSha256: fn.trustRootSha256,
        zipSha256: fn.zipSha256,
      },
      proverImageUri: `${imagePrefix}${fn.functionConfigurationAuthority.environment.IMAGE_SIGNATURE_VERIFIER_EXPECTED_IMAGE_DIGEST}`,
    },
  });
}

/**
 * Bind the exact FunctionVersion that a read-only complete inventory permits:
 * reuse only the numerically highest exact publication, or select max + 1.
 *
 * @param {unknown} candidateInput
 * @param {unknown} observationInput
 * @returns {AppImageSignatureVerifierDesiredState}
 */
export function bindAppImageSignatureVerifierExpectedVersion(candidateInput, observationInput) {
  const candidate = admitCandidateState(
    captureAuthorityData(candidateInput, 'App image-signature verifier candidate state'),
    'App image-signature verifier candidate state',
  );
  const observation = admitObservation(observationInput, candidate);
  return bindExpectedVersion(candidate, observation);
}

/**
 * @param {unknown} input
 * @param {string} label
 * @returns {AppImageSignatureVerifierCandidateState}
 */
function admitCandidateState(input, label) {
  const desired = requireExactKeys(input, CANDIDATE_DESIRED_KEYS, label);
  const targetKey = requireString(desired['targetKey'], 'App image-signature verifier target key');
  const target = resolveAllowedDeploymentTarget(targetKey);
  const app = resolveDeploymentLaneAuthority(target, 'app');
  const signing = resolveImageSigningIdentity(target);

  if (
    desired['accountId'] !== target.accountId ||
    desired['region'] !== target.region ||
    desired['functionName'] !== app.names.signatureVerifierFunction ||
    desired['functionArn'] !==
      `arn:${target.partition}:lambda:${target.region}:${target.accountId}:function:${app.names.signatureVerifierFunction}`
  ) {
    throw new Error('App image-signature verifier desired state is detached from the reviewed target.');
  }
  requireString(desired['accountId'], 'App image-signature verifier account ID', ACCOUNT_ID_PATTERN);
  requireString(desired['region'], 'App image-signature verifier region', REGION_PATTERN);
  const sourceSha = parseGitCommitSha(desired['sourceSha'], 'App image-signature verifier source SHA');

  const verifierPackage = admitPackage(desired['package'], 'App image-signature verifier package');
  if (
    verifierPackage['s3Bucket'] !== app.names.appRetainedArtifactBucket ||
    verifierPackage['s3Key'] !== `${app.names.lambdaArtifactPrefix}/${sourceSha}/image-signature-verifier.zip`
  ) {
    throw new Error('App image-signature verifier package is detached from its exact source.');
  }

  const signatureAuthority = requireExactKeys(
    desired['signatureAuthority'],
    SIGNATURE_AUTHORITY_KEYS,
    'App image-signature verifier signature authority',
  );
  const proverImageDigest = parseImageDigest(
    signatureAuthority['proverImageDigest'],
    'App image-signature verifier Prover image digest',
  );
  if (
    signatureAuthority['proverRepositoryName'] !== signing.repositories.prover ||
    signatureAuthority['signingProfileArn'] !== signing.signingProfileArn
  ) {
    throw new Error('App image-signature verifier signature authority is detached from the reviewed target.');
  }
  const admittedSignatureAuthority = /** @type {AppImageSignatureVerifierSignatureAuthority} */ (signatureAuthority);

  const configuration = admitConfigurationAuthority(
    desired['functionConfigurationAuthority'],
    'App image-signature verifier desired configuration',
  );
  const configurationSha256 = parseSha256(
    desired['functionConfigurationSha256'],
    'App image-signature verifier function configuration SHA-256',
  );
  if (canonicalJsonSha256(configuration) !== configurationSha256) {
    throw new Error('App image-signature verifier function configuration SHA-256 does not bind its exact authority.');
  }
  admitDesiredConfiguration(configuration, {
    app,
    proverImageDigest,
    signatureAuthority: admittedSignatureAuthority,
    target,
    verifierPackage,
  });

  const aliases = requireExactKeys(desired['aliases'], ['preflight', 'runtime'], 'App verifier aliases');
  const aliasAuthority = { app, signing, target };
  const admittedPreflight = admitDesiredAlias(
    aliases['preflight'],
    'preflight',
    desired['functionArn'],
    aliasAuthority,
  );
  admitDesiredAlias(aliases['runtime'], 'runtime', desired['functionArn'], aliasAuthority);
  if (admittedPreflight.target.kind !== 'reconciled-function') {
    throw new Error('App verifier preflight alias must select the reconciled function.');
  }

  return /** @type {AppImageSignatureVerifierCandidateState} */ (desired);
}

/**
 * Select at most one external Lambda action from one exact, complete
 * observation. Callers must observe again after executing the returned action.
 *
 * @param {unknown} desiredInput
 * @param {unknown} observationInput
 * @returns {AppImageSignatureVerifierReconciliationAction}
 */
export function selectAppImageSignatureVerifierAction(desiredInput, observationInput) {
  const desired = admitAppImageSignatureVerifierDesiredState(desiredInput);
  const observation = admitObservation(observationInput, desired);
  const candidate = /** @type {AppImageSignatureVerifierCandidateState} */ (
    Object.fromEntries(CANDIDATE_DESIRED_KEYS.map((key) => [key, desired[key]]))
  );
  const rebound = bindExpectedVersion(candidate, observation);
  if (rebound['expectedFunctionVersion'] !== desired['expectedFunctionVersion']) {
    throw new Error('App image-signature verifier inventory changed from its expected FunctionVersion authority.');
  }
  const mutableFunction = observation.mutableFunction;
  const desiredPackage = desired.package;
  const mutableConfiguration = mutableFunction.functionConfigurationAuthority;
  const desiredConfiguration = desired.functionConfigurationAuthority;
  const desiredFunctionConfiguration = projectFunctionConfigurationUpdate(desiredConfiguration);

  if (
    mutableFunction['state'] === 'Failed' ||
    mutableFunction['state'] === 'Inactive' ||
    mutableFunction['lastUpdateStatus'] === 'Failed'
  ) {
    throw new Error('App image-signature verifier mutable function is in a failed or inactive state.');
  }
  if (mutableFunction['state'] === 'Pending' || mutableFunction['lastUpdateStatus'] === 'InProgress') {
    return deepFreeze({
      functionName: desired['functionName'],
      kind: 'wait-for-function-readiness',
    });
  }
  if (mutableFunction['state'] !== 'Active' || mutableFunction['lastUpdateStatus'] !== 'Successful') {
    throw new Error('App image-signature verifier mutable function readiness is invalid.');
  }
  if (mutableConfiguration['package_type'] !== desiredConfiguration['package_type']) {
    throw new Error('App image-signature verifier package type cannot be reconciled on the existing function.');
  }

  if (
    mutableFunction['description'] !== '' ||
    !isDeepStrictEqual(projectFunctionConfigurationUpdate(mutableConfiguration), desiredFunctionConfiguration)
  ) {
    return deepFreeze({
      description: '',
      expectedAwsRevisionId: mutableFunction['awsRevisionId'],
      functionConfiguration: desiredFunctionConfiguration,
      functionName: desired['functionName'],
      kind: 'update-function-configuration',
    });
  }

  if (
    !isDeepStrictEqual(mutableConfiguration['architectures'], desiredConfiguration['architectures']) ||
    mutableFunction['codeSha256'] !== desiredPackage['codeSha256'] ||
    !matchesOptionalObservation(mutableFunction['resolvedS3Object'], projectResolvedS3Object(desiredPackage))
  ) {
    return deepFreeze({
      architectures: desiredConfiguration['architectures'],
      expectedAwsRevisionId: mutableFunction['awsRevisionId'],
      functionName: desired['functionName'],
      kind: 'update-function-code',
      package: desired['package'],
      publish: false,
    });
  }

  const immutableFunctions = observation.immutableFunctions.items;
  const highestFunction = highestImmutableFunction(immutableFunctions);
  if (highestFunction === null || !isCandidateFunction(highestFunction, mutableFunction, desired)) {
    return deepFreeze({
      codeSha256: desiredPackage['codeSha256'],
      expectedAwsRevisionId: mutableFunction['awsRevisionId'],
      expectedFunctionVersion: desired['expectedFunctionVersion'],
      functionName: desired['functionName'],
      kind: 'publish-immutable-function',
    });
  }

  const aliases = desired.aliases;
  const aliasObservations = observation.aliases;
  /** @type {AppImageSignatureVerifierImmutableFunction | null} */
  let runtimeFunction = null;
  for (const aliasName of ALIAS_NAMES) {
    const desiredAlias = aliases[aliasName];
    const observedAlias = aliasObservations[aliasName];
    const desiredAliasTarget = desiredAlias.target;
    const targetFunction = resolveAliasTarget(desiredAliasTarget, highestFunction, immutableFunctions);
    if (aliasName === 'runtime') {
      runtimeFunction = targetFunction;
    }
    if (
      observedAlias['functionVersion'] !== targetFunction['functionVersion'] ||
      observedAlias['description'] !== desiredAlias['description']
    ) {
      if (desiredAliasTarget['kind'] === 'retained-function') {
        throw new Error(`App verifier retained ${aliasName} alias is mismatched.`);
      }
      return deepFreeze({
        alias: {
          aliasArn: desiredAlias['aliasArn'],
          description: desiredAlias['description'],
          functionVersion: targetFunction['functionVersion'],
          name: desiredAlias['name'],
        },
        expectedAwsRevisionId: observedAlias['awsRevisionId'],
        functionName: desired['functionName'],
        kind: 'update-alias',
      });
    }
  }
  if (runtimeFunction === null) {
    throw new Error('App verifier runtime function is missing.');
  }

  return deepFreeze({
    aliases: aliasObservations,
    kind: 'validate-live-state',
    runtimeFunction,
    selectedFunction: highestFunction,
  });
}

/**
 * @param {AppImageSignatureVerifierCandidateState} candidate
 * @param {AppImageSignatureVerifierObservation} observation
 * @returns {AppImageSignatureVerifierDesiredState}
 */
function bindExpectedVersion(candidate, observation) {
  const mutableFunction = observation.mutableFunction;
  const items = observation.immutableFunctions.items;
  const highest = highestImmutableFunction(items);
  const expectedFunctionVersion =
    highest !== null && isCandidateFunction(highest, mutableFunction, candidate)
      ? highest.functionVersion
      : requireFunctionVersion(
          String(highest === null ? 1n : BigInt(highest.functionVersion) + 1n),
          'App image-signature verifier selected FunctionVersion',
        );
  return deepFreeze({ ...candidate, expectedFunctionVersion });
}

/**
 * @param {unknown} value
 * @param {string} label
 * @returns {unknown}
 */
function captureAuthorityData(value, label) {
  assertNoProxyData(value, label, new Set());
  return snapshotDataTree(value, label);
}

/**
 * Reject proxies before any reflective operation can invoke one of their
 * traps. The descriptor snapshot then rejects accessors, symbols, sparse
 * arrays, inherited shapes, cycles, and unsupported objects.
 *
 * @param {unknown} value
 * @param {string} label
 * @param {Set<object>} ancestors
 */
function assertNoProxyData(value, label, ancestors) {
  if (typeof value !== 'object' || value === null) return;
  if (utilTypes.isProxy(value)) {
    throw new Error(`${label} must not contain a proxy.`);
  }
  if (ancestors.has(value)) return;
  ancestors.add(value);
  try {
    for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
      if (Object.hasOwn(descriptor, 'value')) {
        assertNoProxyData(descriptor.value, label, ancestors);
      }
    }
  } finally {
    ancestors.delete(value);
  }
}

/**
 * @param {unknown} value
 * @param {string} label
 * @returns {AppImageSignatureVerifierPackage}
 */
function admitPackage(value, label) {
  const verifierPackage = requireExactKeys(value, PACKAGE_KEYS, label);
  const zipSha256 = parseSha256(verifierPackage['zipSha256'], `${label} ZIP SHA-256`);
  const codeSha256 = requireBase64Sha256(verifierPackage['codeSha256'], `${label} Lambda CodeSha256`);
  if (Buffer.from(codeSha256, 'base64').toString('hex') !== zipSha256) {
    throw new Error(`${label} Lambda CodeSha256 does not bind the ZIP SHA-256.`);
  }
  parseSha256(verifierPackage['assetManifestSha256'], `${label} asset manifest SHA-256`);
  parseSha256(verifierPackage['trustRootSha256'], `${label} trust root SHA-256`);
  requireString(verifierPackage['s3Bucket'], `${label} S3 bucket`);
  requireString(verifierPackage['s3Key'], `${label} S3 key`);
  parseS3VersionId(verifierPackage['s3ObjectVersionId'], `${label} S3 VersionId`);
  return /** @type {AppImageSignatureVerifierPackage} */ (verifierPackage);
}

/**
 * @param {unknown} value
 * @param {string} label
 * @returns {AppImageSignatureVerifierResolvedS3Object}
 */
function admitResolvedS3Object(value, label) {
  const resolved = requireExactKeys(value, RESOLVED_S3_OBJECT_KEYS, label);
  requireString(resolved['s3Bucket'], `${label} bucket`);
  requireString(resolved['s3Key'], `${label} key`);
  parseS3VersionId(resolved['s3ObjectVersionId'], `${label} VersionId`);
  return /** @type {AppImageSignatureVerifierResolvedS3Object} */ (resolved);
}

/**
 * @param {unknown} value
 * @param {string} label
 * @returns {AppImageSignatureVerifierConfigurationAuthority}
 */
function admitConfigurationAuthority(value, label) {
  const configuration = requireExactKeys(value, CONFIGURATION_KEYS, label);
  requireDenseStringArray(configuration['architectures'], `${label} architectures`);
  requireNullOrString(configuration['dead_letter_target_arn'], `${label} dead-letter target ARN`);
  requireNullOrString(configuration['kms_key_arn'], `${label} KMS key ARN`);
  requireDenseStringArray(configuration['layers'], `${label} layers`);
  requirePositiveInteger(configuration['ephemeral_storage_mb'], `${label} ephemeral storage`, 512, 10_240);
  requireString(configuration['handler'], `${label} handler`);
  requirePositiveInteger(configuration['memory_size_mb'], `${label} memory`, 128, 10_240);
  requireString(configuration['package_type'], `${label} package type`);
  requireString(configuration['role_arn'], `${label} role ARN`);
  requireString(configuration['runtime'], `${label} runtime`);
  requirePositiveInteger(configuration['timeout_seconds'], `${label} timeout`, 1, 900);
  requireString(configuration['tracing_mode'], `${label} tracing mode`);

  const environment = requireExactKeys(configuration['environment'], ENVIRONMENT_KEYS, `${label} environment`);
  for (const key of ENVIRONMENT_KEYS) {
    requireString(environment[key], `${label} environment ${key}`);
  }

  const logging = requireExactKeys(configuration['logging_config'], LOGGING_CONFIG_KEYS, `${label} logging config`);
  for (const key of LOGGING_CONFIG_KEYS) {
    requireString(logging[key], `${label} logging config ${key}`);
  }

  const vpc = requireExactKeys(configuration['vpc_config'], VPC_CONFIG_KEYS, `${label} VPC config`);
  if (typeof vpc['ipv6_allowed_for_dual_stack'] !== 'boolean') {
    throw new Error(`${label} VPC dual-stack field is invalid.`);
  }
  requireDenseStringArray(vpc['security_group_ids'], `${label} VPC security groups`);
  requireDenseStringArray(vpc['subnet_ids'], `${label} VPC subnets`);
  requireNullOrString(vpc['vpc_id'], `${label} VPC ID`);
  return /** @type {AppImageSignatureVerifierConfigurationAuthority} */ (configuration);
}

/**
 * @param {AppImageSignatureVerifierConfigurationAuthority} configuration
 * @param {AppImageSignatureVerifierDesiredConfigurationAdmission} authority
 */
function admitDesiredConfiguration(configuration, authority) {
  admitTargetConfiguration(configuration, authority.app, authority.target, 'App image-signature verifier desired');
  const environment = configuration.environment;
  if (
    environment['IMAGE_SIGNATURE_VERIFIER_EXPECTED_ASSET_MANIFEST_SHA256'] !==
      authority.verifierPackage['assetManifestSha256'] ||
    environment['IMAGE_SIGNATURE_VERIFIER_EXPECTED_IMAGE_DIGEST'] !== authority.proverImageDigest ||
    environment['IMAGE_SIGNATURE_VERIFIER_EXPECTED_REGION'] !== authority.target['region'] ||
    environment['IMAGE_SIGNATURE_VERIFIER_EXPECTED_REGISTRY_ID'] !== authority.target['accountId'] ||
    environment['IMAGE_SIGNATURE_VERIFIER_EXPECTED_REPOSITORY_NAME'] !==
      authority.signatureAuthority['proverRepositoryName'] ||
    environment['IMAGE_SIGNATURE_VERIFIER_EXPECTED_SIGNING_PROFILE_ARN'] !==
      authority.signatureAuthority['signingProfileArn'] ||
    environment['IMAGE_SIGNATURE_VERIFIER_EXPECTED_TRUST_ROOT_SHA256'] !==
      authority.verifierPackage['trustRootSha256'] ||
    environment['NODE_ENV'] !== 'production'
  ) {
    throw new Error(
      'App image-signature verifier desired configuration is detached from package or signature authority.',
    );
  }

  admitTimeoutBudget(configuration, environment, 'App image-signature verifier desired');
}

/**
 * @param {AppImageSignatureVerifierConfigurationAuthority} configuration
 * @param {DeploymentLaneAuthority} app
 * @param {AllowedDeploymentTarget} target
 * @param {string} label
 */
function admitTargetConfiguration(configuration, app, target, label) {
  const logging = configuration.logging_config;
  const vpc = configuration.vpc_config;
  const expectedRoleArn = `arn:${target.partition}:iam::${target.accountId}:role/${app.names.signatureVerifierRole}`;
  const expectedLogGroup = `/aws/lambda/${app.names.signatureVerifierFunction}`;
  if (
    !isDeepStrictEqual(configuration['architectures'], ['x86_64']) ||
    configuration['dead_letter_target_arn'] !== null ||
    configuration['ephemeral_storage_mb'] !== 1024 ||
    configuration['handler'] !== 'index.handler' ||
    configuration['kms_key_arn'] !== null ||
    !isDeepStrictEqual(configuration['layers'], []) ||
    configuration['memory_size_mb'] !== 1024 ||
    configuration['package_type'] !== 'Zip' ||
    configuration['role_arn'] !== expectedRoleArn ||
    configuration['runtime'] !== 'nodejs24.x' ||
    configuration['tracing_mode'] !== 'PassThrough' ||
    !isDeepStrictEqual(logging, {
      application_log_level: 'INFO',
      log_format: 'JSON',
      log_group: expectedLogGroup,
      system_log_level: 'INFO',
    }) ||
    !isDeepStrictEqual(vpc, {
      ipv6_allowed_for_dual_stack: false,
      security_group_ids: [],
      subnet_ids: [],
      vpc_id: null,
    })
  ) {
    throw new Error(`${label} configuration is outside the current target authority.`);
  }
}

/**
 * @param {AppImageSignatureVerifierConfigurationAuthority} configuration
 * @param {AppImageSignatureVerifierEnvironment} environment
 * @param {string} label
 */
function admitTimeoutBudget(configuration, environment, label) {
  const timeoutSeconds = requirePositiveInteger(configuration['timeout_seconds'], `${label} timeout`, 30, 900);
  const handlerDeadline = requireDecimalInteger(
    environment['IMAGE_SIGNATURE_VERIFIER_HANDLER_DEADLINE_MS'],
    `${label} handler deadline`,
    10_000,
    120_000,
  );
  const attemptTimeout = requireDecimalInteger(
    environment['IMAGE_SIGNATURE_VERIFIER_STATUS_ATTEMPT_TIMEOUT_MS'],
    `${label} status attempt timeout`,
    250,
    15_000,
  );
  const attempts = requireDecimalInteger(
    environment['IMAGE_SIGNATURE_VERIFIER_STATUS_ATTEMPTS'],
    `${label} status attempts`,
    1,
    10,
  );
  const retryDelay = requireDecimalInteger(
    environment['IMAGE_SIGNATURE_VERIFIER_STATUS_RETRY_DELAY_MS'],
    `${label} status retry delay`,
    0,
    5_000,
  );
  const processTimeout = requireDecimalInteger(
    environment['IMAGE_SIGNATURE_VERIFIER_TIMEOUT_MS'],
    `${label} process timeout`,
    1_000,
    60_000,
  );
  if (
    handlerDeadline >= timeoutSeconds * 1_000 ||
    attemptTimeout * attempts + retryDelay * (attempts - 1) + processTimeout > handlerDeadline
  ) {
    throw new Error(`${label} timeout budget is invalid.`);
  }
}

/**
 * @param {unknown} value
 * @param {'preflight' | 'runtime'} name
 * @param {unknown} functionArn
 * @param {AppImageSignatureVerifierAliasAuthority} authority
 * @returns {AppImageSignatureVerifierDesiredAlias}
 */
function admitDesiredAlias(value, name, functionArn, authority) {
  const alias = requireExactKeys(value, ALIAS_KEYS, `App verifier ${name} alias`);
  const expectedDescription =
    name === 'preflight'
      ? 'Qualified non-accepting cryptographic verifier preflight'
      : 'Qualified runtime cryptographic verifier gate';
  if (
    alias['name'] !== name ||
    alias['aliasArn'] !== `${functionArn}:${name}` ||
    alias['description'] !== expectedDescription
  ) {
    throw new Error(`App verifier ${name} alias is detached from the reviewed function.`);
  }
  const targetValue = /** @type {Record<string, unknown>} */ (alias['target']);
  const target = requireExactKeys(
    targetValue,
    targetValue['kind'] === 'retained-function' ? ['function', 'kind'] : ['kind'],
    `App verifier ${name} alias target`,
  );
  if (target['kind'] === 'retained-function') {
    admitExactFunction(target['function'], `App verifier ${name} retained function`, authority);
  } else if (target['kind'] !== 'reconciled-function') {
    throw new Error(`App verifier ${name} alias target is invalid.`);
  }
  return /** @type {AppImageSignatureVerifierDesiredAlias} */ (alias);
}

/**
 * @param {unknown} value
 * @param {string} label
 * @param {AppImageSignatureVerifierAliasAuthority} authority
 * @returns {AppImageSignatureVerifierExactFunction}
 */
function admitExactFunction(value, label, authority) {
  const exactFunction = requireExactKeys(value, EXACT_FUNCTION_KEYS, label);
  const assetManifestSha256 = parseSha256(exactFunction['assetManifestSha256'], `${label} asset manifest SHA-256`);
  requireOptionalBase64Sha256(exactFunction['awsConfigSha256'], `${label} AWS ConfigSha256`);
  const codeSha256 = requireBase64Sha256(exactFunction['codeSha256'], `${label} Lambda CodeSha256`);
  const zipSha256 = parseSha256(exactFunction['zipSha256'], `${label} ZIP SHA-256`);
  if (Buffer.from(codeSha256, 'base64').toString('hex') !== zipSha256) {
    throw new Error(`${label} Lambda CodeSha256 does not bind the ZIP SHA-256.`);
  }
  const trustRootSha256 = parseSha256(exactFunction['trustRootSha256'], `${label} trust root SHA-256`);
  if (exactFunction['description'] !== '') throw new Error(`${label} description is invalid.`);
  const configuration = admitConfigurationAuthority(
    exactFunction['functionConfigurationAuthority'],
    `${label} configuration`,
  );
  const configurationSha256 = parseSha256(
    exactFunction['functionConfigurationSha256'],
    `${label} configuration SHA-256`,
  );
  if (canonicalJsonSha256(configuration) !== configurationSha256) {
    throw new Error(`${label} configuration SHA-256 does not bind its exact authority.`);
  }
  requireFunctionVersion(exactFunction['functionVersion'], `${label} FunctionVersion`);
  const resolved = admitResolvedS3Object(exactFunction['resolvedS3Object'], `${label} resolved S3 object`);
  const { app, signing, target: targetAuthority } = authority;
  const prefix = requireString(app.names.lambdaArtifactPrefix, `${label} Lambda artifact prefix`);
  const escapedPrefix = prefix.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  if (
    resolved['s3Bucket'] !== app.names.appRetainedArtifactBucket ||
    !new RegExp(`^${escapedPrefix}/[0-9a-f]{40}/image-signature-verifier\\.zip$`, 'u').test(String(resolved['s3Key']))
  ) {
    throw new Error(`${label} package is detached from the retained App artifact family.`);
  }
  admitRetainedConfiguration(
    configuration,
    {
      app,
      assetManifestSha256,
      signing,
      target: targetAuthority,
      trustRootSha256,
    },
    label,
  );
  return /** @type {AppImageSignatureVerifierExactFunction} */ (exactFunction);
}

/**
 * @param {AppImageSignatureVerifierConfigurationAuthority} configuration
 * @param {{
 *   app: DeploymentLaneAuthority;
 *   assetManifestSha256: string;
 *   signing: ImageSigningIdentity;
 *   target: AllowedDeploymentTarget;
 *   trustRootSha256: string;
 * }} authority
 * @param {string} label
 */
function admitRetainedConfiguration(configuration, authority, label) {
  admitTargetConfiguration(configuration, authority.app, authority.target, label);
  const environment = configuration.environment;
  if (
    environment['IMAGE_SIGNATURE_VERIFIER_EXPECTED_ASSET_MANIFEST_SHA256'] !== authority.assetManifestSha256 ||
    environment['IMAGE_SIGNATURE_VERIFIER_EXPECTED_TRUST_ROOT_SHA256'] !== authority.trustRootSha256 ||
    environment['IMAGE_SIGNATURE_VERIFIER_EXPECTED_REGION'] !== authority.target.region ||
    environment['IMAGE_SIGNATURE_VERIFIER_EXPECTED_REGISTRY_ID'] !== authority.target.accountId ||
    environment['IMAGE_SIGNATURE_VERIFIER_EXPECTED_REPOSITORY_NAME'] !== authority.signing.repositories.prover ||
    environment['IMAGE_SIGNATURE_VERIFIER_EXPECTED_SIGNING_PROFILE_ARN'] !== authority.signing.signingProfileArn ||
    environment['NODE_ENV'] !== 'production'
  ) {
    throw new Error(`${label} retained package or signing authority is detached from the reviewed target.`);
  }
  parseImageDigest(
    environment['IMAGE_SIGNATURE_VERIFIER_EXPECTED_IMAGE_DIGEST'],
    `${label} retained Prover image digest`,
  );
  admitTimeoutBudget(configuration, environment, label);
}

/**
 * @param {unknown} input
 * @param {AppImageSignatureVerifierCandidateState} desired
 * @returns {AppImageSignatureVerifierObservation}
 */
function admitObservation(input, desired) {
  preflightObservationBound(input);
  const snapshot = captureAuthorityData(input, 'App image-signature verifier observation');
  const observation = requireExactKeys(
    snapshot,
    ['aliases', 'immutableFunctions', 'mutableFunction'],
    'App image-signature verifier observation',
  );
  admitMutableFunction(observation['mutableFunction'], desired);
  const inventory = requireExactKeys(
    observation['immutableFunctions'],
    ['items', 'unreadNextMarker'],
    'App image-signature verifier immutable function inventory',
  );
  if (inventory['unreadNextMarker'] !== null) {
    throw new Error('App image-signature verifier immutable function inventory must be complete.');
  }
  if (!Array.isArray(inventory['items']) || inventory['items'].length > MAXIMUM_IMMUTABLE_FUNCTIONS) {
    throw new Error('App image-signature verifier immutable function inventory exceeds its exact bound.');
  }
  const immutableFunctions = inventory['items'].map((item) => admitImmutableFunction(item, desired));
  /** @type {Set<LambdaFunctionVersion>} */
  const versions = new Set();
  for (const immutableFunction of immutableFunctions) {
    const functionVersion = immutableFunction['functionVersion'];
    if (versions.has(functionVersion)) {
      throw new Error(
        'App image-signature verifier immutable function inventory contains a duplicate FunctionVersion.',
      );
    }
    versions.add(functionVersion);
  }

  const aliases = requireExactKeys(observation['aliases'], ['preflight', 'runtime'], 'App verifier alias observations');
  for (const name of ALIAS_NAMES) {
    if (aliases[name] === null) {
      throw new Error(`App verifier ${name} alias is missing from the Terraform-owned topology.`);
    }
    const admittedAlias = admitObservedAlias(aliases[name], name, desired['functionArn']);
    if (!versions.has(admittedAlias['functionVersion'])) {
      throw new Error(`App verifier ${name} alias selects a function absent from the complete inventory.`);
    }
  }

  for (const name of ALIAS_NAMES) {
    const desiredTarget = desired.aliases[name].target;
    if (desiredTarget.kind === 'retained-function') {
      const expected = desiredTarget.function;
      const selected = immutableFunctions.find((item) => item.functionVersion === expected.functionVersion);
      if (selected === undefined || !matchesExactFunction(selected, expected)) {
        throw new Error(`App verifier retained ${name} function is absent or mismatched.`);
      }
    }
  }

  return /** @type {AppImageSignatureVerifierObservation} */ (observation);
}

/**
 * Enforce the inventory width before recursive descriptor capture. This
 * shallow pass never visits an inventory item, so an over-bound input cannot
 * turn descriptor validation into unbounded work.
 *
 * @param {unknown} input
 */
function preflightObservationBound(input) {
  const root = shallowExactDataRecord(
    input,
    ['aliases', 'immutableFunctions', 'mutableFunction'],
    'App image-signature verifier observation',
  );
  const inventory = shallowExactDataRecord(
    root['immutableFunctions'],
    ['items', 'unreadNextMarker'],
    'App image-signature verifier immutable function inventory',
  );
  const items = inventory['items'];
  if (typeof items !== 'object' || items === null || utilTypes.isProxy(items) || !Array.isArray(items)) {
    throw new Error('App image-signature verifier immutable function inventory must use a dense array.');
  }
  const lengthDescriptor = Object.getOwnPropertyDescriptor(items, 'length');
  if (
    lengthDescriptor === undefined ||
    !Object.hasOwn(lengthDescriptor, 'value') ||
    typeof lengthDescriptor.value !== 'number' ||
    !Number.isSafeInteger(lengthDescriptor.value) ||
    lengthDescriptor.value < 0
  ) {
    throw new Error('App image-signature verifier immutable function inventory length is invalid.');
  }
  if (lengthDescriptor.value > MAXIMUM_IMMUTABLE_FUNCTIONS) {
    throw new Error('App image-signature verifier immutable function inventory exceeds its exact bound.');
  }
}

/**
 * @param {unknown} value
 * @param {readonly string[]} expectedKeys
 * @param {string} label
 * @returns {Record<string, unknown>}
 */
function shallowExactDataRecord(value, expectedKeys, label) {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || utilTypes.isProxy(value)) {
    throw new Error(`${label} must use the exact shallow data shape.`);
  }
  const prototype = Object.getPrototypeOf(value);
  const ownKeys = Reflect.ownKeys(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${label} must use the exact shallow data shape.`);
  }
  const actualKeys = [];
  /** @type {Record<string, unknown>} */
  const result = {};
  for (const key of ownKeys) {
    if (typeof key !== 'string') {
      throw new Error(`${label} must use the exact shallow data shape.`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || descriptor.enumerable !== true || !Object.hasOwn(descriptor, 'value')) {
      throw new Error(`${label} must use the exact shallow data shape.`);
    }
    actualKeys.push(key);
    result[key] = descriptor.value;
  }
  actualKeys.sort();
  const expected = [...expectedKeys].sort();
  if (actualKeys.length !== expected.length || actualKeys.some((key, index) => key !== expected[index])) {
    throw new Error(`${label} must use the exact shallow data shape.`);
  }
  return result;
}

/**
 * @param {unknown} value
 * @param {AppImageSignatureVerifierCandidateState} desired
 * @returns {AppImageSignatureVerifierMutableFunction}
 */
function admitMutableFunction(value, desired) {
  const mutableFunction = requireExactKeys(value, MUTABLE_FUNCTION_KEYS, 'App verifier mutable function');
  admitCommonObservedFunction(mutableFunction, 'App verifier mutable function');
  if (
    mutableFunction['functionArn'] !== desired['functionArn'] ||
    mutableFunction['functionName'] !== desired['functionName']
  ) {
    throw new Error('App verifier mutable function is detached from the reviewed target.');
  }
  if (
    typeof mutableFunction['lastUpdateStatus'] !== 'string' ||
    !['Failed', 'InProgress', 'Successful'].includes(mutableFunction['lastUpdateStatus'])
  ) {
    throw new Error('App verifier mutable function LastUpdateStatus is invalid.');
  }
  return /** @type {AppImageSignatureVerifierMutableFunction} */ (mutableFunction);
}

/**
 * @param {unknown} value
 * @param {AppImageSignatureVerifierCandidateState} desired
 * @returns {AppImageSignatureVerifierImmutableFunction}
 */
function admitImmutableFunction(value, desired) {
  const immutableFunction = requireExactKeys(value, IMMUTABLE_FUNCTION_KEYS, 'App verifier immutable function');
  admitCommonObservedFunction(immutableFunction, 'App verifier immutable function');
  const functionVersion = requireFunctionVersion(
    immutableFunction['functionVersion'],
    'App verifier immutable FunctionVersion',
  );
  if (
    immutableFunction['functionName'] !== desired['functionName'] ||
    immutableFunction['functionArn'] !== `${desired['functionArn']}:${functionVersion}`
  ) {
    throw new Error('App verifier immutable function qualified ARN is invalid.');
  }
  if (immutableFunction['state'] !== 'Active') {
    throw new Error('App verifier immutable function must be Active.');
  }
  return /** @type {AppImageSignatureVerifierImmutableFunction} */ (immutableFunction);
}

/** @param {Record<string, unknown>} value @param {string} label */
function admitCommonObservedFunction(value, label) {
  requireOptionalBase64Sha256(value['awsConfigSha256'], `${label} AWS ConfigSha256`);
  requireString(value['awsRevisionId'], `${label} AWS RevisionId`);
  requireBase64Sha256(value['codeSha256'], `${label} Lambda CodeSha256`);
  if (typeof value['description'] !== 'string') throw new Error(`${label} description is invalid.`);
  requireString(value['functionArn'], `${label} ARN`);
  requireString(value['functionName'], `${label} name`);
  requireString(value['lastModified'], `${label} LastModified`);
  if (typeof value['state'] !== 'string' || !['Active', 'Failed', 'Inactive', 'Pending'].includes(value['state'])) {
    throw new Error(`${label} State is invalid.`);
  }
  const configuration = admitConfigurationAuthority(value['functionConfigurationAuthority'], `${label} configuration`);
  const configurationSha256 = parseSha256(value['functionConfigurationSha256'], `${label} configuration SHA-256`);
  if (canonicalJsonSha256(configuration) !== configurationSha256) {
    throw new Error(`${label} configuration SHA-256 does not bind its exact authority.`);
  }
  admitOptionalResolvedS3Object(value['resolvedS3Object'], `${label} resolved S3 object`);
}

/**
 * @param {unknown} value
 * @param {'preflight' | 'runtime'} name
 * @param {unknown} functionArn
 * @returns {AppImageSignatureVerifierObservedAlias}
 */
function admitObservedAlias(value, name, functionArn) {
  const alias = requireExactKeys(value, OBSERVED_ALIAS_KEYS, `App verifier ${name} alias observation`);
  if (alias['name'] !== name || alias['aliasArn'] !== `${functionArn}:${name}`) {
    throw new Error(`App verifier ${name} alias observation is detached from the reviewed function.`);
  }
  requireString(alias['awsRevisionId'], `App verifier ${name} alias AWS RevisionId`);
  if (typeof alias['description'] !== 'string') throw new Error(`App verifier ${name} alias description is invalid.`);
  requireFunctionVersion(alias['functionVersion'], `App verifier ${name} alias FunctionVersion`);
  const weights = requireExactKeys(alias['routingWeights'], [], `App verifier ${name} alias routing weights`);
  if (Object.keys(weights).length !== 0) {
    throw new Error(`App verifier ${name} alias routing weights must be empty.`);
  }
  return /** @type {AppImageSignatureVerifierObservedAlias} */ (alias);
}

/**
 * @param {readonly AppImageSignatureVerifierImmutableFunction[]} items
 * @returns {AppImageSignatureVerifierImmutableFunction | null}
 */
function highestImmutableFunction(items) {
  /** @type {AppImageSignatureVerifierImmutableFunction | null} */
  let selected = null;
  /** @type {null | bigint} */
  let selectedValue = null;
  for (const item of items) {
    const numericValue = BigInt(String(item['functionVersion']));
    if (selectedValue === null || numericValue > selectedValue) {
      selected = item;
      selectedValue = numericValue;
    }
  }
  return selected;
}

/**
 * @param {AppImageSignatureVerifierImmutableFunction} candidate
 * @param {AppImageSignatureVerifierMutableFunction} mutableFunction
 * @param {AppImageSignatureVerifierCandidateState} desired
 */
function isCandidateFunction(candidate, mutableFunction, desired) {
  const desiredPackage = desired.package;
  return (
    candidate['state'] === 'Active' &&
    candidate['description'] === '' &&
    candidate['codeSha256'] === desiredPackage['codeSha256'] &&
    matchesOptionalNativePair(candidate['awsConfigSha256'], mutableFunction['awsConfigSha256']) &&
    candidate['functionConfigurationSha256'] === desired['functionConfigurationSha256'] &&
    isDeepStrictEqual(candidate['functionConfigurationAuthority'], desired['functionConfigurationAuthority']) &&
    matchesOptionalObservation(candidate['resolvedS3Object'], projectResolvedS3Object(desiredPackage))
  );
}

/**
 * @param {AppImageSignatureVerifierAliasTarget} target
 * @param {AppImageSignatureVerifierImmutableFunction} reconciledFunction
 * @param {readonly AppImageSignatureVerifierImmutableFunction[]} immutableFunctions
 * @returns {AppImageSignatureVerifierImmutableFunction}
 */
function resolveAliasTarget(target, reconciledFunction, immutableFunctions) {
  if (target.kind === 'reconciled-function') return reconciledFunction;
  const exactFunction = target.function;
  const selected = immutableFunctions.find((item) => item.functionVersion === exactFunction.functionVersion);
  if (selected === undefined || !matchesExactFunction(selected, exactFunction)) {
    throw new Error('App verifier retained runtime function is absent or mismatched.');
  }
  return selected;
}

/**
 * @param {AppImageSignatureVerifierImmutableFunction} observed
 * @param {AppImageSignatureVerifierExactFunction} exact
 */
function matchesExactFunction(observed, exact) {
  if (!EXACT_OBSERVED_FUNCTION_KEYS.every((key) => isDeepStrictEqual(observed[key], exact[key]))) {
    return false;
  }
  if (
    !matchesOptionalNativePair(observed['awsConfigSha256'], exact['awsConfigSha256']) ||
    !matchesOptionalObservation(observed['resolvedS3Object'], exact['resolvedS3Object'])
  ) {
    return false;
  }
  const environment = observed.functionConfigurationAuthority.environment;
  return (
    Buffer.from(String(observed['codeSha256']), 'base64').toString('hex') === exact['zipSha256'] &&
    environment['IMAGE_SIGNATURE_VERIFIER_EXPECTED_ASSET_MANIFEST_SHA256'] === exact['assetManifestSha256'] &&
    environment['IMAGE_SIGNATURE_VERIFIER_EXPECTED_TRUST_ROOT_SHA256'] === exact['trustRootSha256']
  );
}

/**
 * @param {AppImageSignatureVerifierPackage} verifierPackage
 * @returns {AppImageSignatureVerifierResolvedS3Object}
 */
function projectResolvedS3Object(verifierPackage) {
  return {
    s3Bucket: verifierPackage['s3Bucket'],
    s3Key: verifierPackage['s3Key'],
    s3ObjectVersionId: verifierPackage['s3ObjectVersionId'],
  };
}

/**
 * @param {AppImageSignatureVerifierConfigurationAuthority} configuration
 * @returns {AppImageSignatureVerifierConfigurationUpdate}
 */
function projectFunctionConfigurationUpdate(configuration) {
  return /** @type {AppImageSignatureVerifierConfigurationUpdate} */ (
    Object.fromEntries(FUNCTION_CONFIGURATION_UPDATE_KEYS.map((key) => [key, configuration[key]]))
  );
}

/** Only the service observation may be absent; desired authority remains exact. @param {unknown} observed @param {unknown} expected */
function matchesOptionalObservation(observed, expected) {
  return observed === null || isDeepStrictEqual(observed, expected);
}

/** Compare two service-native observations whenever both were returned. @param {unknown} left @param {unknown} right */
function matchesOptionalNativePair(left, right) {
  return left === null || right === null || isDeepStrictEqual(left, right);
}

/**
 * @param {unknown} value
 * @param {string} label
 * @returns {Base64Sha256 | null}
 */
function requireOptionalBase64Sha256(value, label) {
  return value === null ? null : requireBase64Sha256(value, label);
}

/**
 * @param {unknown} value
 * @param {string} label
 * @returns {AppImageSignatureVerifierResolvedS3Object | null}
 */
function admitOptionalResolvedS3Object(value, label) {
  return value === null ? null : admitResolvedS3Object(value, label);
}

/**
 * @param {unknown} value
 * @param {string} label
 * @returns {Base64Sha256}
 */
function requireBase64Sha256(value, label) {
  if (typeof value !== 'string' || !BASE64_SHA256_PATTERN.test(value)) {
    throw new Error(`${label} must be one canonical base64-encoded SHA-256.`);
  }
  const decoded = Buffer.from(value, 'base64');
  if (decoded.byteLength !== 32 || decoded.toString('base64') !== value) {
    throw new Error(`${label} must be one canonical base64-encoded SHA-256.`);
  }
  return /** @type {Base64Sha256} */ (value);
}

/**
 * @param {unknown} value
 * @param {string} label
 * @returns {LambdaFunctionVersion}
 */
function requireFunctionVersion(value, label) {
  if (typeof value !== 'string' || !POSITIVE_DECIMAL_PATTERN.test(value)) {
    throw new Error(`${label} must be a canonical positive decimal Lambda FunctionVersion.`);
  }
  BigInt(value);
  return /** @type {LambdaFunctionVersion} */ (value);
}

/** @param {unknown} value @param {string} label @returns {string[]} */
function requireDenseStringArray(value, label) {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string' || entry.length === 0)) {
    throw new Error(`${label} must be a dense string array.`);
  }
  return value;
}

/** @param {unknown} value @param {string} label */
function requireNullOrString(value, label) {
  if (value !== null) requireString(value, label);
}

/**
 * @param {unknown} value
 * @param {string} label
 * @param {number} minimum
 * @param {number} maximum
 * @returns {number}
 */
function requirePositiveInteger(value, label, minimum, maximum) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} must be an integer from ${minimum} through ${maximum}.`);
  }
  return value;
}

/**
 * @param {unknown} value
 * @param {string} label
 * @param {number} minimum
 * @param {number} maximum
 * @returns {number}
 */
function requireDecimalInteger(value, label, minimum, maximum) {
  if (typeof value !== 'string' || !/^(?:0|[1-9][0-9]*)$/u.test(value)) {
    throw new Error(`${label} is invalid.`);
  }
  const parsed = Number(value);
  return requirePositiveInteger(parsed, label, minimum, maximum);
}
