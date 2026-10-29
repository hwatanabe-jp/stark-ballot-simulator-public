import { hasDenseArrayOwnKeys, deepFreeze, requireString } from './internal.js';
import { copyArrayDataEntries, snapshotDataTree, snapshotExactRecord } from './descriptor-snapshot.js';

const INPUT_KEYS = ['changedAddresses', 'outputChanges'];
const CHANGED_ADDRESS_KEYS = [
  'actionClasses',
  'address',
  'changedAttributes',
  'replacementAttributes',
  'sensitiveAttributes',
  'unknownAttributes',
];
const OUTPUT_CHANGE_KEYS = ['count', 'names', 'omittedNameCount'];
const ACTION_CLASSES = new Set(['create', 'delete', 'read-only', 'replace', 'update']);
const MAX_CHANGES = 10_000;
const MAX_ADDRESS_BYTES = 2_048;
const RESOURCE_ADDRESS_PATTERN =
  /^(?:module\.[A-Za-z_][A-Za-z0-9_-]*(?:\[[^\]\r\n]+\])?\.)*(?:data\.)?(?:[A-Za-z_][A-Za-z0-9_-]*\.)[A-Za-z_][A-Za-z0-9_-]*(?:\[[^\]\r\n]+\])?$/u;
const OUTPUT_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_-]{0,255}$/u;

const FOUNDATION_OUTPUT_NAMES = new Set([
  'development_codeconnection_arn',
  'development_foundation_pipeline_artifact_bucket_name',
  'development_foundation_pipeline_name',
  'development_foundation_state_backend_key',
  'development_prover_release_pipeline_name',
  'development_toolchain_release_pipeline_name',
  'state_backend_key',
  'state_bucket_name',
  'state_kms_alias',
  'state_kms_key_arn',
  'terraform_authority_bucket_name',
  'terraform_authority_kms_key_arn',
  'terraform_baseline_prefix',
]);

const FOUNDATION_SHARED_RESOURCE_ADDRESSES = new Set([
  'aws_codeconnections_connection.source',
  'aws_iam_policy_document.codebuild_assume_role',
  'aws_iam_policy_document.pipeline_assume_role',
]);
const FOUNDATION_APP_STATUS_RESOURCE_NAMES = new Set(['app_deployment_status_publisher']);
const FOUNDATION_EXACT_RESOURCE_ADDRESSES = new Set([
  'aws_iam_policy.terraform_drift_coordinator_guardrail["requestShape"]',
]);
const FOUNDATION_CAPABILITY_RESOURCE_NAME_PREFIXES = [
  'development_prover_release',
  'development_toolchain_release',
  'prover_release_',
  'saved_plan_approval',
  'source_path_start_build_guardrail',
  'terraform_authority',
  'terraform_baseline_publisher',
  'terraform_drift_runner',
  'toolchain_release_',
];
const FOUNDATION_STATE_RESOURCE_NAMES = new Set(['state', 'state_bucket', 'state_kms_key']);

const FOUNDATION_STATE_RESOURCE_TYPES = new Set([
  'aws_kms_alias',
  'aws_kms_key',
  'aws_s3_bucket',
  'aws_s3_bucket_lifecycle_configuration',
  'aws_s3_bucket_policy',
  'aws_s3_bucket_public_access_block',
  'aws_s3_bucket_server_side_encryption_configuration',
  'aws_s3_bucket_versioning',
]);

/** @param {unknown} value @param {string} label @returns {readonly unknown[]} */
function denseArray(value, label) {
  if (!Array.isArray(value) || value.length > MAX_CHANGES) {
    throw new Error(`${label} must be a bounded dense array.`);
  }
  const entries = copyArrayDataEntries(value, value.length, `${label} must be a bounded dense array.`);
  if (!hasDenseArrayOwnKeys(Reflect.ownKeys(value), value.length)) {
    throw new Error(`${label} must be a bounded dense array.`);
  }
  return entries;
}

