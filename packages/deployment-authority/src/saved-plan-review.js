import { isDeepStrictEqual, types } from 'node:util';
import {
  canonicalJsonSha256,
  deepFreeze,
  hasControlCharacter,
  isPlainRecord,
  parseGitCommitSha,
  parseImageDigest,
  parseImmutableObjectReference,
  parseS3VersionId,
  parseSha256,
  requireExactKeys,
  requireGroupedLowercaseUuid,
  requireString,
} from './internal.js';
import {
  classifyTerraformActionSequence,
  redactTerraformResourceAddress,
  summarizeTerraformPlan,
} from './terraform-drift.js';

/**
 * @typedef {'app' | 'bootstrap' | 'foundation'} SavedPlanReviewLane
 * @typedef {'terraform' | 'verifier-preflight'} SavedPlanReviewGate
 * @typedef {'normal' | 'rollback'} SavedPlanReviewDeploymentMode
 * @typedef {'create' | 'update' | 'replace' | 'delete' | 'read-only'} SavedPlanReviewActionClass
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
 * @typedef {object} SavedPlanReviewArtifact
 * @property {string} bucket
 * @property {string} key
 * @property {string} sha256
 * @property {string} versionId
 *
 * @typedef {object} SavedPlanReviewState
 * @property {string} bucket
 * @property {string} key
 * @property {string} versionId
 * @property {string} etag
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
 * @typedef {object} SavedPlanReviewInput
 * @property {SavedPlanReviewContext} context
 * @property {SavedPlanReviewArtifact} artifact
 * @property {SavedPlanReviewState} state
 * @property {SavedPlanReviewPlanInput} plan
 * @property {SavedPlanReviewSourceApproval | SavedPlanReviewAppApproval} approval
 * @property {null | SavedPlanReviewAppVerifierPreflightAuthority | SavedPlanReviewAppDeploymentAuthority} authority
 *
 * @typedef {object} SavedPlanReviewAppVerifierPreflightAuthority
 * @property {'app-verifier-preflight'} authorityType
 * @property {string} packageSourceSha
 * @property {string} proverImageDigest
 * @property {{ key: string, versionId: string, sha256: string }} package
 * @property {string} sourceCodeHash
 * @property {string} assetManifestSha256
 * @property {string} trustRootSha256
 * @property {string} liveFunctionVersion
 * @property {string} liveAliasFunctionVersion
 * @property {string} liveAuthoritySha256
 *
 * @typedef {object} SavedPlanReviewAppDeploymentAuthority
 * @property {'app-deployment'} authorityType
 * @property {SavedPlanReviewDeploymentMode} deploymentMode
 * @property {string} selectedSourceSha
 * @property {string} deploymentId
 * @property {{ key: string, versionId: string, sha256: string }} appDeploymentRecord
 * @property {'accepted' | 'pinned'} selectedProverSelector
 * @property {string} expectedImageId
 * @property {number} methodVersion
 * @property {'default' | 'x86_64'} imageIdVariant
 * @property {string} imageIdMappingSha256
 * @property {string} proverImageDigest
 * @property {string} toolchainImageDigest
 * @property {{ key: string, versionId: string, sha256: string }} proverReleaseRecord
 * @property {{ key: string, versionId: string, sha256: string }} toolchainArtifactRecord
 * @property {string} lambdaSourceSha
 * @property {6} lambdaCount
 * @property {string} lambdaSetSha256
 * @property {string} verifierFunctionVersion
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
 * @property {SavedPlanReviewActionClass[]} actionClasses
 * @property {string[]} changedAttributes
 * @property {string[]} sensitiveAttributes
 * @property {string[]} unknownAttributes
 * @property {string[]} replacementAttributes
 *
 * @typedef {object} SavedPlanReviewSummary
 * @property {'1.2'} formatVersion
 * @property {'1.15.8'} terraformVersion
 * @property {boolean} applyable
 * @property {boolean} complete
 * @property {false} errored
 * @property {SavedPlanReviewActionCounts} actionCounts
 * @property {SavedPlanReviewChangedAddress[]} changedAddresses
 * @property {number} omittedChangedAddressCount
 * @property {{ count: number, names: string[], omittedNameCount: number }} outputChanges
 * @property {{ count: number, names: string[], omittedNameCount: number }} drift
 * @property {{ pass: number, unknown: number, fail: 0, error: 0 }} checkStatusCounts
 * @property {0} deferredChangeCount
 * @property {string} planJsonSha256
 * @property {string} tfplanSha256
 *
 * @typedef {object} SavedPlanReview
 * @property {'saved-plan-review'} reviewType
 * @property {SavedPlanReviewContext} context
 * @property {SavedPlanReviewArtifact} artifact
 * @property {SavedPlanReviewState} state
 * @property {SavedPlanReviewSummary} summary
 * @property {SavedPlanReviewSourceApproval | SavedPlanReviewAppApproval} approval
 * @property {null | SavedPlanReviewAppVerifierPreflightAuthority | SavedPlanReviewAppDeploymentAuthority} authority
 * @property {string} reviewDigest
 */

