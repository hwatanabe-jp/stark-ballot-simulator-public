/** Initial Bootstrap resource scope; it is not ordinary deployment authority. */
import {
  parseDeploymentLaneContext,
  resolveAllowedDeploymentTarget,
  resolveDeploymentLaneAuthority,
  validateAwsSsoCallerIdentityForPermissionSet,
} from './index.js';
import { createHash } from 'node:crypto';
import { snapshotBoundedBytes } from './exact-bytes.js';
import {
  decodeTerraformBaselineNonsecretInputValues,
  validateTerraformBaselineInputIdentity,
  validateTerraformBackendAuthority,
  validateBootstrapOperatorInputIdentity,
} from './terraform-authority.js';
import { snapshotDataTree, snapshotExactRecord } from './descriptor-snapshot.js';
import { assertProxyFreePortData } from './conditional-object-ledger.js';
import {
  canonicalJsonSha256,
  canonicalRecordJson,
  deepFreeze,
  isPlainRecord,
  parseS3VersionId,
  parseSha256,
  requireGroupedLowercaseUuid,
  requireString,
} from './internal.js';
import { summarizeBootstrapInitializationPlan } from './saved-plan-semantic-review.js';
import {
  BOOTSTRAP_CURRENT_ACCEPTANCE_POINTER_KIND,
  deriveTerraformAcceptancePointerKey,
} from './terraform-acceptance.js';

/** @typedef {'backend' | 'control-plane'} BootstrapInitializationPhase */

// These addresses bound the initializer's mutation authority. They deliberately
// exclude the remaining Bootstrap resources that the first managed full Apply
// will create. Terraform still derives dependency ordering from its own source.
const BACKEND_ADDRESSES = Object.freeze([
  'aws_kms_alias.state',
  'aws_kms_key.state',
  'aws_s3_bucket.state',
  'aws_s3_bucket_lifecycle_configuration.state',
  'aws_s3_bucket_policy.state',
  'aws_s3_bucket_public_access_block.state',
  'aws_s3_bucket_server_side_encryption_configuration.state',
  'aws_s3_bucket_versioning.state',
  'terraform_data.development_app_pipeline_identity_guard',
  'terraform_data.development_foundation_pipeline_identity_guard',
  'terraform_data.development_pipeline_identity_guard',
]);

const CONTROL_PLANE_ADDITIONS = Object.freeze([
  'aws_codebuild_project.bootstrap_smoke[0]',
  'aws_codebuild_project.terraform_apply[0]',
  'aws_codebuild_project.terraform_plan[0]',
  'aws_codeconnections_connection.source[0]',
  'aws_codepipeline.development[0]',
  'aws_iam_openid_connect_provider.github[0]',
  'aws_iam_policy.app_apply_deploy_permissions_boundary[0]',
  'aws_iam_policy.app_deploy_permissions_boundary[0]',
  'aws_iam_policy.bootstrap_apply_app_lane_iam_management[0]',
  'aws_iam_policy.bootstrap_apply_app_lane_pipeline_management[0]',
  'aws_iam_policy.bootstrap_apply_app_lane_role_attachment_management[0]',
  'aws_iam_policy.bootstrap_apply_foundation_lane_artifacts_management[0]',
  'aws_iam_policy.bootstrap_apply_foundation_lane_iam_management[0]',
  'aws_iam_policy.bootstrap_apply_foundation_lane_pipeline_management[0]',
  'aws_iam_policy.bootstrap_deploy_permissions_boundary[0]',
  'aws_iam_policy.foundation_apply_deploy_permissions_boundary[0]',
  'aws_iam_policy.foundation_smoke_deploy_permissions_boundary[0]',
  'aws_iam_policy.terraform_apply_app_lane_policy_admin[0]',
  'aws_iam_policy.terraform_apply_artifact_management[0]',
  'aws_iam_policy.terraform_baseline_authority_management[0]',
  'aws_iam_policy.terraform_baseline_authority_runtime_management[0]',
  'aws_iam_role.app_signature_preflight_apply[0]',
  'aws_iam_role.app_terraform_apply[0]',
  'aws_iam_role.app_terraform_plan[0]',
  'aws_iam_role.bootstrap_terraform_acceptance_publisher[0]',
  'aws_iam_role.foundation_terraform_acceptance_publisher[0]',
  'aws_iam_role.foundation_terraform_apply[0]',
  'aws_iam_role.foundation_terraform_smoke[0]',
  'aws_iam_role.github_trigger[0]',
  'aws_iam_role.pipeline[0]',
  'aws_iam_role.terraform_apply[0]',
  'aws_iam_role.terraform_plan[0]',
  'aws_iam_role.terraform_smoke[0]',
  'aws_iam_role_policy.pipeline[0]',
  'aws_iam_role_policy.terraform_apply[0]',
  'aws_iam_role_policy.terraform_apply_smoke_role_bootstrap[0]',
  'aws_iam_role_policy.terraform_plan[0]',
  'aws_iam_role_policy.terraform_plan_pipeline_state[0]',
  'aws_iam_role_policy.terraform_smoke[0]',
  'aws_iam_role_policy_attachment.bootstrap_apply_app_lane_iam_management[0]',
  'aws_iam_role_policy_attachment.bootstrap_apply_app_lane_pipeline_management[0]',
  'aws_iam_role_policy_attachment.bootstrap_apply_app_lane_role_attachment_management[0]',
  'aws_iam_role_policy_attachment.bootstrap_apply_foundation_lane_artifacts_management[0]',
  'aws_iam_role_policy_attachment.bootstrap_apply_foundation_lane_iam_management[0]',
  'aws_iam_role_policy_attachment.bootstrap_apply_foundation_lane_pipeline_management[0]',
  'aws_iam_role_policy_attachment.terraform_apply_app_lane_policy_admin[0]',
  'aws_iam_role_policy_attachment.terraform_apply_artifact_management[0]',
  'aws_iam_role_policy_attachment.terraform_baseline_authority_management[0]',
  'aws_iam_role_policy_attachment.terraform_baseline_authority_runtime_management[0]',
  'aws_kms_alias.pipeline_artifacts[0]',
  'aws_kms_alias.terraform_authority[0]',
  'aws_kms_key.pipeline_artifacts[0]',
  'aws_kms_key.terraform_authority[0]',
  'aws_s3_bucket.pipeline_artifacts[0]',
  'aws_s3_bucket.terraform_authority[0]',
  'aws_s3_bucket_lifecycle_configuration.pipeline_artifacts[0]',
  'aws_s3_bucket_lifecycle_configuration.terraform_authority[0]',
  'aws_s3_bucket_policy.pipeline_artifacts[0]',
  'aws_s3_bucket_policy.terraform_authority[0]',
  'aws_s3_bucket_public_access_block.pipeline_artifacts[0]',
  'aws_s3_bucket_public_access_block.terraform_authority[0]',
  'aws_s3_bucket_server_side_encryption_configuration.pipeline_artifacts[0]',
  'aws_s3_bucket_server_side_encryption_configuration.terraform_authority[0]',
  'aws_s3_bucket_versioning.pipeline_artifacts[0]',
  'aws_s3_bucket_versioning.terraform_authority[0]',
  'terraform_data.bootstrap_apply_authorization_propagation[0]',
  'terraform_data.terraform_baseline_authority_storage_authorization_propagation[0]',
]);

