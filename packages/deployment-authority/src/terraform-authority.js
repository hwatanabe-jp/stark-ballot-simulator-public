/**
 * Pure Terraform authority validators shared by accepted deployment lanes.
 */

/**
 * @typedef {'bootstrap' | 'foundation' | 'app'} TerraformRoot
 */

/**
 * @typedef {'ssm-parameter' | 'secrets-manager-secret'} TerraformSecretReferenceSource
 */

/**
 * @typedef {{
    readonly inputName: string;
    readonly source: TerraformSecretReferenceSource;
    readonly reference: string;
}} TerraformSecretReference
 */

/**
 * @typedef {{
    readonly path: string;
    readonly sha256: string;
    readonly contentBase64: string;
}} TerraformNonsecretInputFile
 */

/**
 * @typedef {{
    readonly evidenceType: 'terraform-baseline-nonsecret-inputs';
    readonly root: TerraformRoot;
    readonly files: readonly TerraformNonsecretInputFile[];
    readonly secretValuesIncluded: false;
}} TerraformNonsecretInputs
 */

/**
 * @typedef {{
    readonly bucketName: string;
    readonly backendKey: string;
    readonly kmsKeyArn: string;
    readonly region: string;
}} TerraformBackendAuthority
 */

/**
 * @typedef {{
    readonly deploymentMode?: 'normal' | 'rollback';
    readonly stateBucketName?: string;
    readonly stateKmsAlias?: string;
    readonly stateKmsKeyArn?: string;
    readonly terraformVersion?: string;
}} TerraformInputIdentityOptions
 */

/**
 * @typedef {'terraformPlanProject' | 'appSignaturePreflightPlanProject'} CodeBuildRuntimeProjectKey
 */

/**
 * @typedef {{
    readonly projectKey: CodeBuildRuntimeProjectKey;
}} CodeBuildRuntimeEvidenceOptions
 */

/**
 * @typedef {{
    readonly evidenceType: 'codebuild-runtime';
    readonly targetKey: import('./index.js').DeploymentTargetKey;
    readonly lane: TerraformRoot;
    readonly stateIdentity: string;
    readonly sourceSha: string;
    readonly project: {
        readonly key: CodeBuildRuntimeProjectKey;
        readonly name: string;
        readonly arn: string;
        readonly buildId: string;
    };
    readonly runtime: {
        readonly configuredImage: string;
        readonly observedImage: string;
        readonly computeType: 'BUILD_GENERAL1_SMALL';
        readonly environmentType: 'LINUX_CONTAINER';
        readonly privilegedMode: false;
    };
}} CodeBuildRuntimeEvidence
 */

/**
 * @typedef {{
    readonly terraformVersion: string;
    readonly platform: 'linux_amd64';
    readonly terraformOutdated: boolean;
    readonly providerSelections: Readonly<{
        'registry.terraform.io/hashicorp/aws': string;
    }>;
}} TerraformIdentityEvidence
 */

/**
 * @typedef {TerraformNonsecretInputFile & {readonly body: string}} ParsedTerraformNonsecretInputFile
 */

import { createHash } from 'node:crypto';
import {
  canonicalRecordJson,
  deepFreeze,
  isPlainRecord,
  parseSha256,
  requireExactKeys,
  requireGroupedLowercaseUuid,
  requireString,
} from './internal.js';
import { parseDeploymentLaneContext, resolveAllowedDeploymentTarget, resolveDeploymentLaneAuthority } from './index.js';
import { isManagedCodeBuildImageIdentifier } from './source-path-build-authority.js';

