import { types } from 'node:util';

import { allowsAppEmptyPlanSkip } from './plan-approval.js';
import { admitAppAcceptanceRecordKey } from './app-acceptance-ledger.js';
import { snapshotDataTree, snapshotExactRecord } from './descriptor-snapshot.js';
import {
  canonicalJsonSha256,
  deepFreeze,
  parseGitCommitSha,
  parseImageDigest,
  parseImmutableObjectReference,
  parseSha256,
  requireString,
} from './internal.js';
import { deriveDeploymentIdentity, resolveAllowedDeploymentTarget, resolveDeploymentLaneAuthority } from './index.js';
import { PROVER_RELEASE_KIND, TOOLCHAIN_RELEASE_KIND, admitReleaseRecordKey } from './release-ledger.js';
import { admitSavedPlanReviewContext } from './saved-plan-semantic-review.js';
import { FOUNDATION_ACCEPTANCE_KIND, admitTerraformAcceptanceRecordKey } from './terraform-acceptance.js';
import { redactTerraformResourceAddress } from './terraform-drift.js';

const INPUT_KEYS = ['authority', 'evidence', 'releaseComparison'];
const EVIDENCE_KEYS = ['approval', 'context', 'summary'];
const SUMMARY_KEYS = [
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
];
const RELEASE_FACT_KEYS = [
  'foundationAcceptanceKey',
  'foundationContractHash',
  'proverImageDigest',
  'proverReleaseKey',
  'toolchainImageDigest',
  'toolchainReleaseKey',
  'zkvmContractHash',
];
const PREFLIGHT_AUTHORITY_KEYS = [
  ...RELEASE_FACT_KEYS,
  'assetManifestSha256',
  'expectedFunctionVersion',
  'package',
  'packageSourceSha',
  'reconciliationDesiredSha256',
  'releaseAuthoritySha256',
  'sourceCodeHash',
  'trustRootSha256',
];
const NORMAL_AUTHORITY_KEYS = [
  ...RELEASE_FACT_KEYS,
  'appExecutionAuthoritySha256',
  'deploymentId',
  'deploymentMode',
  'expectedImageId',
  'imageIdMappingSha256',
  'imageIdVariant',
  'lambdaCount',
  'lambdaSetSha256',
  'lambdaSourceSha',
  'methodVersion',
  'selectedSourceSha',
  'verifierFunctionVersion',
];
const ROLLBACK_AUTHORITY_KEYS = [
  'appExecutionAuthoritySha256',
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
  'selectedAcceptanceKey',
  'selectedSourceSha',
  'toolchainImageDigest',
  'toolchainReleaseKey',
  'verifierFunctionVersion',
  'zkvmContractHash',
];
const MAX_INSPECTED_VALUES = 100_000;
const MAX_INSPECTED_BYTES = 64 * 1024 * 1024;
const MAX_COLLECTION_ENTRIES = 10_000;
const MAX_REPORTED_NAMES = 100;
const MAX_DEPTH = 64;
/** @typedef {ReturnType<typeof resolveAllowedDeploymentTarget>} AllowedDeploymentTarget */

/**
 * Reject proxies before descriptor capture can reach their traps. Collection
 * widths are admitted before recursive descent.
 *
 * @param {unknown} value
 * @param {string} label
 * @param {{bytes: number; count: number}} [budget]
 * @param {Set<object>} [ancestors]
 * @param {number} [depth]
 */