const BACKEND_TARGETS = Object.freeze([
  'aws_kms_alias.state',
  'aws_s3_bucket_lifecycle_configuration.state',
  'aws_s3_bucket_policy.state',
  'aws_s3_bucket_public_access_block.state',
  'aws_s3_bucket_server_side_encryption_configuration.state',
  'aws_s3_bucket_versioning.state',
  'terraform_data.development_app_pipeline_identity_guard',
  'terraform_data.development_foundation_pipeline_identity_guard',
  'terraform_data.development_pipeline_identity_guard',
]);

const CONTROL_PLANE_TARGETS = Object.freeze([
  'aws_codepipeline.development',
  'aws_iam_role_policy.pipeline',
  'aws_iam_role_policy.terraform_apply',
  'aws_iam_role_policy.terraform_apply_smoke_role_bootstrap',
  'aws_iam_role_policy.terraform_plan',
  'aws_iam_role_policy.terraform_plan_pipeline_state',
  'aws_iam_role_policy.terraform_smoke',
  'aws_iam_role_policy_attachment.bootstrap_apply_app_lane_iam_management',
  'aws_iam_role_policy_attachment.bootstrap_apply_app_lane_pipeline_management',
  'aws_iam_role_policy_attachment.bootstrap_apply_app_lane_role_attachment_management',
  'aws_iam_role_policy_attachment.bootstrap_apply_foundation_lane_artifacts_management',
  'aws_iam_role_policy_attachment.bootstrap_apply_foundation_lane_iam_management',
  'aws_iam_role_policy_attachment.bootstrap_apply_foundation_lane_pipeline_management',
  'aws_iam_role_policy_attachment.terraform_apply_app_lane_policy_admin',
  'aws_iam_role_policy_attachment.terraform_apply_artifact_management',
  'aws_iam_role_policy_attachment.terraform_baseline_authority_management',
  'aws_iam_role_policy_attachment.terraform_baseline_authority_runtime_management',
  'aws_kms_alias.pipeline_artifacts',
  'aws_kms_alias.state',
  'aws_kms_alias.terraform_authority',
  'aws_s3_bucket_lifecycle_configuration.pipeline_artifacts',
  'aws_s3_bucket_lifecycle_configuration.state',
  'aws_s3_bucket_lifecycle_configuration.terraform_authority',
  'aws_s3_bucket_policy.pipeline_artifacts',
  'aws_s3_bucket_policy.state',
  'aws_s3_bucket_policy.terraform_authority',
  'aws_s3_bucket_public_access_block.pipeline_artifacts',
  'aws_s3_bucket_public_access_block.state',
  'aws_s3_bucket_public_access_block.terraform_authority',
  'aws_s3_bucket_server_side_encryption_configuration.pipeline_artifacts',
  'aws_s3_bucket_server_side_encryption_configuration.state',
  'aws_s3_bucket_server_side_encryption_configuration.terraform_authority',
  'aws_s3_bucket_versioning.pipeline_artifacts',
  'aws_s3_bucket_versioning.state',
  'aws_s3_bucket_versioning.terraform_authority',
  'terraform_data.development_app_pipeline_identity_guard',
  'terraform_data.development_foundation_pipeline_identity_guard',
  'terraform_data.development_pipeline_identity_guard',
]);

