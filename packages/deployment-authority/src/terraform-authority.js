import { admitArrayOwnMetadata } from './descriptor-snapshot.js';
/**
 * Pure Terraform authority validators shared by accepted deployment lanes.
 */

/**
 * @typedef {'bootstrap' | 'foundation' | 'app'} TerraformRoot
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
    readonly deploymentMode?: 'normal';
    readonly stateBucketName?: string;
    readonly stateKmsAlias?: string;
    readonly stateKmsKeyArn?: string;
    readonly terraformVersion?: string;
}} TerraformInputIdentityOptions
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
  requireString,
} from './internal.js';
import { parseDeploymentLaneContext, resolveAllowedDeploymentTarget, resolveDeploymentLaneAuthority } from './index.js';

const TERRAFORM_VERSION_PATTERN = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/u;
const AWS_PROVIDER_ADDRESS = 'registry.terraform.io/hashicorp/aws';
const CANONICAL_BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;
const S3_BUCKET_NAME_PATTERN = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/u;
const KMS_KEY_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const NONSECRET_INPUT_KEYS = ['evidenceType', 'files', 'root', 'secretValuesIncluded'];
const NONSECRET_INPUT_FILE_KEYS = ['contentBase64', 'path', 'sha256'];
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
  'image_signature_status_attempt_timeout_ms',
  'image_signature_status_max_attempts',
  'image_signature_status_retry_delay_ms',
  'image_signature_verifier_handler_deadline_ms',
  'image_signature_verifier_lambda_timeout_seconds',
  'image_signature_verifier_permissions_boundary_arn',
  'image_signature_verifier_process_timeout_ms',
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

const APP_STORED_INPUT_KEYS = [...APP_INPUT_KEYS].sort();
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
  const { array, ownKeys } = admitArrayOwnMetadata(
    value,
    `${label} must be an array.`,
    `${label} must be a dense array.`,
  );
  if (ownKeys.length !== array.length + 1) throw new Error(`${label} must be a dense array.`);
  for (let index = 0; index < array.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(array, String(index));
    if (descriptor === undefined || descriptor.enumerable !== true || !Object.hasOwn(descriptor, 'value')) {
      throw new Error(`${label} must be a dense array.`);
    }
  }
  return array;
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
  const { body, contentBase64 } = decodeNonsecretInputBytes(record['contentBase64']);
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
    contentBase64,
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
    } else if (key === 'development_app_cloudfront_acm_certificate_arn') {
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
    validateLambdaArtifactFieldTypes(artifact, name);
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
        'lambda_artifacts',
        'prover_security_group_ids',
        'prover_subnet_ids',
      ].includes(key),
  );
  for (const key of stringKeys) {
    requireValueType(value[key], 'string', `App Terraform baseline ${key}`);
  }
  for (const key of ['cloudfront_acm_certificate_arn']) {
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
function validateBootstrapOperatorInputIdentity(principals, hostname, certificate, contextValue) {
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

  if (inputs.root === 'bootstrap') validateBootstrapBaselineIdentity(variables, context, options);
  else if (inputs.root === 'app') validateAppBaselineIdentity(variables, context, options);
  return inputs;
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

/**
 * Bind reviewed nonsecret operator settings to the exact source/target. The
 * source controls these settings; changing them receives the ordinary full
 * Terraform plan and approval, independent of any previous acceptance shape.
 * @param {unknown} contextValue
 * @param {unknown} configurationValue
 */