function rejectProxies(value, label, budget = { bytes: 0, count: 0 }, ancestors = new Set(), depth = 0) {
  budget.count += 1;
  if (typeof value === 'string') {
    budget.bytes += Buffer.byteLength(value, 'utf8');
  }
  if (budget.count > MAX_INSPECTED_VALUES || budget.bytes > MAX_INSPECTED_BYTES || depth > MAX_DEPTH) {
    throw new Error(`${label} exceeds its inspection bound.`);
  }
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) {
    return;
  }
  if (types.isProxy(value)) {
    throw new Error(`${label} must not contain a proxy.`);
  }
  if (ancestors.has(value)) {
    throw new Error(`${label} must not contain a cycle.`);
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const lengthDescriptor = Reflect.getOwnPropertyDescriptor(value, 'length');
      const length = lengthDescriptor?.value;
      if (
        lengthDescriptor === undefined ||
        !Object.hasOwn(lengthDescriptor, 'value') ||
        typeof length !== 'number' ||
        !Number.isSafeInteger(length) ||
        length < 0 ||
        length > MAX_COLLECTION_ENTRIES
      ) {
        throw new Error(`${label} contains an over-bound collection.`);
      }
    }
    const keys = Reflect.ownKeys(value);
    if (keys.length > MAX_COLLECTION_ENTRIES + (Array.isArray(value) ? 1 : 0)) {
      throw new Error(`${label} contains an over-bound collection.`);
    }
    for (const key of keys) {
      if (typeof key === 'string') {
        budget.bytes += Buffer.byteLength(key, 'utf8');
        if (budget.bytes > MAX_INSPECTED_BYTES) {
          throw new Error(`${label} exceeds its inspection bound.`);
        }
      }
      const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
      if (descriptor !== undefined && Object.hasOwn(descriptor, 'value')) {
        rejectProxies(descriptor.value, label, budget, ancestors, depth + 1);
      }
    }
  } finally {
    ancestors.delete(value);
  }
}

/** @param {unknown} value @param {readonly string[]} keys @param {string} label */
function exactRecord(value, keys, label) {
  try {
    return snapshotExactRecord(value, keys, label);
  } catch (error) {
    throw new Error(`${label} must use the exact current shape.`, { cause: error });
  }
}

/** @param {unknown} value @param {string} label @param {number} [maximum] */
function count(value, label, maximum = MAX_COLLECTION_ENTRIES) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > maximum) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

/** @param {unknown} value @param {string} label */
function positiveSafeInteger(value, label) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

