/** Initial construction is an explicit entrypoint, never a missing-checkpoint recovery path. */
import { deepFreeze, isPlainRecord, requireString } from './internal.js';
import { summarizeTerraformPlan } from './terraform-drift.js';
import { resolveAllowedDeploymentTarget, resolveDeploymentLaneAuthority } from './index.js';

export const BOOTSTRAP_BACKEND_RESOURCES = Object.freeze([
  'aws_kms_alias.state',
  'aws_kms_key.state',
  'aws_s3_bucket.state',
  'aws_s3_bucket_lifecycle_configuration.state',
  'aws_s3_bucket_policy.state',
  'aws_s3_bucket_public_access_block.state',
  'aws_s3_bucket_server_side_encryption_configuration.state',
  'aws_s3_bucket_versioning.state',
]);
/** @param {unknown} value @param {'backend'|'control-plane'} phase @param {string} targetKey */
export function admitBootstrapConstructionPlan(value, phase, targetKey) {
  resolveAllowedDeploymentTarget(targetKey);
  if (
    !isPlainRecord(value) ||
    value['complete'] !== true ||
    value['errored'] !== false ||
    !Array.isArray(value['resource_changes'])
  )
    throw new Error('Initial construction plan is incomplete.');
  const changes = value['resource_changes'];
  for (const raw of changes) assertConstructionResourceChange(raw, phase);
  return summarizeTerraformPlan(value, 'saved-plan-review');
}
/** @param {unknown} value @param {string} targetKey */
export function admitBootstrapConstructionInputs(value, targetKey) {
  const target = resolveAllowedDeploymentTarget(targetKey);
  const lane = resolveDeploymentLaneAuthority(target, 'bootstrap');
  if (
    !isPlainRecord(value) ||
    value['aws_account_id'] !== target.accountId ||
    value['aws_region'] !== target.region ||
    value['account_alias'] !== target.accountLabel ||
    value['deployment_environment'] !== target.environmentId ||
    value['source_branch'] !== target.sourceBranch
  )
    throw new Error('Initial inputs differ from the independently selected target.');
  assertConstructionBackendInputs(value, lane);
  if (value['state_kms_key_id'] !== null) throw new Error('Initial inputs must not invent a state KMS key.');
  return deepFreeze(value);
}

/** @param {unknown} raw @param {'backend'|'control-plane'} phase */
function assertConstructionResourceChange(raw, phase) {
  if (!isPlainRecord(raw) || !isPlainRecord(raw['change'])) throw new Error('Initial resource change is invalid.');
  const address = requireString(raw['address'], 'Initial resource address');
  const actions = raw['change']['actions'];
  if (!Array.isArray(actions) || actions.length !== 1 || !['create', 'read', 'no-op', 'update'].includes(actions[0]))
    throw new Error('Initial construction cannot delete or replace resources.');
  if (raw['mode'] === 'data') {
    if (actions[0] !== 'read' && actions[0] !== 'no-op') throw new Error('Initial data action is invalid.');
    return;
  }
  assertConstructionPhaseAction(address, actions[0], phase);
}
/** @param {string} address @param {unknown} action @param {'backend'|'control-plane'} phase */
function assertConstructionPhaseAction(address, action, phase) {
  const backend = BOOTSTRAP_BACKEND_RESOURCES.includes(address);
  if (phase === 'backend' && (!backend || action !== 'create'))
    throw new Error('First backend plan must only create its reviewed storage resources.');
  if (phase === 'control-plane' && !backend && action !== 'create')
    throw new Error('New target control-plane resources must be newly created.');
}

/** @param {Record<string,unknown>} value @param {ReturnType<typeof resolveDeploymentLaneAuthority>} lane */
function assertConstructionBackendInputs(value, lane) {
  if (
    value['state_bucket_name'] !== lane.names['terraformStateBucket'] ||
    value['state_backend_key'] !== lane.backendKey ||
    value['state_kms_alias'] !== lane.names['terraformStateKmsAlias']
  )
    throw new Error('Initial inputs differ from the independently selected target.');
}