/** @param {unknown} value @param {string} label @returns {number} */
function nonNegativeInteger(value, label) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer.`);
  }
  return value;
}

/** @param {unknown} value @param {string} label @param {RegExp} pattern @returns {string} */
function boundedString(value, label, pattern) {
  const admitted = requireString(value, label, pattern);
  if (Buffer.byteLength(admitted, 'utf8') > MAX_ADDRESS_BYTES) {
    throw new Error(`${label} exceeds the review bound.`);
  }
  return admitted;
}

/** @param {string} address @returns {string} */
function unindexedAddress(address) {
  return address.replace(/\[[^\]\r\n]+\]/gu, '');
}

/**
 * Returns true only for Bootstrap resource addresses that own the stable
 * Foundation lane, its state/output coordinates, or its acceptance publisher.
 * Operational App and drift-coordinator resources are intentionally absent.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
function isFoundationBootstrapResourceAddress(value) {
  if (
    typeof value !== 'string' ||
    Buffer.byteLength(value, 'utf8') > MAX_ADDRESS_BYTES ||
    !RESOURCE_ADDRESS_PATTERN.test(value)
  ) {
    return false;
  }
  if (FOUNDATION_EXACT_RESOURCE_ADDRESSES.has(value)) {
    return true;
  }
  const address = unindexedAddress(value);
  if (address.startsWith('module.foundation_pipeline_codebuild_log_groups.')) {
    return true;
  }
  const segments = address.split('.');
  const resourceType = segments.at(-2);
  const resourceName = segments.at(-1);
  if (resourceType === undefined || resourceName === undefined) {
    return false;
  }
  return isFoundationResourceIdentity(resourceType, resourceName);
}

/** @param {unknown} value @param {string} label @returns {string[]} */
function stringArray(value, label) {
  return denseArray(value, label).map((entry, index) =>
    boundedString(entry, `${label}[${index}]`, /^[A-Za-z_][A-Za-z0-9_-]{0,255}$/u),
  );
}

/**
 * Classifies the admitted saved-plan semantic summary without inspecting
 * mutable source paths. The result is deterministic and suitable for binding
 * into saved-plan correspondence and Apply replay.
 *
 * @param {unknown} value
 * @returns {Readonly<{
 *   impactType: 'foundation-bootstrap-impact',
 *   changedAddresses: readonly string[],
 *   changedOutputNames: readonly string[],
 * }>}
 */
export function classifyFoundationBootstrapImpact(value) {
  let input;
  try {
    input = snapshotExactRecord(
      snapshotDataTree(value, 'Foundation Bootstrap impact input'),
      INPUT_KEYS,
      'Foundation Bootstrap impact input',
    );
  } catch (error) {
    throw new Error('Foundation Bootstrap impact input must use the exact current shape.', { cause: error });
  }

  const changedAddresses = [];
  const observedAddresses = new Set();
  for (const [index, entry] of denseArray(
    input['changedAddresses'],
    'Foundation Bootstrap changed addresses',
  ).entries()) {
    const change = snapshotExactRecord(entry, CHANGED_ADDRESS_KEYS, `Foundation Bootstrap changed address ${index}`);
    const address = boundedString(
      change['address'],
      `Foundation Bootstrap changed address ${index} address`,
      RESOURCE_ADDRESS_PATTERN,
    );
    if (observedAddresses.has(address)) {
      throw new Error('Foundation Bootstrap changed addresses contain a duplicate.');
    }
    observedAddresses.add(address);
    const actionClasses = stringArray(
      change['actionClasses'],
      `Foundation Bootstrap changed address ${index} action classes`,
    );
    if (
      actionClasses.length === 0 ||
      new Set(actionClasses).size !== actionClasses.length ||
      actionClasses.some((actionClass) => !ACTION_CLASSES.has(actionClass))
    ) {
      throw new Error('Foundation Bootstrap changed address action class is invalid.');
    }
    for (const attributeKind of [
      'changedAttributes',
      'replacementAttributes',
      'sensitiveAttributes',
      'unknownAttributes',
    ]) {
      stringArray(change[attributeKind], `Foundation Bootstrap changed address ${index} ${attributeKind}`);
    }
    if (isFoundationBootstrapResourceAddress(address)) {
      changedAddresses.push(address);
    }
  }

  const outputChanges = snapshotExactRecord(
    input['outputChanges'],
    OUTPUT_CHANGE_KEYS,
    'Foundation Bootstrap output changes',
  );
  const outputCount = nonNegativeInteger(outputChanges['count'], 'Foundation Bootstrap output change count');
  const omittedOutputCount = nonNegativeInteger(
    outputChanges['omittedNameCount'],
    'Foundation Bootstrap omitted output change count',
  );
  if (omittedOutputCount !== 0) {
    throw new Error('Foundation Bootstrap impact classification cannot omit changed output names.');
  }
  const outputNames = denseArray(outputChanges['names'], 'Foundation Bootstrap output change names').map(
    (name, index) => boundedString(name, `Foundation Bootstrap output change name ${index}`, OUTPUT_NAME_PATTERN),
  );
  if (outputCount !== outputNames.length) {
    throw new Error('Foundation Bootstrap output change count does not match its names.');
  }
  if (new Set(outputNames).size !== outputNames.length) {
    throw new Error('Foundation Bootstrap output change names contain a duplicate.');
  }

  return deepFreeze({
    impactType: /** @type {const} */ ('foundation-bootstrap-impact'),
    changedAddresses: changedAddresses.sort(),
    changedOutputNames: outputNames.filter((name) => FOUNDATION_OUTPUT_NAMES.has(name)).sort(),
  });
}

/** @param {string} resourceType @param {string} resourceName */
function isFoundationResourceIdentity(resourceType, resourceName) {
  if (FOUNDATION_SHARED_RESOURCE_ADDRESSES.has(`${resourceType}.${resourceName}`)) {
    return true;
  }
  if (FOUNDATION_APP_STATUS_RESOURCE_NAMES.has(resourceName)) {
    return true;
  }
  if (resourceName.includes('foundation')) {
    return true;
  }
  if (
    resourceName.startsWith('terraform_drift_runner') ||
    /^(?:terraform_drift_app|terraform_drift_bootstrap)$/u.test(resourceName)
  ) {
    return true;
  }
  if (
    FOUNDATION_STATE_RESOURCE_NAMES.has(resourceName) &&
    (resourceName !== 'state' || FOUNDATION_STATE_RESOURCE_TYPES.has(resourceType))
  ) {
    return true;
  }
  return FOUNDATION_CAPABILITY_RESOURCE_NAME_PREFIXES.some((prefix) => resourceName.startsWith(prefix));
}