/** @param {unknown} value @param {string} label @param {number} [maximum] */
function denseArray(value, label, maximum = MAX_COLLECTION_ENTRIES) {
  if (!Array.isArray(value) || value.length > maximum) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

/** @param {unknown} value @param {string} label */
function sortedStrings(value, label) {
  const entries = denseArray(value, label, MAX_REPORTED_NAMES).map((entry) => {
    const admitted = requireString(entry, `${label} entry`);
    if (Buffer.byteLength(admitted, 'utf8') > 1024) {
      throw new Error(`${label} entry exceeds its bound.`);
    }
    return admitted;
  });
  let priorEntry = '';
  if (
    new Set(entries).size !== entries.length ||
    entries.some((entry) => {
      const outOfOrder = priorEntry !== '' && priorEntry >= entry;
      priorEntry = entry;
      return outOfOrder;
    })
  ) {
    throw new Error(`${label} must be sorted and unique.`);
  }
  return entries;
}

/** @param {string} value */
function isCanonicalRedactedAddress(value) {
  const materialized = value.replace(/\[\*\]/gu, '["admitted-index"]');
  try {
    return redactTerraformResourceAddress(materialized) === value;
  } catch {
    return false;
  }
}

/** @param {unknown} value @param {string} label @param {'address' | 'output'} kind */
function namedCount(value, label, kind) {
  const record = exactRecord(value, ['count', 'names', 'omittedNameCount'], label);
  const exactCount = count(record['count'], `${label} count`);
  const names = sortedStrings(record['names'], `${label} names`);
  if (
    record['omittedNameCount'] !== 0 ||
    (exactCount === 0) !== (names.length === 0) ||
    (kind === 'output' ? names.length !== exactCount : names.length > exactCount) ||
    names.some((name) =>
      kind === 'output' ? !/^[A-Za-z0-9_-]{1,256}$/u.test(name) : !isCanonicalRedactedAddress(name),
    )
  ) {
    throw new Error(`${label} count is detached from its names.`);
  }
  return deepFreeze({ count: exactCount, names, omittedNameCount: 0 });
}

/** @param {unknown} value @param {string} label */
function attributeNames(value, label) {
  const entries = denseArray(value, label, MAX_REPORTED_NAMES).map((entry) => {
    const admitted = requireString(entry, `${label} entry`, /^[A-Za-z_][A-Za-z0-9_-]*$/u);
    if (Buffer.byteLength(admitted, 'utf8') > 256) {
      throw new Error(`${label} entry exceeds its bound.`);
    }
    return admitted;
  });
  let priorEntry = '';
  if (
    new Set(entries).size !== entries.length ||
    entries.some((entry) => {
      const outOfOrder = priorEntry !== '' && priorEntry >= entry;
      priorEntry = entry;
      return outOfOrder;
    })
  ) {
    throw new Error(`${label} must be sorted and unique.`);
  }
  return Object.freeze(entries);
}

/** @param {unknown} value */
function admitSummary(value) {
  const summary = exactRecord(value, SUMMARY_KEYS, 'App saved-plan summary');
  if (
    summary['formatVersion'] !== '1.2' ||
    summary['terraformVersion'] !== '1.15.8' ||
    typeof summary['applyable'] !== 'boolean' ||
    typeof summary['complete'] !== 'boolean' ||
    summary['errored'] !== false ||
    summary['deferredChangeCount'] !== 0 ||
    summary['omittedChangedAddressCount'] !== 0
  ) {
    throw new Error('App saved-plan execution disposition is invalid.');
  }
  const rawCounts = exactRecord(
    summary['actionCounts'],
    ['create', 'delete', 'readOnly', 'replace', 'update'],
    'App saved-plan action counts',
  );
  const actionCounts = deepFreeze({
    create: count(rawCounts['create'], 'App saved-plan create count'),
    update: count(rawCounts['update'], 'App saved-plan update count'),
    replace: count(rawCounts['replace'], 'App saved-plan replace count'),
    delete: count(rawCounts['delete'], 'App saved-plan delete count'),
    readOnly: count(rawCounts['readOnly'], 'App saved-plan read-only count'),
  });
  const observed = { create: 0, update: 0, replace: 0, delete: 0, readOnly: 0 };
  let previousAddress = '';
  const changedAddresses = denseArray(
    summary['changedAddresses'],
    'App saved-plan changed addresses',
    MAX_REPORTED_NAMES,
  ).map((entry, index) => {
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
      `App saved-plan changed address ${index}`,
    );
    const address = requireString(changed['address'], `App saved-plan changed address ${index}`);
    if (Buffer.byteLength(address, 'utf8') > 1024) {
      throw new Error(`App saved-plan changed address ${index} exceeds its bound.`);
    }
    if (!isCanonicalRedactedAddress(address) || (previousAddress !== '' && previousAddress >= address)) {
      throw new Error('App saved-plan changed addresses must be redacted, sorted, and unique.');
    }
    previousAddress = address;
    const actionClasses = denseArray(
      changed['actionClasses'],
      `App saved-plan changed address ${index} action classes`,
      5,
    ).map((actionClass) =>
      requireString(
        actionClass,
        `App saved-plan changed address ${index} action class`,
        /^(?:create|update|replace|delete|read-only)$/u,
      ),
    );
    const actionOrder = ['create', 'update', 'replace', 'delete', 'read-only'];
    let priorActionIndex = -1;
    if (
      actionClasses.length === 0 ||
      new Set(actionClasses).size !== actionClasses.length ||
      actionClasses.some((actionClass) => {
        const actionIndex = actionOrder.indexOf(actionClass);
        const outOfOrder = actionIndex < 0 || actionIndex <= priorActionIndex;
        priorActionIndex = actionIndex;
        return outOfOrder;
      })
    ) {
      throw new Error('App saved-plan action classes are invalid.');
    }
    for (const actionClass of actionClasses) {
      if (actionClass === 'read-only') observed.readOnly += 1;
      else if (
        actionClass === 'create' ||
        actionClass === 'update' ||
        actionClass === 'replace' ||
        actionClass === 'delete'
      ) {
        observed[actionClass] += 1;
      } else {
        throw new Error('App saved-plan action class is invalid.');
      }
    }
    const changedAttributes = attributeNames(changed['changedAttributes'], 'App saved-plan changed attributes');
    const replacementAttributes = attributeNames(
      changed['replacementAttributes'],
      'App saved-plan replacement attributes',
    );
    if (replacementAttributes.some((name) => !changedAttributes.includes(name))) {
      throw new Error('App saved-plan replacement attributes are detached from changed attributes.');
    }
    return deepFreeze({
      address,
      actionClasses: Object.freeze([...actionClasses]),
      changedAttributes,
      replacementAttributes,
      sensitiveAttributes: attributeNames(changed['sensitiveAttributes'], 'App saved-plan sensitive attributes'),
      unknownAttributes: attributeNames(changed['unknownAttributes'], 'App saved-plan unknown attributes'),
    });
  });
  for (const key of /** @type {const} */ (['create', 'update', 'replace', 'delete', 'readOnly'])) {
    if ((actionCounts[key] === 0) !== (observed[key] === 0) || observed[key] > actionCounts[key]) {
      throw new Error('App saved-plan action counts are detached from changed addresses.');
    }
  }
  const resourceChangeCount = Object.values(actionCounts).reduce((total, value) => total + value, 0);
  if (resourceChangeCount > MAX_COLLECTION_ENTRIES) {
    throw new Error('App saved-plan resource action count exceeds its bound.');
  }
  if ((resourceChangeCount === 0) !== (changedAddresses.length === 0)) {
    throw new Error('App saved-plan action counts are detached from changed addresses.');
  }
  const outputChanges = namedCount(summary['outputChanges'], 'App saved-plan output changes', 'output');
  const drift = namedCount(summary['drift'], 'App saved-plan drift', 'address');
  const checks = exactRecord(
    summary['checkStatusCounts'],
    ['error', 'fail', 'pass', 'unknown'],
    'App saved-plan check counts',
  );
  const checkStatusCounts = deepFreeze({
    pass: count(checks['pass'], 'App saved-plan passing check count'),
    unknown: count(checks['unknown'], 'App saved-plan unknown check count'),
    fail: count(checks['fail'], 'App saved-plan failing check count'),
    error: count(checks['error'], 'App saved-plan errored check count'),
  });
  if (checkStatusCounts.fail !== 0 || checkStatusCounts.error !== 0) {
    throw new Error('App saved-plan contains a failed or errored check.');
  }
  if (checkStatusCounts.pass + checkStatusCounts.unknown > MAX_COLLECTION_ENTRIES) {
    throw new Error('App saved-plan check count exceeds its bound.');
  }
  const semanticChange = resourceChangeCount + outputChanges.count > 0;
  if (summary['applyable'] !== semanticChange) {
    throw new Error('App saved-plan applyable status is detached from its semantic changes.');
  }
  return /** @type {Readonly<Record<string, unknown> & {applyable: boolean; complete: boolean; semanticChange: boolean; tfplanSha256: string}>} */ (
    deepFreeze({
      ...summary,
      applyable: summary['applyable'],
      complete: summary['complete'],
      actionCounts,
      changedAddresses: Object.freeze(changedAddresses),
      outputChanges,
      drift,
      checkStatusCounts,
      planJsonSha256: parseSha256(summary['planJsonSha256'], 'App saved-plan JSON SHA-256'),
      tfplanSha256: parseSha256(summary['tfplanSha256'], 'App saved-plan binary SHA-256'),
      semanticChange,
    })
  );
}