/** @param {unknown} expectedTargetKey */
function initialTarget(expectedTargetKey) {
  const target = resolveAllowedDeploymentTarget(requireString(expectedTargetKey, 'Bootstrap initialization target'));
  if (target.environmentTier !== 'production' || target.environmentId !== 'main') {
    throw new Error('Bootstrap initialization is limited to the reviewed production target.');
  }
  return target;
}

/**
 * Render only reviewed initial values. Backend creation has no fabricated KMS
 * identifier; subsequent phases use the genuine backend state observation.
 * @param {unknown} value
 * @param {unknown} expectedTargetKey
 */
export function buildBootstrapInitializationInputs(value, expectedTargetKey) {
  const target = initialTarget(expectedTargetKey);
  assertProxyFreePortData(value, 'Bootstrap initial input request');
  const input = snapshotExactRecord(
    snapshotDataTree(value, 'Bootstrap initial input request'),
    ['context', 'operatorInputs', 'phase', 'backend'],
    'Bootstrap initial input request',
  );
  const context = parseDeploymentLaneContext(input['context']);
  if (
    context.target.accountLabel !== target.accountLabel ||
    context.target.environmentId !== target.environmentId ||
    context.root.lane !== 'bootstrap' ||
    context.source.requestedControlSourceSha !== context.source.frameworkSourceSha ||
    context.source.requestedControlSourceSha !== context.source.selectedApplicationSourceSha
  ) {
    throw new Error('Bootstrap initial inputs require the exact target and one selected source.');
  }
  const scope = resolveBootstrapInitializationScope(input['phase'], target.targetKey);
  const operator = snapshotExactRecord(
    input['operatorInputs'],
    ['backend_principal_arns', 'development_app_public_hostname', 'development_app_cloudfront_acm_certificate_arn'],
    'Bootstrap operator inputs',
  );
  validateBootstrapOperatorInputIdentity(
    operator['backend_principal_arns'],
    operator['development_app_public_hostname'],
    operator['development_app_cloudfront_acm_certificate_arn'],
    context,
  );
  const backend =
    scope.phase === 'backend'
      ? null
      : validateTerraformBackendAuthority(input['backend'], 'bootstrap', target.targetKey);
  if (scope.phase === 'backend' && input['backend'] !== null) {
    throw new Error('Initial backend creation cannot use an existing backend or fabricated key.');
  }
  return deepFreeze({
    backend_principal_arns: operator['backend_principal_arns'],
    development_app_public_hostname: operator['development_app_public_hostname'],
    development_app_cloudfront_acm_certificate_arn: operator['development_app_cloudfront_acm_certificate_arn'],
    account_alias: target.accountLabel,
    aws_account_id: target.accountId,
    aws_region: target.region,
    control_source_sha: context.source.requestedControlSourceSha,
    deployment_environment: target.environmentId,
    enable_development_app_pipeline: scope.phase === 'control-plane',
    enable_development_foundation_pipeline: scope.phase === 'control-plane',
    enable_development_pipeline: scope.phase === 'control-plane',
    github_full_repository_id: context.source.repository,
    project_name: context.project.projectId,
    protected_production_aws_account_id: null,
    source_branch: context.source.branch,
    state_backend_key: context.root.backendKey,
    state_bucket_name: context.names.terraformStateBucket,
    state_kms_alias: context.names.terraformStateKmsAlias,
    state_kms_key_id: backend === null ? null : backend.kmsKeyArn.slice(backend.kmsKeyArn.lastIndexOf('/') + 1),
    state_scope: context.root.scope,
    terraform_version: '1.15.8',
  });
}

/**
 * Compare Terraform's evaluated variables with the independently rendered
 * phase inputs, including the explicit null backend key before creation.
 * This does not widen normal accepted-input admission to nullable keys.
 * @param {unknown} planValue
 * @param {unknown} inputRequest
 * @param {unknown} expectedTargetKey
 */
