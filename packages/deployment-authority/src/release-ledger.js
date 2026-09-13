/** @typedef {import('./index.js').AllowedDeploymentTarget} AllowedDeploymentTarget */
import {
  assertMatchingSourcePins,
  canonicalRecordJson,
  deepFreeze,
  parseDigestPinnedImageReference,
  parseGitCommitSha,
  parseImageDigest,
  parseS3VersionId,
  parseSha256,
  requireExactKeys,
  requireGroupedLowercaseUuid,
  requireRecord,
  requireString,
  sha256Text,
} from './internal.js';
import { createConditionalObjectLedger } from './conditional-object-ledger.js';
import { resolveAllowedDeploymentTarget, resolveDeploymentLaneAuthority } from './index.js';
import { admitFoundationSourceContract } from './foundation-contract.js';
import { FOUNDATION_ACCEPTANCE_KIND, admitTerraformAcceptanceRecordKey } from './terraform-acceptance.js';

export const TOOLCHAIN_CANDIDATE_KIND = /** @type {const} */ ('toolchain-candidate');
export const TOOLCHAIN_RELEASE_KIND = /** @type {const} */ ('toolchain-release');
export const TOOLCHAIN_ACCEPTED_POINTER_KIND = /** @type {const} */ ('toolchain-accepted-pointer');
export const PROVER_CANDIDATE_KIND = /** @type {const} */ ('prover-candidate');
export const PROVER_RELEASE_KIND = /** @type {const} */ ('prover-release');
export const PROVER_ACCEPTED_POINTER_KIND = /** @type {const} */ ('prover-accepted-pointer');

const RECORD_KEY_SUFFIX_PATTERN = /^[0-9a-f]{64}\.json$/u;
const OPERATIONAL_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/+,-]{0,511}$/u;
const CANDIDATE_KEYS = [
  'buildApprovalEvidenceId',
  'candidateExecutionId',
  'candidateMetadataSha256',
  'criticalHighCount',
  'imageDigest',
  'imageTag',
  'imageUri',
  'kind',
  'requestedSourceSha',
  'resolvedSourceSha',
  'risc0Version',
  'rustToolchainTag',
  'rustVersion',
  'scanStatus',
  'sourceActionSourceSha',
  'targetKey',
];

const RELEASE_KEYS = [
  'buildApprovalEvidenceId',
  'candidateSelectionApprovalEvidenceId',
  'candidateExecutionId',
  'candidateMetadataSha256',
  'criticalHighCount',
  'imageDigest',
  'imageTag',
  'imageUri',
  'kind',
  'promotionApprovalEvidenceId',
  'promotionExecutionId',
  'requestedControlSourceSha',
  'resolvedControlSourceSha',
  'risc0Version',
  'rustToolchainTag',
  'rustVersion',
  'scanStatus',
  'selectedCandidateKey',
  'selectionMode',
  'sourceActionControlSourceSha',
  'targetKey',
];

const POINTER_KEYS = ['compareAndSwapEvidenceId', 'kind', 'previous', 'promotionExecutionId', 'recordKey', 'targetKey'];