/** @param {unknown} value @param {Readonly<Record<string, unknown>>} context @param {Readonly<Record<string, unknown>>} summary */
function admitApproval(value, context, summary) {
  if (context['gate'] === 'verifier-preflight') {
    const approval = exactRecord(
      value,
      ['accountId', 'deploymentEnvironment', 'reviewedPlanChecksum', 'sourceSha'],
      'App verifier-preflight approval evidence',
    );
    const sourceSha = parseGitCommitSha(approval['sourceSha'], 'App verifier-preflight approval source SHA');
    if (
      sourceSha !== context['sourceSha'] ||
      approval['accountId'] !== context['accountId'] ||
      approval['deploymentEnvironment'] !== context['deploymentEnvironment'] ||
      approval['reviewedPlanChecksum'] !== summary['tfplanSha256']
    ) {
      throw new Error('App verifier-preflight approval is detached from its plan evidence.');
    }
    return deepFreeze({ approval: { ...approval, sourceSha }, deploymentMode: /** @type {const} */ ('normal') });
  }
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
    'App Terraform approval evidence',
  );
  const deploymentMode = approval['deploymentMode'];
  if (deploymentMode !== 'normal' && deploymentMode !== 'rollback') {
    throw new Error('App Terraform deployment mode is invalid.');
  }
  const controlSourceSha = parseGitCommitSha(approval['controlSourceSha'], 'App Terraform control source SHA');
  const selectedSourceSha = parseGitCommitSha(approval['selectedSourceSha'], 'App Terraform selected source SHA');
  if (
    controlSourceSha !== context['sourceSha'] ||
    (deploymentMode === 'normal' && selectedSourceSha !== controlSourceSha) ||
    approval['accountId'] !== context['accountId'] ||
    approval['deploymentEnvironment'] !== context['deploymentEnvironment'] ||
    approval['reviewedPlanChecksum'] !== summary['tfplanSha256']
  ) {
    throw new Error('App Terraform approval is detached from its plan evidence.');
  }
  return deepFreeze({
    approval: { ...approval, deploymentMode, controlSourceSha, selectedSourceSha },
    deploymentMode,
  });
}

