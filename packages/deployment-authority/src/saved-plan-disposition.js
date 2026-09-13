import { isAppVerifierPrerequisiteReview } from './app-verifier-initialization.js';
import { resolveAllowedDeploymentTarget } from './index.js';
import { admitSavedPlanReviewContext } from './saved-plan-semantic-review.js';
/** @typedef {ReturnType<typeof resolveAllowedDeploymentTarget>} AllowedDeploymentTarget */
import { types } from 'node:util';
import {
  parseGitCommitSha,
  parseImageDigest,
  parseImmutableObjectReference,
  parseSha256,
  requireExactKeys,
  requireString,
} from './internal.js';
import { admitFoundationAcceptanceApprovalBinding, allowsAppEmptyPlanSkip } from './plan-approval.js';
import { PROVER_RELEASE_KIND, TOOLCHAIN_RELEASE_KIND, admitReleaseRecordKey } from './release-ledger.js';
import { MAX_SAVED_PLAN_REVIEW_ADDRESSES, redactTerraformResourceAddress } from './terraform-drift.js';

const MAX_CAPTURE_DEPTH = 64;
const MAX_CAPTURE_NODES = 1_100_000;
const MAX_CAPTURE_BYTES = 64 * 1024 * 1024;
const MAX_PLAN_COLLECTION_ENTRIES = 10_000;
const MAX_REPORTED_OUTPUT_NAMES = 100;
const MAX_ATTRIBUTE_NAMES = 100;
const ACTION_CLASS_ORDER = Object.freeze(['create', 'update', 'replace', 'delete', 'read-only']);

/** @type {Readonly<Record<string, 'EMPTY_PLAN_SKIP' | 'REVIEWABLE'>>} */
const DISPOSITION_TABLE = Object.freeze({
  '1.2|1.15.8|bootstrap|terraform|none|complete|applyable|change': 'REVIEWABLE',
  '1.2|1.15.8|bootstrap|terraform|none|complete|not-applyable|no-op': 'REVIEWABLE',
  '1.2|1.15.8|foundation|terraform|none|complete|applyable|change': 'REVIEWABLE',
  '1.2|1.15.8|foundation|terraform|none|complete|not-applyable|no-op': 'REVIEWABLE',
  '1.2|1.15.8|app|terraform|rollback|complete|applyable|change': 'REVIEWABLE',
  '1.2|1.15.8|app|terraform|rollback|complete|not-applyable|no-op': 'REVIEWABLE',
  '1.2|1.15.8|app|terraform|normal|complete|applyable|change': 'REVIEWABLE',
  '1.2|1.15.8|app|terraform|normal|complete|not-applyable|no-op': 'EMPTY_PLAN_SKIP',
  '1.2|1.15.8|app|verifier-preflight|normal|incomplete|applyable|change': 'REVIEWABLE',
});

/**
 * @typedef {object} CaptureBudget
 * @property {number} nodes
 * @property {number} bytes
 *
 * @typedef {object} SavedPlanDispositionInput
 * @property {unknown} review
 * @property {unknown} appReleaseChain
 *
 * @typedef {Readonly<{
 *   reviewType: 'saved-plan-semantic-review';
 *   context: Readonly<Record<string, unknown>>;
 *   summary: Readonly<{
 *     actionCounts: Readonly<Record<string, number>>;
 *     applyable: boolean;
 *     complete: boolean;
 *     errored: false;
 *     [key: string]: unknown;
 *   }>;
 *   approval: Readonly<Record<string, unknown>>;
 *   authority: null | Readonly<Record<string, unknown>>;
 * }>} SavedPlanSemanticReview
 */

/** @param {CaptureBudget} budget @param {number} bytes @param {string} label */
function spendCaptureBudget(budget, bytes, label) {
  budget.nodes += 1;
  budget.bytes += bytes;
  if (budget.nodes > MAX_CAPTURE_NODES || budget.bytes > MAX_CAPTURE_BYTES) {
    throw new Error(`${label} exceeds the admission bound.`);
  }
}