const CANDIDATE_COPY_FIELDS = [
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

const PROVER_CANDIDATE_KEYS = [
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
  'kind',
  'managedSigningStatus',
  'methodVersion',
  'postPushImageId',
  'postPushMethodVersion',
  'prePushImageId',
  'prePushMethodVersion',
  'requestedSourceSha',
  'resolvedSourceSha',
  'scanStatus',
  'selectedToolchainImageDigest',
  'selectedToolchainImageUri',
  'selectedToolchainReleaseKey',
  'sourceActionSourceSha',
  'targetKey',
  'zkvmContractHash',
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

const PROVER_RELEASE_KEYS = [
  ...PROVER_CANDIDATE_COPY_FIELDS,
  'candidateSelectionApprovalEvidenceId',
  'kind',
  'promotionApprovalEvidenceId',
  'promotionExecutionId',
  'promotionFoundationAcceptance',
  'requestedControlSourceSha',
  'resolvedControlSourceSha',
  'selectedCandidateKey',
  'selectionMode',
  'sourceActionControlSourceSha',
  'targetKey',
];

/**
 * @typedef {typeof TOOLCHAIN_CANDIDATE_KIND | typeof TOOLCHAIN_RELEASE_KIND | typeof PROVER_CANDIDATE_KIND | typeof PROVER_RELEASE_KIND} ReleaseRecordKind
 * @typedef {typeof TOOLCHAIN_ACCEPTED_POINTER_KIND | typeof PROVER_ACCEPTED_POINTER_KIND} ReleasePointerKind
 * @typedef {{ readonly etag: string, readonly versionId: string }} PointerObservation
 * @typedef {{
 *   readonly kind: typeof TOOLCHAIN_CANDIDATE_KIND;
 *   readonly targetKey: import('./index.js').DeploymentTargetKey;
 *   readonly requestedSourceSha: string;
 *   readonly sourceActionSourceSha: string;
 *   readonly resolvedSourceSha: string;
 *   readonly candidateExecutionId: string;
 *   readonly candidateMetadataSha256: string;
 *   readonly imageUri: string;
 *   readonly imageTag: string;
 *   readonly imageDigest: string;
 *   readonly risc0Version: string;
 *   readonly rustVersion: string;
 *   readonly rustToolchainTag: string;
 *   readonly scanStatus: 'PASS' | 'FINDINGS_PRESENT';
 *   readonly criticalHighCount: number;
 *   readonly buildApprovalEvidenceId: string;
 * }} ToolchainCandidateRecord
 * @typedef {{
 *   readonly kind: typeof TOOLCHAIN_RELEASE_KIND;
 *   readonly targetKey: import('./index.js').DeploymentTargetKey;
 *   readonly requestedControlSourceSha: string;
 *   readonly sourceActionControlSourceSha: string;
 *   readonly resolvedControlSourceSha: string;
 *   readonly selectionMode: 'build' | 'existing';
 *   readonly selectedCandidateKey: string;
 *   readonly candidateExecutionId: string;
 *   readonly candidateMetadataSha256: string;
 *   readonly imageUri: string;
 *   readonly imageTag: string;
 *   readonly imageDigest: string;
 *   readonly risc0Version: string;
 *   readonly rustVersion: string;
 *   readonly rustToolchainTag: string;
 *   readonly scanStatus: 'PASS' | 'FINDINGS_PRESENT';
 *   readonly criticalHighCount: number;
 *   readonly buildApprovalEvidenceId: string;
 *   readonly candidateSelectionApprovalEvidenceId: string;
 *   readonly promotionExecutionId: string;
 *   readonly promotionApprovalEvidenceId: string;
 * }} ToolchainReleaseRecord
 * @typedef {{
 *   readonly recordKey: string;
 *   readonly acceptedSourceSha: string;
 *   readonly closureIdentity: string;
 *   readonly foundationContractHash: string;
 * }} FoundationAcceptance
 * @typedef {{
 *   readonly kind: typeof PROVER_CANDIDATE_KIND;
 *   readonly targetKey: import('./index.js').DeploymentTargetKey;
 *   readonly requestedSourceSha: string;
 *   readonly sourceActionSourceSha: string;
 *   readonly resolvedSourceSha: string;
 *   readonly candidateExecutionId: string;
 *   readonly candidateMetadataSha256: string;
 *   readonly selectedToolchainReleaseKey: string;
 *   readonly selectedToolchainImageUri: string;
 *   readonly selectedToolchainImageDigest: string;
 *   readonly foundationAcceptance: FoundationAcceptance;
 *   readonly imageUri: string;
 *   readonly imageTag: string;
 *   readonly imageDigest: string;
 *   readonly expectedImageId: string;
 *   readonly prePushImageId: string;
 *   readonly postPushImageId: string;
 *   readonly methodVersion: number;
 *   readonly prePushMethodVersion: number;
 *   readonly postPushMethodVersion: number;
 *   readonly imageIdVariant: 'default';
 *   readonly zkvmContractHash: string;
 *   readonly scanStatus: 'PASS';
 *   readonly criticalHighCount: 0;
 *   readonly containerPostureSmokeStatus: 'PASS';
 *   readonly failureMarkerContractSha256: string;
 *   readonly failureMarkerSmokeStatus: 'PASS';
 *   readonly managedSigningStatus: 'COMPLETE';
 *   readonly buildApprovalEvidenceId: string;
 * }} ProverCandidateRecord
 * @typedef {{
 *   readonly kind: typeof PROVER_RELEASE_KIND;
 *   readonly targetKey: import('./index.js').DeploymentTargetKey;
 *   readonly requestedControlSourceSha: string;
 *   readonly sourceActionControlSourceSha: string;
 *   readonly resolvedControlSourceSha: string;
 *   readonly selectionMode: 'build' | 'existing';
 *   readonly selectedCandidateKey: string;
 *   readonly candidateExecutionId: string;
 *   readonly candidateMetadataSha256: string;
 *   readonly selectedToolchainReleaseKey: string;
 *   readonly selectedToolchainImageUri: string;
 *   readonly selectedToolchainImageDigest: string;
 *   readonly foundationAcceptance: FoundationAcceptance;
 *   readonly promotionFoundationAcceptance: FoundationAcceptance;
 *   readonly imageUri: string;
 *   readonly imageTag: string;
 *   readonly imageDigest: string;
 *   readonly expectedImageId: string;
 *   readonly prePushImageId: string;
 *   readonly postPushImageId: string;
 *   readonly methodVersion: number;
 *   readonly prePushMethodVersion: number;
 *   readonly postPushMethodVersion: number;
 *   readonly imageIdVariant: 'default';
 *   readonly zkvmContractHash: string;
 *   readonly scanStatus: 'PASS';
 *   readonly criticalHighCount: 0;
 *   readonly containerPostureSmokeStatus: 'PASS';
 *   readonly failureMarkerContractSha256: string;
 *   readonly failureMarkerSmokeStatus: 'PASS';
 *   readonly managedSigningStatus: 'COMPLETE';
 *   readonly buildApprovalEvidenceId: string;
 *   readonly candidateSelectionApprovalEvidenceId: string;
 *   readonly promotionExecutionId: string;
 *   readonly promotionApprovalEvidenceId: string;
 * }} ProverReleaseRecord
 * @typedef {ToolchainCandidateRecord | ToolchainReleaseRecord | ProverCandidateRecord | ProverReleaseRecord} ReleaseRecord
 * @typedef {{
 *   readonly kind: typeof TOOLCHAIN_ACCEPTED_POINTER_KIND;
 *   readonly targetKey: import('./index.js').DeploymentTargetKey;
 *   readonly recordKey: string;
 *   readonly promotionExecutionId: string;
 *   readonly previous: PointerObservation | null;
 *   readonly compareAndSwapEvidenceId: string;
 * }} ToolchainAcceptedPointer
 * @typedef {{
 *   readonly kind: typeof PROVER_ACCEPTED_POINTER_KIND;
 *   readonly targetKey: import('./index.js').DeploymentTargetKey;
 *   readonly recordKey: string;
 *   readonly promotionExecutionId: string;
 *   readonly previous: PointerObservation | null;
 *   readonly compareAndSwapEvidenceId: string;
 * }} ProverAcceptedPointer
 * @typedef {ToolchainAcceptedPointer | ProverAcceptedPointer} ReleasePointer
 * @typedef {{readonly key: string} & (
 *   {readonly kind: typeof TOOLCHAIN_CANDIDATE_KIND, readonly record: ToolchainCandidateRecord}
 *   | {readonly kind: typeof TOOLCHAIN_RELEASE_KIND, readonly record: ToolchainReleaseRecord}
 *   | {readonly kind: typeof PROVER_CANDIDATE_KIND, readonly record: ProverCandidateRecord}
 *   | {readonly kind: typeof PROVER_RELEASE_KIND, readonly record: ProverReleaseRecord}
 * )} ReleaseRecordSelection
 * @typedef {ReleaseRecordSelection & {readonly recordObservation: PointerObservation}} ReleaseRecordRead
 * @typedef {ReleaseRecordRead & {readonly status: 'created' | 'idempotent-retry'}} ReleaseRecordPublication
 * @typedef {{
 *   readonly pointerKey: string;
 *   readonly pointerObservation: PointerObservation;
 *   readonly recordKey: string;
 *   readonly recordObservation: PointerObservation;
 * } & (
 *   {readonly recordKind: typeof TOOLCHAIN_RELEASE_KIND, readonly pointer: ToolchainAcceptedPointer, readonly record: ToolchainReleaseRecord}
 *   | {readonly recordKind: typeof PROVER_RELEASE_KIND, readonly pointer: ProverAcceptedPointer, readonly record: ProverReleaseRecord}
 * )} ResolvedReleasePointer
 * @typedef {{
 *   readonly pointerKey: string;
 *   readonly pointer: ReleasePointer;
 *   readonly pointerObservation: PointerObservation;
 * }} ObservedReleasePointer
 * @typedef {{
 *   readonly status: 'moved' | 'idempotent-retry';
 *   readonly pointerKey: string;
 *   readonly pointer: ReleasePointer;
 *   readonly pointerObservation: PointerObservation;
 *   readonly recordKey: string;
 *   readonly record: ToolchainReleaseRecord | ProverReleaseRecord;
 * } | {
 *   readonly status: 'conflict';
 *   readonly pointerKey: string;
 *   readonly expected: PointerObservation | null;
 *   readonly observed: null | Readonly<{
 *     pointer: ReleasePointer;
 *     pointerObservation: PointerObservation;
 *   }>;
 * }} MoveReleasePointerResult
 * @typedef {{
 *   readonly kind: ReleasePointerKind;
 *   readonly pointerKey: string;
 *   readonly releaseKind: typeof TOOLCHAIN_RELEASE_KIND | typeof PROVER_RELEASE_KIND;
 *   readonly label: 'Toolchain' | 'Prover';
 *   readonly casDomain: 'toolchain' | 'prover';
 * }} ReleasePointerDescriptor
 * @typedef {{
 *   getObject(input: { readonly key: string, readonly maxBytes: number }): unknown;
 *   putObject(input: { readonly key: string, readonly body: string, readonly condition: { readonly type: 'if-none-match' } | { readonly type: 'if-match', readonly etag: string, readonly versionId: string } }): unknown;
 * }} ReleaseLedgerTransport
 */

/**
 * @param {unknown} value
 * @param {string} label
 * @returns {string}
 */
function requireOperationalIdentifier(value, label) {
  return requireString(value, label, OPERATIONAL_IDENTIFIER_PATTERN);
}

/**
 * @param {unknown} value
 * @param {string} label
 * @returns {string}
 */
function requireOpaqueEtag(value, label) {
  const etag = requireString(value, label);
  if (etag.trim() !== etag || /\s/u.test(etag) || Buffer.byteLength(etag, 'utf8') > 1024) {
    throw new Error(`${label} is invalid`);
  }
  return etag;
}

/**
 * @param {unknown} value
 * @param {string} label
 * @returns {'PASS' | 'FINDINGS_PRESENT'}
 */
function parseScanStatus(value, label) {
  if (value !== 'PASS' && value !== 'FINDINGS_PRESENT') {
    throw new Error(`${label} must be PASS or FINDINGS_PRESENT`);
  }
  return value;
}

/**
 * @param {unknown} value
 * @param {'PASS' | 'FINDINGS_PRESENT'} scanStatus
 * @param {string} label
 * @returns {number}
 */
function parseCriticalHighCount(value, scanStatus, label) {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    (scanStatus === 'PASS' && value !== 0) ||
    (scanStatus === 'FINDINGS_PRESENT' && value === 0)
  ) {
    throw new Error(`${label} is inconsistent with scan status`);
  }
  return value;
}

/**
 * @param {Record<string, unknown>} record
 * @param {string} label
 * @param {AllowedDeploymentTarget} target
 * @returns {{
 *   readonly imageDigest: string;
 *   readonly imageTag: string;
 *   readonly imageUri: string;
 *   readonly risc0Version: string;
 *   readonly rustToolchainTag: string;
 *   readonly rustVersion: string;
 *   readonly scanStatus: 'PASS' | 'FINDINGS_PRESENT';
 *   readonly criticalHighCount: number;
 * }}
 */
function parseToolchainImageAndScan(record, label, target) {
  const image = parseDigestPinnedImageReference(record['imageUri'], {
    partition: target.partition,
    accountId: target.accountId,
    region: target.region,
    repository: resolveDeploymentLaneAuthority(target, 'toolchain').names.toolchainRepository,
  });
  const imageDigest = parseImageDigest(record['imageDigest'], `${label} image digest`);
  if (image.digest !== imageDigest) {
    throw new Error(`${label} image digest is detached from its image URI`);
  }
  const scanStatus = parseScanStatus(record['scanStatus'], `${label} scan status`);
  return deepFreeze({
    imageUri: image.imageUri,
    imageTag: requireOperationalIdentifier(record['imageTag'], `${label} image tag`),
    imageDigest,
    risc0Version: requireOperationalIdentifier(record['risc0Version'], `${label} RISC Zero version`),
    rustVersion: requireOperationalIdentifier(record['rustVersion'], `${label} Rust version`),
    rustToolchainTag: requireOperationalIdentifier(record['rustToolchainTag'], `${label} Rust toolchain tag`),
    scanStatus,
    criticalHighCount: parseCriticalHighCount(record['criticalHighCount'], scanStatus, `${label} HIGH/CRITICAL count`),
  });
}

/**
 * @param {unknown} value
 * @param {string} label
 * @param {AllowedDeploymentTarget} target
 * @returns {FoundationAcceptance}
 */
function parseFoundationAcceptance(value, label, target) {
  const authority = requireExactKeys(
    value,
    ['acceptedSourceSha', 'closureIdentity', 'foundationContractHash', 'recordKey'],
    label,
  );
  const contract = admitFoundationSourceContract({
    closureIdentity: authority['closureIdentity'],
    foundationContractHash: authority['foundationContractHash'],
  });
  return deepFreeze({
    recordKey: admitTerraformAcceptanceRecordKey(FOUNDATION_ACCEPTANCE_KIND, authority['recordKey'], target.targetKey),
    acceptedSourceSha: parseGitCommitSha(authority['acceptedSourceSha'], `${label} accepted source SHA`),
    closureIdentity: contract.closureIdentity,
    foundationContractHash: contract.foundationContractHash,
  });
}

/**
 * @param {unknown} value
 * @param {string} label
 * @returns {number}
 */
function parseMethodVersion(value, label) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return value;
}