/** @param {unknown} value @param {string} label */
function positiveFunctionVersion(value, label) {
  const functionVersion = requireString(value, label, /^[1-9][0-9]*$/u);
  if (Buffer.byteLength(functionVersion, 'utf8') > 32 || BigInt(functionVersion) <= 0n) {
    throw new Error(`${label} is invalid.`);
  }
  return functionVersion;
}

/** @param {unknown} value @param {string} label */
function sourceCodeHash(value, label) {
  const encoded = requireString(value, label, /^[A-Za-z0-9+/]{43}=$/u);
  const decoded = Buffer.from(encoded, 'base64');
  if (decoded.byteLength !== 32 || decoded.toString('base64') !== encoded) {
    throw new Error(`${label} is invalid.`);
  }
  return encoded;
}

/** @param {Readonly<Record<string, unknown>>} authority @param {AllowedDeploymentTarget} target */
function admitReleaseFacts(authority, target) {
  return deepFreeze({
    foundationAcceptanceKey: admitTerraformAcceptanceRecordKey(
      FOUNDATION_ACCEPTANCE_KIND,
      authority['foundationAcceptanceKey'],
      target.targetKey,
    ),
    foundationContractHash: parseSha256(authority['foundationContractHash'], 'App Foundation contract SHA-256'),
    proverImageDigest: parseImageDigest(authority['proverImageDigest'], 'App Prover image digest'),
    proverReleaseKey: admitReleaseRecordKey(PROVER_RELEASE_KIND, authority['proverReleaseKey'], target.targetKey),
    toolchainImageDigest: parseImageDigest(authority['toolchainImageDigest'], 'App Toolchain image digest'),
    toolchainReleaseKey: admitReleaseRecordKey(
      TOOLCHAIN_RELEASE_KIND,
      authority['toolchainReleaseKey'],
      target.targetKey,
    ),
    zkvmContractHash: parseSha256(authority['zkvmContractHash'], 'App zkVM contract SHA-256'),
  });
}