/**
 * Captures data properties without invoking user code and returns a detached frozen value.
 *
 * @param {unknown} value
 * @param {CaptureBudget} budget
 * @param {Set<object>} ancestors
 * @param {number} depth
 * @param {string} label
 * @returns {unknown}
 */
function captureData(value, budget, ancestors, depth, label) {
  if (depth > MAX_CAPTURE_DEPTH) {
    throw new Error(`${label} exceeds the admission depth.`);
  }
  if (value === null || typeof value === 'boolean') {
    spendCaptureBudget(budget, 0, label);
    return value;
  }
  if (typeof value === 'string') {
    spendCaptureBudget(budget, Buffer.byteLength(value, 'utf8'), label);
    return value;
  }
  if (typeof value === 'number') {
    spendCaptureBudget(budget, 0, label);
    if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))) {
      throw new Error(`${label} contains an invalid number.`);
    }
    return value;
  }
  if (typeof value !== 'object' || types.isProxy(value)) {
    throw new Error(`${label} must contain only inert data properties.`);
  }
  if (ancestors.has(value)) {
    throw new Error(`${label} must not be circular.`);
  }
  ancestors.add(value);
  spendCaptureBudget(budget, 0, label);
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) {
        throw new Error(`${label} arrays must use the ordinary array prototype.`);
      }
      const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
      if (
        lengthDescriptor === undefined ||
        !Object.hasOwn(lengthDescriptor, 'value') ||
        !Number.isSafeInteger(lengthDescriptor.value) ||
        lengthDescriptor.value < 0 ||
        lengthDescriptor.value > MAX_CAPTURE_NODES
      ) {
        throw new Error(`${label} must contain bounded dense arrays.`);
      }
      const ownKeys = Reflect.ownKeys(value);
      if (ownKeys.length !== lengthDescriptor.value + 1) {
        throw new Error(`${label} must contain bounded dense arrays.`);
      }
      const captured = [];
      for (let index = 0; index < lengthDescriptor.value; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (descriptor === undefined || descriptor.enumerable !== true || !Object.hasOwn(descriptor, 'value')) {
          throw new Error(`${label} must contain bounded dense arrays.`);
        }
        captured.push(captureData(descriptor.value, budget, ancestors, depth + 1, label));
      }
      if (
        ownKeys.some(
          (key) =>
            typeof key !== 'string' ||
            (key !== 'length' && (!/^(?:0|[1-9][0-9]*)$/u.test(key) || Number(key) >= captured.length)),
        )
      ) {
        throw new Error(`${label} must contain bounded dense arrays.`);
      }
      return Object.freeze(captured);
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error(`${label} records must use an ordinary object prototype.`);
    }
    const captured = {};
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (
        typeof key !== 'string' ||
        descriptor === undefined ||
        descriptor.enumerable !== true ||
        !Object.hasOwn(descriptor, 'value')
      ) {
        throw new Error(`${label} must contain only enumerable string-keyed data properties.`);
      }
      spendCaptureBudget(budget, Buffer.byteLength(key, 'utf8'), label);
      Object.defineProperty(captured, key, {
        configurable: true,
        enumerable: true,
        value: captureData(descriptor.value, budget, ancestors, depth + 1, label),
        writable: true,
      });
    }
    return Object.freeze(captured);
  } finally {
    ancestors.delete(value);
  }
}

/** @param {unknown} value @param {readonly string[]} keys @param {string} label */
function exactRecord(value, keys, label) {
  try {
    return requireExactKeys(value, keys, label);
  } catch (error) {
    throw new Error(`${label} must use the exact current shape.`, { cause: error });
  }
}

/** @param {Record<string, unknown>} value @param {string} key @returns {unknown} */
function field(value, key) {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined || !Object.hasOwn(descriptor, 'value')) {
    throw new Error('Saved-plan semantic review is missing an admitted field.');
  }
  return descriptor.value;
}

/** @param {unknown} value @param {string} label @returns {number} */
function count(value, label) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