/**
 * @param {Record<string, unknown>} record
 * @param {string} label
 * @param {AllowedDeploymentTarget} target
 */
function parseProverTrustFields(record, label, target) {
  const selectedToolchainReleaseKey = parseReleaseRecordKey(
    record['selectedToolchainReleaseKey'],
    TOOLCHAIN_RELEASE_KIND,
    `${label} selected Toolchain release key`,
    target,
  );
  const selectedToolchainImage = parseDigestPinnedImageReference(record['selectedToolchainImageUri'], {
    partition: target.partition,
    accountId: target.accountId,
    region: target.region,
    repository: resolveDeploymentLaneAuthority(target, 'toolchain').names.toolchainRepository,
  });
  const selectedToolchainImageDigest = parseImageDigest(
    record['selectedToolchainImageDigest'],
    `${label} selected Toolchain image digest`,
  );
  if (selectedToolchainImage.digest !== selectedToolchainImageDigest) {
    throw new Error(`${label} selected Toolchain image digest is detached from its image URI`);
  }
  const proverImage = parseDigestPinnedImageReference(record['imageUri'], {
    partition: target.partition,
    accountId: target.accountId,
    region: target.region,
    repository: resolveDeploymentLaneAuthority(target, 'prover').names.proverRepository,
  });
  const imageDigest = parseImageDigest(record['imageDigest'], `${label} image digest`);
  if (proverImage.digest !== imageDigest) {
    throw new Error(`${label} image digest is detached from its image URI`);
  }
  const expectedImageId = requireString(record['expectedImageId'], `${label} expected ImageID`, /^0x[0-9a-f]{64}$/u);
  const prePushImageId = requireString(record['prePushImageId'], `${label} pre-push ImageID`, /^0x[0-9a-f]{64}$/u);
  const postPushImageId = requireString(record['postPushImageId'], `${label} post-push ImageID`, /^0x[0-9a-f]{64}$/u);
  if (prePushImageId !== expectedImageId || postPushImageId !== expectedImageId) {
    throw new Error(`${label} pre-push and post-push ImageIDs must match the expected ImageID`);
  }
  const methodVersion = parseMethodVersion(record['methodVersion'], `${label} method version`);
  const prePushMethodVersion = parseMethodVersion(record['prePushMethodVersion'], `${label} pre-push method version`);
  const postPushMethodVersion = parseMethodVersion(
    record['postPushMethodVersion'],
    `${label} post-push method version`,
  );
  if (prePushMethodVersion !== methodVersion || postPushMethodVersion !== methodVersion) {
    throw new Error(`${label} pre-push and post-push method versions must match the selected method version`);
  }
  if (
    record['imageIdVariant'] !== 'default' ||
    record['scanStatus'] !== 'PASS' ||
    record['criticalHighCount'] !== 0 ||
    record['containerPostureSmokeStatus'] !== 'PASS' ||
    record['failureMarkerSmokeStatus'] !== 'PASS' ||
    record['managedSigningStatus'] !== 'COMPLETE'
  ) {
    throw new Error(`${label} scan, signing, image variant, or smoke status is invalid`);
  }
  return deepFreeze({
    selectedToolchainReleaseKey,
    selectedToolchainImageUri: selectedToolchainImage.imageUri,
    selectedToolchainImageDigest,
    imageUri: proverImage.imageUri,
    imageTag: requireOperationalIdentifier(record['imageTag'], `${label} image tag`),
    imageDigest,
    expectedImageId,
    prePushImageId,
    postPushImageId,
    methodVersion,
    prePushMethodVersion,
    postPushMethodVersion,
    imageIdVariant: /** @type {const} */ ('default'),
    zkvmContractHash: parseSha256(record['zkvmContractHash'], `${label} zkVM contract SHA-256`),
    scanStatus: /** @type {const} */ ('PASS'),
    criticalHighCount: /** @type {const} */ (0),
    containerPostureSmokeStatus: /** @type {const} */ ('PASS'),
    failureMarkerContractSha256: parseSha256(
      record['failureMarkerContractSha256'],
      `${label} failure-marker contract SHA-256`,
    ),
    failureMarkerSmokeStatus: /** @type {const} */ ('PASS'),
    managedSigningStatus: /** @type {const} */ ('COMPLETE'),
  });
}

/**
 * @param {unknown} value
 * @param {AllowedDeploymentTarget} target
 * @returns {ProverCandidateRecord}
 */
function admitProverCandidate(value, target) {
  const record = requireExactKeys(value, PROVER_CANDIDATE_KEYS, 'Prover candidate record');
  if (record['kind'] !== PROVER_CANDIDATE_KIND) {
    throw new Error('Prover candidate record kind is invalid');
  }
  if (record['targetKey'] !== target.targetKey) {
    throw new Error('Prover candidate target is invalid');
  }
  assertMatchingSourcePins({
    requestedSourceSha: record['requestedSourceSha'],
    sourceActionSourceSha: record['sourceActionSourceSha'],
    resolvedSourceSha: record['resolvedSourceSha'],
  });
  const requestedSourceSha = parseGitCommitSha(record['requestedSourceSha'], 'Prover candidate requested source SHA');
  const candidateExecutionSuffix = requireGroupedLowercaseUuid(
    typeof record['candidateExecutionId'] === 'string' && record['candidateExecutionId'].startsWith('prover-candidate/')
      ? record['candidateExecutionId'].slice('prover-candidate/'.length)
      : undefined,
    'Prover candidate execution ID',
  );
  const candidateExecutionId = `prover-candidate/${candidateExecutionSuffix}`;
  const buildApprovalEvidenceId = requireOperationalIdentifier(
    record['buildApprovalEvidenceId'],
    'Prover candidate build approval evidence ID',
  );
  if (buildApprovalEvidenceId !== `prover-build/${candidateExecutionSuffix}`) {
    throw new Error('Prover candidate build approval is detached from its candidate execution');
  }
  return deepFreeze({
    kind: PROVER_CANDIDATE_KIND,
    targetKey: target.targetKey,
    requestedSourceSha,
    sourceActionSourceSha: requestedSourceSha,
    resolvedSourceSha: requestedSourceSha,
    candidateExecutionId,
    candidateMetadataSha256: parseSha256(record['candidateMetadataSha256'], 'Prover candidate metadata SHA-256'),
    ...parseProverTrustFields(record, 'Prover candidate', target),
    foundationAcceptance: parseFoundationAcceptance(
      record['foundationAcceptance'],
      'Prover candidate Foundation acceptance',
      target,
    ),
    buildApprovalEvidenceId,
  });
}