/** @param {unknown} value @param {string} sourceSha @param {AllowedDeploymentTarget} target */
function admitPreflightAuthority(value, sourceSha, target) {
  const appAuthority = resolveDeploymentLaneAuthority(target, 'app');
  const authority = exactRecord(value, PREFLIGHT_AUTHORITY_KEYS, 'App verifier-preflight authority');
  const facts = admitReleaseFacts(authority, target);
  const packageSourceSha = parseGitCommitSha(authority['packageSourceSha'], 'App verifier package source SHA');
  if (packageSourceSha !== sourceSha || authority['releaseAuthoritySha256'] !== canonicalJsonSha256(facts)) {
    throw new Error('App verifier-preflight authority is detached from its source or release selection.');
  }
  const packageReference = parseImmutableObjectReference(authority['package']);
  const admittedSourceCodeHash = sourceCodeHash(authority['sourceCodeHash'], 'App verifier source-code hash');
  if (
    packageReference.key !==
      `${appAuthority.names.lambdaArtifactPrefix}/${packageSourceSha}/image-signature-verifier.zip` ||
    Buffer.from(admittedSourceCodeHash, 'base64').toString('hex') !== packageReference.sha256
  ) {
    throw new Error('App verifier package is detached from its source or source-code hash.');
  }
  return deepFreeze({
    ...facts,
    assetManifestSha256: parseSha256(authority['assetManifestSha256'], 'App verifier asset-manifest SHA-256'),
    expectedFunctionVersion: positiveFunctionVersion(
      authority['expectedFunctionVersion'],
      'App verifier expected FunctionVersion',
    ),
    package: packageReference,
    packageSourceSha,
    reconciliationDesiredSha256: parseSha256(
      authority['reconciliationDesiredSha256'],
      'App verifier reconciliation desired SHA-256',
    ),
    releaseAuthoritySha256: authority['releaseAuthoritySha256'],
    sourceCodeHash: admittedSourceCodeHash,
    trustRootSha256: parseSha256(authority['trustRootSha256'], 'App verifier trust-root SHA-256'),
  });
}

/** @param {unknown} value @param {Readonly<Record<string, unknown>>} approval @param {Readonly<Record<string, unknown>>} context @param {AllowedDeploymentTarget} target */
function admitNormalAuthority(value, approval, context, target) {
  const authority = exactRecord(value, NORMAL_AUTHORITY_KEYS, 'App normal Terraform authority');
  const selectedSourceSha = parseGitCommitSha(authority['selectedSourceSha'], 'App selected source SHA');
  const lambdaSourceSha = parseGitCommitSha(authority['lambdaSourceSha'], 'App Lambda source SHA');
  if (
    authority['deploymentMode'] !== 'normal' ||
    selectedSourceSha !== approval['selectedSourceSha'] ||
    lambdaSourceSha !== selectedSourceSha
  ) {
    throw new Error('App normal Terraform authority is detached from its source approval.');
  }
  const methodVersion = positiveSafeInteger(authority['methodVersion'], 'App method identity');
  if (authority['lambdaCount'] !== 6) {
    throw new Error('App normal Terraform authority has an invalid method or Lambda count.');
  }
  const appExecutionAuthoritySha256 = parseSha256(
    authority['appExecutionAuthoritySha256'],
    'App execution authority SHA-256',
  );
  const deploymentIdentity = deriveDeploymentIdentity({
    appExecutionAuthoritySha256,
    appSourceSha: selectedSourceSha,
    deployMode: 'normal',
    pipelineExecutionId: context['pipelineExecutionId'],
  });
  if (authority['deploymentId'] !== deploymentIdentity.deploymentId) {
    throw new Error('App deployment identity is detached from its record and execution.');
  }
  return deepFreeze({
    ...admitReleaseFacts(authority, target),
    appExecutionAuthoritySha256,
    deploymentId: deploymentIdentity.deploymentId,
    deploymentMode: /** @type {const} */ ('normal'),
    expectedImageId: requireString(authority['expectedImageId'], 'App expected ImageID', /^0x[0-9a-f]{64}$/u),
    imageIdMappingSha256: parseSha256(authority['imageIdMappingSha256'], 'App ImageID mapping SHA-256'),
    imageIdVariant: requireString(authority['imageIdVariant'], 'App ImageID variant', /^(?:default|x86_64)$/u),
    lambdaCount: 6,
    lambdaSetSha256: parseSha256(authority['lambdaSetSha256'], 'App Lambda-set SHA-256'),
    lambdaSourceSha,
    methodVersion,
    selectedSourceSha,
    verifierFunctionVersion: positiveFunctionVersion(
      authority['verifierFunctionVersion'],
      'App verifier function version',
    ),
  });
}

