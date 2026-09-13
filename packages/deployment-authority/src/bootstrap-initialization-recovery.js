import { createHash } from 'node:crypto';
import { parseDeploymentLaneContext, validateAwsSsoCallerIdentityForPermissionSet } from './index.js';
import { snapshotDataTree, snapshotExactRecord } from './descriptor-snapshot.js';
import { snapshotBoundedBytes } from './exact-bytes.js';
import {
  canonicalRecordJson,
  deepFreeze,
  isPlainRecord,
  parseS3VersionId,
  requireGroupedLowercaseUuid,
  requireString,
} from './internal.js';
import { resolveAllowedDeploymentTarget } from './index.js';
import {
  admitFailedBootstrapInitializationHandoff,
  selectBootstrapInitializationInputs,
} from './bootstrap-initialization.js';
import {
  admitCompactSavedPlanApprovalSummary,
  deriveSavedPlanApprovalEvidenceKey,
} from './saved-plan-approval-evidence.js';
import {
  buildTerraformBaselineNonsecretInputs,
  decodeTerraformBaselineNonsecretInputValues,
} from './terraform-authority.js';

const MANIFEST_KEYS = [
  'administratorArn',
  'context',
  'initializationId',
  'kind',
  'previous',
  'state',
  'stateVersionId',
];
const PREVIOUS_KEYS = ['approvalEvidence', 'approvalReference', 'executionId', 'initialManifest'];
const MAX_STATE_BYTES = 8 * 1024 * 1024;
const MAX_PLAN_BYTES = 64 * 1024 * 1024;
const RECOVERY_POLICY_UPDATES = new Set([
  'aws_iam_policy.bootstrap_apply_app_lane_pipeline_management[0]',
  'aws_iam_policy.bootstrap_apply_foundation_lane_artifacts_management[0]',
]);

/** @param {unknown} value @param {string} label */
function record(value, label) {
  if (!isPlainRecord(value)) throw new Error(`${label} must be a record.`);
  return value;
}
/** @param {unknown} value @param {string} label @param {number} maxBytes */
function document(value, label, maxBytes) {
  const body = snapshotBoundedBytes(value, { label, maxBytes });
  let parsed;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
  } catch {
    throw new Error(`${label} must be valid bounded UTF-8 JSON.`);
  }
  return { value: record(parsed, label), body, sha256: createHash('sha256').update(body).digest('hex') };
}

/** The previous execution must have reached, and failed in, its first managed Apply.
 * No retry, superseded execution, recovery chain, skipped gate or successful smoke is admitted.
 * @param {unknown} value @param {unknown} executionIdValue */
export function selectFailedBootstrapApplyActions(value, executionIdValue) {
  const executionId = requireGroupedLowercaseUuid(executionIdValue, 'Previous Bootstrap execution ID');
  const response = snapshotExactRecord(
    snapshotDataTree(value, 'Previous Bootstrap actions'),
    ['actionExecutionDetails'],
    'Previous Bootstrap actions',
  );
  const details = response['actionExecutionDetails'];
  const expected = [
    ['Source', 'Source', 'Succeeded'],
    ['TerraformPlan', 'Plan', 'Succeeded'],
    ['ManualApproval', 'ApproveBootstrapApply', 'Succeeded'],
    ['TerraformApply', 'ApplySavedPlan', 'Failed'],
  ];
  if (!Array.isArray(details) || details.length !== expected.length)
    throw new Error('Recovery requires one complete failed initial Apply history without retries.');
  const selected = expected.map(([stage, action, status]) => {
    const matches = details.filter(
      (item) => isPlainRecord(item) && item['stageName'] === stage && item['actionName'] === action,
    );
    const item = record(matches[0], 'Previous Bootstrap action');
    if (matches.length !== 1 || item['pipelineExecutionId'] !== executionId || item['status'] !== status)
      throw new Error('Recovery requires the exact successful Plan and approval followed by failed Apply.');
    requireGroupedLowercaseUuid(item['actionExecutionId'], 'Previous Bootstrap action ID');
    return item;
  });
  const approval = record(selected[2], 'Previous Bootstrap approval');
  if (new Set(selected.map((item) => item['actionExecutionId'])).size !== expected.length)
    throw new Error('Previous Bootstrap actions have duplicated execution identities.');
  const result = record(
    record(approval['output'], 'Previous approval output')['executionResult'],
    'Previous approval result',
  );
  if (result['externalExecutionId'] !== approval['actionExecutionId'])
    throw new Error('Previous approval is detached from its action.');
  return deepFreeze({
    actionExecutionId: approval['actionExecutionId'],
    compactSummary: requireString(result['externalExecutionSummary'], 'Previous approval compact summary'),
  });
}