/** @param {unknown} value @param {string} label @param {number} maximum @returns {number} */
function boundedCount(value, label, maximum) {
  const exactCount = count(value, label);
  if (exactCount > maximum) {
    throw new Error(`${label} exceeds its bound.`);
  }
  return exactCount;
}

/** @param {unknown} value @param {string} label @param {number} maximum @returns {unknown[]} */
function boundedArray(value, label, maximum) {
  if (!Array.isArray(value) || value.length > maximum) {
    throw new Error(`${label} must be a bounded array.`);
  }
  return value;
}

/**
 * @param {unknown} value
 * @param {string} label
 * @param {number} maximum
 * @param {RegExp | undefined} [pattern]
 * @returns {string[]}
 */
function sortedStrings(value, label, maximum, pattern) {
  const values = boundedArray(value, label, maximum).map((entry) => requireString(entry, label, pattern));
  if (values.some((entry, index) => index > 0 && (values[index - 1] ?? '') >= entry)) {
    throw new Error(`${label} must be sorted and unique.`);
  }
  return values;
}

/** @param {unknown} value @param {string} label @returns {string[]} */
function canonicalActionClasses(value, label) {
  const values = boundedArray(value, label, ACTION_CLASS_ORDER.length).map((entry) =>
    requireString(entry, label, /^(?:create|delete|read-only|replace|update)$/u),
  );
  const canonical = [...values].sort(
    (left, right) => ACTION_CLASS_ORDER.indexOf(left) - ACTION_CLASS_ORDER.indexOf(right),
  );
  if (
    values.length === 0 ||
    new Set(values).size !== values.length ||
    values.some((entry, index) => canonical[index] !== entry)
  ) {
    throw new Error(`${label} must use the canonical action order.`);
  }
  return values;
}

/** @param {unknown} value @param {string} label @returns {string} */
function positiveDecimalIdentity(value, label) {
  const identity = requireString(value, label, /^[1-9][0-9]*$/u);
  if (Buffer.byteLength(identity, 'utf8') > 32) {
    throw new Error(`${label} is invalid.`);
  }
  return identity;
}

/** @param {unknown} value @returns {string} */
function lambdaSourceCodeHash(value) {
  const encoded = requireString(value, 'Saved-plan verifier source code hash', /^[A-Za-z0-9+/]{43}=$/u);
  const decoded = Buffer.from(encoded, 'base64');
  if (decoded.length !== 32 || decoded.toString('base64') !== encoded) {
    throw new Error('Saved-plan verifier source code hash is invalid.');
  }
  return encoded;
}

/** @param {string} value @returns {boolean} */
function isCanonicalRedactedAddress(value) {
  const materialized = value.replace(/\[\*\]/gu, '["admitted-index"]');
  try {
    return redactTerraformResourceAddress(materialized) === value;
  } catch {
    return false;
  }
}

/**
 * @param {unknown} value
 * @param {string} label
 * @param {'address' | 'output'} nameKind
 * @returns {{count: number, names: string[], omittedNameCount: number}}
 */
function admitNamedCount(value, label, nameKind) {
  const summary = exactRecord(value, ['count', 'names', 'omittedNameCount'], label);
  const exactCount = boundedCount(field(summary, 'count'), `${label} count`, MAX_PLAN_COLLECTION_ENTRIES);
  const names = sortedStrings(
    field(summary, 'names'),
    `${label} names`,
    nameKind === 'address' ? MAX_SAVED_PLAN_REVIEW_ADDRESSES : MAX_REPORTED_OUTPUT_NAMES,
    nameKind === 'output' ? /^[A-Za-z0-9_-]{1,256}$/u : undefined,
  );
  if (
    nameKind === 'address' &&
    names.some((name) => Buffer.byteLength(name, 'utf8') > 1024 || !isCanonicalRedactedAddress(name))
  ) {
    throw new Error(`${label} names must be bounded redacted addresses.`);
  }
  const omitted = count(field(summary, 'omittedNameCount'), `${label} omitted-name count`);
  if (
    omitted !== 0 ||
    (nameKind === 'output' ? exactCount !== names.length : names.length > exactCount) ||
    (exactCount === 0) !== (names.length === 0)
  ) {
    throw new Error(`${label} count does not match its names.`);
  }
  return { count: exactCount, names, omittedNameCount: omitted };
}