const CHECK_STATUSES = ['pass', 'unknown', 'fail', 'error'];
const MAX_PLAN_COLLECTION_ENTRIES = 10_000;
const MAX_REPORTED_OUTPUT_NAMES = 100;
const MAX_REPORTED_RESOURCE_ATTRIBUTES = 100;
const MAX_RESOURCE_ATTRIBUTE_NAME_BYTES = 256;
const MAX_REPLACEMENT_PATH_SEGMENTS = 256;
const MAX_CHANGE_VALUE_DEPTH = 64;
const MAX_CHANGE_VALUE_NODES = 1_000_000;
const MAX_CHANGE_VALUE_BYTES = 64 * 1024 * 1024;
const REVIEWED_PLAN_FORMAT_VERSION = '1.2';
const REVIEWED_TERRAFORM_VERSION = '1.15.8';
const REVIEW_GATES = Object.freeze({
  'app/terraform': Object.freeze({
    complete: true,
    allowNonApplyableNoOp: true,
    root: 'app',
    approval: 'app',
    authority: 'app-deployment',
  }),
  'app/verifier-preflight': Object.freeze({
    complete: false,
    allowNonApplyableNoOp: false,
    root: 'app',
    approval: 'source',
    authority: 'app-verifier-preflight',
  }),
  'bootstrap/terraform': Object.freeze({
    complete: true,
    allowNonApplyableNoOp: true,
    root: 'bootstrap',
    approval: 'source',
    authority: null,
  }),
  'foundation/terraform': Object.freeze({
    complete: true,
    allowNonApplyableNoOp: true,
    root: 'foundation',
    approval: 'source',
    authority: null,
  }),
});

function requiredRecord(value, label) {
  if (types.isProxy(value) || !isPlainRecord(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value;
}

function exactKeys(value, keys, label) {
  try {
    return requireExactKeys(value, keys, label);
  } catch (error) {
    throw new Error(`${label} must use the exact current shape.`, { cause: error });
  }
}

function requiredDataProperty(record, key, label) {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  if (descriptor === undefined || descriptor.enumerable !== true || !Object.hasOwn(descriptor, 'value')) {
    throw new Error(`${label} is required.`);
  }
  return descriptor.value;
}

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

function denseArray(value, label) {
  if (types.isProxy(value) || !Array.isArray(value) || value.length > MAX_PLAN_COLLECTION_ENTRIES) {
    throw new Error(`${label} must be a bounded dense array.`);
  }
  const values = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || descriptor.enumerable !== true || !Object.hasOwn(descriptor, 'value')) {
      throw new Error(`${label} must be a bounded dense array.`);
    }
    values.push(descriptor.value);
  }
  if (
    Reflect.ownKeys(value).length !== value.length + 1 ||
    Reflect.ownKeys(value).some(
      (key) =>
        typeof key !== 'string' ||
        (key !== 'length' && (!/^(?:0|[1-9][0-9]*)$/u.test(key) || Number(key) >= value.length)),
    )
  ) {
    throw new Error(`${label} must be a bounded dense array.`);
  }
  return values;
}