/** @param {Record<string, unknown>} state */
function stateInstances(state) {
  if (
    state['version'] !== 4 ||
    state['terraform_version'] !== '1.15.8' ||
    !Number.isSafeInteger(state['serial']) ||
    Number(state['serial']) < 1 ||
    !Array.isArray(state['resources']) ||
    state['resources'].length > 1024
  )
    throw new Error('Recovery state runtime or resource bounds are invalid.');
  requireGroupedLowercaseUuid(state['lineage'], 'Recovery state lineage');
  /** @type {Map<string, {type: string, attributes: Record<string, unknown>}>} */
  const managed = new Map();
  for (const item of state['resources']) {
    const resource = record(item, 'Recovery state resource');
    const type = requireString(resource['type'], 'Recovery state resource type', /^[a-z_][a-z0-9_]*$/u);
    const name = requireString(resource['name'], 'Recovery state resource name', /^[a-z_][a-z0-9_]*$/u);
    const module = resource['module'];
    if (module !== undefined && (typeof module !== 'string' || !/^module\.[a-z_][a-z0-9_]*$/u.test(module)))
      throw new Error('Recovery state module is invalid.');
    if (
      resource['provider'] !==
      (type === 'terraform_data'
        ? 'provider["terraform.io/builtin/terraform"]'
        : 'provider["registry.terraform.io/hashicorp/aws"]')
    )
      throw new Error('Recovery state provider is invalid.');
    if (!Array.isArray(resource['instances']) || resource['instances'].length > 128)
      throw new Error('Recovery state instances are invalid.');
    if (resource['mode'] === 'data') {
      if (type !== 'aws_iam_policy_document' || module !== undefined)
        throw new Error('Recovery state contains external data discovery.');
      continue;
    }
    if (resource['mode'] !== 'managed') throw new Error('Recovery state resource mode is invalid.');
    for (const instanceValue of resource['instances']) {
      const instance = record(instanceValue, 'Recovery state instance');
      if (Object.hasOwn(instance, 'status') || Object.hasOwn(instance, 'deposed'))
        throw new Error('Recovery state must have no tainted or deposed instances.');
      const index = instance['index_key'];
      if (index !== undefined && index !== 0 && typeof index !== 'string')
        throw new Error('Recovery state index is invalid.');
      const address = `${module === undefined ? '' : `${module}.`}${type}.${name}${index === undefined ? '' : `[${JSON.stringify(index)}]`}`;
      const attributes = record(instance['attributes'], 'Recovery state attributes');
      requireString(attributes['id'], 'Recovery state resource ID');
      if (managed.has(address)) throw new Error('Recovery state contains duplicate resource addresses.');
      managed.set(address, { type, attributes });
    }
  }
  return managed;
}

/** Bind partial state to the original seed and the actual approved plan's resource identities.
 * Provider-computed/defaulted values are left to the fresh managed Plan and its review.
 * @param {unknown} stateBytes @param {unknown} seedBytes @param {unknown} planBytes
 * @param {ReturnType<typeof admitFailedBootstrapInitializationHandoff>} initial */