/** @param {unknown} value @returns {{semanticChange: boolean, summary: Record<string, unknown>}} */
function admitSummary(value) {
  const summary = exactRecord(
    value,
    [
      'actionCounts',
      'applyable',
      'changedAddresses',
      'checkStatusCounts',
      'complete',
      'deferredChangeCount',
      'drift',
      'errored',
      'formatVersion',
      'foundationBootstrapImpact',
      'omittedChangedAddressCount',
      'outputChanges',
      'planJsonSha256',
      'terraformVersion',
      'tfplanSha256',
    ],
    'Saved-plan semantic review summary',
  );
  requireString(field(summary, 'formatVersion'), 'Saved-plan review plan format identity');
  requireString(field(summary, 'terraformVersion'), 'Saved-plan review Terraform identity');
  if (
    typeof field(summary, 'applyable') !== 'boolean' ||
    typeof field(summary, 'complete') !== 'boolean' ||
    field(summary, 'errored') !== false ||
    field(summary, 'deferredChangeCount') !== 0 ||
    field(summary, 'omittedChangedAddressCount') !== 0
  ) {
    throw new Error('Saved-plan review execution disposition is invalid.');
  }
  const actionCounts = exactRecord(
    field(summary, 'actionCounts'),
    ['create', 'delete', 'readOnly', 'replace', 'update'],
    'Saved-plan review action counts',
  );
  const parsedActionCounts = {
    create: boundedCount(field(actionCounts, 'create'), 'Saved-plan review create count', MAX_PLAN_COLLECTION_ENTRIES),
    update: boundedCount(field(actionCounts, 'update'), 'Saved-plan review update count', MAX_PLAN_COLLECTION_ENTRIES),
    replace: boundedCount(
      field(actionCounts, 'replace'),
      'Saved-plan review replace count',
      MAX_PLAN_COLLECTION_ENTRIES,
    ),
    delete: boundedCount(field(actionCounts, 'delete'), 'Saved-plan review delete count', MAX_PLAN_COLLECTION_ENTRIES),
    readOnly: boundedCount(
      field(actionCounts, 'readOnly'),
      'Saved-plan review read-only count',
      MAX_PLAN_COLLECTION_ENTRIES,
    ),
  };
  const observedActionCounts = { create: 0, update: 0, replace: 0, delete: 0, readOnly: 0 };
  const changedAddresses = boundedArray(
    field(summary, 'changedAddresses'),
    'Saved-plan review changed addresses',
    MAX_SAVED_PLAN_REVIEW_ADDRESSES,
  );
  let previousAddress = '';
  for (const [index, entry] of changedAddresses.entries()) {
    const changed = exactRecord(
      entry,
      [
        'actionClasses',
        'address',
        'changedAttributes',
        'replacementAttributes',
        'sensitiveAttributes',
        'unknownAttributes',
      ],
      `Saved-plan review changed address ${index}`,
    );
    const address = requireString(field(changed, 'address'), `Saved-plan review changed address ${index}`);
    if (
      Buffer.byteLength(address, 'utf8') > 1024 ||
      !isCanonicalRedactedAddress(address) ||
      (previousAddress !== '' && previousAddress >= address)
    ) {
      throw new Error('Saved-plan review changed addresses must be bounded, sorted, and unique.');
    }
    previousAddress = address;
    const actionClasses = canonicalActionClasses(
      field(changed, 'actionClasses'),
      `Saved-plan review changed address ${index} action classes`,
    );
    for (const actionClass of actionClasses) {
      switch (actionClass) {
        case 'create':
        case 'delete':
        case 'replace':
        case 'update':
          observedActionCounts[actionClass] += 1;
          break;
        case 'read-only':
          observedActionCounts.readOnly += 1;
          break;
        default:
          throw new Error('Saved-plan review action class is invalid.');
      }
    }
    /** @type {Record<string, string[]>} */
    const attributes = {};
    for (const attributeName of [
      'changedAttributes',
      'replacementAttributes',
      'sensitiveAttributes',
      'unknownAttributes',
    ]) {
      const admittedAttributes = sortedStrings(
        field(changed, attributeName),
        `Saved-plan review changed address ${index} ${attributeName}`,
        MAX_ATTRIBUTE_NAMES,
        /^[A-Za-z_][A-Za-z0-9_-]*$/u,
      );
      attributes[attributeName] = admittedAttributes;
      admittedAttributes.forEach((name) => {
        if (Buffer.byteLength(name, 'utf8') > 256) {
          throw new Error('Saved-plan review attribute name exceeds its bound.');
        }
      });
    }
    const changedAttributes = new Set(attributes['changedAttributes'] ?? []);
    if (attributes['replacementAttributes']?.some((name) => !changedAttributes.has(name))) {
      throw new Error('Saved-plan review replacement attributes must also be changed attributes.');
    }
  }
  for (const name of /** @type {const} */ (['create', 'update', 'replace', 'delete', 'readOnly'])) {
    if (
      observedActionCounts[name] > parsedActionCounts[name] ||
      parsedActionCounts[name] > 0 !== observedActionCounts[name] > 0
    ) {
      throw new Error('Saved-plan review changed addresses do not match its action counts.');
    }
  }
  const resourceChangeCount = Object.values(parsedActionCounts).reduce((total, exactCount) => total + exactCount, 0);
  if (resourceChangeCount > MAX_PLAN_COLLECTION_ENTRIES) {
    throw new Error('Saved-plan review resource action count exceeds its bound.');
  }
  if ((resourceChangeCount === 0) !== (changedAddresses.length === 0)) {
    throw new Error('Saved-plan review action counts do not match its changed addresses.');
  }
  const outputChanges = admitNamedCount(field(summary, 'outputChanges'), 'Saved-plan review output changes', 'output');
  admitNamedCount(field(summary, 'drift'), 'Saved-plan review drift', 'address');
  const checks = exactRecord(
    field(summary, 'checkStatusCounts'),
    ['error', 'fail', 'pass', 'unknown'],
    'Saved-plan review check counts',
  );
  const passingCheckCount = boundedCount(
    field(checks, 'pass'),
    'Saved-plan review passing-check count',
    MAX_PLAN_COLLECTION_ENTRIES,
  );
  const unknownCheckCount = boundedCount(
    field(checks, 'unknown'),
    'Saved-plan review unknown-check count',
    MAX_PLAN_COLLECTION_ENTRIES,
  );
  if (passingCheckCount + unknownCheckCount > MAX_PLAN_COLLECTION_ENTRIES) {
    throw new Error('Saved-plan review check count exceeds its bound.');
  }
  if (field(checks, 'fail') !== 0 || field(checks, 'error') !== 0) {
    throw new Error('Saved-plan review contains a failed or errored check.');
  }
  parseSha256(field(summary, 'planJsonSha256'), 'Saved-plan review plan JSON SHA-256');
  parseSha256(field(summary, 'tfplanSha256'), 'Saved-plan review tfplan SHA-256');
  const semanticChange = resourceChangeCount + outputChanges.count > 0;
  if (field(summary, 'applyable') !== semanticChange) {
    throw new Error('Saved-plan review applyable status does not match its semantic changes.');
  }
  return { semanticChange, summary };
}