export function assertBootstrapInitializationPlanInputs(planValue, inputRequest, expectedTargetKey) {
  const expected = buildBootstrapInitializationInputs(inputRequest, expectedTargetKey);
  assertProxyFreePortData(planValue, 'Bootstrap initial saved plan');
  const plan = snapshotDataTree(planValue, 'Bootstrap initial saved plan');
  if (!isPlainRecord(plan)) throw new Error('Bootstrap initial saved plan is invalid.');
  const variables = snapshotExactRecord(plan['variables'], Object.keys(expected), 'Bootstrap initial plan variables');
  for (const [name, value] of Object.entries(expected)) {
    const actual = snapshotExactRecord(variables[name], ['value'], 'Bootstrap initial plan variable');
    if (canonicalRecordJson(actual['value']) !== canonicalRecordJson(value)) {
      throw new Error(
        `Bootstrap initial saved-plan input ${name} does not match its independently rendered authority.`,
      );
    }
  }
}

/**
 * @param {unknown} phaseValue
 * @param {unknown} expectedTargetKey
 */
export function resolveBootstrapInitializationScope(phaseValue, expectedTargetKey) {
  const target = initialTarget(expectedTargetKey);
  if (phaseValue !== 'backend' && phaseValue !== 'control-plane') {
    throw new Error('Bootstrap initialization phase is invalid.');
  }
  const lane = resolveDeploymentLaneAuthority(target, 'bootstrap');
  const additions =
    phaseValue === 'backend'
      ? []
      : [
          ...CONTROL_PLANE_ADDITIONS,
          ...[lane.names.terraformPlanProject, lane.names.terraformApplyProject, lane.names.smokeProject].map(
            (value) => {
              const name = requireString(value, 'Bootstrap initialization log-group project');
              return `module.bootstrap_pipeline_codebuild_log_groups.aws_cloudwatch_log_group.this[${JSON.stringify(name)}]`;
            },
          ),
        ];
  const addresses = [...BACKEND_ADDRESSES, ...additions].sort();
  const targets = [...(phaseValue === 'backend' ? BACKEND_TARGETS : CONTROL_PLANE_TARGETS)].sort();
  return deepFreeze({
    phase: phaseValue,
    addresses,
    targets,
    scopeSha256: canonicalJsonSha256({ addresses, targets }),
  });
}

/**
 * Produce a redacted review for a limited initialization saved plan. The caller
 * must separately prove the initial AWS/state observation, exact source and
 * approval before Apply; this review never authorizes a normal full plan.
 *
 * @param {unknown} value
 * @param {unknown} expectedTargetKey
 */
export function buildBootstrapInitializationPlanReview(value, expectedTargetKey) {
  assertProxyFreePortData(value, 'Bootstrap initialization review');
  const target = initialTarget(expectedTargetKey);
  const input = snapshotExactRecord(
    snapshotDataTree(value, 'Bootstrap initialization review'),
    ['context', 'initializationId', 'phase', 'plan'],
    'Bootstrap initialization review',
  );
  const context = parseDeploymentLaneContext(input['context']);
  if (
    context.target.accountLabel !== target.accountLabel ||
    context.target.environmentId !== target.environmentId ||
    context.root.lane !== 'bootstrap' ||
    context.root.scope !== 'bootstrap' ||
    context.source.frameworkSourceSha !== context.source.requestedControlSourceSha ||
    context.source.selectedApplicationSourceSha !== context.source.requestedControlSourceSha
  ) {
    throw new Error('Bootstrap initialization context must match the exact target and one selected source.');
  }
  const initializationId = requireGroupedLowercaseUuid(input['initializationId'], 'Bootstrap initialization ID');
  const scope = resolveBootstrapInitializationScope(input['phase'], target.targetKey);
  const summary = summarizeBootstrapInitializationPlan(input['plan']);
  if (summary.drift.count !== 0) {
    throw new Error('Bootstrap initialization cannot adopt drift.');
  }
  const planBinding = snapshotExactRecord(
    input['plan'],
    ['planJson', 'planJsonSha256', 'tfplanSha256'],
    'Bootstrap initialization plan',
  );
  const plan = /** @type {Record<string, unknown>} */ (planBinding['planJson']);
  const changes = /** @type {Record<string, unknown>[]} */ (plan['resource_changes']);
  const seen = new Set();
  for (const resource of changes) {
    const address = requireString(resource['address'], 'Bootstrap initialization resource address');
    if (seen.has(address)) throw new Error('Bootstrap initialization plan has a duplicate resource address.');
    seen.add(address);
    const change = /** @type {Record<string, unknown>} */ (resource['change']);
    const actions = /** @type {string[]} */ (change['actions']);
    if (resource['mode'] === 'data') {
      if (
        resource['type'] !== 'aws_iam_policy_document' ||
        (!/^data\.aws_iam_policy_document\.[a-z_][a-z0-9_]*(?:\[0\])?$/u.test(address) &&
          !/^data\.aws_iam_policy_document\.saved_plan_approval_apply_read\["(?:app_terraform|app_verifier_preflight|foundation_terraform)"\]$/u.test(
            address,
          )) ||
        (actions.join(',') !== 'read' && actions.join(',') !== 'no-op')
      ) {
        throw new Error('Bootstrap initialization admits only local IAM policy-document reads.');
      }
      continue;
    }
    if (resource['mode'] !== 'managed' || !scope.addresses.includes(address)) {
      throw new Error('Bootstrap initialization resource is outside its reviewed phase scope.');
    }
    const expectedType = address.startsWith('module.')
      ? 'aws_cloudwatch_log_group'
      : address.slice(0, address.indexOf('.'));
    if (resource['type'] !== expectedType) {
      throw new Error('Bootstrap initialization resource type does not match its reviewed address.');
    }
    const priorBackend = scope.phase === 'control-plane' && BACKEND_ADDRESSES.includes(address);
    if (!isPlainRecord(change['after']) || (priorBackend && !isPlainRecord(change['before']))) {
      throw new Error('Bootstrap initialization resource has no exact created or existing state shape.');
    }
    if (!priorBackend) {
      if (actions.join(',') !== 'create' || change['before'] !== null) {
        throw new Error('Bootstrap initialization must create each new resource without adopting existing state.');
      }
    } else if (address === 'aws_kms_key.state' || address === 'aws_s3_bucket_policy.state') {
      if (actions.join(',') !== 'update' && actions.join(',') !== 'no-op') {
        throw new Error('Bootstrap initialization may only update the existing backend policies.');
      }
      const described = summary.changedAddresses.find((item) => item.address === address);
      if (
        described !== undefined &&
        [...described.changedAttributes, ...described.unknownAttributes].some((attribute) => attribute !== 'policy')
      ) {
        throw new Error('Bootstrap initialization cannot change backend attributes outside policy.');
      }
    } else if (actions.join(',') !== 'no-op') {
      throw new Error('Bootstrap initialization must preserve every existing non-policy backend resource.');
    }
    if (
      priorBackend &&
      actions.join(',') === 'no-op' &&
      (canonicalRecordJson(change['before']) !== canonicalRecordJson(change['after']) ||
        canonicalRecordJson(change['after_unknown']) !== canonicalRecordJson({}))
    ) {
      throw new Error('Bootstrap initialization backend no-op must have identical values and no unknown changes.');
    }
  }
  if (scope.addresses.some((address) => !seen.has(address))) {
    throw new Error('Bootstrap initialization plan omits a required phase resource.');
  }
  const review = {
    reviewType: /** @type {const} */ ('bootstrap-initialization-plan-review'),
    initializationId,
    targetKey: target.targetKey,
    targetConfigurationSha256: context.targetConfigurationSha256,
    sourceSha: context.source.requestedControlSourceSha,
    stateIdentity: context.root.stateIdentity,
    phase: scope.phase,
    scopeSha256: scope.scopeSha256,
    summary,
  };
  return deepFreeze({ ...review, reviewSha256: canonicalJsonSha256(review) });
}

