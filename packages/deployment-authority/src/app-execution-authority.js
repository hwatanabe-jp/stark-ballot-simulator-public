import { types } from 'node:util';

import {
  admitAppAcceptanceRecordKey,
  admitAppAcceptanceReleaseAuthority,
  admitAppAcceptanceVerifierAuthority,
  bindAppAcceptanceSelection,
} from './app-acceptance-ledger.js';
import { admitAppReleaseSelection } from './app-release-selection.js';
import { snapshotDataTree, snapshotExactRecord } from './descriptor-snapshot.js';
import {
  canonicalJsonSha256,
  deepFreeze,
  parseGitCommitSha,
  parseSha256,
  requireExactKeys,
  requireString,
} from './internal.js';
import { resolveAllowedDeploymentTarget } from './index.js';

/** @typedef {ReturnType<typeof resolveAllowedDeploymentTarget>} AllowedDeploymentTarget */
const AUTHORITY_KEYS = [
  'authorityType',
  'controlSourceSha',
  'deploymentMode',
  'releaseAuthority',
  'selectedAcceptanceKey',
  'selectedApplicationSourceSha',
  'targetKey',
  'verifier',
];
const NORMAL_INPUT_KEYS = ['controlSourceSha', 'releaseSelection', 'selectedApplicationSourceSha', 'verifier'];
const ROLLBACK_INPUT_KEYS = ['acceptanceSelection', 'controlSourceSha'];
const BOUND_SELECTION_KEYS = [
  'acceptance',
  'acceptanceKey',
  'acceptanceObservation',
  'pointer',
  'pointerObservation',
  'selectionType',
  'targetKey',
];
const CONFIRMED_MAPPING_KEYS = [
  'expectedImageId',
  'imageIdMappingSha256',
  'imageIdVariant',
  'methodVersion',
  'proverImageDigest',
  'proverReleaseKey',
  'zkvmContractHash',
];
const MAX_INSPECTED_VALUES = 100_000;
const MAX_INSPECTED_BYTES = 64 * 1024 * 1024;
const MAX_COLLECTION_ENTRIES = 10_000;
const MAX_DEPTH = 64;

/** @typedef {ReturnType<typeof admitAppExecutionAuthority>} AppExecutionAuthority */

/**
 * Reject proxies before descriptor capture can invoke a trap. Accessors are
 * left unread and rejected by snapshotDataTree.
 *
 * @param {unknown} value
 * @param {string} label
 * @param {{bytes: number; count: number}} [budget]
 * @param {Set<object>} [ancestors]
 * @param {number} [depth]
 */