/**
 * @param {unknown} value
 * @param {Record<string, unknown>} context
 * @param {Record<string, unknown>} summary
 * @returns {{approval: Record<string, unknown>, deploymentMode: 'normal' | 'rollback' | 'none'}}
 */
function admitApproval(value, context, summary) {
  const lane = field(context, 'lane');
  const gate = field(context, 'gate');
  const sourceSha = field(context, 'sourceSha');
  const accountId = field(context, 'accountId');
  const deploymentEnvironment = field(context, 'deploymentEnvironment');
  const tfplanSha256 = field(summary, 'tfplanSha256');
  if (lane === 'app' && gate === 'terraform') {
    const approval = exactRecord(
      value,
      [
        'accountId',
        'controlSourceSha',
        'deploymentEnvironment',
        'deploymentMode',
        'reviewedPlanChecksum',
        'selectedSourceSha',
      ],
      'Saved-plan semantic review App approval',
    );
    const deploymentMode = requireString(
      field(approval, 'deploymentMode'),
      'Saved-plan review App deployment mode',
      /^(?:normal|rollback)$/u,
    );
    const controlSourceSha = parseGitCommitSha(
      field(approval, 'controlSourceSha'),
      'Saved-plan review App control source SHA',
    );
    const selectedSourceSha = parseGitCommitSha(
      field(approval, 'selectedSourceSha'),
      'Saved-plan review App selected source SHA',
    );
    if (
      controlSourceSha !== sourceSha ||
      (deploymentMode === 'normal' && selectedSourceSha !== controlSourceSha) ||
      field(approval, 'accountId') !== accountId ||
      field(approval, 'deploymentEnvironment') !== deploymentEnvironment ||
      field(approval, 'reviewedPlanChecksum') !== tfplanSha256
    ) {
      throw new Error('Saved-plan review App approval does not match its context and saved plan.');
    }
    return {
      approval,
      deploymentMode: /** @type {'normal' | 'rollback'} */ (deploymentMode),
    };
  }
  const approval = exactRecord(
    value,
    ['accountId', 'deploymentEnvironment', 'reviewedPlanChecksum', 'sourceSha'],
    'Saved-plan semantic review source approval',
  );
  if (
    parseGitCommitSha(field(approval, 'sourceSha'), 'Saved-plan review approval source SHA') !== sourceSha ||
    field(approval, 'accountId') !== accountId ||
    field(approval, 'deploymentEnvironment') !== deploymentEnvironment ||
    field(approval, 'reviewedPlanChecksum') !== tfplanSha256
  ) {
    throw new Error('Saved-plan review source approval does not match its context and saved plan.');
  }
  return { approval, deploymentMode: lane === 'app' ? 'normal' : 'none' };
}

