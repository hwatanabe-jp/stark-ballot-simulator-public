import {
  hasDenseArrayOwnKeys,
  deepFreeze,
  hasControlCharacter,
  isPlainRecord,
  parseSha256,
  requireExactKeys,
} from './internal.js';
import {
  copyArrayDataEntries,
  requireEnumerableDataProperty,
  isEnumerableDataDescriptor,
} from './descriptor-snapshot.js';
import { storedBytesSha256 as canonicalPlanHash } from './plan-package.js';
import { isDeepStrictEqual, types } from 'node:util';
import { classifyFoundationBootstrapImpact } from './foundation-bootstrap-impact.js';
import {
  classifyTerraformActionSequence,
  redactTerraformResourceAddress,
  summarizeTerraformPlan,
} from './terraform-drift.js';

/** @typedef {import("./terraform-drift.js").TerraformDriftSummary} TerraformDriftSummary */

/**
 * @typedef {'app' | 'bootstrap' | 'foundation'} SavedPlanReviewLane
 * @typedef {'terraform'} SavedPlanReviewGate
 * @typedef {'normal'} SavedPlanReviewDeploymentMode
 * @typedef {'create' | 'update' | 'replace' | 'delete' | 'read-only'} SavedPlanReviewActionClass
 * @typedef {{ nodes: number, bytes: number }} SavedPlanReviewChangeBudget
 * @typedef {{
 *   readonly complete: boolean;
 *   readonly allowNonApplyableNoOp: boolean;
 *   readonly root: SavedPlanReviewLane;
 *   readonly approval: 'app' | 'source';
 *   readonly authority: 'app-deployment' | null;
 * }} SavedPlanReviewGatePolicy
 * @typedef {{
 *   changedAttributes: Set<string>;
 *   sensitiveAttributes: Set<string>;
 *   unknownAttributes: Set<string>;
 *   replacementAttributes: Set<string>;
 * }} SavedPlanReviewAttributeSets
 *
 * @typedef {object} SavedPlanReviewContext
 * @property {string} accountId
 * @property {string} backendKey
 * @property {string} deploymentEnvironment
 * @property {SavedPlanReviewGate} gate
 * @property {SavedPlanReviewLane} lane
 * @property {string} pipelineExecutionId
 * @property {string} region
 * @property {string} sourceSha
 * @property {string} stateIdentity
 *
 * @typedef {object} SavedPlanReviewPlanInput
 * @property {unknown} planJson
 * @property {string} planJsonSha256
 * @property {string} tfplanSha256
 *
 * @typedef {object} SavedPlanReviewSourceApproval
 * @property {string} sourceSha
 * @property {string} accountId
 * @property {string} deploymentEnvironment
 * @property {string} reviewedPlanChecksum
 *
 * @typedef {object} SavedPlanReviewAppApproval
 * @property {SavedPlanReviewDeploymentMode} deploymentMode
 * @property {string} controlSourceSha
 * @property {string} selectedSourceSha
 * @property {string} accountId
 * @property {string} deploymentEnvironment
 * @property {string} reviewedPlanChecksum
 *
 * @typedef {object} SavedPlanReviewAppDeploymentAuthority
 * @property {'app-deployment'} authorityType
 * @property {SavedPlanReviewDeploymentMode} deploymentMode
 * @property {string} selectedSourceSha
 * @property {string} deploymentId
 * @property {string} appExecutionAuthoritySha256
 * @property {'accepted' | 'pinned'} selectedProverSelector
 * @property {string} expectedImageId
 * @property {number} methodVersion
 * @property {'default' | 'x86_64'} imageIdVariant
 * @property {string} imageIdMappingSha256
 * @property {string} proverImageDigest
 * @property {string} toolchainImageDigest
 * @property {string} proverReleaseKey
 * @property {string} toolchainReleaseKey
 * @property {string} lambdaSourceSha
 * @property {6} lambdaCount
 * @property {string} lambdaSetSha256
 *
 * @typedef {object} SavedPlanReviewActionCounts
 * @property {number} create
 * @property {number} update
 * @property {number} replace
 * @property {number} delete
 * @property {number} readOnly
 *
 * @typedef {object} SavedPlanReviewChangedAddress
 * @property {string} address
 * @property {ReadonlyArray<SavedPlanReviewActionClass>} actionClasses
 * @property {readonly string[]} changedAttributes
 * @property {readonly string[]} sensitiveAttributes
 * @property {readonly string[]} unknownAttributes
 * @property {readonly string[]} replacementAttributes
 *
 * @typedef {object} SavedPlanReviewSummary
 * @property {'1.2'} formatVersion
 * @property {'1.17.0'} terraformVersion
 * @property {boolean} applyable
 * @property {boolean} complete
 * @property {false} errored
 * @property {SavedPlanReviewActionCounts} actionCounts
 * @property {readonly SavedPlanReviewChangedAddress[]} changedAddresses
 * @property {ReturnType<typeof classifyFoundationBootstrapImpact> | null} foundationBootstrapImpact
 * @property {number} omittedChangedAddressCount
 * @property {{ count: number, names: readonly string[], omittedNameCount: number }} outputChanges
 * @property {{ count: number, names: readonly string[], omittedNameCount: number }} drift
 * @property {{ pass: number, unknown: number, fail: 0, error: 0 }} checkStatusCounts
 * @property {0} deferredChangeCount
 * @property {string} planJsonSha256
 * @property {string} tfplanSha256
 *
 */