export function buildBootstrapConfiguredInputs(contextValue, configurationValue) {
  const context = parseDeploymentLaneContext(contextValue);
  if (context.root.lane !== 'bootstrap') throw new Error('Bootstrap configuration requires the Bootstrap root.');
  const config = exactKeys(
    configurationValue,
    ['backendPrincipalRolePaths', 'cloudfrontCertificateId', 'publicHostname', 'stateKmsKeyId'],
    'Bootstrap operator configuration',
  );
  const hostname = config['publicHostname'];
  if (
    typeof hostname !== 'string' ||
    !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/u.test(
      hostname,
    )
  )
    throw new Error('Bootstrap public hostname is invalid.');
  const rolePaths = config['backendPrincipalRolePaths'];
  if (
    !Array.isArray(rolePaths) ||
    rolePaths.length === 0 ||
    new Set(rolePaths).size !== rolePaths.length ||
    rolePaths.some((role) => typeof role !== 'string' || !/^[A-Za-z0-9+=,.@_/-]+$/u.test(role))
  )
    throw new Error('Bootstrap backend principal role paths are invalid.');
  const keyId = config['stateKmsKeyId'];
  const certificateId = config['cloudfrontCertificateId'];
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
  if (
    typeof keyId !== 'string' ||
    !uuid.test(keyId) ||
    (certificateId !== null && (typeof certificateId !== 'string' || !uuid.test(certificateId)))
  )
    throw new Error('Bootstrap KMS key and certificate identities are invalid.');
  const target = context.target;
  const values = {
    account_alias: target.accountLabel,
    aws_account_id: target.accountId,
    aws_region: target.region,
    backend_principal_arns: rolePaths.map((role) => `arn:${target.partition}:iam::${target.accountId}:role/${role}`),
    control_source_sha: context.source.requestedControlSourceSha,
    deployment_environment: target.environmentId,
    development_app_cloudfront_acm_certificate_arn:
      certificateId === null
        ? null
        : `arn:${target.partition}:acm:us-east-1:${target.accountId}:certificate/${certificateId}`,
    development_app_public_hostname: config['publicHostname'],
    enable_development_app_pipeline: true,
    enable_development_foundation_pipeline: true,
    enable_development_pipeline: true,
    github_full_repository_id: context.source.repository,
    project_name: context.project.projectId,
    source_branch: context.source.branch,
    state_backend_key: context.root.backendKey,
    state_bucket_name: context.names.terraformStateBucket,
    state_kms_alias: context.names.terraformStateKmsAlias,
    state_kms_key_id: keyId,
    state_scope: context.root.scope,
    terraform_version: '1.17.0',
  };
  return validateTerraformBaselineInputIdentity(
    buildTerraformBaselineNonsecretInputs('bootstrap', {
      variables: Object.fromEntries(Object.entries(values).map(([key, value]) => [key, { value }])),
    }),
    context,
    {
      stateBucketName: context.names.terraformStateBucket,
      stateKmsAlias: context.names.terraformStateKmsAlias,
      terraformVersion: '1.17.0',
    },
  );
}

/** @typedef {ReturnType<typeof parseDeploymentLaneContext>} DeploymentContext */
/** @param {Record<string, unknown>} variables @param {DeploymentContext} context @param {TerraformInputIdentityOptions} options */
function validateBootstrapBaselineIdentity(variables, context, options) {
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
  assertInputIdentity(variables['source_branch'], context.source.branch, 'Bootstrap Terraform baseline source branch');
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
  validateBootstrapExpectedInputs(variables, options);
}
/** @param {Record<string, unknown>} variables @param {TerraformInputIdentityOptions} options */
function validateBootstrapExpectedInputs(variables, options) {
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
  validateBootstrapExpectedKmsKey(variables, options.stateKmsKeyArn);
}
/** @param {Record<string, unknown>} variables @param {string|undefined} keyArn */
function validateBootstrapExpectedKmsKey(variables, keyArn) {
  if (keyArn !== undefined) {
    const keyId =
      typeof keyArn === 'string'
        ? keyArn.match(/^arn:aws:kms:[a-z0-9-]+:[0-9]{12}:key\/([0-9a-f-]{36})$/u)?.[1]
        : undefined;
    if (keyId === undefined) {
      throw new Error('Terraform baseline state KMS key ARN is invalid.');
    }
    assertInputIdentity(variables['state_kms_key_id'], keyId, 'Bootstrap Terraform baseline state KMS key');
  }
}
/** @param {Record<string, unknown>} variables @param {DeploymentContext} context @param {TerraformInputIdentityOptions} options */
function validateAppBaselineIdentity(variables, context, options) {
  validateTargetPublicHostnameInputs(
    variables['public_hostname'],
    variables['cloudfront_acm_certificate_arn'],
    context,
  );
  validateProductionAppOrigin(variables, context);
  assertInputIdentity(
    variables['app_source_sha'],
    context.source.selectedApplicationSourceSha,
    'App Terraform baseline selected source',
  );
  if (variables['deploy_mode'] !== 'normal') {
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
}
/** @param {Record<string, unknown>} variables @param {DeploymentContext} context */
function validateProductionAppOrigin(variables, context) {
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
}

/** @param {unknown} contentBase64 */
function decodeNonsecretInputBytes(contentBase64) {
  if (
    typeof contentBase64 !== 'string' ||
    contentBase64.length === 0 ||
    !CANONICAL_BASE64_PATTERN.test(contentBase64)
  ) {
    throw new Error('Terraform baseline nonsecret input content is invalid.');
  }
  const body = Buffer.from(contentBase64, 'base64');
  if (
    body.length === 0 ||
    body.length > MAX_NONSECRET_INPUT_BYTES ||
    body.includes(0) ||
    body.toString('base64') !== contentBase64
  ) {
    throw new Error('Terraform baseline nonsecret input content is invalid.');
  }
  return { body, contentBase64 };
}

/** @param {Record<string,unknown>} artifact @param {string} name */
function validateLambdaArtifactFieldTypes(artifact, name) {
  for (const key of LAMBDA_ARTIFACT_KEYS) {
    const nullable = key === 'asset_manifest_sha256' || key === 'trust_root_sha256';
    requireValueType(artifact[key], 'string', `App Terraform baseline lambda_artifacts.${name}.${key}`, {
      nullable,
    });
  }
}