/**
 * @param {unknown} value
 * @param {AllowedDeploymentTarget} target
 * @returns {ToolchainCandidateRecord}
 */
function admitToolchainCandidate(value, target) {
  const record = requireExactKeys(value, CANDIDATE_KEYS, 'Toolchain candidate record');
  if (record['kind'] !== TOOLCHAIN_CANDIDATE_KIND) {
    throw new Error('Toolchain candidate record kind is invalid');
  }
  if (record['targetKey'] !== target.targetKey) {
    throw new Error('Toolchain candidate target is invalid');
  }
  assertMatchingSourcePins({
    requestedSourceSha: record['requestedSourceSha'],
    sourceActionSourceSha: record['sourceActionSourceSha'],
    resolvedSourceSha: record['resolvedSourceSha'],
  });
  const requestedSourceSha = parseGitCommitSha(
    record['requestedSourceSha'],
    'Toolchain candidate requested source SHA',
  );
  const candidateExecutionSuffix = requireGroupedLowercaseUuid(
    typeof record['candidateExecutionId'] === 'string' &&
      record['candidateExecutionId'].startsWith('toolchain-candidate/')
      ? record['candidateExecutionId'].slice('toolchain-candidate/'.length)
      : undefined,
    'Toolchain candidate execution ID',
  );
  const candidateExecutionId = `toolchain-candidate/${candidateExecutionSuffix}`;
  const buildApprovalEvidenceId = requireOperationalIdentifier(
    record['buildApprovalEvidenceId'],
    'Toolchain candidate build approval evidence ID',
  );
  if (buildApprovalEvidenceId !== `toolchain-build/${candidateExecutionSuffix}`) {
    throw new Error('Toolchain candidate build approval is detached from its candidate execution');
  }
  const imageAndScan = parseToolchainImageAndScan(record, 'Toolchain candidate', target);
  return deepFreeze({
    kind: TOOLCHAIN_CANDIDATE_KIND,
    targetKey: target.targetKey,
    requestedSourceSha,
    sourceActionSourceSha: requestedSourceSha,
    resolvedSourceSha: requestedSourceSha,
    candidateExecutionId,
    candidateMetadataSha256: parseSha256(record['candidateMetadataSha256'], 'Toolchain candidate metadata SHA-256'),
    ...imageAndScan,
    buildApprovalEvidenceId,
  });
}

/**
 * @param {unknown} key
 * @param {ReleaseRecordKind} expectedKind
 * @param {string} label
 * @param {AllowedDeploymentTarget} target
 * @returns {string}
 */
function parseReleaseRecordKey(key, expectedKind, label, target) {
  const admittedKey = requireString(key, label);
  const prefix = releaseRecordPrefix(expectedKind, target);
  const suffix = admittedKey.startsWith(prefix) ? admittedKey.slice(prefix.length) : '';
  if (!RECORD_KEY_SUFFIX_PATTERN.test(suffix)) {
    throw new Error(`${label} is outside the ${expectedKind} namespace`);
  }
  return admittedKey;
}

/**
 * @param {ReleaseRecordKind} kind
 * @param {AllowedDeploymentTarget} target
 * @returns {string}
 */
function releaseRecordPrefix(kind, target) {
  switch (kind) {
    case TOOLCHAIN_CANDIDATE_KIND:
      return `${resolveDeploymentLaneAuthority(target, 'toolchain').names.toolchainArtifactPrefix}/candidates/`;
    case TOOLCHAIN_RELEASE_KIND:
      return `${resolveDeploymentLaneAuthority(target, 'toolchain').names.toolchainArtifactPrefix}/releases/`;
    case PROVER_CANDIDATE_KIND:
      return `${resolveDeploymentLaneAuthority(target, 'prover').names.proverReleasePrefix}/candidates/`;
    case PROVER_RELEASE_KIND:
      return `${resolveDeploymentLaneAuthority(target, 'prover').names.proverReleasePrefix}/releases/`;
  }
}

/**
 * Admit one immutable record key from the closed release-ledger registry.
 *
 * @param {ReleaseRecordKind} kind
 * @param {unknown} key
 * @param {unknown} expectedTargetKey
 * @returns {string}
 */
export function admitReleaseRecordKey(kind, key, expectedTargetKey) {
  const target = resolveAllowedDeploymentTarget(requireString(expectedTargetKey, 'release ledger expected target'));
  if (
    kind !== TOOLCHAIN_CANDIDATE_KIND &&
    kind !== TOOLCHAIN_RELEASE_KIND &&
    kind !== PROVER_CANDIDATE_KIND &&
    kind !== PROVER_RELEASE_KIND
  ) {
    throw new Error('release record kind is not registered');
  }
  return parseReleaseRecordKey(key, kind, 'release ledger record key', target);
}

/**
 * Return the content digest encoded by one admitted immutable record key.
 *
 * @param {ReleaseRecordKind} kind
 * @param {unknown} key
 * @param {unknown} expectedTargetKey
 * @returns {string}
 */
export function releaseRecordKeySha256(kind, key, expectedTargetKey) {
  const target = resolveAllowedDeploymentTarget(requireString(expectedTargetKey, 'release ledger expected target'));
  const admittedKey = admitReleaseRecordKey(kind, key, target.targetKey);
  const prefix = releaseRecordPrefix(kind, target);
  return parseSha256(admittedKey.slice(prefix.length, -'.json'.length), 'release ledger record key SHA-256');
}

/**
 * @param {unknown} value
 * @param {AllowedDeploymentTarget} target
 * @returns {ToolchainReleaseRecord}
 */
function admitToolchainRelease(value, target) {
  const record = requireExactKeys(value, RELEASE_KEYS, 'Toolchain release record');
  if (record['kind'] !== TOOLCHAIN_RELEASE_KIND) {
    throw new Error('Toolchain release record kind is invalid');
  }
  if (record['targetKey'] !== target.targetKey) {
    throw new Error('Toolchain release target is invalid');
  }
  assertMatchingSourcePins({
    requestedSourceSha: record['requestedControlSourceSha'],
    sourceActionSourceSha: record['sourceActionControlSourceSha'],
    resolvedSourceSha: record['resolvedControlSourceSha'],
  });
  const requestedControlSourceSha = parseGitCommitSha(
    record['requestedControlSourceSha'],
    'Toolchain release requested control source SHA',
  );
  const selectionMode = record['selectionMode'];
  if (selectionMode !== 'build' && selectionMode !== 'existing') {
    throw new Error('Toolchain release selection mode must be build or existing');
  }
  const candidateExecutionSuffix = requireGroupedLowercaseUuid(
    typeof record['candidateExecutionId'] === 'string' &&
      record['candidateExecutionId'].startsWith('toolchain-candidate/')
      ? record['candidateExecutionId'].slice('toolchain-candidate/'.length)
      : undefined,
    'Toolchain release candidate execution ID',
  );
  const candidateExecutionId = `toolchain-candidate/${candidateExecutionSuffix}`;
  const buildApprovalEvidenceId = requireOperationalIdentifier(
    record['buildApprovalEvidenceId'],
    'Toolchain release build approval evidence ID',
  );
  if (buildApprovalEvidenceId !== `toolchain-build/${candidateExecutionSuffix}`) {
    throw new Error('Toolchain release build approval is detached from its candidate execution');
  }
  const promotionExecutionId = requireGroupedLowercaseUuid(
    record['promotionExecutionId'],
    'Toolchain release promotion execution ID',
  );
  const candidateSelectionApprovalEvidenceId = requireOperationalIdentifier(
    record['candidateSelectionApprovalEvidenceId'],
    'Toolchain release candidate-selection approval evidence ID',
  );
  if (candidateSelectionApprovalEvidenceId !== `toolchain-candidate-selection/${promotionExecutionId}`) {
    throw new Error('Toolchain release candidate-selection approval is detached from its promotion execution');
  }
  const promotionApprovalEvidenceId = requireOperationalIdentifier(
    record['promotionApprovalEvidenceId'],
    'Toolchain release promotion approval evidence ID',
  );
  if (promotionApprovalEvidenceId !== `toolchain-promotion/${promotionExecutionId}`) {
    throw new Error('Toolchain release promotion approval is detached from its promotion execution');
  }
  const imageAndScan = parseToolchainImageAndScan(record, 'Toolchain release', target);
  return deepFreeze({
    kind: TOOLCHAIN_RELEASE_KIND,
    targetKey: target.targetKey,
    requestedControlSourceSha,
    sourceActionControlSourceSha: requestedControlSourceSha,
    resolvedControlSourceSha: requestedControlSourceSha,
    selectionMode,
    selectedCandidateKey: parseReleaseRecordKey(
      record['selectedCandidateKey'],
      TOOLCHAIN_CANDIDATE_KIND,
      'Toolchain release selected candidate key',
      target,
    ),
    candidateExecutionId,
    candidateMetadataSha256: parseSha256(
      record['candidateMetadataSha256'],
      'Toolchain release candidate metadata SHA-256',
    ),
    ...imageAndScan,
    buildApprovalEvidenceId,
    candidateSelectionApprovalEvidenceId,
    promotionExecutionId,
    promotionApprovalEvidenceId,
  });
}

