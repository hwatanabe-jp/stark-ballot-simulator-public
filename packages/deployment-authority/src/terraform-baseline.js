import { createHash } from 'node:crypto';
import {
  canonicalRecordJson,
  deepFreeze,
  isPlainRecord,
  parseGitCommitSha,
  parseImmutableObjectReference,
  parseSha256,
  requireExactKeys,
  requireGroupedLowercaseUuid,
  requireString,
} from './internal.js';
import { parseDeploymentLaneContext, resolveAllowedDeploymentTarget, resolveDeploymentLaneAuthority } from './index.js';

const DEPLOYMENT_TARGET = resolveAllowedDeploymentTarget('stark-dev/develop');
const TERRAFORM_BASELINE_ROOTS = Object.freeze(['bootstrap', 'foundation', 'app']);
const TERRAFORM_VERSION_PATTERN = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/u;
const AWS_PROVIDER_ADDRESS = 'registry.terraform.io/hashicorp/aws';
const MANAGED_CODEBUILD_IMAGE_PATTERN = /^aws\/codebuild\/(?:standard|amazonlinux2-aarch64-standard):[0-9]+\.[0-9]+$/u;
const CODEBUILD_COMPUTE_TYPES = Object.freeze([
  'BUILD_GENERAL1_SMALL',
  'BUILD_GENERAL1_MEDIUM',
  'BUILD_GENERAL1_LARGE',
  'BUILD_GENERAL1_XLARGE',
  'BUILD_GENERAL1_2XLARGE',
]);
const CODEBUILD_ENVIRONMENT_TYPES = Object.freeze(['LINUX_CONTAINER', 'ARM_CONTAINER']);
const CANONICAL_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const TERRAFORM_INPUT_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,127}$/u;
const CANONICAL_BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;
const REFERENCE_PATH_PATTERN = /^\/[A-Za-z0-9_.+=,@-]+(?:\/[A-Za-z0-9_.+=,@-]+)*$/u;
const S3_BUCKET_NAME_PATTERN = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/u;
const KMS_KEY_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const SSM_PARAMETER_ARN_PATTERN = /^arn:aws:ssm:[a-z0-9-]+:[0-9]{12}:parameter\/[A-Za-z0-9_.+=,@/-]+$/u;
const SECRETS_MANAGER_ARN_PATTERN = /^arn:aws:secretsmanager:[a-z0-9-]+:[0-9]{12}:secret:[A-Za-z0-9_.+=,@/-]+$/u;

const INPUT_MANIFEST_KEYS = [
  'backendKey',
  'controlSourceSha',
  'evidenceType',
  'frameworkSourceSha',
  'nonsecretInputs',
  'root',
  'secretReferences',
  'secretValuesIncluded',
  'stateIdentity',
  'targetContext',
];

const ACCEPTANCE_EVIDENCE_KEYS = [
  'acceptedPlanChecksum',
  'accountId',
  'actionExecutionId',
  'actionName',
  'approvalTimestamp',
  'approver',
  'backendKey',
  'controlSourceSha',
  'deploymentEnvironment',
  'evidenceType',
  'frameworkSourceSha',
  'pipelineExecutionId',
  'reviewedPlanChecksum',
  'root',
  'sourceSha',
  'stageName',
  'stateIdentity',
];

const PROVIDER_EVIDENCE_KEYS = [
  'backendKey',
  'controlSourceSha',
  'evidenceType',
  'frameworkSourceSha',
  'platform',
  'providerLock',
  'providerSelections',
  'root',
  'runtimeEvidence',
  'stateIdentity',
  'targetContext',
  'terraformVersion',
];

const SMOKE_ADMISSION_KEYS = [
  'acceptedPlanChecksum',
  'backendKey',
  'controlSourceSha',
  'evidenceType',
  'frameworkSourceSha',
  'pipelineExecutionId',
  'root',
  'smokeResult',
  'specializedSmokeSha256',
  'specializedSmokeType',
  'stateIdentity',
  'targetContext',
];

const ACCEPTED_BASELINE_KEYS = [
  'acceptanceEvidence',
  'acceptedPlanChecksum',
  'backend',
  'backendKey',
  'controlSourceSha',
  'frameworkSourceSha',
  'inputManifest',
  'pipelineExecutionId',
  'providerEvidence',
  'publishedAt',
  'recordType',
  'root',
  'smokeEvidence',
  'stateIdentity',
  'targetContext',
];

const CURRENT_POINTER_KEYS = ['backendKey', 'baseline', 'pointerType', 'root', 'stateIdentity'];
const SECRET_REFERENCE_KEYS = ['inputName', 'reference', 'source'];
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
const CODEBUILD_RUNTIME_PROJECT_AUTHORITY_KEYS = ['terraformPlanProject', 'appSignaturePreflightPlanProject'];
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

function parseRoot(value) {
  if (!TERRAFORM_BASELINE_ROOTS.includes(value)) {
    throw new Error('Terraform baseline root must be bootstrap, foundation, or app.');
  }
  return value;
}

function parseRootAuthority(record) {
  const root = parseRoot(record.root);
  const authority = resolveDeploymentLaneAuthority(DEPLOYMENT_TARGET, root);
  if (record.stateIdentity !== authority.stateIdentity) {
    throw new Error('Terraform baseline state identity does not match the root.');
  }
  if (record.backendKey !== authority.backendKey) {
    throw new Error('Terraform baseline backend key does not match the root.');
  }
  return { root, stateIdentity: authority.stateIdentity, backendKey: authority.backendKey };
}

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