function observeRecoveryState(stateBytes, seedBytes, planBytes, initial) {
  const target = resolveAllowedDeploymentTarget(initial.state.targetKey);
  const state = document(stateBytes, 'Recovery state', MAX_STATE_BYTES);
  const seed = document(seedBytes, 'Original Bootstrap seed', MAX_STATE_BYTES);
  const plan = document(planBytes, 'Previously approved Bootstrap plan', MAX_PLAN_BYTES);
  if (
    state.value['lineage'] !== initial.state.lineage ||
    Number(state.value['serial']) <= initial.state.serial ||
    state.sha256 === initial.state.sha256
  )
    throw new Error('Recovery state is not a later state in the original initialization lineage.');
  const managed = stateInstances(state.value);
  const original = stateInstances(seed.value);
  if (
    !Array.isArray(plan.value['resource_changes']) ||
    plan.value['resource_changes'].length > 1024 ||
    plan.value['applyable'] !== true ||
    plan.value['errored'] !== false ||
    plan.value['complete'] !== true ||
    plan.value['terraform_version'] !== '1.15.8'
  )
    throw new Error('Recovery requires a complete approved initial plan.');
  /** @type {Map<string, Record<string, unknown>>} */
  const changes = new Map();
  for (const item of plan.value['resource_changes']) {
    const resource = record(item, 'Previous planned resource');
    if (resource['mode'] === 'data') continue;
    const address = requireString(resource['address'], 'Previous planned address');
    const change = record(resource['change'], 'Previous resource change');
    const actions = JSON.stringify(change['actions']);
    if (
      resource['mode'] !== 'managed' ||
      changes.has(address) ||
      Object.hasOwn(resource, 'deposed') ||
      Object.hasOwn(resource, 'previous_address') ||
      Object.hasOwn(change, 'importing') ||
      (actions !== '["create"]' && actions !== '["no-op"]')
    )
      throw new Error('Recovery requires a create/no-op initial plan without imports, moves or replacements.');
    if ((actions === '["no-op"]') !== original.has(address))
      throw new Error('Previous plan does not preserve exactly the original seed.');
    changes.set(address, resource);
  }
  if (
    managed.size <= original.size ||
    managed.size >= changes.size ||
    [...original.keys()].some((address) => !managed.has(address) || !changes.has(address))
  )
    throw new Error('Recovery requires a partial Apply preserving the complete original seed.');
  for (const [address, instance] of managed) {
    const planned = record(changes.get(address), 'Recovery resource must belong to the approved plan');
    if (planned['type'] !== instance.type) throw new Error('Recovery resource type differs from the approved plan.');
    const prior = original.get(address);
    if (prior !== undefined && prior.attributes['id'] !== instance.attributes['id'])
      throw new Error('Recovery changed an original seed resource identity.');
    if (prior === undefined) assertCreatedResourceIdentity(instance.type, instance.attributes, target);
    const change = record(planned['change'], 'Previous planned change');
    const after = record(change['after'], 'Previous planned values');
    const unknown = record(change['after_unknown'], 'Previous planned unknown values');
    for (const key of ['name', 'bucket', 'role', 'policy_arn', 'url', 'tags']) {
      if (
        after[key] !== undefined &&
        after[key] !== null &&
        unknown[key] === undefined &&
        canonicalRecordJson(after[key]) !== canonicalRecordJson(instance.attributes[key])
      )
        throw new Error(`Recovery resource identity differs from the approved ${key}.`);
    }
  }
  for (const address of ['aws_s3_bucket.state', 'aws_kms_key.state', 'aws_kms_alias.state']) {
    const old = original.get(address)?.attributes;
    const current = managed.get(address)?.attributes;
    for (const key of ['id', 'arn', 'bucket', 'name', 'key_id', 'target_key_id']) {
      if (old?.[key] !== current?.[key]) throw new Error('Recovery backend identity changed.');
    }
  }
  return deepFreeze({
    observationType: 'bootstrap-initialization-recovery-state',
    targetKey: initial.state.targetKey,
    lineage: state.value['lineage'],
    serial: state.value['serial'],
    sha256: state.sha256,
    byteLength: state.body.byteLength,
    managedResourceCount: managed.size,
    backend: initial.state.backend,
  });
}

/** Only resource kinds from the reviewed partial initialization may be carried.
 * Check computed primary IDs against their known planned names and target account.
 * @param {string} type @param {Record<string, unknown>} attributes
 * @param {ReturnType<typeof resolveAllowedDeploymentTarget>} target */
