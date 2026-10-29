import {
  assertPointerCompareAndSwap,
  canonicalRecordJson,
  deepFreeze,
  parseDigestPinnedImageReference,
  parseGitCommitSha,
  parseS3VersionId,
  parseSha256,
  requireExactKeys,
  requireGroupedLowercaseUuid,
  requireString,
  sha256Text,
} from './internal.js';
import { admitObjectReference as admitImageObjectReference, packageRecord } from './plan-package.js';
export { admitObjectReference as admitImageObjectReference } from './plan-package.js';
import { resolveAllowedDeploymentTarget, resolveDeploymentLaneAuthority } from './index.js';

/** @typedef {'toolchain' | 'prover'} ImageKind */
/** @typedef {{readonly key:string, readonly versionId:string, readonly sha256:string}} ObjectReference */
/** @typedef {{readonly body:string, readonly versionId:string, readonly etag:string}} StoredObject */
/** @typedef {{readonly etag:string, readonly versionId:string, readonly sha256:string}} ExpectedObject */
/** @typedef {{getObject(input:{key:string,versionId?:string}):Promise<StoredObject|null>, putObject(input:{key:string,body:string,expected:ExpectedObject|null}):Promise<StoredObject>}} ImageTransport */

/** @param {unknown} value @returns {ImageKind} */
function imageKind(value) {
  if (value !== 'toolchain' && value !== 'prover') throw new Error('Unknown image kind.');
  return value;
}
/** @param {string} targetKey @param {ImageKind} kind */
export function promotionKey(targetKey, kind) {
  resolveAllowedDeploymentTarget(targetKey);
  return `promotions/${imageKind(kind)}/current.json`;
}
/** @param {string} key @param {string} targetKey */
export function admitImageObjectKey(key, targetKey) {
  if (key === promotionKey(targetKey, 'toolchain') || key === promotionKey(targetKey, 'prover')) return key;
  return admitImageCandidateKey(key, key.startsWith('artifacts/toolchain/') ? 'toolchain' : 'prover', targetKey);
}
/** @param {ExpectedObject} expected @param {StoredObject|null} observed */
export function assertImagePredecessor(expected, observed) {
  if (observed === null) throw new Error('Image promotion predecessor is missing.');
  assertPointerCompareAndSwap({
    expectedVersionOrEtag: sha256Text(canonicalRecordJson(expected)),
    observedVersionOrEtag: sha256Text(
      canonicalRecordJson({
        etag: observed.etag,
        versionId: observed.versionId,
        sha256: sha256Text(observed.body),
      }),
    ),
  });
}
/** @param {unknown} value */
function scanEvidence(value) {
  const scan = requireExactKeys(value, ['status', 'criticalHighCount'], 'Image scan');
  const count = scan['criticalHighCount'];
  if (
    typeof count !== 'number' ||
    !Number.isSafeInteger(count) ||
    count < 0 ||
    (scan['status'] === 'PASS' ? count !== 0 : scan['status'] !== 'FINDINGS_PRESENT' || count === 0)
  ) {
    throw new Error('Image scan status and finding count disagree.');
  }
  return deepFreeze({ status: /** @type {'PASS'|'FINDINGS_PRESENT'} */ (scan['status']), criticalHighCount: count });
}
/** @param {unknown} value @param {string} targetKey */
function foundationReference(value, targetKey) {
  const authority = requireExactKeys(value, ['reference', 'consumerContractSha256'], 'Image Foundation authority');
  const reference = admitImageObjectReference(authority['reference']);
  if (reference.key !== `deployment/${targetKey}/foundation/checkpoint.json`)
    throw new Error('Foundation checkpoint belongs to another target.');
  return deepFreeze({
    reference,
    consumerContractSha256: parseSha256(authority['consumerContractSha256'], 'Foundation consumer contract hash'),
  });
}
/** @param {unknown} value @param {string} targetKey @param {ImageKind} kind */
function pinnedImage(value, targetKey, kind) {
  const target = resolveAllowedDeploymentTarget(targetKey);
  const names = resolveDeploymentLaneAuthority(target, kind).names;
  const repository = kind === 'prover' ? names.proverRepository : names.toolchainRepository;
  return parseDigestPinnedImageReference(value, {
    partition: target.partition,
    accountId: target.accountId,
    region: target.region,
    repository,
  });
}
/**
 * Immutable candidates own all build evidence. Promotion records never duplicate it.
 * @param {unknown} value @param {string} targetKey
 */
