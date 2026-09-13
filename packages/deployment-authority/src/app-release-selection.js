import { isDeepStrictEqual, types } from 'node:util';

import { snapshotDataTree, snapshotExactRecord } from './descriptor-snapshot.js';
import { admitFoundationSourceContract } from './foundation-contract.js';
import { resolveAllowedDeploymentTarget, resolveDeploymentLaneAuthority } from './index.js';
import { deepFreeze, parseGitCommitSha, parseS3VersionId, requireString } from './internal.js';
import { admitFoundationAcceptanceApprovalBinding } from './plan-approval.js';
import {
  PROVER_ACCEPTED_POINTER_KIND,
  PROVER_CANDIDATE_KIND,
  PROVER_RELEASE_KIND,
  TOOLCHAIN_ACCEPTED_POINTER_KIND,
  TOOLCHAIN_CANDIDATE_KIND,
  TOOLCHAIN_RELEASE_KIND,
  admitReleasePointer,
  admitReleaseRecord,
  admitReleaseRecordKey,
  deriveReleaseRecordKey,
} from './release-ledger.js';
import {
  FOUNDATION_ACCEPTANCE_KIND,
  FOUNDATION_CURRENT_ACCEPTANCE_POINTER_KIND,
  admitTerraformAcceptancePointer,
  admitTerraformAcceptanceRecord,
  admitTerraformAcceptanceRecordKey,
  deriveTerraformAcceptanceRecordKey,
  deriveTerraformAcceptancePointerKey,
} from './terraform-acceptance.js';

const INPUT_KEYS = ['foundation', 'prover', 'selectedSourceSha', 'toolchain'];
const PROVER_FOUNDATION_BINDING_KEYS = ['foundationAcceptance', 'prover'];
const FOUNDATION_SELECTION_KEYS = [
  'consumerAuthority',
  'pointer',
  'pointerKey',
  'pointerObservation',
  'record',
  'recordKey',
  'recordObservation',
];
const FOUNDATION_CONSUMER_KEYS = [
  'admissionType',
  'closureIdentity',
  'consumerLane',
  'consumerSourceSha',
  'foundationAcceptanceKey',
  'foundationAcceptedSourceSha',
  'foundationContractHash',
  'networking',
];
const RELEASE_SELECTION_KEYS = [
  'candidateRecord',
  'candidateRecordKey',
  'candidateRecordObservation',
  'pointer',
  'pointerKey',
  'pointerObservation',
  'releaseRecord',
  'releaseRecordKey',
  'releaseRecordObservation',
];
const RAW_RELEASE_SELECTION_KEYS = ['selectionType', ...RELEASE_SELECTION_KEYS];
const OBSERVATION_KEYS = ['etag', 'versionId'];
const MAX_INSPECTED_VALUES = 100_000;
const MAX_INSPECTED_BYTES = 64 * 1024 * 1024;
const MAX_COLLECTION_ENTRIES = 10_000;
const MAX_INSPECTION_DEPTH = 64;
const TOOLCHAIN_CANDIDATE_COPY_FIELDS = [
  'buildApprovalEvidenceId',
  'candidateExecutionId',
  'candidateMetadataSha256',
  'criticalHighCount',
  'imageDigest',
  'imageTag',
  'imageUri',
  'risc0Version',
  'rustToolchainTag',
  'rustVersion',
  'scanStatus',
];
const PROVER_CANDIDATE_COPY_FIELDS = [
  'buildApprovalEvidenceId',
  'candidateExecutionId',
  'candidateMetadataSha256',
  'containerPostureSmokeStatus',
  'criticalHighCount',
  'expectedImageId',
  'failureMarkerContractSha256',
  'failureMarkerSmokeStatus',
  'foundationAcceptance',
  'imageDigest',
  'imageIdVariant',
  'imageTag',
  'imageUri',
  'managedSigningStatus',
  'methodVersion',
  'postPushImageId',
  'postPushMethodVersion',
  'prePushImageId',
  'prePushMethodVersion',
  'scanStatus',
  'selectedToolchainImageDigest',
  'selectedToolchainImageUri',
  'selectedToolchainReleaseKey',
  'zkvmContractHash',
];