const TERRAFORM_VERSION_PATTERN = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/u;
const AWS_PROVIDER_ADDRESS = 'registry.terraform.io/hashicorp/aws';
const CANONICAL_BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;
const S3_BUCKET_NAME_PATTERN = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/u;
const KMS_KEY_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const NONSECRET_INPUT_KEYS = ['evidenceType', 'files', 'root', 'secretValuesIncluded'];
const NONSECRET_INPUT_FILE_KEYS = ['contentBase64', 'path', 'sha256'];
const CODEBUILD_RUNTIME_KEYS = [
  'evidenceType',
  'lane',
  'project',
  'runtime',
  'sourceSha',
  'stateIdentity',
  'targetKey',
];
const CODEBUILD_RUNTIME_PROJECT_KEYS = ['arn', 'buildId', 'key', 'name'];
const CODEBUILD_RUNTIME_CONFIGURATION_KEYS = [
  'computeType',
  'configuredImage',
  'environmentType',
  'observedImage',
  'privilegedMode',
];
const TERRAFORM_IDENTITY_KEYS = ['platform', 'provider_selections', 'terraform_outdated', 'terraform_version'];
const TERRAFORM_BACKEND_AUTHORITY_KEYS = ['backendKey', 'bucketName', 'kmsKeyArn', 'region'];
const MAX_NONSECRET_INPUT_BYTES = 1024 * 1024;
const BOOTSTRAP_INPUT_KEYS = [
  'account_alias',
  'aws_account_id',
  'aws_region',
  'backend_principal_arns',
  'control_source_sha',
  'deployment_environment',
  'development_app_cloudfront_acm_certificate_arn',
  'development_app_public_hostname',
  'enable_development_app_pipeline',
  'enable_development_foundation_pipeline',
  'enable_development_pipeline',
  'github_full_repository_id',
  'project_name',
  'protected_production_aws_account_id',
  'source_branch',
  'state_backend_key',
  'state_bucket_name',
  'state_kms_alias',
  'state_kms_key_id',
  'state_scope',
  'terraform_version',
];
const FOUNDATION_INPUT_KEYS = [
  'account_alias',
  'aws_account_id',
  'aws_region',
  'deployment_environment',
  'project_name',
  'public_hostname_disposition',
  'state_backend_key',
  'state_scope',
];
const APP_INPUT_KEYS = [
  'account_alias',
  'app_source_sha',
  'aws_account_id',
  'aws_region',
  'cloudfront_acm_certificate_arn',
  'deploy_mode',
  'deployment_environment',
  'deployment_id',
  'develop_operator_gate_enabled',
  'enable_dynamodb_deletion_protection',
  'expected_image_id',
  'fargate_vcpu_alarm_threshold',
  'image_id_mapping_evidence',
  'image_signature_preflight_prover_image_uri',
  'image_signature_status_attempt_timeout_ms',
  'image_signature_status_max_attempts',
  'image_signature_status_retry_delay_ms',
  'image_signature_verifier_base_prover_image_uri',
  'image_signature_verifier_handler_deadline_ms',
  'image_signature_verifier_lambda_timeout_seconds',
  'image_signature_verifier_permissions_boundary_arn',
  'image_signature_verifier_process_timeout_ms',
  'image_signature_verifier_reconciliation_desired_json',
  'image_signature_verifier_reconciliation_desired_sha256',
  'image_signature_verifier_reconciled_function_version',
  'image_signature_verifier_selected_authority',
  'image_signature_verifier_step_timeout_seconds',
  'lambda_artifacts',
  'lambda_runtime',
  'project_name',
  'proof_artifact_lifecycle_days',
  'prover_cpu',
  'prover_image_uri',
  'prover_max_concurrent_provers',
  'prover_memory',
  'prover_security_group_ids',
  'prover_subnet_ids',
  'prover_task_timeout_seconds',
  'public_hostname',
  'public_hostname_disposition',
  'session_live_ttl_seconds',
  'state_backend_key',
  'state_scope',
  'verification_artifact_ttl_seconds',
  'verifier_public_base_url',
  'verifier_service_bin_path',
  'vote_duplicate_detector_ttl_seconds',
];
const RECOVERY_INPUT_KEYS = ['dynamodb_recovery_activation', 'dynamodb_recovery_phase'];
const APP_STORED_INPUT_KEYS = [...APP_INPUT_KEYS, ...RECOVERY_INPUT_KEYS].sort();
const LAMBDA_ARTIFACT_NAMES = [
  'finalization_writer',
  'image_signature_verifier',
  'proof_dispatcher',
  'public_api',
  'semaphore_janitor',
  'verification_worker',
];
const LAMBDA_ARTIFACT_KEYS = [
  'asset_manifest_sha256',
  's3_bucket',
  's3_key',
  's3_object_version',
  'source_code_hash',
  'trust_root_sha256',
];
const LAMBDA_ARTIFACT_OPTIONAL_KEYS = ['asset_manifest_sha256', 'trust_root_sha256'];
const LAMBDA_ARTIFACT_REQUIRED_KEYS = LAMBDA_ARTIFACT_KEYS.filter(
  (key) => !LAMBDA_ARTIFACT_OPTIONAL_KEYS.includes(key),
);
const IMAGE_ID_MAPPING_INPUT_KEYS = [
  'current_method_version',
  'current_method_version_key',
  'expected_image_id',
  'mapping_path',
  'mapping_sha256',
  'variant',
];
const RECOVERY_ACTIVATION_KEYS = [
  'account_alias',
  'account_id',
  'deployment_environment',
  'kms_key_arn',
  'manifest_sha256',
  'manifest_type',
  'recovery_id',
  'recovery_point',
  'region',
  'sessions',
  'validation_status',
  'votes',
];
const RECOVERY_SESSIONS_KEYS = ['key_schema', 'source_table_arn', 'table_arn', 'table_name'];
const RECOVERY_VOTES_KEYS = ['key_schema', 'source_table_arn', 'table_arn', 'table_name', 'vote_id_index_schema'];
const SELECTED_VERIFIER_AUTHORITY_KEYS = [
  'architecture',
  'environment_sha256',
  'execution_role_arn',
  'execution_role_assume_policy_sha256',
  'execution_role_permissions_boundary_arn',
  'execution_role_permissions_boundary_policy_sha256',
  'execution_role_policy_sha256',
  'function_arn',
  'function_configuration_sha256',
  'function_version',
  'package',
  'preflight_alias_arn',
  'runtime',
  'runtime_alias_arn',
  'timeout_seconds',
];
const SELECTED_VERIFIER_PACKAGE_KEYS = [
  'asset_manifest_sha256',
  's3_bucket',
  's3_key',
  's3_object_version',
  'source_code_hash',
  'trust_root_sha256',
];

/**
 * @param {unknown} value
 * @param {readonly string[]} expectedKeys
 * @param {string} label
 * @returns {Record<string, unknown>}
 */
function exactKeys(value, expectedKeys, label) {
  try {
    return requireExactKeys(value, expectedKeys, label);
  } catch (error) {
    if (!isPlainRecord(value)) {
      throw new Error(`${label} must be an object.`, { cause: error });
    }
    throw new Error(`${label} must use the exact current shape.`, { cause: error });
  }
}

/**
 * @param {unknown} value
 */
function parseRoot(value) {
  if (value !== 'bootstrap' && value !== 'foundation' && value !== 'app') {
    throw new Error('Terraform baseline root must be bootstrap, foundation, or app.');
  }
  return value;
}

/**
 * @param {TerraformRoot} rootValue
 * @param {unknown} contextValue
 * @returns {readonly TerraformSecretReference[]}
 */
export function buildTerraformBaselineSecretReferences(rootValue, contextValue) {
  const root = parseRoot(rootValue);
  const context = parseDeploymentLaneContext(contextValue);
  if (context.root.lane !== root || context.root.scope !== root) {
    throw new Error('Terraform baseline secret-reference context does not match its root.');
  }
  if (root !== 'app') {
    return deepFreeze([]);
  }
  return deepFreeze([
    {
      inputName: 'api_origin_verify_header',
      source: 'secrets-manager-secret',
      reference: `${context.names.runtimeSecretReferencePrefix}/expected-origin-verify-header`,
    },
    {
      inputName: 'verification_invariant_email',
      source: 'ssm-parameter',
      reference: `/${context.project.stateNamespace}/observability/invariant-email/endpoint`,
    },
    {
      inputName: 'ops_actionable_email',
      source: 'ssm-parameter',
      reference: `/${context.project.stateNamespace}/observability/ops-actionable-email/endpoint`,
    },
  ]);
}

/**
 * @param {unknown} value
 * @param {TerraformRoot} rootValue
 * @param {unknown} targetKeyValue
 * @returns {TerraformBackendAuthority}
 */