/**
 * Read only the metadata needed to bind a genuine Terraform-generated seed
 * state. The original bytes are never rewritten or included in the result.
 * This is not an import/adoption or retained-acceptance conversion path.
 * @param {unknown} value
 * @param {unknown} phase
 * @param {unknown} expectedTargetKey
 */
export function observeBootstrapInitializationState(value, phase, expectedTargetKey) {
  const target = initialTarget(expectedTargetKey);
  const scope = resolveBootstrapInitializationScope(phase, target.targetKey);
  const bytes = snapshotBoundedBytes(value, { label: 'Bootstrap initialization state', maxBytes: 8 * 1024 * 1024 });
  let parsed;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    // Native JSON errors can contain state fragments. Never retain their cause.
    throw new Error('Bootstrap initialization state must contain valid UTF-8 JSON.');
  }
  if (
    !isPlainRecord(parsed) ||
    parsed['version'] !== 4 ||
    parsed['terraform_version'] !== '1.15.8' ||
    !Number.isSafeInteger(parsed['serial']) ||
    /** @type {number} */ (parsed['serial']) < 1 ||
    !Array.isArray(parsed['resources']) ||
    parsed['resources'].length > 256
  ) {
    throw new Error('Bootstrap initialization state has invalid runtime or state metadata.');
  }
  const lineage = requireGroupedLowercaseUuid(parsed['lineage'], 'Bootstrap initialization state lineage');
  /** @type {Map<string, Record<string, unknown>>} */
  const managed = new Map();
  for (const resource of parsed['resources']) {
    if (!isPlainRecord(resource) || !Array.isArray(resource['instances']) || resource['instances'].length > 128) {
      throw new Error('Bootstrap initialization state resource shape is invalid.');
    }
    const mode = resource['mode'];
    const type = resource['type'];
    const name = resource['name'];
    if (
      typeof type !== 'string' ||
      !/^[a-z_][a-z0-9_]*$/u.test(type) ||
      typeof name !== 'string' ||
      !/^[a-z_][a-z0-9_]*$/u.test(name) ||
      (mode !== 'managed' && mode !== 'data')
    ) {
      throw new Error('Bootstrap initialization state resource identity is invalid.');
    }
    if (mode === 'data') {
      if (
        type !== 'aws_iam_policy_document' ||
        Object.hasOwn(resource, 'module') ||
        resource['provider'] !== 'provider["registry.terraform.io/hashicorp/aws"]'
      ) {
        throw new Error('Bootstrap initialization state contains external data discovery.');
      }
      continue;
    }
    const moduleName = resource['module'];
    if (moduleName !== undefined && moduleName !== 'module.bootstrap_pipeline_codebuild_log_groups') {
      throw new Error('Bootstrap initialization state contains an unreviewed module.');
    }
    const expectedProvider =
      type === 'terraform_data'
        ? 'provider["terraform.io/builtin/terraform"]'
        : 'provider["registry.terraform.io/hashicorp/aws"]';
    if (resource['provider'] !== expectedProvider) {
      throw new Error('Bootstrap initialization state contains an unreviewed provider.');
    }
    for (const instance of resource['instances']) {
      if (
        !isPlainRecord(instance) ||
        !isPlainRecord(instance['attributes']) ||
        Object.hasOwn(instance, 'deposed') ||
        Object.hasOwn(instance, 'status')
      ) {
        throw new Error('Bootstrap initialization state contains an invalid, deposed or tainted instance.');
      }
      const index = instance['index_key'];
      if (index !== undefined && index !== 0 && typeof index !== 'string') {
        throw new Error('Bootstrap initialization state instance index is invalid.');
      }
      const address = `${moduleName === undefined ? '' : `${moduleName}.`}${type}.${name}${index === undefined ? '' : `[${JSON.stringify(index)}]`}`;
      if (!scope.addresses.includes(address) || managed.has(address)) {
        throw new Error('Bootstrap initialization state is outside its exact phase resource scope.');
      }
      managed.set(address, instance['attributes']);
    }
  }
  if (managed.size !== scope.addresses.length || scope.addresses.some((address) => !managed.has(address))) {
    throw new Error('Bootstrap initialization state is incomplete for its phase.');
  }
  const bucket = managed.get('aws_s3_bucket.state');
  const key = managed.get('aws_kms_key.state');
  const alias = managed.get('aws_kms_alias.state');
  const lane = resolveDeploymentLaneAuthority(target, 'bootstrap');
  if (
    bucket === undefined ||
    key === undefined ||
    alias === undefined ||
    bucket['bucket'] !== lane.names.terraformStateBucket ||
    bucket['id'] !== lane.names.terraformStateBucket ||
    alias['name'] !== lane.names.terraformStateKmsAlias ||
    alias['target_key_id'] !== key['key_id'] ||
    typeof key['key_id'] !== 'string' ||
    key['id'] !== key['key_id'] ||
    key['arn'] !== `arn:${target.partition}:kms:${target.region}:${target.accountId}:key/${key['key_id']}`
  ) {
    throw new Error('Bootstrap initialization state backend identity does not match the reviewed target.');
  }
  const backend = validateTerraformBackendAuthority(
    { bucketName: bucket['bucket'], backendKey: lane.backendKey, kmsKeyArn: key['arn'], region: target.region },
    'bootstrap',
    target.targetKey,
  );
  return deepFreeze({
    observationType: /** @type {const} */ ('bootstrap-initialization-state'),
    targetKey: target.targetKey,
    phase: scope.phase,
    lineage,
    serial: /** @type {number} */ (parsed['serial']),
    sha256: createHash('sha256').update(bytes).digest('hex'),
    byteLength: bytes.byteLength,
    managedResourceCount: managed.size,
    backend,
  });
}