export function admitImageCandidate(value, targetKey) {
  const target = resolveAllowedDeploymentTarget(targetKey);
  const shell = packageRecord(
    value,
    [
      'kind',
      'targetKey',
      'sourceSha',
      'executionId',
      'approvalEvidenceId',
      'metadataSha256',
      'imageUri',
      'imageTag',
      'scan',
      'evidence',
    ],
    'Image candidate',
  );
  const kind = imageKind(shell['kind']);
  if (shell['targetKey'] !== target.targetKey) throw new Error('Image candidate target mismatch.');
  const executionId = requireGroupedLowercaseUuid(shell['executionId'], 'Image candidate execution');
  if (shell['approvalEvidenceId'] !== `${kind}-build/${executionId}`)
    throw new Error('Candidate approval is detached from its execution.');
  const image = pinnedImage(shell['imageUri'], targetKey, kind);
  const common = {
    targetKey: target.targetKey,
    sourceSha: parseGitCommitSha(shell['sourceSha'], 'Image source'),
    executionId,
    approvalEvidenceId: `${kind}-build/${executionId}`,
    metadataSha256: parseSha256(shell['metadataSha256'], 'Candidate metadata hash'),
    imageUri: image.imageUri,
    imageTag: requireString(shell['imageTag'], 'Image tag', /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/u),
    scan: scanEvidence(shell['scan']),
  };
  if (kind === 'toolchain') {
    const evidence = requireExactKeys(
      shell['evidence'],
      ['risc0Version', 'rustVersion', 'rustToolchainTag'],
      'Toolchain evidence',
    );
    return deepFreeze({
      ...common,
      kind,
      evidence: {
        risc0Version: requireString(evidence['risc0Version'], 'RISC Zero version'),
        rustVersion: requireString(evidence['rustVersion'], 'Rust version'),
        rustToolchainTag: requireString(evidence['rustToolchainTag'], 'Rust toolchain tag'),
      },
    });
  }
  const evidence = requireExactKeys(
    shell['evidence'],
    [
      'foundation',
      'toolchain',
      'imageId',
      'methodVersion',
      'variant',
      'zkvmContractHash',
      'failureMarkerContractSha256',
      'posture',
      'failureMarker',
      'managedSigning',
    ],
    'Prover evidence',
  );
  const toolchain = requireExactKeys(evidence['toolchain'], ['promotion', 'imageUri'], 'Original Toolchain authority');
  const originalPromotion = admitImageObjectReference(toolchain['promotion']);
  if (originalPromotion.key !== promotionKey(targetKey, 'toolchain'))
    throw new Error('Original Toolchain promotion key mismatch.');
  const base = pinnedImage(toolchain['imageUri'], targetKey, 'toolchain');
  const methodVersion = evidence['methodVersion'];
  if (
    typeof methodVersion !== 'number' ||
    !Number.isSafeInteger(methodVersion) ||
    methodVersion < 1 ||
    evidence['variant'] !== 'default' ||
    evidence['posture'] !== 'PASS' ||
    evidence['failureMarker'] !== 'PASS' ||
    evidence['managedSigning'] !== 'COMPLETE' ||
    common.scan.status !== 'PASS'
  )
    throw new Error('Prover evidence failed admission.');
  return deepFreeze({
    ...common,
    kind,
    evidence: {
      foundation: foundationReference(evidence['foundation'], targetKey),
      toolchain: { promotion: originalPromotion, imageUri: base.imageUri },
      imageId: requireString(evidence['imageId'], 'Prover ImageID', /^0x[0-9a-f]{64}$/u),
      methodVersion,
      variant: /** @type {const} */ ('default'),
      zkvmContractHash: parseSha256(evidence['zkvmContractHash'], 'zkVM contract hash'),
      failureMarkerContractSha256: parseSha256(evidence['failureMarkerContractSha256'], 'Failure marker contract hash'),
      posture: /** @type {const} */ ('PASS'),
      failureMarker: /** @type {const} */ ('PASS'),
      managedSigning: /** @type {const} */ ('COMPLETE'),
    },
  });
}
/** @typedef {ReturnType<typeof admitImageCandidate>} ImageCandidate */
/** @param {unknown} value @param {ImageKind} kind @param {string} targetKey */
export function admitImageCandidateKey(value, kind, targetKey) {
  resolveAllowedDeploymentTarget(targetKey);
  return requireString(
    value,
    'Image candidate key',
    new RegExp(`^artifacts/${imageKind(kind)}/candidates/[0-9a-f]{64}\\.json$`, 'u'),
  );
}
/** @param {ImageCandidate} candidate */
export function candidateKey(candidate) {
  return `artifacts/${candidate.kind}/candidates/${sha256Text(canonicalRecordJson(candidate))}.json`;
}
/** @param {unknown} value @param {string} targetKey @param {ImageKind} kind */
export function admitImagePromotion(value, targetKey, kind) {
  resolveAllowedDeploymentTarget(targetKey);
  const record = packageRecord(
    value,
    [
      'kind',
      'targetKey',
      'candidate',
      'sourceSha',
      'selectionMode',
      'executionId',
      'candidateApprovalEvidenceId',
      'promotionApprovalEvidenceId',
      'revalidation',
    ],
    'Image promotion',
  );
  if (record['kind'] !== kind || record['targetKey'] !== targetKey)
    throw new Error('Image promotion target or kind mismatch.');
  const candidate = admitImageObjectReference(record['candidate']);
  if (
    !new RegExp(`^artifacts/${kind}/candidates/[0-9a-f]{64}\\.json$`, 'u').test(candidate.key) ||
    !candidate.key.endsWith(`${candidate.sha256}.json`)
  )
    throw new Error('Candidate reference is not content addressed.');
  const executionId = requireGroupedLowercaseUuid(record['executionId'], 'Promotion execution');
  if (
    record['candidateApprovalEvidenceId'] !== `${kind}-candidate-selection/${executionId}` ||
    record['promotionApprovalEvidenceId'] !== `${kind}-promotion/${executionId}`
  )
    throw new Error('Promotion approvals detached from execution.');
  const mode = record['selectionMode'];
  if (mode !== 'build' && mode !== 'existing') throw new Error('Invalid image selection mode.');
  const check = requireExactKeys(
    record['revalidation'],
    kind === 'prover'
      ? ['imageUri', 'scan', 'foundation', 'toolchainImageUri', 'managedSigning']
      : ['imageUri', 'scan'],
    'Image revalidation',
  );
  const image = pinnedImage(check['imageUri'], targetKey, kind);
  const scan = scanEvidence(check['scan']);
  const common = {
    kind,
    targetKey,
    candidate,
    sourceSha: parseGitCommitSha(record['sourceSha'], 'Promotion source'),
    selectionMode: mode,
    executionId,
    candidateApprovalEvidenceId: `${kind}-candidate-selection/${executionId}`,
    promotionApprovalEvidenceId: `${kind}-promotion/${executionId}`,
  };
  if (kind === 'toolchain') return deepFreeze({ ...common, revalidation: { imageUri: image.imageUri, scan } });
  if (scan.status !== 'PASS' || check['managedSigning'] !== 'COMPLETE') throw new Error('Prover revalidation failed.');
  return deepFreeze({
    ...common,
    revalidation: {
      imageUri: image.imageUri,
      scan,
      foundation: foundationReference(check['foundation'], targetKey),
      toolchainImageUri: pinnedImage(check['toolchainImageUri'], targetKey, 'toolchain').imageUri,
      managedSigning: /** @type {const} */ ('COMPLETE'),
    },
  });
}
/** @typedef {ReturnType<typeof admitImagePromotion>} ImagePromotion */
/** @param {ImagePromotion} promotion @param {ImageCandidate} candidate */
export function assertImagePromotionCandidate(promotion, candidate) {
  if (
    candidate.kind !== promotion.kind ||
    candidate.imageUri !== promotion.revalidation.imageUri ||
    (promotion.selectionMode === 'build' &&
      (candidate.sourceSha !== promotion.sourceSha || candidate.executionId !== promotion.executionId))
  )
    throw new Error('Promotion candidate mismatch: detached source, execution or image evidence.');
  if (
    candidate.kind === 'prover' &&
    'toolchainImageUri' in promotion.revalidation &&
    candidate.evidence.toolchain.imageUri !== promotion.revalidation.toolchainImageUri
  )
    throw new Error('Prover base dependency mismatch.');
}
/** Current dependency admission intentionally ignores original promotion/source identity. @param {ImageCandidate} candidate @param {{toolchainImageUri:string,zkvmContractHash:string,failureMarkerContractSha256:string}} requirements */
export function assertProverImageContract(candidate, requirements) {
  if (
    candidate.kind !== 'prover' ||
    candidate.evidence.toolchain.imageUri !== requirements.toolchainImageUri ||
    candidate.evidence.zkvmContractHash !== requirements.zkvmContractHash ||
    candidate.evidence.failureMarkerContractSha256 !== requirements.failureMarkerContractSha256
  )
    throw new Error('Prover image does not meet current dependencies.');
}
/** @param {StoredObject} object @param {string} key @returns {ObjectReference} */
function reference(object, key) {
  return admitImageObjectReference({ key, versionId: object.versionId, sha256: sha256Text(object.body) });
}
/** @param {StoredObject} object @param {ObjectReference} ref */
function exactObject(object, ref) {
  if (object.versionId !== ref.versionId || sha256Text(object.body) !== ref.sha256)
    throw new Error('Image authority version or hash mismatch.');
  const value = JSON.parse(object.body);
  if (canonicalRecordJson(value) !== object.body) throw new Error('Image authority bytes are not canonical.');
  return value;
}
/** @param {ImageTransport} transport @param {string} targetKey */
export function createImageLedger(transport, targetKey) {
  resolveAllowedDeploymentTarget(targetKey);
  /** @param {ObjectReference} input */
  async function readCandidate(input) {
    const ref = admitImageObjectReference(input);
    const object = await transport.getObject({ key: ref.key, versionId: ref.versionId });
    if (!object) throw new Error('Image candidate is missing.');
    const candidate = admitImageCandidate(exactObject(object, ref), targetKey);
    if (candidateKey(candidate) !== ref.key) throw new Error('Candidate key and content disagree.');
    return candidate;
  }
  /** @param {ImageKind} kind @param {string} [versionId] */
  async function selectPromotion(kind, versionId) {
    const key = promotionKey(targetKey, kind);
    const object = await transport.getObject({
      key,
      ...(versionId === undefined ? {} : { versionId: parseS3VersionId(versionId, 'Pinned promotion version') }),
    });
    if (!object)
      throw new Error(`${kind} promotion is missing; an explicit successful build and promotion is required.`);
    if (versionId !== undefined && object.versionId !== versionId)
      throw new Error('Pinned promotion version mismatch.');
    const ref = reference(object, key);
    const promotion = admitImagePromotion(exactObject(object, ref), targetKey, kind);
    const candidate = await readCandidate(promotion.candidate);
    assertImagePromotionCandidate(promotion, candidate);
    return deepFreeze({ promotion, reference: ref, etag: object.etag, candidate });
  }
  /** @param {unknown} value */
  async function publishCandidate(value) {
    const candidate = admitImageCandidate(value, targetKey);
    if (candidate.kind === 'prover') {
      const original = candidate.evidence.toolchain.promotion;
      const selected = await selectPromotion('toolchain', original.versionId);
      if (
        selected.reference.sha256 !== original.sha256 ||
        selected.candidate.imageUri !== candidate.evidence.toolchain.imageUri
      )
        throw new Error('Original Toolchain provenance mismatch.');
    }
    const key = candidateKey(candidate);
    const body = canonicalRecordJson(candidate);
    const result = await transport.putObject({ key, body, expected: null });
    const ref = reference(result, key);
    if (result.body !== body) throw new Error('Candidate publication read-back differs.');
    return ref;
  }
  /** @param {unknown} value @param {ImageKind} kind @param {ExpectedObject|null} expected */
  async function publishPromotion(value, kind, expected) {
    const promotion = admitImagePromotion(value, targetKey, kind);
    if (expected !== null) {
      const observation = packageRecord(expected, ['etag', 'versionId', 'sha256'], 'Promotion predecessor');
      expected = {
        etag: requireString(observation['etag'], 'Promotion predecessor ETag', /^"[^"\s]{1,128}"$/u),
        versionId: parseS3VersionId(observation['versionId']),
        sha256: parseSha256(observation['sha256']),
      };
    }
    const candidate = await readCandidate(promotion.candidate);
    assertImagePromotionCandidate(promotion, candidate);
    const key = promotionKey(targetKey, kind);
    const body = canonicalRecordJson(promotion);
    const result = await transport.putObject({ key, body, expected });
    if (result.body !== body) throw new Error('Promotion publication read-back differs.');
    return reference(result, key);
  }
  return Object.freeze({ readCandidate, selectPromotion, publishCandidate, publishPromotion });
}