function rejectProxies(value, label, budget = { bytes: 0, count: 0 }, ancestors = new Set(), depth = 0) {
  budget.count += 1;
  if (typeof value === 'string') budget.bytes += Buffer.byteLength(value, 'utf8');
  if (budget.count > MAX_INSPECTED_VALUES || budget.bytes > MAX_INSPECTED_BYTES || depth > MAX_DEPTH) {
    throw new Error(`${label} exceeds its inspection bound.`);
  }
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) return;
  if (types.isProxy(value)) throw new Error(`${label} must not contain a proxy.`);
  if (ancestors.has(value)) throw new Error(`${label} must not contain a cycle.`);
  ancestors.add(value);
  try {
    const isArray = Array.isArray(value);
    if (isArray) {
      const length = Reflect.getOwnPropertyDescriptor(value, 'length')?.value;
      if (
        typeof length !== 'number' ||
        !Number.isSafeInteger(length) ||
        length < 0 ||
        length > MAX_COLLECTION_ENTRIES
      ) {
        throw new Error(`${label} contains an over-bound collection.`);
      }
    }
    const keys = Reflect.ownKeys(value);
    if (keys.length > MAX_COLLECTION_ENTRIES + (isArray ? 1 : 0)) {
      throw new Error(`${label} contains an over-bound collection.`);
    }
    for (const key of keys) {
      if (typeof key === 'string') budget.bytes += Buffer.byteLength(key, 'utf8');
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
function capture(value, keys, label) {
  rejectProxies(value, label);
  const snapshot = snapshotDataTree(value, label);
  try {
    return requireExactKeys(snapshot, keys, label);
  } catch (error) {
    throw new Error(`${label} must use the exact current shape.`, { cause: error });
  }
}

/** @param {unknown} value @param {AllowedDeploymentTarget} target */
function admitBoundSelection(value, target) {
  rejectProxies(value, 'App rollback acceptance selection');
  const selection = snapshotExactRecord(value, BOUND_SELECTION_KEYS, 'App rollback acceptance selection');
  return bindAppAcceptanceSelection(
    {
      pointer: selection['pointer'],
      pointerObservation: selection['pointerObservation'],
      recordKey: selection['acceptanceKey'],
      record: selection['acceptance'],
      recordObservation: selection['acceptanceObservation'],
    },
    target.targetKey,
  );
}

/**
 * Admit the canonical, transport-free authority for one App execution.
 *
 * @param {unknown} value
 * @param {unknown} expectedTargetKey
 */
export function admitAppExecutionAuthority(value, expectedTargetKey) {
  const target = resolveAllowedDeploymentTarget(requireString(expectedTargetKey, 'App execution expected target'));
  const authority = capture(value, AUTHORITY_KEYS, 'App execution authority');
  if (authority['authorityType'] !== 'app-execution-authority' || authority['targetKey'] !== target.targetKey) {
    throw new Error('App execution authority type or target is invalid.');
  }
  const controlSourceSha = parseGitCommitSha(
    authority['controlSourceSha'],
    'App execution authority control source SHA',
  );
  const selectedApplicationSourceSha = parseGitCommitSha(
    authority['selectedApplicationSourceSha'],
    'App execution authority selected application source SHA',
  );
  const deploymentMode = authority['deploymentMode'];
  if (deploymentMode !== 'normal' && deploymentMode !== 'rollback') {
    throw new Error('App execution authority deployment mode is invalid.');
  }
  /** @type {{deploymentMode: 'normal', selectedAcceptanceKey: null} | {deploymentMode: 'rollback', selectedAcceptanceKey: string}} */
  let selection;
  if (deploymentMode === 'normal') {
    if (controlSourceSha !== selectedApplicationSourceSha || authority['selectedAcceptanceKey'] !== null) {
      throw new Error('Normal App execution authority source or acceptance selection is invalid.');
    }
    selection = { deploymentMode, selectedAcceptanceKey: null };
  } else {
    selection = {
      deploymentMode,
      selectedAcceptanceKey: admitAppAcceptanceRecordKey(authority['selectedAcceptanceKey'], target.targetKey),
    };
  }
  const releaseAuthority = admitAppAcceptanceReleaseAuthority(authority['releaseAuthority'], target.targetKey);
  const verifier = admitAppAcceptanceVerifierAuthority(
    authority['verifier'],
    releaseAuthority,
    selectedApplicationSourceSha,
    target.targetKey,
  );
  return deepFreeze({
    authorityType: /** @type {const} */ ('app-execution-authority'),
    targetKey: target.targetKey,
    controlSourceSha,
    selectedApplicationSourceSha,
    ...selection,
    releaseAuthority,
    verifier,
  });
}

/**
 * Project the normal authority only after exact current Foundation, Toolchain,
 * and Prover selection admission.
 *
 * @param {unknown} value
 * @param {unknown} expectedTargetKey
 */
export function projectNormalAppExecutionAuthority(value, expectedTargetKey) {
  const target = resolveAllowedDeploymentTarget(requireString(expectedTargetKey, 'App execution expected target'));
  const input = capture(value, NORMAL_INPUT_KEYS, 'Normal App execution authority input');
  const releaseSelection = admitAppReleaseSelection(input['releaseSelection'], target.targetKey);
  const controlSourceSha = parseGitCommitSha(input['controlSourceSha'], 'Normal App execution control source SHA');
  const selectedApplicationSourceSha = parseGitCommitSha(
    input['selectedApplicationSourceSha'],
    'Normal App execution selected application source SHA',
  );
  if (
    controlSourceSha !== selectedApplicationSourceSha ||
    releaseSelection.selectedSourceSha !== selectedApplicationSourceSha
  ) {
    throw new Error('Normal App execution source is detached from its current release selection.');
  }
  const verifierInput = capture(
    input['verifier'],
    ['confirmedImageIdMapping', 'signaturePreflight'],
    'Normal App execution verifier authority',
  );
  const mapping = capture(
    verifierInput['confirmedImageIdMapping'],
    CONFIRMED_MAPPING_KEYS,
    'Normal App execution confirmed ImageID mapping',
  );
  const toolchainRelease = /** @type {Readonly<Record<string, unknown>>} */ (releaseSelection.toolchain.releaseRecord);
  const proverRelease = /** @type {Readonly<Record<string, unknown>>} */ (releaseSelection.prover.releaseRecord);
  return admitAppExecutionAuthority(
    {
      authorityType: 'app-execution-authority',
      targetKey: target.targetKey,
      controlSourceSha,
      selectedApplicationSourceSha,
      deploymentMode: 'normal',
      selectedAcceptanceKey: null,
      releaseAuthority: {
        foundationAcceptanceKey: releaseSelection.foundation.recordKey,
        foundationContractHash: releaseSelection.foundation.record.foundationContract.foundationContractHash,
        toolchainReleaseKey: releaseSelection.toolchain.releaseRecordKey,
        proverReleaseKey: releaseSelection.prover.releaseRecordKey,
        toolchainImage: { imageUri: toolchainRelease['imageUri'], imageDigest: toolchainRelease['imageDigest'] },
        proverImage: { imageUri: proverRelease['imageUri'], imageDigest: proverRelease['imageDigest'] },
        zkvm: {
          applicationZkvmContractHash: proverRelease['zkvmContractHash'],
          proverZkvmContractHash: proverRelease['zkvmContractHash'],
          zkvmContractHash: proverRelease['zkvmContractHash'],
          expectedImageId: proverRelease['expectedImageId'],
          methodVersion: proverRelease['methodVersion'],
          imageIdVariant: proverRelease['imageIdVariant'],
          imageIdMappingSha256: parseSha256(
            mapping['imageIdMappingSha256'],
            'Normal App execution ImageID mapping SHA-256',
          ),
          failureMarkerContractSha256: proverRelease['failureMarkerContractSha256'],
        },
      },
      verifier: verifierInput,
    },
    target.targetKey,
  );
}

/**
 * Project rollback entirely from one retained App acceptance. This function
 * has no input or callback through which a current release pointer or current
 * Foundation acceptance could be read.
 *
 * @param {unknown} value
 * @param {unknown} expectedTargetKey
 */
export function projectRollbackAppExecutionAuthority(value, expectedTargetKey) {
  const target = resolveAllowedDeploymentTarget(requireString(expectedTargetKey, 'App execution expected target'));
  const input = capture(value, ROLLBACK_INPUT_KEYS, 'Rollback App execution authority input');
  const selection = admitBoundSelection(input['acceptanceSelection'], target);
  if (selection.selectionType !== 'retained') {
    throw new Error('Rollback App execution authority requires a retained acceptance selection.');
  }
  return admitAppExecutionAuthority(
    {
      authorityType: 'app-execution-authority',
      targetKey: target.targetKey,
      controlSourceSha: input['controlSourceSha'],
      selectedApplicationSourceSha: selection.acceptance.selectedApplicationSourceSha,
      deploymentMode: 'rollback',
      selectedAcceptanceKey: selection.acceptanceKey,
      releaseAuthority: selection.acceptance.releaseAuthority,
      verifier: selection.acceptance.verifier,
    },
    target.targetKey,
  );
}

/** @param {unknown} value @param {unknown} expectedTargetKey */
export function deriveAppExecutionAuthoritySha256(value, expectedTargetKey) {
  const target = resolveAllowedDeploymentTarget(requireString(expectedTargetKey, 'App execution expected target'));
  return canonicalJsonSha256(admitAppExecutionAuthority(value, target.targetKey));
}