function parseContext(value) {
  const context = exactKeys(
    value,
    [
      'accountId',
      'backendKey',
      'deploymentEnvironment',
      'gate',
      'lane',
      'pipelineExecutionId',
      'region',
      'sourceSha',
      'stateIdentity',
    ],
    'Saved-plan review context',
  );
  const lane = requireString(context.lane, 'Saved-plan review lane', /^(?:app|bootstrap|foundation)$/u);
  const gate = requireString(context.gate, 'Saved-plan review gate', /^(?:terraform|verifier-preflight)$/u);
  const policy = REVIEW_GATES[`${lane}/${gate}`];
  if (policy === undefined) {
    throw new Error('Saved-plan review lane and gate are not supported.');
  }
  const deploymentEnvironment = requireString(
    context.deploymentEnvironment,
    'Saved-plan review deployment environment',
    /^[a-z][a-z0-9-]{0,62}$/u,
  );
  const stateIdentity = requireString(
    context.stateIdentity,
    'Saved-plan review state identity',
    /^[a-z][a-z0-9-]*\/[a-z][a-z0-9-]*\/(?:app|bootstrap|foundation)$/u,
  );
  const stateSegments = stateIdentity.split('/');
  if (stateSegments[1] !== deploymentEnvironment || stateSegments[2] !== policy.root) {
    throw new Error('Saved-plan review state identity does not match its context.');
  }
  const backendKey = requireString(
    context.backendKey,
    'Saved-plan review backend key',
    /^[A-Za-z0-9][A-Za-z0-9._/-]{1,1023}$/u,
  );
  if (
    backendKey.startsWith('/') ||
    backendKey.includes('//') ||
    backendKey.includes('..') ||
    !backendKey.endsWith(`/${stateIdentity}/terraform.tfstate`)
  ) {
    throw new Error('Saved-plan review backend key does not match its state identity.');
  }
  return deepFreeze({
    accountId: requireString(context.accountId, 'Saved-plan review AWS account ID', /^[0-9]{12}$/u),
    region: requireString(context.region, 'Saved-plan review AWS region', /^[a-z]{2}(?:-gov)?-[a-z]+-[0-9]$/u),
    deploymentEnvironment,
    lane,
    gate,
    pipelineExecutionId: requireGroupedLowercaseUuid(
      context.pipelineExecutionId,
      'Saved-plan review pipeline execution ID',
    ),
    sourceSha: parseGitCommitSha(context.sourceSha, 'Saved-plan review source SHA'),
    stateIdentity,
    backendKey,
  });
}

function parseS3BucketName(value, label) {
  const bucket = requireString(value, label, /^(?![0-9]+(?:\.[0-9]+){3}$)[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/u);
  if (bucket.includes('..') || bucket.includes('.-') || bucket.includes('-.')) {
    throw new Error(`${label} is invalid.`);
  }
  return bucket;
}

function parseArtifact(value) {
  const artifact = exactKeys(value, ['bucket', 'key', 'sha256', 'versionId'], 'Saved-plan review artifact');
  const bucket = parseS3BucketName(artifact.bucket, 'Saved-plan review artifact bucket');
  const reference = parseImmutableObjectReference({
    key: artifact.key,
    versionId: artifact.versionId,
    sha256: artifact.sha256,
  });
  return deepFreeze({ bucket, ...reference });
}

function parseState(value, context) {
  const state = exactKeys(value, ['bucket', 'etag', 'key', 'versionId'], 'Saved-plan review state');
  const key = requireString(state.key, 'Saved-plan review state key', /^[A-Za-z0-9][A-Za-z0-9._/-]{1,1023}$/u);
  if (key !== context.backendKey) {
    throw new Error('Saved-plan review state key does not match its backend context.');
  }
  const etag = requireString(state.etag, 'Saved-plan review state ETag', /^"[A-Za-z0-9._:+/=-]{1,1022}"$/u);
  if (Buffer.byteLength(etag, 'utf8') > 1024) {
    throw new Error('Saved-plan review state ETag is invalid.');
  }
  return deepFreeze({
    bucket: parseS3BucketName(state.bucket, 'Saved-plan review state bucket'),
    key,
    versionId: parseS3VersionId(state.versionId, 'Saved-plan review state VersionId'),
    etag,
  });
}

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

function attributeMetadataProperty(change, key, label) {
  const descriptor = Object.getOwnPropertyDescriptor(change, key);
  if (descriptor === undefined || descriptor.enumerable !== true || !Object.hasOwn(descriptor, 'value')) {
    throw new Error(`${label} attribute metadata is invalid.`);
  }
  return descriptor.value;
}

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

function consumeChangeValueBudget(budget, byteCount, label) {
  budget.nodes += 1;
  budget.bytes += byteCount;
  if (budget.nodes > MAX_CHANGE_VALUE_NODES || budget.bytes > MAX_CHANGE_VALUE_BYTES) {
    throw new Error(`${label} exceeds the review bound.`);
  }
}

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
      if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))) {
        throw new Error(`${label} is invalid.`);
      }
      consumeChangeValueBudget(budget, 0, label);
      return;
    case 'string':
      consumeChangeValueBudget(budget, Buffer.byteLength(value, 'utf8'), label);
      return;
    case 'object': {
      consumeChangeValueBudget(budget, 0, label);
      if (Array.isArray(value)) {
        const entries = denseArray(value, label);
        for (const entry of entries) {
          validateBoundedChangeValue(entry, label, budget, depth + 1);
        }
        return;
      }
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
          descriptor === undefined ||
          descriptor.enumerable !== true ||
          !Object.hasOwn(descriptor, 'value')
        ) {
          throw new Error(`${label} is invalid.`);
        }
        consumeChangeValueBudget(budget, Buffer.byteLength(key, 'utf8'), label);
        validateBoundedChangeValue(descriptor.value, label, budget, depth + 1);
      }
      return;
    }
    default:
      throw new Error(`${label} is invalid.`);
  }
}

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