const MAX_PLAN_COLLECTION_ENTRIES = 10_000;
const MAX_REPORTED_OUTPUT_NAMES = 100;
const MAX_REPORTED_RESOURCE_ATTRIBUTES = 100;
const MAX_RESOURCE_ATTRIBUTE_NAME_BYTES = 256;
const MAX_REPLACEMENT_PATH_SEGMENTS = 256;
const MAX_CHANGE_VALUE_DEPTH = 64;
const MAX_CHANGE_VALUE_NODES = 1_000_000;
const MAX_CHANGE_VALUE_BYTES = 64 * 1024 * 1024;
const REVIEWED_PLAN_FORMAT_VERSION = '1.2';
const REVIEWED_TERRAFORM_VERSION = '1.17.0';
/**
 * @param {unknown} value
 * @param {string} label
 * @returns {Record<string, unknown>}
 */
function requiredRecord(value, label) {
  if (types.isProxy(value) || !isPlainRecord(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value;
}

/**
 * @param {unknown} value
 * @param {readonly string[]} keys
 * @param {string} label
 * @returns {Record<string, unknown>}
 */
function exactKeys(value, keys, label) {
  try {
    return requireExactKeys(value, keys, label);
  } catch (error) {
    throw new Error(`${label} must use the exact current shape.`, { cause: error });
  }
}

/**
 * @param {object} record
 * @param {PropertyKey} key
 * @param {string} label
 * @returns {unknown}
 */
function requiredDataProperty(record, key, label) {
  return requireEnumerableDataProperty(record, key, `${label} is required.`);
}

/**
 * @template T
 * @param {object} record
 * @param {PropertyKey} key
 * @param {T} fallback
 * @param {string} label
 * @returns {unknown | T}
 */
function optionalDataProperty(record, key, fallback, label) {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  if (descriptor === undefined) {
    return fallback;
  }
  if (descriptor.enumerable !== true || !Object.hasOwn(descriptor, 'value')) {
    throw new Error(`${label} is invalid.`);
  }
  return descriptor.value;
}

/**
 * @param {unknown} value
 * @param {string} label
 * @returns {unknown[]}
 */
function denseArray(value, label) {
  if (types.isProxy(value) || !Array.isArray(value) || value.length > MAX_PLAN_COLLECTION_ENTRIES) {
    throw new Error(`${label} must be a bounded dense array.`);
  }
  const values = copyArrayDataEntries(value, value.length, `${label} must be a bounded dense array.`);
  if (!hasDenseArrayOwnKeys(Reflect.ownKeys(value), value.length)) {
    throw new Error(`${label} must be a bounded dense array.`);
  }
  return values;
}

/**
 * @param {unknown[]} changes
 * @param {string} label
 */
function rejectMoveOrImportMetadata(changes, label) {
  for (const [index, value] of changes.entries()) {
    const resourceChange = requiredRecord(value, `${label}[${index}]`);
    const change = requiredRecord(
      requiredDataProperty(resourceChange, 'change', `${label}[${index}].change`),
      `${label}[${index}].change`,
    );
    if (Object.hasOwn(resourceChange, 'previous_address') || Object.hasOwn(change, 'importing')) {
      throw new Error(`${label} contains unsupported move or import metadata.`);
    }
  }
}

/**
 * @param {object} change
 * @param {PropertyKey} key
 * @param {string} label
 * @returns {unknown}
 */
function attributeMetadataProperty(change, key, label) {
  return requireEnumerableDataProperty(change, key, `${label} attribute metadata is invalid.`);
}

/**
 * @param {object} change
 * @param {string} label
 * @returns {unknown}
 */
function optionalReplacementPaths(change, label) {
  const descriptor = Object.getOwnPropertyDescriptor(change, 'replace_paths');
  if (descriptor === undefined) {
    return [];
  }
  if (descriptor.enumerable !== true || !Object.hasOwn(descriptor, 'value')) {
    throw new Error(`${label} replacement path metadata is invalid.`);
  }
  return descriptor.value;
}

/**
 * @param {SavedPlanReviewChangeBudget} budget
 * @param {number} byteCount
 * @param {string} label
 */
function consumeChangeValueBudget(budget, byteCount, label) {
  budget.nodes += 1;
  budget.bytes += byteCount;
  if (budget.nodes > MAX_CHANGE_VALUE_NODES || budget.bytes > MAX_CHANGE_VALUE_BYTES) {
    throw new Error(`${label} exceeds the review bound.`);
  }
}

/**
 * @param {unknown} value
 * @param {string} label
 * @param {SavedPlanReviewChangeBudget} budget
 * @param {number} depth
 * @returns {void}
 */
function validateBoundedChangeValue(value, label, budget, depth = 0) {
  if (depth > MAX_CHANGE_VALUE_DEPTH) {
    throw new Error(`${label} exceeds the review bound.`);
  }
  if (value === null) {
    consumeChangeValueBudget(budget, 0, label);
    return;
  }
  switch (typeof value) {
    case 'boolean':
      consumeChangeValueBudget(budget, 0, label);
      return;
    case 'number':
      consumeNumericChangeValue(value, label, budget);
      return;
    case 'string':
      consumeChangeValueBudget(budget, Buffer.byteLength(value, 'utf8'), label);
      return;
    case 'object':
      consumeChangeValueBudget(budget, 0, label);
      validateChangeCollection(value, label, budget, depth);
      return;
    default:
      throw new Error(`${label} is invalid.`);
  }
}

/**
 * @param {unknown} value
 * @param {string} label
 * @returns {string}
 */
function parseResourceAttributeName(value, label) {
  if (
    typeof value !== 'string' ||
    !/^[A-Za-z_][A-Za-z0-9_-]*$/u.test(value) ||
    Buffer.byteLength(value, 'utf8') > MAX_RESOURCE_ATTRIBUTE_NAME_BYTES
  ) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

/**
 * @param {unknown} value
 * @param {string} label
 * @param {SavedPlanReviewChangeBudget} budget
 * @returns {Map<string, unknown>}
 */
function parseTopLevelResourceValue(value, label, budget) {
  if (value === null) {
    consumeChangeValueBudget(budget, 0, label);
    return new Map();
  }
  /** @type {Map<string, unknown>} */
  const attributes = new Map();
  for (const [attribute, entry] of topLevelResourceEntries(value, label)) {
    validateBoundedChangeValue(entry, label, budget, 1);
    attributes.set(attribute, entry);
  }
  return attributes;
}

/**
 * @param {unknown} value
 * @param {string} label
 * @param {SavedPlanReviewChangeBudget} budget
 * @param {number} depth
 * @returns {boolean}
 */
function flagTreeContainsTrue(value, label, budget, depth = 0) {
  if (depth > MAX_CHANGE_VALUE_DEPTH) {
    throw new Error(`${label} exceeds the review bound.`);
  }
  consumeChangeValueBudget(budget, 0, label);
  if (typeof value === 'boolean') {
    return value;
  }
  if (Array.isArray(value)) {
    const entries = denseArray(value, label);
    let containsTrue = false;
    for (const entry of entries) {
      containsTrue = flagTreeContainsTrue(entry, label, budget, depth + 1) || containsTrue;
    }
    return containsTrue;
  }
  let containsTrue = false;
  for (const entry of changeRecordValues(value, label, budget)) {
    containsTrue = flagTreeContainsTrue(entry, label, budget, depth + 1) || containsTrue;
  }
  return containsTrue;
}

/**
 * @param {unknown} value
 * @param {ReadonlySet<string>} knownAttributes
 * @param {string} label
 * @param {SavedPlanReviewChangeBudget} budget
 * @param {boolean} admitUnmaterializedAttributes
 * @returns {string[]}
 */
function parseTopLevelFlaggedAttributes(value, knownAttributes, label, budget, admitUnmaterializedAttributes = false) {
  if (typeof value === 'boolean') {
    if (!value) {
      return [];
    }
    if (knownAttributes.size === 0) {
      throw new Error(`${label} is invalid.`);
    }
    return [...knownAttributes.keys()].sort();
  }
  const attributes = [];
  for (const [attribute, entry] of topLevelResourceEntries(value, label)) {
    const containsTrue = flagTreeContainsTrue(entry, label, budget, 1);
    if (!containsTrue) {
      continue;
    }
    if (!admitUnmaterializedAttributes && !knownAttributes.has(attribute)) {
      throw new Error(`${label} does not match its resource value.`);
    }
    attributes.push(attribute);
  }
  return attributes.sort();
}

/**
 * @param {unknown} value
 * @param {ReadonlyMap<string, unknown>} knownAttributes
 * @param {SavedPlanReviewActionClass} actionClass
 * @param {string} label
 * @returns {string[]}
 */
function parseReplacementAttributes(value, knownAttributes, actionClass, label) {
  const paths = denseArray(value, `${label} replacement paths`);
  const attributes = new Set();
  for (const [pathIndex, pathValue] of paths.entries()) {
    const path = denseArray(pathValue, `${label} replacement path ${pathIndex}`);
    if (path.length === 0 || path.length > MAX_REPLACEMENT_PATH_SEGMENTS) {
      throw new Error(`${label} replacement path is invalid.`);
    }
    assertReplacementPathSegments(path, label);
    const attribute = parseResourceAttributeName(path[0], `${label} replacement path attribute`);
    if (!knownAttributes.has(attribute)) {
      throw new Error(`${label} replacement path does not match its resource value.`);
    }
    attributes.add(attribute);
    if (attributes.size > MAX_REPORTED_RESOURCE_ATTRIBUTES) {
      throw new Error('Terraform resource attribute summary exceeds the review bound.');
    }
  }
  if (actionClass !== 'replace' && attributes.size !== 0) {
    throw new Error(`${label} replacement path does not match its action.`);
  }
  return [...attributes].sort();
}

/**
 * @param {Record<string, unknown>} change
 * @param {SavedPlanReviewActionClass} actionClass
 * @param {string} label
 * @param {SavedPlanReviewChangeBudget} budget
 * @returns {{changedAttributes: string[], sensitiveAttributes: string[], unknownAttributes: string[], replacementAttributes: string[]}}
 */
function summarizeResourceChangeAttributes(change, actionClass, label, budget) {
  const before = parseTopLevelResourceValue(
    attributeMetadataProperty(change, 'before', label),
    `${label} before attribute metadata`,
    budget,
  );
  const after = parseTopLevelResourceValue(
    attributeMetadataProperty(change, 'after', label),
    `${label} after attribute metadata`,
    budget,
  );
  const knownAttributes = new Map([...before, ...after]);
  if (knownAttributes.size > MAX_REPORTED_RESOURCE_ATTRIBUTES) {
    throw new Error('Terraform resource attribute summary exceeds the review bound.');
  }
  const changedAttributes = [...knownAttributes.keys()]
    .filter(
      (attribute) =>
        !before.has(attribute) ||
        !after.has(attribute) ||
        !isDeepStrictEqual(before.get(attribute), after.get(attribute)),
    )
    .sort();
  const beforeSensitive = parseTopLevelFlaggedAttributes(
    attributeMetadataProperty(change, 'before_sensitive', label),
    new Set(before.keys()),
    `${label} sensitive attribute metadata`,
    budget,
  );
  const unknownAttributes = parseTopLevelFlaggedAttributes(
    attributeMetadataProperty(change, 'after_unknown', label),
    new Set(after.keys()),
    `${label} unknown attribute metadata`,
    budget,
    true,
  );
  // Terraform omits unknown values from after, including sensitive values.
  // Sensitivity must bind to a materialized or explicitly unknown attribute.
  const afterSensitive = parseTopLevelFlaggedAttributes(
    attributeMetadataProperty(change, 'after_sensitive', label),
    new Set([...after.keys(), ...unknownAttributes]),
    `${label} sensitive attribute metadata`,
    budget,
  );
  const sensitiveAttributes = [...new Set([...beforeSensitive, ...afterSensitive])].sort();
  const replacementAttributes = parseReplacementAttributes(
    optionalReplacementPaths(change, label),
    knownAttributes,
    actionClass,
    label,
  );
  return { changedAttributes, sensitiveAttributes, unknownAttributes, replacementAttributes };
}

/**
 * @param {Set<string>} target
 * @param {readonly string[]} source
 */
function mergeBoundedAttributes(target, source) {
  for (const attribute of source) {
    target.add(attribute);
  }
  if (target.size > MAX_REPORTED_RESOURCE_ATTRIBUTES) {
    throw new Error('Terraform resource attribute summary exceeds the review bound.');
  }
}

/**
 * @param {unknown[]} resourceChanges
 * @param {TerraformDriftSummary} resourceSummary
 * @returns {SavedPlanReviewChangedAddress[]}
 */
function summarizeChangedAddresses(resourceChanges, resourceSummary) {
  /** @type {Map<string, SavedPlanReviewAttributeSets>} */
  const addressAttributes = new Map();
  const budget = { nodes: 0, bytes: 0 };
  for (const [index, value] of resourceChanges.entries()) {
    const resourceChange = requiredRecord(value, `Terraform plan resource_changes[${index}]`);
    const change = requiredRecord(
      requiredDataProperty(resourceChange, 'change', `Terraform plan resource_changes[${index}].change`),
      `Terraform plan resource_changes[${index}].change`,
    );
    const actionClass = classifyTerraformActionSequence(
      requiredDataProperty(change, 'actions', `Terraform plan resource_changes[${index}].change.actions`),
      `Terraform plan resource_changes[${index}].change.actions`,
    );
    if (actionClass === null) {
      continue;
    }
    const address = redactTerraformResourceAddress(
      requiredDataProperty(resourceChange, 'address', `Terraform plan resource_changes[${index}].address`),
    );
    const summary = summarizeResourceChangeAttributes(
      change,
      actionClass,
      `Terraform plan resource_changes[${index}].change`,
      budget,
    );
    const aggregate = addressAttributes.get(address) ?? {
      changedAttributes: new Set(),
      sensitiveAttributes: new Set(),
      unknownAttributes: new Set(),
      replacementAttributes: new Set(),
    };
    /** @type {Array<keyof SavedPlanReviewAttributeSets>} */
    const attributeKinds = ['changedAttributes', 'sensitiveAttributes', 'unknownAttributes', 'replacementAttributes'];
    for (const key of attributeKinds) {
      mergeBoundedAttributes(aggregate[key], summary[key]);
    }
    addressAttributes.set(address, aggregate);
  }

  return resourceSummary.addresses.map(({ address, actionClasses }) => {
    const aggregate = addressAttributes.get(address);
    if (aggregate === undefined) {
      throw new Error('Terraform resource attribute summary does not match its changed address.');
    }
    return deepFreeze({
      address,
      actionClasses,
      changedAttributes: [...aggregate.changedAttributes].sort(),
      sensitiveAttributes: [...aggregate.sensitiveAttributes].sort(),
      unknownAttributes: [...aggregate.unknownAttributes].sort(),
      replacementAttributes: [...aggregate.replacementAttributes].sort(),
    });
  });
}

/**
 * @param {unknown} value
 */
function summarizeOutputChanges(value) {
  const outputChanges = requiredRecord(value, 'Terraform plan output_changes');
  /** @type {string[]} */
  const changedNames = [];
  for (const key of Reflect.ownKeys(outputChanges)) {
    const descriptor = Object.getOwnPropertyDescriptor(outputChanges, key);
    if (typeof key !== 'string' || !isEnumerableDataDescriptor(descriptor) || !/^[A-Za-z0-9_-]{1,256}$/u.test(key)) {
      throw new Error('Terraform plan output_changes is invalid.');
    }
    const change = requiredRecord(descriptor.value, `Terraform output change ${key}`);
    const action = classifyTerraformActionSequence(
      requiredDataProperty(change, 'actions', `Terraform output change ${key} actions`),
      `Terraform output change ${key} actions`,
    );
    if (action !== null) {
      changedNames.push(key);
    }
  }
  if (changedNames.length > MAX_PLAN_COLLECTION_ENTRIES) {
    throw new Error('Terraform plan output_changes exceeds the review bound.');
  }
  changedNames.sort();
  const names = changedNames.slice(0, MAX_REPORTED_OUTPUT_NAMES);
  return deepFreeze({
    count: changedNames.length,
    names,
    omittedNameCount: changedNames.length - names.length,
  });
}

/**
 * @param {unknown} value
 * @returns {{pass: number, unknown: number, fail: 0, error: 0}}
 */
function summarizeChecks(value) {
  const checks = denseArray(value, 'Terraform plan checks');
  /** @type {{pass: number, unknown: number, fail: number, error: number}} */
  const counts = { pass: 0, unknown: 0, fail: 0, error: 0 };
  for (const [index, valueAtIndex] of checks.entries()) {
    const check = requiredRecord(valueAtIndex, `Terraform plan check ${index}`);
    const status = requiredDataProperty(check, 'status', `Terraform plan check ${index} status`);
    if (status !== 'pass' && status !== 'unknown' && status !== 'fail' && status !== 'error') {
      throw new Error(`Terraform plan check ${index} status is invalid.`);
    }
    counts[status] += 1;
  }
  if (counts['fail'] !== 0 || counts['error'] !== 0) {
    throw new Error('Terraform plan contains a failed or errored check.');
  }
  return deepFreeze({ pass: counts.pass, unknown: counts.unknown, fail: 0, error: 0 });
}

/**
 * @param {unknown} value
 * @param {SavedPlanReviewGatePolicy} policy
 * @returns {SavedPlanReviewSummary}
 */
function parsePlan(value, policy) {
  const planBinding = exactKeys(
    value,
    ['planJson', 'planJsonSha256', 'tfplanSha256'],
    'Saved-plan review plan binding',
  );
  const plan = requiredRecord(planBinding['planJson'], 'Terraform plan JSON');
  const { formatVersion, terraformVersion, applyable, complete, errored } = admitPlanDisposition(plan, policy);

  rejectUnsupportedPlanActions(plan);
  const resourceChanges = denseArray(
    requiredDataProperty(plan, 'resource_changes', 'Terraform plan resource_changes'),
    'Terraform plan resource_changes',
  );
  const resourceDrift = denseArray(
    optionalDataProperty(plan, 'resource_drift', [], 'Terraform plan resource_drift'),
    'Terraform plan resource_drift',
  );
  rejectMoveOrImportMetadata(resourceChanges, 'Terraform plan resource_changes');
  rejectMoveOrImportMetadata(resourceDrift, 'Terraform plan resource_drift');
  const resourceSummary = summarizeTerraformPlan({ resource_changes: resourceChanges }, 'saved-plan-review');
  if (resourceSummary.omittedAddressCount !== 0) {
    throw new Error('Saved-plan review cannot omit changed resource addresses.');
  }
  const changedAddresses = summarizeChangedAddresses(resourceChanges, resourceSummary);
  const driftSummary = summarizeTerraformPlan({ resource_changes: resourceDrift }, 'saved-plan-review');
  if (driftSummary.omittedAddressCount !== 0) {
    throw new Error('Saved-plan review cannot omit drift addresses.');
  }
  const drift = deepFreeze({
    count: Object.values(driftSummary.actionCounts).reduce((total, count) => total + count, 0),
    names: driftSummary.addresses.map(({ address }) => address),
    omittedNameCount: driftSummary.omittedAddressCount,
  });
  const outputChanges = summarizeOutputChanges(
    optionalDataProperty(plan, 'output_changes', {}, 'Terraform plan output_changes'),
  );
  if (outputChanges.omittedNameCount !== 0) {
    throw new Error('Saved-plan review cannot omit changed output names.');
  }
  assertSemanticPlanDisposition(applyable, resourceSummary.actionCounts, outputChanges.count, policy);
  const checkStatusCounts = summarizeChecks(requiredDataProperty(plan, 'checks', 'Terraform plan checks'));
  const foundationBootstrapImpact =
    policy.root === 'bootstrap' ? classifyFoundationBootstrapImpact({ changedAddresses, outputChanges }) : null;
  return deepFreeze({
    formatVersion,
    terraformVersion,
    applyable,
    complete,
    errored,
    actionCounts: resourceSummary.actionCounts,
    changedAddresses,
    foundationBootstrapImpact,
    omittedChangedAddressCount: resourceSummary.omittedAddressCount,
    outputChanges,
    drift,
    checkStatusCounts,
    deferredChangeCount: 0,
    planJsonSha256: parseSha256(planBinding['planJsonSha256'], 'Saved-plan review plan JSON SHA-256'),
    tfplanSha256: parseSha256(planBinding['tfplanSha256'], 'Saved-plan review tfplan SHA-256'),
  });
}

/**
 * The immutable package owns target/source/dependencies. Only Terraform's
 * redacted semantic view crosses the interactive display boundary.
 * @param {import('./plan-package.js').PlanPackage} plan
 */
export function summarizePlanPackageReview(plan) {
  return parsePlan(
    {
      planJson: JSON.parse(plan.files.tfplanJson),
      planJsonSha256: canonicalPlanHash(plan.files.tfplanJson),
      tfplanSha256: canonicalPlanHash(Buffer.from(plan.files.tfplan, 'base64')),
    },
    {
      complete: true,
      allowNonApplyableNoOp: true,
      root: plan.root,
      approval: plan.root === 'app' ? 'app' : 'source',
      authority: null,
    },
  );
}

/** @param {object} value @param {string} label @param {SavedPlanReviewChangeBudget} budget @param {number} depth */
function validateChangeCollection(value, label, budget, depth) {
  const entries = Array.isArray(value) ? denseArray(value, label) : changeRecordValues(value, label, budget);
  for (const entry of entries) validateBoundedChangeValue(entry, label, budget, depth + 1);
}

/** @param {unknown} value @param {string} label @param {SavedPlanReviewChangeBudget} budget @returns {Generator<unknown>} */
function* changeRecordValues(value, label, budget) {
  const record = requiredRecord(value, label);
  const keys = Reflect.ownKeys(record);
  if (keys.length > MAX_PLAN_COLLECTION_ENTRIES) {
    throw new Error(`${label} exceeds the review bound.`);
  }
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    if (
      typeof key !== 'string' ||
      Buffer.byteLength(key, 'utf8') > 4_096 ||
      hasControlCharacter(key) ||
      !isEnumerableDataDescriptor(descriptor)
    ) {
      throw new Error(`${label} is invalid.`);
    }
    consumeChangeValueBudget(budget, Buffer.byteLength(key, 'utf8'), label);
    yield descriptor.value;
  }
}

/** @param {unknown} value @param {string} label @returns {Generator<[string, unknown]>} */
function* topLevelResourceEntries(value, label) {
  const record = requiredRecord(value, label);
  const keys = Reflect.ownKeys(record);
  if (keys.length > MAX_REPORTED_RESOURCE_ATTRIBUTES) {
    throw new Error('Terraform resource attribute summary exceeds the review bound.');
  }
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    if (typeof key !== 'string' || !isEnumerableDataDescriptor(descriptor)) {
      throw new Error(`${label} is invalid.`);
    }
    const attribute = parseResourceAttributeName(key, `${label} attribute name`);
    yield [attribute, descriptor.value];
  }
}

/** @param {unknown[]} path @param {string} label */
function assertReplacementPathSegments(path, label) {
  for (const segment of path) {
    const validStringSegment =
      typeof segment === 'string' && Buffer.byteLength(segment, 'utf8') <= 4_096 && !hasControlCharacter(segment);
    const validNumericSegment = typeof segment === 'number' && Number.isSafeInteger(segment) && segment >= 0;
    if (!validStringSegment && !validNumericSegment) {
      throw new Error(`${label} replacement path is invalid.`);
    }
  }
}

/** @param {Record<string,unknown>} plan @param {SavedPlanReviewGatePolicy} policy
 * @returns {Pick<SavedPlanReviewSummary, "formatVersion"|"terraformVersion"|"applyable"|"complete"|"errored">} */
function admitPlanDisposition(plan, policy) {
  const formatVersion = requiredDataProperty(plan, 'format_version', 'Terraform plan format_version');
  const terraformVersion = requiredDataProperty(plan, 'terraform_version', 'Terraform plan terraform_version');
  const applyable = requiredDataProperty(plan, 'applyable', 'Terraform plan applyable');
  const complete = requiredDataProperty(plan, 'complete', 'Terraform plan complete');
  const errored = requiredDataProperty(plan, 'errored', 'Terraform plan errored');
  if (formatVersion !== REVIEWED_PLAN_FORMAT_VERSION || terraformVersion !== REVIEWED_TERRAFORM_VERSION) {
    throw new Error('Terraform plan runtime is not the reviewed runtime.');
  }
  if ((applyable !== true && applyable !== false) || errored !== false || complete !== policy.complete) {
    throw new Error('Terraform plan execution disposition does not match the selected gate.');
  }

  return { formatVersion, terraformVersion, applyable, complete, errored };
}
/** @param {Record<string,unknown>} plan */
function rejectUnsupportedPlanActions(plan) {
  const deferredChanges = denseArray(
    optionalDataProperty(plan, 'deferred_changes', [], 'Terraform plan deferred_changes'),
    'Terraform plan deferred_changes',
  );
  if (deferredChanges.length !== 0) {
    throw new Error('Terraform plan contains deferred changes.');
  }
  const actionInvocations = denseArray(
    optionalDataProperty(plan, 'action_invocations', [], 'Terraform plan action_invocations'),
    'Terraform plan action_invocations',
  );
  const deferredActionInvocations = denseArray(
    optionalDataProperty(plan, 'deferred_action_invocations', [], 'Terraform plan deferred_action_invocations'),
    'Terraform plan deferred_action_invocations',
  );
  if (actionInvocations.length !== 0 || deferredActionInvocations.length !== 0) {
    throw new Error('Terraform plan action invocations are not supported by saved-plan review.');
  }
}
/** @param {boolean} applyable @param {SavedPlanReviewActionCounts} actionCounts @param {number} outputChangeCount @param {SavedPlanReviewGatePolicy} policy */
function assertSemanticPlanDisposition(applyable, actionCounts, outputChangeCount, policy) {
  const semanticResourceChangeCount = Object.values(actionCounts).reduce((total, count) => total + count, 0);
  const semanticNoOp = semanticResourceChangeCount === 0 && outputChangeCount === 0;
  if (applyable === false && !semanticNoOp) {
    throw new Error('Terraform non-applyable plan contains semantic changes.');
  }
  if (applyable === true && semanticNoOp) {
    throw new Error('Terraform applyable plan contains no semantic changes.');
  }
  if (applyable === false && policy.allowNonApplyableNoOp !== true) {
    throw new Error('Terraform non-applyable no-op is not admitted for the selected gate.');
  }
}

/** @param {number} value @param {string} label @param {SavedPlanReviewChangeBudget} budget */
function consumeNumericChangeValue(value, label, budget) {
  if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))) {
    throw new Error(`${label} is invalid.`);
  }
  consumeChangeValueBudget(budget, 0, label);
}