/**
 * @param {unknown} value
 * @param {AllowedDeploymentTarget} target
 * @returns {ProverReleaseRecord}
 */
function admitProverRelease(value, target) {
  const record = requireExactKeys(value, PROVER_RELEASE_KEYS, 'Prover release record');
  if (record['kind'] !== PROVER_RELEASE_KIND) {
    throw new Error('Prover release record kind is invalid');
  }
  if (record['targetKey'] !== target.targetKey) {
    throw new Error('Prover release target is invalid');
  }
  assertMatchingSourcePins({
    requestedSourceSha: record['requestedControlSourceSha'],
    sourceActionSourceSha: record['sourceActionControlSourceSha'],
    resolvedSourceSha: record['resolvedControlSourceSha'],
  });
  const requestedControlSourceSha = parseGitCommitSha(
    record['requestedControlSourceSha'],
    'Prover release requested control source SHA',
  );
  const selectionMode = record['selectionMode'];
  if (selectionMode !== 'build' && selectionMode !== 'existing') {
    throw new Error('Prover release selection mode must be build or existing');
  }
  const candidateExecutionSuffix = requireGroupedLowercaseUuid(
    typeof record['candidateExecutionId'] === 'string' && record['candidateExecutionId'].startsWith('prover-candidate/')
      ? record['candidateExecutionId'].slice('prover-candidate/'.length)
      : undefined,
    'Prover release candidate execution ID',
  );
  const candidateExecutionId = `prover-candidate/${candidateExecutionSuffix}`;
  const buildApprovalEvidenceId = requireOperationalIdentifier(
    record['buildApprovalEvidenceId'],
    'Prover release build approval evidence ID',
  );
  if (buildApprovalEvidenceId !== `prover-build/${candidateExecutionSuffix}`) {
    throw new Error('Prover release build approval is detached from its candidate execution');
  }
  const promotionExecutionId = requireGroupedLowercaseUuid(
    record['promotionExecutionId'],
    'Prover release promotion execution ID',
  );
  const candidateSelectionApprovalEvidenceId = requireOperationalIdentifier(
    record['candidateSelectionApprovalEvidenceId'],
    'Prover release candidate-selection approval evidence ID',
  );
  if (
    (selectionMode === 'build' &&
      (promotionExecutionId !== candidateExecutionSuffix ||
        candidateSelectionApprovalEvidenceId !== buildApprovalEvidenceId)) ||
    (selectionMode === 'existing' &&
      candidateSelectionApprovalEvidenceId !== `prover-candidate-selection/${promotionExecutionId}`)
  ) {
    throw new Error(
      selectionMode === 'build'
        ? 'Prover build release candidate selection is detached from its build approval'
        : 'Prover release candidate-selection approval is detached from its promotion execution',
    );
  }
  const promotionApprovalEvidenceId = requireOperationalIdentifier(
    record['promotionApprovalEvidenceId'],
    'Prover release promotion approval evidence ID',
  );
  if (promotionApprovalEvidenceId !== `prover-promotion/${promotionExecutionId}`) {
    throw new Error('Prover release promotion approval is detached from its promotion execution');
  }
  const foundationAcceptance = parseFoundationAcceptance(
    record['foundationAcceptance'],
    'Prover release candidate Foundation acceptance',
    target,
  );
  const promotionFoundationAcceptance = parseFoundationAcceptance(
    record['promotionFoundationAcceptance'],
    'Prover release promotion Foundation acceptance',
    target,
  );
  if (
    selectionMode === 'build' &&
    canonicalRecordJson(foundationAcceptance) !== canonicalRecordJson(promotionFoundationAcceptance)
  ) {
    throw new Error('Prover build release Foundation acceptance is detached from its candidate');
  }
  return deepFreeze({
    kind: PROVER_RELEASE_KIND,
    targetKey: target.targetKey,
    requestedControlSourceSha,
    sourceActionControlSourceSha: requestedControlSourceSha,
    resolvedControlSourceSha: requestedControlSourceSha,
    selectionMode,
    selectedCandidateKey: parseReleaseRecordKey(
      record['selectedCandidateKey'],
      PROVER_CANDIDATE_KIND,
      'Prover release selected candidate key',
      target,
    ),
    candidateExecutionId,
    candidateMetadataSha256: parseSha256(
      record['candidateMetadataSha256'],
      'Prover release candidate metadata SHA-256',
    ),
    ...parseProverTrustFields(record, 'Prover release', target),
    foundationAcceptance,
    promotionFoundationAcceptance,
    buildApprovalEvidenceId,
    candidateSelectionApprovalEvidenceId,
    promotionExecutionId,
    promotionApprovalEvidenceId,
  });
}

/**
 * Admit one closed release-ledger record kind.
 *
 * @overload
 * @param {typeof TOOLCHAIN_CANDIDATE_KIND} kind
 * @param {unknown} value
 * @param {unknown} expectedTargetKey
 * @returns {ToolchainCandidateRecord}
 */
/**
 * @overload
 * @param {typeof TOOLCHAIN_RELEASE_KIND} kind
 * @param {unknown} value
 * @param {unknown} expectedTargetKey
 * @returns {ToolchainReleaseRecord}
 */
/**
 * @overload
 * @param {typeof PROVER_CANDIDATE_KIND} kind
 * @param {unknown} value
 * @param {unknown} expectedTargetKey
 * @returns {ProverCandidateRecord}
 */
/**
 * @overload
 * @param {typeof PROVER_RELEASE_KIND} kind
 * @param {unknown} value
 * @param {unknown} expectedTargetKey
 * @returns {ProverReleaseRecord}
 */
/**
 * @overload
 * @param {ReleaseRecordKind} kind
 * @param {unknown} value
 * @param {unknown} expectedTargetKey
 * @returns {ReleaseRecord}
 */
/**
 * @param {ReleaseRecordKind} kind
 * @param {unknown} value
 * @param {unknown} expectedTargetKey
 * @returns {ReleaseRecord}
 */