/** @typedef {ReturnType<typeof resolveAllowedDeploymentTarget>} AllowedDeploymentTarget */

/** @param {unknown} value @param {readonly string[]} keys @param {string} label */
function exactRecord(value, keys, label) {
  return snapshotExactRecord(value, keys, label);
}

/**
 * Reject proxies before reflective admission can reach their traps. Each
 * collection is width-checked before recursive descent, and every visited
 * value consumes the shared inspection budget.
 *
 * @param {unknown} value
 * @param {string} label
 * @param {{bytes: number; count: number}} [budget]
 * @param {Set<object>} [ancestors]
 * @param {number} [depth]
 */
function assertBoundedNonProxyTree(value, label, budget = { bytes: 0, count: 0 }, ancestors = new Set(), depth = 0) {
  budget.count += 1;
  if (typeof value === 'string') {
    budget.bytes += Buffer.byteLength(value, 'utf8');
  }
  if (budget.count > MAX_INSPECTED_VALUES || budget.bytes > MAX_INSPECTED_BYTES || depth > MAX_INSPECTION_DEPTH) {
    throw new Error(`${label} exceeds its inspection bound.`);
  }
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) {
    return;
  }
  if (types.isProxy(value)) {
    throw new Error(`${label} must not contain a proxy.`);
  }
  if (types.isArrayBufferView(value)) {
    throw new Error(`${label} must not contain a byte view.`);
  }
  if (ancestors.has(value)) {
    throw new Error(`${label} must not contain a cycle.`);
  }
  ancestors.add(value);
  try {
    const isArray = Array.isArray(value);
    if (isArray) {
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
    if (keys.length > MAX_COLLECTION_ENTRIES + (isArray ? 1 : 0)) {
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
        assertBoundedNonProxyTree(descriptor.value, label, budget, ancestors, depth + 1);
      }
    }
  } finally {
    ancestors.delete(value);
  }
}

/** @param {unknown} value @param {string} label */
function admitObservation(value, label) {
  const observation = exactRecord(value, OBSERVATION_KEYS, label);
  const etag = requireString(observation['etag'], `${label} ETag`);
  if (etag.trim() !== etag || /\s/u.test(etag) || Buffer.byteLength(etag, 'utf8') > 1024) {
    throw new Error(`${label} ETag is invalid.`);
  }
  return deepFreeze({
    etag,
    versionId: parseS3VersionId(observation['versionId'], `${label} VersionId`),
  });
}

/**
 * @param {unknown} value
 * @param {Readonly<Record<string, unknown>>} record
 * @param {string} recordKey
 * @param {AllowedDeploymentTarget} target
 */
function admitFoundationConsumer(value, record, recordKey, target) {
  const consumer = exactRecord(value, FOUNDATION_CONSUMER_KEYS, 'App Foundation consumer authority');
  const consumerSourceSha = parseGitCommitSha(
    consumer['consumerSourceSha'],
    'App Foundation consumer selected source SHA',
  );
  const foundationAcceptedSourceSha = parseGitCommitSha(
    consumer['foundationAcceptedSourceSha'],
    'App Foundation consumer accepted source SHA',
  );
  const contract = admitFoundationSourceContract({
    closureIdentity: consumer['closureIdentity'],
    foundationContractHash: consumer['foundationContractHash'],
  });
  const targetContext = /** @type {Readonly<Record<string, unknown>>} */ (record['targetContext']);
  const source = /** @type {Readonly<Record<string, unknown>>} */ (targetContext['source']);
  const recordContract = /** @type {Readonly<Record<string, unknown>>} */ (record['foundationContract']);
  if (
    consumer['admissionType'] !== 'foundation-app-consumer-contract' ||
    consumer['consumerLane'] !== 'app' ||
    admitTerraformAcceptanceRecordKey(
      FOUNDATION_ACCEPTANCE_KIND,
      consumer['foundationAcceptanceKey'],
      target.targetKey,
    ) !== recordKey ||
    foundationAcceptedSourceSha !== source['requestedControlSourceSha'] ||
    contract.closureIdentity !== recordContract['closureIdentity'] ||
    contract.foundationContractHash !== recordContract['foundationContractHash'] ||
    !isDeepStrictEqual(consumer['networking'], record['networking'])
  ) {
    throw new Error('App Foundation consumer authority is detached from the current acceptance.');
  }
  return deepFreeze({
    admissionType: /** @type {const} */ ('foundation-app-consumer-contract'),
    consumerLane: /** @type {const} */ ('app'),
    consumerSourceSha,
    foundationAcceptanceKey: recordKey,
    foundationAcceptedSourceSha,
    closureIdentity: contract.closureIdentity,
    foundationContractHash: contract.foundationContractHash,
    networking: record['networking'],
  });
}