const INITIAL_INPUT_VARIABLES = Object.freeze([
  'BootstrapInputMode',
  'BootstrapInitializationId',
  'BootstrapInitializationVersionId',
  'BootstrapInitializationSha256',
]);

/**
 * Select initial inputs only from an independently observed running execution.
 * Missing variables, an implicit start, and an untrusted trigger never select
 * initialization. Normal accepted-input execution has no manifest reference.
 * @param {unknown} value
 * @param {unknown} contextValue
 * @param {unknown} pipelineExecutionIdValue
 * @param {unknown} expectedTargetKey
 */
export function selectBootstrapInitializationInputs(value, contextValue, pipelineExecutionIdValue, expectedTargetKey) {
  return selectBootstrapInputs(value, contextValue, pipelineExecutionIdValue, expectedTargetKey, 'InProgress');
}

/** @param {unknown} value @param {unknown} contextValue @param {unknown} pipelineExecutionIdValue @param {unknown} expectedTargetKey @param {'InProgress' | 'Failed'} status */
function selectBootstrapInputs(value, contextValue, pipelineExecutionIdValue, expectedTargetKey, status) {
  const target = initialTarget(expectedTargetKey);
  const context = parseDeploymentLaneContext(contextValue);
  if (
    context.target.accountLabel !== target.accountLabel ||
    context.target.environmentId !== target.environmentId ||
    context.root.lane !== 'bootstrap' ||
    context.source.requestedControlSourceSha !== context.source.selectedApplicationSourceSha ||
    context.source.requestedControlSourceSha !== context.source.frameworkSourceSha
  )
    throw new Error('Bootstrap initial input context does not match the independently selected target and source.');
  const pipelineExecutionId = requireGroupedLowercaseUuid(pipelineExecutionIdValue, 'Bootstrap input execution ID');
  assertProxyFreePortData(value, 'Bootstrap input execution response');
  const response = snapshotDataTree(value, 'Bootstrap input execution response');
  if (!isPlainRecord(response) || !isPlainRecord(response['pipelineExecution'])) {
    throw new Error('Bootstrap input execution response is invalid.');
  }
  const execution = response['pipelineExecution'];
  if (
    execution['pipelineName'] !== context.names.pipeline ||
    execution['pipelineExecutionId'] !== pipelineExecutionId ||
    execution['status'] !== status ||
    (Object.hasOwn(execution, 'executionType') && execution['executionType'] !== 'STANDARD') ||
    Object.hasOwn(execution, 'rollbackMetadata')
  )
    throw new Error('Bootstrap initial inputs require the exact running standard pipeline execution.');
  const revisions = execution['artifactRevisions'];
  if (
    !Array.isArray(revisions) ||
    revisions.length !== 1 ||
    !isPlainRecord(revisions[0]) ||
    revisions[0]['name'] !== 'SourceOutput' ||
    revisions[0]['revisionId'] !== context.source.requestedControlSourceSha
  )
    throw new Error('Bootstrap initial input execution does not match the exact source.');
  const variables = execution['variables'];
  if (!Array.isArray(variables) || variables.length !== INITIAL_INPUT_VARIABLES.length) {
    throw new Error('Production Bootstrap input variables must use the exact reviewed shape.');
  }
  const selected = new Map();
  for (const item of variables) {
    const variable = snapshotExactRecord(item, ['name', 'resolvedValue'], 'Bootstrap input variable');
    const name = requireString(variable['name'], 'Bootstrap input variable name');
    if (!INITIAL_INPUT_VARIABLES.includes(name) || selected.has(name)) {
      throw new Error('Production Bootstrap input variable is unknown or duplicated.');
    }
    selected.set(name, requireString(variable['resolvedValue'], 'Bootstrap input variable value'));
  }
  const mode = selected.get('BootstrapInputMode');
  if (mode === 'accepted') {
    if (INITIAL_INPUT_VARIABLES.slice(1).some((name) => selected.get(name) !== 'disabled')) {
      throw new Error('Accepted Bootstrap inputs cannot carry an initialization selector.');
    }
    return null;
  }
  if (mode !== 'initial' && (mode !== 'recovery' || status !== 'InProgress'))
    throw new Error('Bootstrap input mode must be explicitly accepted, initial or recovery.');
  const trigger = execution['trigger'];
  if (!isPlainRecord(trigger) || trigger['triggerType'] !== 'StartPipelineExecution') {
    throw new Error('Bootstrap initialization requires an explicit administrator pipeline start.');
  }
  const { arn: administratorArn } = validateAwsSsoCallerIdentityForPermissionSet(
    { Account: target.accountId, Arn: trigger['triggerDetail'] },
    target,
    'AdministratorAccess',
  );
  const initializationId = requireGroupedLowercaseUuid(
    selected.get('BootstrapInitializationId'),
    'Bootstrap initialization ID',
  );
  return deepFreeze({
    mode,
    initializationId,
    pipelineExecutionId,
    administratorArn,
    manifest: {
      key: `initializations/bootstrap/${initializationId}.json`,
      versionId: parseS3VersionId(
        selected.get('BootstrapInitializationVersionId'),
        'Bootstrap initialization manifest VersionId',
      ),
      sha256: parseSha256(selected.get('BootstrapInitializationSha256'), 'Bootstrap initialization manifest SHA-256'),
    },
  });
}