export function validateTerraformBackendAuthority(value, rootValue) {
  const record = exactKeys(value, TERRAFORM_BACKEND_AUTHORITY_KEYS, 'Terraform backend authority');
  const root = parseRoot(rootValue);
  const authority = resolveDeploymentLaneAuthority(DEPLOYMENT_TARGET, root);
  const bucketName = requireString(record.bucketName, 'Terraform backend state bucket');
  const backendKey = requireString(record.backendKey, 'Terraform backend state key');
  const kmsKeyArn = requireString(record.kmsKeyArn, 'Terraform backend KMS key ARN');
  const region = requireString(record.region, 'Terraform backend region');
  const expectedKmsPrefix = `arn:${DEPLOYMENT_TARGET.partition}:kms:${DEPLOYMENT_TARGET.region}:${DEPLOYMENT_TARGET.accountId}:key/`;
  if (
    !S3_BUCKET_NAME_PATTERN.test(bucketName) ||
    bucketName.includes('..') ||
    backendKey !== authority.backendKey ||
    region !== DEPLOYMENT_TARGET.region ||
    !kmsKeyArn.startsWith(expectedKmsPrefix) ||
    !KMS_KEY_ID_PATTERN.test(kmsKeyArn.slice(expectedKmsPrefix.length))
  ) {
    throw new Error('Terraform backend authority does not match its deployment target and state.');
  }
  return deepFreeze({ bucketName, backendKey: authority.backendKey, kmsKeyArn, region: DEPLOYMENT_TARGET.region });
}

function parseSourceSha(value, label) {
  try {
    return parseGitCommitSha(value, label);
  } catch (error) {
    throw new Error(`${label} is invalid.`, { cause: error });
  }
}

function parseChecksum(value, label) {
  try {
    return parseSha256(value, label);
  } catch (error) {
    throw new Error(`${label} is invalid.`, { cause: error });
  }
}

function parsePipelineExecutionId(value) {
  try {
    return requireGroupedLowercaseUuid(value, 'Accepted Terraform baseline pipeline execution ID');
  } catch (error) {
    throw new Error('Accepted Terraform baseline pipeline execution ID is invalid.', { cause: error });
  }
}

function parseCanonicalTimestamp(value) {
  if (
    typeof value !== 'string' ||
    !CANONICAL_TIMESTAMP_PATTERN.test(value) ||
    Number.isNaN(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  ) {
    throw new Error('Accepted Terraform baseline publication timestamp is invalid.');
  }
  return value;
}

function isForbiddenDependencyKey(key) {
  return key.split('/').some((segment) => {
    const normalized = segment.toLowerCase();
    return (
      normalized === 'tfplan' ||
      normalized.startsWith('tfplan.') ||
      normalized.endsWith('.tfplan') ||
      normalized.endsWith('.tfplan.json') ||
      normalized === 'plan.json' ||
      normalized === 'raw-plan.json' ||
      normalized === 'raw-values.json' ||
      normalized === 'saved-plan' ||
      normalized === 'saved-plans' ||
      normalized === 'terraform.tfstate' ||
      normalized.startsWith('terraform.tfstate.') ||
      normalized.endsWith('.tfstate') ||
      normalized.endsWith('.tfstate.backup') ||
      normalized.endsWith('.tfvars') ||
      normalized.endsWith('.tfvars.json')
    );
  });
}

function parseEvidenceReference(value, label, rootAuthority, durable) {
  let reference;
  try {
    reference = parseImmutableObjectReference(value);
  } catch (error) {
    throw new Error(`${label} must contain an exact key, VersionId, and SHA-256.`, { cause: error });
  }
  const forbidden = isForbiddenDependencyKey(reference.key);
  if (durable) {
    const durablePrefix = `accepted-baselines/${rootAuthority.stateIdentity}/`;
    if (forbidden || !reference.key.startsWith(durablePrefix)) {
      throw new Error(`${label} must be durable and must not contain saved plans, state, or raw values.`);
    }
  } else if (forbidden) {
    throw new Error(`${label} must not contain saved plans, state, or raw values.`);
  }
  return reference;
}

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

function parseNonsecretInputFile(value) {
  const record = exactKeys(value, NONSECRET_INPUT_FILE_KEYS, 'Terraform baseline nonsecret input file');
  if (
    typeof record.path !== 'string' ||
    record.path.length === 0 ||
    record.path.startsWith('/') ||
    record.path.includes('..')
  ) {
    throw new Error('Terraform baseline nonsecret input path is invalid.');
  }
  const sha256 = parseChecksum(record.sha256, 'Terraform baseline nonsecret input SHA-256');
  if (
    typeof record.contentBase64 !== 'string' ||
    record.contentBase64.length === 0 ||
    !CANONICAL_BASE64_PATTERN.test(record.contentBase64)
  ) {
    throw new Error('Terraform baseline nonsecret input content is invalid.');
  }
  const body = Buffer.from(record.contentBase64, 'base64');
  if (
    body.length === 0 ||
    body.length > MAX_NONSECRET_INPUT_BYTES ||
    body.includes(0) ||
    body.toString('base64') !== record.contentBase64
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
  return { path: record.path, sha256, contentBase64: record.contentBase64, body: decodedBody };
}

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

function requireValueType(value, type, label, { nullable = false } = {}) {
  if ((nullable && value === null) || typeof value === type) {
    return;
  }
  throw new Error(`${label} has an invalid value type.`);
}

function requireStringArray(value, label) {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new Error(`${label} must be an array of strings.`);
  }
}

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

function validateFoundationInputValues(value) {
  for (const key of FOUNDATION_INPUT_KEYS) {
    requireValueType(value[key], 'string', `Foundation Terraform baseline ${key}`);
  }
}

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
      (artifact.asset_manifest_sha256 === null || artifact.trust_root_sha256 === null)
    ) {
      throw new Error('App Terraform baseline image-signature verifier artifact evidence is incomplete.');
    }
    if (
      name !== 'image_signature_verifier' &&
      (artifact.asset_manifest_sha256 !== null || artifact.trust_root_sha256 !== null)
    ) {
      throw new Error('App Terraform baseline non-verifier artifacts contain verifier-only evidence.');
    }
  }
}

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
            ? artifact.asset_manifest_sha256
            : null,
          s3_bucket: artifact.s3_bucket,
          s3_key: artifact.s3_key,
          s3_object_version: artifact.s3_object_version,
          source_code_hash: artifact.source_code_hash,
          trust_root_sha256: Object.hasOwn(artifact, 'trust_root_sha256') ? artifact.trust_root_sha256 : null,
        },
      ];
    }),
  );
}