/** @param {unknown} value @param {AllowedDeploymentTarget} target */
function admitFoundationSelection(value, target) {
  const foundationPointerKey = deriveTerraformAcceptancePointerKey(
    FOUNDATION_CURRENT_ACCEPTANCE_POINTER_KIND,
    target.targetKey,
  );
  const selection = exactRecord(value, FOUNDATION_SELECTION_KEYS, 'App Foundation release selection');
  if (selection['pointerKey'] !== foundationPointerKey) {
    throw new Error('App Foundation current pointer key is detached from the reviewed target.');
  }
  const pointer = admitTerraformAcceptancePointer(
    FOUNDATION_CURRENT_ACCEPTANCE_POINTER_KIND,
    selection['pointer'],
    target.targetKey,
  );
  const recordKey = admitTerraformAcceptanceRecordKey(
    FOUNDATION_ACCEPTANCE_KIND,
    selection['recordKey'],
    target.targetKey,
  );
  const record = admitTerraformAcceptanceRecord(FOUNDATION_ACCEPTANCE_KIND, selection['record'], target.targetKey);
  if (
    pointer.recordKey !== recordKey ||
    deriveTerraformAcceptanceRecordKey(FOUNDATION_ACCEPTANCE_KIND, record, target.targetKey) !== recordKey
  ) {
    throw new Error('App Foundation current pointer or acceptance body is detached from its content-addressed key.');
  }
  if (
    pointer.pipelineExecutionId !== record.pipelineExecutionId ||
    pointer.acceptanceAttemptId !== record.acceptanceAttemptId
  ) {
    throw new Error('App Foundation current pointer is detached from its acceptance execution.');
  }
  return deepFreeze({
    consumerAuthority: admitFoundationConsumer(selection['consumerAuthority'], record, recordKey, target),
    pointerKey: foundationPointerKey,
    pointer,
    pointerObservation: admitObservation(selection['pointerObservation'], 'App Foundation pointer observation'),
    recordKey,
    record,
    recordObservation: admitObservation(selection['recordObservation'], 'App Foundation record observation'),
  });
}

/**
 * @param {Readonly<Record<string, unknown>>} release
 * @param {Readonly<Record<string, unknown>>} candidate
 * @param {readonly string[]} fields
 * @param {string} label
 */
function assertCandidateCopy(release, candidate, fields, label) {
  for (const field of fields) {
    if (!isDeepStrictEqual(release[field], candidate[field])) {
      throw new Error(`${label} release ${field} is detached from its selected candidate.`);
    }
  }
  if (
    release['selectionMode'] === 'build' &&
    (release['requestedControlSourceSha'] !== candidate['requestedSourceSha'] ||
      release['sourceActionControlSourceSha'] !== candidate['sourceActionSourceSha'] ||
      release['resolvedControlSourceSha'] !== candidate['resolvedSourceSha'])
  ) {
    throw new Error(`${label} build release source is detached from its selected candidate.`);
  }
}