function parseTopLevelResourceValue(value, label, budget) {
  if (value === null) {
    consumeChangeValueBudget(budget, 0, label);
    return new Map();
  }
  const record = requiredRecord(value, label);
  const keys = Reflect.ownKeys(record);
  if (keys.length > MAX_REPORTED_RESOURCE_ATTRIBUTES) {
    throw new Error('Terraform resource attribute summary exceeds the review bound.');
  }
  const attributes = new Map();
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    if (
      typeof key !== 'string' ||
      descriptor === undefined ||
      descriptor.enumerable !== true ||
      !Object.hasOwn(descriptor, 'value')
    ) {
      throw new Error(`${label} is invalid.`);
    }
    const attribute = parseResourceAttributeName(key, `${label} attribute name`);
    validateBoundedChangeValue(descriptor.value, label, budget, 1);
    attributes.set(attribute, descriptor.value);
  }
  return attributes;
}

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
    return entries.reduce(
      (containsTrue, entry) => flagTreeContainsTrue(entry, label, budget, depth + 1) || containsTrue,
      false,
    );
  }
  const record = requiredRecord(value, label);
  const keys = Reflect.ownKeys(record);
  if (keys.length > MAX_PLAN_COLLECTION_ENTRIES) {
    throw new Error(`${label} exceeds the review bound.`);
  }
  let containsTrue = false;
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    if (
      typeof key !== 'string' ||
      Buffer.byteLength(key, 'utf8') > 4_096 ||
      hasControlCharacter(key) ||
      descriptor === undefined ||
      descriptor.enumerable !== true ||
      !Object.hasOwn(descriptor, 'value')
    ) {
      throw new Error(`${label} is invalid.`);
    }
    consumeChangeValueBudget(budget, Buffer.byteLength(key, 'utf8'), label);
    containsTrue = flagTreeContainsTrue(descriptor.value, label, budget, depth + 1) || containsTrue;
  }
  return containsTrue;
}

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
  const record = requiredRecord(value, label);
  const keys = Reflect.ownKeys(record);
  if (keys.length > MAX_REPORTED_RESOURCE_ATTRIBUTES) {
    throw new Error('Terraform resource attribute summary exceeds the review bound.');
  }
  const attributes = [];
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    if (
      typeof key !== 'string' ||
      descriptor === undefined ||
      descriptor.enumerable !== true ||
      !Object.hasOwn(descriptor, 'value')
    ) {
      throw new Error(`${label} is invalid.`);
    }
    const attribute = parseResourceAttributeName(key, `${label} attribute name`);
    const containsTrue = flagTreeContainsTrue(descriptor.value, label, budget, 1);
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