export function validateTerraformBackendAuthority(value, rootValue, targetKeyValue) {
  const target = resolveAllowedDeploymentTarget(requireString(targetKeyValue, 'Terraform backend deployment target'));
  const record = exactKeys(value, TERRAFORM_BACKEND_AUTHORITY_KEYS, 'Terraform backend authority');
  const root = parseRoot(rootValue);
  const authority = resolveDeploymentLaneAuthority(target, root);
  const bucketName = requireString(record['bucketName'], 'Terraform backend state bucket');
  const backendKey = requireString(record['backendKey'], 'Terraform backend state key');
  const kmsKeyArn = requireString(record['kmsKeyArn'], 'Terraform backend KMS key ARN');
  const region = requireString(record['region'], 'Terraform backend region');
  const expectedKmsPrefix = `arn:${target.partition}:kms:${target.region}:${target.accountId}:key/`;
  if (
    !S3_BUCKET_NAME_PATTERN.test(bucketName) ||
    bucketName.includes('..') ||
    backendKey !== authority.backendKey ||
    region !== target.region ||
    !kmsKeyArn.startsWith(expectedKmsPrefix) ||
    !KMS_KEY_ID_PATTERN.test(kmsKeyArn.slice(expectedKmsPrefix.length))
  ) {
    throw new Error('Terraform backend authority does not match its deployment target and state.');
  }
  return deepFreeze({ bucketName, backendKey: authority.backendKey, kmsKeyArn, region: target.region });
}

/**
 * @param {unknown} value
 * @param {string} label
 * @returns {string}
 */
function parseChecksum(value, label) {
  try {
    return parseSha256(value, label);
  } catch (error) {
    throw new Error(`${label} is invalid.`, { cause: error });
  }
}

/**
 * @param {unknown} value
 * @param {string} label
 * @returns {unknown[]}
 */