/** @param {unknown} value @param {Record<string, unknown>} context @param {AllowedDeploymentTarget} target */
function admitVerifierAuthority(value, context, target) {
  const authority = exactRecord(
    value,
    [
      'assetManifestSha256',
      'authorityType',
      'expectedFunctionVersion',
      'foundationAcceptance',
      'package',
      'packageSourceSha',
      'proverImageDigest',
      'reconciliationDesiredSha256',
      'sourceCodeHash',
      'trustRootSha256',
    ],
    'Saved-plan semantic review verifier authority',
  );
  const prerequisite = isAppVerifierPrerequisiteReview(authority, target.targetKey);
  if (
    (!prerequisite && field(authority, 'authorityType') !== 'app-verifier-preflight') ||
    parseGitCommitSha(field(authority, 'packageSourceSha'), 'Saved-plan verifier package source SHA') !==
      field(context, 'sourceSha')
  ) {
    throw new Error('Saved-plan verifier authority does not match its context.');
  }
  parseImageDigest(field(authority, 'proverImageDigest'), 'Saved-plan verifier prover image digest');
  parseImmutableObjectReference(field(authority, 'package'));
  lambdaSourceCodeHash(field(authority, 'sourceCodeHash'));
  parseSha256(field(authority, 'assetManifestSha256'), 'Saved-plan verifier asset-manifest SHA-256');
  parseSha256(field(authority, 'trustRootSha256'), 'Saved-plan verifier trust-root SHA-256');
  if (!prerequisite) {
    positiveDecimalIdentity(
      field(authority, 'expectedFunctionVersion'),
      'Saved-plan verifier expected FunctionVersion',
    );
    parseSha256(field(authority, 'reconciliationDesiredSha256'), 'Saved-plan verifier reconciliation desired SHA-256');
  }
  admitFoundationAcceptanceApprovalBinding(field(authority, 'foundationAcceptance'), target.targetKey);
}