function assertCreatedResourceIdentity(type, attributes, target) {
  const id = requireString(attributes['id'], 'Created recovery resource ID');
  const name = attributes['name'];
  const iam = `arn:${target.partition}:iam::${target.accountId}:`;
  let expected;
  if (
    type === 'aws_iam_role' ||
    type === 'aws_cloudwatch_log_group' ||
    type === 'aws_codepipeline' ||
    type === 'aws_kms_alias'
  )
    expected = name;
  else if (type === 'aws_iam_policy')
    expected = `${iam}policy${requireString(attributes['path'], 'Created policy path')}${requireString(name, 'Created policy name')}`;
  else if (type === 'aws_codebuild_project')
    expected = `arn:${target.partition}:codebuild:${target.region}:${target.accountId}:project/${requireString(name, 'Created project name')}`;
  else if (
    type.startsWith('aws_s3_bucket') &&
    [
      'aws_s3_bucket',
      'aws_s3_bucket_lifecycle_configuration',
      'aws_s3_bucket_policy',
      'aws_s3_bucket_public_access_block',
      'aws_s3_bucket_server_side_encryption_configuration',
      'aws_s3_bucket_versioning',
    ].includes(type)
  )
    expected = attributes['bucket'];
  else if (type === 'aws_iam_role_policy')
    expected = `${requireString(attributes['role'], 'Created policy role')}:${requireString(name, 'Created inline policy name')}`;
  else if (type === 'aws_iam_role_policy_attachment') {
    const policyArn = requireString(attributes['policy_arn'], 'Created attachment policy ARN');
    if (!policyArn.startsWith(`${iam}policy/`)) throw new Error('Recovery attachment belongs to another account.');
    expected = `${requireString(attributes['role'], 'Created attachment role')}/${policyArn}`;
  } else if (type === 'aws_kms_key' || type === 'terraform_data') {
    expected = requireGroupedLowercaseUuid(id, 'Created recovery resource UUID');
    if (type === 'aws_kms_key') {
      // Failed provider readback can leave computed key_id/arn absent. Preserve
      // that absence; the separately reviewed live key is never reconstructed.
      if (attributes['key_id'] != null && attributes['key_id'] !== id) throw new Error('Recovery key ID is detached.');
      if (
        attributes['arn'] != null &&
        attributes['arn'] !== `arn:${target.partition}:kms:${target.region}:${target.accountId}:key/${id}`
      )
        throw new Error('Recovery key ARN is detached.');
    }
  } else throw new Error('Recovery contains an unreviewed created resource kind.');
  if (id !== expected) throw new Error('Recovery primary resource identity differs from its planned name.');
  if (
    type === 'aws_iam_role' &&
    attributes['arn'] !==
      `${iam}role${requireString(attributes['path'], 'Created role path')}${requireString(name, 'Created role name')}`
  )
    throw new Error('Recovery role ARN is detached from its target.');
}

/** Validate the original AWS approval, immutable initial inputs, exact plan and current state.
 * Callers supply freshly observed failed execution/actions and exact-version bytes; none are inferred from the manifest.
 * @param {unknown} value @param {unknown} stateBytes @param {unknown} seedBytes @param {unknown} planBytes @param {unknown} expectedTargetKey */