function parseDenseArray(value, label) {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array.`);
  }
  const ownKeys = Reflect.ownKeys(value);
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
  if (
    lengthDescriptor === undefined ||
    !Object.hasOwn(lengthDescriptor, 'value') ||
    ownKeys.length !== value.length + 1
  ) {
    throw new Error(`${label} must be a dense array.`);
  }
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || descriptor.enumerable !== true || !Object.hasOwn(descriptor, 'value')) {
      throw new Error(`${label} must be a dense array.`);
    }
  }
  return value;
}

/**
 * @param {unknown} value
 * @returns {ParsedTerraformNonsecretInputFile}
 */
function parseNonsecretInputFile(value) {
  const record = exactKeys(value, NONSECRET_INPUT_FILE_KEYS, 'Terraform baseline nonsecret input file');
  if (
    typeof record['path'] !== 'string' ||
    record['path'].length === 0 ||
    record['path'].startsWith('/') ||
    record['path'].includes('..')
  ) {
    throw new Error('Terraform baseline nonsecret input path is invalid.');
  }
  const sha256 = parseChecksum(record['sha256'], 'Terraform baseline nonsecret input SHA-256');
  if (
    typeof record['contentBase64'] !== 'string' ||
    record['contentBase64'].length === 0 ||
    !CANONICAL_BASE64_PATTERN.test(record['contentBase64'])
  ) {
    throw new Error('Terraform baseline nonsecret input content is invalid.');
  }
  const body = Buffer.from(record['contentBase64'], 'base64');
  if (
    body.length === 0 ||
    body.length > MAX_NONSECRET_INPUT_BYTES ||
    body.includes(0) ||
    body.toString('base64') !== record['contentBase64']
  ) {
    throw new Error('Terraform baseline nonsecret input content is invalid.');
  }
  if (createHash('sha256').update(body).digest('hex') !== sha256) {
    throw new Error('Terraform baseline nonsecret input content hash is invalid.');
  }
  let decodedBody;
  try {
    decodedBody = new TextDecoder('utf-8', { fatal: true }).decode(body);
  } catch (error) {
    throw new Error('Terraform baseline nonsecret input content is not valid UTF-8.', { cause: error });
  }
  return {
    path: record['path'],
    sha256,
    contentBase64: record['contentBase64'],
    body: decodedBody,
  };
}

/**
 * @param {string} body
 * @param {readonly string[]} expectedKeys
 * @param {string} label
 * @returns {Record<string, unknown>}
 */
function parseCanonicalJsonInputs(body, expectedKeys, label) {
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch (error) {
    throw new Error(`${label} must be valid JSON.`, { cause: error });
  }
  exactKeys(parsed, expectedKeys, label);
  if (body !== canonicalRecordJson(parsed)) {
    throw new Error(`${label} must use canonical JSON bytes.`);
  }
  return parsed;
}

/**
 * @param {unknown} value
 * @param {'boolean' | 'number' | 'string'} type
 * @param {string} label
 * @param {{nullable?: boolean}} [options]
 */
function requireValueType(value, type, label, { nullable = false } = {}) {
  if ((nullable && value === null) || typeof value === type) {
    return;
  }
  throw new Error(`${label} has an invalid value type.`);
}

/**
 * @param {unknown} value
 * @param {string} label
 */
function requireStringArray(value, label) {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new Error(`${label} must be an array of strings.`);
  }
}

/**
 * @param {Record<string, unknown>} value
 */
function validateBootstrapInputValues(value) {
  for (const key of BOOTSTRAP_INPUT_KEYS) {
    if (key === 'backend_principal_arns') {
      requireStringArray(value[key], `Bootstrap Terraform baseline ${key}`);
    } else if (key.startsWith('enable_')) {
      requireValueType(value[key], 'boolean', `Bootstrap Terraform baseline ${key}`);
    } else if (
      key === 'development_app_cloudfront_acm_certificate_arn' ||
      key === 'protected_production_aws_account_id'
    ) {
      requireValueType(value[key], 'string', `Bootstrap Terraform baseline ${key}`, { nullable: true });
    } else {
      requireValueType(value[key], 'string', `Bootstrap Terraform baseline ${key}`);
    }
  }
}

/**
 * @param {Record<string, unknown>} value
 */
function validateFoundationInputValues(value) {
  for (const key of FOUNDATION_INPUT_KEYS) {
    requireValueType(value[key], 'string', `Foundation Terraform baseline ${key}`);
  }
}

/**
 * @param {unknown} value
 */
function validateLambdaArtifacts(value) {
  const artifacts = exactKeys(value, LAMBDA_ARTIFACT_NAMES, 'App Terraform baseline lambda_artifacts');
  for (const name of LAMBDA_ARTIFACT_NAMES) {
    const artifact = exactKeys(
      artifacts[name],
      LAMBDA_ARTIFACT_KEYS,
      `App Terraform baseline lambda_artifacts.${name}`,
    );
    for (const key of LAMBDA_ARTIFACT_KEYS) {
      const nullable = key === 'asset_manifest_sha256' || key === 'trust_root_sha256';
      requireValueType(artifact[key], 'string', `App Terraform baseline lambda_artifacts.${name}.${key}`, {
        nullable,
      });
    }
    if (
      name === 'image_signature_verifier' &&
      (artifact['asset_manifest_sha256'] === null || artifact['trust_root_sha256'] === null)
    ) {
      throw new Error('App Terraform baseline image-signature verifier artifact evidence is incomplete.');
    }
    if (
      name !== 'image_signature_verifier' &&
      (artifact['asset_manifest_sha256'] !== null || artifact['trust_root_sha256'] !== null)
    ) {
      throw new Error('App Terraform baseline non-verifier artifacts contain verifier-only evidence.');
    }
  }
}

/**
 * @param {unknown} value
 */
function projectSavedPlanLambdaArtifacts(value) {
  const artifacts = exactKeys(value, LAMBDA_ARTIFACT_NAMES, 'App Terraform baseline lambda_artifacts');
  return Object.fromEntries(
    LAMBDA_ARTIFACT_NAMES.map((name) => {
      const rawArtifact = artifacts[name];
      const presentOptionalKeys = isPlainRecord(rawArtifact)
        ? LAMBDA_ARTIFACT_OPTIONAL_KEYS.filter((key) => Object.hasOwn(rawArtifact, key))
        : [];
      const artifact = exactKeys(
        rawArtifact,
        [...LAMBDA_ARTIFACT_REQUIRED_KEYS, ...presentOptionalKeys],
        `App Terraform baseline lambda_artifacts.${name}`,
      );
      return [
        name,
        {
          asset_manifest_sha256: Object.hasOwn(artifact, 'asset_manifest_sha256')
            ? artifact['asset_manifest_sha256']
            : null,
          s3_bucket: artifact['s3_bucket'],
          s3_key: artifact['s3_key'],
          s3_object_version: artifact['s3_object_version'],
          source_code_hash: artifact['source_code_hash'],
          trust_root_sha256: Object.hasOwn(artifact, 'trust_root_sha256') ? artifact['trust_root_sha256'] : null,
        },
      ];
    }),
  );
}

/**
 * @param {unknown} value
 */
function validateRecoveryActivation(value) {
  if (value === null) {
    return;
  }
  const activation = exactKeys(value, RECOVERY_ACTIVATION_KEYS, 'App Terraform baseline recovery activation');
  for (const key of RECOVERY_ACTIVATION_KEYS.filter((key) => key !== 'sessions' && key !== 'votes')) {
    requireValueType(activation[key], 'string', `App Terraform baseline recovery activation ${key}`);
  }
  const sessions = exactKeys(
    activation['sessions'],
    RECOVERY_SESSIONS_KEYS,
    'App Terraform baseline recovery sessions',
  );
  const votes = exactKeys(activation['votes'], RECOVERY_VOTES_KEYS, 'App Terraform baseline recovery votes');
  /** @type {Array<[string, Record<string, unknown>]>} */
  const recoveryRecords = [
    ['sessions', sessions],
    ['votes', votes],
  ];
  for (const [label, record] of recoveryRecords) {
    for (const [key, entry] of Object.entries(record)) {
      requireValueType(entry, 'string', `App Terraform baseline recovery ${label}.${key}`);
    }
  }
}

/**
 * @param {unknown} value
 */
function validateSelectedVerifierAuthority(value) {
  if (value === null) {
    return;
  }
  const authority = exactKeys(
    value,
    SELECTED_VERIFIER_AUTHORITY_KEYS,
    'App Terraform baseline selected verifier authority',
  );
  for (const key of SELECTED_VERIFIER_AUTHORITY_KEYS.filter((key) => key !== 'package' && key !== 'timeout_seconds')) {
    requireValueType(authority[key], 'string', `App Terraform baseline selected verifier authority ${key}`);
  }
  requireValueType(
    authority['timeout_seconds'],
    'number',
    'App Terraform baseline selected verifier authority timeout_seconds',
  );
  const packageValue = exactKeys(
    authority['package'],
    SELECTED_VERIFIER_PACKAGE_KEYS,
    'App Terraform baseline selected verifier package',
  );
  for (const [key, entry] of Object.entries(packageValue)) {
    requireValueType(entry, 'string', `App Terraform baseline selected verifier package ${key}`);
  }
}

/**
 * @param {Record<string, unknown>} value
 */
function validateAppInputValues(value) {
  const booleanKeys = ['develop_operator_gate_enabled', 'enable_dynamodb_deletion_protection'];
  const numberKeys = [
    'fargate_vcpu_alarm_threshold',
    'image_signature_status_attempt_timeout_ms',
    'image_signature_status_max_attempts',
    'image_signature_status_retry_delay_ms',
    'image_signature_verifier_handler_deadline_ms',
    'image_signature_verifier_lambda_timeout_seconds',
    'image_signature_verifier_process_timeout_ms',
    'image_signature_verifier_step_timeout_seconds',
    'proof_artifact_lifecycle_days',
    'prover_cpu',
    'prover_max_concurrent_provers',
    'prover_memory',
    'prover_task_timeout_seconds',
    'session_live_ttl_seconds',
    'verification_artifact_ttl_seconds',
    'vote_duplicate_detector_ttl_seconds',
  ];
  const stringKeys = APP_INPUT_KEYS.filter(
    (key) =>
      ![
        'cloudfront_acm_certificate_arn',
        ...booleanKeys,
        ...numberKeys,
        'image_id_mapping_evidence',
        'image_signature_preflight_prover_image_uri',
        'image_signature_verifier_base_prover_image_uri',
        'image_signature_verifier_reconciliation_desired_json',
        'image_signature_verifier_reconciliation_desired_sha256',
        'image_signature_verifier_reconciled_function_version',
        'image_signature_verifier_selected_authority',
        'lambda_artifacts',
        'prover_security_group_ids',
        'prover_subnet_ids',
      ].includes(key),
  );
  for (const key of stringKeys) {
    requireValueType(value[key], 'string', `App Terraform baseline ${key}`);
  }
  for (const key of [
    'cloudfront_acm_certificate_arn',
    'image_signature_preflight_prover_image_uri',
    'image_signature_verifier_base_prover_image_uri',
    'image_signature_verifier_reconciliation_desired_json',
    'image_signature_verifier_reconciliation_desired_sha256',
    'image_signature_verifier_reconciled_function_version',
  ]) {
    requireValueType(value[key], 'string', `App Terraform baseline ${key}`, { nullable: true });
  }
  for (const key of booleanKeys) {
    requireValueType(value[key], 'boolean', `App Terraform baseline ${key}`);
  }
  for (const key of numberKeys) {
    requireValueType(value[key], 'number', `App Terraform baseline ${key}`);
  }
  requireStringArray(value['prover_security_group_ids'], 'App Terraform baseline prover_security_group_ids');
  requireStringArray(value['prover_subnet_ids'], 'App Terraform baseline prover_subnet_ids');
  const mapping = exactKeys(
    value['image_id_mapping_evidence'],
    IMAGE_ID_MAPPING_INPUT_KEYS,
    'App Terraform baseline image_id_mapping_evidence',
  );
  for (const key of IMAGE_ID_MAPPING_INPUT_KEYS) {
    requireValueType(
      mapping[key],
      key === 'current_method_version' ? 'number' : 'string',
      `App Terraform baseline image_id_mapping_evidence.${key}`,
    );
  }
  validateLambdaArtifacts(value['lambda_artifacts']);
  const desiredJson = value['image_signature_verifier_reconciliation_desired_json'];
  const desiredSha256 = value['image_signature_verifier_reconciliation_desired_sha256'];
  const reconciledFunctionVersion = value['image_signature_verifier_reconciled_function_version'];
  if (
    [desiredJson, desiredSha256, reconciledFunctionVersion].every((entry) => entry === null) === false &&
    [desiredJson, desiredSha256, reconciledFunctionVersion].every((entry) => typeof entry === 'string') === false
  ) {
    throw new Error('App Terraform baseline verifier reconciliation authority must be wholly null or present.');
  }
  if (typeof desiredJson === 'string') {
    if (
      Buffer.byteLength(desiredJson, 'utf8') > 256 * 1024 ||
      createHash('sha256').update(desiredJson).digest('hex') !== desiredSha256
    ) {
      throw new Error('App Terraform baseline verifier reconciliation desired JSON hash is invalid.');
    }
    try {
      const parsed = JSON.parse(desiredJson);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new Error('not a record');
      }
    } catch {
      throw new Error('App Terraform baseline verifier reconciliation desired JSON is invalid.');
    }
    parseSha256(desiredSha256, 'App Terraform baseline verifier reconciliation desired SHA-256');
    requireString(
      reconciledFunctionVersion,
      'App Terraform baseline verifier reconciled FunctionVersion',
      /^[1-9][0-9]*$/u,
    );
  }
  validateSelectedVerifierAuthority(value['image_signature_verifier_selected_authority']);
  validateRecoveryActivation(value['dynamodb_recovery_activation']);
  requireValueType(value['dynamodb_recovery_phase'], 'string', 'App Terraform baseline dynamodb_recovery_phase');
}

/**
 * @param {unknown} value
 * @returns {TerraformNonsecretInputs}
 */
export function validateTerraformBaselineNonsecretInputs(value) {
  const record = exactKeys(value, NONSECRET_INPUT_KEYS, 'Terraform baseline nonsecret inputs');
  if (record['evidenceType'] !== 'terraform-baseline-nonsecret-inputs') {
    throw new Error('Terraform baseline nonsecret input evidence type is invalid.');
  }
  const root = parseRoot(record['root']);
  if (record['secretValuesIncluded'] !== false) {
    throw new Error('Terraform baseline nonsecret inputs must exclude secret values.');
  }
  const parsedFiles = parseDenseArray(record['files'], 'Terraform baseline nonsecret input files').map(
    parseNonsecretInputFile,
  );
  const paths = parsedFiles.map(({ path }) => path);
  if (paths.length !== 1 || paths[0] !== 'pipeline.auto.tfvars.json') {
    const rootLabel = root === 'bootstrap' ? 'Bootstrap' : root === 'foundation' ? 'Foundation' : 'App';
    throw new Error(`${rootLabel} Terraform baseline reconstruction file set is invalid.`);
  }
  const inputFile = parsedFiles[0];
  if (inputFile === undefined) {
    throw new Error('Terraform baseline reconstruction file is missing.');
  }
  if (root === 'bootstrap') {
    const inputs = parseCanonicalJsonInputs(
      inputFile.body,
      BOOTSTRAP_INPUT_KEYS,
      'Bootstrap Terraform baseline inputs',
    );
    validateBootstrapInputValues(inputs);
  } else if (root === 'foundation') {
    const inputs = parseCanonicalJsonInputs(
      inputFile.body,
      FOUNDATION_INPUT_KEYS,
      'Foundation Terraform baseline inputs',
    );
    validateFoundationInputValues(inputs);
  } else {
    const inputs = parseCanonicalJsonInputs(inputFile.body, APP_STORED_INPUT_KEYS, 'App Terraform baseline inputs');
    validateAppInputValues(inputs);
  }
  return deepFreeze({
    evidenceType: 'terraform-baseline-nonsecret-inputs',
    root,
    files: parsedFiles.map(({ path, sha256, contentBase64 }) => ({ path, sha256, contentBase64 })),
    secretValuesIncluded: false,
  });
}

/**
 * @param {TerraformRoot} rootValue
 * @param {unknown} terraformPlanDocument
 * @returns {TerraformNonsecretInputs}
 */
export function buildTerraformBaselineNonsecretInputs(rootValue, terraformPlanDocument) {
  const root = parseRoot(rootValue);
  if (!isPlainRecord(terraformPlanDocument) || !isPlainRecord(terraformPlanDocument['variables'])) {
    throw new Error('Terraform saved-plan JSON does not contain evaluated variables.');
  }
  const expectedKeys =
    root === 'bootstrap' ? BOOTSTRAP_INPUT_KEYS : root === 'foundation' ? FOUNDATION_INPUT_KEYS : APP_STORED_INPUT_KEYS;
  for (const name of expectedKeys) {
    if (!Object.hasOwn(terraformPlanDocument['variables'], name)) {
      throw new Error(`Terraform saved plan is missing the admitted ${root} variable ${name}.`);
    }
  }
  const variables = exactKeys(
    terraformPlanDocument['variables'],
    expectedKeys,
    `Terraform saved-plan ${root} variables`,
  );
  /** @type {Record<string, unknown>} */
  const selected = {};
  for (const name of expectedKeys) {
    const variable = exactKeys(variables[name], ['value'], `Terraform saved-plan variable ${name}`);
    selected[name] =
      root === 'app' && name === 'lambda_artifacts'
        ? projectSavedPlanLambdaArtifacts(variable['value'])
        : variable['value'];
  }
  const body = canonicalRecordJson(selected);
  return validateTerraformBaselineNonsecretInputs({
    evidenceType: 'terraform-baseline-nonsecret-inputs',
    root,
    files: [
      {
        path: 'pipeline.auto.tfvars.json',
        sha256: createHash('sha256').update(body).digest('hex'),
        contentBase64: Buffer.from(body).toString('base64'),
      },
    ],
    secretValuesIncluded: false,
  });
}

/**
 * @param {TerraformNonsecretInputs} inputs
 * @returns {Record<string, unknown>}
 */
function decodedNonsecretInputValues(inputs) {
  const file = inputs.files[0];
  if (file === undefined) {
    throw new Error('Terraform baseline nonsecret input file is missing.');
  }
  const body = Buffer.from(file.contentBase64, 'base64').toString('utf8');
  return /** @type {Record<string, unknown>} */ (JSON.parse(body));
}

/**
 * @param {unknown} value
 * @returns {Readonly<Record<string, unknown>>}
 */
export function decodeTerraformBaselineNonsecretInputValues(value) {
  const inputs = validateTerraformBaselineNonsecretInputs(value);
  return deepFreeze(decodedNonsecretInputValues(inputs));
}

/**
 * @param {unknown} actual
 * @param {unknown} expected
 * @param {string} label
 */
function assertInputIdentity(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label} does not match the deployment context authority.`);
  }
}