/**
 * @param {unknown} value
 * @param {Record<string, unknown>} approval
 * @param {'normal' | 'rollback'} deploymentMode
 * @param {AllowedDeploymentTarget} target
 */
function admitAppDeploymentAuthority(value, approval, deploymentMode, target) {
  const authority = exactRecord(
    value,
    [
      'appExecutionAuthoritySha256',
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
      'proverReleaseKey',
      'selectedProverSelector',
      'selectedSourceSha',
      'toolchainReleaseKey',
      'toolchainImageDigest',
      'verifierFunctionVersion',
    ],
    'Saved-plan semantic review App deployment authority',
  );
  const selectedSourceSha = parseGitCommitSha(
    field(authority, 'selectedSourceSha'),
    'Saved-plan App deployment selected source SHA',
  );
  if (
    field(authority, 'authorityType') !== 'app-deployment' ||
    field(authority, 'deploymentMode') !== deploymentMode ||
    selectedSourceSha !== field(approval, 'selectedSourceSha') ||
    parseGitCommitSha(field(authority, 'lambdaSourceSha'), 'Saved-plan App Lambda source SHA') !== selectedSourceSha
  ) {
    throw new Error('Saved-plan App deployment authority does not match its approval.');
  }
  requireString(field(authority, 'deploymentId'), 'Saved-plan App deployment ID', /^dep_[0-9a-f]{32}$/u);
  parseSha256(field(authority, 'appExecutionAuthoritySha256'), 'Saved-plan App execution-authority SHA-256');
  requireString(
    field(authority, 'selectedProverSelector'),
    'Saved-plan App selected prover selector',
    /^(?:accepted|pinned)$/u,
  );
  requireString(field(authority, 'expectedImageId'), 'Saved-plan App expected ImageID', /^0x[0-9a-f]{64}$/u);
  const methodVersion = field(authority, 'methodVersion');
  if (typeof methodVersion !== 'number' || !Number.isSafeInteger(methodVersion) || methodVersion < 1) {
    throw new Error('Saved-plan App method identity is invalid.');
  }
  requireString(field(authority, 'imageIdVariant'), 'Saved-plan App ImageID variant', /^(?:default|x86_64)$/u);
  parseSha256(field(authority, 'imageIdMappingSha256'), 'Saved-plan App ImageID mapping SHA-256');
  parseImageDigest(field(authority, 'proverImageDigest'), 'Saved-plan App prover image digest');
  parseImageDigest(field(authority, 'toolchainImageDigest'), 'Saved-plan App toolchain image digest');
  admitReleaseRecordKey(PROVER_RELEASE_KIND, field(authority, 'proverReleaseKey'), target.targetKey);
  admitReleaseRecordKey(TOOLCHAIN_RELEASE_KIND, field(authority, 'toolchainReleaseKey'), target.targetKey);
  if (field(authority, 'lambdaCount') !== 6) {
    throw new Error('Saved-plan App Lambda count must be exactly 6.');
  }
  parseSha256(field(authority, 'lambdaSetSha256'), 'Saved-plan App Lambda-set SHA-256');
  positiveDecimalIdentity(field(authority, 'verifierFunctionVersion'), 'Saved-plan App verifier function identity');
}

/**
 * @param {unknown} value
 * @param {Record<string, unknown>} context
 * @param {Record<string, unknown>} approval
 * @param {'normal' | 'rollback' | 'none'} deploymentMode
 * @param {AllowedDeploymentTarget} target
 */