function parseReplacementAttributes(value, knownAttributes, actionClass, label) {
  const paths = denseArray(value, `${label} replacement paths`);
  const attributes = new Set();
  for (const [pathIndex, pathValue] of paths.entries()) {
    const path = denseArray(pathValue, `${label} replacement path ${pathIndex}`);
    if (path.length === 0 || path.length > MAX_REPLACEMENT_PATH_SEGMENTS) {
      throw new Error(`${label} replacement path is invalid.`);
    }
    for (const segment of path) {
      const validStringSegment =
        typeof segment === 'string' && Buffer.byteLength(segment, 'utf8') <= 4_096 && !hasControlCharacter(segment);
      const validNumericSegment = Number.isSafeInteger(segment) && segment >= 0;
      if (!validStringSegment && !validNumericSegment) {
        throw new Error(`${label} replacement path is invalid.`);
      }
    }
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
    before,
    `${label} sensitive attribute metadata`,
    budget,
  );
  const afterSensitive = parseTopLevelFlaggedAttributes(
    attributeMetadataProperty(change, 'after_sensitive', label),
    after,
    `${label} sensitive attribute metadata`,
    budget,
  );
  const sensitiveAttributes = [...new Set([...beforeSensitive, ...afterSensitive])].sort();
  const unknownAttributes = parseTopLevelFlaggedAttributes(
    attributeMetadataProperty(change, 'after_unknown', label),
    after,
    `${label} unknown attribute metadata`,
    budget,
    true,
  );
  const replacementAttributes = parseReplacementAttributes(
    optionalReplacementPaths(change, label),
    knownAttributes,
    actionClass,
    label,
  );
  return { changedAttributes, sensitiveAttributes, unknownAttributes, replacementAttributes };
}

function mergeBoundedAttributes(target, source) {
  for (const attribute of source) {
    target.add(attribute);
  }
  if (target.size > MAX_REPORTED_RESOURCE_ATTRIBUTES) {
    throw new Error('Terraform resource attribute summary exceeds the review bound.');
  }
}