/**
 * @param {unknown} hostname
 * @param {unknown} certificate
 * @param {import('./index.js').DeploymentLaneContext} context
 */
function validateTargetPublicHostnameInputs(hostname, certificate, context) {
  const certificatePattern = new RegExp(
    `^arn:${context.target.partition}:acm:us-east-1:${context.target.accountId}:certificate/[A-Za-z0-9-]+$`,
    'u',
  );
  if (certificate !== null && (typeof certificate !== 'string' || !certificatePattern.test(certificate))) {
    throw new Error('CloudFront ACM certificate must belong to the exact target account and partition in us-east-1.');
  }
  if (
    context.target.environmentId === 'main' &&
    (certificate === null ||
      typeof hostname !== 'string' ||
      hostname.toLowerCase() === 'develop.stark-ballot-sim.hwatanabe.dev' ||
      !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/u.test(
        hostname,
      ))
  ) {
    throw new Error(
      'Production requires an explicit public hostname and target-owned ACM certificate; the develop default is not admitted.',
    );
  }
}

/**
 * Validate the three operator-owned inputs shared by initialization and
 * accepted Bootstrap updates. All other values derive from reviewed authority.
 * @param {unknown} principals
 * @param {unknown} hostname
 * @param {unknown} certificate
 * @param {unknown} contextValue
 */