function admitAuthority(value, context, approval, deploymentMode, target) {
  const lane = field(context, 'lane');
  const gate = field(context, 'gate');
  if (lane !== 'app') {
    if (value !== null) {
      throw new Error('Saved-plan authority must be null outside the App lane.');
    }
    return;
  }
  if (gate === 'verifier-preflight') {
    admitVerifierAuthority(value, context, target);
    return;
  }
  if (deploymentMode !== 'normal' && deploymentMode !== 'rollback') {
    throw new Error('Saved-plan App deployment mode is invalid.');
  }
  admitAppDeploymentAuthority(value, approval, deploymentMode, target);
}

/** @param {unknown} value */
function admitMatchingReleaseChain(value) {
  const releaseChain = exactRecord(
    value,
    ['currentAcceptedReleaseChainSha256', 'deploymentMode', 'selectedReleaseChainSha256'],
    'Saved-plan disposition App release chain',
  );
  if (field(releaseChain, 'deploymentMode') !== 'normal') {
    throw new Error('Saved-plan disposition App release-chain deployment mode is invalid.');
  }
  const selected = parseSha256(
    field(releaseChain, 'selectedReleaseChainSha256'),
    'Saved-plan disposition selected release-chain SHA-256',
  );
  const accepted = parseSha256(
    field(releaseChain, 'currentAcceptedReleaseChainSha256'),
    'Saved-plan disposition accepted release-chain SHA-256',
  );
  if (selected !== accepted) {
    throw new Error('Saved-plan disposition App release chains do not match.');
  }
}

/**
 * Classifies an exact plan-time semantic review under the supported execution policy.
 *
 * @param {SavedPlanDispositionInput} value
 * @param {unknown} expectedTargetKey
 * @returns {Readonly<{disposition: 'EMPTY_PLAN_SKIP' | 'REVIEWABLE', review: SavedPlanSemanticReview}>}
 */
export function classifySavedPlanDisposition(value, expectedTargetKey) {
  const target = resolveAllowedDeploymentTarget(requireString(expectedTargetKey, 'Saved-plan expected target'));
  const captured = captureData(value, { nodes: 0, bytes: 0 }, new Set(), 0, 'Saved-plan disposition input');
  const input = exactRecord(captured, ['appReleaseChain', 'review'], 'Saved-plan disposition input');
  const review = exactRecord(
    field(input, 'review'),
    ['approval', 'authority', 'context', 'reviewType', 'summary'],
    'Saved-plan semantic review',
  );
  if (field(review, 'reviewType') !== 'saved-plan-semantic-review') {
    throw new Error('Saved-plan semantic review discriminator is invalid.');
  }
  const context = admitSavedPlanReviewContext(field(review, 'context'), target.targetKey);
  const { semanticChange, summary } = admitSummary(field(review, 'summary'));
  const { approval, deploymentMode } = admitApproval(field(review, 'approval'), context, summary);
  admitAuthority(field(review, 'authority'), context, approval, deploymentMode, target);
  const tableKey = [
    field(summary, 'formatVersion'),
    field(summary, 'terraformVersion'),
    field(context, 'lane'),
    field(context, 'gate'),
    deploymentMode,
    field(summary, 'complete') === true ? 'complete' : 'incomplete',
    field(summary, 'applyable') === true ? 'applyable' : 'not-applyable',
    semanticChange ? 'change' : 'no-op',
  ].join('|');
  const candidateDisposition = DISPOSITION_TABLE[tableKey];
  if (candidateDisposition === undefined) {
    throw new Error('Saved-plan disposition is not supported.');
  }
  const disposition =
    candidateDisposition === 'EMPTY_PLAN_SKIP' &&
    !allowsAppEmptyPlanSkip(field(context, 'deploymentEnvironment'), deploymentMode)
      ? 'REVIEWABLE'
      : candidateDisposition;
  const releaseChain = field(input, 'appReleaseChain');
  if (disposition === 'EMPTY_PLAN_SKIP') {
    admitMatchingReleaseChain(releaseChain);
  } else if (releaseChain !== null) {
    throw new Error('Saved-plan disposition App release chain must be null for a reviewable plan.');
  }
  return Object.freeze({
    disposition,
    review: /** @type {SavedPlanSemanticReview} */ (review),
  });
}