export function admitReleaseRecord(kind, value, expectedTargetKey) {
  const target = resolveAllowedDeploymentTarget(requireString(expectedTargetKey, 'release ledger expected target'));
  if (
    kind !== TOOLCHAIN_CANDIDATE_KIND &&
    kind !== TOOLCHAIN_RELEASE_KIND &&
    kind !== PROVER_CANDIDATE_KIND &&
    kind !== PROVER_RELEASE_KIND
  ) {
    throw new Error('release record kind is not registered');
  }
  const record = requireRecord(value, 'release record');
  const kindDescriptor = Object.getOwnPropertyDescriptor(record, 'kind');
  if (kindDescriptor !== undefined && Object.hasOwn(kindDescriptor, 'value') && kindDescriptor.value !== kind) {
    throw new Error('release record kind does not match the requested kind');
  }
  switch (kind) {
    case TOOLCHAIN_CANDIDATE_KIND:
      return admitToolchainCandidate(value, target);
    case TOOLCHAIN_RELEASE_KIND:
      return admitToolchainRelease(value, target);
    case PROVER_CANDIDATE_KIND:
      return admitProverCandidate(value, target);
    case PROVER_RELEASE_KIND:
      return admitProverRelease(value, target);
    default:
      throw new Error('release record kind is not registered');
  }
}

/**
 * @param {unknown} value
 * @param {string} label
 * @returns {PointerObservation}
 */
function admitPointerObservation(value, label) {
  const observation = requireExactKeys(value, ['etag', 'versionId'], label);
  return deepFreeze({
    etag: requireOpaqueEtag(observation['etag'], `${label} ETag`),
    versionId: parseS3VersionId(observation['versionId'], `${label} VersionId`),
  });
}

/**
 * @param {unknown} value
 * @param {AllowedDeploymentTarget} target
 * @returns {ToolchainAcceptedPointer}
 */
function admitToolchainAcceptedPointer(value, target) {
  const pointer = requireExactKeys(value, POINTER_KEYS, 'Toolchain accepted pointer');
  if (pointer['kind'] !== TOOLCHAIN_ACCEPTED_POINTER_KIND) {
    throw new Error('Toolchain accepted pointer kind is invalid');
  }
  if (pointer['targetKey'] !== target.targetKey) {
    throw new Error('Toolchain accepted pointer target is invalid');
  }
  const promotionExecutionId = requireGroupedLowercaseUuid(
    pointer['promotionExecutionId'],
    'Toolchain accepted pointer promotion execution ID',
  );
  const compareAndSwapEvidenceId = requireOperationalIdentifier(
    pointer['compareAndSwapEvidenceId'],
    'Toolchain accepted pointer compare-and-swap evidence ID',
  );
  if (compareAndSwapEvidenceId !== `cas/toolchain/${promotionExecutionId}`) {
    throw new Error('Toolchain accepted pointer CAS evidence is detached from its promotion execution');
  }
  return deepFreeze({
    kind: TOOLCHAIN_ACCEPTED_POINTER_KIND,
    targetKey: target.targetKey,
    recordKey: parseReleaseRecordKey(
      pointer['recordKey'],
      TOOLCHAIN_RELEASE_KIND,
      'Toolchain accepted pointer record key',
      target,
    ),
    promotionExecutionId,
    previous:
      pointer['previous'] === null
        ? null
        : admitPointerObservation(pointer['previous'], 'Toolchain accepted pointer predecessor'),
    compareAndSwapEvidenceId,
  });
}

/**
 * @param {unknown} value
 * @param {AllowedDeploymentTarget} target
 * @returns {ProverAcceptedPointer}
 */
function admitProverAcceptedPointer(value, target) {
  const pointer = requireExactKeys(value, POINTER_KEYS, 'Prover accepted pointer');
  if (pointer['kind'] !== PROVER_ACCEPTED_POINTER_KIND) {
    throw new Error('Prover accepted pointer kind is invalid');
  }
  if (pointer['targetKey'] !== target.targetKey) {
    throw new Error('Prover accepted pointer target is invalid');
  }
  const promotionExecutionId = requireGroupedLowercaseUuid(
    pointer['promotionExecutionId'],
    'Prover accepted pointer promotion execution ID',
  );
  const compareAndSwapEvidenceId = requireOperationalIdentifier(
    pointer['compareAndSwapEvidenceId'],
    'Prover accepted pointer compare-and-swap evidence ID',
  );
  if (compareAndSwapEvidenceId !== `cas/prover/${promotionExecutionId}`) {
    throw new Error('Prover accepted pointer CAS evidence is detached from its promotion execution');
  }
  return deepFreeze({
    kind: PROVER_ACCEPTED_POINTER_KIND,
    targetKey: target.targetKey,
    recordKey: parseReleaseRecordKey(
      pointer['recordKey'],
      PROVER_RELEASE_KIND,
      'Prover accepted pointer record key',
      target,
    ),
    promotionExecutionId,
    previous:
      pointer['previous'] === null
        ? null
        : admitPointerObservation(pointer['previous'], 'Prover accepted pointer predecessor'),
    compareAndSwapEvidenceId,
  });
}

/**
 * Admit one closed release-ledger pointer kind.
 *
 * @param {ReleasePointerKind} kind
 * @param {unknown} value
 * @param {unknown} expectedTargetKey
 * @returns {ReleasePointer}
 */
export function admitReleasePointer(kind, value, expectedTargetKey) {
  const target = resolveAllowedDeploymentTarget(requireString(expectedTargetKey, 'release ledger expected target'));
  switch (kind) {
    case TOOLCHAIN_ACCEPTED_POINTER_KIND:
      return admitToolchainAcceptedPointer(value, target);
    case PROVER_ACCEPTED_POINTER_KIND:
      return admitProverAcceptedPointer(value, target);
    default:
      throw new Error('release pointer kind is not registered');
  }
}

/**
 * @param {ReleaseRecordKind} kind
 * @param {unknown} body
 * @param {unknown} expectedTargetKey
 * @returns {string}
 */
export function deriveReleaseRecordKey(kind, body, expectedTargetKey) {
  const target = resolveAllowedDeploymentTarget(requireString(expectedTargetKey, 'release ledger expected target'));
  const record = admitReleaseRecord(kind, body, target.targetKey);
  const prefix = releaseRecordPrefix(kind, target);
  return `${prefix}${sha256Text(canonicalRecordJson(record))}.json`;
}

/**
 * @param {string} key
 * @param {AllowedDeploymentTarget} target
 * @returns {ReleaseRecordKind}
 */
function inferReleaseRecordKind(key, target) {
  for (const kind of [TOOLCHAIN_CANDIDATE_KIND, TOOLCHAIN_RELEASE_KIND, PROVER_CANDIDATE_KIND, PROVER_RELEASE_KIND]) {
    const prefix = releaseRecordPrefix(kind, target);
    if (key.startsWith(prefix) && RECORD_KEY_SUFFIX_PATTERN.test(key.slice(prefix.length))) return kind;
  }
  throw new Error('release ledger record key is not registered');
}

/**
 * @param {string} body
 * @param {string} label
 * @returns {unknown}
 */
function parseCanonicalBody(body, label) {
  let value;
  try {
    value = JSON.parse(body);
  } catch (error) {
    throw new Error(`${label} is not valid JSON`, { cause: error });
  }
  let canonicalBody;
  try {
    canonicalBody = canonicalRecordJson(value);
  } catch (error) {
    throw new Error(`${label} is not canonical JSON`, { cause: error });
  }
  if (body !== canonicalBody) {
    throw new Error(`${label} must use canonical JSON bytes`);
  }
  return value;
}

/**
 * @param {Readonly<Record<string, unknown>>} release
 * @param {Readonly<Record<string, unknown>>} candidate
 * @returns {void}
 */
function assertReleaseCandidateClosure(release, candidate) {
  const proverRelease = release['kind'] === PROVER_RELEASE_KIND;
  const copyFields = proverRelease ? PROVER_CANDIDATE_COPY_FIELDS : CANDIDATE_COPY_FIELDS;
  const label = proverRelease ? 'Prover' : 'Toolchain';
  for (const field of copyFields) {
    const releaseValue = release[field];
    const candidateValue = candidate[field];
    const equal =
      typeof releaseValue === 'object' && releaseValue !== null
        ? canonicalRecordJson(releaseValue) === canonicalRecordJson(candidateValue)
        : releaseValue === candidateValue;
    if (!equal) {
      throw new Error(`${label} release ${field} is detached from its selected candidate`);
    }
  }
  if (
    release['selectionMode'] === 'build' &&
    (release['requestedControlSourceSha'] !== candidate['requestedSourceSha'] ||
      release['sourceActionControlSourceSha'] !== candidate['sourceActionSourceSha'] ||
      release['resolvedControlSourceSha'] !== candidate['resolvedSourceSha'])
  ) {
    throw new Error(`${label} build release control source is detached from its selected candidate`);
  }
}