export function validateBootstrapOperatorInputIdentity(principals, hostname, certificate, contextValue) {
  const context = parseDeploymentLaneContext(contextValue);
  if (context.root.lane !== 'bootstrap') throw new Error('Bootstrap operator inputs require the Bootstrap lane.');
  const principalPattern = new RegExp(
    `^arn:${context.target.partition}:iam::${context.target.accountId}:role/[A-Za-z0-9+=,.@_/-]+$`,
    'u',
  );
  if (
    !Array.isArray(principals) ||
    principals.length === 0 ||
    principals.some((principal) => typeof principal !== 'string' || !principalPattern.test(principal))
  ) {
    throw new Error(
      'Bootstrap backend principals must be non-empty IAM roles in the exact target account and partition.',
    );
  }
  validateTargetPublicHostnameInputs(hostname, certificate, context);
}

/**
 * @param {unknown} value
 * @param {unknown} contextValue
 * @param {TerraformInputIdentityOptions} [options]
 * @returns {TerraformNonsecretInputs}
 */
export function validateTerraformBaselineInputIdentity(value, contextValue, options = {}) {
  const optionKeys = ['deploymentMode', 'stateBucketName', 'stateKmsAlias', 'stateKmsKeyArn', 'terraformVersion'];
  if (!isPlainRecord(options) || Object.keys(options).some((key) => !optionKeys.includes(key))) {
    throw new Error('Terraform baseline input-identity options are invalid.');
  }
  const inputs = validateTerraformBaselineNonsecretInputs(value);
  const context = parseDeploymentLaneContext(contextValue);
  if (inputs.root !== context.root.lane) {
    throw new Error('Terraform baseline inputs do not match the deployment-context root.');
  }
  const variables = decodedNonsecretInputValues(inputs);
  const commonIdentity = {
    account_alias: context.target.accountLabel,
    aws_account_id: context.target.accountId,
    aws_region: context.target.region,
    deployment_environment: context.target.environmentId,
    project_name: context.project.projectId,
    state_backend_key: context.root.backendKey,
    state_scope: context.root.scope,
  };
  for (const [name, expected] of Object.entries(commonIdentity)) {
    assertInputIdentity(variables[name], expected, `Terraform baseline input ${name}`);
  }

  if (inputs.root === 'bootstrap') {
    validateBootstrapOperatorInputIdentity(
      variables['backend_principal_arns'],
      variables['development_app_public_hostname'],
      variables['development_app_cloudfront_acm_certificate_arn'],
      context,
    );
    assertInputIdentity(
      variables['control_source_sha'],
      context.source.requestedControlSourceSha,
      'Bootstrap Terraform baseline control source',
    );
    assertInputIdentity(
      variables['github_full_repository_id'],
      context.source.repository,
      'Bootstrap Terraform baseline repository',
    );
    assertInputIdentity(
      variables['source_branch'],
      context.source.branch,
      'Bootstrap Terraform baseline source branch',
    );
    for (const name of [
      'enable_development_pipeline',
      'enable_development_foundation_pipeline',
      'enable_development_app_pipeline',
    ]) {
      assertInputIdentity(variables[name], true, `Bootstrap Terraform baseline input ${name}`);
    }
    if (
      typeof variables['terraform_version'] !== 'string' ||
      !TERRAFORM_VERSION_PATTERN.test(variables['terraform_version'])
    ) {
      throw new Error('Bootstrap Terraform baseline Terraform version is invalid.');
    }
    if (options.terraformVersion !== undefined) {
      assertInputIdentity(
        variables['terraform_version'],
        options.terraformVersion,
        'Bootstrap Terraform baseline Terraform version',
      );
    }
    if (options.stateBucketName !== undefined) {
      assertInputIdentity(
        variables['state_bucket_name'],
        options.stateBucketName,
        'Bootstrap Terraform baseline state bucket',
      );
    }
    if (options.stateKmsAlias !== undefined) {
      assertInputIdentity(
        variables['state_kms_alias'],
        options.stateKmsAlias,
        'Bootstrap Terraform baseline state KMS alias',
      );
    }
    if (options.stateKmsKeyArn !== undefined) {
      const keyId =
        typeof options.stateKmsKeyArn === 'string'
          ? options.stateKmsKeyArn.match(/^arn:aws:kms:[a-z0-9-]+:[0-9]{12}:key\/([0-9a-f-]{36})$/u)?.[1]
          : undefined;
      if (keyId === undefined) {
        throw new Error('Terraform baseline state KMS key ARN is invalid.');
      }
      assertInputIdentity(variables['state_kms_key_id'], keyId, 'Bootstrap Terraform baseline state KMS key');
    }
  } else if (inputs.root === 'app') {
    validateTargetPublicHostnameInputs(
      variables['public_hostname'],
      variables['cloudfront_acm_certificate_arn'],
      context,
    );
    if (
      context.target.environmentId === 'main' &&
      !['external-dns-acm', 'foundation-owned-dns-acm'].includes(String(variables['public_hostname_disposition']))
    ) {
      throw new Error('Production App must use its explicit public hostname and ACM certificate.');
    }
    if (context.target.environmentId === 'main') {
      const origin = variables['verifier_public_base_url'];
      const hostname = /** @type {string} */ (variables['public_hostname']);
      if (
        typeof origin !== 'string' ||
        origin.toLowerCase().replace(/\/$/u, '') !== `https://${hostname.toLowerCase()}`
      ) {
        throw new Error('Production App public origin must match its configured public hostname.');
      }
    }
    assertInputIdentity(
      variables['app_source_sha'],
      context.source.selectedApplicationSourceSha,
      'App Terraform baseline selected source',
    );
    if (variables['deploy_mode'] !== 'normal' && variables['deploy_mode'] !== 'rollback') {
      throw new Error('App Terraform baseline deployment mode is invalid.');
    }
    if (options.deploymentMode !== undefined) {
      assertInputIdentity(variables['deploy_mode'], options.deploymentMode, 'App Terraform baseline deployment mode');
    }
    if (typeof variables['deployment_id'] !== 'string' || !/^dep_[0-9a-f]{32}$/u.test(variables['deployment_id'])) {
      throw new Error('App Terraform baseline deployment ID is invalid.');
    }
    assertInputIdentity(
      variables['develop_operator_gate_enabled'],
      context.target.environmentId === 'develop',
      'App Terraform baseline develop operator gate',
    );
    assertInputIdentity(
      variables['image_signature_verifier_permissions_boundary_arn'],
      `arn:${context.target.partition}:iam::${context.target.accountId}:policy/${context.names.signatureVerifierPermissionsBoundary}`,
      'App Terraform baseline verifier permissions boundary',
    );
    const activation = variables['dynamodb_recovery_activation'];
    if (activation !== null) {
      if (!isPlainRecord(activation)) {
        throw new Error('App Terraform baseline recovery activation is invalid.');
      }
      for (const [name, expected] of Object.entries({
        account_alias: context.target.accountLabel,
        account_id: context.target.accountId,
        deployment_environment: context.target.environmentId,
        region: context.target.region,
      })) {
        assertInputIdentity(activation[name], expected, `App Terraform baseline recovery ${name}`);
      }
    }
  }
  return inputs;
}