function validateRecoveryActivation(value) {
  if (value === null) {
    return;
  }
  const activation = exactKeys(value, RECOVERY_ACTIVATION_KEYS, 'App Terraform baseline recovery activation');
  for (const key of RECOVERY_ACTIVATION_KEYS.filter((key) => key !== 'sessions' && key !== 'votes')) {
    requireValueType(activation[key], 'string', `App Terraform baseline recovery activation ${key}`);
  }
  const sessions = exactKeys(activation.sessions, RECOVERY_SESSIONS_KEYS, 'App Terraform baseline recovery sessions');
  const votes = exactKeys(activation.votes, RECOVERY_VOTES_KEYS, 'App Terraform baseline recovery votes');
  for (const [label, record] of [
    ['sessions', sessions],
    ['votes', votes],
  ]) {
    for (const [key, entry] of Object.entries(record)) {
      requireValueType(entry, 'string', `App Terraform baseline recovery ${label}.${key}`);
    }
  }
}

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
    authority.timeout_seconds,
    'number',
    'App Terraform baseline selected verifier authority timeout_seconds',
  );
  const packageValue = exactKeys(
    authority.package,
    SELECTED_VERIFIER_PACKAGE_KEYS,
    'App Terraform baseline selected verifier package',
  );
  for (const [key, entry] of Object.entries(packageValue)) {
    requireValueType(entry, 'string', `App Terraform baseline selected verifier package ${key}`);
  }
}

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
  ]) {
    requireValueType(value[key], 'string', `App Terraform baseline ${key}`, { nullable: true });
  }
  for (const key of booleanKeys) {
    requireValueType(value[key], 'boolean', `App Terraform baseline ${key}`);
  }
  for (const key of numberKeys) {
    requireValueType(value[key], 'number', `App Terraform baseline ${key}`);
  }
  requireStringArray(value.prover_security_group_ids, 'App Terraform baseline prover_security_group_ids');
  requireStringArray(value.prover_subnet_ids, 'App Terraform baseline prover_subnet_ids');
  const mapping = exactKeys(
    value.image_id_mapping_evidence,
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
  validateLambdaArtifacts(value.lambda_artifacts);
  validateSelectedVerifierAuthority(value.image_signature_verifier_selected_authority);
  validateRecoveryActivation(value.dynamodb_recovery_activation);
  requireValueType(value.dynamodb_recovery_phase, 'string', 'App Terraform baseline dynamodb_recovery_phase');
}

export function validateTerraformBaselineNonsecretInputs(value) {
  const record = exactKeys(value, NONSECRET_INPUT_KEYS, 'Terraform baseline nonsecret inputs');
  if (record.evidenceType !== 'terraform-baseline-nonsecret-inputs') {
    throw new Error('Terraform baseline nonsecret input evidence type is invalid.');
  }
  const root = parseRoot(record.root);
  if (record.secretValuesIncluded !== false) {
    throw new Error('Terraform baseline nonsecret inputs must exclude secret values.');
  }
  const parsedFiles = parseDenseArray(record.files, 'Terraform baseline nonsecret input files').map(
    parseNonsecretInputFile,
  );
  const paths = parsedFiles.map(({ path }) => path);
  if (paths.length !== 1 || paths[0] !== 'pipeline.auto.tfvars.json') {
    throw new Error(`${root[0].toUpperCase()}${root.slice(1)} Terraform baseline reconstruction file set is invalid.`);
  }
  if (root === 'bootstrap') {
    const inputs = parseCanonicalJsonInputs(
      parsedFiles[0].body,
      BOOTSTRAP_INPUT_KEYS,
      'Bootstrap Terraform baseline inputs',
    );
    validateBootstrapInputValues(inputs);
  } else if (root === 'foundation') {
    const inputs = parseCanonicalJsonInputs(
      parsedFiles[0].body,
      FOUNDATION_INPUT_KEYS,
      'Foundation Terraform baseline inputs',
    );
    validateFoundationInputValues(inputs);
  } else {
    const inputs = parseCanonicalJsonInputs(
      parsedFiles[0].body,
      APP_STORED_INPUT_KEYS,
      'App Terraform baseline inputs',
    );
    validateAppInputValues(inputs);
  }
  return deepFreeze({
    evidenceType: 'terraform-baseline-nonsecret-inputs',
    root,
    files: parsedFiles.map(({ path, sha256, contentBase64 }) => ({ path, sha256, contentBase64 })),
    secretValuesIncluded: false,
  });
}