/**
 * @param {ProverCandidateRecord} candidate
 * @param {ToolchainReleaseRecord} selectedToolchainRelease
 * @returns {void}
 */
function assertProverToolchainClosure(candidate, selectedToolchainRelease) {
  if (
    candidate.selectedToolchainImageUri !== selectedToolchainRelease.imageUri ||
    candidate.selectedToolchainImageDigest !== selectedToolchainRelease.imageDigest
  ) {
    throw new Error('Prover candidate Toolchain image is detached from its selected Toolchain release');
  }
}

/**
 * @param {ReleaseRecordKind} kind
 * @returns {typeof TOOLCHAIN_CANDIDATE_KIND | typeof PROVER_CANDIDATE_KIND | undefined}
 */
function releaseCandidateKind(kind) {
  if (kind === TOOLCHAIN_RELEASE_KIND) {
    return TOOLCHAIN_CANDIDATE_KIND;
  }
  if (kind === PROVER_RELEASE_KIND) {
    return PROVER_CANDIDATE_KIND;
  }
  return undefined;
}

/**
 * @param {unknown} kind
 * @param {AllowedDeploymentTarget} target
 * @returns {ReleasePointerDescriptor | undefined}
 */
function pointerDescriptorForKind(kind, target) {
  if (kind === TOOLCHAIN_ACCEPTED_POINTER_KIND) {
    return {
      kind,
      pointerKey: resolveDeploymentLaneAuthority(target, 'toolchain').names.toolchainAcceptedPointerKey,
      releaseKind: TOOLCHAIN_RELEASE_KIND,
      label: 'Toolchain',
      casDomain: 'toolchain',
    };
  }
  if (kind === PROVER_ACCEPTED_POINTER_KIND) {
    return {
      kind,
      pointerKey: resolveDeploymentLaneAuthority(target, 'prover').names.proverAcceptedPointerKey,
      releaseKind: PROVER_RELEASE_KIND,
      label: 'Prover',
      casDomain: 'prover',
    };
  }
  return undefined;
}

/**
 * @param {unknown} pointerKey
 * @param {AllowedDeploymentTarget} target
 * @returns {ReleasePointerDescriptor | undefined}
 */
function pointerDescriptorForKey(pointerKey, target) {
  if (pointerKey === resolveDeploymentLaneAuthority(target, 'toolchain').names.toolchainAcceptedPointerKey) {
    return pointerDescriptorForKind(TOOLCHAIN_ACCEPTED_POINTER_KIND, target);
  }
  if (pointerKey === resolveDeploymentLaneAuthority(target, 'prover').names.proverAcceptedPointerKey) {
    return pointerDescriptorForKind(PROVER_ACCEPTED_POINTER_KIND, target);
  }
  return undefined;
}

/**
 * Preserve the admitted record's discriminator in the public selection.
 *
 * @param {string} key
 * @param {ReleaseRecord} record
 * @returns {ReleaseRecordSelection}
 */
function selectReleaseRecord(key, record) {
  switch (record.kind) {
    case TOOLCHAIN_CANDIDATE_KIND:
      return deepFreeze({ key, kind: record.kind, record });
    case TOOLCHAIN_RELEASE_KIND:
      return deepFreeze({ key, kind: record.kind, record });
    case PROVER_CANDIDATE_KIND:
      return deepFreeze({ key, kind: record.kind, record });
    case PROVER_RELEASE_KIND:
      return deepFreeze({ key, kind: record.kind, record });
  }
}

/**
 * Create a release-ledger boundary over a thin conditional object transport.
 *
 * @param {ReleaseLedgerTransport} transport
 * @param {unknown} expectedTargetKey
 * @returns {{
 *   preflightRecordPublication(kind: ReleaseRecordKind, body: unknown): Promise<ReleaseRecordSelection>;
 *   publishRecord(kind: ReleaseRecordKind, body: unknown): Promise<ReleaseRecordPublication>;
 *   readRecord(key: string): Promise<ReleaseRecordRead>;
 *   observePointer(pointerKey: string): Promise<ObservedReleasePointer>;
 *   resolvePointer(pointerKey: string): Promise<ResolvedReleasePointer>;
 *   movePointer(input: unknown): Promise<MoveReleasePointerResult>;
 * }}
 */