/** @param {unknown} value @param {Readonly<Record<string, unknown>>} approval @param {Readonly<Record<string, unknown>>} context @param {AllowedDeploymentTarget} target */
function admitRollbackAuthority(value, approval, context, target) {
  const authority = exactRecord(value, ROLLBACK_AUTHORITY_KEYS, 'App rollback Terraform authority');
  const selectedSourceSha = parseGitCommitSha(authority['selectedSourceSha'], 'App rollback selected source SHA');
  const lambdaSourceSha = parseGitCommitSha(authority['lambdaSourceSha'], 'App rollback Lambda source SHA');
  const appExecutionAuthoritySha256 = parseSha256(
    authority['appExecutionAuthoritySha256'],
    'App rollback execution authority SHA-256',
  );
  const deploymentId = requireString(authority['deploymentId'], 'App rollback deployment ID', /^dep_[0-9a-f]{32}$/u);
  const deploymentIdentity = deriveDeploymentIdentity({
    appExecutionAuthoritySha256,
    appSourceSha: selectedSourceSha,
    deployMode: 'rollback',
    pipelineExecutionId: context['pipelineExecutionId'],
  });
  const methodVersion = positiveSafeInteger(authority['methodVersion'], 'App rollback method identity');
  if (
    authority['deploymentMode'] !== 'rollback' ||
    selectedSourceSha !== approval['selectedSourceSha'] ||
    lambdaSourceSha !== selectedSourceSha ||
    authority['lambdaCount'] !== 6
  ) {
    throw new Error('App rollback Terraform authority is detached from its retained selection or execution.');
  }
  if (deploymentId !== deploymentIdentity.deploymentId) {
    throw new Error('App rollback deployment identity is detached from its execution authority.');
  }
  return deepFreeze({
    appExecutionAuthoritySha256,
    deploymentId,
    deploymentMode: /** @type {const} */ ('rollback'),
    expectedImageId: requireString(authority['expectedImageId'], 'App rollback expected ImageID', /^0x[0-9a-f]{64}$/u),
    imageIdMappingSha256: parseSha256(authority['imageIdMappingSha256'], 'App rollback ImageID mapping SHA-256'),
    imageIdVariant: requireString(authority['imageIdVariant'], 'App rollback ImageID variant', /^(?:default|x86_64)$/u),
    lambdaCount: 6,
    lambdaSetSha256: parseSha256(authority['lambdaSetSha256'], 'App rollback Lambda-set SHA-256'),
    lambdaSourceSha,
    methodVersion,
    proverImageDigest: parseImageDigest(authority['proverImageDigest'], 'App rollback Prover image digest'),
    proverReleaseKey: admitReleaseRecordKey(PROVER_RELEASE_KIND, authority['proverReleaseKey'], target.targetKey),
    selectedAcceptanceKey: admitAppAcceptanceRecordKey(authority['selectedAcceptanceKey'], target.targetKey),
    selectedSourceSha,
    toolchainImageDigest: parseImageDigest(authority['toolchainImageDigest'], 'App rollback Toolchain image digest'),
    toolchainReleaseKey: admitReleaseRecordKey(
      TOOLCHAIN_RELEASE_KIND,
      authority['toolchainReleaseKey'],
      target.targetKey,
    ),
    verifierFunctionVersion: positiveFunctionVersion(
      authority['verifierFunctionVersion'],
      'App rollback verifier function version',
    ),
    zkvmContractHash: parseSha256(authority['zkvmContractHash'], 'App rollback zkVM contract SHA-256'),
  });
}