function summarizeChangedAddresses(resourceChanges, resourceSummary) {
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
    const aggregate =
      addressAttributes.get(address) ??
      Object.fromEntries(
        ['changedAttributes', 'sensitiveAttributes', 'unknownAttributes', 'replacementAttributes'].map((key) => [
          key,
          new Set(),
        ]),
      );
    for (const key of ['changedAttributes', 'sensitiveAttributes', 'unknownAttributes', 'replacementAttributes']) {
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

function summarizeOutputChanges(value) {
  const outputChanges = requiredRecord(value, 'Terraform plan output_changes');
  const changedNames = [];
  for (const key of Reflect.ownKeys(outputChanges)) {
    const descriptor = Object.getOwnPropertyDescriptor(outputChanges, key);
    if (
      typeof key !== 'string' ||
      descriptor === undefined ||
      descriptor.enumerable !== true ||
      !Object.hasOwn(descriptor, 'value') ||
      !/^[A-Za-z0-9_-]{1,256}$/u.test(key)
    ) {
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

function summarizeChecks(value) {
  const checks = denseArray(value, 'Terraform plan checks');
  const counts = Object.fromEntries(CHECK_STATUSES.map((status) => [status, 0]));
  for (const [index, valueAtIndex] of checks.entries()) {
    const check = requiredRecord(valueAtIndex, `Terraform plan check ${index}`);
    const status = requiredDataProperty(check, 'status', `Terraform plan check ${index} status`);
    if (typeof status !== 'string' || !CHECK_STATUSES.includes(status)) {
      throw new Error(`Terraform plan check ${index} status is invalid.`);
    }
    counts[status] += 1;
  }
  if (counts.fail !== 0 || counts.error !== 0) {
    throw new Error('Terraform plan contains a failed or errored check.');
  }
  return deepFreeze(counts);
}

function parsePlan(value, policy) {
  const planBinding = exactKeys(
    value,
    ['planJson', 'planJsonSha256', 'tfplanSha256'],
    'Saved-plan review plan binding',
  );
  const plan = requiredRecord(planBinding.planJson, 'Terraform plan JSON');
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
  const resourceSummary = summarizeTerraformPlan({ resource_changes: resourceChanges });
  if (resourceSummary.omittedAddressCount !== 0) {
    throw new Error('Saved-plan review cannot omit changed resource addresses.');
  }
  const changedAddresses = summarizeChangedAddresses(resourceChanges, resourceSummary);
  const driftSummary = summarizeTerraformPlan({ resource_changes: resourceDrift });
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
  const semanticResourceChangeCount = Object.values(resourceSummary.actionCounts).reduce(
    (total, count) => total + count,
    0,
  );
  const semanticNoOp = semanticResourceChangeCount === 0 && outputChanges.count === 0;
  if (applyable === false && !semanticNoOp) {
    throw new Error('Terraform non-applyable plan contains semantic changes.');
  }
  if (applyable === true && semanticNoOp) {
    throw new Error('Terraform applyable plan contains no semantic changes.');
  }
  if (applyable === false && policy.allowNonApplyableNoOp !== true) {
    throw new Error('Terraform non-applyable no-op is not admitted for the selected gate.');
  }
  const checkStatusCounts = summarizeChecks(requiredDataProperty(plan, 'checks', 'Terraform plan checks'));
  return deepFreeze({
    formatVersion,
    terraformVersion,
    applyable,
    complete,
    errored,
    actionCounts: resourceSummary.actionCounts,
    changedAddresses,
    omittedChangedAddressCount: resourceSummary.omittedAddressCount,
    outputChanges,
    drift,
    checkStatusCounts,
    deferredChangeCount: 0,
    planJsonSha256: parseSha256(planBinding.planJsonSha256, 'Saved-plan review plan JSON SHA-256'),
    tfplanSha256: parseSha256(planBinding.tfplanSha256, 'Saved-plan review tfplan SHA-256'),
  });
}

function parseApproval(value, context, policy, tfplanSha256) {
  if (policy.approval === 'app') {
    const approval = exactKeys(
      value,
      [
        'accountId',
        'controlSourceSha',
        'deploymentEnvironment',
        'deploymentMode',
        'reviewedPlanChecksum',
        'selectedSourceSha',
      ],
      'Saved-plan review App approval',
    );
    const deploymentMode = requireString(
      approval.deploymentMode,
      'Saved-plan review App deployment mode',
      /^(?:normal|rollback)$/u,
    );
    const controlSourceSha = parseGitCommitSha(approval.controlSourceSha, 'Saved-plan review App control source SHA');
    const selectedSourceSha = parseGitCommitSha(
      approval.selectedSourceSha,
      'Saved-plan review App selected source SHA',
    );
    if (
      controlSourceSha !== context.sourceSha ||
      (deploymentMode === 'normal' && selectedSourceSha !== controlSourceSha)
    ) {
      throw new Error('Saved-plan review App source authority does not match its context.');
    }
    const parsed = {
      deploymentMode,
      controlSourceSha,
      selectedSourceSha,
      accountId: approval.accountId,
      deploymentEnvironment: approval.deploymentEnvironment,
      reviewedPlanChecksum: approval.reviewedPlanChecksum,
    };
    assertApprovalBindings(parsed, context, tfplanSha256);
    return deepFreeze(parsed);
  }

  const approval = exactKeys(
    value,
    ['accountId', 'deploymentEnvironment', 'reviewedPlanChecksum', 'sourceSha'],
    'Saved-plan review source approval',
  );
  const sourceSha = parseGitCommitSha(approval.sourceSha, 'Saved-plan review approval source SHA');
  if (sourceSha !== context.sourceSha) {
    throw new Error('Saved-plan review approval source SHA does not match its context.');
  }
  const parsed = {
    sourceSha,
    accountId: approval.accountId,
    deploymentEnvironment: approval.deploymentEnvironment,
    reviewedPlanChecksum: approval.reviewedPlanChecksum,
  };
  assertApprovalBindings(parsed, context, tfplanSha256);
  return deepFreeze(parsed);
}

function assertApprovalBindings(approval, context, tfplanSha256) {
  if (
    approval.accountId !== context.accountId ||
    approval.deploymentEnvironment !== context.deploymentEnvironment ||
    approval.reviewedPlanChecksum !== tfplanSha256
  ) {
    throw new Error('Saved-plan review approval does not match its context and saved plan.');
  }
}

function parsePositiveDecimalVersion(value, label) {
  const version = requireString(value, label, /^[1-9][0-9]*$/u);
  if (Buffer.byteLength(version, 'utf8') > 32) {
    throw new Error(`${label} is invalid.`);
  }
  return version;
}

function parseLambdaSourceCodeHash(value) {
  const sourceCodeHash = requireString(value, 'Saved-plan review verifier source code hash', /^[A-Za-z0-9+/]{43}=$/u);
  const decoded = Buffer.from(sourceCodeHash, 'base64');
  if (decoded.length !== 32 || decoded.toString('base64') !== sourceCodeHash) {
    throw new Error('Saved-plan review verifier source code hash is invalid.');
  }
  return sourceCodeHash;
}

function parseAppVerifierPreflightAuthority(value, context) {
  const authority = exactKeys(
    value,
    [
      'assetManifestSha256',
      'authorityType',
      'liveAliasFunctionVersion',
      'liveAuthoritySha256',
      'liveFunctionVersion',
      'package',
      'packageSourceSha',
      'proverImageDigest',
      'sourceCodeHash',
      'trustRootSha256',
    ],
    'Saved-plan review App verifier preflight authority',
  );
  if (authority.authorityType !== 'app-verifier-preflight') {
    throw new Error('Saved-plan review App verifier preflight authority discriminator is invalid.');
  }
  const packageSourceSha = parseGitCommitSha(
    authority.packageSourceSha,
    'Saved-plan review verifier package source SHA',
  );
  if (packageSourceSha !== context.sourceSha) {
    throw new Error('Saved-plan review verifier package source SHA does not match its context.');
  }
  return deepFreeze({
    authorityType: 'app-verifier-preflight',
    packageSourceSha,
    proverImageDigest: parseImageDigest(authority.proverImageDigest, 'Saved-plan review verifier prover image digest'),
    package: parseImmutableObjectReference(authority.package),
    sourceCodeHash: parseLambdaSourceCodeHash(authority.sourceCodeHash),
    assetManifestSha256: parseSha256(
      authority.assetManifestSha256,
      'Saved-plan review verifier asset manifest SHA-256',
    ),
    trustRootSha256: parseSha256(authority.trustRootSha256, 'Saved-plan review verifier trust root SHA-256'),
    liveFunctionVersion: parsePositiveDecimalVersion(
      authority.liveFunctionVersion,
      'Saved-plan review verifier live function version',
    ),
    liveAliasFunctionVersion: parsePositiveDecimalVersion(
      authority.liveAliasFunctionVersion,
      'Saved-plan review verifier live alias function version',
    ),
    liveAuthoritySha256: parseSha256(
      authority.liveAuthoritySha256,
      'Saved-plan review verifier live authority SHA-256',
    ),
  });
}

function parseAppDeploymentAuthority(value, approval) {
  const authority = exactKeys(
    value,
    [
      'appDeploymentRecord',
      'authorityType',
      'deploymentId',
      'deploymentMode',
      'expectedImageId',
      'imageIdMappingSha256',
      'imageIdVariant',
      'lambdaCount',
      'lambdaSetSha256',
      'lambdaSourceSha',
      'methodVersion',
      'proverImageDigest',
      'proverReleaseRecord',
      'selectedProverSelector',
      'selectedSourceSha',
      'toolchainArtifactRecord',
      'toolchainImageDigest',
      'verifierFunctionVersion',
    ],
    'Saved-plan review App deployment authority',
  );
  if (authority.authorityType !== 'app-deployment') {
    throw new Error('Saved-plan review App deployment authority discriminator is invalid.');
  }
  const deploymentMode = requireString(
    authority.deploymentMode,
    'Saved-plan review App deployment authority mode',
    /^(?:normal|rollback)$/u,
  );
  const selectedSourceSha = parseGitCommitSha(
    authority.selectedSourceSha,
    'Saved-plan review App deployment authority selected source SHA',
  );
  if (deploymentMode !== approval.deploymentMode || selectedSourceSha !== approval.selectedSourceSha) {
    throw new Error('Saved-plan review App deployment authority does not match its approval.');
  }
  const lambdaSourceSha = parseGitCommitSha(
    authority.lambdaSourceSha,
    'Saved-plan review App deployment Lambda source SHA',
  );
  if (lambdaSourceSha !== selectedSourceSha) {
    throw new Error('Saved-plan review App deployment Lambda source SHA does not match the selected source.');
  }
  if (authority.lambdaCount !== 6) {
    throw new Error('Saved-plan review App deployment Lambda count must be exactly 6.');
  }
  if (!Number.isSafeInteger(authority.methodVersion) || authority.methodVersion < 1) {
    throw new Error('Saved-plan review App deployment method version is invalid.');
  }
  return deepFreeze({
    authorityType: 'app-deployment',
    deploymentMode,
    selectedSourceSha,
    deploymentId: requireString(authority.deploymentId, 'Saved-plan review App deployment ID', /^dep_[0-9a-f]{32}$/u),
    appDeploymentRecord: parseImmutableObjectReference(authority.appDeploymentRecord),
    selectedProverSelector: requireString(
      authority.selectedProverSelector,
      'Saved-plan review App selected prover selector',
      /^(?:accepted|pinned)$/u,
    ),
    expectedImageId: requireString(
      authority.expectedImageId,
      'Saved-plan review App expected ImageID',
      /^0x[0-9a-f]{64}$/u,
    ),
    methodVersion: authority.methodVersion,
    imageIdVariant: requireString(
      authority.imageIdVariant,
      'Saved-plan review App ImageID variant',
      /^(?:default|x86_64)$/u,
    ),
    imageIdMappingSha256: parseSha256(authority.imageIdMappingSha256, 'Saved-plan review App ImageID mapping SHA-256'),
    proverImageDigest: parseImageDigest(authority.proverImageDigest, 'Saved-plan review App prover image digest'),
    toolchainImageDigest: parseImageDigest(
      authority.toolchainImageDigest,
      'Saved-plan review App toolchain image digest',
    ),
    proverReleaseRecord: parseImmutableObjectReference(authority.proverReleaseRecord),
    toolchainArtifactRecord: parseImmutableObjectReference(authority.toolchainArtifactRecord),
    lambdaSourceSha,
    lambdaCount: 6,
    lambdaSetSha256: parseSha256(authority.lambdaSetSha256, 'Saved-plan review App Lambda set SHA-256'),
    verifierFunctionVersion: parsePositiveDecimalVersion(
      authority.verifierFunctionVersion,
      'Saved-plan review App verifier function version',
    ),
  });
}

function parseAuthority(value, context, policy, approval) {
  if (policy.authority === null) {
    if (value !== null) {
      throw new Error('Saved-plan review authority must be null outside the App lane.');
    }
    return null;
  }
  const authority = requiredRecord(value, 'Saved-plan review authority');
  if (policy.authority === 'app-verifier-preflight') {
    return parseAppVerifierPreflightAuthority(authority, context);
  }
  return parseAppDeploymentAuthority(authority, approval);
}

/**
 * Builds the immutable semantic review bound to one exact saved-plan artifact.
 *
 * @param {SavedPlanReviewInput} value
 * @returns {SavedPlanReview}
 */
export function buildSavedPlanReview(value) {
  const input = exactKeys(
    value,
    ['approval', 'artifact', 'authority', 'context', 'plan', 'state'],
    'Saved-plan review input',
  );
  const context = parseContext(input.context);
  const policy = REVIEW_GATES[`${context.lane}/${context.gate}`];
  const artifact = parseArtifact(input.artifact);
  const state = parseState(input.state, context);
  const summary = parsePlan(input.plan, policy);
  const approval = parseApproval(input.approval, context, policy, summary.tfplanSha256);
  const authority = parseAuthority(input.authority, context, policy, approval);
  const reviewDigest = canonicalJsonSha256({ context, artifact, state, summary, approval, authority });
  return deepFreeze({
    reviewType: 'saved-plan-review',
    context,
    artifact,
    state,
    summary,
    approval,
    authority,
    reviewDigest,
  });
}