export function createReleaseLedger(transport, expectedTargetKey) {
  const target = resolveAllowedDeploymentTarget(requireString(expectedTargetKey, 'release ledger expected target'));
  const conditionalObjects = createConditionalObjectLedger({
    byteLimits: { pointerMaxBytes: 1024 * 1024, recordMaxBytes: 1024 * 1024 },
    coordinateObject: null,
    transport,
  });

  /**
   * @param {string} key
   * @returns {Promise<Readonly<{body: string, etag: string, versionId: string}> | undefined>}
   */
  async function observeRecord(key) {
    return conditionalObjects.readRecord({ key });
  }

  /**
   * @param {string} key
   * @returns {Promise<Readonly<{body: string, etag: string, versionId: string}> | undefined>}
   */
  async function readPointerObject(key) {
    return conditionalObjects.readPointer({ key });
  }

  /**
   * @param {string} key
   * @param {Readonly<{body: string, etag: string, versionId: string}>} observed
   * @param {boolean} verifyClosure
   * @returns {Promise<ReleaseRecordRead>}
   */
  async function admitObservedRecord(key, observed, verifyClosure) {
    const kind = inferReleaseRecordKind(requireString(key, 'release ledger record key'), target);
    const value = parseCanonicalBody(observed.body, `release ledger record ${key}`);
    const record = admitReleaseRecord(kind, value, target.targetKey);
    if (deriveReleaseRecordKey(kind, record, target.targetKey) !== key) {
      throw new Error(`release ledger record ${key} does not match its derived key`);
    }
    if (record.kind === PROVER_CANDIDATE_KIND && verifyClosure) {
      const selectedToolchain = await readRecordInternal(record.selectedToolchainReleaseKey, true);
      if (selectedToolchain['kind'] !== TOOLCHAIN_RELEASE_KIND) {
        throw new Error('Prover candidate selected Toolchain record is not a release');
      }
      assertProverToolchainClosure(record, selectedToolchain.record);
    }
    if ((record.kind === TOOLCHAIN_RELEASE_KIND || record.kind === PROVER_RELEASE_KIND) && verifyClosure) {
      const expectedCandidateKind = releaseCandidateKind(record.kind);
      const selectedCandidate = await readRecordInternal(
        record.selectedCandidateKey,
        record.kind === PROVER_RELEASE_KIND,
      );
      if (selectedCandidate['kind'] !== expectedCandidateKind) {
        const label = record.kind === PROVER_RELEASE_KIND ? 'Prover' : 'Toolchain';
        throw new Error(`${label} release selected record is not a candidate`);
      }
      assertReleaseCandidateClosure(
        record,
        /** @type {Readonly<Record<string, unknown>>} */ (selectedCandidate['record']),
      );
    }
    return deepFreeze({
      ...selectReleaseRecord(key, record),
      recordObservation: deepFreeze({ etag: observed.etag, versionId: observed.versionId }),
    });
  }

  /**
   * @param {string} key
   * @param {boolean} verifyClosure
   * @returns {Promise<ReleaseRecordRead>}
   */
  async function readRecordInternal(key, verifyClosure) {
    const admittedKey = requireString(key, 'release ledger record key');
    inferReleaseRecordKind(admittedKey, target);
    const observed = await observeRecord(admittedKey);
    if (observed === undefined) {
      throw new Error(`release ledger record ${admittedKey} does not exist`);
    }
    return admitObservedRecord(admittedKey, observed, verifyClosure);
  }

  /**
   * @param {string} key
   * @returns {Promise<ReleaseRecordRead>}
   */
  async function readRecord(key) {
    return readRecordInternal(key, true);
  }

  /**
   * Admit a record and re-observe every record needed to prove its ledger
   * closure without writing. A bounded multi-record publisher can preflight
   * its complete set before attempting the first create-only publication.
   *
   * @param {ReleaseRecordKind} kind
   * @param {unknown} body
   */
  async function preflightRecordPublication(kind, body) {
    const record = admitReleaseRecord(kind, body, target.targetKey);
    if (record.kind === PROVER_CANDIDATE_KIND) {
      const selectedToolchain = await readRecordInternal(record.selectedToolchainReleaseKey, true);
      if (selectedToolchain['kind'] !== TOOLCHAIN_RELEASE_KIND) {
        throw new Error('Prover candidate selected Toolchain record is not a release');
      }
      assertProverToolchainClosure(record, selectedToolchain.record);
    }
    if (record.kind === TOOLCHAIN_RELEASE_KIND || record.kind === PROVER_RELEASE_KIND) {
      const selectedCandidate = await readRecordInternal(
        record.selectedCandidateKey,
        record.kind === PROVER_RELEASE_KIND,
      );
      assertReleaseCandidateClosure(
        record,
        /** @type {Readonly<Record<string, unknown>>} */ (selectedCandidate['record']),
      );
    }
    return selectReleaseRecord(deriveReleaseRecordKey(kind, record, target.targetKey), record);
  }

  /**
   * @param {ReleaseRecordKind} kind
   * @param {unknown} body
   * @returns {Promise<ReleaseRecordPublication>}
   */
  async function publishRecord(kind, body) {
    const preflight = await preflightRecordPublication(kind, body);
    const record = preflight.record;
    const key = preflight.key;
    const canonicalBody = canonicalRecordJson(record);
    const result = await conditionalObjects.publishRecord({ key, body: canonicalBody });
    if (result.status === 'created') {
      return deepFreeze({
        status: /** @type {const} */ ('created'),
        ...preflight,
        recordObservation: result.observation,
      });
    }
    if (result.status === 'conflict') {
      if (result.observed !== undefined) {
        const existing = await admitObservedRecord(key, result.observed, true);
        if (canonicalRecordJson(existing['record']) === canonicalBody) {
          throw new Error(`release ledger record ${key} conflict classification is invalid`);
        }
      }
      throw new Error(`release ledger record ${key} conflicts with different canonical bytes`);
    }
    return deepFreeze({
      status: /** @type {const} */ ('idempotent-retry'),
      ...preflight,
      recordObservation: result.observation,
    });
  }

  /**
   * Observe and exact-admit one pointer without reading its selected release.
   * This is the bounded CAS boundary used when a schema hard cut leaves the
   * predecessor release body intentionally unreadable by current admission.
   *
   * @param {string} pointerKey
   * @returns {Promise<ObservedReleasePointer>}
   */
  async function observePointer(pointerKey) {
    const descriptor = pointerDescriptorForKey(pointerKey, target);
    if (descriptor === undefined) {
      throw new Error('release ledger pointer key is not registered');
    }
    const observed = await readPointerObject(pointerKey);
    if (observed === undefined) {
      throw new Error(`release ledger pointer ${pointerKey} does not exist`);
    }
    const pointer = admitReleasePointer(
      descriptor.kind,
      parseCanonicalBody(observed.body, `release ledger pointer ${pointerKey}`),
      target.targetKey,
    );
    return deepFreeze({
      pointerKey,
      pointer,
      pointerObservation: deepFreeze({ etag: observed.etag, versionId: observed.versionId }),
    });
  }

  /**
   * @param {string} pointerKey
   * @returns {Promise<ResolvedReleasePointer>}
   */
  async function resolvePointer(pointerKey) {
    const descriptor = pointerDescriptorForKey(pointerKey, target);
    if (descriptor === undefined) {
      throw new Error('release ledger pointer key is not registered');
    }
    const observed = await observePointer(pointerKey);
    const pointer = observed.pointer;
    const selected = await readRecord(pointer.recordKey);
    const coordinates = {
      pointerKey,
      pointerObservation: observed.pointerObservation,
      recordKey: selected.key,
      recordObservation: selected.recordObservation,
    };
    if (
      pointer.kind === TOOLCHAIN_ACCEPTED_POINTER_KIND &&
      selected.kind === TOOLCHAIN_RELEASE_KIND &&
      selected.record.promotionExecutionId === pointer.promotionExecutionId
    ) {
      return deepFreeze({ ...coordinates, pointer, recordKind: selected.kind, record: selected.record });
    }
    if (
      pointer.kind === PROVER_ACCEPTED_POINTER_KIND &&
      selected.kind === PROVER_RELEASE_KIND &&
      selected.record.promotionExecutionId === pointer.promotionExecutionId
    ) {
      return deepFreeze({ ...coordinates, pointer, recordKind: selected.kind, record: selected.record });
    }
    throw new Error(`${descriptor.label} accepted pointer is detached from its selected release`);
  }

  /**
   * @param {unknown} input
   * @returns {Promise<MoveReleasePointerResult>}
   */
  async function movePointer(input) {
    const request = requireExactKeys(
      input,
      ['expected', 'kind', 'pointerKey', 'promotionExecutionId', 'recordKey'],
      'release ledger pointer move',
    );
    const descriptor = pointerDescriptorForKind(request['kind'], target);
    if (descriptor === undefined) {
      throw new Error('release ledger pointer move kind is not registered');
    }
    if (request['pointerKey'] !== descriptor.pointerKey) {
      throw new Error('release ledger pointer move key is not registered');
    }
    const expected =
      request['expected'] === null
        ? null
        : admitPointerObservation(request['expected'], 'release ledger expected pointer observation');
    const promotionExecutionId = requireGroupedLowercaseUuid(
      request['promotionExecutionId'],
      'release ledger pointer move promotion execution ID',
    );
    const selected = await readRecord(
      parseReleaseRecordKey(
        request['recordKey'],
        descriptor.releaseKind,
        'release ledger pointer move record key',
        target,
      ),
    );
    const selectedRecord = requireRecord(selected['record'], `selected ${descriptor.label} release record`);
    if (selectedRecord['promotionExecutionId'] !== promotionExecutionId) {
      throw new Error('release ledger pointer move promotion is detached from the selected release');
    }
    const selectedRelease = /** @type {ToolchainReleaseRecord | ProverReleaseRecord} */ (selected['record']);
    const pointer = admitReleasePointer(
      descriptor.kind,
      {
        kind: descriptor.kind,
        targetKey: target.targetKey,
        recordKey: selected['key'],
        promotionExecutionId,
        previous: expected,
        compareAndSwapEvidenceId: `cas/${descriptor.casDomain}/${promotionExecutionId}`,
      },
      target.targetKey,
    );
    const canonicalBody = canonicalRecordJson(pointer);
    const result = await conditionalObjects.movePointer({
      key: descriptor.pointerKey,
      body: canonicalBody,
      expected,
    });
    if (result.status === 'moved') {
      return deepFreeze({
        status: /** @type {const} */ ('moved'),
        pointerKey: descriptor.pointerKey,
        pointer,
        pointerObservation: result.observation,
        recordKey: selected['key'],
        record: selectedRelease,
      });
    }
    if (result.status === 'idempotent-retry') {
      return deepFreeze({
        status: /** @type {const} */ ('idempotent-retry'),
        pointerKey: descriptor.pointerKey,
        pointer,
        pointerObservation: result.observation,
        recordKey: selected['key'],
        record: selectedRelease,
      });
    }
    const currentObservation = result.observed;
    if (currentObservation === undefined) {
      return deepFreeze({
        status: /** @type {const} */ ('conflict'),
        pointerKey: descriptor.pointerKey,
        expected,
        observed: null,
      });
    }
    const currentPointer = admitReleasePointer(
      descriptor.kind,
      parseCanonicalBody(currentObservation.body, `release ledger pointer ${descriptor.pointerKey}`),
      target.targetKey,
    );
    const observed = deepFreeze({
      pointer: currentPointer,
      pointerObservation: deepFreeze({ etag: currentObservation.etag, versionId: currentObservation.versionId }),
    });
    return deepFreeze({
      status: /** @type {const} */ ('conflict'),
      pointerKey: descriptor.pointerKey,
      expected,
      observed,
    });
  }

  return deepFreeze({
    preflightRecordPublication,
    publishRecord,
    readRecord,
    observePointer,
    resolvePointer,
    movePointer,
  });
}