/**
 * Admit the initial input handoff against the live seed state and independently
 * selected execution. The state bytes are inspected but never retained here.
 * The producer must repeat the same observation after Terraform Plan.
 * @param {unknown} value
 * @param {unknown} stateBytes
 * @param {unknown} expectedTargetKey
 */
export function admitBootstrapInitializationHandoff(value, stateBytes, expectedTargetKey) {
  return admitInitializationHandoff(value, stateBytes, expectedTargetKey, 'InProgress');
}

/** Exact historical initial handoff for an explicitly failed managed execution; never ordinary input selection.
 * @param {unknown} value @param {unknown} stateBytes @param {unknown} expectedTargetKey */
export function admitFailedBootstrapInitializationHandoff(value, stateBytes, expectedTargetKey) {
  return admitInitializationHandoff(value, stateBytes, expectedTargetKey, 'Failed');
}

/** @param {unknown} value @param {unknown} stateBytes @param {unknown} expectedTargetKey @param {'InProgress' | 'Failed'} status */
function admitInitializationHandoff(value, stateBytes, expectedTargetKey, status) {
  assertProxyFreePortData(value, 'Bootstrap initialization handoff');
  const target = initialTarget(expectedTargetKey);
  const input = snapshotExactRecord(
    snapshotDataTree(value, 'Bootstrap initialization handoff'),
    ['context', 'executionResponse', 'manifest', 'pipelineExecutionId', 'stateVersionId'],
    'Bootstrap initialization handoff',
  );
  const context = parseDeploymentLaneContext(input['context']);
  const selection = selectBootstrapInputs(
    input['executionResponse'],
    context,
    input['pipelineExecutionId'],
    target.targetKey,
    status,
  );
  if (selection === null || selection.mode !== 'initial')
    throw new Error('Bootstrap initial handoff requires explicit initial input selection.');
  const manifest = snapshotExactRecord(
    input['manifest'],
    [
      'administratorArn',
      'backendPlanReviewSha256',
      'context',
      'controlPlanePlanReviewSha256',
      'initializationId',
      'kind',
      'nonsecretInputs',
      'seedState',
      'seedStateVersionId',
    ],
    'Bootstrap initialization manifest',
  );
  if (
    manifest['kind'] !== 'bootstrap-initialization' ||
    manifest['initializationId'] !== selection.initializationId ||
    manifest['administratorArn'] !== selection.administratorArn ||
    canonicalRecordJson(manifest['context']) !== canonicalRecordJson(context) ||
    createHash('sha256').update(canonicalRecordJson(manifest)).digest('hex') !== selection.manifest.sha256
  )
    throw new Error(
      'Bootstrap initialization manifest is detached from its exact execution, administrator, source or checksum.',
    );
  parseSha256(manifest['backendPlanReviewSha256'], 'Bootstrap backend plan review SHA-256');
  parseSha256(manifest['controlPlanePlanReviewSha256'], 'Bootstrap control-plane plan review SHA-256');
  const stateVersionId = parseS3VersionId(input['stateVersionId'], 'Bootstrap seed state VersionId');
  if (manifest['seedStateVersionId'] !== stateVersionId) {
    throw new Error('Bootstrap initialization seed state version changed.');
  }
  const state = observeBootstrapInitializationState(stateBytes, 'control-plane', target.targetKey);
  if (canonicalRecordJson(manifest['seedState']) !== canonicalRecordJson(state)) {
    throw new Error('Bootstrap initialization requires the complete exact seed state from its own initialization.');
  }
  const nonsecretInputs = validateTerraformBaselineInputIdentity(manifest['nonsecretInputs'], context, {
    terraformVersion: '1.15.8',
    stateBucketName: state.backend.bucketName,
    stateKmsAlias: context.names.terraformStateKmsAlias,
    stateKmsKeyArn: state.backend.kmsKeyArn,
  });
  if (nonsecretInputs.root !== 'bootstrap')
    throw new Error('Bootstrap initialization inputs must use the Bootstrap root.');
  const variables = decodeTerraformBaselineNonsecretInputValues(nonsecretInputs);
  if (
    ['enable_development_pipeline', 'enable_development_app_pipeline', 'enable_development_foundation_pipeline'].some(
      (name) => variables[name] !== true,
    )
  ) {
    throw new Error('Bootstrap initialization handoff must enable the complete managed deployment composition.');
  }
  return deepFreeze({
    initializationId: selection.initializationId,
    manifest: selection.manifest,
    nonsecretInputs,
    state,
    stateVersionId,
  });
}