export function admitBootstrapRecoveryMaterial(value, stateBytes, seedBytes, planBytes, expectedTargetKey) {
  const target = resolveAllowedDeploymentTarget(requireString(expectedTargetKey, 'Recovery target'));
  if (target.targetKey !== 'stark-prod/main') throw new Error('Bootstrap initialization recovery is production-only.');
  const input = snapshotExactRecord(
    snapshotDataTree(value, 'Bootstrap recovery material'),
    ['context', 'previous', 'previousActions', 'previousExecution'],
    'Bootstrap recovery material',
  );
  const context = parseDeploymentLaneContext(input['context']);
  if (
    context.root.lane !== 'bootstrap' ||
    context.target.accountId !== target.accountId ||
    context.source.requestedControlSourceSha !== context.source.frameworkSourceSha ||
    context.source.requestedControlSourceSha !== context.source.selectedApplicationSourceSha
  )
    throw new Error('Recovery context is detached from its target or source.');
  const previous = snapshotExactRecord(input['previous'], PREVIOUS_KEYS, 'Previous initial deployment');
  const initialManifest = record(previous['initialManifest'], 'Previous initialization manifest');
  const initialContext = parseDeploymentLaneContext(initialManifest['context']);
  if (initialContext.targetConfigurationSha256 !== context.targetConfigurationSha256)
    throw new Error('Recovery cannot change target authority.');
  const initial = admitFailedBootstrapInitializationHandoff(
    {
      context: initialContext,
      manifest: initialManifest,
      executionResponse: input['previousExecution'],
      pipelineExecutionId: previous['executionId'],
      stateVersionId: initialManifest['seedStateVersionId'],
    },
    seedBytes,
    target.targetKey,
  );
  const approval = selectFailedBootstrapApplyActions(input['previousActions'], previous['executionId']);
  const reference = snapshotExactRecord(
    previous['approvalReference'],
    ['key', 'versionId', 'sha256'],
    'Previous approval reference',
  );
  const key = deriveSavedPlanApprovalEvidenceKey(
    {
      targetKey: target.targetKey,
      lane: 'bootstrap',
      gate: 'terraform',
      pipelineExecutionId: previous['executionId'],
      actionExecutionId: approval.actionExecutionId,
    },
    target.targetKey,
  );
  if (reference['key'] !== key)
    throw new Error('Recovery approval reference differs from the observed approval action.');
  admitCompactSavedPlanApprovalSummary(
    { compactSummary: approval.compactSummary, evidence: previous['approvalEvidence'], evidenceReference: reference },
    target.targetKey,
  );
  const evidence = record(previous['approvalEvidence'], 'Previous approval evidence');
  const source = record(evidence['source'], 'Previous approved source');
  const execution = record(evidence['execution'], 'Previous approved execution');
  const review = record(evidence['review'], 'Previous approved review');
  const summary = record(review['summary'], 'Previous approved plan summary');
  const reviewState = record(review['state'], 'Previous reviewed state');
  const plan = document(planBytes, 'Previously approved Bootstrap plan', MAX_PLAN_BYTES);
  if (
    source['controlSourceSha'] !== initialContext.source.requestedControlSourceSha ||
    execution['pipelineExecutionId'] !== previous['executionId'] ||
    reviewState['versionId'] !== initial.stateVersionId ||
    plan.sha256 !== summary['planJsonSha256']
  )
    throw new Error('Recovery is detached from the exact approved initial plan, source or seed state.');
  const inputs = buildTerraformBaselineNonsecretInputs('bootstrap', plan.value);
  if (canonicalRecordJson(inputs) !== canonicalRecordJson(initial.nonsecretInputs))
    throw new Error('Previously approved plan does not carry the complete original initialization inputs.');
  const values = {
    ...decodeTerraformBaselineNonsecretInputValues(inputs),
    control_source_sha: context.source.requestedControlSourceSha,
  };
  const nonsecretInputs = buildTerraformBaselineNonsecretInputs('bootstrap', {
    variables: Object.fromEntries(Object.entries(values).map(([name, value]) => [name, { value }])),
  });
  const state = observeRecoveryState(stateBytes, seedBytes, planBytes, initial);
  return deepFreeze({ nonsecretInputs, state });
}

/** @param {unknown} value @param {unknown} stateBytes @param {unknown} seedBytes @param {unknown} planBytes @param {unknown} expectedTargetKey */
export function buildBootstrapRecoveryManifest(value, stateBytes, seedBytes, planBytes, expectedTargetKey) {
  const input = snapshotExactRecord(
    snapshotDataTree(value, 'Bootstrap recovery publication'),
    ['administratorIdentity', 'initializationId', 'material', 'stateVersionId'],
    'Bootstrap recovery publication',
  );
  const target = resolveAllowedDeploymentTarget(requireString(expectedTargetKey, 'Recovery target'));
  const administrator = validateAwsSsoCallerIdentityForPermissionSet(
    input['administratorIdentity'],
    target,
    'AdministratorAccess',
  );
  const material = record(input['material'], 'Bootstrap recovery material');
  const admitted = admitBootstrapRecoveryMaterial(material, stateBytes, seedBytes, planBytes, target.targetKey);
  return deepFreeze({
    kind: 'bootstrap-initialization-recovery',
    initializationId: requireGroupedLowercaseUuid(input['initializationId'], 'Recovery initialization ID'),
    administratorArn: administrator.arn,
    context: material['context'],
    previous: material['previous'],
    state: admitted.state,
    stateVersionId: parseS3VersionId(input['stateVersionId']),
  });
}