/**
 * @param {unknown} value
 * @param {Readonly<{
 *   candidateKind: typeof TOOLCHAIN_CANDIDATE_KIND | typeof PROVER_CANDIDATE_KIND;
 *   copyFields: readonly string[];
 *   label: 'Toolchain' | 'Prover';
 *   pointerKey: string;
 *   pointerKind: typeof TOOLCHAIN_ACCEPTED_POINTER_KIND | typeof PROVER_ACCEPTED_POINTER_KIND;
 *   releaseKind: typeof TOOLCHAIN_RELEASE_KIND | typeof PROVER_RELEASE_KIND;
 * }>} authority
 * @param {AllowedDeploymentTarget} target
 */
function admitReleaseSelection(value, authority, target) {
  const selection = exactRecord(value, RELEASE_SELECTION_KEYS, `App ${authority.label} release selection`);
  if (selection['pointerKey'] !== authority.pointerKey) {
    throw new Error(`App ${authority.label} current pointer key is detached from the reviewed target.`);
  }
  const pointer = admitReleasePointer(authority.pointerKind, selection['pointer'], target.targetKey);
  const releaseRecordKey = admitReleaseRecordKey(
    authority.releaseKind,
    selection['releaseRecordKey'],
    target.targetKey,
  );
  const releaseRecord = admitReleaseRecord(authority.releaseKind, selection['releaseRecord'], target.targetKey);
  const candidateRecordKey = admitReleaseRecordKey(
    authority.candidateKind,
    selection['candidateRecordKey'],
    target.targetKey,
  );
  const candidateRecord = admitReleaseRecord(authority.candidateKind, selection['candidateRecord'], target.targetKey);
  const release = /** @type {Readonly<Record<string, unknown>>} */ (releaseRecord);
  const candidate = /** @type {Readonly<Record<string, unknown>>} */ (candidateRecord);
  if (
    pointer.recordKey !== releaseRecordKey ||
    deriveReleaseRecordKey(authority.releaseKind, releaseRecord, target.targetKey) !== releaseRecordKey
  ) {
    throw new Error(
      `App ${authority.label} current pointer or release body is detached from its content-addressed key.`,
    );
  }
  if (pointer.promotionExecutionId !== release['promotionExecutionId']) {
    throw new Error(`App ${authority.label} current pointer is detached from its release promotion.`);
  }
  if (
    release['selectedCandidateKey'] !== candidateRecordKey ||
    deriveReleaseRecordKey(authority.candidateKind, candidateRecord, target.targetKey) !== candidateRecordKey
  ) {
    throw new Error(`App ${authority.label} release is detached from its content-addressed candidate.`);
  }
  assertCandidateCopy(release, candidate, authority.copyFields, authority.label);
  return deepFreeze({
    pointerKey: authority.pointerKey,
    pointer,
    pointerObservation: admitObservation(selection['pointerObservation'], `App ${authority.label} pointer observation`),
    releaseRecordKey,
    releaseRecord,
    releaseRecordObservation: admitObservation(
      selection['releaseRecordObservation'],
      `App ${authority.label} release observation`,
    ),
    candidateRecordKey,
    candidateRecord,
    candidateRecordObservation: admitObservation(
      selection['candidateRecordObservation'],
      `App ${authority.label} candidate observation`,
    ),
  });
}

/**
 * @param {Readonly<Record<string, unknown>>} prover
 * @param {{
 *   readonly foundationAcceptanceKey: string,
 *   readonly foundationAcceptedSourceSha: string,
 *   readonly closureIdentity: string,
 *   readonly foundationContractHash: string,
 * }} foundationAcceptance
 */