/**
 * An empty exact-prefix version inventory is necessary for initialization.
 * Truncation, delete markers, or any retained object fail closed; neither an
 * access error nor a missing response is evidence of first creation.
 * @param {unknown} value
 * @param {unknown} expectedTargetKey
 */
export function assertBootstrapAcceptanceNeverPublished(value, expectedTargetKey) {
  assertProxyFreePortData(value, 'Bootstrap current pointer version inventory');
  const target = initialTarget(expectedTargetKey);
  const lane = resolveDeploymentLaneAuthority(target, 'bootstrap');
  const prefix = deriveTerraformAcceptancePointerKey(BOOTSTRAP_CURRENT_ACCEPTANCE_POINTER_KIND, target.targetKey);
  const response = snapshotDataTree(value, 'Bootstrap current pointer version inventory');
  if (
    !isPlainRecord(response) ||
    response['Name'] !== lane.names.terraformAuthorityBucket ||
    response['Prefix'] !== prefix ||
    response['IsTruncated'] !== false ||
    response['MaxKeys'] !== 1 ||
    ['KeyMarker', 'VersionIdMarker', 'NextKeyMarker', 'NextVersionIdMarker', 'Delimiter'].some(
      (name) => Object.hasOwn(response, name) && response[name] !== '',
    ) ||
    (Object.hasOwn(response, 'EncodingType') &&
      response['EncodingType'] !== '' &&
      response['EncodingType'] !== 'url') ||
    ['Versions', 'DeleteMarkers', 'CommonPrefixes'].some(
      (name) => Object.hasOwn(response, name) && (!Array.isArray(response[name]) || response[name].length !== 0),
    )
  ) {
    throw new Error(
      'Bootstrap initialization requires a complete empty version inventory for its exact current pointer.',
    );
  }
}