/**
 * @param {unknown} value
 * @param {unknown} expectedProjectName
 * @returns {string}
 */
export function validateCodeBuildBuildId(value, expectedProjectName) {
  if (
    typeof value !== 'string' ||
    typeof expectedProjectName !== 'string' ||
    expectedProjectName.length === 0 ||
    value.length > 512 ||
    !value.startsWith(`${expectedProjectName}:`)
  ) {
    throw new Error('CodeBuild build ID does not match its exact project authority.');
  }
  const attemptId = value.slice(expectedProjectName.length + 1);
  try {
    requireGroupedLowercaseUuid(attemptId, 'CodeBuild build attempt ID');
  } catch (error) {
    throw new Error('CodeBuild build ID does not match its exact project authority.', { cause: error });
  }
  return value;
}

/**
 * @param {unknown} value
 * @param {unknown} contextValue
 * @param {CodeBuildRuntimeEvidenceOptions} [options]
 * @returns {CodeBuildRuntimeEvidence}
 */
export function validateCodeBuildRuntimeEvidence(value, contextValue, options = undefined) {
  const context = parseDeploymentLaneContext(contextValue);
  const target = resolveAllowedDeploymentTarget(`${context.target.accountLabel}/${context.target.environmentId}`);
  const lane = parseRoot(context.root.lane);
  const projectKeyValue =
    options === undefined
      ? 'terraformPlanProject'
      : exactKeys(options, ['projectKey'], 'CodeBuild runtime authority options')['projectKey'];
  if (
    (projectKeyValue !== 'terraformPlanProject' && projectKeyValue !== 'appSignaturePreflightPlanProject') ||
    (projectKeyValue === 'appSignaturePreflightPlanProject' && lane !== 'app')
  ) {
    throw new Error('CodeBuild runtime project authority is invalid.');
  }
  const projectKey = projectKeyValue;
  const record = exactKeys(value, CODEBUILD_RUNTIME_KEYS, 'CodeBuild runtime evidence');
  const project = exactKeys(record['project'], CODEBUILD_RUNTIME_PROJECT_KEYS, 'CodeBuild runtime project');
  const runtime = exactKeys(record['runtime'], CODEBUILD_RUNTIME_CONFIGURATION_KEYS, 'CodeBuild runtime configuration');
  const expectedProjectName = context.names[projectKey];
  const expectedProjectArn = `arn:${context.target.partition}:codebuild:${context.target.region}:${context.target.accountId}:project/${expectedProjectName}`;
  let buildId;
  try {
    buildId = validateCodeBuildBuildId(project['buildId'], expectedProjectName);
  } catch (error) {
    throw new Error('CodeBuild runtime evidence does not match the Terraform Plan project authority.', {
      cause: error,
    });
  }
  if (
    record['evidenceType'] !== 'codebuild-runtime' ||
    record['targetKey'] !== target.targetKey ||
    record['lane'] !== context.root['lane'] ||
    record['stateIdentity'] !== context.root['stateIdentity'] ||
    record['sourceSha'] !== context.source.frameworkSourceSha ||
    project['key'] !== projectKey ||
    project['name'] !== expectedProjectName ||
    project['arn'] !== expectedProjectArn
  ) {
    throw new Error('CodeBuild runtime evidence does not match the Terraform Plan project authority.');
  }
  if (
    typeof runtime['configuredImage'] !== 'string' ||
    !isManagedCodeBuildImageIdentifier(runtime['configuredImage']) ||
    typeof runtime['observedImage'] !== 'string' ||
    !isManagedCodeBuildImageIdentifier(runtime['observedImage']) ||
    runtime['computeType'] !== 'BUILD_GENERAL1_SMALL' ||
    runtime['environmentType'] !== 'LINUX_CONTAINER' ||
    runtime['privilegedMode'] !== false
  ) {
    throw new Error('CodeBuild runtime evidence does not match the admitted Terraform Plan runtime.');
  }
  return deepFreeze({
    evidenceType: 'codebuild-runtime',
    targetKey: target.targetKey,
    lane,
    stateIdentity: context.root.stateIdentity,
    sourceSha: context.source.frameworkSourceSha,
    project: {
      key: projectKey,
      name: expectedProjectName,
      arn: expectedProjectArn,
      buildId,
    },
    runtime: {
      configuredImage: runtime['configuredImage'],
      observedImage: runtime['observedImage'],
      computeType: 'BUILD_GENERAL1_SMALL',
      environmentType: 'LINUX_CONTAINER',
      privilegedMode: false,
    },
  });
}