function assertProverFoundationAcceptance(prover, foundationAcceptance) {
  const proverCandidate = /** @type {Readonly<Record<string, unknown>>} */ (prover['candidateRecord']);
  const proverRelease = /** @type {Readonly<Record<string, unknown>>} */ (prover['releaseRecord']);
  const proverFoundationAcceptance = /** @type {Readonly<Record<string, unknown>>} */ (
    proverCandidate['foundationAcceptance']
  );
  const promotionFoundationAcceptance = /** @type {Readonly<Record<string, unknown>>} */ (
    proverRelease['promotionFoundationAcceptance']
  );
  const exactCurrentAcceptance = {
    recordKey: foundationAcceptance.foundationAcceptanceKey,
    acceptedSourceSha: foundationAcceptance.foundationAcceptedSourceSha,
    closureIdentity: foundationAcceptance.closureIdentity,
    foundationContractHash: foundationAcceptance.foundationContractHash,
  };
  if (
    !isDeepStrictEqual(promotionFoundationAcceptance, exactCurrentAcceptance) ||
    proverFoundationAcceptance['closureIdentity'] !== exactCurrentAcceptance.closureIdentity ||
    proverFoundationAcceptance['foundationContractHash'] !== exactCurrentAcceptance.foundationContractHash
  ) {
    throw new Error('App Prover Foundation exact current acceptance is detached.');
  }
}

/**
 * Remove the selector-only discriminator after exact admission so the one
 * aggregate App release authority can own the canonical persisted shape.
 *
 * @param {unknown} value
 * @param {'toolchain' | 'prover'} lane
 */
export function projectAppReleaseLedgerSelection(value, lane) {
  if (lane !== 'toolchain' && lane !== 'prover') {
    throw new Error('App release selector lane is invalid.');
  }
  const label = lane === 'toolchain' ? 'Toolchain' : 'Prover';
  const selectionType = lane === 'toolchain' ? 'app-toolchain-ledger-selection' : 'app-prover-ledger-selection';
  assertBoundedNonProxyTree(value, `App ${label} selector output`);
  const raw = exactRecord(
    snapshotDataTree(value, `App ${label} selector output`),
    RAW_RELEASE_SELECTION_KEYS,
    `App ${label} selector output`,
  );
  if (raw['selectionType'] !== selectionType) {
    throw new Error(`App ${label} selector output type is invalid.`);
  }
  return deepFreeze(Object.fromEntries(RELEASE_SELECTION_KEYS.map((key) => [key, raw[key]])));
}

/**
 * Exact-admit one observed Prover release/candidate selection against the raw
 * Foundation authority carried from App's first normal preflight. This narrow
 * seam is used before Terraform planning and by the full aggregate admission.
 *
 * @param {unknown} value
 * @param {unknown} expectedTargetKey
 */
export function admitAppProverFoundationAcceptanceBinding(value, expectedTargetKey) {
  const target = resolveAllowedDeploymentTarget(
    requireString(expectedTargetKey, 'App release selection expected target'),
  );
  const proverAuthority = resolveDeploymentLaneAuthority(target, 'prover');
  assertBoundedNonProxyTree(value, 'App Prover Foundation binding');
  const input = exactRecord(
    snapshotDataTree(value, 'App Prover Foundation binding'),
    PROVER_FOUNDATION_BINDING_KEYS,
    'App Prover Foundation binding',
  );
  const foundationAcceptance = admitFoundationAcceptanceApprovalBinding(
    input['foundationAcceptance'],
    target.targetKey,
  );
  const prover = admitReleaseSelection(
    input['prover'],
    {
      candidateKind: PROVER_CANDIDATE_KIND,
      copyFields: PROVER_CANDIDATE_COPY_FIELDS,
      label: 'Prover',
      pointerKey: proverAuthority.names.proverAcceptedPointerKey,
      pointerKind: PROVER_ACCEPTED_POINTER_KIND,
      releaseKind: PROVER_RELEASE_KIND,
    },
    target,
  );
  assertProverFoundationAcceptance(prover, foundationAcceptance);
  return prover;
}

/**
 * Admit one exact, already-observed normal App release selection. The aggregate
 * owns only cross-record closure; the Foundation and release-ledger modules
 * remain the record and pointer shape authorities.
 *
 * @param {unknown} value
 * @param {unknown} expectedTargetKey
 */