/** @param {unknown} value */
function admitReleaseComparison(value) {
  const comparison = exactRecord(
    value,
    ['currentAcceptedReleaseChainSha256', 'deploymentMode', 'selectedReleaseChainSha256'],
    'App saved-plan release comparison',
  );
  if (comparison['deploymentMode'] !== 'normal') {
    throw new Error('App saved-plan release comparison mode is invalid.');
  }
  return deepFreeze({
    deploymentMode: /** @type {const} */ ('normal'),
    selectedReleaseChainSha256: parseSha256(
      comparison['selectedReleaseChainSha256'],
      'App selected release-chain SHA-256',
    ),
    currentAcceptedReleaseChainSha256: parseSha256(
      comparison['currentAcceptedReleaseChainSha256'],
      'App accepted release-chain SHA-256',
    ),
  });
}

/**
 * Admit the already-parsed App plan evidence and its mode-specific target
 * authority. Terraform JSON parsing stays with the sole saved-plan parser.
 *
 * @param {unknown} value
 * @param {unknown} expectedTargetKey
 */
export function admitAppSavedPlanAuthority(value, expectedTargetKey) {
  const target = resolveAllowedDeploymentTarget(requireString(expectedTargetKey, 'Saved-plan expected target'));
  rejectProxies(value, 'App saved-plan authority');
  const captured = snapshotDataTree(value, 'App saved-plan authority');
  const input = exactRecord(captured, INPUT_KEYS, 'App saved-plan authority');
  const evidenceInput = exactRecord(input['evidence'], EVIDENCE_KEYS, 'App saved-plan evidence');
  const context = admitSavedPlanReviewContext(evidenceInput['context'], target.targetKey);
  if (context.lane !== 'app') {
    throw new Error('App saved-plan evidence must use the App lane.');
  }
  const summary = admitSummary(evidenceInput['summary']);
  const { approval, deploymentMode } = admitApproval(evidenceInput['approval'], context, summary);
  let authority;
  let disposition;
  let releaseComparison = null;
  if (context.gate === 'verifier-preflight') {
    if (
      deploymentMode !== 'normal' ||
      summary.complete !== false ||
      summary.applyable !== true ||
      summary.semanticChange !== true ||
      input['releaseComparison'] !== null
    ) {
      throw new Error('App verifier-preflight plan disposition is invalid.');
    }
    authority = admitPreflightAuthority(input['authority'], context.sourceSha, target);
    disposition = /** @type {const} */ ('REVIEWABLE');
  } else if (context.gate === 'terraform') {
    if (summary.complete !== true) {
      throw new Error('App Terraform plan must be complete.');
    }
    authority =
      deploymentMode === 'normal'
        ? admitNormalAuthority(input['authority'], approval, context, target)
        : admitRollbackAuthority(input['authority'], approval, context, target);
    if (
      allowsAppEmptyPlanSkip(context.deploymentEnvironment, deploymentMode) &&
      summary.applyable === false &&
      summary.semanticChange === false
    ) {
      if (input['releaseComparison'] === null) {
        throw new Error('App normal no-op requires an exact release comparison.');
      }
      releaseComparison = admitReleaseComparison(input['releaseComparison']);
      disposition =
        releaseComparison.selectedReleaseChainSha256 === releaseComparison.currentAcceptedReleaseChainSha256
          ? /** @type {const} */ ('EMPTY_PLAN_SKIP')
          : /** @type {const} */ ('REVIEWABLE');
    } else {
      if (input['releaseComparison'] !== null) {
        throw new Error('App reviewable plan must not carry release comparison authority.');
      }
      disposition = /** @type {const} */ ('REVIEWABLE');
    }
  } else {
    throw new Error('App saved-plan gate is invalid.');
  }
  return deepFreeze({
    disposition,
    evidence: deepFreeze({ context, summary, approval }),
    authority,
    releaseComparison,
  });
}