/** @param {unknown} value @param {unknown} stateBytes @param {unknown} seedBytes @param {unknown} planBytes @param {unknown} expectedTargetKey */
export function admitBootstrapRecoveryHandoff(value, stateBytes, seedBytes, planBytes, expectedTargetKey) {
  const input = snapshotExactRecord(
    snapshotDataTree(value, 'Bootstrap recovery handoff'),
    [
      'context',
      'executionResponse',
      'manifest',
      'pipelineExecutionId',
      'previousActions',
      'previousExecution',
      'stateVersionId',
    ],
    'Bootstrap recovery handoff',
  );
  const selection = selectBootstrapInitializationInputs(
    input['executionResponse'],
    input['context'],
    input['pipelineExecutionId'],
    expectedTargetKey,
  );
  const manifest = snapshotExactRecord(input['manifest'], MANIFEST_KEYS, 'Bootstrap recovery manifest');
  if (
    selection === null ||
    selection.mode !== 'recovery' ||
    manifest['kind'] !== 'bootstrap-initialization-recovery' ||
    manifest['initializationId'] !== selection.initializationId ||
    manifest['administratorArn'] !== selection.administratorArn ||
    canonicalRecordJson(manifest['context']) !== canonicalRecordJson(input['context']) ||
    createHash('sha256').update(canonicalRecordJson(manifest)).digest('hex') !== selection.manifest.sha256
  )
    throw new Error('Recovery manifest is detached from its explicit execution, administrator, source or checksum.');
  const stateVersionId = parseS3VersionId(input['stateVersionId']);
  if (record(manifest['previous'], 'Previous recovery execution')['executionId'] === input['pipelineExecutionId'])
    throw new Error('Recovery requires a new pipeline execution.');
  if (manifest['stateVersionId'] !== stateVersionId) throw new Error('Recovery state version changed.');
  const admitted = admitBootstrapRecoveryMaterial(
    {
      context: input['context'],
      previous: manifest['previous'],
      previousActions: input['previousActions'],
      previousExecution: input['previousExecution'],
    },
    stateBytes,
    seedBytes,
    planBytes,
    expectedTargetKey,
  );
  if (canonicalRecordJson(admitted.state) !== canonicalRecordJson(manifest['state']))
    throw new Error('Recovery state no longer matches the complete reviewed state observation.');
  return deepFreeze({
    ...admitted,
    initializationId: selection.initializationId,
    manifest: selection.manifest,
    stateVersionId,
  });
}

/** The new saved plan may finish creates and repair the two reviewed readback policies.
 * Only the existing local propagation barrier may be replaced; AWS resources remain delete-denied.
 * @param {unknown} value */
export function assertBootstrapRecoveryPlan(value) {
  const plan = record(snapshotDataTree(value, 'Bootstrap recovery plan'), 'Bootstrap recovery plan');
  if (!Array.isArray(plan['resource_changes']) || plan['resource_changes'].length > 1024)
    throw new Error('Recovery plan resource changes are invalid.');
  for (const item of plan['resource_changes']) {
    const resource = record(item, 'Recovery planned resource');
    const change = record(resource['change'], 'Recovery planned change');
    const actions = JSON.stringify(change['actions']);
    if (
      Object.hasOwn(change, 'importing') ||
      Object.hasOwn(resource, 'previous_address') ||
      Object.hasOwn(resource, 'deposed')
    )
      throw new Error('Recovery plan cannot import, move or replace deposed resources.');
    if (actions === '["no-op"]' || actions === '["create"]' || (resource['mode'] === 'data' && actions === '["read"]'))
      continue;
    if (actions === '["update"]' && RECOVERY_POLICY_UPDATES.has(String(resource['address']))) continue;
    if (
      actions === '["delete","create"]' &&
      resource['address'] === 'terraform_data.bootstrap_apply_authorization_propagation[0]'
    )
      continue;
    throw new Error('Recovery plan contains an unreviewed update or resource deletion/replacement.');
  }
}