export function admitAppReleaseSelection(value, expectedTargetKey) {
  const target = resolveAllowedDeploymentTarget(
    requireString(expectedTargetKey, 'App release selection expected target'),
  );
  const proverAuthority = resolveDeploymentLaneAuthority(target, 'prover');
  const toolchainAuthority = resolveDeploymentLaneAuthority(target, 'toolchain');
  assertBoundedNonProxyTree(value, 'App release selection');
  const snapshot = snapshotDataTree(value, 'App release selection');
  const input = exactRecord(snapshot, INPUT_KEYS, 'App release selection');
  const selectedSourceSha = parseGitCommitSha(input['selectedSourceSha'], 'App selected source SHA');
  const foundation = admitFoundationSelection(input['foundation'], target);
  if (selectedSourceSha !== foundation.consumerAuthority.consumerSourceSha) {
    throw new Error('App selected source is detached from the Foundation consumer authority.');
  }
  const toolchain = admitReleaseSelection(
    input['toolchain'],
    {
      candidateKind: TOOLCHAIN_CANDIDATE_KIND,
      copyFields: TOOLCHAIN_CANDIDATE_COPY_FIELDS,
      label: 'Toolchain',
      pointerKey: toolchainAuthority.names.toolchainAcceptedPointerKey,
      pointerKind: TOOLCHAIN_ACCEPTED_POINTER_KIND,
      releaseKind: TOOLCHAIN_RELEASE_KIND,
    },
    target,
  );
  const prover = admitReleaseSelection(
    input['prover'],
    {
      candidateKind: PROVER_CANDIDATE_KIND,
      copyFields: PROVER_CANDIDATE_COPY_FIELDS,
      label: 'Prover',
      pointerKey: proverAuthority.names.proverAcceptedPointerKey,
      pointerKind: PROVER_ACCEPTED_POINTER_KIND,
      releaseKind: PROVER_RELEASE_KIND,
    },
    target,
  );
  const toolchainRelease = /** @type {Readonly<Record<string, unknown>>} */ (toolchain.releaseRecord);
  const proverCandidate = /** @type {Readonly<Record<string, unknown>>} */ (prover.candidateRecord);
  if (
    proverCandidate['selectedToolchainReleaseKey'] !== toolchain.releaseRecordKey ||
    proverCandidate['selectedToolchainImageUri'] !== toolchainRelease['imageUri'] ||
    proverCandidate['selectedToolchainImageDigest'] !== toolchainRelease['imageDigest']
  ) {
    throw new Error('App Prover Toolchain authority is detached from the admitted Toolchain release.');
  }
  const foundationRecord = /** @type {Readonly<Record<string, unknown>>} */ (foundation.record);
  const foundationContract = /** @type {Readonly<Record<string, unknown>>} */ (foundationRecord['foundationContract']);
  const proverRelease = /** @type {Readonly<Record<string, unknown>>} */ (prover.releaseRecord);
  assertProverFoundationAcceptance(prover, {
    foundationAcceptanceKey: foundation.recordKey,
    foundationAcceptedSourceSha: foundation.consumerAuthority.foundationAcceptedSourceSha,
    closureIdentity: /** @type {string} */ (foundationContract['closureIdentity']),
    foundationContractHash: /** @type {string} */ (foundationContract['foundationContractHash']),
  });
  return deepFreeze({
    selectedSourceSha,
    foundation,
    toolchain,
    prover,
    selectedReleaseAuthority: {
      foundationAcceptanceKey: foundation.recordKey,
      foundationContractHash: foundationContract['foundationContractHash'],
      proverImageDigest: proverRelease['imageDigest'],
      proverReleaseKey: prover.releaseRecordKey,
      toolchainImageDigest: toolchainRelease['imageDigest'],
      toolchainReleaseKey: toolchain.releaseRecordKey,
      zkvmContractHash: proverRelease['zkvmContractHash'],
    },
  });
}