export function buildTerraformBaselineNonsecretInputs(rootValue, terraformPlanDocument) {
  const root = parseRoot(rootValue);
  if (!isPlainRecord(terraformPlanDocument) || !isPlainRecord(terraformPlanDocument.variables)) {
    throw new Error('Terraform saved-plan JSON does not contain evaluated variables.');
  }
  const expectedKeys =
    root === 'bootstrap' ? BOOTSTRAP_INPUT_KEYS : root === 'foundation' ? FOUNDATION_INPUT_KEYS : APP_STORED_INPUT_KEYS;
  for (const name of expectedKeys) {
    if (!Object.hasOwn(terraformPlanDocument.variables, name)) {
      throw new Error(`Terraform saved plan is missing the admitted ${root} variable ${name}.`);
    }
  }
  exactKeys(terraformPlanDocument.variables, expectedKeys, `Terraform saved-plan ${root} variables`);
  const selected = {};
  for (const name of expectedKeys) {
    const variable = exactKeys(
      terraformPlanDocument.variables[name],
      ['value'],
      `Terraform saved-plan variable ${name}`,
    );
    selected[name] =
      root === 'app' && name === 'lambda_artifacts' ? projectSavedPlanLambdaArtifacts(variable.value) : variable.value;
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

function decodedNonsecretInputValues(inputs) {
  const body = Buffer.from(inputs.files[0].contentBase64, 'base64').toString('utf8');
  return JSON.parse(body);
}

export function decodeTerraformBaselineNonsecretInputValues(value) {
  const inputs = validateTerraformBaselineNonsecretInputs(value);
  return deepFreeze(decodedNonsecretInputValues(inputs));
}

function assertInputIdentity(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label} does not match the deployment context authority.`);
  }
}

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
    assertInputIdentity(
      variables.control_source_sha,
      context.source.requestedControlSourceSha,
      'Bootstrap Terraform baseline control source',
    );
    assertInputIdentity(
      variables.github_full_repository_id,
      context.source.repository,
      'Bootstrap Terraform baseline repository',
    );
    assertInputIdentity(variables.source_branch, context.source.branch, 'Bootstrap Terraform baseline source branch');
    for (const name of [
      'enable_development_pipeline',
      'enable_development_foundation_pipeline',
      'enable_development_app_pipeline',
    ]) {
      assertInputIdentity(variables[name], true, `Bootstrap Terraform baseline input ${name}`);
    }
    if (!TERRAFORM_VERSION_PATTERN.test(variables.terraform_version)) {
      throw new Error('Bootstrap Terraform baseline Terraform version is invalid.');
    }
    if (options.terraformVersion !== undefined) {
      assertInputIdentity(
        variables.terraform_version,
        options.terraformVersion,
        'Bootstrap Terraform baseline Terraform version',
      );
    }
    if (options.stateBucketName !== undefined) {
      assertInputIdentity(
        variables.state_bucket_name,
        options.stateBucketName,
        'Bootstrap Terraform baseline state bucket',
      );
    }
    if (options.stateKmsAlias !== undefined) {
      assertInputIdentity(
        variables.state_kms_alias,
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
      assertInputIdentity(variables.state_kms_key_id, keyId, 'Bootstrap Terraform baseline state KMS key');
    }
  } else if (inputs.root === 'app') {
    assertInputIdentity(
      variables.app_source_sha,
      context.source.selectedApplicationSourceSha,
      'App Terraform baseline selected source',
    );
    if (variables.deploy_mode !== 'normal' && variables.deploy_mode !== 'rollback') {
      throw new Error('App Terraform baseline deployment mode is invalid.');
    }
    if (options.deploymentMode !== undefined) {
      assertInputIdentity(variables.deploy_mode, options.deploymentMode, 'App Terraform baseline deployment mode');
    }
    if (typeof variables.deployment_id !== 'string' || !/^dep_[0-9a-f]{32}$/u.test(variables.deployment_id)) {
      throw new Error('App Terraform baseline deployment ID is invalid.');
    }
    assertInputIdentity(variables.develop_operator_gate_enabled, true, 'App Terraform baseline develop operator gate');
    assertInputIdentity(
      variables.image_signature_verifier_permissions_boundary_arn,
      `arn:${context.target.partition}:iam::${context.target.accountId}:policy/${context.names.signatureVerifierPermissionsBoundary}`,
      'App Terraform baseline verifier permissions boundary',
    );
    const activation = variables.dynamodb_recovery_activation;
    if (activation !== null) {
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

export function validateCodeBuildRuntimeEvidence(value, contextValue, options = undefined) {
  const context = parseDeploymentLaneContext(contextValue);
  const projectKey =
    options === undefined
      ? 'terraformPlanProject'
      : exactKeys(options, ['projectKey'], 'CodeBuild runtime authority options').projectKey;
  if (
    !CODEBUILD_RUNTIME_PROJECT_AUTHORITY_KEYS.includes(projectKey) ||
    (projectKey === 'appSignaturePreflightPlanProject' && context.root.lane !== 'app')
  ) {
    throw new Error('CodeBuild runtime project authority is invalid.');
  }
  const record = exactKeys(value, CODEBUILD_RUNTIME_KEYS, 'CodeBuild runtime evidence');
  const project = exactKeys(record.project, CODEBUILD_RUNTIME_PROJECT_KEYS, 'CodeBuild runtime project');
  const runtime = exactKeys(record.runtime, CODEBUILD_RUNTIME_CONFIGURATION_KEYS, 'CodeBuild runtime configuration');
  const expectedProjectName = context.names[projectKey];
  const expectedProjectArn = `arn:${context.target.partition}:codebuild:${context.target.region}:${context.target.accountId}:project/${expectedProjectName}`;
  try {
    validateCodeBuildBuildId(project.buildId, expectedProjectName);
  } catch (error) {
    throw new Error('CodeBuild runtime evidence does not match the Terraform Plan project authority.', {
      cause: error,
    });
  }
  if (
    record.evidenceType !== 'codebuild-runtime' ||
    record.targetKey !== DEPLOYMENT_TARGET.targetKey ||
    record.lane !== context.root.lane ||
    record.stateIdentity !== context.root.stateIdentity ||
    record.sourceSha !== context.source.frameworkSourceSha ||
    project.key !== projectKey ||
    project.name !== expectedProjectName ||
    project.arn !== expectedProjectArn
  ) {
    throw new Error('CodeBuild runtime evidence does not match the Terraform Plan project authority.');
  }
  if (
    typeof runtime.configuredImage !== 'string' ||
    !MANAGED_CODEBUILD_IMAGE_PATTERN.test(runtime.configuredImage) ||
    runtime.configuredImage !== 'aws/codebuild/standard:8.0' ||
    runtime.observedImage !== runtime.configuredImage ||
    !CODEBUILD_COMPUTE_TYPES.includes(runtime.computeType) ||
    runtime.computeType !== 'BUILD_GENERAL1_SMALL' ||
    !CODEBUILD_ENVIRONMENT_TYPES.includes(runtime.environmentType) ||
    runtime.environmentType !== 'LINUX_CONTAINER' ||
    runtime.privilegedMode !== false
  ) {
    throw new Error('CodeBuild runtime evidence does not match the admitted Terraform Plan runtime.');
  }
  return deepFreeze({
    evidenceType: 'codebuild-runtime',
    targetKey: DEPLOYMENT_TARGET.targetKey,
    lane: context.root.lane,
    stateIdentity: context.root.stateIdentity,
    sourceSha: context.source.frameworkSourceSha,
    project: {
      key: projectKey,
      name: expectedProjectName,
      arn: expectedProjectArn,
      buildId: project.buildId,
    },
    runtime: {
      configuredImage: 'aws/codebuild/standard:8.0',
      observedImage: 'aws/codebuild/standard:8.0',
      computeType: 'BUILD_GENERAL1_SMALL',
      environmentType: 'LINUX_CONTAINER',
      privilegedMode: false,
    },
  });
}

export function validateTerraformBaselineIdentityEvidence(value) {
  const record = exactKeys(value, TERRAFORM_IDENTITY_KEYS, 'Terraform identity evidence');
  if (
    typeof record.terraform_version !== 'string' ||
    !TERRAFORM_VERSION_PATTERN.test(record.terraform_version) ||
    record.platform !== 'linux_amd64' ||
    typeof record.terraform_outdated !== 'boolean'
  ) {
    throw new Error('Terraform identity evidence uses an unsupported runtime.');
  }
  const selections = exactKeys(record.provider_selections, [AWS_PROVIDER_ADDRESS], 'Terraform provider selections');
  const providerVersion = selections[AWS_PROVIDER_ADDRESS];
  if (typeof providerVersion !== 'string' || !TERRAFORM_VERSION_PATTERN.test(providerVersion)) {
    throw new Error('Terraform AWS provider selection is invalid.');
  }
  return deepFreeze({
    terraformVersion: record.terraform_version,
    platform: 'linux_amd64',
    terraformOutdated: record.terraform_outdated,
    providerSelections: { [AWS_PROVIDER_ADDRESS]: providerVersion },
  });
}

export function validateTerraformBaselineProviderSelections(value, terraformIdentity) {
  const identity = validateTerraformBaselineIdentityEvidence(terraformIdentity);
  const selections = exactKeys(value, [AWS_PROVIDER_ADDRESS], 'Terraform baseline provider selections');
  if (selections[AWS_PROVIDER_ADDRESS] !== identity.providerSelections[AWS_PROVIDER_ADDRESS]) {
    throw new Error('Terraform baseline provider selections do not match Terraform identity evidence.');
  }
  return identity.providerSelections;
}

export function validateTerraformBaselineProviderLock(body, terraformIdentity) {
  const identity = validateTerraformBaselineIdentityEvidence(terraformIdentity);
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

function parseSecretReference(value) {
  const reference = exactKeys(value, SECRET_REFERENCE_KEYS, 'Terraform baseline secret reference');
  let inputName;
  try {
    inputName = requireString(
      reference.inputName,
      'Terraform baseline secret-reference input name',
      TERRAFORM_INPUT_NAME_PATTERN,
    );
  } catch (error) {
    throw new Error('Terraform baseline secret-reference input name is invalid.', { cause: error });
  }
  const source = reference.source;
  if (source !== 'ssm-parameter' && source !== 'secrets-manager-secret') {
    throw new Error('Terraform baseline secret-reference source is invalid.');
  }
  let admittedReference;
  try {
    admittedReference = requireString(reference.reference, 'Terraform baseline secret reference');
  } catch (error) {
    throw new Error('Terraform baseline secret reference is invalid.', { cause: error });
  }
  const matchesReference =
    REFERENCE_PATH_PATTERN.test(admittedReference) ||
    (source === 'ssm-parameter'
      ? SSM_PARAMETER_ARN_PATTERN.test(admittedReference)
      : SECRETS_MANAGER_ARN_PATTERN.test(admittedReference));
  if (!matchesReference || Buffer.byteLength(admittedReference, 'utf8') > 2048) {
    throw new Error('Terraform baseline secret reference is invalid.');
  }
  return deepFreeze({ inputName, source, reference: admittedReference });
}

function parseCommonAuthority(record) {
  const rootAuthority = parseRootAuthority(record);
  const controlSourceSha = parseSourceSha(record.controlSourceSha, 'Terraform baseline control source SHA');
  const frameworkSourceSha = parseSourceSha(record.frameworkSourceSha, 'Terraform baseline framework source SHA');
  return { rootAuthority, controlSourceSha, frameworkSourceSha };
}

export function validateTerraformBaselineInputManifest(value) {
  const record = exactKeys(value, INPUT_MANIFEST_KEYS, 'Terraform baseline input manifest');
  if (record.evidenceType !== 'terraform-baseline-input-manifest') {
    throw new Error('Terraform baseline input manifest evidence type is invalid.');
  }
  const { rootAuthority, controlSourceSha, frameworkSourceSha } = parseCommonAuthority(record);
  const targetContext = parseEvidenceReference(
    record.targetContext,
    'Terraform baseline target context',
    rootAuthority,
    true,
  );
  const nonsecretInputs = parseEvidenceReference(
    record.nonsecretInputs,
    'Terraform baseline nonsecret inputs',
    rootAuthority,
    true,
  );
  const secretReferences = parseDenseArray(record.secretReferences, 'Terraform baseline secret references').map(
    parseSecretReference,
  );
  if (new Set(secretReferences.map(({ inputName }) => inputName)).size !== secretReferences.length) {
    throw new Error('Terraform baseline secret-reference input names must be unique.');
  }
  if (record.secretValuesIncluded !== false) {
    throw new Error('Terraform baseline input manifest must exclude secret values.');
  }
  return deepFreeze({
    evidenceType: 'terraform-baseline-input-manifest',
    root: rootAuthority.root,
    stateIdentity: rootAuthority.stateIdentity,
    backendKey: rootAuthority.backendKey,
    controlSourceSha,
    frameworkSourceSha,
    targetContext,
    nonsecretInputs,
    secretReferences,
    secretValuesIncluded: false,
  });
}

export function validateTerraformBaselineProviderEvidence(value) {
  const record = exactKeys(value, PROVIDER_EVIDENCE_KEYS, 'Terraform baseline provider evidence');
  if (record.evidenceType !== 'terraform-baseline-provider-evidence') {
    throw new Error('Terraform baseline provider evidence type is invalid.');
  }
  const { rootAuthority, controlSourceSha, frameworkSourceSha } = parseCommonAuthority(record);
  const targetContext = parseEvidenceReference(
    record.targetContext,
    'Terraform baseline target context',
    rootAuthority,
    true,
  );
  const providerLock = parseEvidenceReference(
    record.providerLock,
    'Terraform baseline provider lock',
    rootAuthority,
    true,
  );
  const providerSelections = parseEvidenceReference(
    record.providerSelections,
    'Terraform baseline provider selections',
    rootAuthority,
    true,
  );
  const runtimeEvidence = parseEvidenceReference(
    record.runtimeEvidence,
    'Terraform baseline runtime evidence',
    rootAuthority,
    true,
  );
  let terraformVersion;
  try {
    terraformVersion = requireString(
      record.terraformVersion,
      'Terraform baseline Terraform version',
      TERRAFORM_VERSION_PATTERN,
    );
  } catch (error) {
    throw new Error('Terraform baseline Terraform version is invalid.', { cause: error });
  }
  if (record.platform !== 'linux_amd64' && record.platform !== 'linux_arm64') {
    throw new Error('Terraform baseline platform is invalid.');
  }
  return deepFreeze({
    evidenceType: 'terraform-baseline-provider-evidence',
    root: rootAuthority.root,
    stateIdentity: rootAuthority.stateIdentity,
    backendKey: rootAuthority.backendKey,
    controlSourceSha,
    frameworkSourceSha,
    targetContext,
    providerLock,
    providerSelections,
    runtimeEvidence,
    terraformVersion,
    platform: record.platform,
  });
}

export function validateTerraformBaselineAcceptanceEvidence(value) {
  const record = exactKeys(value, ACCEPTANCE_EVIDENCE_KEYS, 'Terraform baseline acceptance evidence');
  if (record.evidenceType !== 'terraform-baseline-acceptance') {
    throw new Error('Terraform baseline acceptance evidence type is invalid.');
  }
  const { rootAuthority, controlSourceSha, frameworkSourceSha } = parseCommonAuthority(record);
  if (rootAuthority.root === 'app') {
    throw new Error('Terraform baseline saved-plan acceptance is only valid for Bootstrap or Foundation.');
  }
  const acceptedPlanChecksum = parseChecksum(record.acceptedPlanChecksum, 'Terraform baseline accepted plan checksum');
  const reviewedPlanChecksum = parseChecksum(record.reviewedPlanChecksum, 'Terraform baseline reviewed plan checksum');
  if (acceptedPlanChecksum !== reviewedPlanChecksum) {
    throw new Error('Terraform baseline acceptance checksums do not match.');
  }
  const pipelineExecutionId = parsePipelineExecutionId(record.pipelineExecutionId);
  let actionExecutionId;
  try {
    actionExecutionId = requireGroupedLowercaseUuid(
      record.actionExecutionId,
      'Terraform baseline acceptance action execution ID',
    );
  } catch (error) {
    throw new Error('Terraform baseline acceptance action execution ID is invalid.', { cause: error });
  }
  const sourceSha = parseSourceSha(record.sourceSha, 'Terraform baseline acceptance source SHA');
  if (sourceSha !== frameworkSourceSha) {
    throw new Error('Terraform baseline acceptance source does not match its framework source.');
  }
  const expectedActionName =
    rootAuthority.root === 'bootstrap' ? 'ApproveInitialDevelopmentApply' : 'ApproveFoundationApply';
  if (record.stageName !== 'ManualApproval' || record.actionName !== expectedActionName) {
    throw new Error('Terraform baseline acceptance action identity is invalid.');
  }
  if (
    record.accountId !== DEPLOYMENT_TARGET.accountId ||
    record.deploymentEnvironment !== DEPLOYMENT_TARGET.environmentId
  ) {
    throw new Error('Terraform baseline acceptance target is invalid.');
  }
  const approverPattern = new RegExp(
    `^arn:${DEPLOYMENT_TARGET.partition}:(?:iam|sts)::${DEPLOYMENT_TARGET.accountId}:` +
      '(?:user|role|assumed-role)/[^\\s]+$',
    'u',
  );
  if (typeof record.approver !== 'string' || !approverPattern.test(record.approver)) {
    throw new Error('Terraform baseline acceptance approver is invalid.');
  }
  const approvalTimestamp = record.approvalTimestamp;
  if (
    typeof approvalTimestamp !== 'string' ||
    !CANONICAL_TIMESTAMP_PATTERN.test(approvalTimestamp) ||
    Number.isNaN(Date.parse(approvalTimestamp)) ||
    new Date(approvalTimestamp).toISOString() !== approvalTimestamp
  ) {
    throw new Error('Terraform baseline acceptance timestamp is invalid.');
  }
  return deepFreeze({
    evidenceType: 'terraform-baseline-acceptance',
    root: rootAuthority.root,
    stateIdentity: rootAuthority.stateIdentity,
    backendKey: rootAuthority.backendKey,
    controlSourceSha,
    frameworkSourceSha,
    acceptedPlanChecksum,
    pipelineExecutionId,
    stageName: 'ManualApproval',
    actionName: expectedActionName,
    actionExecutionId,
    sourceSha,
    accountId: DEPLOYMENT_TARGET.accountId,
    deploymentEnvironment: DEPLOYMENT_TARGET.environmentId,
    reviewedPlanChecksum,
    approver: record.approver,
    approvalTimestamp,
  });
}

export function validateTerraformBaselineSmokeAdmission(value) {
  const record = exactKeys(value, SMOKE_ADMISSION_KEYS, 'Terraform baseline smoke admission');
  if (record.evidenceType !== 'terraform-baseline-smoke-admission') {
    throw new Error('Terraform baseline smoke admission evidence type is invalid.');
  }
  const { rootAuthority, controlSourceSha, frameworkSourceSha } = parseCommonAuthority(record);
  const targetContext = parseEvidenceReference(
    record.targetContext,
    'Terraform baseline smoke target context',
    rootAuthority,
    true,
  );
  const specializedSmokeSha256 = parseChecksum(
    record.specializedSmokeSha256,
    'Terraform baseline specialized smoke SHA-256',
  );
  const expectedSpecializedSmokeType = {
    bootstrap: 'bootstrap-codebuild-log-group-state',
    foundation: 'foundation-smoke',
    app: 'app-smoke-report',
  }[rootAuthority.root];
  if (record.specializedSmokeType !== expectedSpecializedSmokeType) {
    throw new Error('Terraform baseline specialized smoke type is invalid.');
  }
  const acceptedPlanChecksum = parseChecksum(
    record.acceptedPlanChecksum,
    'Terraform baseline smoke accepted plan checksum',
  );
  const pipelineExecutionId = parsePipelineExecutionId(record.pipelineExecutionId);
  if (record.smokeResult !== 'passed') {
    throw new Error('Terraform baseline smoke result is invalid.');
  }
  return deepFreeze({
    evidenceType: 'terraform-baseline-smoke-admission',
    root: rootAuthority.root,
    stateIdentity: rootAuthority.stateIdentity,
    backendKey: rootAuthority.backendKey,
    controlSourceSha,
    frameworkSourceSha,
    targetContext,
    acceptedPlanChecksum,
    pipelineExecutionId,
    specializedSmokeType: expectedSpecializedSmokeType,
    specializedSmokeSha256,
    smokeResult: 'passed',
  });
}

export function validateAcceptedTerraformBaseline(value) {
  const record = exactKeys(value, ACCEPTED_BASELINE_KEYS, 'Accepted Terraform baseline');
  if (record.recordType !== 'accepted-terraform-baseline') {
    throw new Error('Accepted Terraform baseline record type is invalid.');
  }
  const { rootAuthority, controlSourceSha, frameworkSourceSha } = parseCommonAuthority(record);
  let backend;
  try {
    backend = validateTerraformBackendAuthority(record.backend, rootAuthority.root);
  } catch (error) {
    throw new Error('Accepted Terraform baseline backend authority does not match its deployment target and state.', {
      cause: error,
    });
  }
  const targetContext = parseEvidenceReference(
    record.targetContext,
    'Accepted Terraform baseline target context',
    rootAuthority,
    true,
  );
  const inputManifest = parseEvidenceReference(
    record.inputManifest,
    'Accepted Terraform baseline input manifest',
    rootAuthority,
    true,
  );
  const providerEvidence = parseEvidenceReference(
    record.providerEvidence,
    'Accepted Terraform baseline provider evidence',
    rootAuthority,
    true,
  );
  const acceptedPlanChecksum = parseChecksum(record.acceptedPlanChecksum, 'Accepted Terraform baseline plan checksum');
  const acceptanceEvidence = parseEvidenceReference(
    record.acceptanceEvidence,
    'Accepted Terraform baseline acceptance evidence',
    rootAuthority,
    false,
  );
  const smokeEvidence = parseEvidenceReference(
    record.smokeEvidence,
    'Accepted Terraform baseline smoke evidence',
    rootAuthority,
    false,
  );
  const pipelineExecutionId = parsePipelineExecutionId(record.pipelineExecutionId);
  const publishedAt = parseCanonicalTimestamp(record.publishedAt);
  return deepFreeze({
    recordType: 'accepted-terraform-baseline',
    root: rootAuthority.root,
    stateIdentity: rootAuthority.stateIdentity,
    backendKey: rootAuthority.backendKey,
    backend,
    controlSourceSha,
    frameworkSourceSha,
    targetContext,
    inputManifest,
    providerEvidence,
    acceptedPlanChecksum,
    acceptanceEvidence,
    smokeEvidence,
    pipelineExecutionId,
    publishedAt,
  });
}

export function bindAdmittedAppTerraformBaseline({
  baselinePrefix,
  configuration,
  candidate,
  manifest,
  baseline,
  baselineReference,
  fetchedBaselineSha256,
}) {
  const reference = parseImmutableObjectReference(baselineReference);
  const expectedKey =
    `${baselinePrefix}/${configuration.stateIdentity}/executions/${candidate.pipelineExecutionId}/attempts/` +
    `${candidate.acceptanceAttemptId}/baseline.json`;
  if (reference.key !== expectedKey || reference.sha256 !== fetchedBaselineSha256) {
    throw new Error('App accepted Terraform baseline selection coordinates are invalid.');
  }
  if (
    baseline.root !== 'app' ||
    baseline.stateIdentity !== configuration.stateIdentity ||
    baseline.stateIdentity !== manifest.stateIdentity ||
    baseline.backendKey !== configuration.backendKey ||
    baseline.backendKey !== manifest.backendKey ||
    baseline.pipelineExecutionId !== candidate.pipelineExecutionId ||
    baseline.pipelineExecutionId !== manifest.pipelineExecutionId
  ) {
    throw new Error('App accepted Terraform baseline identity contradicts the accepted deployment.');
  }
  if (
    baseline.acceptedPlanChecksum !== candidate.planChecksum ||
    baseline.acceptedPlanChecksum !== manifest.planChecksum
  ) {
    throw new Error('App accepted Terraform baseline checksum contradicts the accepted deployment.');
  }
  if (
    baseline.controlSourceSha !== candidate.controlSourceSha ||
    baseline.controlSourceSha !== manifest.controlSourceSha
  ) {
    throw new Error('App accepted Terraform baseline source contradicts the accepted deployment.');
  }
  return reference;
}

export function validateCurrentTerraformBaselinePointer(value) {
  const record = exactKeys(value, CURRENT_POINTER_KEYS, 'Current Terraform baseline pointer');
  if (record.pointerType !== 'current-terraform-baseline') {
    throw new Error('Current Terraform baseline pointer type is invalid.');
  }
  const rootAuthority = parseRootAuthority(record);
  if (rootAuthority.root === 'app') {
    throw new Error('App Terraform baseline selection belongs to the accepted App deployment authority.');
  }
  const baseline = parseEvidenceReference(record.baseline, 'Current Terraform baseline record', rootAuthority, true);
  return deepFreeze({
    pointerType: 'current-terraform-baseline',
    root: rootAuthority.root,
    stateIdentity: rootAuthority.stateIdentity,
    backendKey: rootAuthority.backendKey,
    baseline,
  });
}