/**
 * @param {unknown} value
 * @returns {TerraformIdentityEvidence}
 */
export function validateTerraformBaselineIdentityEvidence(value) {
  const record = exactKeys(value, TERRAFORM_IDENTITY_KEYS, 'Terraform identity evidence');
  if (
    typeof record['terraform_version'] !== 'string' ||
    !TERRAFORM_VERSION_PATTERN.test(record['terraform_version']) ||
    record['platform'] !== 'linux_amd64' ||
    typeof record['terraform_outdated'] !== 'boolean'
  ) {
    throw new Error('Terraform identity evidence uses an unsupported runtime.');
  }
  const selections = exactKeys(record['provider_selections'], [AWS_PROVIDER_ADDRESS], 'Terraform provider selections');
  const providerVersion = selections[AWS_PROVIDER_ADDRESS];
  if (typeof providerVersion !== 'string' || !TERRAFORM_VERSION_PATTERN.test(providerVersion)) {
    throw new Error('Terraform AWS provider selection is invalid.');
  }
  return deepFreeze({
    terraformVersion: record['terraform_version'],
    platform: 'linux_amd64',
    terraformOutdated: record['terraform_outdated'],
    providerSelections: { [AWS_PROVIDER_ADDRESS]: providerVersion },
  });
}

/**
 * @param {unknown} value
 * @param {unknown} terraformIdentity
 * @returns {TerraformIdentityEvidence['providerSelections']}
 */
export function validateTerraformBaselineProviderSelections(value, terraformIdentity) {
  const identity = validateTerraformBaselineIdentityEvidence(terraformIdentity);
  const selections = exactKeys(value, [AWS_PROVIDER_ADDRESS], 'Terraform baseline provider selections');
  if (selections[AWS_PROVIDER_ADDRESS] !== identity.providerSelections[AWS_PROVIDER_ADDRESS]) {
    throw new Error('Terraform baseline provider selections do not match Terraform identity evidence.');
  }
  return identity.providerSelections;
}

/**
 * @param {unknown} body
 * @param {unknown} terraformIdentity
 * @returns {Uint8Array}
 */
export function validateTerraformBaselineProviderLock(body, terraformIdentity) {
  const identity = validateTerraformBaselineIdentityEvidence(terraformIdentity);
  if (typeof body !== 'string' && !(body instanceof Uint8Array)) {
    throw new Error('Terraform baseline provider lock must be text or bytes.');
  }
  const bytes = Buffer.from(body);
  if (bytes.length === 0 || bytes.length > MAX_NONSECRET_INPUT_BYTES || bytes.includes(0)) {
    throw new Error('Terraform baseline provider lock is empty, oversized, or binary.');
  }
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (error) {
    throw new Error('Terraform baseline provider lock is not valid UTF-8.', { cause: error });
  }
  const providerVersion = identity.providerSelections[AWS_PROVIDER_ADDRESS];
  const escapedVersion = providerVersion.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const lockPattern = new RegExp(
    '^# This file is maintained automatically by "terraform init"\\.\\n' +
      '# Manual edits may be lost in future updates\\.\\n\\n' +
      'provider "registry\\.terraform\\.io/hashicorp/aws" \\{\\n' +
      `  version\\s+= "${escapedVersion}"\\n` +
      '(?:  constraints\\s+= "[0-9A-Za-z .,!<>=~*+_-]+"\\n)?' +
      '  hashes = \\[\\n' +
      '(?:    "(?:h1:[A-Za-z0-9+/=]+|zh:[0-9a-f]{64})",\\n)+' +
      '  \\]\\n' +
      '\\}\\n$',
    'u',
  );
  if (!lockPattern.test(text)) {
    throw new Error('Terraform baseline provider lock does not use the exact generated AWS provider shape.');
  }
  return bytes;
}
